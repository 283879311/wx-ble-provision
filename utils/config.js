/**
 * 现场默认值（只在内存里用，不写 storage、不进日志）。
 *
 * 设备出厂默认管理员账号是 admin / 123456：登录表单默认填好这两项，
 * 验收页「自动连接并运行」也会用它们自动登录，省掉断连后反复手输。
 * 真机改了密码就在设备页直接改输入框，登录成功后内存凭据以你填的为准。
 */

const DEFAULT_USERNAME = 'admin';
const DEFAULT_PASSWORD = '123456';

/** 蓝牙目标设备的记忆 key：断连后靠它找回上次连过的设备 */
const TARGET_STORAGE_KEY = 'ble.target';

/** 打开小程序后自动连接：先试上次设备，失败/缺席再试信号最强的已发现设备 */
const AUTO_CONNECT_ENABLED = true;
/** 候选发现窗口：收集 NUS 设备广播的时长（ms） */
const AUTO_CONNECT_SCAN_WINDOW_MS = 6000;
/** 自动连接冷却：两次尝试之间的最小间隔，防止反复扫描打扰 */
const AUTO_CONNECT_COOLDOWN_MS = 15000;

/** 连接态心跳：轮询 getBLEDeviceRSSI 探测链路存活（设备断电/走出范围时
 *  系统 onBLEConnectionStateChange 可能丢失或延迟，UI 不能一直显示在线） */
const DEVICE_PROBE_INTERVAL_MS = 10000;
/** 连续心跳失败多少次判定链路丢失（1 次可能是瞬态抖动） */
const DEVICE_PROBE_FAIL_LIMIT = 2;

module.exports = {
  DEFAULT_USERNAME,
  DEFAULT_PASSWORD,
  TARGET_STORAGE_KEY,
  AUTO_CONNECT_ENABLED,
  AUTO_CONNECT_SCAN_WINDOW_MS,
  AUTO_CONNECT_COOLDOWN_MS,
  DEVICE_PROBE_INTERVAL_MS,
  DEVICE_PROBE_FAIL_LIMIT,
};
