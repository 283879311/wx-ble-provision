/**
 * 验收结果摘要（跨页留存）。
 *
 * 只存计数与结论，**不存完整报告**：报告动辄几 KB，storage 单键 1MB /
 * 总量 10MB 看着够，但和配网历史、口令记忆共用，留底很快会顶到上限。
 * 完整报告仍然走「复制」到剪贴板。
 */

const KEY = 'accept_summary_v1';

function readAll() {
  try {
    const v = wx.getStorageSync(KEY);
    return v && typeof v === 'object' ? v : {};
  } catch (e) {
    return {};
  }
}

/**
 * @param {string} mod 't4' | 't5' | 'stress'
 * @param {Object} summary {pass, expected, fail, skip|other, verdict, verdictKind, ...}
 */
function save(mod, summary) {
  const all = readAll();
  all[mod] = Object.assign({}, summary, { at: Date.now() });
  try {
    wx.setStorageSync(KEY, all);
  } catch (e) {
    /* 存储满或序列化失败：摘要只是便利功能，不影响验收本身 */
  }
  return all[mod];
}

function get(mod) {
  const all = readAll();
  return all[mod] || null;
}

function readAllSafe() {
  return readAll();
}

function clear() {
  try {
    wx.removeStorageSync(KEY);
  } catch (e) {
    /* ignore */
  }
}

/** 摘要一行文案，hub 用 */
function lineOf(mod) {
  const s = get(mod);
  if (!s) return { text: '尚未运行', kind: 'idle', at: 0 };
  if (mod === 'stress') {
    const parts = [];
    if (s.verdict) parts.push(s.verdict);
    if (s.sent !== undefined) parts.push('发 ' + s.sent + ' 帧');
    if (s.received !== undefined) parts.push('收 ' + s.received + ' 帧');
    return {
      text: parts.join(' · ') || '有记录',
      kind: s.verdict === 'PASS' ? 'ok' : s.verdict === 'FAIL' ? 'fail' : 'warn',
      at: s.at || 0,
    };
  }
  const fail = s.fail || 0;
  const pass = s.pass || 0;
  const exp = s.expected || 0;
  return {
    text: pass + 'P / ' + exp + 'E / ' + fail + 'F',
    kind: fail > 0 ? 'fail' : exp > 0 ? 'warn' : pass > 0 ? 'ok' : 'idle',
    at: s.at || 0,
  };
}

module.exports = { KEY, save, get, readAll: readAllSafe, clear, lineOf };
