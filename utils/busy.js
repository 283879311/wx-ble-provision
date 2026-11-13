/**
 * 跨页互斥标志：配网（tryconnect→apply）或 profile 清理进行中时，
 * 其它配置页（如 MQTT 保存）应暂缓写操作。
 * 配置拆成独立页后，运行状态不再同页可见，用模块级单例传递。
 */
let netBusy = false;

module.exports = {
  isBusy() {
    return netBusy;
  },
  setBusy(v) {
    netBusy = !!v;
  },
};
