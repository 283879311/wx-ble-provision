/**
 * T5 · 长稳韧性（自 pages/accept 迁出，**逻辑未改**），M1 终态槽取证一并归入。
 */
const { ble, protocol } = require('../../utils/session');
const { DEFAULT_USERNAME } = require('../../utils/config');
const { describe } = require('../../utils/errors');
const { stamp } = require('../../utils/util');
const BleManager = require('../../utils/ble');
const { runT5, slotProbe, renderReport, renderProbeReport } = require('../../utils/t5runner');
const pwstore = require('../../utils/pwstore');
const core = require('../../utils/accept-core');
const store = require('../../utils/accept-store');

const SCEN_SHORT = {
  'tryconnect-cancel': 'A试连取消',
  'designed-failure': 'B设计失败',
  'apply': 'C成功apply',
  'relink': 'D断连重登',
};

Page(Object.assign({}, core.shared, {
  data: {
    ready: false,
    loggedIn: false,
    linking: false,
    linkText: '',
    busy: false,
    defaultUser: DEFAULT_USERNAME,
    deviceId: '',
    deviceName: '',
    sessionId: 0,
    /* T5 */
    t5Running: false,
    probing: false,
    rounds: 50,
    roundChoices: [10, 50, 100],
    set: 'mixed',
    setChoices: [
      { v: 'mixed', label: '混合场景' },
      { v: 'failure', label: '失败场景' },
      { v: 'connect', label: '连接场景' },
      { v: 'apply', label: '配网场景' },
    ],
    pacing: 'serial',
    pacingChoices: ['serial', 'compact'],
    targetSsid: '',
    targetPassword: '',
    wrongPassword: 'wrong-pass-t5',
    records: [],
    t5Summary: { pass: 0, expected: 0, fail: 0, other: 0 },
    summaryText: '',
    reportText: '',
    probeText: '',
    progressText: '',
    scrollTo: '',
  },

  onLoad() {},

  onShow() {
    this._syncState();
    if (this.data.ready && this.data.loggedIn) {
      this.prefillTarget();
    }
  },

  /** 结果摘要回写 hub */
  _saveSummary() {
    const s = this.data.t5Summary || {};
    store.save('t5', {
      pass: s.pass || 0,
      expected: s.expected || 0,
      fail: s.fail || 0,
      other: s.other || 0,
      verdict: (s.fail ? '不可签收：' + s.fail + ' 轮失败' : '无失败轮'),
      verdictKind: s.fail ? 'fail' : 'ok',
    });
  },


  /* 预填目标 = 当前正式 SSID；口令优先本地记忆 */
  async prefillTarget() {
    try {
      const cfg = await protocol.configGet(['network']);
      const formal = String((cfg && cfg.network && cfg.network.sta_ssid) || '').trim();
      if (formal && !this.data.targetSsid) {
        this.setData({
          targetSsid: formal,
          targetPassword: this.data.targetPassword || pwstore.lookup(formal),
        });
      }
    } catch (e) {
      /* 读不到就不预填，用户手填 */
    }
  },

  onPickRounds(e) {
    if (!this.data.t5Running) this.setData({ rounds: parseInt(e.currentTarget.dataset.v, 10) });
  },
  onPickSet(e) {
    if (!this.data.t5Running) this.setData({ set: e.currentTarget.dataset.v });
  },
  onPickPacing(e) {
    if (!this.data.t5Running) this.setData({ pacing: e.currentTarget.dataset.v });
  },
  onTargetSsid(e) { this.setData({ targetSsid: e.detail.value }); },
  onTargetPassword(e) { this.setData({ targetPassword: e.detail.value }); },
  onWrongPassword(e) { this.setData({ wrongPassword: e.detail.value }); },

  /* ---------------- M1 取证 ---------------- */

  async onSlotProbe() {
    if (this._anyRunning()) return;
    this.setData({ probing: true, probeText: '' });
    this._syncBusy();
    try {
      const probe = await slotProbe({ ble: ble, protocol: protocol }, {
        onEvent: (e) => {
          if (e.kind === 'slot-fill') this.setData({ progressText: 'M1：占槽 ' + e.i + '/4' });
          if (e.kind === 'slot-fifth') this.setData({ progressText: 'M1：发起第 5 个操作' });
        },
      });
      const text = renderProbeReport(probe, { deviceName: ble.deviceName, deviceId: ble.deviceId });
      this.setData({ probeText: text, progressText: '' });
      wx.setClipboardData({
        data: text,
        success: () => wx.showToast({ title: '取证报告已复制', icon: 'none' }),
      });
    } catch (err) {
      const code = (err && err.code) || err.message || 'unknown';
      wx.showToast({ title: '取证失败：' + code, icon: 'none' });
    } finally {
      this.setData({ probing: false });
      this._syncBusy();
    }
  },

  onCopyProbe() {
    if (this.data.probeText) {
      wx.setClipboardData({ data: this.data.probeText, success: () => wx.showToast({ title: '已复制', icon: 'none' }) });
    }
  },

  /* ---------------- soak ---------------- */

  async onT5Start() {
    if (this._anyRunning()) return;
    const targetSsid = (this.data.targetSsid || '').trim();
    if (!targetSsid) {
      wx.showToast({ title: '请填目标 SSID（apply 轮需要）', icon: 'none' });
      return;
    }
    const needPassword = this.data.set === 'mixed' || this.data.set === 'connect' || this.data.set === 'apply';
    if (needPassword && (this.data.targetPassword || '').length < 8) {
      wx.showToast({ title: '目标口令至少 8 位（apply 轮需要）', icon: 'none' });
      return;
    }

    // 统一验收页：不再要求先去设备页，缺链路就地补（连接 → 登录）
    const link = await this._autoLink();
    if (!link.ok) return;

    this._abort = false;
    const setLabel = { mixed: '混合', failure: '失败', connect: '连接', apply: '配网' }[this.data.set] || this.data.set;
    this.setData({
      t5Running: true,
      records: [],
      t5Summary: { pass: 0, expected: 0, fail: 0, other: 0 },
      summaryText: '',
      reportText: '',
      progressText: setLabel + ' ' + this.data.rounds + ' 轮 · ' + (this.data.pacing === 'serial' ? '串行' : '紧凑'),
    });
    this._syncBusy();

    try {
      const run = await runT5(
        { ble: ble, protocol: protocol },
        {
          rounds: this.data.rounds,
          set: this.data.set,
          pacing: this.data.pacing,
          targetSsid: targetSsid,
          targetPassword: this.data.targetPassword,
          wrongPassword: this.data.wrongPassword || 'wrong-pass-t5',
          adminUser: protocol.credentials ? protocol.credentials.username : 'admin',
          adminPass: protocol.credentials ? protocol.credentials.password : '',
          formalSsid: targetSsid,
          profileMax: 2,
        },
        {
          isAborted: () => this._abort,
          onEvent: (e) => {
            if (e.kind === 'relink') this.setData({ progressText: '#' + e.n + ' 意外断连，补链中…' });
            if (e.kind === 'cleanup-cancel') this.setData({ progressText: '已中止，清理活动操作…' });
          },
          onRound: (rec) => {
            const records = this.data.records.concat([{
              n: rec.n,
              scenarioShort: SCEN_SHORT[rec.scenario] || rec.scenario,
              outcomeUpper: (rec.outcome || '').toUpperCase(),
              err: rec.error || '',
              ms: rec.ms,
            }]).slice(-200);
            this.setData({
              records: records,
              scrollTo: 't5-bottom',
              progressText: '第 ' + rec.n + '/' + this.data.rounds + ' 轮完成 · ' + (rec.outcome || '').toUpperCase() + (rec.error ? ' (' + rec.error + ')' : ''),
            });
          },
        }
      );

      const report = renderReport(run, {
        deviceName: ble.deviceName,
        deviceId: ble.deviceId,
        env: ble.envInfo ? ble.envInfo() : '',
      });
      const s = run.summary;
      this.setData({
        t5Running: false,
        t5Summary: {
          pass: s.pass || 0,
          expected: s.expected || 0,
          fail: s.fail || 0,
          other: (s.noSlot || 0) + (s.busy || 0) + (s.hangingOps || 0),
        },
        reportText: report,
        summaryText:
          'PASS ' + s.pass + ' · EXPECTED ' + s.expected + ' · FAIL ' + s.fail +
          (s.noSlot ? ' · no_slot=' + s.noSlot : '') +
          (s.busy ? ' · busy=' + s.busy : '') +
          (s.hangingOps ? ' · 悬挂=' + s.hangingOps : '') +
          (run.aborted ? ' · 已中止' : ''),
      });
      this._saveSummary();
      wx.setClipboardData({
        data: report,
        success: () => wx.showToast({ title: '报告已复制，可直接粘贴', icon: 'none' }),
      });
    } catch (err) {
      const code = (err && err.code) || err.message || 'unknown';
      this.setData({ t5Running: false });
      wx.showToast({ title: 'soak 异常终止：' + code, icon: 'none' });
    } finally {
      this.setData({ t5Running: false });
      this._syncBusy();
      this._syncState();
    }
  },

  onT5Abort() {
    this._abort = true;
    this.setData({ progressText: '中止中：等当前轮收尾并清理…' });
  },

  onCopyT5Report() {
    if (!this.data.reportText) {
      wx.showToast({ title: '先运行一次 soak', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: this.data.reportText,
      success: () => wx.showToast({ title: '报告已复制', icon: 'none' }),
    });
  },
}));
