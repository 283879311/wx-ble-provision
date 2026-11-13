/**
 * 验收中心共享逻辑：链路状态、自动连接/登录、报告元信息、页面返回。
 *
 * 为什么单独抽一层：T4 / T5 / 压测三个子页都要「断开态也能跑」——
 * 自动扫描→连接→发现→订阅→登录这套动作必须完全一致，各写一份必然
 * 在错误文案和重试策略上分叉。这里的方法用 `this` 指向页面实例，
 * 通过 Object.assign 混入 Page 配置，调用点与拆分前完全一致。
 */
const { ble, protocol } = require('./session');
const { ensureLink } = require('./link');
const { DEFAULT_USERNAME, DEFAULT_PASSWORD } = require('./config');
const credstore = require('./credstore');
const { describe } = require('./errors');
const { stamp } = require('./util');
const BleManager = require('./ble');

/** 登录凭据优先级：用户保存的长期凭据 → 出厂默认（仅测试环境兜底） */
function loginArgs() {
  const saved = credstore.loadSaved();
  if (saved && saved.username) return { username: saved.username, password: saved.password };
  return { username: DEFAULT_USERNAME, password: DEFAULT_PASSWORD };
}

const shared = {
  /* A2 扫描生命周期审计：findDevice 自身会停掉自己发起的扫描（ownScan 收尾必经
   * stopScan），这里只做页面退出兜底，防 12s 窗口内用户离开留下残留扫描 */
  onHide() {
    ble.stopScan().catch(function () {});
  },

  onUnload() {
    ble.stopScan().catch(function () {});
  },

  /** 是否有任一模块在跑：跨模块互斥，防止 BLE 链路被两边同时占用 */
  _anyRunning() {
    return !!(this.data.running || this.data.t5Running || this.data.probing);
  },

  /** 统一给 wxml 用的 busy 标记（按钮禁用） */
  _syncBusy() {
    this.setData({ busy: this._anyRunning() });
  },

  /** 目标设备：当前链路 > 页面缓存 > 上次连过的记录（断连后 deviceId 会被清空） */
  _target() {
    const saved = ble.lastTarget() || {};
    return {
      deviceId: ble.deviceId || this.data.deviceId || saved.deviceId || '',
      name: ble.deviceName || this.data.deviceName || saved.name || '',
    };
  },

  _syncState() {
    const t = this._target();
    const ready = !!ble.connected;
    const loggedIn = ready && protocol.loggedIn;
    let linkText = '';
    if (!ready) {
      linkText = t.deviceId
        ? '当前未连接（上次设备 ' + (t.name || t.deviceId) + '）：T4 第 1 项可立即取证；其余项会先自动连接并登录'
        : '当前未连接：T4 第 1 项可立即取证；其余项与 T5 会先扫描发现设备，再自动连接并登录';
    } else if (!loggedIn) {
      linkText = '已连接但未登录：运行时会用默认账号（' + DEFAULT_USERNAME + '）自动登录';
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

  _ctx() {
    return {
      ble: ble,
      protocol: protocol,
      target: this._target(),
    };
  },

  /**
   * 断开状态下把链路拉起来（扫描 → 连接 → 发现 → 订阅 → 登录）。
   * 需要人工确认时才弹框，避免「一进页面就自动连」显得突兀。
   */
  async _autoLink(opts) {
    const o = opts || {};
    if (ble.connected && protocol.loggedIn && !o.force) {
      /* 内部调用（跑项前补链）：链路健康就静默返回。用户手点的「重连登录」
       * 走 force=true，永远真实重连——僵尸链路时 ble.connected 只是手机侧
       * 本地缓存，静默 no-op 在 UI 上就是"按了没反应"（2026-11-10 真机反馈）。 */
      return { ok: true, linked: true, loggedIn: true, error: '' };
    }
    if (this._linking) return { ok: false, error: '正在连接中，请稍候' };

    this._linking = true;
    this.setData({ linking: true });
    wx.showLoading({ title: o.force ? '正在重连设备' : '正在连接设备', mask: true });
    try {
      /* 强制重连：先拆旧链再走 ensureLink（扫描→连接→订阅→登录）。
       * 身份必须在 disconnect 前留档——disconnect 会清空 ble.deviceId/deviceName
       * （ble.js 同款坑，link.js P1-2 已踩过一次）。 */
      if (o.force && ble.connected) {
        const staleId = ble.deviceId || this.data.deviceId || '';
        const staleName = ble.deviceName || this.data.deviceName || '';
        try {
          await ble.disconnect();
        } catch (e2) {
          /* 本地已断则忽略，继续走扫描 */
        }
        if (staleId && !this.data.deviceId) {
          this.setData({ deviceId: staleId, deviceName: staleName });
        }
        /* 拆链后复核设备侧广播（P1-2 同款方法论）：正常断连固件 ~1s 恢复广播；
         * 等不到 = 手机栈半开（设备 conn=1 依规不广播），后面 26s 扫描注定
         * 扫不到，直接给 link_stale 指引，不烧等待预算。 */
        if (staleId || staleName) {
          const adv = await ble.waitForAdvertising(staleId, staleName, 12000);
          if (!adv.seen) {
            const msg =
              '旧链路拆掉后 ' + (adv.ms / 1000).toFixed(1) + 's 内未见设备重新广播：' +
              '手机栈半开（设备仍 conn=1，依规不广播），继续扫描也扫不到。' +
              '点「重启蓝牙恢复广播」按钮一键恢复（等价关开系统蓝牙），恢复后重试。';
            wx.showModal({ title: '连接失败', content: msg, showCancel: false });
            return { ok: false, linked: false, loggedIn: false, error: msg, code: 'link_stale' };
          }
        }
      }
      const r = await ensureLink(ble, protocol, Object.assign({ target: this._target(), scanTimeout: o.scanTimeout }, loginArgs()));
      this._syncState();
      if (r.ok) {
        wx.showToast({ title: '已连接并登录', icon: 'none' });
      } else if (!o.silent) {
        wx.showModal({
          title: r.linked ? '登录失败' : '连接失败',
          content: r.error || '未知原因',
          showCancel: false,
        });
      }
      return r;
    } catch (err) {
      const d = describe(err);
      this._syncState();
      if (!o.silent) wx.showModal({ title: '连接失败', content: d.text, showCancel: false });
      return { ok: false, linked: false, loggedIn: false, error: d.text };
    } finally {
      this._linking = false;
      wx.hideLoading();
      this.setData({ linking: false });
      this._syncState();
    }
  },

  /** 已连接但没 token：优先内存凭据，其次用户保存的长期凭据，最后出厂默认 */
  async _autoLogin() {
    if (protocol.loggedIn) return { ok: true };
    if (protocol.hasCredentials()) {
      try {
        await protocol.relogin();
        this._syncState();
        return { ok: true };
      } catch (err) {
        /* 内存凭据失效，落到下面的登录链 */
      }
    }
    const la = loginArgs();
    try {
      await protocol.login(la.username, la.password);
      this._syncState();
      return { ok: true };
    } catch (err) {
      const d = describe(err);
      this._syncState();
      return { ok: false, error: d.text, code: (err && err.code) || '' };
    }
  },

  /** 人工项的取证前置：必须已连接 + 已登录，缺哪步补哪步 */
  async _ensureForManual() {
    if (!ble.connected) {
      const link = await this._autoLink();
      if (!link.ok) return false;
    }
    if (!protocol.loggedIn) {
      const lg = await this._autoLogin();
      if (!lg.ok) {
        wx.showToast({ title: '登录失败：' + lg.error, icon: 'none' });
        return false;
      }
    }
    return true;
  },

  /** 手动触发：强制拆旧链 + 重新连接登录（不做静默 no-op，按钮必须有可感知反应） */
  async onAutoLink() {
    if (this._anyRunning()) return;
    await this._autoLink({ force: true });
  },

  /**
   * 僵尸链路逃生口：重启蓝牙适配器（等价"手机关蓝牙→开蓝牙"）。
   * 适用「订阅态僵尸链路」（2026-11-09 T4 #4 定案）：宿主栈停滞时
   * closeBLEConnection 不生效（串口 10 分钟无断链事件），只有适配器级重启
   * 能强制拆链让设备恢复广播。会断开本机所有 BLE 链路——必须经用户确认，
   * 不做任何自动触发。
   */
  onResetAdapter() {
    if (this._anyRunning() || this.data.linking) return;
    wx.showModal({
      title: '重启蓝牙适配器',
      content: '将关闭并重开本机蓝牙适配器：强制拆掉所有 BLE 链路（含无响应的僵尸链路），设备约 1s 后恢复广播，随后自动重连登录。其它正在使用的蓝牙设备也会断开。',
      confirmText: '重启适配器',
      cancelText: '取消',
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ linking: true });
        ble
          .resetAdapter()
          .then(async (r) => {
            if (!r.ok) {
              wx.showToast({ title: '适配器重启失败：' + (r.text || r.code || '未知错误'), icon: 'none' });
              return;
            }
            wx.showToast({ title: '适配器已重启', icon: 'success' });
            await this._autoLink(); // 设备 ~1s 内恢复广播，走既有连接+登录链
          })
          .catch(() => {})
          .then(() => {
            this.setData({ linking: false });
            this._syncState();
          });
      },
    });
  },

  _meta() {
    let sys = {};
    try {
      sys = wx.getSystemInfoSync() || {};
    } catch (e) {
      sys = {};
    }
    const t = this._target();
    return {
      time: stamp(),
      deviceName: ble.deviceName || t.name,
      deviceId: ble.deviceId || t.deviceId,
      /* 目标设备与「设备」取自不同来源：设备优先当前链路，目标还会回退到页面缓存/上次记录。
       * 断链后两者可能分叉（22:58 那轮 header 是 65D8、自动重连却去找 C8E4），
       * 报告头必须把它印出来，否则只能翻到第 12 项的 detail 才发现。 */
      targetName: t.name,
      targetId: t.deviceId,
      sessionId: ble.sessionId,
      chunk: BleManager.CHUNK_SIZE,
      env: ble.envInfo(),
      platform: sys.platform || '-',
      system: sys.system || sys.model || '-',
      wechat: sys.version || '-',
      firmware: protocol.lastDeviceInfoFirmware || '',
      /* 报告里一直引用 m.buildSha 却没被赋值（附页「固件…（build_sha …）」永远是空），
         顺手从 device.info 缓存补齐。 */
      buildSha: protocol.lastBuildSha || '',
      deviceIdReported: protocol.lastDeviceId || '',
      /* C：跑批起点由页面在开跑时打标；没打标就不写这段，避免把整个环形缓冲当成本批 */
      batchLog: typeof this._logMark === 'number' ? protocol.logSummary(this._logMark) : null,
      net: this._netLine || '',
    };
  },

  /** 子页返回验收中心；直接打开子页（无栈）时兜底回 tab */
  goBack() {
    wx.navigateBack({
      delta: 1,
      fail: function () {
        wx.switchTab({ url: '/pages/accept/accept' });
      },
    });
  },

  goDevice() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  goProvision() {
    const app = typeof getApp === 'function' ? getApp() : null;
    if (app && app.globalData) app.globalData.cfgTarget = 'net';
    wx.switchTab({ url: '/pages/provision/provision' });
  },
};

module.exports = { shared };
