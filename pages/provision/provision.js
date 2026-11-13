const { ble, protocol } = require('../../utils/session');

/**
 * 配置中心（hub）：三个配置子页的入口。
 * - 网络配置 pages/netcfg：Wi-Fi 扫描配网、状态判读、网络诊断、profile 清理
 * - MQTT 配置 pages/mqttcfg：MQTT 服务器查询与配置
 * - BLE 配置 pages/blecfg：BLE 状态查询与判读（固件只读）
 * - UART 配置 pages/uartcfg：串口参数读写 + 收发窗口（BLE DATA 通道）
 */
Page({
  data: {
    ready: false,
    loggedIn: false,
  },

  onShow() {
    const ready = !!ble.connected;
    const loggedIn = ready && protocol.loggedIn;
    this.setData({ ready: ready, loggedIn: loggedIn });
    /* 跨页直达标记（如验收页救援流程）：进入配置中心后直接进网络配置 */
    const app = typeof getApp === 'function' ? getApp() : null;
    const target = app && app.globalData && app.globalData.cfgTarget;
    if (target) {
      app.globalData.cfgTarget = '';
      if (ready && loggedIn) {
        if (target === 'net') this._go('/pages/netcfg/netcfg');
      }
    }
  },

  goDevice() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  goNetcfg() {
    this._go('/pages/netcfg/netcfg');
  },

  goMqttcfg() {
    this._go('/pages/mqttcfg/mqttcfg');
  },

  goBlecfg() {
    this._go('/pages/blecfg/blecfg');
  },

  goUartcfg() {
    this._go('/pages/uartcfg/uartcfg');
  },

  _go(url) {
    if (!this.data.ready || !this.data.loggedIn) {
      wx.showToast({ title: '请先连接并登录设备', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: url });
  },
});
