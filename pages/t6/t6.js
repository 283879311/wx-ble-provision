/**
 * T6 · B 镜像自动测试（netcheck 语义 / 事务窗口 / 循环压测）。
 * 逻辑在 utils/bmirror.js；本页只做环境输入（goodAp/failAp，本地记忆）+ 一键运行。
 */
const { ble, protocol } = require('../../utils/session');
const { DEFAULT_USERNAME, DEFAULT_PASSWORD } = require('../../utils/config');
const credstore = require('../../utils/credstore');
const { stamp } = require('../../utils/util');
const core = require('../../utils/accept-core');
const store = require('../../utils/accept-store');
const pwstore = require('../../utils/pwstore');
const bmirror = require('../../utils/bmirror');

const ENV_KEY = 'bmirror_env_v1';
/* 口令指纹记忆（每 SSID 一条，只存 len+FNV 前缀，不可逆）：用于回答"这次的
 * 口令和上次成功时是不是同一个值"——13:19 wrong_password 就是靠这个自证的。 */
const PWFP_KEY = 'bmirror_pwfp_v1';

function pwfpLoad() {
  try {
    const m = wx.getStorageSync(PWFP_KEY);
    return m && typeof m === 'object' ? m : {};
  } catch (e) { return {}; }
}

function pwfpSave(m) {
  try { wx.setStorageSync(PWFP_KEY, m); } catch (e) { /* 存储满/被禁忽略 */ }
}

const SUITES = [
  { v: 'readonly', label: '只读组（A4/C2/C3）', safe: true },
  { v: 'fullflow', label: '配网全流程 A1（P0）', safe: false },
  { v: 'txn', label: '事务窗口 B1/B2/A6', safe: false },
  { v: 'failpath', label: '失败轨迹 A2/A3（需不可达 AP）', safe: false },
  { v: 'concur', label: '并存压测 B4', safe: false },
  { v: 'loop', label: '循环压测 B3', safe: false },
];

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
    suites: SUITES,
    selected: { readonly: true, fullflow: true, txn: true },
    goodSsid: '',
    goodPassword: '',
    /* 口令默认明文可见（2026-11-08 用户要求）：wrong_password 只有人能看出"哪个字符错了"，
     * 掩码输入时无法自证，只能等设备判死再猜。掩码改为可选。 */
    goodPwdShow: true,
    failPwdShow: false,
    goodPwdMeta: '',
    goodPwdWarn: '',
    /* 上一轮被设备判错的口令原文留档：设备不回传口令，人只有对照"发出去的那个值"
     * 才能发现是哪个字符错。作废记忆后仍保留显示，直到本次页面卸载。 */
    lastBadPwd: '',
    lastBadPwdFp: '',
    failSsid: 'TQ2018',
    failPassword: '',
    rounds: 10,
    roundChoices: [3, 10, 20],
    running: false,
    progressText: '',
    logLines: [],
    results: [],
    summary: { pass: 0, total: 0 },
    scrollTo: '',
  },

  onLoad() {
    this._pwdSrc = '未填';
    try {
      const env = wx.getStorageSync(ENV_KEY) || {};
      if (env.goodSsid) this.setData({ goodSsid: env.goodSsid, goodPassword: env.goodPassword || '' });
      if (env.goodSsid && env.goodPassword) this._pwdSrc = '本地记忆(ENV_KEY)';
      if (env.failSsid) this.setData({ failSsid: env.failSsid, failPassword: env.failPassword || '' });
    } catch (e) { /* 本地记忆缺失不致命 */ }
    this._refreshPwdMeta();
  },

  onShow() {
    this._syncState();
    this._refreshPwdMeta();
    if (this.data.ready && this.data.loggedIn) this._prefill();
  },

  onHide() { this._saveEnv(); },
  onUnload() { this._saveEnv(); },

  /* goodAp 预填（t5 同款升级版）：
   * - SSID 以设备当前正式 SSID 为准（换设备自动跟上，旧密码不残留）；
   * - 口令优先级：手填 > 本地环境记忆(ENV_KEY) > pwstore 设备记忆；空了就查，不再整体短路。 */
  async _prefill() {
    try {
      const cfg = await protocol.configGet(['network']);
      const formal = String((cfg && cfg.network && cfg.network.sta_ssid) || '').trim();
      const patch = {};
      const ssid = formal || this.data.goodSsid;
      if (ssid && ssid !== this.data.goodSsid) {
        patch.goodSsid = ssid;
        patch.goodPassword = pwstore.lookup(ssid) || '';
        if (patch.goodPassword) this._pwdSrc = '设备记忆(pwstore)';
      } else if (ssid && !this.data.goodPassword) {
        const pw = pwstore.lookup(ssid);
        if (pw) {
          patch.goodPassword = pw;
          this._pwdSrc = '设备记忆(pwstore)';
        }
      }
      if (this.data.failSsid && !this.data.failPassword) {
        const fpw = pwstore.lookup(this.data.failSsid);
        if (fpw) patch.failPassword = fpw;
      }
      if (Object.keys(patch).length) {
        this.setData(patch);
        this._saveEnv();
      }
      this._refreshPwdMeta();
    } catch (e) { /* 读不到就手填 */ }
  },

  _saveEnv() {
    try {
      wx.setStorageSync(ENV_KEY, {
        goodSsid: this.data.goodSsid,
        goodPassword: this.data.goodPassword,
        failSsid: this.data.failSsid,
        failPassword: this.data.failPassword,
      });
    } catch (e) { /* 存不上不影响运行 */ }
  },

  /* 上次"成功"时该 SSID 的口令指纹（只存 len+FNV8，不可逆）。用于页面即时提示
   * "你现在框里的值和上次连通过的不是一个"——13:19 wrong_password 就是值被改过。 */
  _prevFp(ssid) {
    if (!ssid) return '';
    try { return String(pwfpLoad()[ssid] || ''); } catch (e) { return ''; }
  },

  /* 口令可见化配套：明文框下面实时显示 长度 / 指纹 / 来源 / 与上次成功是否同值 / 卫生告警。
   * 设备不回传口令，"值对不对"只能靠人看 + 指纹比对，页面必须当场给出来。 */
  _refreshPwdMeta() {
    const pw = String(this.data.goodPassword || '');
    const src = this._pwdSrc || '未填';
    if (!pw) {
      this.setData({
        goodPwdMeta: '未填写（长度 0，设备必判口令错误）· 来源 ' + src,
        goodPwdWarn: '',
      });
      return;
    }
    const fpFull = bmirror.pwdFp ? bmirror.pwdFp(pw) : '';
    const fp = String(fpFull).replace(/^len=\d+\/fp=/, '');
    const prev = this._prevFp(this.data.goodSsid);
    let meta = '长度 ' + pw.length + ' · 指纹 ' + fp + ' · 来源 ' + src;
    if (prev && prev !== fpFull) meta += ' · ⚠ 与上次成功时不同（上次 ' + prev + '）';
    const hy = bmirror.pwdHygiene ? bmirror.pwdHygiene(pw) : [];
    this.setData({ goodPwdMeta: meta, goodPwdWarn: hy.join('；') });
  },

  onToggleGoodPwd() { this.setData({ goodPwdShow: !this.data.goodPwdShow }); },
  onToggleFailPwd() { this.setData({ failPwdShow: !this.data.failPwdShow }); },

  /* 设备判 wrong_password 时的页面处置（独立方法，便于 _verify/page-t6-selftest.js 直接回归）：
   * 清空输入框防旧值回填、切明文让人看清刚发的值、留档原文+指纹以便"对照着改"、来源标已作废。 */
  _onPwdRejected(ssid) {
    try { pwstore.forget(ssid); } catch (e) { /* 存储不可用忽略 */ }
    const bad = String(this.data.goodPassword || '');
    const badFp = bmirror.pwdFp ? bmirror.pwdFp(bad) : '';
    this._pwdSrc = '已作废(待重填)';
    this.setData({
      goodPassword: '',
      goodPwdShow: true,
      lastBadPwd: bad,
      lastBadPwdFp: String(badFp).replace(/^len=\d+\/fp=/, ''),
    });
    this._saveEnv();
    this._refreshPwdMeta();
    this._appendLog('⚠ 口令被设备判定错误，已清空 T6 页口令并作废本地记忆（' + ssid +
      '）；请重新输入正确口令后重跑（不要沿用上一次的值）。');
    try { wx.showToast({ title: '口令错误，已清空', icon: 'none' }); } catch (e) { /* ignore */ }
  },

  _appendLog(text) {
    const lines = this.data.logLines.concat(stamp() + ' ' + text);
    const cut = lines.length > 400 ? lines.slice(lines.length - 400) : lines;
    this.setData({ logLines: cut, scrollTo: 'L' + cut.length });
  },

  onToggleSuite(e) {
    const v = e.currentTarget.dataset.v;
    if (this.data.running) return;
    const sel = Object.assign({}, this.data.selected);
    sel[v] = !sel[v];
    this.setData({ selected: sel });
  },
  onPickRounds(e) {
    if (this.data.running) return;
    this.setData({ rounds: parseInt(e.currentTarget.dataset.v, 10) || 10 });
  },
  onGoodSsid(e) {
    this.setData({ goodSsid: e.detail.value });
    this._saveEnv();
    this._refreshPwdMeta();
  },
  onGoodPassword(e) {
    this._pwdSrc = '手填';
    this.setData({ goodPassword: e.detail.value });
    this._saveEnv();
    this._refreshPwdMeta();
  },
  onFailSsid(e) { this.setData({ failSsid: e.detail.value }); this._saveEnv(); },
  onFailPassword(e) { this.setData({ failPassword: e.detail.value }); this._saveEnv(); },

  async onRun() {
    if (this._anyRunning()) return;
    const toRun = SUITES.filter((s) => this.data.selected[s.v]).map((s) => s.v);
    if (!toRun.length) {
      wx.showToast({ title: '先勾选套件', icon: 'none' });
      return;
    }
    this._saveEnv();
    this.setData({ running: true, logLines: [], results: [], progressText: '准备…' });
    this._syncBusy();
    const io = {
      proc: protocol,
      env: {
        goodAp: { ssid: this.data.goodSsid, password: this.data.goodPassword },
        failAp: { ssid: this.data.failSsid, password: this.data.failPassword },
        rounds: this.data.rounds,
      },
      log: (t) => this._appendLog(t),
      /* 设备身份（bmirror 每套件开头打一行，防"连错设备/镜像"静默发生） */
      deviceLabel: () => {
        const id = String(ble.deviceId || this.data.deviceId || '?');
        return (ble.deviceName || this.data.deviceName || '?') + '/' + id.slice(-5);
      },
      /* A6 用：断链前后的设备名对比（双机并存时 relink 可能降级连到另一台） */
      currentDeviceName: () => ble.deviceName || this.data.deviceName || '',
      /* 协议层收发计数（bmirror 用它监视"未匹配响应"=残留/迟到帧，判 failed 是否陈旧应答） */
      stats: () => (protocol && protocol.stats) || {},
      /* 链路层计数（2026-11-08 09:35 三轮静默事故：判"设备不响应"还是"链路半开/ack 丢失"
       * 只能说靠断链数、重组残留、connected 这三个量） */
      bleStats: () => (ble && ble.stats) || {},
      /* 口令来源/指纹（2026-11-08 十三轮）：wrong_password 时靠这三样自证
       * "值被改过 / 从旧记忆回填 / 含脏字符"，不必等串口 reason=15。 */
      pwdSource: () => this._pwdSrc || '未标注',
      pwdFpRecall: (ssid) => {
        const m = pwfpLoad();
        return (ssid && m[ssid]) || '';
      },
      pwdFpRecord: (ssid, fp) => {
        if (!ssid || !fp) return;
        const m = pwfpLoad();
        m[ssid] = fp;
        pwfpSave(m);
      },
      /* 设备判 wrong_password 时：作废本地记忆并清空输入框，避免旧值被无限回填、
       * 也避免连续 4WAY 失败触发 AP 侧锁 MAC。实现见 _onPwdRejected。 */
      onPwdRejected: (ssid) => this._onPwdRejected(ssid),
      /* A6 用：断开当前 BLE 链路（不封 autoconnect）→ 由 relink 恢复。
       * 2026-11-07 二跑教训：旧实现 protocol.login()/link.ensureLink() 均无参调用
       * （login 必拒 invalid_argument，ensureLink 缺 ble 参数直接 TypeError），
       * 且 catch 静默吞错 → 3 次空转恒失败。修复：ensureLink 带目标+凭据
       * （accept-core 同款优先级：保存的凭据 → 出厂默认），失败带证据返回。 */
      dropLink: async () => {
        try { await ble.disconnect(); } catch (e) { /* 已断也当成功 */ }
      },
      relink: async () => {
        const link = require('../../utils/link');
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        let creds = null;
        try {
          const saved = credstore.loadSaved();
          if (saved && saved.username) creds = { username: saved.username, password: saved.password };
        } catch (e) { /* 读不到用默认 */ }
        if (!creds) creds = { username: DEFAULT_USERNAME, password: DEFAULT_PASSWORD };
        let lastErr = '';
        for (let i = 0; i < 3; i++) {
          try {
            const r = await link.ensureLink(ble, protocol, {
              target: this._target(),
              username: creds.username,
              password: creds.password,
            });
            if (r && r.ok) return { ok: true, ms: r.ms, deviceName: r.deviceName || '' };
            lastErr = (r && (r.error || r.code)) || '未知原因(stage=' + (r && r.stage) + ')';
          } catch (e) {
            lastErr = (e && e.message) || String(e);
          }
          if (i < 2) await wait(2000);
        }
        const s = ble.stats || {};
        return {
          ok: false,
          detail: '重连3次全败(末次=' + lastErr + ') scanFailures=' + (s.scanFailures || 0) +
            ' lastScanError=' + (s.lastScanError || '无'),
        };
      },
    };
    const runner = bmirror.mkRunner(io);
    let last = null;
    try {
      for (const s of toRun) {
        this.setData({ progressText: '运行 ' + s + '…' });
        last = await runner.run(s);
      }
    } catch (e) {
      this._appendLog('运行器异常：' + ((e && e.message) || e));
    }
    const recs = runner.recs;
    const pass = recs.filter((r) => r.pass).length;
    this.setData({
      running: false,
      progressText: '',
      results: recs,
      summary: { pass: pass, total: recs.length },
    });
    this._syncBusy();
    store.save('t6', {
      pass: pass,
      expected: 0,
      fail: recs.length - pass,
      other: 0,
      verdict: recs.length ? pass + '/' + recs.length + ' 通过' : '无结果',
      verdictKind: recs.length && pass === recs.length ? 'ok' : 'fail',
    });
    if (recs.length) {
      const text = 'B 镜像自动测试 ' + pass + '/' + recs.length +
        '\n' + recs.map((r) => (r.pass ? 'PASS' : 'FAIL') + ' [' + r.id + '] ' + r.name +
          (r.detail ? ' — ' + r.detail : '')).join('\n');
      wx.setClipboardData({
        data: text,
        success: () => wx.showToast({ title: '报告已复制', icon: 'none' }),
      });
    }
  },

  onCopyLog() {
    const lines = this.data.logLines || [];
    if (!lines.length) return;
    wx.setClipboardData({
      data: lines.join('\n'),
      success: () => wx.showToast({ title: '日志已复制', icon: 'none' }),
    });
  },
}));
