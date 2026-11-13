/**
 * BLE 传输层（只做 GATT，不讲业务）。
 *
 * 严格遵守协议：
 *  - 扫描必须按 NUS Service UUID 过滤；
 *  - CMD RX / CMD TX 与 DATA RX / DATA TX 是两对独立特征，互不混用；
 *  - 写 CMD 必须 20B 分片、串行、等 success 回调；片间 20ms；
 *  - CMD TX 通知是字节分片，交给 JsonStreamAssembler 重组。
 *
 * 重要：特征以「实际发现结果」为准，UUID 只是提示。
 *  discover() 先按属性（write / notify）校验，必要时回退到同服务内的其它特征，
 *  并把解析依据（uuid / property / uuid-weak）暴露在 resolved 里，便于验收核对。
 */

const JsonStreamAssembler = require('./json-stream');
const { sleep } = require('./util');
const { TARGET_STORAGE_KEY } = require('./config');

const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';

/** 逻辑名 -> 协议约定的 UUID（仅作提示，不保证设备一定这么给） */
const CHAR_UUID = {
  DATA_RX: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
  DATA_TX: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
  CMD_RX: '6e400004-b5a3-f393-e0a9-e50e24dcca9e',
  CMD_TX: '6e400005-b5a3-f393-e0a9-e50e24dcca9e',
};

const CHAR_KEYS = ['CMD_RX', 'CMD_TX', 'DATA_RX', 'DATA_TX'];

/**
 * 设备名尾号：广播名 `IotHubBLE-65D8` 与 device.info 的 `device_id: IotHub-65D8`
 * 同为板卡 4 位十六进制后缀。**注意 MAC 尾号不是同源**（65D8 的 MAC 是 …65:DA，
 * 尾号 65DA），所以身份判定只能用「名字/device_id 尾号」，不能用 MAC 反推。
 * @returns {string} 大写 4 位十六进制；取不到返回 ''
 */
function nameTail(v) {
  const m = String(v === undefined || v === null ? '' : v).toUpperCase().match(/([0-9A-F]{4})$/);
  return m ? m[1] : '';
}

const CHUNK_SIZE = 20; // 验收基线：固定 20B，即使协商到更大 MTU 也不改
const CHUNK_GAP_MS = 20; // 协议建议片间 20ms
/* 单片写入兜底截止：GATT 假死/断链无事件时 writeBLECharacteristicValue 可能
 * 既不 success 也不 fail（wx 调用无超时）。不兜底的话写锁永远不释放，
 * 之后所有命令（含 auth.login）永远排队 → 登录界面永远转圈（2026-11-05 用户反馈）。
 * 正常 20B 写入 <50ms，5s 已是 100 倍余量；可用实例属性 writeChunkTimeoutMs 覆盖（自测用）。 */
const WRITE_CHUNK_TIMEOUT_MS = 5000;

/**
 * 验收基线要求「真机支持更大 MTU 也不改变当前基线」，
 * 因此默认不主动协商 MTU。设备侧通知分片按 MTU-3 走，与写分片无关。
 */
const ENABLE_MTU_NEGOTIATION = false;

const BLE_ERROR_TEXT = {
  10000: '蓝牙适配器未初始化',
  10001: '蓝牙未打开，请打开系统蓝牙后重试',
  10002: '没有找到指定设备',
  10003: '连接失败，请靠近设备重试',
  10004: '没有找到指定服务',
  10005: '没有找到指定特征值',
  10006: '当前连接已断开',
  10007: '该特征值不支持此操作',
  10008: '系统异常，请重试',
  10009: 'Android 系统版本过低（需 4.3+）',
  10012: '连接超时',
  10013: 'deviceId 为空',
};

class BleError extends Error {
  constructor(code, message, raw) {
    super(message || code);
    this.name = 'BleError';
    this.code = code;
    this.raw = raw || null;
  }
}

function lower(v) {
  return String(v || '').toLowerCase();
}

/** 给无超时的 wx 调用加截止时间：到点仍未结算就拒绝（errCode 类错误原样透传） */
function withDeadline(promise, ms, code, message) {
  return new Promise(function (resolve, reject) {
    const t = setTimeout(function () {
      reject(new BleError(code, message));
    }, ms);
    promise.then(
      function (v) { clearTimeout(t); resolve(v); },
      function (e) { clearTimeout(t); reject(e); }
    );
  });
}

/** 取运行平台。旧版只有 getSystemInfoSync（新基础库已标废弃，会刷警告），优先新接口 */
function platformOf() {
  try {
    if (typeof wx.getDeviceInfo === 'function') return String(wx.getDeviceInfo().platform || '');
  } catch (e) { /* 新接口异常时退回旧接口 */ }
  try {
    if (typeof wx.getSystemInfoSync === 'function') return String(wx.getSystemInfoSync().platform || '');
  } catch (e) { /* 无平台信息 */ }
  return '';
}

/** 微信开发者工具模拟器：platform=devtools，且**没有 BLE 适配器** */
function isDevtools() {
  return platformOf() === 'devtools';
}

/* 「这不支持」类 errMsg：模拟器/H5 渲染层最常见，此时微信往往连 errCode 都不给 */
const RE_UNSUPPORTED = /not\s*support|unsupported|not\s*available|不支持|无法使用/i;

/**
 * 归一化 wx 的 fail 回调。
 *
 * 2026-11-08 真机日志暴露的问题：模拟器下 openBluetoothAdapter 直接 fail，
 * err 里既没有 errCode 也可能只有 "fail" 这种无信息 errMsg，旧实现
 * `'ble_' + errCode` 会拼成 **ble_undefined**，把唯一可用的 errMsg 证据丢掉，
 * 页面只能显示「未知错误」，用户无法判断是「手机蓝牙没开」还是「模拟器不支持」。
 * 因此分三档：有官方码 → ble_<code>；能判定不支持 → ble_unsupported；
 * 其它无码 → ble_failed（保留 errMsg）/ ble_undefined（彻底无信息）。
 */
function normalizeFail(api, err) {
  const errCode = err && err.errCode;
  const msg = String((err && err.errMsg) || '');
  if (errCode !== undefined && errCode !== null) {
    const text = BLE_ERROR_TEXT[errCode] || msg || '蓝牙操作失败';
    return new BleError('ble_' + errCode, text, err);
  }
  if (RE_UNSUPPORTED.test(msg) || (api === 'openBluetoothAdapter' && isDevtools())) {
    return new BleError(
      'ble_unsupported',
      '当前环境不支持蓝牙（微信开发者工具模拟器）：请用工具栏「真机调试」或用手机扫码预览',
      err
    );
  }
  return new BleError(msg ? 'ble_failed' : 'ble_undefined', msg || '蓝牙操作失败', err);
}

function wxCall(api, options) {
  return new Promise(function (resolve, reject) {
    if (typeof wx[api] !== 'function') {
      reject(new BleError('api_unsupported', '当前微信版本不支持 ' + api));
      return;
    }
    const params = Object.assign({}, options, {
      success: resolve,
      fail: function (err) {
        reject(normalizeFail(api, err));
      },
    });
    wx[api](params);
  });
}

/* 属性判定：以微信实际返回的 properties 为准 */
function canWrite(p) {
  return !!(p && (p.write || p.writeNoResponse));
}
function canNotify(p) {
  return !!(p && (p.notify || p.indicate));
}
const WANT = {
  CMD_RX: canWrite,
  DATA_RX: canWrite,
  CMD_TX: canNotify,
  DATA_TX: canNotify,
};

class BleManager {
  constructor() {
    this.deviceId = '';
    this.deviceName = '';
    this.serviceId = '';
    this.resolved = null; // {serviceId, serviceSource, chars:{KEY:{id,by,properties}}, missing}
    this.connected = false;
    this.subscribed = {}; // 逻辑名 -> true
    this.mtu = 0;
    this.available = false;
    this.scanning = false;
    this.sessionId = 0;
    this.listeners = {};
    this._locks = {};
    this._bindings = {};
    this._channelOf = {}; // 实际特征 UUID（小写）-> 'CMD_TX' | 'DATA_TX'
    this.stats = {
      notifyCount: 0,
      notifyBytes: 0, // 全部通道的通知字节（含 DATA / 非协议通道）
      cmdBytes: 0, // 仅 CMD_TX 通道：报告里的「响应字节」只认这个口径
      otherBytes: 0, // 非本协议通道的通知字节（不含 DATA）
      notifyOverChunk: 0, // 单片长度 > 20B 的通知数（>0 说明该片被合并/MTU 变化）
      notifyMaxLen: 0,
      fragments: [],
      objects: 0,
      objectBytes: 0, // 重组出的完整 JSON 对象字节总数（权威口径，不含换行）
      lastObjectBytes: 0,
      scanStarts: 0,
      scanFailures: 0,
      lastScanError: '',
      parseErrors: 0,
      cmdNotify: 0,
      dataFrames: 0,
      dataBytes: 0,
      chunksWritten: 0,
      chunkSizes: [],
      otherNotify: 0,
      disconnects: 0, // 被动断链（非本端主动 close）
      manualDisconnects: 0, // 本端主动断开
      linkCloseConfirmed: 0, // 本机确认关闭（系统事件/探测）次数
      advConfirmed: 0, // 设备侧确认：断开后重新扫到广播的次数
    };
    this._linkWait = null;
    this._lastTarget = null; // 上次连过的设备（断连后靠它自动找回）
    this._assembler = new JsonStreamAssembler(
      (obj, size) => {
        this.stats.objects += 1;
        this.stats.objectBytes += size || 0;
        this.stats.lastObjectBytes = size || 0;
        this.emit('message', obj);
      },
      (err, text) => {
        this.stats.parseErrors += 1;
        this.emit('parseError', { error: err, text: text });
      }
    );
    this._bindSystem();
  }

  /* ---------------- 事件 ---------------- */

  on(event, handler) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    const list = this.listeners[event];
    if (!list) return;
    const i = list.indexOf(handler);
    if (i >= 0) list.splice(i, 1);
  }

  emit(event, payload) {
    const list = this.listeners[event];
    if (!list || !list.length) return;
    list.slice().forEach((fn) => {
      try {
        fn(payload);
      } catch (e) {
        console.error('[ble] listener error', event, e);
      }
    });
  }

  _bindSystem() {
    // 非小程序环境（Node 单测）没有 wx：跳过系统回调注册，事件 API 仍可用
    if (typeof wx === 'undefined') return;
    const self = this;
    const bind = function (name, factory) {
      if (self._bindings[name]) return;
      if (typeof wx[name] !== 'function') {
        console.warn('[ble] 当前基础库不支持 ' + name);
        return;
      }
      try {
        wx[name](factory());
        self._bindings[name] = true;
      } catch (e) {
        // 适配器未就绪时注册可能失败，open() 会再补一次
        console.warn('[ble] 注册 ' + name + ' 失败', e);
      }
    };
    bind('onBLECharacteristicValueChange', () => (res) => self._onValue(res));
    bind('onBLEConnectionStateChange', () => (res) => self._onConnState(res));
    bind('onBluetoothDeviceFound', () => (res) => self.emit('devices', res.devices || []));
    bind('onBluetoothAdapterStateChange', () => (res) => {
      self.available = !!res.available;
      /* resetAdapter 的主动关闭不外播：设备页会把 available=false 误判成
         "用户关了蓝牙"而弹系统设置引导（2026-11-09 逃生口设计） */
      if (self._resetting && !res.available) return;
      self.emit('adapter', res);
    });
  }

  _onValue(res) {
    if (this.deviceId && res.deviceId && res.deviceId !== this.deviceId) return;
    const charId = lower(res.characteristicId);
    const bytes = new Uint8Array(res.value);
    const channel = this._channelOf[charId]; // 按实际解析出的特征 ID 分流，不写死 UUID

    this.stats.notifyCount += 1;
    this.stats.notifyBytes += bytes.length;
    if (bytes.length > this.stats.notifyMaxLen) this.stats.notifyMaxLen = bytes.length;
    /* 协议 §4.2：设备按 MTU-3 分片；未协商 MTU 时单片上限 20B。超过 20B 的
       通知只可能是「多片被合并投递」或「链路 MTU 变大」——两种都会让
       「分片数×片长」不再等于响应字节，必须单独计数留证。 */
    if (bytes.length > CHUNK_SIZE) this.stats.notifyOverChunk += 1;
    if (this.stats.fragments.length < 500) this.stats.fragments.push(bytes.length);

    if (channel === 'CMD_TX') {
      this.stats.cmdNotify += 1;
      this.stats.cmdBytes += bytes.length;
      this.emit('notify', { channel: 'CMD', length: bytes.length, charId: charId });
      this._assembler.push(bytes);
    } else if (channel === 'DATA_TX') {
      this.stats.dataFrames += 1;
      this.stats.dataBytes += bytes.length;
      this.emit('notify', { channel: 'DATA', length: bytes.length, charId: charId });
      this.emit('data', bytes);
    } else {
      // 非本协议通道的通知：只计数，不进重组缓冲，避免串道
      this.stats.otherNotify += 1;
      this.stats.otherBytes += bytes.length;
      this.emit('notifyOther', { charId: charId, length: bytes.length });
    }
  }

  _onConnState(res) {
    if (this.deviceId && res.deviceId && res.deviceId !== this.deviceId) return;
    if (!res.connected) {
      const was = this.connected;
      this.connected = false;
      this._resetGatt();
      if (was) {
        this.stats.disconnects += 1;
        this.emit('disconnected', { deviceId: this.deviceId || res.deviceId });
      }
      // 主动断开时等的是这个事件：链路已被系统确认断开（而不是我们自己在本地改标志位）
      if (this._linkWait) this._linkWait('event');
    }
  }

  /** 会话级清理：解析结果、订阅状态、重组缓冲（不动会话号） */
  _resetGatt() {
    this.resolved = null;
    this._channelOf = {};
    this.subscribed = {};
    this._assembler.reset();
    // 写锁一并作废：断链时在途写入已无意义，若把毒化锁带进下一次连接，
    // 重连后第一条命令（常是 auth.login）会永远排队 → 登录永远转圈。
    // 在途写入的 release() 落在空锁链上，无副作用。
    this._locks = {};
  }

  /** 新会话：清空链路级状态并递增会话号 */
  _beginSession() {
    this._resetGatt();
    this.sessionId += 1;
    this.sessionStartedAt = Date.now();
  }

  /** 等一次「链路已断开」的确认：系统事件优先，超时后由调用方探测 */
  _armLinkCloseWait(ms) {
    const self = this;
    const started = Date.now();
    return new Promise(function (resolve) {
      let done = false;
      const finish = function (src) {
        if (done) return;
        done = true;
        if (self._linkWait === finish) self._linkWait = null;
        clearTimeout(timer);
        resolve({ eventSeen: src === 'event', ms: Date.now() - started });
      };
      const timer = setTimeout(function () {
        finish('timeout');
      }, ms);
      self._linkWait = finish;
    });
  }

  /** 探针：链路若仍可用，getBLEDeviceServices 会成功；失败即认为已断 */
  async _probeLinkGone(deviceId) {
    if (typeof wx.getBLEDeviceServices !== 'function') return false;
    try {
      await wxCall('getBLEDeviceServices', { deviceId: deviceId });
      return false; // 还能读服务，说明链路没断
    } catch (e) {
      return true;
    }
  }

  /**
   * 等外设重新广播。这是**设备侧**的断连证据：
   * 固件只在 BLE_GAP_EVENT_DISCONNECT 里 restart_advertising，所以「扫得到它」= 它真的断了。
   * 系统的 onBLEConnectionStateChange 和 getBLEDeviceServices 只代表手机本地 GATT 关闭，
   * Android 连接缓存还能把 ACL 留住——那期间外设收不到断连，token 自然不会被作废。
   * 顺便：这段扫描窗口本身也是等待，避免立刻重连把 ACL 又续上。
   * @returns {Promise<{seen:boolean, ms:number, name:string, rssi:number, error?:string}>}
   */
  async waitForAdvertising(deviceId, name, timeoutMs) {
    const limit = timeoutMs || 9000;
    const started = Date.now();
    const self = this;
    let seen = null;

    const off = this.on('devices', function (list) {
      if (seen) return;
      for (let i = 0; i < list.length; i++) {
        const d = list[i];
        const idMatch = !!deviceId && d.deviceId === deviceId;
        const nameMatch = !!name && (d.name === name || d.localName === name);
        if (idMatch || nameMatch) {
          seen = { name: d.name || d.localName || '', rssi: d.RSSI || 0, deviceId: d.deviceId };
          return;
        }
      }
    });

    let startedScan = false;
    try {
      await this.startScan();
      startedScan = true;
    } catch (e) {
      // 已经在扫描（比如用户手动开着）：直接复用当前扫描窗口
      if (!this.scanning) {
        off();
        return { seen: false, ms: 0, name: '', rssi: 0, error: (e && (e.errMsg || e.message)) || String(e) };
      }
    }

    while (!seen && Date.now() - started < limit) {
      await sleep(200);
    }
    if (startedScan) {
      try {
        await this.stopScan();
      } catch (e) {
        /* 忽略 */
      }
    }
    off();

    if (seen) this.stats.advConfirmed += 1;
    return {
      seen: !!seen,
      ms: Date.now() - started,
      name: seen ? seen.name : '',
      rssi: seen ? seen.rssi : 0,
    };
  }

  /* ---------------- 适配器 ---------------- */

  /** 记住目标设备：断开后 ble.deviceId 会被清空，重连要靠这条记录 */
  _rememberTarget(deviceId, name) {
    if (!deviceId) return;
    this._lastTarget = { deviceId: deviceId, name: name || '', at: Date.now() };
    try {
      if (typeof wx.setStorageSync === 'function') wx.setStorageSync(TARGET_STORAGE_KEY, this._lastTarget);
    } catch (e) {
      /* 存储失败不影响连接 */
    }
  }

  /** 上次连过的设备（内存优先，其次 storage）；没连过返回 null */
  lastTarget() {
    if (this._lastTarget) return this._lastTarget;
    try {
      if (typeof wx.getStorageSync === 'function') {
        const saved = wx.getStorageSync(TARGET_STORAGE_KEY);
        if (saved && saved.deviceId) {
          this._lastTarget = saved;
          return saved;
        }
      }
    } catch (e) {
      /* 忽略 */
    }
    return null;
  }

  /**
   * 扫一段时间的广播，找出目标设备；用于「断连状态下也能一键重连」。
   * 先按 deviceId / name 精确匹配；12s 内没等到精确命中时，退回本窗口内第一个 NUS 设备
   * （Android 的 deviceId 会漂移，名称也可能为空，死等旧 id 会一直连不上）。
   * @param {{deviceId?:string, name?:string, timeout?:number, preferFirst?:boolean}} [opts]
   * @returns {Promise<{deviceId:string, name:string, rssi:number, exact:boolean}|null>}
   */
  async findDevice(opts) {
    const o = opts || {};
    const limit = o.timeout || 9000;
    const started = Date.now();
    let exact = null;
    let any = null;
    let exactBy = '';
    /* 目标名的 4 位十六进制尾号（IotHubBLE-65D8 → 65D8）。Android 的 deviceId 会漂移，
       名字尾号是同一台设备最稳的标识：id 对不上但尾号一致时按同一台处理。 */
    const wantTail = nameTail(o.name);

    const off = this.on('devices', function (list) {
      (list || []).forEach(function (d) {
        if (!d || !d.deviceId) return;
        if (!any) any = d;
        if (exact) return;
        if (o.deviceId && d.deviceId === o.deviceId) {
          exact = d;
          exactBy = 'id';
        } else if (o.name && (d.name === o.name || d.localName === o.name)) {
          exact = d;
          exactBy = 'name';
        } else if (wantTail && nameTail(d.name || d.localName) === wantTail) {
          exact = d;
          exactBy = 'name-tail';
        }
      });
    });

    let ownScan = false;
    try {
      await this.startScan();
      ownScan = true;
    } catch (e) {
      if (!this.scanning) {
        off();
        throw e;
      }
    }

    if (!o.deviceId && !o.name) {
      // 没有历史目标：收到第一台就当结果
      while (!any && Date.now() - started < limit) await sleep(120);
    } else {
      while (!exact && Date.now() - started < limit) {
        // 精确目标没等到，但已经扫到别的 NUS 设备：最多再等 4s 就先用它
        if (any && Date.now() - started > Math.min(4000, limit)) break;
        await sleep(120);
      }
    }

    if (ownScan) {
      try {
        await this.stopScan();
      } catch (e) {
        /* 忽略 */
      }
    }
    off();

    const d = exact || any;
    if (!d) return null;
    return {
      deviceId: d.deviceId,
      name: d.name || d.localName || '',
      rssi: typeof d.RSSI === 'number' ? d.RSSI : 0,
      /* exact=false 只表示「这是随手抓到的任意 NUS 设备」，调用方有目标时不得直接连，
         必须先问用户（2026-11-08 21:48 串台：ensureLink 丢弃了 exact 直接连）。 */
      exact: !!exact,
      by: exactBy || 'any',
    };
  }

  async open() {
    this._bindSystem(); // 若首次注册时适配器未就绪，这里补一次
    await wxCall('openBluetoothAdapter');
    this.available = true;
    return true;
  }

  async close() {
    try {
      await wxCall('closeBluetoothAdapter');
    } catch (e) {
      /* 忽略：适配器可能本就未初始化 */
    }
    this.available = false;
  }

  /**
   * 程序化逃生口：关闭并重开蓝牙适配器（等价"手机关蓝牙→开蓝牙"）。
   * 适用「订阅态僵尸链路」：手机宿主栈停滞时 closeBLEConnection 不生效
   * （2026-11-09 T4 #4 实证：串口 10 分钟无断链事件），只有适配器级重启
   * 能强制拆掉所有 GATT 链路，让外设恢复广播。
   * 副作用：本机所有 BLE 链路全部断开——必须由用户在 UI 确认后调用，
   * 不允许任何自动路径走到这里（与 2026-11-08 串台教训同一原则）。
   * @returns {Promise<{ok:boolean, ms:number, code?:string, text?:string}>}
   */
  async resetAdapter() {
    this._resetting = true;
    const started = Date.now();
    try {
      if (this.connected) {
        try {
          await this.disconnect();
        } catch (e) {
          /* 僵尸链路拆不动是预期内的：适配器级 close 会兜底 */
        }
      }
      await this.close();
      await sleep(1000); // 给蓝牙栈收尾时间，立刻重开在部分机型上会 10001
      await this.open();
      return { ok: true, ms: Date.now() - started };
    } catch (e) {
      const d = normalizeFail('openBluetoothAdapter', e);
      return { ok: false, code: d.code, text: d.message || d.text, ms: Date.now() - started };
    } finally {
      this._resetting = false;
    }
  }

  /* ---------------- 扫描 ---------------- */

  async startScan() {
    const self = this;
    const note = function (err) {
      self.stats.scanFailures += 1;
      self.stats.lastScanError = (err && (err.errMsg || err.code || err.message)) || String(err);
    };
    this.stats.scanStarts += 1;
    try {
      await wxCall('startBluetoothDevicesDiscovery', {
        services: [NUS_SERVICE],
        allowDuplicatesKey: true,
      });
    } catch (err) {
      /* 失败留证：Android 扫描配额（30s 内 ≤5 次 startScan）触发时是 BLE
         errCode 10008「系统异常，请重试」，扫描根本没起来——验收必须能区分
         「设备不广播」和「手机侧配额把扫描掐了」，否则会误判成设备侧缺陷。 */
      note(err);
      await this.stopScan();
      await sleep(200);
      try {
        await wxCall('startBluetoothDevicesDiscovery', {
          services: [NUS_SERVICE],
          allowDuplicatesKey: true,
        });
      } catch (err2) {
        note(err2);
        throw err2;
      }
    }
    this.scanning = true;
  }

  async stopScan() {
    try {
      await wxCall('stopBluetoothDevicesDiscovery');
    } catch (e) {
      /* 未在扫描时会失败，忽略 */
    }
    this.scanning = false;
  }

  /* ---------------- 连接 / 发现 ---------------- */

  async connect(deviceId, name) {
    // 幂等：自动连接流程已建好同一设备的链路时，页面级 _link 直接复用，不拆线重连
    if (this.deviceId === deviceId && this.connected) return true;
    await this.stopScan();
    // stopScan 后立刻 create 在部分安卓机型上会 10003：给蓝牙协议栈留收尾时间
    await sleep(300);
    if (this.deviceId) {
      try {
        await wxCall('closeBLEConnection', { deviceId: this.deviceId });
      } catch (e) {
        /* 旧连接可能已失效 */
      }
    }
    this.deviceId = deviceId;
    this.deviceName = name || '';
    this.connected = false;
    this._beginSession();

    /* close→connect、scan→connect 的系统时序问题（10003/10012）用退避重试兜底：
     * 真机常见「第一次失败、再点一次就连上」，根因多是 400ms 级退避太短——
     * Android GATT 缓存释放普遍需要 ~1s。这里给 0.8s / 1.6s 两级，共 3 次机会。 */
    const backoffs = [800, 1600];
    let lastErr = null;
    for (let i = 0; i <= backoffs.length; i++) {
      try {
        await wxCall('createBLEConnection', { deviceId: deviceId, timeout: 12000 });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (i < backoffs.length) await sleep(backoffs[i]);
      }
    }
    if (lastErr) throw lastErr;
    this.connected = true;
    /* 通知会话层链路建立：Protocol.onLinkUp 据此作废旧 token（每次重连必须重新 auth.login） */
    this.emit('connected', { deviceId: deviceId, name: this.deviceName });
    this._rememberTarget(deviceId, name);

    if (ENABLE_MTU_NEGOTIATION) await this._trySetMtu();
    return true;
  }

  async _trySetMtu() {
    const platform = platformOf();
    if (platform !== 'android' || typeof wx.setBLEMTU !== 'function') return 0;
    try {
      const res = await wxCall('setBLEMTU', { deviceId: this.deviceId, mtu: 247 });
      this.mtu = res.mtu || 0;
    } catch (e) {
      this.mtu = 0;
    }
    return this.mtu;
  }

  async _charsOf(serviceUuid) {
    const res = await wxCall('getBLEDeviceCharacteristics', {
      deviceId: this.deviceId,
      serviceId: serviceUuid,
    });
    return res.characteristics || [];
  }

  /**
   * 解析四个特征：UUID 提示 + 属性校验 -> 属性回退 -> UUID 兜底。
   * 返回 { KEY: {id, by, properties} }，by 记录解析依据。
   */
  _resolveChars(chars) {
    const byUuid = {};
    chars.forEach(function (c) {
      byUuid[lower(c.uuid)] = c;
    });

    const used = {};
    const picked = {};
    const hints = {};
    CHAR_KEYS.forEach(function (k) {
      hints[lower(CHAR_UUID[k])] = k;
    });

    const take = function (ch, by) {
      used[lower(ch.uuid)] = true;
      return { id: ch.uuid, by: by, properties: ch.properties || {} };
    };

    CHAR_KEYS.forEach(function (key) {
      const prefer = byUuid[lower(CHAR_UUID[key])];
      const want = WANT[key];

      // 1) UUID 命中且属性满足
      if (prefer && want(prefer.properties) && !used[lower(prefer.uuid)]) {
        picked[key] = take(prefer, 'uuid');
        return;
      }

      // 2) 属性回退：同服务内第一个满足属性、未被占用、且不是其它逻辑名占位符的特征
      const alt = chars.filter(function (c) {
        if (used[lower(c.uuid)]) return false;
        if (!want(c.properties)) return false;
        const owner = hints[lower(c.uuid)];
        return !owner || owner === key; // 不抢别人的 UUID 提示位
      })[0];
      if (alt) {
        picked[key] = take(alt, 'property');
        return;
      }

      // 3) UUID 命中但属性不符：仍先绑定，用 uuid-weak 暴露出来
      if (prefer && !used[lower(prefer.uuid)]) {
        picked[key] = take(prefer, 'uuid-weak');
        return;
      }

      picked[key] = null;
    });

    return picked;
  }

  async discover() {
    const svcRes = await wxCall('getBLEDeviceServices', { deviceId: this.deviceId });
    const services = svcRes.services || [];

    let chosen = null;
    let chars = null;
    let source = 'uuid';

    // 优先按协议约定的 Service UUID
    const exact = services.filter(function (s) {
      return lower(s.uuid) === NUS_SERVICE;
    })[0];

    if (exact) {
      chosen = exact;
    } else {
      // 回退：找「同时具备 ≥2 个可写 + ≥2 个可通知特征」的服务
      source = 'property';
      for (let i = 0; i < services.length; i++) {
        const list = await this._charsOf(services[i].uuid);
        const writes = list.filter(function (c) {
          return canWrite(c.properties);
        }).length;
        const notifies = list.filter(function (c) {
          return canNotify(c.properties);
        }).length;
        if (writes >= 2 && notifies >= 2) {
          chosen = services[i];
          chars = list;
          break;
        }
      }
    }

    if (!chosen) {
      throw new BleError(
        'service_missing',
        '未发现 NUS 服务（6E400001…），也没有符合「2 写 + 2 notify」特征布局的服务'
      );
    }

    this.serviceId = chosen.uuid;
    if (!chars) chars = await this._charsOf(chosen.uuid);

    const picked = this._resolveChars(chars);
    const missing = CHAR_KEYS.filter(function (k) {
      return !picked[k];
    });

    this.resolved = {
      serviceId: chosen.uuid,
      serviceSource: source,
      chars: picked,
      missing: missing,
      total: chars.length,
      sessionId: this.sessionId,
    };

    // 通知分流表：用实际特征 ID，而不是写死 UUID
    this._channelOf = {};
    if (picked.CMD_TX) this._channelOf[lower(picked.CMD_TX.id)] = 'CMD_TX';
    if (picked.DATA_TX) this._channelOf[lower(picked.DATA_TX.id)] = 'DATA_TX';

    this.emit('discovered', this.resolved);

    if (!picked.CMD_RX || !picked.CMD_TX) {
      throw new BleError(
        'characteristic_missing',
        '缺少 CMD 收发特征：' + missing.join('、') + '（共发现 ' + chars.length + ' 个特征）'
      );
    }
    return this.resolved;
  }

  /* ---------------- 订阅 ---------------- */

  charId(key) {
    return this.resolved && this.resolved.chars[key] ? this.resolved.chars[key].id : '';
  }

  hasChar(key) {
    return !!this.charId(key);
  }

  isSubscribed(key) {
    return !!this.subscribed[key];
  }

  /** 必须先订阅 CMD TX 再写 CMD RX；DATA 同理先订阅 DATA TX */
  async subscribe(key) {
    const ch = this.resolved && this.resolved.chars[key];
    if (!ch) throw new BleError('characteristic_missing', '未找到特征 ' + key);
    if (!canNotify(ch.properties)) {
      throw new BleError('characteristic_missing', key + ' 不支持 notify/indicate');
    }
    await wxCall('notifyBLECharacteristicValueChange', {
      state: true,
      deviceId: this.deviceId,
      serviceId: this.serviceId,
      characteristicId: ch.id,
    });
    this.subscribed[key] = true;
    return true;
  }

  async unsubscribe(key) {
    const ch = this.resolved && this.resolved.chars[key];
    if (!ch) return false;
    try {
      await wxCall('notifyBLECharacteristicValueChange', {
        state: false,
        deviceId: this.deviceId,
        serviceId: this.serviceId,
        characteristicId: ch.id,
      });
    } catch (e) {
      /* 忽略 */
    }
    delete this.subscribed[key];
    return true;
  }

  /* ---------------- 写入 ---------------- */

  /** 同一特征的写入串行化，避免长命令分片被另一条命令插队；不同特征互不阻塞 */
  _withLock(key, fn) {
    if (!this._locks[key]) this._locks[key] = Promise.resolve();
    const prev = this._locks[key];
    let release;
    const gate = new Promise(function (resolve) {
      release = resolve;
    });
    this._locks[key] = prev.then(function () {
      return gate;
    });
    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        release();
      }
    });
  }

  /**
   * @param {'CMD_RX'|'DATA_RX'} key
   * @param {Uint8Array} bytes
   */
  write(key, bytes) {
    const ch = this.resolved && this.resolved.chars[key];
    if (!ch) {
      // 未发现服务/句柄已失效（设备重启后 _resetGatt 清空 resolved 即此形态）：引导 relink，不是设备缺特征
      return Promise.reject(new BleError('characteristic_missing', '特征 ' + key + ' 不可用（服务未发现或句柄已失效，请重新连接设备）'));
    }
    if (!this.connected) return Promise.reject(new BleError('not_connected', '蓝牙未连接'));
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

    // 属性只有 writeNoResponse 时必须显式指定，否则 iOS / 部分 Android 写会失败
    const props = ch.properties || {};
    const writeType = props.write ? 'write' : props.writeNoResponse ? 'writeNoResponse' : 'write';

    return this._withLock(key, async () => {
      for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
        const end = Math.min(offset + CHUNK_SIZE, data.length);
        const slice = data.slice(offset, end); // 独立 buffer，长度精确
        const params = {
          deviceId: this.deviceId,
          serviceId: this.serviceId,
          characteristicId: ch.id,
          value: slice.buffer,
        };
        if (writeType === 'writeNoResponse') params.writeType = writeType;
        await withDeadline(
          wxCall('writeBLECharacteristicValue', params),
          this.writeChunkTimeoutMs || WRITE_CHUNK_TIMEOUT_MS,
          'ble_write_timeout',
          'BLE 写入超时（链路可能已假死或断开）：请断开重连后重试'
        );
        this.stats.chunksWritten += 1;
        if (this.stats.chunkSizes.length < 2000) this.stats.chunkSizes.push(slice.length);
        if (end < data.length) await sleep(CHUNK_GAP_MS);
      }
      return data.length;
    });
  }

  /* ---------------- 心跳探测 ---------------- */

  /**
   * 链路存活探测：查当前连接的 RSSI（不产生任何 GATT 数据面流量）。
   * 用途：设备断电/走出范围时系统 onBLEConnectionStateChange 可能丢失或延迟，
   * 页面心跳靠它发现「假在线」。@returns {Promise<number>} RSSI（dBm，负数）
   */
  probeRssi() {
    if (!this.connected || !this.deviceId) {
      return Promise.reject(new BleError('not_connected', '蓝牙未连接'));
    }
    return wxCall('getBLEDeviceRSSI', { deviceId: this.deviceId }).then(
      (res) => (res && typeof res.RSSI === 'number' ? res.RSSI : -127)
    );
  }

  /**
   * 心跳判定链路丢失后的收尾：清本地 GATT 态并广播 disconnected（若还认为连着）。
   * 与真实断连事件的唯一区别：手机侧栈可能还挂着半死链路，顺手 close 兜底。
   * @returns {boolean} 是否真的从"已连接"切换到"已断开"
   */
  notifyLinkLost(reason) {
    if (!this.connected) return false;
    this.connected = false;
    const id = this.deviceId;
    this._resetGatt();
    this.deviceId = '';
    this.deviceName = '';
    if (typeof wx !== 'undefined' && typeof wx.closeBLEConnection === 'function' && id) {
      try {
        wx.closeBLEConnection({ deviceId: id, fail: function () {} });
      } catch (e) {
        /* 半死链路清不动就算了，本地态已清 */
      }
    }
    this.emit('disconnected', { deviceId: id, reason: reason || 'link_lost' });
    return true;
  }

  /* ---------------- 断开 ---------------- */

  /**
   * 主动断开，并确认链路真的断了。
   * 只调 closeBLEConnection 不算数：Android 上快速 close→connect 可能复用同一条链路，
   * 外设就没收到断连事件，连接级 token 自然不会被作废（T4 重连项会因此误判）。
   * @returns {Promise<{closed:boolean, eventSeen:boolean, probeGone:boolean, ms:number, attempts:number, apiError:string}>}
   */
  async disconnect() {
    const id = this.deviceId;
    if (!id) {
      this.connected = false;
      this._resetGatt();
      return { closed: true, eventSeen: false, probeGone: false, ms: 0, attempts: 0, apiError: '' };
    }

    let eventSeen = false;
    let probeGone = false;
    let ms = 0;
    let attempts = 0;
    let apiError = '';

    attempts += 1;
    const waiter = this._armLinkCloseWait(4000);
    try {
      await wxCall('closeBLEConnection', { deviceId: id });
    } catch (e) {
      apiError = (e && (e.errMsg || e.message)) || String(e);
    }
    const ev = await waiter;
    ms += ev.ms;
    eventSeen = ev.eventSeen;
    if (!eventSeen) {
      // 没收到事件：探测本地 GATT 是否还挂着（注意：这只代表手机侧，不等于外设已断）
      await sleep(500);
      probeGone = await this._probeLinkGone(id);
    }

    const closed = eventSeen || probeGone;

    this.connected = false;
    this._resetGatt();
    this.stats.manualDisconnects += 1;
    if (closed) this.stats.linkCloseConfirmed += 1;
    this.deviceId = '';
    this.deviceName = '';
    return {
      closed: closed,
      eventSeen: eventSeen,
      probeGone: probeGone,
      ms: ms,
      attempts: attempts,
      apiError: apiError,
    };
  }

  /* ---------------- 统计 ---------------- */

  /** 分片统计，用于验收记录通知长度/片数 */
  fragmentStats() {
    const f = this.stats.fragments;
    if (!f.length) return { count: 0, min: 0, max: 0, avg: 0 };
    let min = f[0];
    let max = f[0];
    let sum = 0;
    for (let i = 0; i < f.length; i++) {
      if (f[i] < min) min = f[i];
      if (f[i] > max) max = f[i];
      sum += f[i];
    }
    return { count: f.length, min: min, max: max, avg: Math.round(sum / f.length) };
  }

  /** 环境信息：MTU 是否被主动协商、通知分片长度范围、断链次数（T4 报告要记录） */
  envInfo() {
    const fs = this.fragmentStats();
    return {
      mtu: this.mtu,
      mtuNegotiated: ENABLE_MTU_NEGOTIATION,
      writeChunk: CHUNK_SIZE,
      notifyMin: fs.min,
      // 全量最大片长（fragments 只留前 500 片，长跑后会失真）
      notifyMax: Math.max(fs.max, this.stats.notifyMaxLen),
      notifyAvg: fs.avg,
      notifyCount: fs.count,
      notifyOverChunk: this.stats.notifyOverChunk,
      scanStarts: this.stats.scanStarts,
      scanFailures: this.stats.scanFailures,
      disconnects: this.stats.disconnects,
      manualDisconnects: this.stats.manualDisconnects,
      linkCloseConfirmed: this.stats.linkCloseConfirmed,
      advConfirmed: this.stats.advConfirmed,
      sessionId: this.sessionId,
    };
  }

  /** 计数器快照：验收时用差值判断某一步是否真的收到通知 / 写了片 */
  snapshot() {
    return {
      sessionId: this.sessionId,
      cmdNotify: this.stats.cmdNotify,
      notifyBytes: this.stats.notifyBytes,
      cmdBytes: this.stats.cmdBytes,
      otherBytes: this.stats.otherBytes,
      notifyOverChunk: this.stats.notifyOverChunk,
      notifyMaxLen: this.stats.notifyMaxLen,
      objectBytes: this.stats.objectBytes,
      lastObjectBytes: this.stats.lastObjectBytes,
      scanStarts: this.stats.scanStarts,
      scanFailures: this.stats.scanFailures,
      lastScanError: this.stats.lastScanError,
      dataFrames: this.stats.dataFrames,
      dataBytes: this.stats.dataBytes,
      objects: this.stats.objects,
      parseErrors: this.stats.parseErrors,
      chunks: this.stats.chunksWritten,
      chunkSizes: this.stats.chunkSizes.slice(),
      otherNotify: this.stats.otherNotify,
      disconnects: this.stats.disconnects,
      manualDisconnects: this.stats.manualDisconnects,
      linkCloseConfirmed: this.stats.linkCloseConfirmed,
      advConfirmed: this.stats.advConfirmed,
      connected: this.connected,
      // 重组缓冲里残留的字节数：切会话后必须为 0
      pendingBytes: this._assembler.buffer.length,
    };
  }
}

BleManager.NUS_SERVICE = NUS_SERVICE;
BleManager.CHAR_UUID = CHAR_UUID;
BleManager.CHAR_KEYS = CHAR_KEYS;
BleManager.CHUNK_SIZE = CHUNK_SIZE;
BleManager.BleError = BleError;
/* 页面层（首页开蓝牙引导）要判「模拟器还是真机」，单测要直测失败归一化，
   因此把这两个纯函数挂成静态成员，不改 module.exports 形状（仍是类本身）。 */
BleManager.isDevtools = isDevtools;
BleManager.normalizeFail = normalizeFail;
BleManager.nameTail = nameTail;

module.exports = BleManager;
