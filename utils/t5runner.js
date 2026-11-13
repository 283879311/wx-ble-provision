/**
 * T5「常态化运行与异常韧性验收」测试器。
 *
 * 定位（按 T5 方案冻结版）：
 *  - 固件稳定性为主，小程序只是测试工具；不引入新协议版本。
 *  - 每轮保留原始请求/响应 id、operation_id、状态迁移与计时，
 *    不能只保留最终 PASS/FAIL。
 *  - 错误分类分别记录：wrong_password / ap_not_found / wifi_scan_failed /
 *    timeout / busy / no_slot / operation_state / expired / disconnected。
 *    wifi_scan_failed 是 P1-10 方案 A 的新错误码（预扫描两次均败），必须保持
 *    可分辨——B 轮设计内失败不含它，出现即记 fail 并进错误分布。
 *  - 可中止：中止后不再发起新操作，并按协议清理当前活动操作。
 *  - 断连不无限重试（只补链一次），不复用旧会话 token（重连后重新登录）。
 *  - 堆曲线本阶段不在协议层（固件未暴露 heap 字段）：以串口 diag 日志
 *    为准，报告留对时占位；这是 T5 第一阶段「不动固件」的已知边界。
 *
 * 纯逻辑（不直接调 wx），可在 Node 下用桩回归。
 */

const { sleep, stamp } = require('./util');
const { ensureLink } = require('./link');
const { cancelOperation } = require('./provision');

/* 场景代号：A 试连后取消/回滚；B 设计内失败；C 成功 apply；D 断连重登 */
const SCEN = {
  A: 'tryconnect-cancel',
  B: 'designed-failure',
  C: 'apply',
  D: 'relink',
};

const SET_MIXED = 'mixed';
const SET_FAILURE = 'failure';
const SET_CONNECT = 'connect';
const SET_APPLY = 'apply';

/* 终态集合：取自契约（states.json#terminal_states），不再手写 */
const TERMINAL_STATES = require('./contract').TERMINAL_STATES;

const ABSENT_SSID_PREFIX = '__t5_noap_';

/* ---------------- 计划生成 ---------------- */

/**
 * 50 轮 mixed = 15/15/10/10（A/B/C/D）；10 轮按同比例取整 3/3/2/2。
 * failure 只排 B；connect 只排 D。
 */
function buildPlan(rounds, set) {
  const n = Math.max(1, rounds | 0);
  const plan = [];
  if (set === SET_FAILURE) {
    for (let i = 0; i < n; i++) plan.push(SCEN.B);
    return plan;
  }
  if (set === SET_CONNECT) {
    for (let i = 0; i < n; i++) plan.push(SCEN.D);
    return plan;
  }
  if (set === SET_APPLY) {
    for (let i = 0; i < n; i++) plan.push(SCEN.C);
    return plan;
  }
  /* mixed：A/B/C/D = 3:3:2:2 */
  const unit = [SCEN.A, SCEN.A, SCEN.A, SCEN.B, SCEN.B, SCEN.B, SCEN.C, SCEN.C, SCEN.D, SCEN.D];
  for (let i = 0; i < n; i++) plan.push(unit[i % unit.length]);
  return plan;
}

/* ---------------- 工具 ---------------- */

function maskArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const out = {};
  Object.keys(args).forEach(function (k) {
    if (k === 'password' || k === 'token') {
      out[k] = args[k] ? '***' : args[k];
    } else {
      out[k] = args[k];
    }
  });
  return out;
}

function isTerminal(state) {
  return TERMINAL_STATES.indexOf(state) >= 0;
}

/**
 * 口令证据（C v2 定案用）：只记「是否非空 + 长度」，绝不记口令本身。
 * 判据：口令非空时，原固件从未出现 T5 C 轮快速 connect_failed 特征
 * （2026-10-25 原固件基线 t5c_cv2_20261025_130605.json）。
 */
function pwEvidence(pw) {
  const s = String(pw === undefined || pw === null ? '' : pw);
  return { nonEmpty: s.length > 0, len: s.length };
}

/**
 * 轮询 operation.get 直到终态或超时。单次查询失败不终止（长响应/调度延迟），
 * 记录到 transitions，超时返回 state='timeout'。
 */
async function pollTerminal(protocol, operationId, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || 40000;
  const intervalMs = o.intervalMs || 800;
  const onEvent = o.onEvent || function () {};
  const deadline = Date.now() + timeoutMs;
  const seen = [];
  let last = null;

  while (Date.now() < deadline) {
    let st;
    try {
      st = await protocol.operationGet(operationId);
    } catch (err) {
      const code = (err && err.code) || 'unknown';
      if (code === 'not_found') {
        /* 记录已被回收：这本身就是终态证据（T5 槽语义） */
        last = { state: 'not_found', error: 'not_found' };
        seen.push('not_found');
        break;
      }
      if (code === 'unauthorized') throw err;
      onEvent({ kind: 'poll-error', code: code });
      await sleep(intervalMs);
      continue;
    }
    const state = st && st.state ? st.state : 'unknown';
    if (seen[seen.length - 1] !== state) {
      seen.push(state);
      onEvent({ kind: 'transition', state: state, error: st && st.error });
    }
    last = { state: state, error: st && st.error ? st.error : 'none', raw: st };
    if (isTerminal(state)) break;
    await sleep(intervalMs);
  }
  if (!last) last = { state: 'timeout', error: 'timeout' };
  last.transitions = seen;
  return last;
}

/** 试连并等到终态；返回 { opId, terminal } */
async function tryconnectToTerminal(protocol, ssid, password, key, opts) {
  const acc = await protocol.tryConnect(ssid, password, key);
  const opId = acc && acc.operation_id;
  if (!opId) {
    const e = new Error('tryconnect 未返回 operation_id');
    e.code = 'internal_error';
    throw e;
  }
  const terminal = await pollTerminal(protocol, opId, opts);
  return { opId: opId, terminal: terminal };
}

/* ---------------- 四类场景 ---------------- */

/**
 * A：试连目标 AP，进入 connecting 后取消；验证 cancel 幂等。
 * 正式配置不被触碰（不 apply）。
 */
async function runA(ctx, cfg, rec) {
  const { protocol } = ctx;
  const pollOpts = { intervalMs: cfg.pollIntervalMs, timeoutMs: cfg.pollTimeoutMs };
  rec.pwEvidence = pwEvidence(cfg.targetPassword);
  rec.requests.push({ cmd: 'network.tryconnect', args: maskArgs({ ssid: cfg.targetSsid, password: cfg.targetPassword, idempotency_key: rec.key }) });
  const r = await tryconnectToTerminal(protocol, cfg.targetSsid, cfg.targetPassword, rec.key, {
    intervalMs: pollOpts.intervalMs,
    timeoutMs: pollOpts.timeoutMs,
    onEvent: function (e) {
      if (e.kind === 'transition') rec.transitions.push(e.state);
    },
  });
  rec.opId = r.opId;
  rec.terminal = r.terminal;

  /* 等到 got_ip 才取消会拖慢节奏：进入 connecting 即取消 */
  if (r.terminal.state === 'got_ip' || isTerminal(r.terminal.state) === false) {
    rec.requests.push({ cmd: 'network.cancel', args: { operation_id: r.opId } });
    await cancelOperation(protocol, r.opId);
    rec.terminal = await pollTerminal(protocol, r.opId, pollOpts);
    rec.transitions.push('cancel-sent');
  }

  /* cancel 幂等：重复 cancel 返回 cancelled 或 operation_state 都算符合协议 */
  rec.requests.push({ cmd: 'network.cancel#2', args: { operation_id: r.opId } });
  let doubleCancel = 'ok';
  try {
    await cancelOperation(protocol, r.opId);
  } catch (err) {
    doubleCancel = (err && err.code) || 'unknown';
  }
  rec.doubleCancel = doubleCancel;

  const finalState = rec.terminal.state;
  const finalError = rec.terminal.error && rec.terminal.error !== 'none' ? rec.terminal.error : '';
  if (finalState === 'cancelled' &&
      (doubleCancel === 'ok' || doubleCancel === 'operation_state' || doubleCancel === 'cancelled')) {
    rec.outcome = 'pass';
  } else {
    rec.outcome = 'fail';
    rec.error = finalError || finalState;
  }
}

/**
 * B：设计内失败。奇数轮错口令（wrong_password），偶数轮不存在 SSID
 * （ap_not_found / timeout）。错误码必须与设计一致，否则记 fail
 * （例如被 no_slot/busy 顶替 = 槽语义或分类出了问题）。
 * wifi_scan_failed（预扫描两次均败）不在设计内：保持独立错误码并记 fail，
 * 不折叠进 ap_not_found——这样 P1-10 的修复效果才可被 soak 统计验证。
 * 「正式配置未被覆盖」判据按 rec.expectedFormal（runT5 起始时实测的正式
 * SSID，C 轮 apply 成功后更新为目标）：目标≠正式（如 M3-2 热点当目标）时
 * 不再把正确分类的 B 轮误报成 FAIL。每轮后核对正式 SSID。
 */
async function runB(ctx, cfg, rec, roundIndex) {
  const { protocol } = ctx;
  const wrongPw = roundIndex % 2 === 0;
  const ssid = wrongPw ? cfg.targetSsid : ABSENT_SSID_PREFIX + rec.key;
  const password = wrongPw ? cfg.wrongPassword : '';
  const designed = wrongPw ? ['wrong_password'] : ['ap_not_found', 'timeout'];

  rec.pwEvidence = pwEvidence(password);

  rec.requests.push({ cmd: 'network.tryconnect', args: maskArgs({ ssid: ssid, password: password, idempotency_key: rec.key }) });
  try {
    const r = await tryconnectToTerminal(protocol, ssid, password, rec.key, {
      intervalMs: cfg.pollIntervalMs,
      timeoutMs: cfg.pollTimeoutMs,
      onEvent: function (e) {
        if (e.kind === 'transition') rec.transitions.push(e.state);
      },
    });
    rec.opId = r.opId;
    rec.terminal = r.terminal;
    rec.error = r.terminal.error && r.terminal.error !== 'none' ? r.terminal.error : r.terminal.state;
  } catch (err) {
    /* tryconnect 被设备直接拒绝（busy/no_slot 等）也算本轮结果 */
    rec.error = (err && err.code) || 'unknown';
    rec.terminal = { state: 'rejected', error: rec.error };
  }

  /* 正式配置未被覆盖 */
  let formalNow = '';
  try {
    const cfgNow = await protocol.configGet(['network']);
    formalNow = String((cfgNow && cfgNow.network && cfgNow.network.sta_ssid) || '').trim();
  } catch (e) {
    formalNow = '(config.get 失败:' + ((e && e.code) || 'unknown') + ')';
  }
  rec.formalSsidAfter = formalNow;
  rec.requests.push({ cmd: 'config.get', args: { domains: ['network'] } });

  /* 一次复读（只作证据，不改判据）：区分「失败重连窗口内 sta_ssid 运行态回显
   * 漂移（1.2s 后恢复）」与「持久漂移」。2026-10-28 真机 t5-155038100-C38A：
   * 三个 B 轮全 FAIL 但错误码都在设计内，且错口令轮（#5 试连目标=正式 SSID）
   * 也 FAIL——「固件把候选 SSID 写进 config」假设被 #5 反证排除，
   * 剩「失败窗口内运行态回显为空/漂移」假设，用复读定分晓。 */
  const formalExpected = rec.expectedFormal || cfg.formalSsid;
  if (formalNow !== formalExpected && formalNow.indexOf('(') !== 0) {
    await sleep(1200);
    try {
      const cfg2 = await protocol.configGet(['network']);
      rec.formalSsidAfter2 = String((cfg2 && cfg2.network && cfg2.network.sta_ssid) || '').trim();
    } catch (e) {
      rec.formalSsidAfter2 = '(config.get 失败:' + ((e && e.code) || 'unknown') + ')';
    }
    rec.requests.push({ cmd: 'config.get#2', args: { domains: ['network'] } });
  }

  if (designed.indexOf(rec.error) >= 0) {
    if (formalNow === (rec.expectedFormal || cfg.formalSsid) || formalNow.indexOf('(') === 0) {
      rec.outcome = 'expected';
    } else {
      /* 错误分类正确但「正式配置未被覆盖」不成立——这才是本轮的真实失败原因。
       * error 必须改写成 formal-overwritten:<实测 sta_ssid>，否则错误分布里
       * 仍是 ap_not_found/wrong_password，会被误读成「错误分类出了问题」。
       * designedError 保留原始设计内错误码，供与固件对账。 */
      rec.outcome = 'fail';
      rec.designedError = rec.error;
      rec.error = 'formal-overwritten:' + (formalNow === '' ? '(空)' : formalNow);
    }
  } else if (rec.error === 'busy' || rec.error === 'no_slot') {
    rec.outcome = 'fail'; /* busy/no_slot 出现在设计内失败轮 = 分类/槽语义异常 */
  } else {
    rec.outcome = 'fail';
  }
}

/**
 * C：完整配网（tryconnect → got_ip → apply → 等 IP/MQTT）。
 * 默认 apply 目标 = 当前正式网络（配置零漂移），复用 provision.js 主流程。
 */
async function runC(ctx, cfg, rec, opts) {
  const { provisionWifi } = require('./provision');
  rec.pwEvidence = pwEvidence(cfg.targetPassword);
  rec.requests.push({ cmd: 'network.tryconnect+apply', args: maskArgs({ ssid: cfg.targetSsid, password: cfg.targetPassword, idempotency_key: rec.key }) });
  const result = await provisionWifi(ctx.protocol, {
    ssid: cfg.targetSsid,
    password: cfg.targetPassword,
    isCancelled: opts.isAborted,
    verifyTimeoutMs: cfg.verifyTimeoutMs,
    verifyIntervalMs: cfg.verifyIntervalMs,
    onProgress: function (p) {
      if (p.state) rec.transitions.push(p.state);
      rec.requests.push({ cmd: 'progress', args: { stage: p.stage, state: p.state || '' } });
    },
  });
  rec.opId = result.operationId;
  const st = result.status || {};
  rec.statusAfter = {
    sta_has_ip: !!st.sta_has_ip,
    sta_ip: st.sta_ip || '',
    mqtt_connected: !!st.mqtt_connected,
    connected_ssid: st.connected_ssid || '',
  };

  if (result.pending) {
    rec.outcome = 'fail';
    rec.error = result.mismatch ? 'fallback:' + result.mismatch : 'apply-pending';
    return;
  }
  /* profile 不累积 */
  let profiles = [];
  try {
    const pl = await ctx.protocol.profileList();
    profiles = Array.isArray(pl) ? pl : (pl && pl.profiles) || [];
  } catch (e) {
    profiles = [];
  }
  rec.profileCount = profiles.length;
  rec.requests.push({ cmd: 'network.profile.list', args: {} });

  const online = rec.statusAfter.sta_has_ip && rec.statusAfter.sta_ip !== '0.0.0.0';
  const onTarget = !rec.statusAfter.connected_ssid || rec.statusAfter.connected_ssid === cfg.targetSsid;
  if (online && onTarget && rec.profileCount <= cfg.profileMax) {
    rec.outcome = 'pass';
  } else {
    rec.outcome = 'fail';
    rec.error = !online ? 'no-ip' : (!onTarget ? 'fallback:' + rec.statusAfter.connected_ssid : 'profile-accumulation:' + rec.profileCount);
  }
}

/**
 * D：主动断开 BLE → 设备恢复广播 → 补链（含重新登录）→ 查状态。
 * 只补链一次；失败即终止整轮 run（按方案原则 3，不无限重试）。
 */
async function runD(ctx, cfg, rec, opts) {
  const { ble, protocol } = ctx;
  rec.requests.push({ cmd: 'ble.disconnect', args: {} });
  try {
    await ble.disconnect();
  } catch (e) {
    /* 已断开时 close 可能报错，忽略 */
  }
  await sleep(cfg.relinkGapMs !== undefined ? cfg.relinkGapMs : 1200); /* 设备 1.2s 左右恢复广播（T4 实测） */

  rec.requests.push({ cmd: 'relink+relogin', args: { target: ble.deviceName || '' } });
  const link = await opts.relinkFn(ctx, cfg);
  rec.linkMs = link.ms;
  if (!link.ok || !link.loggedIn) {
    rec.outcome = 'fail';
    /* A2：区分「扫满窗口没发现设备」（设备侧广播缺失嫌疑）与「扫描流程自身失败」
     * （startScan 被拒/适配器异常等手机侧问题）——两类不能混为一个 relink-failed:scan */
    let why = link.code || link.stage || 'unknown';
    if (link.scan && link.scan.outcome === 'timeout') why = 'scan-timeout';
    else if (link.scan && link.scan.outcome === 'error') why = 'scan-error';
    else if (why === 'scan') why = 'scan-timeout'; /* 旧链路结果对象兜底 */
    rec.error = 'relink-failed:' + why;
    rec.linkScan = link.scan || null;
    return;
  }

  const st = await protocol.networkStatus();
  rec.requests.push({ cmd: 'network.status', args: {} });
  rec.statusAfter = {
    sta_has_ip: !!st.sta_has_ip,
    sta_ip: st.sta_ip || '',
    mqtt_connected: !!st.mqtt_connected,
    connected_ssid: st.connected_ssid || '',
  };
  rec.outcome = 'pass';
}

/* ---------------- 主循环 ---------------- */

/**
 * @param {{ble, protocol}} ctx
 * @param {object} cfg { rounds, set, pacing, targetSsid, targetPassword,
 *   wrongPassword, adminUser, adminPass, formalSsid, profileMax,
 *   verifyTimeoutMs, verifyIntervalMs, relinkFn }
 * @param {object} opts { isAborted():boolean, onRound(rec):void, onEvent(e):void,
 *   relinkFn(ctx,cfg):Promise }
 */
async function runT5(ctx, cfg, opts) {
  const o = opts || {};
  const isAborted = o.isAborted || function () { return false; };
  const onRound = o.onRound || function () {};
  const onEvent = o.onEvent || function () {};
  const relinkFn = o.relinkFn || defaultRelink;

  const run = {
    runId: 't5-' + stamp().replace(/[^0-9]/g, '') + '-' + Math.floor(Math.random() * 0xffff).toString(16).toUpperCase(),
    config: {
      rounds: cfg.rounds,
      set: cfg.set,
      pacing: cfg.pacing || 'serial',
      targetSsid: cfg.targetSsid,
      formalSsid: cfg.formalSsid || cfg.targetSsid,
      profileMax: cfg.profileMax || 2,
      /* C v2 口令证据：只记布尔+长度，不记口令 */
      targetPwNonEmpty: !!cfg.targetPassword,
      targetPwLen: String(cfg.targetPassword || '').length,
    },
    plan: buildPlan(cfg.rounds, cfg.set),
    records: [],
    summary: null,
    aborted: false,
    abortReason: '',
    t0: Date.now(),
    t1: 0,
  };

  /* B 轮「正式配置未被覆盖」的期望值：起始时以设备实测为准（目标≠正式的
   * 场景——如热点只当目标——不能拿 cfg.formalSsid 硬套）；读不到才回退配置值。
   * C 轮 apply 成功后正式配置会变成目标，届时在轮后更新。 */
  run.expectedFormal = cfg.formalSsid || cfg.targetSsid;
  try {
    const c0 = await ctx.protocol.configGet(['network']);
    const f0 = String((c0 && c0.network && c0.network.sta_ssid) || '').trim();
    if (c0 && c0.network) run.expectedFormal = f0;
  } catch (e) {
    /* 读不到就按配置值判 */
  }

  for (let i = 0; i < run.plan.length; i++) {
    if (isAborted()) {
      run.aborted = true;
      run.abortReason = '用户中止';
      break;
    }

    const scen = run.plan[i];
    const rec = {
      n: i + 1,
      scenario: scen,
      key: run.runId + '-' + (i + 1),
      t0: Date.now(),
      t1: 0,
      opId: '',
      terminal: null,
      transitions: [],
      requests: [],
      outcome: '',
      error: '',
      statusAfter: null,
      profileCount: null,
    };

    try {
      rec.expectedFormal = run.expectedFormal;
      if (scen === SCEN.A) await runA(ctx, cfg, rec);
      else if (scen === SCEN.B) await runB(ctx, cfg, rec, i);
      else if (scen === SCEN.C) await runC(ctx, cfg, rec, { isAborted: isAborted });
      else if (scen === SCEN.D) await runD(ctx, cfg, rec, { relinkFn: relinkFn });
      else {
        rec.outcome = 'fail';
        rec.error = 'unknown-scenario';
      }
      /* C 轮 apply 成功 = 正式配置已变成目标，后续 B 轮按新期望判 */
      if (scen === SCEN.C && rec.outcome === 'pass') run.expectedFormal = cfg.targetSsid;
    } catch (err) {
      const code = (err && err.code) || 'unknown';
      rec.error = code;

      /* 失败取证：找回 operation_id，抓 operation.get + network.status 侧证据。
       * 没有这一步，C 轮 connect_failed 只剩小程序侧错误码，无法与固件对账。 */
      const failOpId = (err && err.operationId) || ctx.protocol.lastOperationId || '';
      if (failOpId) {
        rec.opId = failOpId;
        const ev = {};
        try {
          const op = await ctx.protocol.operationGet(failOpId);
          ev.opState = op && op.state;
          ev.opError = (op && op.error) || '';
        } catch (e) {
          ev.opGet = (e && e.code) || 'unknown';
        }
        try {
          const stn = await ctx.protocol.networkStatus();
          ev.sta_has_ip = !!stn.sta_has_ip;
          ev.mqtt_connected = !!stn.mqtt_connected;
          ev.connected_ssid = stn.connected_ssid || '';
          ev.last_disconnect = stn.last_disconnect || '';
        } catch (e2) {
          ev.status = (e2 && e2.code) || 'unknown';
        }
        rec.failureEvidence = ev;
      }

      if (code === 'disconnected' || code === 'not_connected') {
        /* 意外断连：只补链一次；失败则终止整个 run（原则 3） */
        onEvent({ kind: 'relink', n: rec.n });
        let link = null;
        try {
          link = await relinkFn(ctx, cfg);
        } catch (e2) {
          link = { ok: false, code: (e2 && e2.code) || 'unknown' };
        }
        if (!link || !link.ok || !link.loggedIn) {
          rec.outcome = 'fail';
          run.aborted = true;
          run.abortReason = '断连后补链失败（' + ((link && link.code) || 'unknown') + '），按原则停止';
        } else {
          rec.outcome = 'fail';
          rec.error = 'disconnected-then-relinked';
        }
      } else if (code === 'aborted') {
        rec.outcome = 'expected';
        rec.error = 'aborted-by-user';
      } else {
        rec.outcome = 'fail';
      }
    }

    rec.t1 = Date.now();
    rec.ms = rec.t1 - rec.t0;
    run.records.push(rec);
    onRound(rec);

    if (run.aborted) break;

    /* 中止检查放在清理之前判断过，这里处理「轮内请求中止」 */
    if (isAborted()) {
      try {
        await cancelOperation(ctx.protocol, ctx.protocol.lastOperationId);
      } catch (e) {
        /* 尽力清理 */
      }
      run.aborted = true;
      run.abortReason = '用户中止（轮间）';
      break;
    }

    /* 节奏：串行=冷却 1s；紧凑=250ms（设备限频 ≥200ms 由协议层保证） */
    await sleep(cfg.roundGapMs !== undefined
      ? cfg.roundGapMs
      : (run.config.pacing === 'compact' ? 250 : 1000));
  }

  /* 中止时清理活动操作（原则 2） */
  if (run.aborted) {
    try {
      await cancelOperation(ctx.protocol, ctx.protocol.lastOperationId);
      onEvent({ kind: 'cleanup-cancel' });
    } catch (e) {
      /* 尽力清理 */
    }
  }

  run.t1 = Date.now();
  run.summary = summarize(run);
  return run;
}

async function defaultRelink(ctx, cfg) {
  return ensureLink(ctx.ble, ctx.protocol, {
    username: cfg.adminUser,
    password: cfg.adminPass,
  });
}

/* ---------------- 汇总与报告 ---------------- */

function summarize(run) {
  const s = {
    total: run.records.length,
    planned: run.plan.length,
    pass: 0,
    expected: 0,
    fail: 0,
    byScenario: {},
    byError: {},
    noSlot: 0,
    busy: 0,
    hangingOps: 0,
    relinkCount: 0,
    msMin: 0,
    msMax: 0,
    msAvg: 0,
  };
  let msSum = 0;
  run.records.forEach(function (r) {
    s[r.outcome === 'pass' ? 'pass' : r.outcome === 'expected' ? 'expected' : 'fail']++;
    const bs = s.byScenario[r.scenario] || (s.byScenario[r.scenario] = { total: 0, pass: 0, expected: 0, fail: 0 });
    bs.total++;
    bs[r.outcome === 'pass' ? 'pass' : r.outcome === 'expected' ? 'expected' : 'fail']++;
    if (r.error) {
      s.byError[r.error] = (s.byError[r.error] || 0) + 1;
    }
    if (r.error === 'no_slot') s.noSlot++;
    if (r.error === 'busy') s.busy++;
    /* 悬挂操作：发起过 operation 但没有终态结论（rejected/终态/回收都算有结论） */
    if (r.opId && !r.terminal && r.scenario !== SCEN.D && r.outcome !== 'pass') s.hangingOps++;
    if (r.scenario === SCEN.D) s.relinkCount++;
    msSum += r.ms || 0;
    if (!s.msMin || (r.ms && r.ms < s.msMin)) s.msMin = r.ms || 0;
    if (r.ms > s.msMax) s.msMax = r.ms;
  });
  s.msAvg = s.total ? Math.round(msSum / s.total) : 0;
  return s;
}

/** 生成可粘贴的报告文本（口令已脱敏） */
function renderReport(run, meta) {
  const m = meta || {};
  const L = [];
  L.push('T5 常态化运行与异常韧性验收报告');
  L.push('runId: ' + run.runId);
  L.push('时间: ' + stamp() + ' · 用时 ' + Math.round((run.t1 - run.t0) / 1000) + 's' +
    (m.deviceName ? ' · 设备: ' + m.deviceName + (m.deviceId ? ' (' + m.deviceId + ')' : '') : ''));
  if (m.env) L.push('环境: ' + (typeof m.env === 'string' ? m.env : JSON.stringify(m.env)));
  L.push('配置: ' + run.config.rounds + ' 轮 · ' + run.config.set + ' · ' + run.config.pacing +
    ' · 目标 SSID=' + run.config.targetSsid + ' · 正式 SSID=' + run.config.formalSsid +
    ' · 期望正式 SSID(起始实测)=' + (run.expectedFormal || '(未取到)'));
  L.push('口令证据: 目标口令' + (run.config.targetPwNonEmpty ? '非空（长度 ' + run.config.targetPwLen + '）' : '为空') +
    ' · 逐轮见 pw= 字段（不含口令本身） · C v2 判据：口令非空时不应出现快速 connect_failed 特征');
  if (run.aborted) L.push('!! 已中止: ' + run.abortReason);

  const s = run.summary;
  L.push('');
  L.push('汇总: 共 ' + s.total + '/' + s.planned + ' 轮 · PASS ' + s.pass + ' · EXPECTED ' + s.expected +
    ' · FAIL ' + s.fail + ' · no_slot=' + s.noSlot + ' · busy=' + s.busy +
    ' · 悬挂操作=' + s.hangingOps + ' · 重补链=' + s.relinkCount + ' 次');
  L.push('耗时: min ' + s.msMin + 'ms / avg ' + s.msAvg + 'ms / max ' + s.msMax + 'ms');
  Object.keys(s.byScenario).forEach(function (k) {
    const b = s.byScenario[k];
    L.push('  ' + k + ': ' + b.total + ' 轮 (pass ' + b.pass + ' / expected ' + b.expected + ' / fail ' + b.fail + ')');
  });
  const errs = Object.keys(s.byError);
  if (errs.length) {
    L.push('错误分布: ' + errs.map(function (k) { return k + '×' + s.byError[k]; }).join(' · '));
  }

  L.push('');
  L.push('逐轮记录（原始证据；口令已脱敏）:');
  run.records.forEach(function (r) {
    L.push('#' + r.n + ' [' + r.scenario + '] ' + r.outcome.toUpperCase() +
      (r.error ? ' (' + r.error + ')' : '') +
      ' · ' + r.ms + 'ms · op=' + (r.opId || '-') +
      ' · 终态=' + (r.terminal ? r.terminal.state : '-') +
      (r.statusAfter ? ' · ip=' + (r.statusAfter.sta_has_ip ? r.statusAfter.sta_ip : '无') +
        ' mqtt=' + (r.statusAfter.mqtt_connected ? 1 : 0) +
        (r.statusAfter.connected_ssid ? ' · conn=' + r.statusAfter.connected_ssid : '') : '') +
      (r.profileCount !== null && r.profileCount !== undefined ? ' · profile=' + r.profileCount : '') +
      (r.pwEvidence ? ' · pw=' + (r.pwEvidence.nonEmpty ? '非空(' + r.pwEvidence.len + ')' : '空') : '') +
      (r.linkMs ? ' · link=' + r.linkMs + 'ms' : '') +
      (r.designedError ? ' · designed=' + r.designedError : '') +
      (r.formalSsidAfter2 !== undefined && r.formalSsidAfter2 !== null
        ? ' · formal#2=' + (r.formalSsidAfter2 === '' ? '(空)' : r.formalSsidAfter2)
        : '') +
      /* B 轮专用：正式配置未被覆盖判据的两侧证据，缺了它 formal-overwritten 无法定因 */
      (r.formalSsidAfter !== undefined && r.formalSsidAfter !== null
        ? ' · formal=' + (r.formalSsidAfter === '' ? '(空)' : r.formalSsidAfter) +
          (r.expectedFormal ? '（期望 ' + r.expectedFormal + '）' : '')
        : ''));
    if (r.transitions && r.transitions.length) {
      L.push('    迁移: ' + r.transitions.join(' → '));
    }
    if (r.failureEvidence) {
      L.push('    失败取证: ' + JSON.stringify(r.failureEvidence));
    }
    r.requests.forEach(function (q) {
      L.push('    > ' + q.cmd + ' ' + JSON.stringify(q.args || {}));
    });
  });

  L.push('');
  L.push('备注: 堆曲线(free/largest)以串口 diag 日志为准，与本报告按时间戳对时；' +
    '协议层 heap 字段属 T5 第二阶段固件加法项（device.status），本阶段未改动固件。');
  return L.join('\n');
}

/* ---------------- M1：终态槽回收取证 ---------------- */

/**
 * 连续制造 4 个失败操作占满终态槽，再发起第 5 个：
 *  - 新固件：第 5 个被受理，最老记录被回收（operation.get → not_found）；
 *  - 旧固件：第 5 个返回 no_slot（证据：槽未自动回收）。
 * 返回结构化证据；配合串口日志确认 reclaim oldest terminal。
 */
async function slotProbe(ctx, opts) {
  const o = opts || {};
  const { protocol } = ctx;
  const onEvent = o.onEvent || function () {};
  const probe = {
    t0: Date.now(),
    slots: [],       /* 前 4 个 { i, opId, terminal } */
    fifth: '',       /* 'accepted' | 'no_slot' | 其他错误码 */
    fifthOpId: '',
    oldestAfter: '', /* O1 查询结果: not_found=已被回收 */
    verdict: '',
    t1: 0,
  };
  const absent = ABSENT_SSID_PREFIX + 'probe-' + stamp();

  for (let i = 1; i <= 4; i++) {
    onEvent({ kind: 'slot-fill', i: i });
    let r;
    try {
      r = await tryconnectToTerminal(protocol, absent + '-' + i, '', 't5-slot-' + i + '-' + stamp(), {
        intervalMs: o.intervalMs,
        timeoutMs: o.timeoutMs,
      });
    } catch (err) {
      probe.slots.push({ i: i, opId: '', terminal: { state: 'rejected', error: (err && err.code) || 'unknown' } });
      continue;
    }
    probe.slots.push({ i: i, opId: r.opId, terminal: { state: r.terminal.state, error: r.terminal.error } });
  }

  onEvent({ kind: 'slot-fifth' });
  try {
    const acc = await protocol.tryConnect(absent + '-5', '', 't5-slot-5-' + stamp());
    probe.fifth = 'accepted';
    probe.fifthOpId = acc && acc.operation_id;
    if (probe.fifthOpId) {
      const t = await pollTerminal(protocol, probe.fifthOpId, { intervalMs: o.intervalMs, timeoutMs: o.timeoutMs });
      probe.fifthTerminal = t.state;
    }
  } catch (err) {
    probe.fifth = (err && err.code) || 'unknown';
  }

  /* 最老的 O1 应被回收（新固件）或仍可查（旧固件 600s 内） */
  const oldest = probe.slots[0];
  if (oldest && oldest.opId) {
    try {
      const st = await protocol.operationGet(oldest.opId);
      probe.oldestAfter = st && st.state ? st.state : 'unknown';
    } catch (err) {
      probe.oldestAfter = (err && err.code) === 'not_found' ? 'not_found(已回收)' : (err && err.code) || 'unknown';
    }
  }

  if (probe.fifth === 'accepted') {
    probe.verdict = probe.oldestAfter.indexOf('not_found') === 0
      ? '新语义成立：槽满自动回收最老终态，新请求受理'
      : '第 5 个已受理；O1 仍可查（回收发生在下一次 start，属预期），以串口 reclaim 日志为准';
  } else if (probe.fifth === 'no_slot') {
    probe.verdict = '旧固件行为：槽满返回 no_slot（未自动回收）';
  } else {
    probe.verdict = '异常：第 5 个返回 ' + probe.fifth + '，需结合 busy（活动操作）区分';
  }
  probe.t1 = Date.now();
  return probe;
}

function renderProbeReport(probe, meta) {
  const m = meta || {};
  const L = [];
  L.push('T5-M1 终态槽回收取证');
  L.push('时间: ' + stamp() + (m.deviceName ? ' · 设备: ' + m.deviceName : '') +
    ' · 用时 ' + Math.round((probe.t1 - probe.t0) / 1000) + 's');
  probe.slots.forEach(function (s) {
    L.push('  槽' + s.i + ': op=' + (s.opId || '-') + ' → ' + s.terminal.state +
      (s.terminal.error && s.terminal.error !== 'none' ? '(' + s.terminal.error + ')' : ''));
  });
  L.push('  第 5 个: ' + probe.fifth + (probe.fifthOpId ? ' (op=' + probe.fifthOpId + ')' : '') +
    (probe.fifthTerminal ? ' → ' + probe.fifthTerminal : ''));
  L.push('  O1 现状: ' + probe.oldestAfter);
  L.push('  结论: ' + probe.verdict);
  L.push('  对时: 串口日志应出现 reclaim oldest terminal ... state=cancelled/failed');
  return L.join('\n');
}

module.exports = {
  SCEN,
  SET_MIXED,
  SET_FAILURE,
  SET_CONNECT,
  buildPlan,
  runT5,
  runB,
  slotProbe,
  renderReport,
  renderProbeReport,
  summarize,
  pollTerminal,
  maskArgs,
};
