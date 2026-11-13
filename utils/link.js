/**
 * 一键把链路拉起来：扫描 → 连接 → 发现 → 订阅 → device.info → auth.login。
 *
 * 为什么要单独一层：T4 的多数验收项都要求「已连接且已登录」，
 * 而第 1 项又必须在断开状态取证。现场常见的死局是：
 * 断开后验收页直接拦住不让跑，只能退回设备页手动扫、手动连、手动输密码。
 * 这里把「断开 → 自动恢复」做成一个可复用动作，页面只管调用与展示。
 *
 * 不修改任何业务状态：只建链路、只登录，不发配网/配置类命令。
 * 纯逻辑（不直接调 wx），可在 Node 下用桩回归。
 */

const { describe } = require('./errors');
const { nameTail } = require('./ble');

/* 12s：正常断连固件 ~30-40ms 恢复广播；极端竞态下设备侧看门狗最坏 ~6s 才重新
 * 广播（P0-6，退避 2/4/8/16/30s）。9s 余量偏薄（T5 run1 #9 relink-failed:scan
 * 即疑似命中），提到 12s 覆盖看门狗兜底路径（T4 §2.1 建议重扫窗口 ≥10s）。 */
const DEFAULT_SCAN_TIMEOUT = 12000;

/* 拆旧链路后复核「设备重新广播」的等待窗（P1-2，2026-11-10 评审）。
 * TODO(P2-2)：进契约 derived_client_budgets.client_adv_wait_ms 后改读契约值；
 * 硬件侧已在 timing.json 登记 link_recovery（设备订阅态自救 300s ≫ 客户端 26s）。 */
const ADV_RECOVER_WAIT_MS = 12000;

/* 这些错误码是「答案」而不是「没答上」：重试也不会变，直接上抛。
 * 其余（timeout/disconnected 等）视为瞬时失败，退避后重试一次——
 * 链路刚建立时设备侧命令通道未必就绪，真机上 auth.login 首发
 * timeout、第二发成功就是这类时序问题。 */
const AUTH_DEFINITIVE_CODES = [
  'unauthorized',
  'invalid_credentials',
  'invalid_argument',
  'guard_rejected',
  'forbidden',
];

/**
 * 登录重试包装：瞬时失败（timeout 等）退避后重试一次，确定性失败直接上抛。
 * @param {function():Promise} fn 返回登录 Promise 的 thunk（普通 login 或 relogin 均可）
 * @param {{tries?:number, backoffMs?:number}} [opts]
 */
async function loginWithRetry(fn, opts) {
  const o = opts || {};
  const tries = o.tries || 2;
  const backoffMs = o.backoffMs === undefined ? 800 : o.backoffMs;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const code = (e && e.code) || '';
      if (AUTH_DEFINITIVE_CODES.indexOf(code) >= 0) throw e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}

/**
 * 目标与「实连设备」是否同一台（B · 身份锁）。
 *
 * 只用 4 位十六进制尾号比对：广播名 `IotHubBLE-65D8`、device.info 的 `device_id: IotHub-65D8`
 * 同尾 65D8。**MAC 尾号不同源**（65D8 的 MAC 是 …65:DA），不能反推，因此只在名字/id 都有尾号时判定。
 * 取不到尾号 → verified:false 但不拦（旧固件可能不报 device_id；此时必须留痕，不允许静默）。
 *
 * @param {{name?:string,deviceId?:string}} target
 * @param {Object|null} device device.info 应答
 * @returns {{ok:boolean, verified:boolean, reason:string, want:string, got:string, wantTail?:string, gotTail?:string}}
 */
function compareIdentity(target, device) {
  const wantName = (target && target.name) || '';
  const want = nameTail(wantName);
  const gotId = (device && device.device_id) || '';
  const got = nameTail(gotId);
  if (!want) return { ok: true, verified: false, reason: 'no_target_name', want: wantName, got: gotId };
  if (!got) return { ok: true, verified: false, reason: 'device_id_missing', want: wantName, got: gotId };
  return {
    ok: want === got,
    verified: true,
    reason: want === got ? 'tail_match' : 'tail_mismatch',
    want: wantName,
    got: gotId,
    wantTail: want,
    gotTail: got,
  };
}

/**
 * @param {BleManager} ble
 * @param {Protocol} protocol
 * @param {{target?:{deviceId?:string,name?:string}, username?:string, password?:string,
 *          scanTimeout?:number, onStep?:function(string):void}} [opts]
 * @returns {Promise<{ok:boolean, linked:boolean, loggedIn:boolean, deviceId:string, deviceName:string,
 *          stage:string, error:string, code:string, ms:number, total:number, ttl:number,
 *          subscribed:string[], device:Object|null,
 *          scan:({outcome:'ok'|'timeout'|'error', attempts?:number, ms:number, code?:string}|null)}>}
 */
async function ensureLink(ble, protocol, opts) {
  const o = opts || {};
  const target = o.target || {};
  const step = typeof o.onStep === 'function' ? o.onStep : function () {};
  const started = Date.now();
  const out = {
    ok: false,
    linked: false,
    loggedIn: false,
    deviceId: '',
    deviceName: '',
    stage: 'init',
    error: '',
    code: '',
    ms: 0,
    total: 0,
    ttl: 0,
    subscribed: [],
    device: null,
    scan: null,
    identity: null,
    candidate: null,
  };

  const finish = function () {
    out.ms = Date.now() - started;
    return out;
  };

  try {
    if (!ble.available) {
      step('打开蓝牙适配器');
      try {
        await ble.open();
      } catch (e) {
        // 适配器打不开时扫描必然失败，交给下面的 findDevice 报更具体的原因
      }
    }

    /* 1) 找设备：已连接且链路真的还在，就直接用当前链路 */
    let dev = null;
    if (ble.connected && ble.deviceId) {
      out.stage = 'probe';
      step('检查现有链路');
      /* 断开前先留档身份：disconnect() 会清空 ble.deviceId/deviceName，
         复核广播要按「刚拆掉的那条链路的对端」匹配（2026-11-10 P1-2）。 */
      const staleId = ble.deviceId;
      const staleName = ble.deviceName || '';
      try {
        await ble.discover(); // 能读到服务 = 链路真的还在
        dev = { deviceId: ble.deviceId, name: ble.deviceName, exact: true };
      } catch (e) {
        // 页面以为还连着、其实已经断了（真机断连后状态可能滞后）：拆掉重扫
        try {
          await ble.disconnect();
        } catch (e2) {
          /* 已经断了就不用再关 */
        }
        /* P1-2（2026-11-10 评审）：disconnect 的 closed 只代表手机本地 GATT 关闭
         * （ble.js 同款注释），Android 连接缓存能把 ACL 留住——设备 conn=1 依规
         * 不广播，26s 扫描预算内必然扫不到（T4 #11/#21 两次实证）。与 #11 的
         * waitForAdvertising 方法论对齐：拆链后先复核设备侧广播，等不到就返回
         * link_stale 交给调用方（验收路径先试 resetAdapter；产品路径提示一键
         * 「重启蓝牙恢复广播」按钮），不再把 26s 烧在注定扫不到的窗口上。 */
        const adv = await ble.waitForAdvertising(
          staleId || target.deviceId || '',
          staleName || target.name || '',
          ADV_RECOVER_WAIT_MS
        );
        if (!adv.seen) {
          out.stage = 'link_recovery';
          out.code = 'link_stale';
          out.scan = { outcome: 'link_stale', attempts: 0, ms: adv.ms };
          out.error =
            '旧链路拆掉后 ' + (adv.ms / 1000).toFixed(1) + 's 内未见设备重新广播：' +
            '手机栈半开（设备仍 conn=1，依规不广播），继续扫描也扫不到。' +
            '点「重启蓝牙恢复广播」按钮一键恢复（等价关开系统蓝牙），恢复后重试。';
          return finish();
        }
      }
    }
    if (!dev) {
      out.stage = 'scan';
      step('扫描设备');
      const scanMs = o.scanTimeout || DEFAULT_SCAN_TIMEOUT;
      /* 主动断开后设备可能根本没收到断连（Android 连接缓存 / 监督超时未到期），
       * 12s 内不会恢复广播——真机 T4 报告两次命中：#11 断连与重连 12.1s 未恢复广播、
       * #21 relink3 第 1 轮扫描 12s 未发现。而正常断连 1.2s 即可扫回（同报告 #1）。
       * 与 connect 阶段的退避重试对齐：timeout 时退避 2s 复扫一次，两窗累计 ~26s，
       * 覆盖监督超时与手机栈常规恢复窗口；订阅态僵尸链路（设备订阅会话自救 300s，
       * 契约 v1.1）远超本预算——那条路由 link_stale / 适配器重启处理，别指望扫到。
       * error（扫描流程自身失败）不复扫，重试也不会变。 */
      const SCAN_SETTLE_MS = 2000;
      const attempts = [];
      let found = null;
      for (let i = 0; i < 2 && !found; i++) {
        if (i > 0) {
          step('第一次扫描未发现，退避后复扫');
          await new Promise((r) => setTimeout(r, SCAN_SETTLE_MS));
        }
        try {
          found = await ble.findDevice({
            deviceId: target.deviceId,
            name: target.name,
            timeout: scanMs,
          });
        } catch (e) {
          /* 扫描流程自身失败（startScan 被拒/适配器异常等），与"扫满窗口没找到"是两类问题 */
          out.scan = { outcome: 'error', attempts: i + 1, code: (e && e.code) || '', ms: Date.now() - started };
          const d = describe(e);
          out.error = '扫描流程自身失败（未完成等待窗口）: ' + d.text + (d.hint ? '（' + d.hint + '）' : '');
          return finish();
        }
        attempts.push(found ? 'hit' : 'miss');
      }
      if (!found) {
        /* 扫满两个窗口、流程正常，就是没发现设备：真正的"未发现" */
        const waited = attempts.length * scanMs + (attempts.length - 1) * SCAN_SETTLE_MS;
        out.scan = { outcome: 'timeout', attempts: attempts.length, ms: waited };
        out.error =
          (attempts.length > 1
            ? '两次扫描共 ' + Math.round(waited / 1000) + 's'
            : '扫描 ' + Math.round(scanMs / 1000) + 's') +
          ' 没发现 NUS 设备：' +
          '确认设备已上电且没有被其它手机连着；Android 还需开启系统定位并授予微信定位权限。' +
          '单次扫描失败不直接判定为固件缺陷；持续 30s 以上仍扫不到时，优先排查「订阅态僵尸链路」' +
          '（2026-11-09 T4 #4 实证：请求超时后手机栈不拆链，设备 conn=1 依规不广播，' +
          '固件看门狗又被订阅豁免挡住——特征=设备侧串口 conn=1 且 rx_age_ms>90000，' +
          '此模式下 adv_retry_count 恒 0，不能用它佐证看门狗健康）；' +
          '恢复：点上方「重启蓝牙恢复广播」按钮一键恢复（等价手机关蓝牙再开/强制停止微信）' +
          '→ 链路层断开，设备约 1s 内恢复广播';
        return finish();
      }
      out.scan = { outcome: 'ok', attempts: attempts.length, ms: Date.now() - started };
      /* B · 禁静默降级：findDevice 在精确目标缺席时会退回「本窗口第一个 NUS 设备」。
         有目标时绝不能拿这个候选直接连——2026-11-08 21:48 串台就是这条路径：
         65D8 掉线后 ensureLink 连到了 C8E4，整轮 T4 跑在错误设备上。 */
      if (!found.exact && (target.deviceId || target.name)) {
        out.stage = 'identity';
        out.code = 'device_mismatch';
        out.candidate = {
          deviceId: found.deviceId,
          name: found.name,
          rssi: found.rssi,
          by: found.by || 'any',
        };
        out.error =
          '未发现目标设备「' + (target.name || target.deviceId) + '」，本窗口只扫到「' +
          (found.name || found.deviceId) + '」；已拒绝连接以避免连错设备。' +
          '请确认目标设备已上电并在范围内（或回设备页手动选择设备）。';
        step('目标设备不在场：拒绝连到 ' + (found.name || found.deviceId));
        return finish();
      }
      dev = found;
    }

    /* 2) 连接 + 发现特征 + 订阅：整体失败时拆线退避重试一轮。
     * Android 上「连上后立刻 discover 拿到空缓存 / subscribe 报 10006」很常见，
     * 表现为第一次连不上、再点一次就好——与其让用户手动重试，这里自动补一轮。 */
    out.stage = 'connect';
    let linkErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (!ble.connected) await ble.connect(dev.deviceId, dev.name);
        out.linked = true;
        out.deviceId = ble.deviceId;
        out.deviceName = ble.deviceName;

        out.stage = 'discover';
        const info = await ble.discover();
        out.total = info.total;

        /* 订阅：先 CMD TX 再 DATA TX（协议要求先订阅后发命令） */
        out.stage = 'subscribe';
        await ble.subscribe('CMD_TX');
        out.subscribed = ['CMD_TX'];
        if (info.chars.DATA_TX) {
          try {
            await ble.subscribe('DATA_TX');
            out.subscribed.push('DATA_TX');
          } catch (e) {
            /* DATA 通道订阅失败不影响命令通道，验收页会单独判定 */
          }
        }
        linkErr = null;
        break;
      } catch (e) {
        linkErr = e;
        out.linked = false;
        try {
          await ble.disconnect();
        } catch (e2) {
          /* 已经断了 */
        }
        if (attempt === 0) {
          step('链路建立失败，退避重试');
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    }
    if (linkErr) throw linkErr;

    /* 4) device.info 不需要 token，先确认链路真的能收发 */
    out.stage = 'device.info';
    try {
      out.device = await protocol.deviceInfo();
    } catch (e) {
      // 命令通道可能刚起来需要一点时间；登录本身还会再发命令，这里不急着报错
    }

    /* B · 身份锁：连上 ≠ 连对。device.info 的 device_id 是唯一权威字段
       （广播名由请求方带进来，MAC 尾号与 id 不同源）。不一致立刻断链，
       不允许在陌生设备上继续登录/取证——无人确认的自动化路径尤其如此。 */
    const idc = compareIdentity(target, out.device);
    out.identity = idc;
    if (!idc.ok) {
      step('设备身份不符：断开 ' + idc.got);
      try {
        await ble.disconnect();
      } catch (e) {
        /* 已经断了 */
      }
      out.linked = false;
      out.code = 'device_mismatch';
      out.error =
        '链路实际连到「' + idc.got + '」，与目标「' + idc.want + '」不符，已断开。' +
        '同型号多台设备在场时最容易发生（广播名相近）；请确认目标设备在场后重试。';
      return finish();
    }
    if (idc.verified) step('设备身份校验通过：' + idc.got);

    /* 5) 登录 */
    out.stage = 'login';
    if (protocol.loggedIn) {
      out.loggedIn = true;
      out.ttl = protocol.tokenRemaining();
    } else {
      if (!o.username) {
        out.error = '已连接，但没有可用的登录账号';
        return finish();
      }
      step('登录设备');
      try {
        const data = await loginWithRetry(() =>
          protocol.login(o.username, o.password === undefined ? '' : o.password)
        );
        out.loggedIn = true;
        out.ttl = (data && data.expires_in) || 600;
      } catch (e) {
        const d = describe(e);
        out.code = (e && e.code) || '';
        out.error =
          '已连接（' + (ble.deviceName || dev.name || dev.deviceId) + '），但登录失败：' + d.text +
          (d.hint ? '（' + d.hint + '）' : '') +
          (out.code === 'unauthorized' ? '；默认账号为 admin / 123456，改过密码请在设备页改输入框后登录' : '');
        return finish();
      }
    }

    out.ok = true;
    out.stage = 'ready';
    return finish();
  } catch (err) {
    const d = describe(err);
    out.code = (err && err.code) || '';
    out.error = d.text + (d.hint ? '（' + d.hint + '）' : '');
    if (!out.linked) {
      try {
        await ble.disconnect();
      } catch (e) {
        /* 忽略 */
      }
    }
    return finish();
  }
}

module.exports = { ensureLink, loginWithRetry, compareIdentity, DEFAULT_SCAN_TIMEOUT };
