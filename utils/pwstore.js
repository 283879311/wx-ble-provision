/**
 * 本地口令记忆：只存「配网成功」过的 SSID 口令，再次选中该 Wi-Fi 时自动回填。
 *
 * 协议安全约束：设备侧不保存/不回传口令（operation 记录不含口令，
 * config.get 只有 sta_password_set 布尔），所以自动填密码只能靠小程序
 * 自己记住。明文存本地 storage，与微信账号隔离，不上传任何服务器；
 * wrong_password 时作废该条，避免坏口令被反复自动填入。
 *
 * Node 环境无 wx（_verify 自测 require 本文件），全部调用加 guard。
 */
const KEY = 'ble_pw_memory_v1';

function wxOk() {
  return typeof wx !== 'undefined' && wx && typeof wx.getStorageSync === 'function';
}

function load() {
  if (!wxOk()) return {};
  try {
    const m = wx.getStorageSync(KEY);
    return m && typeof m === 'object' ? m : {};
  } catch (e) {
    return {};
  }
}

function save(map) {
  if (!wxOk()) return;
  try {
    wx.setStorageSync(KEY, map);
  } catch (e) {
    /* storage 满/被禁：口令记忆是体验增强，失败静默 */
  }
}

/** 配网成功后调用；开放网络（无口令）不记 */
function remember(ssid, password) {
  if (!ssid || !password) return;
  const map = load();
  map[ssid] = { password: String(password), at: Date.now() };
  save(map);
}

/** 返回该 SSID 之前用过的口令，没有则空串 */
function lookup(ssid) {
  if (!ssid) return '';
  const rec = load()[ssid];
  return rec && rec.password ? String(rec.password) : '';
}

/** 口令被设备判定错误时作废 */
function forget(ssid) {
  if (!ssid) return;
  const map = load();
  if (map[ssid]) {
    delete map[ssid];
    save(map);
  }
}

/** 调试/设置页用：当前记住了哪些 SSID */
function list() {
  return Object.keys(load());
}

module.exports = { remember, lookup, forget, list };
