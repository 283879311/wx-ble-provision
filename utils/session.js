/** 全局单例：整个小程序共用一条 BLE 链路和一个命令会话 */

const BleManager = require('./ble');
const Protocol = require('./protocol');

const ble = new BleManager();
const protocol = new Protocol(ble);

module.exports = { ble, protocol };
