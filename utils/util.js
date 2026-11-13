/** 杂项工具 */

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms > 0 ? ms : 0);
  });
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

function stamp(date) {
  const d = date || new Date();
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) +
    '.' + String(d.getMilliseconds()).padStart(3, '0');
}

/** 协议要求的幂等键：新事务必须换新 key */
function newIdempotencyKey() {
  const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return 'prov-' + Date.now() + '-' + rand;
}

/** Wi-Fi auth mode -> 展示文案（数值取自 ESP-IDF wifi_auth_mode_t） */
const AUTH_TEXT = {
  0: '开放',
  1: 'WEP',
  2: 'WPA',
  3: 'WPA2',
  4: 'WPA/WPA2',
  5: 'WPA2-企业',
  6: 'WPA3',
  7: 'WPA2/WPA3',
  8: 'WAPI',
};

function authText(auth) {
  if (auth === undefined || auth === null) return '';
  return AUTH_TEXT[auth] || ('AUTH ' + auth);
}

/** 企业/WPA3 需要设备侧支持，给出提示而不是直接拦 */
function authNeedsAttention(auth) {
  return auth === 5 || auth === 6 || auth === 7 || auth === 8;
}

/** RSSI -> 0~4 格 */
function rssiBars(rssi) {
  if (typeof rssi !== 'number') return 0;
  if (rssi >= -55) return 4;
  if (rssi >= -67) return 3;
  if (rssi >= -78) return 2;
  if (rssi >= -88) return 1;
  return 0;
}

function rssiText(rssi) {
  if (typeof rssi !== 'number') return '--';
  return rssi + ' dBm';
}

/** 128-bit UUID -> 便于肉眼核对的后 4 位，如 6e400005-… -> 0005 */
function shortUuid(uuid) {
  const s = String(uuid || '');
  const parts = s.split('-');
  if (parts.length === 5) return parts[0].slice(-4).toUpperCase();
  return s.slice(0, 8);
}

/** 服务 UUID 短形态，如 6e400001-… -> 6E400001 */
function shortService(uuid) {
  return String(uuid || '').split('-')[0].toUpperCase();
}

module.exports = {
  sleep,
  stamp,
  newIdempotencyKey,
  authText,
  authNeedsAttention,
  rssiBars,
  rssiText,
  shortUuid,
  shortService,
};
