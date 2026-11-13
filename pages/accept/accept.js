/**
 * 验收中心（hub）：只做导航与链路状态，不再承载 T4/T5 的检查项。
 *
 * 拆页动机：原来一页塞了 15+ 张卡，T4 自身就超长，滚动定位全靠手感。
 * 现在 hub 只保留「四个入口 + 各自上次结果摘要」，具体执行在子页。
 *
 * 摘要跨页留存的关键约束：
 *   - 只存计数，不存报告全文（storage 与口令记忆共用配额）；
 *   - 子页写完摘要后，hub 的 onShow 重新读，所以从子页返回能立刻看到变化；
 *   - 压测运行中切页不中断：状态在引擎里，不在 page.data 里（globalData 标记）。
 */
const { ble, protocol } = require('../../utils/session');
const core = require('../../utils/accept-core');
const store = require('../../utils/accept-store');

const CARDS = [
  {
    key: 't4',
    title: 'T4 · 功能自检',
    desc: 'P0 主链路、配网、救援、网络诊断',
    path: '/pages/t4/t4',
  },
  {
    key: 't5',
    title: 'T5 · 长稳韧性',
    desc: 'A/B/C/D 混合长稳 + M1 终态槽取证',
    path: '/pages/t5/t5',
  },
  {
    key: 'stress',
    title: 'S · 传输压测',
    desc: 'BLE DATA / UART1 收发压测，分层记账',
    path: '/pages/stress/stress',
  },
  {
    key: 't3',
    title: 'T3 · 人工测试',
    desc: '功能自测不可自动化部分：页面级走查 / 真机环境核对',
    path: '/pages/t3/t3',
  },
  {
    key: 't6',
    title: 'T6 · B 镜像自动测试',
    desc: 'B 镜像新语义六套件：readonly/fullflow/txn/failpath/concur/loop',
    path: '/pages/t6/t6',
  },
];

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
    cards: CARDS,
    summaries: {},
    stressRunning: false,
  },

  onLoad() {},

  onShow() {
    this._syncState();
    this._loadSummaries();
    this._consumePendingModule();
    this._syncStressFlag();
  },

  /** hub 的链路文案不绑定 T4 的检查项，单独写一版 */
  _syncState() {
    const t = this._target();
    const ready = !!ble.connected;
    const loggedIn = ready && protocol.loggedIn;
    let linkText = '';
    if (!ready) {
      linkText = t.deviceId
        ? '当前未连接（上次设备 ' + (t.name || t.deviceId) + '）：进入任一子页运行时会自动扫描并连接'
        : '当前未连接：进入子页运行时会自动扫描、连接并登录';
    } else if (!loggedIn) {
      linkText = '已连接但未登录：运行时会用默认账号自动登录';
    }
    this.setData({
      ready: ready,
      loggedIn: loggedIn,
      deviceId: t.deviceId,
      deviceName: t.name,
      sessionId: ble.sessionId,
      linkText: linkText,
    });
  },

  _loadSummaries() {
    const out = {};
    CARDS.forEach(function (c) {
      out[c.key] = store.lineOf(c.key);
    });
    this.setData({ summaries: out });
  },

  _syncStressFlag() {
    let running = false;
    try {
      const app = typeof getApp === 'function' ? getApp() : null;
      running = !!(app && app.globalData && app.globalData.stressRunning);
    } catch (e) {
      running = false;
    }
    this.setData({ stressRunning: running });
  },

  /** 设备页「T5 长稳测试」入口：switchTab 不能带参，globalData 转交后立刻清空 */
  _consumePendingModule() {
    let m = '';
    try {
      const app = typeof getApp === 'function' ? getApp() : null;
      if (app && app.globalData && app.globalData.acceptModule) {
        m = app.globalData.acceptModule;
        app.globalData.acceptModule = '';
      }
    } catch (e) {
      m = '';
    }
    if (m === 't5') {
      wx.navigateTo({ url: '/pages/t5/t5' });
    } else if (m === 't4') {
      wx.navigateTo({ url: '/pages/t4/t4' });
    }
  },

  goPage(e) {
    const path = e.currentTarget.dataset.path;
    if (!path) return;
    wx.navigateTo({
      url: path,
      fail: (err) => {
        wx.showToast({
          title: '打不开：' + ((err && err.errMsg) || path),
          icon: 'none',
        });
      },
    });
  },

  onClearSummaries() {
    wx.showModal({
      title: '清除结果摘要',
      content: '只清除本页显示的计数，各子页当前结果不受影响。',
      success: (r) => {
        if (!r.confirm) return;
        store.clear();
        this._loadSummaries();
        wx.showToast({ title: '已清除', icon: 'none' });
      },
    });
  },
}));
