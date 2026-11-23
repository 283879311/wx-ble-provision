/**
 * 配网流程（协议 §8）。
 *
 * tryconnect -> 每 500ms operation.get -> got_ip（契约 v1.1=IP+联网验证+MQTT 就绪）
 *            -> apply -> 等 sta_has_ip + internet_verified + mqtt_connected
 *
 * 注意两个易踩的坑：
 *  1. apply success != 已拿到 IP，必须继续轮询 network.status；
 *  2. busy / no_slot 不是密码错误，不能提示用户改密码。
 */

const { sleep } = require('./util');
const pwstore = require('./pwstore');
const contract = require('./contract');
// 全局单例：BLE 断链事件由 session 里的 BleManager 实例发出（系统回调注册在它身上）
const { ble } = require('./session');

const OP_POLL_MS = 500;
const OP_DEADLINE_MS = 60000; // 设备候选超时约 15s，这里留足余量
const VERIFY_DEADLINE_MS = 60000;
const VERIFY_INTERVAL_MS = 1000;

const STATE_TEXT = {
  accepted: '已受理，等待设备连接',
  connecting: '设备正在连接 Wi-Fi',
  got_ip: '试连成功，已获取 IP',
  committing: '正在提交配置',
  success: '配置已生效',
  failed: '试连失败',
  cancelled: '已取消',
  expired: '已过期',
};

class ProvisionError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ProvisionError';
    this.code = code;
  }
}

function noop() {}

/**
 * @param {object} protocol
 * @param {{ssid:string,password:string,onProgress?:Function,isCancelled?:Function}} options
 * @returns {Promise<{operationId:string,operation:object,applied:object,status:object,pending:boolean}>}
 */
/* 最近一次配网成功的记录：给 T4 第 13 项取证用，证明本次真的执行过 apply
   （只看「设备当前有 IP」会误把历史配置当成这次配网的成果） */
let lastSuccess = null;

function recordSuccess(info) {
  lastSuccess = info;
}

function lastProvision() {
  return lastSuccess;
}

/* 最近一次「救援/配网动作」：只要 apply 真的提交过就记一笔（哪怕最后没拿到 IP）。
   第 14 项要靠它区分「还没做救援」和「救援做了但没救回来」——只看设备当前状态
   无法判断，会把「点了核验但还没去配网」误判成 FAIL。 */
let lastAttempt = null;

function recordAttempt(info) {
  lastAttempt = info;
}

function lastRescueAttempt() {
  return lastAttempt;
}

/* ---------- 配网时间线（断链定因取证） ----------
 * 小程序 API 拿不到 HCI reason，定因要靠串口日志；本时间线提供对齐用的
 * 另一半证据：每一步（扫描/试连/轮询/apply/验证）发生的确切时刻，以及
 * BLE 断链发生时"正处于哪一步、当时是否有请求在途"。
 * timelineReset() 激活（provisionWifi 入口与 netcfg 扫描入口各调一次），
 * 事件最多保留 200 条，timelineText() 输出可直接粘贴进报告与串口日志对时。 */
let tlEvents = [];
let tlStart = 0;
let tlStep = 'idle';
let activeProtocol = null; // 配网进行中的 protocol 实例，用于断链时记录在途请求

function timelineReset() {
  tlEvents = [];
  tlStart = Date.now();
  tlStep = 'idle';
}

function setStep(step) {
  if (!tlStart) timelineReset();
  tlStep = step;
}

function tl(event, detail) {
  if (!tlStart) return; // 未激活不记录
  const now = Date.now();
  const d = new Date(now);
  const p2 = (n) => (n < 10 ? '0' + n : '' + n);
  const p3 = (n) => (n < 100 ? '0' + (n < 10 ? '0' + n : n) : '' + n);
  tlEvents.push({
    t: p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) + '.' + p3(d.getMilliseconds()),
    dt: now - tlStart,
    event: event,
    step: tlStep,
    detail: detail === undefined || detail === null ? '' : String(detail),
  });
  if (tlEvents.length > 200) tlEvents.shift();
}

function timelineText() {
  if (!tlEvents.length) return '(配网时间线未激活)';
  return tlEvents
    .map((e) => e.t + ' +' + e.dt + 'ms [' + e.step + '] ' + e.event + (e.detail ? ' ' + e.detail : ''))
    .join('\n');
}

/* BLE 断链捕获：整个模块只挂一次。断链发生时若时间线已激活，记录步骤与在途请求 id */
ble.on('disconnected', (info) => {
  if (!tlStart) return;
  const inFlight = activeProtocol && activeProtocol.lastTxId ? activeProtocol.lastTxId : '';
  tl('ble_disconnected', 'deviceId=' + ((info && info.deviceId) || '') + (inFlight ? ' 在途请求=' + inFlight : ' 无在途请求'));
});

async function provisionWifiImpl(protocol, options) {
  const ssid = options.ssid;
  const password = options.password || '';
  const onProgress = options.onProgress || noop;
  const isCancelled = options.isCancelled || function () { return false; };
  // 仅测试用：默认 60s / 1s，保持真机行为不变
  const verifyTimeoutMs = options.verifyTimeoutMs || VERIFY_DEADLINE_MS;
  const verifyIntervalMs = options.verifyIntervalMs || VERIFY_INTERVAL_MS;

  if (!ssid) throw new ProvisionError('invalid_argument', '请选择要连接的 Wi-Fi');

  onProgress({ stage: 'tryconnect', text: '正在让设备试连「' + ssid + '」' });

  let accepted;
  try {
    accepted = await protocol.tryConnect(ssid, password);
  } catch (err) {
    // busy：设备已有活动 operation。若我们手上还有上一个 operation_id，先取消再重试一次
    if (err.code === 'busy' && protocol.lastOperationId) {
      onProgress({ stage: 'cancel', text: '设备有进行中的任务，正在取消后重试' });
      try {
        await protocol.networkCancel(protocol.lastOperationId);
      } catch (e) {
        /* 可能是 operation_state，忽略并继续尝试 */
      }
      accepted = await protocol.tryConnect(ssid, password);
    } else {
      throw err;
    }
  }

  const operationId = accepted && accepted.operation_id;
  if (!operationId) throw new ProvisionError('internal_error', '设备未返回 operation_id');

  /* 试连请求已被设备接受 = 救援动作开始。口令错/找不到 AP 时流程会在这里之后抛错，
     也要留下记录，否则第 14 项会把「救了但失败」误判成「还没救」。 */
  try {
    recordAttempt({
      ssid: ssid,
      operationId: operationId,
      at: Date.now(),
      source: options.source || 'provision',
      stage: 'tryconnect',
    });
  } catch (e) {
    /* 记录失败不影响主流程 */
  }

  /* ---------- 轮询 operation ---------- */
  const deadline = Date.now() + OP_DEADLINE_MS;
  let operation = null;

  while (Date.now() < deadline) {
    if (isCancelled()) throw new ProvisionError('aborted', '已取消');

    let st;
    try {
      st = await protocol.operationGet(operationId);
    } catch (err) {
      // 单次查询失败不终止流程（设备可能在长响应发送中），继续下一轮
      if (err.code === 'unauthorized') throw err;
      onProgress({
        stage: 'wait_ip',
        state: 'polling',
        text: '查询状态失败，重试中：' + (err.code || err.message),
      });
      await sleep(OP_POLL_MS);
      continue;
    }

    operation = st;
    onProgress({
      stage: 'wait_ip',
      state: st.state,
      error: st.error,
      operationId: operationId,
      text: STATE_TEXT[st.state] || st.state,
    });

    if (st.state === 'got_ip') break;

    /* operation.state 是生命周期唯一判据；cleanup_state 仅为诊断字段，
       不参与终态判断，也不作为继续轮询的条件。 */
    if (contract.isTerminal(st.state)) {
      if (st.state === 'failed' || st.state === 'cancelled' || st.state === 'expired') {
        const code = st.error && st.error !== 'none' ? st.error : st.state;
        if (code === 'wrong_password') {
          /* 设备判定口令错误：本地记忆同步作废，避免下次再自动填坏口令 */
          try {
            pwstore.forget(ssid);
          } catch (e) {
            /* 忽略 */
          }
        }
        const perr = new ProvisionError(code, STATE_TEXT[st.state] || st.state);
        perr.operationId = operationId; /* 失败也要能查 operation.get */
        throw perr;
      }

      /* success 是 apply 后的终态；tryconnect 阶段只接受 got_ip，不能把 success
         当成试连成功或继续轮询到客户端超时。 */
      const perr = new ProvisionError('operation_state', '试连阶段收到非预期终态：' + st.state);
      perr.operationId = operationId;
      throw perr;
    }

    await sleep(OP_POLL_MS);
  }

  if (!operation || operation.state !== 'got_ip') {
    const terr = new ProvisionError('timeout', '等待试连结果超时');
    terr.operationId = operationId;
    throw terr;
  }
  if (isCancelled()) throw new ProvisionError('aborted', '已取消');

  /* ---------- 提交 ---------- */
  onProgress({ stage: 'apply', text: '试连成功，正在保存配置' });
  const applied = await protocol.networkApply(operationId);
  // apply 已提交：不管后面有没有等到 IP，都要留下「救援动作已发生」的证据
  try {
    recordAttempt({
      ssid: ssid,
      operationId: operationId,
      at: Date.now(),
      source: options.source || 'provision',
      stage: 'apply',
      attempt: 0,
    });
  } catch (e) {
    /* 记录失败不影响配网主流程 */
  }

  /* ---------- 等待运行时真正拿到 IP ---------- */
  onProgress({ stage: 'verify', text: '配置已保存，等待设备获取 IP' });
  const verifyDeadline = Date.now() + verifyTimeoutMs;
  let status = null;
  let lastMismatch = '';

  while (Date.now() < verifyDeadline) {
    try {
      status = await protocol.networkStatus();
    } catch (err) {
      if (err.code === 'unauthorized') throw err;
      await sleep(verifyIntervalMs);
      continue;
    }

    const st = status || {};
    const hasIp = !!st.sta_has_ip && !!st.sta_ip && st.sta_ip !== '0.0.0.0';
    /* 有 IP 不代表连的就是目标 SSID：非静态模式会自动回退到其它已保存 profile。
       固件暴露 connected_ssid 时以它为准，不一致就继续等（可能是 apply 尚未生效）。 */
    const curSsid = st.connected_ssid ? String(st.connected_ssid) : '';
    const mismatch = !!curSsid && curSsid !== ssid;
    /* 契约 v1.1 got_ip 语义（states.json#got_ip_semantics）：IP + 联网验证 + MQTT 就绪
       三者缺一不交付。成功判据与之统一：internet_verified / mqtt_connected 为 false 就继续等
       （verify 窗口内等满仍 false → pending 返回，页面提示未完成，不再"有 IP 即成功"）。
       容忍未知字段：字段缺失（旧固件）不拦，按 hasIp + SSID 一致判定。 */
    const verified = st.internet_verified !== false;
    const mqttUp = st.mqtt_connected !== false;
    onProgress({
      stage: 'verify',
      text: hasIp
        ? mismatch
          ? '设备已拿到 IP，但实际连的是「' + curSsid + '」而不是「' + ssid + '」，等待切换'
          : !verified
            ? '设备已获取 IP，等待联网验证（broker 路径）'
            : (st.mqtt_connected ? '设备已上线，MQTT 已连接' : '设备已获取 IP，等待 MQTT 连接')
        : '等待设备获取 IP',
      status: st,
    });

    if (hasIp && !mismatch && verified && mqttUp) {
      lastSuccess = {
        ssid: ssid,
        operationId: operationId,
        at: Date.now(),
        ip: st.sta_ip,
        mqtt: !!st.mqtt_connected,
        internetVerified: st.internet_verified === true,
        connectedSsid: curSsid,
        lastDisconnect: st.last_disconnect || '',
      };
      /* 口令已被设备验证成功：记下来，下次选中同一 SSID 自动回填 */
      try {
        pwstore.remember(ssid, password);
      } catch (e) {
        /* 记忆失败不影响配网结果 */
      }
      return {
        operationId: operationId,
        operation: operation,
        applied: applied,
        status: status,
        pending: false,
      };
    }
    if (hasIp && mismatch) lastMismatch = curSsid;
    await sleep(verifyIntervalMs);
  }

  return {
    operationId: operationId,
    operation: operation,
    applied: applied,
    status: status,
    pending: true,
    mismatch: lastMismatch,
  };
}

/**
 * 带时间线取证的配网入口（签名与原 provisionWifi 完全一致）。
 * 每次调用重置并激活时间线，记录阶段迁移、结果/错误；BLE 断链由模块级
 * 监听器捕获并标注当时步骤与在途请求。
 */
async function provisionWifi(protocol, options) {
  timelineReset();
  activeProtocol = protocol;
  tl('start', 'ssid=' + (options && options.ssid));
  const onProgress = options.onProgress;
  const wrapped = onProgress
    ? function (p) {
        if (p && p.stage) {
          tl('stage', p.stage + (p.state ? '/' + p.state : ''));
          setStep(p.stage); // 断链取证要的是"当时处于哪一步"
        }
        onProgress(p);
      }
    : options.onProgress;
  const wrappedOpts = Object.assign({}, options, { onProgress: wrapped });
  try {
    const r = await provisionWifiImpl(protocol, wrappedOpts);
    tl('done', 'pending=' + r.pending + ' ip=' + ((r.status && r.status.sta_ip) || '-') + ' mqtt=' + !!(r.status && r.status.mqtt_connected));
    return r;
  } catch (err) {
    tl('error', (err.code || '') + ' ' + (err.message || ''));
    throw err;
  } finally {
    activeProtocol = null;
  }
}

/** 取消活动 operation（重复 cancel 幂等；success/committing 会返回 operation_state） */
async function cancelOperation(protocol, operationId) {
  if (!operationId) return null;
  try {
    return await protocol.networkCancel(operationId);
  } catch (err) {
    if (err.code === 'not_found' || err.code === 'operation_state') return null;
    throw err;
  }
}

module.exports = {
  provisionWifi,
  cancelOperation,
  ProvisionError,
  STATE_TEXT,
  recordSuccess,
  lastProvision,
  recordAttempt,
  lastRescueAttempt,
  timelineReset,
  setStep,
  tl,
  timelineText,
};
