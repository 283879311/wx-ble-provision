/**
 * 长期登录凭据存取（2026-11-06 改策：勾选「记住密码」才保存）。
 *
 * 策略：
 *  - 设备页登录表单带「记住密码」开关：勾选时登录成功 → save()（覆盖式），
 *    连接后自动登录直接用存档；取消勾选时登录成功 → clear()（删除旧存档）；
 *  - 未保存时表单预填出厂默认账号（admin/123456）；保存过时预填保存值；
 *  - 兼容 2026-10-29 旧策略（登录成功即记住）的存量记录：无需迁移，
 *    存档存在即视为「已勾选」，用户取消勾选并登录一次后自然清除；
 *  - 凭据只存本机 storage，不进日志、不进报告。
 *
 * 与 autoconnect 的 TARGET_STORAGE_KEY 同一套守卫写法：Node 自测环境无 wx 时全部
 * 返回空/静默，不抛错。
 */
const KEY = 'iothub_saved_credentials_v1';

function readRaw() {
  try {
    if (typeof wx !== 'undefined' && typeof wx.getStorageSync === 'function') {
      const v = wx.getStorageSync(KEY);
      if (v && v.username) {
        return { username: String(v.username), password: String(v.password || '') };
      }
    }
  } catch (e) {
    /* 存储不可用视为未保存 */
  }
  return null;
}

/** 读取保存过的凭据；没有返回 null */
function loadSaved() {
  return readRaw();
}

/** 是否保存过长期凭据 */
function hasSaved() {
  return !!readRaw();
}

/** 保存长期凭据（登录成功时由页面调用，覆盖式） */
function save(username, password) {
  try {
    if (typeof wx !== 'undefined' && typeof wx.setStorageSync === 'function') {
      wx.setStorageSync(KEY, { username: String(username || ''), password: String(password || '') });
    }
  } catch (e) {
    /* 存储不可用时静默：本次会话内存凭据仍可用 */
  }
}

/** 清除长期凭据（取消勾选后再次登录成功、或需要作废时调用） */
function clear() {
  try {
    if (typeof wx !== 'undefined' && typeof wx.removeStorageSync === 'function') {
      wx.removeStorageSync(KEY);
    }
  } catch (e) {
    /* ignore */
  }
}

module.exports = { loadSaved, hasSaved, save, clear };
