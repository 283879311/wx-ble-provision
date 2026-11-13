/**
 * 压测引擎：BLE DATA 通道 / UART1 通路的可测性封装。
 *
 * 设计约束（很重要，别为了"顺手"破坏它）
 * ----------------------------------------
 * 1. **纯逻辑，不碰 wx**。所有外部动作走注入的 `io`（write/subscribe/now/sleep）。
 *    这样 Node 桩能完整跑一遍调度、结算、判定，不用真机；页面卸载也不会
 *    把压测状态带走（状态在引擎里，不在 page.data 里）。
 * 2. **三模式共用一套编解码与统计**。listen / echo / flood 的差别只在
 *    「发不发、发多少、等不等回程」，帧语义一律走 pframe。
 * 3. **不同层的丢失分开计数**。sent / received / crc / seqGap / dup / timeout /
 *    disconnect 各自独立，禁止合成一个「丢失 N 帧」。
 * 4. **收尾三态**。收到 END ≠ 完整；END 没到 ≠ 失败。见 pframe 头部约定。
 *
 * 三模式
 * ------
 *   listen  手机不发，只解析对端（PC flood）灌下来的帧。测下行到达率。
 *   echo    手机发 START+DATA+END，电脑原样回显。测完整性 + 帧级 RTT。
 *   flood   手机按目标速率主动灌流，同时解析回程（若对端 echo）。测上行吞吐。
 *
 * 结算以「回程 END」为准；若对端不回显（PC 用 listen 模式），则退化为
 * 「本地已发 + 等不到 END」→ `no_end`，此时只能签收提交量，不能断言到达。
 */

const P = require('./pframe');

const MODE = {
  LISTEN: 'listen',
  ECHO: 'echo',
  FLOOD: 'flood',
};

/** 速率统计的样本门槛：低于此值一律显示「数据不足」，不参与饱和判断 */
const MIN_RATE_BYTES = 1024;
const MIN_RATE_MS = 300;

/** 收尾等待：从「最后一帧到达」算起，不是从发送结束算起 */
const DEFAULT_END_WAIT_MS = 3000;

/** 判定档位：<=SMALL_FRAME_BYTES 要求零丢零错；更大只要求不错内容 */
const SMALL_FRAME_BYTES = 200;

const VERDICT = {
  PASS: 'PASS',
  EXPECTED: 'EXPECTED',
  FAIL: 'FAIL',
  NA: 'N/A',
};

/* ---------------------------------------------------------------- 位图 */

/**
 * 定长 seq 位图。用 total 定长而不是滑动窗口，是因为本轮 total 一定已知
 * （发送端自己知道；接收端从 START 拿到），seq 不会回绕，直接 O(1) 置位。
 * 65535 帧也只要 8KB。
 */
function Bitset(n) {
  this.n = n > 0 ? n : 0;
  this.words = new Uint8Array(((this.n + 7) >> 3) || 1);
  this.count = 0;
}

Bitset.prototype.mark = function (seq) {
  if (seq < 0 || seq >= this.n) return 'out';
  const byte = seq >> 3;
  const mask = 1 << (seq & 7);
  if (this.words[byte] & mask) return 'dup';
  this.words[byte] |= mask;
  this.count += 1;
  return 'new';
};

Bitset.prototype.has = function (seq) {
  if (seq < 0 || seq >= this.n) return false;
  return (this.words[seq >> 3] & (1 << (seq & 7))) !== 0;
};

/** 返回缺失序号，最多收集 limit 个（报告里只要首几个定位） */
Bitset.prototype.missing = function (limit) {
  const out = [];
  const cap = limit || 20;
  for (let i = 0; i < this.n; i++) {
    if (!this.has(i)) {
      out.push(i);
      if (out.length >= cap) break;
    }
  }
  return out;
};

Bitset.prototype.missingCount = function () {
  return this.n - this.count;
};

/* ---------------------------------------------------------------- 配置 */

function normalize(cfg) {
  const c = cfg || {};
  const mode = c.mode || MODE.ECHO;
  if (mode !== MODE.LISTEN && mode !== MODE.ECHO && mode !== MODE.FLOOD) {
    throw new Error('未知模式: ' + mode);
  }
  const frames = Math.max(1, Math.min(65535, c.frames || 100));
  const payloadLen = Math.max(0, Math.min(P.MAX_PAYLOAD, c.payloadLen === undefined ? 191 : c.payloadLen));
  return {
    mode: mode,
    frames: frames,
    payloadLen: payloadLen,
    /** 目标速率 B/s（含帧开销）。0 = 不做速率限制，尽快发 */
    rate: Math.max(0, c.rate || 0),
    runId: (c.runId === undefined ? Math.floor(Math.random() * 0x10000) : c.runId) & 0xffff,
    endWaitMs: c.endWaitMs === undefined ? DEFAULT_END_WAIT_MS : c.endWaitMs,
    /** listen 模式总超时：等 PC 灌流开始 + 灌完，默认 15s */
    listenTimeoutMs: c.listenTimeoutMs === undefined ? 15000 : c.listenTimeoutMs,
    /** 每帧之间额外静默（ms），用于测片间隔下限 / 模拟慢速现场 */
    gapMs: Math.max(0, c.gapMs || 0),
    label: c.label || '',
  };
}

/* ---------------------------------------------------------------- 统计 */

function newStat() {
  return {
    // 发送侧
    sent: 0,
    sendErrors: 0,
    submittedBytes: 0,
    // 接收侧
    received: 0,        // 收到的 DATA 帧总数（含重复）
    receivedUnique: 0,  // 去重后的 DATA 帧数
    receivedBytes: 0,   // 收到的整帧字节（含开销）
    duplicates: 0,
    outOfOrder: 0,
    outOfRange: 0,
    payloadMismatch: 0,
    // 解析层
    crcErrors: 0,
    resyncBytes: 0,
    truncBytes: 0,
    oversize: 0,
    unknownType: 0,
    // 控制帧
    startSeen: 0,
    endSeen: 0,
    staleControl: 0,
    startTotal: -1,
    startPayloadLen: -1,
    endSent: -1,
    // 链路
    disconnects: 0,
    disconnected: false,
    aborted: false,
  };
}

/* ---------------------------------------------------------------- 引擎 */

/**
 * @param {Object} cfg {mode, frames, payloadLen, rate, runId, gapMs, endWaitMs, label}
 * @param {Object} io  {write(bytes):Promise<{ok,ms,error}>, subscribe(cb):function,
 *                      now():number, sleep(ms):Promise, isConnected():boolean, meta():Object}
 * @param {Object} [hooks] {onProgress(snapshot), onFrame(frame), onLog(line)}
 */
function StressRun(cfg, io, hooks) {
  this.cfg = normalize(cfg);
  this.io = io;
  this.hooks = hooks || {};

  this.stat = newStat();
  this.window = new Bitset(this.cfg.frames);
  this.parser = new P.FrameParser({
    staleMs: 2000,
    onFrame: (f) => this._onFrame(f),
  });

  this._sendAt = new Float64Array(this.cfg.frames);
  this._sendAtSet = new Uint8Array(this.cfg.frames);
  this._rtt = [];

  this._state = 'idle'; // idle -> running -> settling -> done
  this._startedAt = 0;
  this._endedAt = 0;
  this._lastFrameAt = 0;
  this._lastSeq = -1;
  this._unsubscribe = null;
  this._settleState = 'pending';
  this._inflightWrite = 0;
}

StressRun.prototype.snapshot = function () {
  const s = this.stat;
  const elapsed = this._startedAt ? (this._endedAt || this.io.now()) - this._startedAt : 0;
  return {
    state: this._state,
    mode: this.cfg.mode,
    runId: this.cfg.runId,
    elapsedMs: elapsed,
    sent: s.sent,
    planned: this.cfg.frames,
    received: s.receivedUnique,
    receivedRaw: s.received,
    duplicates: s.duplicates,
    seqGaps: s.sent > 0 ? this._gapCount() : 0,
    crcErrors: s.crcErrors,
    sendErrors: s.sendErrors,
    disconnects: s.disconnects,
    endSeen: s.endSeen,
    settle: this._settleState,
    inFlight: this._inflightWrite,
  };
};

StressRun.prototype._gapCount = function () {
  // 只统计「已发出但没收到」的区间，未发出的不算丢
  const upto = Math.min(this.window.n, Math.max(this.stat.sent, this.stat.receivedUnique));
  let missing = 0;
  for (let i = 0; i < upto; i++) if (!this.window.has(i)) missing += 1;
  return missing;
};

StressRun.prototype._emitProgress = function (force) {
  const now = this.io.now();
  if (!force && this._lastProgressAt && now - this._lastProgressAt < 120) return;
  this._lastProgressAt = now;
  if (typeof this.hooks.onProgress === 'function') {
    this.hooks.onProgress(this.snapshot());
  }
};

StressRun.prototype._log = function (line) {
  if (typeof this.hooks.onLog === 'function') this.hooks.onLog(line);
};

/* ---------------------------------------------------------------- 接收 */

StressRun.prototype._onFrame = function (frame) {
  const s = this.stat;
  this._lastFrameAt = this.io.now();

  // 解析层异常由 parser 自己记账，这里定期同步，避免两处各算一份
  s.crcErrors = this.parser.stats.crcErrors;
  s.resyncBytes = this.parser.stats.resyncBytes;

  if (typeof this.hooks.onFrame === 'function') this.hooks.onFrame(frame);

  if (frame.type === P.TYPE_START) {
    if (frame.seq !== this.cfg.runId) {
      s.staleControl += 1;
      return;
    }
    const d = P.decodeStart(frame.payload);
    if (!d) {
      s.staleControl += 1;
      return;
    }
    s.startSeen += 1;
    s.startTotal = d.total;
    s.startPayloadLen = d.payloadLen;
    // 接收端（listen）靠 START 才知道该收多少；发送端自己已经知道，不覆盖
    if (this.cfg.mode === MODE.LISTEN && this.window.n !== d.total) {
      this.window = new Bitset(d.total);
    }
    return;
  }

  if (frame.type === P.TYPE_END) {
    if (frame.seq !== this.cfg.runId) {
      s.staleControl += 1;
      return;
    }
    const d = P.decodeEnd(frame.payload);
    if (!d) {
      s.staleControl += 1;
      return;
    }
    s.endSeen += 1;
    s.endSent = d.sent;
    return;
  }

  if (!P.isData(frame.type)) {
    s.unknownType += 1;
    return;
  }

  s.received += 1;
  s.receivedBytes += frame.bytes;

  const seq = frame.seq;
  const mark = this.window.mark(seq);
  if (mark === 'out') {
    s.outOfRange += 1;
    return;
  }
  if (mark === 'dup') {
    s.duplicates += 1;
    this._emitProgress();
    return;
  }

  s.receivedUnique += 1;

  // 乱序：以「已见最大 seq」为基准，回退即乱序（重复已在上一步排除）
  if (seq < this._lastSeq) s.outOfOrder += 1;
  else this._lastSeq = seq;

  // 内容校验：按 seq 就地重建，不留副本
  if (!P.payloadMatches(seq, frame.payload)) s.payloadMismatch += 1;

  // RTT：只有本机发过的 seq 才有发送时刻
  if (seq < this._sendAtSet.length && this._sendAtSet[seq]) {
    const rtt = this.io.now() - this._sendAt[seq];
    if (rtt >= 0 && rtt < 600000) this._rtt.push(rtt);
  }

  this._emitProgress();
};

/* ---------------------------------------------------------------- 发送 */

StressRun.prototype._writeFrame = async function (bytes) {
  this._inflightWrite += 1;
  try {
    const r = await this.io.write(bytes);
    if (r && r.ok) {
      this.stat.submittedBytes += bytes.length;
      return true;
    }
    this.stat.sendErrors += 1;
    this._log('写失败：' + ((r && r.error) || 'unknown'));
    return false;
  } catch (e) {
    this.stat.sendErrors += 1;
    this._log('写异常：' + ((e && (e.message || e.errMsg)) || String(e)));
    return false;
  } finally {
    this._inflightWrite -= 1;
  }
};

StressRun.prototype._shouldStop = function () {
  return this.stat.aborted || this.stat.disconnected;
};

StressRun.prototype._sleep = function (ms) {
  if (ms <= 0) return Promise.resolve();
  return this.io.sleep ? this.io.sleep(ms) : new Promise((r) => setTimeout(r, ms));
};

/* ---------------------------------------------------------------- 主流程 */

/**
 * @returns {Promise<Object>} report
 */
StressRun.prototype.start = async function () {
  if (this._state !== 'idle') throw new Error('run 已启动');

  const cfg = this.cfg;
  const s = this.stat;

  this._state = 'running';
  this._startedAt = this.io.now();
  this._lastFrameAt = this._startedAt;
  this._lastProgressAt = 0;

  // 先订阅再发，避免前几帧的回程落在订阅之前
  if (typeof this.io.subscribe === 'function') {
    this._unsubscribe = this.io.subscribe((bytes) => this.parser.push(bytes));
  }

  this._log('开始 ' + cfg.mode + ' · ' + cfg.frames + ' 帧 × ' + cfg.payloadLen + 'B' +
    (cfg.rate ? ' · 目标 ' + cfg.rate + ' B/s' : '') + ' · runId=0x' + cfg.runId.toString(16).toUpperCase());

  try {
    if (cfg.mode === MODE.LISTEN) {
      await this._runListen();
    } else {
      await this._runSend();
    }
  } finally {
    if (this._unsubscribe) {
      try { this._unsubscribe(); } catch (e) { /* 链路已断时退订会抛，忽略 */ }
      this._unsubscribe = null;
    }
    this._endedAt = this.io.now();
    this._state = 'done';
    this.parser.tick(this._endedAt); // 收尾时把半帧判为残缺
    s.truncBytes = this.parser.stats.truncBytes;
    s.crcErrors = this.parser.stats.crcErrors;
    s.resyncBytes = this.parser.stats.resyncBytes;
    s.oversize = this.parser.stats.oversize;
    this._settle();
    this._emitProgress(true);
  }

  return this.report();
};

/** L0：不发，只等到 END 或超时 */
StressRun.prototype._runListen = async function () {
  const cfg = this.cfg;
  const deadline = this.io.now() + cfg.listenTimeoutMs;
  while (!this._shouldStop()) {
    if (this.stat.endSeen > 0) break;
    if (this.io.isConnected && !this.io.isConnected()) {
      this.stat.disconnected = true;
      this.stat.disconnects += 1;
      break;
    }
    // 收到 START 后按 total 提前结束（END 可能丢）
    if (this.stat.startTotal >= 0 && this.stat.receivedUnique >= this.stat.startTotal) break;
    if (this.io.now() > deadline) break;
    await this._sleep(50);
    this._emitProgress();
  }
  // END 之后还可能有余帧在路上，给一点收尾
  await this._sleep(200);
};

/** L1/L2：发 START → DATA×N → END，然后等回程结算 */
StressRun.prototype._runSend = async function () {
  const cfg = this.cfg;
  const s = this.stat;
  const frameLen = P.FRAME_OVERHEAD + cfg.payloadLen;

  // START 只在 flood 发：echo 下 START 会被原样回显，回程控制帧对结算无意义，
  // 但发了也无害且方便 PC 侧日志对时，统一发。
  const startOk = await this._writeFrame(P.startFrame(cfg.runId, cfg.frames, cfg.payloadLen));
  if (!startOk && !this._shouldStop()) {
    // START 写失败通常是链路已经断了，直接进入结算
    this._log('START 写失败，提前结算');
  }

  const t0 = this.io.now();
  let nextAt = t0;

  for (let i = 0; i < cfg.frames; i++) {
    if (this._shouldStop()) break;

    if (this.io.isConnected && !this.io.isConnected()) {
      s.disconnected = true;
      s.disconnects += 1;
      this._log('第 ' + i + ' 帧前检测到断链');
      break;
    }

    const frame = P.dataFrame(i, cfg.payloadLen);
    this._sendAt[i] = this.io.now();
    const ok = await this._writeFrame(frame);
    if (ok) {
      s.sent += 1;
      this._sendAtSet[i] = 1;
    }

    // 速率控制：累加补偿，避免 sleep 抖动累积成漂移
    if (cfg.rate > 0) {
      nextAt += (frameLen / cfg.rate) * 1000;
      const ahead = nextAt - this.io.now();
      if (ahead > 0) await this._sleep(ahead);
    } else if (cfg.gapMs > 0) {
      await this._sleep(cfg.gapMs);
    }

    this._emitProgress();
  }

  const endOk = await this._writeFrame(P.endFrame(cfg.runId, s.sent));
  if (!endOk) this._log('END 写失败（结算将以回程证据为准）');

  await this._waitForSettle();
};

StressRun.prototype._waitForSettle = async function () {
  const cfg = this.cfg;
  const deadline = this.io.now() + cfg.endWaitMs + 8000;
  while (!this._shouldStop()) {
    const idle = this.io.now() - this._lastFrameAt;

    // 全齐（含 END 已到）→ 直接收工
    if (this.stat.endSeen > 0 && this._gapCount() === 0) break;

    // END 已到但还有缺口：不能立刻结算。END 是最后发出的，但乱序的 DATA
    // 完全可能比它晚到（BLE 重传、UART 缓冲）。必须等满一个静默窗口，
    // 否则会把「还在路上的帧」判成丢失。
    if (idle > cfg.endWaitMs) break;
    if (this.io.now() > deadline) break;

    await this._sleep(50);
    this._emitProgress();
  }
  await this._sleep(120); // 让最后一片 notify 落地
};

/* ---------------------------------------------------------------- 结算 */

StressRun.prototype._settle = function () {
  const cfg = this.cfg;
  const s = this.stat;

  // 解析层数字最后同步一次
  s.truncBytes = this.parser.stats.truncBytes;
  s.oversize = this.parser.stats.oversize;

  // 期望接收数：优先回程 START，其次本地计划，最后本地已发
  let expected = cfg.frames;
  if (s.startTotal >= 0) expected = s.startTotal;
  if (cfg.mode === MODE.LISTEN && s.startTotal < 0) expected = this.window.n;

  // 位图按 expected 裁剪统计（listen 可能被 START 重设过大小）
  const upto = Math.min(expected, this.window.n);
  let missing = 0;
  for (let i = 0; i < upto; i++) if (!this.window.has(i)) missing += 1;
  this._missingCount = missing;
  this._missingSeqs = this.window.missing(10);

  const got = s.receivedUnique;

  if (s.endSeen > 0) {
    // END 到了：还要看 DATA 是否齐
    this._settleState = missing === 0 && got >= upto ? 'complete' : 'end_partial';
  } else if (got > 0) {
    this._settleState = 'no_end';
  } else if (cfg.mode === MODE.LISTEN) {
    this._settleState = 'no_data';
  } else {
    this._settleState = 'no_end';
  }

  // 完全没收到任何回程，且本机也没发（listen）→ 无证据
  if (cfg.mode === MODE.LISTEN && got === 0 && s.startSeen === 0) {
    this._settleState = 'no_data';
  }
};

/* ---------------------------------------------------------------- 报告 */

StressRun.prototype._rttStats = function () {
  const a = this._rtt;
  if (!a.length) return { n: 0, min: 0, avg: 0, p50: 0, p95: 0, max: 0 };
  const sorted = a.slice().sort((x, y) => x - y);
  const sum = sorted.reduce((x, y) => x + y, 0);
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    n: sorted.length,
    min: Math.round(sorted[0]),
    avg: Math.round(sum / sorted.length),
    p50: Math.round(pick(0.5)),
    p95: Math.round(pick(0.95)),
    max: Math.round(sorted[sorted.length - 1]),
  };
};

StressRun.prototype.report = function () {
  const cfg = this.cfg;
  const s = this.stat;
  const elapsed = this._endedAt ? this._endedAt - this._startedAt : this.io.now() - this._startedAt;
  const elapsedMs = Math.max(0, Math.round(elapsed));
  const elapsedSec = elapsedMs / 1000;

  const frameLen = P.FRAME_OVERHEAD + cfg.payloadLen;
  const plannedBytes = cfg.frames * frameLen;
  const receivedPayloadBytes = s.receivedUnique * cfg.payloadLen;

  // 样本门槛：数据太少时速率没有意义，明确标出来而不是给个漂亮数字
  const rateInsufficient =
    s.submittedBytes < MIN_RATE_BYTES || elapsedMs < MIN_RATE_MS;
  const goodputBps = rateInsufficient || elapsedSec <= 0
    ? null
    : Math.round(receivedPayloadBytes / elapsedSec);
  const submitBps = rateInsufficient || elapsedSec <= 0
    ? null
    : Math.round(s.submittedBytes / elapsedSec);

  const rtt = this._rttStats();
  const missingCount = this._missingCount === undefined ? 0 : this._missingCount;
  const missingSeqs = this._missingSeqs || [];

  const outcome = this._verdict(missingCount);

  return {
    version: 1,
    profile: cfg.label || cfg.mode,
    mode: cfg.mode,
    runId: cfg.runId,
    startedAt: this._startedAt,
    elapsedMs: elapsedMs,
    config: {
      frames: cfg.frames,
      payloadLen: cfg.payloadLen,
      frameLen: frameLen,
      rate: cfg.rate,
      gapMs: cfg.gapMs,
      endWaitMs: cfg.endWaitMs,
    },
    link: (this.io.meta && this.io.meta()) || {},
    ledger: {
      // 四个阶段分别记账，**不要相减**
      plannedBytes: plannedBytes,
      submittedBytes: s.submittedBytes,
      deviceRxBytes: null,  // 需设备侧日志/回显旁证，缺失即 null（报告显示 n/a）
      uartOutBytes: null,   // 需 PC 侧汇总行人工抄录
    },
    frames: {
      planned: cfg.frames,
      sent: s.sent,
      sendErrors: s.sendErrors,
      received: s.received,
      receivedUnique: s.receivedUnique,
      duplicates: s.duplicates,
      seqGaps: missingCount,
      outOfOrder: s.outOfOrder,
      outOfRange: s.outOfRange,
      payloadMismatch: s.payloadMismatch,
      startSeen: s.startSeen,
      endSeen: s.endSeen,
      endSent: s.endSent,
      startTotal: s.startTotal,
      staleControl: s.staleControl,
      disconnects: s.disconnects,
    },
    parser: {
      crcErrors: s.crcErrors,
      resyncBytes: s.resyncBytes,
      truncBytes: s.truncBytes,
      oversize: s.oversize,
      unknownType: s.unknownType,
    },
    settle: this._settleState,
    missing: {
      count: missingCount,
      firstSeqs: missingSeqs,
    },
    timing: {
      goodputBps: goodputBps,
      submitBps: submitBps,
      rateInsufficient: rateInsufficient,
      rateNote: rateInsufficient
        ? '数据不足（' + s.submittedBytes + 'B / ' + elapsedMs + 'ms），不下饱和结论'
        : '',
      rtt: rtt,
      rttNote: cfg.mode === MODE.ECHO
        ? 'RTT 含 BLE 双程 + UART 往返 + PC 回写，非单程'
        : '本模式无回程 RTT',
    },
    verdict: outcome.verdict,
    reasons: outcome.reasons,
  };
};

StressRun.prototype._verdict = function (missingCount) {
  const cfg = this.cfg;
  const s = this.stat;
  const reasons = [];
  const small = cfg.payloadLen <= SMALL_FRAME_BYTES;

  if (s.payloadMismatch > 0) {
    reasons.push('内容不一致 ' + s.payloadMismatch + ' 帧（两端 LCG/编码不一致，或链路改字节）');
    return { verdict: VERDICT.FAIL, reasons: reasons };
  }
  if (s.disconnects > 0 || s.disconnected) {
    reasons.push('压测期间断链');
    return { verdict: VERDICT.FAIL, reasons: reasons };
  }
  if (s.crcErrors > 0) {
    reasons.push('CRC 错误 ' + s.crcErrors + ' 次（内容损坏或错位）');
    return { verdict: VERDICT.FAIL, reasons: reasons };
  }
  if (s.sendErrors > 0) {
    reasons.push('写调用失败 ' + s.sendErrors + ' 次');
    if (s.sent === 0) return { verdict: VERDICT.FAIL, reasons: reasons };
  }

  // 发送侧但完全没有回程：对端是 --mode listen（只听不回）时的正常现象。
  // 此时只能签收「提交量」，到达率不在本机可测范围内 —— 标 N/A 而不是 FAIL，
  // 否则每次测上行吞吐都会被判失败。
  if (cfg.mode !== MODE.LISTEN && s.received === 0 && s.startSeen === 0) {
    if (s.sent === 0) {
      reasons.push('一帧都没发出');
      return { verdict: VERDICT.FAIL, reasons: reasons };
    }
    reasons.push('对端未回显（listen 模式）：已签收提交 ' + s.submittedBytes +
      'B / ' + s.sent + ' 帧，到达率需 PC 侧计数');
    return { verdict: VERDICT.NA, reasons: reasons };
  }

  if (this._settleState === 'no_data') {
    reasons.push('未收到任何数据（runId/波特率/对端模式检查）');
    return { verdict: VERDICT.FAIL, reasons: reasons };
  }

  if (this._settleState === 'complete' && missingCount === 0) {
    reasons.push('END 到达且 DATA 全齐');
    if (s.duplicates > 0) reasons.push('有重复帧 ' + s.duplicates + '（不计失败，但需记录）');
    if (s.outOfOrder > 0) reasons.push('乱序 ' + s.outOfOrder + ' 帧（不计失败，但需记录）');
    return { verdict: VERDICT.PASS, reasons: reasons };
  }

  // END 未到达：不能断言完整，但也不能等同于「丢了帧」。
  // 数据全齐时记 EXPECTED（证据不足），有缺口时按档位判。
  if (this._settleState === 'no_end') {
    if (missingCount === 0 && s.receivedUnique > 0) {
      reasons.push('未收到 END（' + cfg.endWaitMs + 'ms 空闲）：DATA 全齐但无法断言完整');
      return { verdict: VERDICT.EXPECTED, reasons: reasons };
    }
    reasons.push('未收到 END（' + cfg.endWaitMs + 'ms 空闲）且缺 ' + missingCount + ' 帧');
    return { verdict: small ? VERDICT.FAIL : VERDICT.EXPECTED, reasons: reasons };
  }

  // end_partial / 其它缺口
  reasons.push('缺 ' + missingCount + ' 帧（首几个 seq: ' + (this._missingSeqs || []).join(',') + '）');
  if (small) {
    reasons.push('≤' + SMALL_FRAME_BYTES + 'B 档要求零丢帧');
    return { verdict: VERDICT.FAIL, reasons: reasons };
  }
  reasons.push('>' + SMALL_FRAME_BYTES + 'B 档：已知 data_pipe 深度边界，与首轮基线比');
  return { verdict: VERDICT.EXPECTED, reasons: reasons };
};

/* ---------------------------------------------------------------- 中止 */

StressRun.prototype.abort = function (why) {
  if (this._state === 'done') return;
  this.stat.aborted = true;
  this._log('中止：' + (why || 'user'));
};

StressRun.prototype.state = function () {
  return this._state;
};

module.exports = {
  MODE: MODE,
  VERDICT: VERDICT,
  MIN_RATE_BYTES: MIN_RATE_BYTES,
  MIN_RATE_MS: MIN_RATE_MS,
  SMALL_FRAME_BYTES: SMALL_FRAME_BYTES,
  StressRun: StressRun,
  createRun: function (cfg, io, hooks) {
    return new StressRun(cfg, io, hooks);
  },
  Bitset: Bitset,
};
