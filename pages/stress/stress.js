/**
 * 传输压测控制台（L0 只收 / L1 回显 / L2 灌流）。
 *
 * 分工：本页只负责「选参数、起停、展示、归档」；调度与判定全在
 * `utils/stress.js`，帧编解码全在 `utils/pframe.js`。页面不参与任何计数，
 * 否则切页/重渲染会把统计带偏。
 *
 * 三条硬约束：
 * 1. **改设备状态必须还原**。`data.loopback` 一旦开着，UART 页会看到
 *    "发出去的数据原样回来"。所有收尾路径（正常/中止/断链/onUnload）
 *    都要还原，并在报告里写「已还原」证据。
 * 2. **切 tab 不中断**。状态挂在引擎实例上（`this._run` + globalData 标记），
 *    页面卸载只解绑回调，不销毁引擎。
 * 3. **不承诺测不了的东西**。对端只监听时只能签收提交量，报告标 N/A。
 */
const { ble, protocol } = require('../../utils/session');
const core = require('../../utils/accept-core');
const S = require('../../utils/stress');
const P = require('../../utils/pframe');
const store = require('../../utils/accept-store');
const { describe } = require('../../utils/errors');

const CHUNK_SIZE = 20;
const CHUNK_GAP_MS = 20;

Page(Object.assign({}, core.shared, {
  data: {
    ready: false,
    loggedIn: false,
    linking: false,
    linkText: '',
    busy: false,
    deviceId: '',
    deviceName: '',
    sessionId: 0,

    modeChoices: [
      { v: 'listen', label: 'L0 只收' },
      { v: 'echo', label: 'L1 回显' },
      { v: 'flood', label: 'L2 灌流' },
    ],
    mode: 'echo',
    peerChoices: [
      { v: 'device', label: '设备回环' },
      { v: 'pc', label: 'PC 回显' },
      { v: 'keep', label: '不改' },
    ],
    peer: 'device',

    frameChoices: [20, 64, 128, 200, 512, 1024, 2048],
    frameLen: 200,
    countChoices: [10, 50, 200, 500],
    frames: 50,
    rateChoices: [0, 2000, 4000, 8000],
    rate: 0,

    runIdText: '',
    estText: '',
    cmdText: '',

    running: false,
    progress: {
      sent: 0,
      received: 0,
      duplicates: 0,
      seqGaps: 0,
      crcErrors: 0,
      elapsedMs: 0,
      settle: 'pending',
    },
    progressText: '尚未开始',
    logText: '',
    reportText: '',
    reportJson: '',
    verdict: '',
    verdictKind: '',
  },

  onLoad() {
    this._run = null;
    this._detached = false;
    this._logs = [];
    this._newRunId();
    this._refreshDerived();
  },

  onShow() {
    this._detached = false;
    this._syncState();
    if (this._run && this._run.state() !== 'done') {
      // 从别的页切回来：重新把实时状态接上
      this.setData({ running: true });
      this._onProgress(this._run.snapshot());
    }
  },

  onHide() {
    // 切 tab 不中断压测，只停止往 setData 推（页面不可见时无意义）
    this._detached = true;
  },

  onUnload() {
    this._detached = true;
    if (this._run && this._run.state() === 'running') {
      this._run.abort('page-unload');
    }
    // 页面没了仍要还原设备状态，否则 UART 页会看到数据被回环
    this._restoreLoopback();
    this._setGlobalRunning(false);
  },

  /* ---------------- 参数 ---------------- */

  _newRunId() {
    const id = Math.floor(Math.random() * 0x10000);
    this._runId = id;
    this.setData({ runIdText: '0x' + ('0000' + id.toString(16).toUpperCase()).slice(-4) });
  },

  _refreshDerived() {
    const frameLen = this.data.frameLen;
    const chunks = Math.max(1, Math.ceil(frameLen / CHUNK_SIZE));
    const perFrame = (chunks - 1) * CHUNK_GAP_MS;
    // 回显模式回程也要走一遍分片，估算按 2 倍；灌流按 1 倍
    const factor = this.data.mode === 'listen' ? 0 : this.data.mode === 'echo' ? 2 : 1;
    const estMs = this.data.frames * (perFrame || 1) * factor + 800;
    this.setData({
      estText: '预估 ' + (estMs / 1000).toFixed(1) + 's（按 ' + CHUNK_SIZE + 'B 分片 / ' +
        CHUNK_GAP_MS + 'ms 片间隔估算）',
      cmdText: this._buildCmd(),
    });
  },

  _buildCmd() {
    const payloadLen = Math.max(1, this.data.frameLen - P.FRAME_OVERHEAD);
    const id = this._runId;
    const base = 'python3 tools/uart_bridge.py /dev/ttyUSB1 --baud 115200';
    let cmd = '';
    if (this.data.mode === 'listen') {
      cmd = base + ' --mode flood --rate ' + (this.data.rate || 4000) +
        ' --frames ' + this.data.frames + ' --len ' + payloadLen +
        ' --run-id ' + id + ' --delay 5';
    } else if (this.data.mode === 'echo') {
      cmd = this.data.peer === 'pc'
        ? base + ' --mode echo'
        : '（设备回环：无需电脑侧脚本；若选 PC 回显则用 --mode echo）';
    } else {
      cmd = this.data.peer === 'pc'
        ? base + ' --mode echo'
        : base + ' --mode listen';
    }
    return cmd;
  },

  onPickMode(e) {
    if (this.data.running) return;
    const v = e.currentTarget.dataset.v;
    if (v === this.data.mode) return;
    // L0 只收没有本机发送量，帧数/速率由对端决定，这里保留参数仅供命令生成
    this.setData({ mode: v });
    this._refreshDerived();
  },

  onPickPeer(e) {
    if (this.data.running) return;
    this.setData({ peer: e.currentTarget.dataset.v });
    this._refreshDerived();
  },

  onPickFrame(e) {
    if (this.data.running) return;
    this.setData({ frameLen: Number(e.currentTarget.dataset.v) });
    this._refreshDerived();
  },

  onPickCount(e) {
    if (this.data.running) return;
    this.setData({ frames: Number(e.currentTarget.dataset.v) });
    this._refreshDerived();
  },

  onPickRate(e) {
    if (this.data.running) return;
    this.setData({ rate: Number(e.currentTarget.dataset.v) });
    this._refreshDerived();
  },

  onNewRunId() {
    if (this.data.running) return;
    this._newRunId();
    this._refreshDerived();
  },

  onCopyCmd() {
    if (!this.data.cmdText) return;
    wx.setClipboardData({
      data: this.data.cmdText,
      success: () => wx.showToast({ title: '命令已复制', icon: 'none' }),
    });
  },

  /* ---------------- 设备回环状态守卫 ---------------- */

  async _readLoopback() {
    try {
      const r = await protocol.configGet(['data']);
      const d = (r && r.data) || {};
      if (typeof d.loopback === 'boolean') return d.loopback;
      if (d.loopback && typeof d.loopback.enabled === 'boolean') return d.loopback.enabled;
      return null;
    } catch (e) {
      return null;
    }
  },

  /** 记录当轮 UART 波特率，报告里要能复现配置 */
  async _readBaud() {
    try {
      const r = await protocol.configGet(['uart']);
      const u = (r && r.uart) || {};
      return u.baud_rate || u.baud || 115200;
    } catch (e) {
      return 115200;
    }
  },

  /** 记录改前值；改不了就直接放弃自动切换，避免压测结论建立在错误链路上 */
  async _applyLoopback() {
    const peer = this.data.peer;
    this._loopbackOriginal = null;
    this._loopbackTouched = false;
    if (peer === 'keep') return { ok: true, note: '未改动设备回环' };

    const original = await this._readLoopback();
    this._loopbackOriginal = original;
    const want = peer === 'device';
    try {
      await protocol.dataLoopback(want);
      this._loopbackTouched = true;
      return { ok: true, note: '回环已设为 ' + (want ? 'on' : 'off') };
    } catch (e) {
      return { ok: false, note: '回环设置失败：' + describe(e).text };
    }
  },

  async _restoreLoopback() {
    if (!this._loopbackTouched) return '未改动';
    const target = this._loopbackOriginal;
    try {
      if (target === null || target === undefined) {
        // 读不到原值：保守地关掉，避免残留回环污染 UART 数据面
        await protocol.dataLoopback(false);
        return '已还原（原值未知→off）';
      }
      await protocol.dataLoopback(!!target);
      return '已还原为 ' + (target ? 'on' : 'off');
    } catch (e) {
      return '还原失败：' + describe(e).text;
    } finally {
      this._loopbackTouched = false;
    }
  },

  /* ---------------- io ---------------- */

  _makeIo() {
    const self = this;
    return {
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      isConnected: () => !!ble.connected,
      meta: () => {
        const env = ble.envInfo ? ble.envInfo() : {};
        return {
          deviceName: ble.deviceName || self.data.deviceName || '',
          deviceId: ble.deviceId || self.data.deviceId || '',
          fw: env.fw || env.firmware || '',
          mtu: env.mtu || 0,
          chunk: CHUNK_SIZE,
          peer: self.data.peer,
          loopback: self.data.peer === 'device' ? 'on' : self.data.peer === 'pc' ? 'off' : 'unchanged',
          uartBaud: self._baud || 115200,
        };
      },
      subscribe: (cb) => {
        ble.on('data', cb);
        return () => ble.off('data', cb);
      },
      write: async (bytes) => {
        const t = Date.now();
        try {
          await ble.write('DATA_RX', bytes);
          return { ok: true, ms: Date.now() - t };
        } catch (e) {
          return { ok: false, ms: Date.now() - t, error: describe(e).text };
        }
      },
    };
  },

  /* ---------------- 运行 ---------------- */

  _setGlobalRunning(v) {
    try {
      const app = typeof getApp === 'function' ? getApp() : null;
      if (app && app.globalData) app.globalData.stressRunning = !!v;
    } catch (e) {
      /* ignore */
    }
  },

  _onProgress(s) {
    if (this._detached) return;
    this.setData({
      progress: {
        sent: s.sent,
        received: s.received,
        duplicates: s.duplicates,
        seqGaps: s.seqGaps,
        crcErrors: s.crcErrors,
        elapsedMs: s.elapsedMs,
        settle: s.settle,
      },
      progressText: s.sent + '/' + s.planned + ' 发 · ' + s.received + ' 收 · 缺 ' + s.seqGaps +
        ' · CRC ' + s.crcErrors + ' · ' + (s.elapsedMs / 1000).toFixed(1) + 's',
    });
  },

  _log(line) {
    const t = new Date();
    const ts = ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2) +
      ':' + ('0' + t.getSeconds()).slice(-2);
    this._logs.push('[' + ts + '] ' + line);
    if (this._logs.length > 8) this._logs.shift();
    if (!this._detached) this.setData({ logText: this._logs.join('\n') });
  },

  async onStart() {
    if (this.data.running || this._anyRunning()) return;

    // 波形前置检查：帧数×帧长 与 data_pipe 深度的关系，提前提示可能的丢帧
    const link = await this._autoLink();
    if (!link.ok) return;

    const lb = await this._applyLoopback();
    this._log(lb.note);
    if (!lb.ok && this.data.peer !== 'keep') {
      wx.showModal({ title: '回环设置失败', content: lb.note + '\n\n压测已取消。', showCancel: false });
      return;
    }

    this._baud = await this._readBaud();

    const payloadLen = Math.max(0, this.data.frameLen - P.FRAME_OVERHEAD);
    const cfg = {
      mode: this.data.mode,
      frames: this.data.frames,
      payloadLen: payloadLen,
      rate: this.data.rate,
      runId: this._runId,
      label: this.data.mode + '/' + this.data.peer,
    };

    this._logs = [];
    this.setData({
      running: true,
      busy: true,
      reportText: '',
      reportJson: '',
      verdict: '',
      verdictKind: '',
      progress: { sent: 0, received: 0, duplicates: 0, seqGaps: 0, crcErrors: 0, elapsedMs: 0, settle: 'pending' },
      progressText: '启动中…',
    });
    this._setGlobalRunning(true);

    const run = S.createRun(cfg, this._makeIo(), {
      onProgress: (s) => this._onProgress(s),
      onLog: (l) => this._log(l),
    });
    this._run = run;

    let rep = null;
    try {
      rep = await run.start();
    } catch (e) {
      this._log('压测异常：' + describe(e).text);
    }

    const restoreNote = await this._restoreLoopback();
    this._log(restoreNote);
    this._setGlobalRunning(false);

    if (!rep) {
      this.setData({ running: false, busy: false, progressText: '压测异常结束' });
      this._syncState();
      return;
    }

    rep.loopbackNote = restoreNote;
    const text = this._formatReport(rep);
    this.setData({
      running: false,
      busy: false,
      reportText: text,
      reportJson: JSON.stringify(rep),
      verdict: rep.verdict,
      verdictKind: rep.verdict === 'PASS' ? 'ok' : rep.verdict === 'FAIL' ? 'fail' : 'warn',
      progressText: '完成 · ' + rep.verdict,
    });
    this._syncBusy();
    this._syncState();

    store.save('stress', {
      verdict: rep.verdict,
      sent: rep.frames.sent,
      received: rep.frames.receivedUnique,
      seqGaps: rep.frames.seqGaps,
      crcErrors: rep.parser.crcErrors,
      mode: rep.mode,
    });

    wx.showToast({ title: '压测完成：' + rep.verdict, icon: 'none' });
  },

  onAbort() {
    if (this._run && this._run.state() === 'running') {
      this._run.abort('user');
      this.setData({ progressText: '正在中止…' });
    }
  },

  onCopyReport() {
    if (!this.data.reportText) {
      wx.showToast({ title: '先跑一次压测', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: this.data.reportText,
      success: () => wx.showToast({ title: '报告已复制', icon: 'none' }),
    });
  },

  onCopyJson() {
    if (!this.data.reportJson) {
      wx.showToast({ title: '先跑一次压测', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: this.data.reportJson,
      success: () => wx.showToast({ title: 'JSON 已复制', icon: 'none' }),
    });
  },

  /* ---------------- 报告 ---------------- */

  _formatReport(r) {
    const L = [];
    const pad = (k, v) => L.push('  ' + k + '：' + v);
    L.push('== 传输压测报告 v' + r.version + ' ==');
    L.push('时间 ' + new Date(r.startedAt).toLocaleString());
    L.push('');
    L.push('[配置]');
    pad('模式', r.mode + ' / 对端 ' + (r.link.peer || '-'));
    pad('runId', '0x' + ('0000' + r.runId.toString(16).toUpperCase()).slice(-4));
    pad('帧', r.config.frames + ' 帧 × ' + r.config.frameLen + 'B（载荷 ' + r.config.payloadLen + 'B）');
    pad('目标速率', r.config.rate ? r.config.rate + ' B/s' : '不限速');
    pad('耗时', (r.elapsedMs / 1000).toFixed(2) + 's');

    L.push('[链路]');
    pad('设备', (r.link.deviceName || '-') + (r.link.fw ? ' / fw ' + r.link.fw : ''));
    pad('MTU / 分片', (r.link.mtu || 0) + ' / ' + (r.link.chunk || 20) + 'B');
    pad('回环', r.link.loopback || '-');
    pad('UART', (r.link.uartBaud || 115200) + ' 8N1');

    L.push('[分层字节账] 四层独立，不要相减');
    pad('计划 planned', r.ledger.plannedBytes + 'B');
    pad('提交 submitted', r.ledger.submittedBytes + 'B');
    pad('设备收 deviceRx', r.ledger.deviceRxBytes === null ? 'n/a（需设备日志/回显旁证）' : r.ledger.deviceRxBytes + 'B');
    pad('串口出 uartOut', r.ledger.uartOutBytes === null ? 'n/a（需 PC 汇总行）' : r.ledger.uartOutBytes + 'B');

    L.push('[帧计数]');
    pad('sent', r.frames.sent + ' / ' + r.frames.planned + '（写失败 ' + r.frames.sendErrors + '）');
    pad('received', r.frames.receivedUnique + '（原始 ' + r.frames.received + '，重复 ' + r.frames.duplicates + '）');
    pad('seqGaps', r.frames.seqGaps + (r.missing.firstSeqs.length ? '（首几个 ' + r.missing.firstSeqs.join(',') + '）' : ''));
    pad('乱序 / 越界', r.frames.outOfOrder + ' / ' + r.frames.outOfRange);
    pad('内容不一致', r.frames.payloadMismatch);
    pad('控制帧', 'START ' + r.frames.startSeen + ' · END ' + r.frames.endSeen +
      (r.frames.endSent >= 0 ? '（sent=' + r.frames.endSent + '）' : '') +
      (r.frames.staleControl ? ' · 串轮丢弃 ' + r.frames.staleControl : ''));

    L.push('[解析层]');
    pad('CRC 错', r.parser.crcErrors);
    pad('resync / trunc', r.parser.resyncBytes + 'B / ' + r.parser.truncBytes + 'B');
    pad('oversize / unknownType', r.parser.oversize + ' / ' + r.parser.unknownType);

    L.push('[时序]');
    pad('收尾', r.settle);
    pad('goodput', r.timing.goodputBps === null ? '数据不足' : r.timing.goodputBps + ' B/s');
    pad('submit', r.timing.submitBps === null ? '数据不足' : r.timing.submitBps + ' B/s');
    if (r.timing.rtt.n) {
      pad('RTT', 'n=' + r.timing.rtt.n + ' min ' + r.timing.rtt.min + ' / p50 ' + r.timing.rtt.p50 +
        ' / p95 ' + r.timing.rtt.p95 + ' / max ' + r.timing.rtt.max + ' ms');
    }

    L.push('[判定] ' + r.verdict);
    r.reasons.forEach((x) => L.push('  · ' + x));
    if (r.loopbackNote) L.push('[状态还原] ' + r.loopbackNote);
    return L.join('\n');
  },
}));
