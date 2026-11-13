/**
 * 自动连接（打开小程序后）：
 *
 *   上次连接过的设备在场 → 直连；
 *   上次设备缺席（广播里没出现）→ 连续计数，满 3 个扫描窗口仍缺席 → 交还页面弹窗
 *     （连当前信号最强的设备 / 取消后手动扫描选择），不再静默切走；
 *   没有记忆设备（首用）→ 维持旧行为：直连信号最强设备；
 *   上次设备在场但连接失败 → 维持旧行为：排除它后试最强（连接级失败≠缺席）。
 *
 * 缺席计数口径：统计「本窗口没有扫到目标」的窗口——包括窗口里有其它设备唯独没目标、
 * 以及窗口内一个设备都没有（后者正是设备断电后的典型形态，2026-11-06 修正：
 * 原先空窗口不计数导致断电后 3 次弹窗永远不出现）。
 * 弹窗每次缺席episode只弹一次；目标重新被扫到或任一设备连接成功即重置。
 *
 * 只负责"选设备 + 建立 GATT 链路"；发现服务/订阅/登录由页面级 _link 完成
 * （ble.connect 幂等：同一设备已连接时直接复用，不会拆线重连）。
 *
 * 边界：
 *  - 已连接 / 手动扫描进行中 / 冷却期内 / 上一次尝试未结束 → 直接跳过，不与用户抢；
 *  - 扫描窗口内没有任何 NUS 设备：无记忆设备返回 no_device；有记忆设备计入缺席
 *    计数（strongest=null，页面弹「设备可能已断电」）；
 *  - 两个候选都失败 → 返回失败原因，不循环重试（下次 onShow 冷却后可再试）。
 */

const { sleep } = require('./util');
const {
  TARGET_STORAGE_KEY,
  AUTO_CONNECT_SCAN_WINDOW_MS,
  AUTO_CONNECT_COOLDOWN_MS,
} = require('./config');

let busy = false;
let lastDoneAt = 0;

/* 记忆设备缺席计数（跨扫描窗口累计，连接成功/目标复现即重置） */
const TARGET_MISS_PROMPT_AT = 3;
let targetMisses = 0;
let missPrompted = false; // 每次缺席episode只弹一次窗，之后静默计数直到状态变化

/** 目标重新在场或任一设备连接成功后由页面调用：清缺席计数、恢复弹窗资格 */
function resetMissState() {
  targetMisses = 0;
  missPrompted = false;
}

/** 从 storage 读上次目标（不在日志/报告里出现） */
function readTarget() {
  try {
    if (typeof wx !== 'undefined' && typeof wx.getStorageSync === 'function') {
      const t = wx.getStorageSync(TARGET_STORAGE_KEY);
      if (t && (t.deviceId || t.name)) return { deviceId: t.deviceId || '', name: t.name || '' };
    }
  } catch (e) {
    /* 存储不可用时当没有上次设备 */
  }
  return null;
}

/** 收集窗口期内的广播，按 deviceId 去重（RSSI 取最强、名字取首个非空），按 RSSI 降序 */
async function collectDevices(ble, windowMs) {
  const map = {};
  const off = ble.on('devices', (list) => {
    (list || []).forEach((d) => {
      if (!d || !d.deviceId) return;
      const rssi = typeof d.RSSI === 'number' ? d.RSSI : -127;
      const name = d.name || d.localName || '';
      const cur = map[d.deviceId];
      if (!cur) {
        map[d.deviceId] = { deviceId: d.deviceId, name: name, rssi: rssi };
      } else {
        if (rssi > cur.rssi) cur.rssi = rssi;
        if (!cur.name && name) cur.name = name;
      }
    });
  });
  try {
    await sleep(windowMs);
  } finally {
    off();
  }
  const arr = Object.keys(map).map((k) => map[k]);
  arr.sort((a, b) => b.rssi - a.rssi);
  return arr;
}

/** 上次设备命中：deviceId 精确匹配，其次名字匹配 */
function findTarget(devices, target) {
  if (!target) return null;
  for (let i = 0; i < devices.length; i++) {
    const d = devices[i];
    if (target.deviceId && d.deviceId === target.deviceId) return d;
  }
  if (target.name) {
    for (let i = 0; i < devices.length; i++) {
      if (devices[i].name && devices[i].name === target.name) return devices[i];
    }
  }
  return null;
}

function strongest(devices, excludeDeviceId) {
  let best = null;
  for (let i = 0; i < devices.length; i++) {
    const d = devices[i];
    if (excludeDeviceId && d.deviceId === excludeDeviceId) continue;
    if (!best || d.rssi > best.rssi) best = d;
  }
  return best;
}

/**
 * @param {object} ble BleManager 单例（session 导出）
 * @param {object} [opts] { log(kind,text), windowMs, cooldownMs, _collect, _readTarget }
 * @returns {Promise<{ok?:boolean, skipped?:boolean, via?:string, device?:object, reason?:string, devices?:number}>}
 */
async function attemptAutoConnect(ble, opts) {
  const o = opts || {};
  const log = o.log || function () {};
  const windowMs = o.windowMs || AUTO_CONNECT_SCAN_WINDOW_MS;
  /* 显式传 0 = 无冷却（自测需要连续多窗）；用 || 会把 0 吞成默认 15s */
  const cooldownMs = o.cooldownMs !== undefined ? o.cooldownMs : AUTO_CONNECT_COOLDOWN_MS;

  // 跳过判定：这些情况不进入冷却，也不算一次尝试
  if (busy) return { skipped: true, reason: 'busy' };
  if (ble.connected) return { skipped: true, reason: 'connected' };
  if (ble.scanning) return { skipped: true, reason: 'scanning' }; // 手动扫描进行中，不抢
  if (lastDoneAt && Date.now() - lastDoneAt < cooldownMs) {
    return { skipped: true, reason: 'cooldown' };
  }

  busy = true;
  const collect = o._collect || collectDevices;
  const readT = o._readTarget || readTarget;
  try {
    if (!ble.available) {
      try {
        await ble.open();
      } catch (err) {
        return { ok: false, reason: 'adapter' };
      }
    }

    let startedScan = false;
    try {
      await ble.startScan();
      startedScan = true;
    } catch (e) {
      if (!ble.scanning) return { ok: false, reason: 'scan' };
      /* 已在扫描（少见）：复用当前窗口 */
    }

    let devices = [];
    try {
      devices = await collect(ble, windowMs);
    } finally {
      if (startedScan) {
        try {
          await ble.stopScan();
        } catch (e) {
          /* 忽略 */
        }
      }
    }
    if (!devices.length) {
      // 窗口空 + 无记忆设备（首用）：没得连，维持 no_device
      const t0 = readT();
      if (!t0) return { ok: false, reason: 'no_device', devices: 0, target: null, misses: 0 };
      // 窗口空 + 有记忆设备：设备断电后它通常是周边唯一的 NUS 设备，空窗口就是
      // "连续扫描无回应"本身——必须计数，否则 3 次弹窗永远触发不了（2026-11-06 缺陷）。
      // 空窗口返回 strongest=null，页面据此把弹窗文案切到「设备可能已断电」。
      targetMisses += 1;
      /* 弹窗触发：满 3 窗首次弹；此后每再满 3 窗（6/9/…）重新弹一次询问——
       * 设备断电可能持续很久，只弹一次会让用户错过后再也看不到提示（2026-11-06 用户反馈）。 */
      if (targetMisses >= TARGET_MISS_PROMPT_AT && (!missPrompted || targetMisses % TARGET_MISS_PROMPT_AT === 0)) {
        missPrompted = true;
        log('sys', '已连续 ' + targetMisses + ' 次扫描未发现「' + (t0.name || t0.deviceId) + '」（本窗口无任何设备广播）');
        return {
          ok: false,
          reason: 'target_missing',
          devices: 0,
          target: t0,
          misses: targetMisses,
          strongest: null,
        };
      }
      return { ok: false, reason: 'target_missed', devices: 0, target: t0, misses: targetMisses, strongest: null };
    }

    /* 候选 1：上次连接过的设备 */
    const target = readT();
    const hit = findTarget(devices, target);

    /* 记忆设备缺席：先计数，满 3 个窗口仍缺席 → 交还页面弹窗（连最强 / 手动选），
     * 不再静默切走——设备可能只是暂时离线上电，静默换设备会连到别人的设备上 */
    if (target && !hit) {
      targetMisses += 1;
      const best = strongest(devices, '');
      /* 弹窗触发：满 3 窗首次弹；此后每再满 3 窗（6/9/…）重新弹一次询问——
       * 设备断电可能持续很久，只弹一次会让用户错过后再也看不到提示（2026-11-06 用户反馈）。 */
      if (targetMisses >= TARGET_MISS_PROMPT_AT && (!missPrompted || targetMisses % TARGET_MISS_PROMPT_AT === 0)) {
        missPrompted = true;
        log('sys', '已连续 ' + targetMisses + ' 次扫描未发现「' + (target.name || target.deviceId) + '」');
        return {
          ok: false,
          reason: 'target_missing',
          devices: devices.length,
          target: target,
          misses: targetMisses,
          strongest: best,
        };
      }
      return {
        ok: false,
        reason: 'target_missed',
        devices: devices.length,
        target: target,
        misses: targetMisses,
        strongest: best,
      };
    }
    /* 2026-11-07：命中不再立刻清缺席计数——清点统一移到 connect 成功之后。
     * 否则"广播可见但连接失败"的场景每窗都从 0 重数，3 次弹窗永远凑不满。 */

    if (hit) {
      log('sys', '自动连接：尝试上次设备「' + (hit.name || hit.deviceId) + '」（' + hit.rssi + 'dBm）');
      try {
        await ble.connect(hit.deviceId, hit.name);
        resetMissState();
        return { ok: true, via: 'last', device: hit, devices: devices.length };
      } catch (e) {
        /* 2026-11-07：广播可见但连接连续失败（断电瞬间/系统扫描缓存）也是缺席证据，
         * 计入同一计数器——否则这就是用户看到的"一直重试连接断电设备、三次不弹窗"。 */
        targetMisses += 1;
        if (targetMisses >= TARGET_MISS_PROMPT_AT && (!missPrompted || targetMisses % TARGET_MISS_PROMPT_AT === 0)) {
          missPrompted = true;
          log('sys', '已连续 ' + targetMisses + ' 次尝试连接「' + (hit.name || hit.deviceId) + '」失败，交还页面弹窗');
          return {
            ok: false,
            reason: 'target_missing',
            devices: devices.length,
            target: target,
            misses: targetMisses,
            strongest: strongest(devices, hit.deviceId),
          };
        }
        log('sys', '上次设备连接失败（第 ' + targetMisses + ' 次），不自动改连其它设备');
        /* 2026-11-08 串台教训：目标「在场但连不上」时静默改连最强，正是连错设备的入口
           （21:48 手机最终在 C8E4 上跑完整轮 T4）。这里改为把候选交还页面：
           满 3 窗由 _promptFallbackDevice 弹窗征得同意后直连，用户授权才换设备。 */
        return {
          ok: false,
          reason: 'target_connect_failed',
          devices: devices.length,
          target: target,
          misses: targetMisses,
          strongest: strongest(devices, hit.deviceId),
        };
      }
    }

    /* 候选 2：信号最强的其它设备（排除刚失败的） */
    const best = strongest(devices, hit ? hit.deviceId : '');
    if (!best) return { ok: false, reason: 'no_candidate', devices: devices.length };
    log('sys', '自动连接：尝试信号最强设备「' + (best.name || best.deviceId) + '」（' + best.rssi + 'dBm）');
    try {
      await ble.connect(best.deviceId, best.name);
      resetMissState();
      return { ok: true, via: 'strongest', device: best, devices: devices.length };
    } catch (e) {
      return { ok: false, reason: 'connect_failed', devices: devices.length };
    }
  } finally {
    busy = false;
    lastDoneAt = Date.now();
  }
}

/** 仅测试用：清冷却与缺席计数（真机代码不调用） */
function _resetForTest() {
  busy = false;
  lastDoneAt = 0;
  resetMissState();
}

/** 页面观察驱动续拍决策（2026-11-07 驱动链自愈）：
 * 返回重试间隔 ms；0 = 有占用方在驱动（本页不重复拍）；-1 = 链终止。
 * 任何失败分支都必须续拍或明确终止——否则 3 窗计数停摆、断电弹窗永不出现。 */
function nextDriverRetry(r) {
  if (!r) return 5000;
  if (r.ok) return -1;
  if (r.skipped) {
    if (r.reason === 'connected') return -1;
    if (r.reason === 'busy') return 0;
    return 5000; // cooldown / scanning / 其它占用：晚点再拍
  }
  if (r.reason === 'target_missing') return -1; // 页面接管（弹窗）
  if (r.reason === 'no_device' && !r.target) return -1; // 无记忆设备：无观察对象
  if (r.reason === 'scan' || r.reason === 'adapter') return 5000; // 蓝牙/扫描异常：放宽节奏
  return 2500; // target_missed / connect_failed / no_candidate / 未知
}

module.exports = { attemptAutoConnect, resetMissState, TARGET_MISS_PROMPT_AT, nextDriverRetry, _resetForTest };
