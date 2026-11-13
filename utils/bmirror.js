/**
 * B 镜像（369f7d27… netcheck 语义）小程序侧自动测试套件（2026-11-07）。
 *
 * 分工口径：41 例 MQTT 命令面 / BLE 41 例 / R1-R2 设备侧回滚归硬件侧 harness，
 * 本套件只覆盖小程序侧新字段/新语义/事务窗口（硬件侧 A/B/C 清单 ∩ 小程序职责：
 * A1-A6、B1-B5、C1-C3）。
 *
 * 自动化原则：每个套件一个入口、内部自驱动（发起→轮询→断言→恢复），
 * 人工只出现在首次连接与「失败路径 AP 凭据」两个环境输入上。
 *
 * 设备安全红线（写死在流程里，不靠调用方自觉）：
 *  - fullflow/loop/txn/concur 的 tryconnect 一律用 goodAp（默认预填当前正式 SSID +
 *    pwstore 记忆口令），apply 前断言 goodAp.ssid === 当前 connected_ssid，
 *    不一致立即中止——apply 成功也等于原配置，设备最终状态不变；
 *  - failpath 用 broker 不可达 AP（默认 TQ2018），失败自动回滚，**绝不 apply**；
 *  - concur 用 network.cancel 收尾，不落盘。
 *
 * 纯判定逻辑（verdictOfNetworkStatus/checkStagesShape/classifyFailEnd/
 * summarizeLoop）下沉在本文件头部，主机自测 _verify/bmirror-selftest.js 直接覆盖。
 */

const errors = require('./errors');

/* ================= 纯逻辑（主机可测，不碰 wx/ble） ================= */

/** op 终态失败码白名单（A2/A3）：B 镜像验证不过的三种归宿 */
const FAIL_CODES = ['internet_unverified', 'verify_timeout', 'mqtt_unavailable'];

/** op 终态集合：取自契约（states.json#terminal_states，4 元含 expired）。
 *  2026-11-08 事故：漏 expired 曾让 op 到期后轮询空转到客户端超时。 */
const OP_TERMINAL = require('./contract').TERMINAL_STATES;

/**
 * A4：network.status → 页面应展示的连接判定。
 * 语义铁律：sta_has_ip=true 不等于已联网——internet_verified 才是权威。
 * 返回 'online' | 'unverified'（有 IP 未验证，页面不得显示"已联网"）|
 * 'offline' | 'legacy'（旧固件无字段，页面按旧口径）。
 */
function verdictOfNetworkStatus(st) {
  if (!st || typeof st !== 'object') return 'offline';
  if (st.internet_verified === undefined && st.net_verify_stage === undefined) return 'legacy';
  if (st.internet_verified === true) return 'online';
  if (st.sta_connected === true || st.sta_has_ip === true) return 'unverified';
  return 'offline';
}

/**
 * A2：operation.get 的 data.stages 形状断言。
 * 失败轨迹应保留已完成阶段：wifi/ip=true、internet=false（mqtt 未进入）。
 */
function checkStagesShape(stages) {
  if (!stages || typeof stages !== 'object') return { ok: false, detail: 'stages 缺失' };
  const bad = [];
  if (stages.wifi_connected !== true) bad.push('wifi_connected=' + stages.wifi_connected);
  if (stages.ip_acquired !== true) bad.push('ip_acquired=' + stages.ip_acquired);
  if (stages.internet_verified !== false) bad.push('internet_verified=' + stages.internet_verified);
  if (stages.mqtt_connected !== false) bad.push('mqtt_connected=' + stages.mqtt_connected);
  return { ok: bad.length === 0, detail: bad.length ? bad.join(';') : 'ok' };
}

/**
 * A2/A3：失败终态分类。state=failed 且 code ∈ FAIL_CODES 才算 PASS；
 * verify_timeout 单列（语义=验证预算到期拆链，不是网络不通）。
 */
function classifyFailEnd(state, code) {
  if (state !== 'failed') return { pass: false, why: 'state=' + state };
  if (!code || FAIL_CODES.indexOf(code) < 0) return { pass: false, why: 'code=' + (code || '无') };
  return { pass: true, code: code };
}

/**
 * B3：循环压测汇总。全部成功、耗时无恶化（max ≤ min×3 + 2000ms）、
 * heap（若设备上报）无单调下降（末次 ≥ 首次 - 6144）。
 */
function summarizeLoop(durationsMs, heaps) {
  const n = durationsMs.length;
  if (!n) return { pass: false, detail: '无轮次' };
  const min = Math.min.apply(null, durationsMs);
  const max = Math.max.apply(null, durationsMs);
  const detail = ['轮数=' + n, '耗时 ' + min + '~' + max + 'ms'];
  let pass = true;
  if (max > min * 3 + 2000) { pass = false; detail.push('耗 时恶化'); }
  if (heaps && heaps.length === n && heaps[0] > 0) {
    const drop = heaps[0] - heaps[heaps.length - 1];
    detail.push('heap ' + heaps[0] + '→' + heaps[heaps.length - 1] + '（降' + drop + '）');
    if (drop > 6144) { pass = false; detail.push('heap 疑似泄漏'); }
  }
  return { pass: pass, detail: detail.join('，') };
}

/* ================= 设备静默判因（2026-11-08 09:35 事故） ================= */

/**
 * 三轮套件 0/1 的事故形态：`device.info` 与 `network.status` 各 10s 超时、
 * **零回包**，readonly/fullflow/txn 三套件同形态。旧日志只有一句「响应超时」，
 * 分不清是"设备不响应"、"写没发出去"、"链路半开"还是"ack 丢了"——四者
 * 处理动作完全不同（前两者只能重启设备，后两者 relink 可能自愈）。
 *
 * 输入是**两次快照的差值**（命令前后各取一次），输出归因：
 *   link_down       链路已断（连接态已翻转）
 *   link_half_open  断连事件 +1 或重组缓冲残留（对端已走，本机还当连着）
 *   write_ack_lost  写 ack 丢失且零回包（字节可能根本没进对端）
 *   device_silent   写发出去了、对端零回包（设备侧命令 worker 不响应）
 *   no_write        命令没写出去（本机链路状态异常）
 *   ok              有回包（不是静默，可能是业务错误）
 */
function classifySilence(d) {
  const x = d || {};
  const dTx = Math.abs(Number(x.dTx) || 0);
  const dRx = Math.abs(Number(x.dRx) || 0);
  const ackLost = Number(x.writeAckLost) || 0;
  const dDisc = Number(x.dDisc) || 0;
  const pending = Number(x.pending) || 0;
  if (x.connected === false) return { kind: 'link_down', action: 'relink', text: '链路已断（connected=false）' };
  if (dDisc > 0 || pending > 0) {
    return { kind: 'link_half_open', action: 'relink', text: '链路半开（被动断链 +' + dDisc + '、重组残留 ' + pending + 'B）' };
  }
  if (dRx > 0) return { kind: 'ok', action: 'none', text: '有回包 ' + dRx + ' 条' };
  if (dTx === 0) return { kind: 'no_write', action: 'relink', text: '命令没写出去（tx 未增长）' };
  if (ackLost > 0) {
    return { kind: 'write_ack_lost', action: 'relink', text: '写 ack 丢失 ' + ackLost + ' 次且零回包（字节可能没进对端）' };
  }
  return { kind: 'device_silent', action: 'relink_once', text: '写已发出 ' + dTx + ' 条、零回包（设备侧不响应）' };
}

/** 该归因是否应当中止套件（继续跑只会得到 N 个 10s 超时，浪费 70s×套件） */
function silenceBlocksSuite(kind) {
  return kind === 'link_down' || kind === 'link_half_open' ||
    kind === 'write_ack_lost' || kind === 'device_silent' || kind === 'no_write';
}

/** 静默归因的处置建议（写进 rec.detail，报告里直接可读） */
function silenceHint(kind) {
  if (kind === 'link_down' || kind === 'no_write') return '处置：先建链路（设备页重连）再重跑';
  if (kind === 'link_half_open') return '处置：重连已试过仍无回包，请重启设备后重跑';
  if (kind === 'write_ack_lost') return '处置：微信写 ack 丢失形态，重开小程序（或重启手机蓝牙）后重跑';
  if (kind === 'device_silent') {
    return '处置：客户端无法自救，请断电重启设备后重跑；重启后仍静默按固件回归处理（串口看是否卡在 scan/tryconnect）';
  }
  return '处置：重连设备后重跑';
}

function snapOf(io) {
  const p = (io.stats && io.stats()) || {};
  const b = (io.bleStats && io.bleStats()) || {};
  return {
    tx: Number(p.tx) || 0,
    rx: Number(p.rx) || 0,
    ackLost: Number(p.writeAckLost) || 0,
    disc: Number(b.disconnects) || 0,
    pending: Number(b.pendingBytes) || 0,
    connected: b.connected !== false,
  };
}

/** 一次探测：命令前后各取快照，失败时把差值交给 classifySilence */
async function probeOnce(io) {
  const s0 = snapOf(io);
  const t0 = nowMs();
  try {
    const info = await io.proc.deviceInfo();
    return { ok: true, ms: nowMs() - t0, info: (info && info.data) || info || {} };
  } catch (e) {
    const s1 = snapOf(io);
    const d = {
      dTx: s1.tx - s0.tx,
      dRx: s1.rx - s0.rx,
      writeAckLost: s1.ackLost - s0.ackLost,
      dDisc: s1.disc - s0.disc,
      pending: s1.pending,
      connected: s1.connected,
    };
    return {
      ok: false,
      ms: nowMs() - t0,
      code: (e && e.code) || String(e),
      cls: classifySilence(d),
      stats: 'tx+' + d.dTx + '/rx+' + d.dRx + '/ackLost+' + d.writeAckLost +
        '/断链+' + d.dDisc + '/残留 ' + d.pending + 'B',
    };
  }
}

/**
 * 套件前置探测：失败重探一次（2s），仍静默则 relink 一次再探。
 * 返回 {ok:true, info, ms} 或 {ok:false, code, cls, stats}。
 */
async function preflightDevice(io) {
  let r = await probeOnce(io);
  if (r.ok) return r;
  io.log('  设备探测 #1 失败：' + r.code + '（' + (r.cls && r.cls.text) + '；' + r.stats + '）');
  await sleep(2000);
  r = await probeOnce(io);
  if (r.ok) {
    io.log('  设备探测 #2 成功（' + r.ms + 'ms）——一次失败后自愈，套件继续');
    return r;
  }
  io.log('  设备探测 #2 失败：' + r.code + '（' + (r.cls && r.cls.text) + '；' + r.stats + '）');
  if (r.cls && r.cls.action !== 'none' && typeof io.relink === 'function') {
    const rel = await io.relink();
    /* relink 返回值有两种形态：页面实现给 {ok,ms,detail}，测试/旧实现给布尔 */
    const relOk = rel === true || !!(rel && rel.ok);
    io.log('  静默后重连：' + (relOk
      ? '成功' + (rel && rel.ms ? ' ' + rel.ms + 'ms' : '')
      : '失败（' + ((rel && (rel.detail || rel.reason || rel.error)) || '未知') + '）'));
    if (relOk) {
      await sleep(500);
      r = await probeOnce(io);
      if (r.ok) {
        io.log('  重连后探测成功（' + r.ms + 'ms）——静默由链路/写引起，套件继续');
        return r;
      }
      io.log('  重连后仍失败：' + r.code + '（' + (r.cls && r.cls.text) + '；' + r.stats + '）');
    }
  }
  return r;
}

/* ================= 运行器 ================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nowMs() { return Date.now(); }

/** 失败 op 的阶段尾巴（stages 有就带上，硬件侧能直接看出停在哪一步） */
function stagesTail(d) {
  const st = d && d.stages;
  if (!st) return '';
  try { return ' stages=' + JSON.stringify(st).slice(0, 180); } catch (e) { return ''; }
}

/**
 * 取 operation.get 回包里的错误码。
 * **形状修正（2026-11-07 20:35，固件源码 cmd.c:723 核实）**：
 *   cJSON_AddStringToObject(resp, "error", app_operation_error_name(status.error))
 * ⟹ `data.error` 是**扁平字符串**（error name，如 "connect_failed"；无错时 "none"），
 *    不是 {code,message} 对象。旧实现读 d.error.code，对字符串永远 undefined，
 *    于是把"有码失败"误报成 "code=null / v1 契约缺陷"（18:52 那两轮的假缺陷就是这么来的）。
 * 兼容：对象形状仍支持（旧镜像/第三方实现）；"none"/空串视为无码。
 */
function errCodeOf(d) {
  if (!d || typeof d !== 'object') return null;
  const e = d.error;
  let code = null;
  if (typeof e === 'string') code = e;
  else if (e && typeof e === 'object') code = e.code || null;
  if (!code) code = d.error_code || null;
  if (code === null || code === undefined) return null;
  const s = String(code).trim();
  return (s === '' || s === 'none') ? null : s;
}

/**
 * 失败后复核（+5s 再查一次 op，只在上报失败前跑一次）。
 * 2026-11-07 gate-v2 争议点：硬件侧主张「code=null ⟹ op 仍处 connecting、是客户端预算」。
 * 若 +5s 后回包变成 got_ip/success ⟹ 之前读到的 failed 是陈旧/重复响应；
 * 仍是 failed 且仍无码 ⟹ 设备终态确实无码（契约缺陷成立）。
 */
async function recheckAfterFail(proc, oid, io, waitMs) {
  const w = waitMs === undefined ? 5000 : waitMs;
  await sleep(w);
  const tag = '失败复核（+' + (w / 1000) + 's）';
  try {
    const g = await proc.operationGet(oid);
    const d = (g && g.data) || g || {};
    const st = String(d.state || '').toLowerCase();
    const code = errCodeOf(d);
    if (io && io.log) {
      io.log('  ' + tag + '：' + oid + ' → ' + st +
        (code ? ' (' + code + ')' : ' (无码)') + stagesTail(d));
    }
    return { state: st, data: d, code: code };
  } catch (e) {
    if (io && io.log) io.log('  ' + tag + '：' + oid + ' 查询失败(' + ((e && e.code) || e) + ')');
    return { state: 'error', data: null, code: null };
  }
}

/**
 * 失败现场快照：设备此刻的真实联网态。
 * 若 op 报 failed 但这里 sta_has_ip/internet_verified 都为 true、SSID 也是目标网络，
 * 说明"失败"只存在于 op 状态机里（设备实际已连上），不是链路问题。
 */
/**
 * network.status 里与"连不上"直接相关的字段拼成一行（失败 detail 自带，不用翻日志）。
 * `last_disconnect` 是固件 `s_wifi.last_disconnect`，格式 `%d(%s)`
 * （wifi.c:2069，如 `8(assoc_leave)` / `204(handshake_timeout)`）——这是判定
 * "断在关联/握手/凭据哪一层"的唯一直接证据：15/202/2→wrong_password、
 * 201/203→ap_not_found、**其余一律 connect_failed**（wifi.c:1574-1587）。
 */
/**
 * tryconnect 失败原因的**可信度判定**（2026-11-07 23:5x 固件源码核实，别再误用）。
 *
 * 硬事实：
 *   wifi.c:2048  `if (app_wifi_tryconnect_on_disconnected(d)) break;`  ← 候选断连在这里就收口
 *   wifi.c:2069  `snprintf(s_wifi.last_disconnect, "%d(%s)", reason, name)`  ← 永远走不到
 * ⟹ 候选失败的 reason **不写 last_disconnect**；且 set_result_done() 只存枚举 result
 *   （wifi.c:307-316），数字 reason 被丢弃；operation.get 的 stages 也只有 4 个 bool
 *   （cmd.c:755-760）。唯一留存是串口那行 `tryconnect failed: reason=%d(%s)`（wifi.c:1649）。
 * ⟹ 所以 network.status.last_disconnect 读到的必是**上一次非 tryconnect 断连的旧值**
 *   （fast_path / ble_fast_path_failed / none / 更早的 reason），拿它判 A/B 分支会误判。
 * 唯一可靠通道：stages.candidate_reason（需固件 R-2 改造，见 docs/t6九轮_*.md）。
 */
function reasonOf(stages, lastDisconnect) {
  const st = (stages && typeof stages === 'object') ? stages : null;
  if (st && st.candidate_reason !== undefined && st.candidate_reason !== null) {
    const n = Number(st.candidate_reason);
    const nm = st.candidate_reason_name ? String(st.candidate_reason_name) : '';
    const val = isNaN(n) ? String(st.candidate_reason) : (nm ? n + '(' + nm + ')' : String(n));
    return { value: val, source: 'stages.candidate_reason', trusted: true };
  }
  const ld = (lastDisconnect === undefined || lastDisconnect === null) ? '' : String(lastDisconnect);
  if (!ld || ld === '-') return { value: '-', source: 'none', trusted: false };
  if (/^\d+\(/.test(ld)) {
    return { value: ld, source: 'last_disconnect', trusted: false, why: '旧值，非本轮候选' };
  }
  return { value: ld, source: 'last_disconnect', trusted: false, why: '状态串≠reason' };
}

/* ================= 试用凭据诊断（2026-11-08 十三轮） =================
 * 背景：13:19 A1/B2b 双双 failed/wrong_password。硬件侧串口铁证：
 *   assoc 成功（无线层通）→ run→init reason=15（4WAY_HANDSHAKE_TIMEOUT）→ wrong_password；
 *   设备用自存 profile 同 SSID 9s 后握手成功 ⟹ RF/AP/固件透传都正常，是**口令值不同**。
 * 客户端不知道口令原文，但能把"是不是同一个值、从哪来的、有没有脏字符"证明出来：
 *  1. 指纹 pwdFp()：只算 len + FNV-1a 8 位，可跨轮比对，不可逆、不进报告原文；
 *  2. 卫生检查 pwdHygiene()：首尾空白 / 全角同形字 / 控制字符 / 长度越界——
 *     粘贴带尾空格是最常见的"长度一样但 PSK 不匹配"来源；
 *  3. 来源标注：手填 / 本地环境记忆 / pwstore 设备记忆（旧值被静默回填最坑）。
 */
function pwdFp(pwd) {
  const s = String(pwd === undefined || pwd === null ? '' : pwd);
  if (!s) return 'len=0/fp=-';
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return 'len=' + s.length + '/fp=' + ('0000000' + h.toString(16)).slice(-8);
}

/** 口令卫生检查：返回问题描述数组（空数组=看起来正常，不保证值是"对的"） */
function pwdHygiene(pwd) {
  const s = String(pwd === undefined || pwd === null ? '' : pwd);
  const out = [];
  if (!s) {
    out.push('口令为空（设备侧收到 pwd_len=0，必判口令错误）');
    return out;
  }
  const lead = /^\s+/.exec(s);
  const trail = /\s+$/.exec(s);
  if (lead || trail) {
    out.push('首尾含空白（前 ' + (lead ? lead[0].length : 0) + ' / 后 ' +
      (trail ? trail[0].length : 0) + ' 个）——粘贴或输入法残留，长度仍可能等于真实值');
  }
  let wide = 0;
  let ctrl = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0xff01 && c <= 0xff5e) || c === 0x3000) wide++;
    if (c < 0x20 || c === 0x7f) ctrl++;
  }
  if (wide) out.push('含 ' + wide + ' 个全角/同形字符（看着一样，字节不同）');
  if (ctrl) out.push('含 ' + ctrl + ' 个控制字符');
  if (s.length < 8 || s.length > 63) out.push('长度 ' + s.length + ' 不在 WPA-PSK 8–63 范围');
  return out;
}

/** 口令判因：仅 wrong_password 且"同 SSID 基线有 IP"时才能定到"值不同" */
function credVerdict(code, preBase) {
  if (code !== 'wrong_password') return '';
  const same = preBase && preBase.sameSsid;
  const hadIp = preBase && preBase.status && preBase.status.sta_has_ip === true;
  if (same && hadIp) {
    return '与设备自存 profile 不一致（同 SSID 基线有 IP；固件 reason 15/202/2=4WAY 握手失败即 PSK 值不同）';
  }
  return 'PSK 不匹配（基线无 IP，无法区分"口令错"与"AP 换了密钥"）';
}

/** 一行说清这个口令是哪来的、有没有脏字符、和上次成功时是否同一个值 */
function credLine(goodAp, io) {
  const ssid = String((goodAp && goodAp.ssid) || '');
  const pwd = (goodAp && goodAp.password) || '';
  const fp = pwdFp(pwd);
  const src = (io && typeof io.pwdSource === 'function') ? (io.pwdSource() || '未知') : '未标注';
  const prev = (io && typeof io.pwdFpRecall === 'function') ? String(io.pwdFpRecall(ssid) || '') : '';
  const hy = pwdHygiene(pwd);
  return '试用凭据=' + fp + ' 来源=' + src +
    (prev && prev !== fp ? '；⚠ 与上次成功时不同（上次 ' + prev + '）' : '') +
    (hy.length ? '；⚠ ' + hy.join(' / ') : '');
}

/** 口令被设备判错时的统一处置：留痕 + 通知页面作废本地记忆，避免旧值被无限回填 */
function noteCredReject(io, goodAp, fp) {
  if (!io) return;
  io.pwdRejected = { ssid: (goodAp && goodAp.ssid) || '', fp: fp || pwdFp(goodAp && goodAp.password) };
  if (io.log) {
    io.log('  ⚠ 口令被设备判定错误（wrong_password = 4WAY 握手失败）。同 SSID、同长度仍失败 ⟹ 口令值不同；' +
      '请核对 T6 页 goodPassword（来源见上行"来源="），修正后重跑。本轮本地记忆将被作废。');
  }
  if (typeof io.onPwdRejected === 'function') {
    try { io.onPwdRejected((goodAp && goodAp.ssid) || ''); } catch (e) { /* 页面处置失败不影响测试 */ }
  }
}

function netTail(g) {
  if (!g) return '';
  const r = reasonOf(null, g.last_disconnect);
  const parts = ['断连原因=' + r.value + (r.why ? '（' + r.why + '）' : '')];
  if (g.sta_connected !== undefined) parts.push('conn=' + g.sta_connected);
  if (g.rssi_valid === true) {
    parts.push('rssi=' + g.rssi + ' ch=' + g.channel + ' bssid=' + (g.bssid || '-'));
  } else {
    parts.push('rssi=不可见');
  }
  if (g.nc_tcp_fails_last !== undefined && g.nc_tcp_fails_last !== null) {
    parts.push('tcp探败=' + g.nc_tcp_fails_last +
      (g.nc_tcp_last_errno ? '/errno' + g.nc_tcp_last_errno : ''));
  }
  return '；' + parts.join(' ');
}

async function diagNetwork(proc, io) {
  if (!proc || typeof proc.networkStatus !== 'function') return null;
  try {
    const raw = await proc.networkStatus();
    const g = (raw && raw.data) || raw || {};
    if (io && io.log) {
      const stg = g.net_verify_stage || '-';
      io.log('  现场快照 network.status：sta_has_ip=' + g.sta_has_ip +
        ' internet_verified=' + g.internet_verified +
        ' stage=' + stg +
        ' ssid=' + (g.connected_ssid || '-') +
        ' verdict=' + verdictOfNetworkStatus(g));
      io.log('  断连现场：' + netTail(g).replace(/^；/, ''));
      /* 2026-11-07：stage=none 不等于"没失败过"。失败后设备会回滚到持久配置、
       * 重新拿到 IP → link_gen++，GOT_IP 处理器把 stage 重置为 none 并起新一轮
       * netcheck（wifi.c:2181-2183）。判失败原因只认 op 的 error 串。 */
      if ((stg === '-' || stg === 'none') && !g.internet_verified) {
        io.log('    ⚠ stage 已被新一轮链路重置（回滚后换代），仅凭此处不能判失败阶段；以 op error 为准');
      }
    }
    return g;
  } catch (e) {
    if (io && io.log) io.log('  现场快照 network.status 读取失败(' + ((e && e.code) || e) + ')');
    return null;
  }
}

/**
 * 未知 operation_id 探测（2026-11-07 新增判别）：
 * 设备对"不存在 / 已回收"的 op 怎么答？若同样返回 state=failed 且无 code，
 * 则本次的"无码 failed"极可能是 op 记录失效后的兜底，而不是终态分支漏码。
 */
async function probeUnknownOp(proc, io) {
  if (!proc || typeof proc.operationGet !== 'function') return null;
  const fake = 'probe-unknown-' + nowMs();
  try {
    const raw = await proc.operationGet(fake);
    const d = (raw && raw.data) || raw || {};
    if (io && io.log) io.log('  未知 id 探测：operation.get(' + fake + ') → ' + JSON.stringify(d).slice(0, 200));
    return d;
  } catch (e) {
    if (io && io.log) io.log('  未知 id 探测：operation.get(' + fake + ') 被拒 code=' + ((e && e.code) || e));
    return { rejected: true, code: (e && e.code) || 'error' };
  }
}

/** 失败现场一次抓全：真实联网态 + 未知 id 兜底形态 + +2s/+5s 两次复核 */
async function diagFail(proc, oid, io) {
  const net = await diagNetwork(proc, io);
  const unk = await probeUnknownOp(proc, oid);
  const re2 = await recheckAfterFail(proc, oid, io, 2000);
  const re5 = await recheckAfterFail(proc, oid, io, 3000);
  /* 恢复复核：失败后设备会回滚到持久配置自愈。若此时已重新拿到 IP，
   * 说明"网络/凭据本身没问题，失败只发生在本次 trial 的重关联过程"——
   * 这是把"环境坏"与"trial 时序坏"分开的关键一行。 */
  let rec = null;
  try {
    rec = await proc.networkStatus();
    if (io && io.log && rec) {
      io.log('  恢复复核：ssid=' + (rec.connected_ssid || '-') +
        ' ip=' + rec.sta_has_ip + ' verified=' + rec.internet_verified +
        ' last_disconnect=' + (rec.last_disconnect || '-'));
    }
  } catch (e) { /* 读不到不影响判定 */ }
  return { net: net, unk: unk, re2: re2, re5: re5, rec: rec };
}

/** 试连前基线：记录"动手前设备是否已经连在目标网上" */
async function netBaseline(proc, io, targetSsid) {
  try {
    const st = await proc.networkStatus();
    const g = (st && st.data) || st || {};
    const same = !!(targetSsid && g.connected_ssid === targetSsid);
    if (io && io.log) {
      io.log('  试连前基线：ssid=' + (g.connected_ssid || '-') +
        ' ip=' + g.sta_has_ip + ' verified=' + g.internet_verified +
        ' last_disconnect=' + (g.last_disconnect || '-') +
        (same ? '（目标=当前 SSID：设备会先拆掉这条好链路再重关联）' : ''));
    }
    return { status: g, sameSsid: same };
  } catch (e) {
    if (io && io.log) io.log('  试连前基线读取失败(' + ((e && e.code) || e) + ')');
    return null;
  }
}

/**
 * 轮询 operation.get 至目标态。返回 {state, data, code, elapsedMs}。
 * until: 目标态数组（如 ['got_ip']）——到达即返回；否则轮到终态或超时。
 */
async function pollOp(proc, oid, until, deadlineMs, io) {
  const start = nowMs();
  const end = start + deadlineMs;
  let last = null;
  let seenUnmatched = null;
  while (nowMs() < end) {
    let data;
    try {
      data = await proc.operationGet(oid);
    } catch (e) {
      const ec = (e && e.code) || 'error';
      last = { state: ec === 'not_found' ? 'not_found' : 'error', data: null, code: ec };
      /* 2026-11-07：查询本身失败（含单次 10s 请求超时）过去是静默 continue，
       * 真机上无法区分"设备一直 connecting"与"查询一直超时"——补一行日志。
       * 另外：`not_found` = op 记录已不存在（过期/回收），再轮询没有意义，
       * 直接收尾——否则 60s 预算内会空转几十次（对端脚本踩过同类坑）。 */
      if (io && io.log) {
        io.log('  op ' + oid + ' 查询失败(' + ec + ')' +
          (ec === 'not_found' ? '，op 记录已不存在→停止轮询' : '，继续轮询'));
      }
      if (ec === 'not_found') break;
      await sleep(1000);
      continue;
    }
    const d = (data && data.data) || data || {};
    const state = String(d.state || '').toLowerCase();
    last = { state: state, data: d, code: errCodeOf(d) };
    if (io && io.log && state) {
      io.log('  op ' + oid + ' → ' + state + (last.code ? ' (' + last.code + ')' : '') +
        ' +' + ((nowMs() - start) / 1000).toFixed(1) + 's');
    }
    /* 残留帧监视：protocol.stats.unmatched 增长说明收到了与任何在途请求都不匹配的响应
     * （迟到的/上一会话残留）。这是"failed 是不是陈旧应答"最直接的客户端侧证据。 */
    if (io && typeof io.stats === 'function') {
      try {
        const s = io.stats() || {};
        if (typeof s.unmatched === 'number') {
          if (seenUnmatched !== null && s.unmatched > seenUnmatched && io.log) {
            io.log('  ⚠ 收到未匹配响应（残留/迟到帧）：unmatched ' + seenUnmatched + '→' + s.unmatched +
              ' lastRxId=' + (s.lastRxId || '-') + '（本次请求 id=' + (s.lastTxId || '?') + '）');
          }
          seenUnmatched = s.unmatched;
        }
      } catch (e) { /* 统计不可用不影响判定 */ }
    }
    /* 候选失败原因（唯一可信通道）：固件 R-2 改造后 stages 会带 candidate_reason。
     * 未改造时这里读不到——**不要**退回去读 last_disconnect 冒充 reason（见 reasonOf 注释）。 */
    if (state === 'failed') {
      const rsn = reasonOf(d.stages, null);
      last.reason = rsn;
      if (io && io.log && rsn.trusted) {
        io.log('  ★ 候选失败原因（stages.candidate_reason）：' + rsn.value);
      }
    }
    /* failed 但真无码（error 缺失或 "none"）才打：固件用 ERR_NONE 收 failed 属异常，
     * 需要原始回包定位。注意 error 是扁平字符串（见 errCodeOf 注释），
     * 别再把它读成对象——18:52 那两轮就是这样把"有码"误报成"无码"的。 */
    if (state === 'failed' && !last.code && io && io.log) {
      io.log('  ⚠ op 失败但 error 为 none/缺失（固件终态未赋码）：原始回包=' +
        JSON.stringify(d).slice(0, 320));
      if (d.stages) io.log('    stages=' + JSON.stringify(d.stages).slice(0, 200));
    }
    if (until.indexOf(state) >= 0 || OP_TERMINAL.indexOf(state) >= 0) break;
    await sleep(1500);
  }
  if (!last) last = { state: 'timeout', data: null, code: null };
  last.elapsedMs = nowMs() - start;
  return last;
}

function mkRunner(io) {
  const recs = [];
  let passCount = 0;

  function rec(id, name, pass, detail) {
    recs.push({ id: id, name: name, pass: !!pass, detail: detail || '' });
    if (pass) passCount++;
    io.log((pass ? 'PASS' : 'FAIL') + ' [' + id + '] ' + name + (detail ? ' — ' + detail : ''));
    return !!pass;
  }

  /** 环境自检：goodAp 必须是设备当前网络（apply 才是"原配置重放"）。
   * 2026-11-07 真机教训：上一套件 apply 失败会触发设备恢复流程（WiFi 重启/BLE 抖动），
   * 下一套件开头 status 可能暂时读不到 connected_ssid——重试 3 次（3s 间隔）再判死，
   * 传输异常先试 relink；goodAp 不匹配的安全中止不重试。 */
  async function assertGoodAp(proc, goodAp) {
    let lastErr = null;
    for (let i = 0; i < 3; i++) {
      try {
        const st = await proc.networkStatus();
        const cur = String(st.connected_ssid || '').trim();
        if (cur) {
          if (String(goodAp.ssid || '').trim() !== cur) {
            throw new Error('goodAp.ssid（' + goodAp.ssid + '）≠ 设备当前网络（' + cur +
              '）：为防误改正式配置已中止。请把 goodAp 改成当前网络或先连到目标网络');
          }
          return cur;
        }
        lastErr = new Error('读不到 connected_ssid（设备可能在恢复网络），重试 ' + (i + 1) + '/3');
      } catch (e) {
        if (e && /goodAp\.ssid/.test(e.message)) throw e; /* 安全中止：不重试 */
        lastErr = e;
        if (io.relink) { try { await io.relink(); } catch (e2) { /* relink 失败继续等 */ } }
      }
      await sleep(3000);
    }
    throw lastErr || new Error('读不到 connected_ssid，无法确认设备当前网络');
  }

  async function readHeap(proc) {
    try {
      const ds = await proc.deviceStatus();
      const d = (ds && ds.data) || ds || {};
      return d.free_heap || d.heap || (d.sys && d.sys.free_heap) || 0;
    } catch (e) { return 0; }
  }

  /** A1 主体：tryconnect→got_ip→apply→success（goodAp=原配置重放） */
  async function fullflowOnce(proc, goodAp, label) {
    const t0 = nowMs();
    const preBase = await netBaseline(proc, io, goodAp.ssid);
    const fp = pwdFp(goodAp.password);
    /* 口令来源/指纹/卫生检查先打一行：wrong_password 时这是唯一能自证的线索，
     * 不必等串口 reason=15 才知道"是值不同不是链路不通"。 */
    if (io && io.log) io.log('  ' + credLine(goodAp, io));
    const acc = await proc.tryConnect(goodAp.ssid, goodAp.password);
    const oid = (acc && (acc.operation_id || (acc.data && acc.data.operation_id)));
    if (!oid) throw new Error('tryconnect 未返回 operation_id: ' + JSON.stringify(acc).slice(0, 120));
    /* 受理回包原样留证：若带 accepted_ttl / poll_after_ms / 超时类字段，
     * 就能和后面的失败时刻对上（10s 归因的关键） */
    if (io && io.log) io.log('  tryconnect 受理回包：' + JSON.stringify(acc).slice(0, 260));
    const got = await pollOp(proc, oid, ['got_ip'], 60000, io);
    if (got.state !== 'got_ip' && got.state !== 'success') {
      const diag = await diagFail(proc, oid, io);
      const verdict = credVerdict(got.code, preBase);
      if (verdict) noteCredReject(io, goodAp, fp);
      throw new Error(label + ' got_ip 阶段终态=' + got.state + ' code=' + (got.code || '无') +
        ' 候选原因=' + (got.reason && got.reason.trusted ? got.reason.value : '未暴露(固件无 stages.candidate_reason)') +
        ' elapsed=' + got.elapsedMs + 'ms' + stagesTail(got.data) +
        (verdict ? '；口令判因=' + verdict : '') +
        '；' + credLine(goodAp, io) +
        '；+2s 复核=' + diag.re2.state + (diag.re2.code ? '(' + diag.re2.code + ')' : '(无码)') +
        '；+5s 复核=' + diag.re5.state + (diag.re5.code ? '(' + diag.re5.code + ')' : '(无码)') +
        '；设备联网态=' + (diag.net ? ('ip=' + diag.net.sta_has_ip + ' verified=' + diag.net.internet_verified +
          ' ssid=' + (diag.net.connected_ssid || '-')) : '读不到') +
        netTail(diag.net) +
        '；试连前=' + (preBase ? ('ssid=' + (preBase.status.connected_ssid || '-') +
          ' ip=' + preBase.status.sta_has_ip +
          (preBase.sameSsid ? '（同SSID重放）' : '')) : '读不到') +
        '；自愈=' + (diag.rec ? ('ip=' + diag.rec.sta_has_ip + ' ssid=' + (diag.rec.connected_ssid || '-')) : '读不到') +
        '；未知id探测=' + (diag.unk ? JSON.stringify(diag.unk).slice(0, 80) : '不可用'));
    }
    /* 预留通道：TCP 探测失败次数（固件尚未上报时打 "-"，不影响判定）。
     * 一旦 netcheck 把 nc_tcp_fails_last 写进 network.status，A1 的 detail 就能
     * 直接证明 A+B 是否被触发（>0=首探失败后探成功），不再依赖串口——见
     * docs/t6七轮_AB修法与验证证据评估_2026-11-07.md §6。 */
    let tcpFails = '-';
    try {
      const ns = await proc.networkStatus();
      if (ns && ns.nc_tcp_fails_last !== undefined) tcpFails = String(ns.nc_tcp_fails_last);
    } catch (e) { /* 读不到不影响判定 */ }
    const ap = await proc.networkApply(oid);
    const apState = String(((ap && ap.data) || ap || {}).state || '').toLowerCase();
    if (apState !== 'success') {
      throw new Error(label + ' apply 终态=' + apState);
    }
    /* 只在"这条口令被设备接受过"时记指纹：下次同 SSID 失败即可一眼看出值被改过 */
    if (io && typeof io.pwdFpRecord === 'function') {
      try { io.pwdFpRecord(goodAp.ssid, fp); } catch (e) { /* 存储不可用不影响判定 */ }
    }
    return { oid: oid, ms: nowMs() - t0, acc: acc, got: got, ap: ap, tcpFails: tcpFails };
  }

  /** 等 networkStatus.internet_verified 回 true（apply 被联网验证兜底拒绝后的回稳等待） */
  async function waitInternetOk(proc, deadlineMs) {
    const end = nowMs() + deadlineMs;
    while (nowMs() < end) {
      try {
        const st = await proc.networkStatus();
        if (st && st.internet_verified === true) return true;
      } catch (e) { /* 传输抖动继续等 */ }
      await sleep(2000);
    }
    return false;
  }

  const suites = {
    /* ---- 只读组：零配置变更，任何连接状态下可跑 ---- */
    async readonly() {
      const proc = io.proc;
      const st = await proc.networkStatus();
      const hasNew = st.internet_verified !== undefined || st.net_verify_stage !== undefined;
      rec('A4-1', 'network.status 携带 netcheck 字段',
        hasNew,
        hasNew ? 'internet_verified=' + st.internet_verified + ' stage=' + st.net_verify_stage
               : '旧固件/旧镜像，无 internet_verified 字段');
      const v = verdictOfNetworkStatus(st);
      rec('A4-2', '联网判定（sta_has_ip ≠ 已联网）',
        v === 'online' || v === 'legacy', 'verdict=' + v);
      const info = await proc.deviceInfo();
      const di = (info && info.data) || info || {};
      rec('C2', 'device.info 携带 build_sha/build_variant',
        String(di.build_sha || '').length >= 8 && !!di.build_variant,
        'build_sha=' + (di.build_sha || '无') + ' variant=' + (di.build_variant || '无'));
      const ds = await proc.deviceStatus();
      const d = (ds && ds.data) || ds || {};
      const ble = d.ble || {};
      const bleKeys = ['advertising', 'adv_retry_count', 'rx_age'].filter(function (k) { return k in ble; });
      rec('C3', 'device.status.ble 调试字段', bleKeys.length >= 1, '有=' + (bleKeys.join(',') || '无'));

      /* A5：静态锁定引导——秒拒零副作用，但仅对静态锁定设备有意义 */
      let isStatic = false;
      try {
        const cfg = await proc.configGet(['network']);
        const net = (cfg && cfg.network) || {};
        isStatic = net.sta_use_static === true || net['sta_use_static'] === 1;
      } catch (e) { /* 读不到按非静态处理 */ }
      if (!isStatic) {
        rec('A5', '静态锁定引导', true, 'SKIP：设备非静态锁定，场景不适用');
        return;
      }
      let pinned = null;
      try {
        await proc.tryConnect('A5-PROBE-' + nowMs(), '');
        pinned = null; /* 静态锁定设备竟受理了不同 SSID = 锁失效 */
      } catch (e) {
        pinned = (e && e.code) || 'unknown';
      }
      rec('A5', '静态锁定 tryconnect 秒拒 static_ip_pinned', pinned === 'static_ip_pinned',
        '实际=' + pinned);
    },

    /* ---- 事务窗口组（B1/B2/A6）：会动 trial，apply=原配置重放 ---- */
    async txn() {
      const proc = io.proc;
      const goodAp = io.env.goodAp;
      const cur = await assertGoodAp(proc, goodAp);
      io.log('安全自检通过：goodAp=当前网络 ' + cur);

      /* B1: defer 窗口内重复 tryconnect → busy */
      const preBase2 = await netBaseline(proc, io, goodAp.ssid);
      const r1 = await proc.tryConnect(goodAp.ssid, goodAp.password);
      const oid1 = r1.operation_id || (r1.data && r1.data.operation_id);
      let busy = null;
      try {
        await proc.tryConnect(goodAp.ssid, goodAp.password);
        busy = null; /* 第二条竟成功 = 语义破坏 */
      } catch (e) {
        busy = (e && e.code) || 'unknown';
      }
      rec('B1', 'defer 窗口内第二条 tryconnect 被拒', busy === 'busy', '实际=' + busy);

      /* B2a: got_ip 前立即 apply → 应被拒（不崩即可，码记录在案） */
      let early = null;
      try {
        await proc.networkApply(oid1);
      } catch (e) {
        early = (e && e.code) || 'unknown';
      }
      rec('B2a', 'got_ip 前 apply 被拒', !!early, 'code=' + (early || '未被拒!'));

      /* 等 got_ip → B2b 紧贴 apply → success */
      const got = await pollOp(proc, oid1, ['got_ip'], 60000, io);
      if (got.state !== 'got_ip') {
        const diag = await diagFail(proc, oid1, io);
        const verdict = credVerdict(got.code, preBase2);
        if (verdict) noteCredReject(io, goodAp, pwdFp(goodAp.password));
        rec('B2b', 'tryconnect 到 got_ip', false,
          '终态=' + got.state + ' code=' + (got.code || '无') + ' elapsed=' + got.elapsedMs + 'ms' +
          stagesTail(got.data) +
          (verdict ? '；口令判因=' + verdict : '') +
          '；' + credLine(goodAp, io) +
          '；+2s 复核=' + diag.re2.state + (diag.re2.code ? '(' + diag.re2.code + ')' : '(无码)') +
          '；+5s 复核=' + diag.re5.state + (diag.re5.code ? '(' + diag.re5.code + ')' : '(无码)') +
          '；设备联网态=' + (diag.net ? ('ip=' + diag.net.sta_has_ip + ' verified=' + diag.net.internet_verified +
            ' ssid=' + (diag.net.connected_ssid || '-')) : '读不到') +
          netTail(diag.net) +
          '；试连前=' + (preBase2 ? ('ssid=' + (preBase2.status.connected_ssid || '-') +
            ' ip=' + preBase2.status.sta_has_ip +
            (preBase2.sameSsid ? '（同SSID重放）' : '')) : '读不到') +
          '；自愈=' + (diag.rec ? ('ip=' + diag.rec.sta_has_ip + ' ssid=' + (diag.rec.connected_ssid || '-')) : '读不到'));
        return;
      }
      let tight = null;
      try {
        const ap = await proc.networkApply(oid1);
        tight = String(((ap && ap.data) || ap || {}).state || '').toLowerCase();
      } catch (e) {
        tight = 'err:' + ((e && e.code) || 'unknown');
      }
      rec('B2b', 'got_ip 后紧贴 apply → success', tight === 'success', '终态=' + tight);

      /* A6: defer 窗口内断 BLE → 设备应 cancel 并回原网；重连后无残留 */
      const r2 = await proc.tryConnect(goodAp.ssid, goodAp.password);
      const oid2 = r2.operation_id || (r2.data && r2.data.operation_id);
      const devBefore = io.currentDeviceName ? String(io.currentDeviceName() || '') : '';
      await sleep(3000); /* 8s 窗口内 */
      io.log('A6：窗口内主动断 BLE…' + (devBefore ? '（断前设备 ' + devBefore + '）' : ''));
      await io.dropLink();
      await sleep(2500);
      /* relink 兼容两种返回：true（旧 mock）| {ok, detail, deviceName}（带证据）。
       * 2026-11-07 二跑教训：断链后设备重新广播可能要几秒，首轮失败先等 5s
       * 补试一轮再判死，且 FAIL detail 必须带 relink 证据（scanFailures 等）。 */
      const rlOk = (r) => r === true || !!(r && r.ok);
      const rlDetail = (r, fallback) => (r && r.detail) || fallback;
      let relinked = await io.relink();
      let relinkDetail = rlOk(relinked) ? '' : rlDetail(relinked, '重连失败');
      if (!rlOk(relinked)) {
        io.log('A6：首轮重连失败，等 5s 设备广播恢复后补试一轮…');
        await sleep(5000);
        relinked = await io.relink();
        if (rlOk(relinked)) relinkDetail = '';
        else relinkDetail = rlDetail(relinked, relinkDetail);
      }
      if (!rlOk(relinked)) {
        rec('A6', 'defer 窗口断 BLE→重连', false, relinkDetail);
        return;
      }
      /* 重连必须是同一台设备（2026-11-07 双机并存教训）：findDevice 有「精确目标没等到
       * → 4s 后用任意 NUS 设备」的降级，若 C8E4 断链后 ~12s 不恢复广播而 65D8 在广播，
       * 会连到 65D8；两台正式 SSID 都是 CMCC-502 时"回原网"断言会假 PASS。 */
      const devAfter = (relinked && relinked.deviceName) ||
        (io.currentDeviceName ? String(io.currentDeviceName() || '') : '');
      if (devBefore && devAfter && devBefore !== devAfter) {
        rec('A6', 'defer 窗口断 BLE→重连', false,
          '重连到不同设备：断前=' + devBefore + ' 重连后=' + devAfter + '（可能误连另一台，如 IotHubBLE-65D8）');
        return;
      }
      let end2 = null;
      try {
        const g = await proc.operationGet(oid2);
        const d = (g && g.data) || g || {};
        end2 = String(d.state || '').toLowerCase();
      } catch (e) {
        end2 = 'gone:' + ((e && e.code) || 'unknown');
      }
      const stAfter = await proc.networkStatus();
      const backHome = stAfter.connected_ssid === cur && stAfter.sta_connected === true;
      rec('A6', 'defer 窗口断 BLE：op 终结 + 回原网',
        (end2 === 'cancelled' || end2.indexOf('gone:') === 0) && backHome,
        'op=' + end2 + ' 回原网=' + backHome);
    },

    /* ---- A1 配网全流程（P0 发布关键路径） ---- */
    async fullflow() {
      const proc = io.proc;
      const goodAp = io.env.goodAp;
      await assertGoodAp(proc, goodAp);
      let note = '';
      try {
        let r;
        try {
          r = await fullflowOnce(proc, goodAp, 'A1');
        } catch (e1) {
          /* 兜底闸（netcheck）拒绝的两条入口都要重试：
           * ① got_ip 之后 apply 被拒（17:44 形态）——apply 终态=<net码>；
           * ② **got_ip 之前 tryconnect 就被判失败**（gate-v2 起 GOT_IP 语义升级为
           *    "IP+联网+MQTT 就绪"，固件 cmd.c:470-530 只在 netcheck 判决 OK 才交付
           *    GOT_IP，否则直接 FAILED）——阶段终态=failed code=<net码>。
           * 两者都是"闸在设计内工作（防坏网落盘）"，不是坏网：等 internet_verified
           * 回 true 后整轮重试一次（新 op），仍被拒才判 FAIL。 */
          const msg1 = (e1 && e1.message) || '';
          const mApply = /apply 终态=(\w+)/.exec(msg1);
          const mStage = /阶段终态=failed code=(\w+)/.exec(msg1);
          const gateCode = (mApply && mApply[1]) || (mStage && mStage[1]) || '';
          /* 2026-11-07 六轮：op 以 cancelled 收尾 = owner=BLE 的 op 被链路掉线取消
           * （硬件侧 forensics 实测：PC 侧 BLE 适配器 ~40s 掉线即触发）。这是测试
           * 环境事件，不是固件/配网缺陷，也不该与"闸拒绝"共用一条重试路径：
           * 先 relink 把链路接回来，再整轮重跑一次。 */
          if (/阶段终态=cancelled/.test(msg1)) {
            io.log('op 被取消（owner=BLE 链路掉线，环境因素）：relink 后整轮重试一次');
            const rl = (io.relink ? await io.relink() : true);
            if (!(rl === true || (rl && rl.ok))) {
              throw new Error(msg1 + '；链路重连失败，无法复验（环境，非固件）');
            }
            r = await fullflowOnce(proc, goodAp, 'A1-c');
            note = '；首轮 op 被 BLE 掉链取消（环境）后重连重试成功';
          } else {
            if (FAIL_CODES.indexOf(gateCode) < 0) throw e1;
            io.log('联网验证兜底拒绝（' + gateCode + '，入口=' +
              (mApply ? 'apply' : 'tryconnect') + '）：等 MQTT 回稳后整轮重试一次');
            if (!await waitInternetOk(proc, 20000)) throw e1;
            r = await fullflowOnce(proc, goodAp, 'A1-r');
            note = '；联网验证首次拒绝（' + gateCode + '，' + (mApply ? 'apply' : 'tryconnect') + '）后重试成功';
          }
        }
        /* A1-s 口径修正（2026-11-07 22:4x，源码核实）：`stages` 在 operation.get
         * （cmd.c:732，按 have_snapshot 读 job 快照）；**apply 回包是动作回执**
         * （operation_id/state/saved/applied，cmd.c:790-800），按设计不带 stages。
         * §7.2 的本意是"阶段来自当前 operation"，故断言点放在 got_ip 时的 op 快照。
         * 旧写法（查 apply 回包）会把一个从不存在的要求判成永久红项。 */
        const gst = r.got && r.got.data && r.got.data.stages;
        const stOk = !!gst && gst.wifi_connected === true && gst.ip_acquired === true &&
          gst.internet_verified === true && gst.mqtt_connected === true;
        rec('A1', '配网全流程 tryconnect→got_ip→apply→success', true,
          'got_ip ' + gotMs(r.got) + '，全程 ' + r.ms + 'ms，stages=' +
          (gst ? '有' : '无') + '，tcp探败=' + (r.tcpFails || '-') + note);
        rec('A1-s', 'got_ip 时 op 快照 stages 四阶段（§7.2）', stOk,
          stOk ? 'four=true' : 'stages=' + (gst ? JSON.stringify(gst).slice(0, 120) : '缺失'));
      } catch (e) {
        rec('A1', '配网全流程 tryconnect→got_ip→apply→success', false, (e && e.message) || String(e));
      }
    },

    /* ---- A2/A3 失败轨迹（需 broker 不可达 AP） ---- */
    async failpath() {
      const proc = io.proc;
      const failAp = io.env.failAp;
      if (!failAp || !failAp.ssid) {
        rec('A2', '失败轨迹（需 broker 不可达 AP）', false, '未配置 failAp，套件跳过');
        return;
      }
      try {
        const acc = await proc.tryConnect(failAp.ssid, failAp.password || '');
        const oid = acc.operation_id || (acc.data && acc.data.operation_id);
        const end = await pollOp(proc, oid, [], 80000, io);
        const cls = classifyFailEnd(end.state, end.code);
        rec('A2', '失败终态 failed/' + (cls.code || end.code || end.state), cls.pass, cls.why || '');
        if (cls.pass) {
          const stages = end.data && end.data.stages;
          const sh = checkStagesShape(stages);
          rec('A2-s', 'stages 失败轨迹形状', sh.ok, sh.detail);
        }
        const mapped = errors.textOf({ code: end.code });
        rec('A3', 'errors.js 已映射 ' + end.code + '（非裸码透传）', !!mapped && mapped !== end.code,
          mapped || '未映射');
      } catch (e) {
        rec('A2', '失败轨迹', false, (e && e.message) || String(e));
      }
    },

    /* ---- B3 循环压测 ---- */
    async loop() {
      const proc = io.proc;
      const goodAp = io.env.goodAp;
      const rounds = Math.max(1, Math.min(20, io.env.rounds || 10));
      await assertGoodAp(proc, goodAp);
      const durs = [];
      const heaps = [];
      let fails = 0;
      for (let i = 1; i <= rounds; i++) {
        io.log('B3 第 ' + i + '/' + rounds + ' 轮…');
        try {
          const r = await fullflowOnce(proc, goodAp, 'B3-' + i);
          durs.push(r.ms);
          heaps.push(await readHeap(proc));
        } catch (e) {
          fails++;
          io.log('  第 ' + i + ' 轮失败：' + ((e && e.message) || e));
          break; /* 有失败就停，别把设备拖进风暴 */
        }
      }
      const s = summarizeLoop(durs, heaps);
      rec('B3', '配网循环 ' + durs.length + '/' + rounds + ' 轮', s.pass && fails === 0,
        s.detail + (fails ? '，失败 ' + fails + ' 轮后中止' : ''));
    },

    /* ---- B4 netcheck 在飞 + BLE 长响应并存 ---- */
    async concur() {
      const proc = io.proc;
      const goodAp = io.env.goodAp;
      await assertGoodAp(proc, goodAp);
      const acc = await proc.tryConnect(goodAp.ssid, goodAp.password);
      const oid = acc.operation_id || (acc.data && acc.data.operation_id);
      let okN = 0;
      for (let i = 0; i < 10; i++) {
        try {
          const cfg = await proc.configGet(['network']);
          if (cfg) okN++;
        } catch (e) {
          io.log('  config.get #' + (i + 1) + ' 失败：' + ((e && e.code) || e));
        }
        await sleep(300);
      }
      rec('B4', 'netcheck 在飞期间 config.get×10 完整', okN === 10, okN + '/10');
      let cancelled = null;
      try {
        await proc.networkCancel(oid);
        const end = await pollOp(proc, oid, ['cancelled'], 15000, io);
        cancelled = end.state;
      } catch (e) {
        cancelled = 'err:' + ((e && e.code) || 'unknown');
      }
      rec('B4-c', '并发后 cancel 收尾（不落盘）', cancelled === 'cancelled', '终态=' + cancelled);
      let tail = false;
      try { await proc.networkStatus(); tail = true; } catch (e) { tail = false; }
      rec('B4-t', '收尾后 BLE 流完好', tail, '');
    },
  };

  return {
    recs: recs,
    run: async function (suite) {
      const fn = suites[suite];
      if (!fn) { io.log('未知套件：' + suite); return null; }
      io.log('==== 套件 ' + suite + ' 开始 ====');
      const before = recs.length;
      /* 口令否决（2026-11-08 十三轮）：上一套件已被设备判 wrong_password（4WAY 握手失败）
       * 时，同口令再跑 tryconnect 只会重复失败——更糟的是连续 4WAY 失败有触发 AP 侧
       * 锁 MAC 的风险。只读组不动配置，照常跑（它可能正是取证需要）。 */
      if (io.pwdRejected && suite !== 'readonly') {
        const pj = io.pwdRejected;
        io.log('⚠ 口令已被设备判定错误（ssid=' + pj.ssid + ' ' + pj.fp + '）：本套件跳过');
        rec(suite + '-x', '口令被拒：套件未执行', false,
          '上一套件 failed/wrong_password（ssid=' + pj.ssid + ' ' + pj.fp + '）；' +
          '同口令继续跑只会重复 4WAY 握手失败，并可能触发 AP 侧锁 MAC。' +
          '请修正 T6 页 goodPassword（本地记忆已被作废，需重新输入）后重跑。');
        io.log('==== 套件 ' + suite + ' 结束（0/1）====');
        return { pass: passCount, total: recs.length, recs: recs.slice() };
      }
      /* 前置探测（2026-11-08 09:35 事故）：身份读取与首条命令各 10s 静默时，
       * 继续跑只会把同一形态复制成 N 个 FAIL 并浪费 70s/套件。先判因，静默类
       * 直接中止并给出处置，让日志自己说清是"设备不响应"还是"链路/写的问题"。 */
      let pf = null;
      try {
        pf = await preflightDevice(io);
      } catch (e) {
        io.log('设备探测异常：' + ((e && e.code) || (e && e.message) || e));
      }
      if (pf && pf.ok) {
        const di = pf.info || {};
        io.log('设备身份：' + (io.deviceLabel ? io.deviceLabel() + ' ' : '') +
          'firmware=' + (di.firmware || di.version || '?') +
          ' build_sha=' + (di.build_sha || '无') +
          ' variant=' + (di.build_variant || '无') + '（探测 ' + pf.ms + 'ms）');
        if (!di.build_sha) {
          io.log('⚠ 该设备未上报 build_sha：镜像早于 11-06 scan_v2（旧固件/旧镜像）。' +
            '此时 A4-1/A1-s/C2 的 FAIL 属「连错设备/镜像旧」而非新固件缺陷——' +
            '双机并存（IotHubBLE-C8E4 / IotHubBLE-65D8）时请先确认连接目标。');
        }
      } else if (pf) {
        const cls = pf.cls || { kind: 'unknown', text: '未知' };
        io.log('设备身份读取失败：' + pf.code + '（归因=' + cls.kind + '：' + cls.text + '；' + pf.stats + '）');
        if (silenceBlocksSuite(cls.kind) || cls.kind === 'unknown') {
          rec(suite + '-x', '设备无响应：套件未执行', false,
            '归因=' + cls.kind + '；' + cls.text + '；' + pf.stats + '；' + silenceHint(cls.kind));
          io.log('==== 套件 ' + suite + ' 结束（0/1）====');
          return { pass: passCount, total: recs.length, recs: recs.slice() };
        }
      }
      try {
        await fn();
      } catch (e) {
        rec(suite + '-x', '套件异常中止', false, (e && e.message) || String(e));
      }
      io.log('==== 套件 ' + suite + ' 结束（' +
        recs.slice(before).filter(function (r) { return r.pass; }).length + '/' +
        (recs.length - before) + '）====');
      return { pass: passCount, total: recs.length, recs: recs.slice() };
    },
  };
}

function gotMs(got) { return (got && got.elapsedMs ? got.elapsedMs + 'ms' : 'n/a'); }

module.exports = {
  FAIL_CODES: FAIL_CODES,
  OP_TERMINAL: OP_TERMINAL,
  verdictOfNetworkStatus: verdictOfNetworkStatus,
  errCodeOf: errCodeOf,
  reasonOf: reasonOf,
  pwdFp: pwdFp,
  pwdHygiene: pwdHygiene,
  credVerdict: credVerdict,
  credLine: credLine,
  noteCredReject: noteCredReject,
  checkStagesShape: checkStagesShape,
  netTail: netTail,
  classifyFailEnd: classifyFailEnd,
  summarizeLoop: summarizeLoop,
  pollOp: pollOp,
  classifySilence: classifySilence,
  silenceBlocksSuite: silenceBlocksSuite,
  silenceHint: silenceHint,
  mkRunner: mkRunner,
};
