const { ble, protocol } = require('./utils/session');

App({
  globalData: {
    bleReady: false,
    lastDeviceId: '',
    cfgTarget: '', // 跳配置中心后直达的子页标记：'net' = 网络配置（用完即清）
  },

  onLaunch() {
    // 提前打开适配器，进入设备页就能扫描
    ble
      .open()
      .then(() => {
        this.globalData.bleReady = true;
      })
      .catch((err) => {
        this.globalData.bleReady = false;
        /* 保留 errMsg：旧版只打 err.code，模拟器下拿到的就是 ble_undefined，
           连「是不是环境不支持」都判断不了（2026-11-08 日志分诊） */
        const raw = err && err.raw ? err.raw.errMsg || err.raw.message || '' : '';
        console.warn('[app] 蓝牙初始化失败', (err && err.code) || '-', raw || (err && err.message) || '');
      });

    // 链路断开时清空 token（设备侧 token 是连接级的，断连即作废）
    ble.on('disconnected', () => {
      protocol.clearSession(true);
    });
  },

  onHide() {
    ble.stopScan();
  },
});
