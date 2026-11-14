const { ble, protocol } = require('../../utils/session');
const { describe } = require('../../utils/errors');
const {
  DEFAULT_USERNAME,
  DEFAULT_PASSWORD,
  AUTO_CONNECT_ENABLED,
  AUTO_CONNECT_SCAN_WINDOW_MS,
  DEVICE_PROBE_INTERVAL_MS,
  DEVICE_PROBE_FAIL_LIMIT,
} = require('../../utils/config');
const credstore = require('../../utils/credstore');
const {
  attemptAutoConnect,
  resetMissState,
  nextDriverRetry: acNext,
  TARGET_MISS_PROMPT_AT,
} = require('../../utils/autoconnect');
const { compareIdentity } = require('../../utils/link');
const { stamp, rssiBars, rssiText, sleep, shortUuid, shortService } = require('../../utils/util');
const BleManager = require('../../utils/ble');

const NUS_SERVICE = BleManager.NUS_SERVICE;
const STALE_MS = 12000; // 超过这个时间没再收到广播就标灰（可能已关机/走远）

/* 字节 → 显示串：<1KB 用 B，其余按 1024 换算保留 1 位。
 * 口径对齐旧 web 设备面板的「空闲堆」（web/config-api.js 的 formatBytes）。 */
function formatBytes(n) {
  const v = Number(n);
  if (!isFinite(v) || v < 0) return '—';
  return v < 1024 ? Math.round(v) + 'B' : (v / 1024).toFixed(1) + 'KB';
}

Page({
  data: {
    adapterHint: '',
    discovering: false,
    devices: [],
    connecting: '',
    connected: false,
    identityWarn: false,
    connectedId: '',
    deviceName: '',
    deviceInfo: null,
    infoRows: [],
    /* 运行态行（堆 / 任务栈 / Flash）：来自 device.status，需 token，登录后拉一次 */
    statusRows: [],
    resolvedRows: [],
    serviceText: '',
    lastTarget: null,
    loggedIn: false,
    loggingIn: false,
    // 预填出厂账号（设备没改过凭据时直接点登录即可）；
    // 用户保存过长期凭据时 onLoad 会覆盖为保存值；手动改输入框即用新值
    username: DEFAULT_USERNAME,
    password: DEFAULT_PASSWORD,
    // 「记住密码」开关：勾选时登录成功存本机（连接后自动登录）；取消时登录成功删存档。
    // 初始态=是否有存档（兼容旧策略的存量记录：有存档即视为已勾选）
    remember: false,
    tokenLeft: 0,
    // 连接态心跳（getBLEDeviceRSSI 轮询）：设备断电时系统断连事件可能丢失，
    // 心跳失败即标记离线，UI 不再停留在「已连接」
    probeRssi: '',
    probeAt: '',
    reconnecting: false,
    logs: [],
    scrollTo: '',
    errText: '',
    errHint: '',
  },

  onLoad() {
    this._devMap = {};
    this._manualUntil = 0; // 页面主动断开的时间窗：事件落在窗内不算「设备断电」
    this._pageVisible = true;
    // 「记住密码」初始态：有存档即勾选（存量记录兼容）；无存档时预填出厂默认
    this.setData({ remember: credstore.hasSaved() });
    // 预填优先级：用户保存过的长期凭据（勾选记住密码时登录成功保存的）> 出厂默认 admin/123456
    const saved = credstore.loadSaved();
    if (saved) {
      this.setData({ username: saved.username, password: saved.password });
    }
    this._refillFromSaved = () => {
      const s = credstore.loadSaved();
      this.setData({
        username: s ? s.username : DEFAULT_USERNAME,
        password: s ? s.password : DEFAULT_PASSWORD,
        remember: credstore.hasSaved(),
      });
    };
    // 自动连接暂停标记：用户在「未找到上次设备」弹窗里选了「手动选择」后置位，
    // 手动连接成功后复位——避免弹窗后每次 onShow 又自动连走
    this._autoConnectPaused = false;
    this._acPromptOpen = false; // 设备缺席弹窗待答：待答期间不续拍、不叠窗（2026-11-09）
    this._onDevices = (list) => this.mergeDevices(list || []);
    this._onAdapter = (res) => {
      this.setData({
        adapterHint: res.available
          ? ''
          : '蓝牙不可用，请打开系统蓝牙（Android 还需开启定位开关并授予微信定位权限）',
      });
      if (!res.available) {
        this.setData({ discovering: false });
        this._promptOpenBluetooth(true);
        return;
      }
      this._btAsked = false; // 蓝牙已开，下次再关时允许重新自动询问
      // 蓝牙从关到开（用户先开小程序后开蓝牙的场景）：openBluetoothAdapter 之前失败过，
      // 必须重新 open 成功后 wx 蓝牙接口才可用（adapter 事件只会把 ble.available 置 true，
      // 不会补 open）；open 成功后补跑自动连接，否则用户开了蓝牙小程序也无动作（2026-11-01 反馈）。
      if (this._reopening) return;
      this._reopening = true;
      ble
        .open()
        .then(() => this._maybeAutoConnect())
        .catch(() => {})
        .then(() => {
          this._reopening = false;
        });
    };
    this._onDisconnected = (info) => {
      this.stopTokenTimer();
      this._stopAgeTicker();
      this._stopHeartbeat();
      this._clearAcRetry();
      this.setData({
        connected: false,
        loggedIn: false,
        connecting: '',
        reconnecting: false,
        deviceInfo: null,
        infoRows: [],
        resolvedRows: [],
        serviceText: '',
        probeRssi: '',
        probeAt: '',
        tokenLeft: 0,
      });
      // 断开后回填长期凭据（保存过才有），重连后一键登录
      this._refillFromSaved();
      const manual = Date.now() < (this._manualUntil || 0);
      if (manual) {
        this.log('err', '蓝牙连接已断开：设备侧 token 同步作废，重连后需重新登录');
      } else {
        // 非页面主动断开 = 设备断电/链路丢失：立即进入重新发现观察，
        // 连续 3 个扫描窗口见不到记忆设备会弹「设备可能已断电」
        this.log('err', '蓝牙链路丢失（设备可能已断电或超出范围），正在自动重新发现…');
        this._scheduleAcRetry(3000);
      }
      wx.showToast({ title: '连接已断开', icon: 'none' });
    };
    // G1：改密等操作会作废全部会话（sessions_invalidated），协议层已丢 token/凭据，
    // 这里负责 UI 提示并回到未登录态
    this._onSessionInvalidated = (info) => {
      this.stopTokenTimer();
      this.setData({
        loggedIn: false,
        tokenLeft: 0,
        errText: '会话已失效，请重新登录',
        errHint: '改密或其它客户端已作废全部会话（sessions_invalidated），请用当前有效口令重新登录',
      });
      this.log('err', '收到 sessions_invalidated（响应 id ' + ((info && info.responseId) || '-') + '）：本地 token 已作废，需重新登录');
      wx.showToast({ title: '会话已失效', icon: 'none' });
    };

    ble.on('devices', this._onDevices);
    ble.on('adapter', this._onAdapter);
    ble.on('disconnected', this._onDisconnected);
  },

  /* ---------------- 引导打开系统蓝牙 ---------------- */

  /** 弹窗确认后跳系统蓝牙设置页。wx.openSystemBluetoothSetting 仅 Android/鸿蒙支持
   *  （基础库 2.20.1+，且要求用户点击手势触发，modal 确认即满足）；iOS 无任何代开/跳转
   *  能力，只能提示用户到控制中心手动打开。
   *  @param {boolean} auto 自动触发（onShow open 失败 / 适配器关闭事件）：每次页面生命周期
   *  只弹一次，取消后不打扰；手动点提示区不走此限。 */
  _promptOpenBluetooth(auto) {
    if (ble.connected || this.data.connecting) return;
    const isAuto = auto === true;
    if (isAuto && this._btAsked) return;
    if (isAuto) this._btAsked = true;
    /* 开发者工具模拟器没有蓝牙适配器：弹「去打开蓝牙」纯属误导（手机上蓝牙本来就开着），
       直接告知要真机调试（2026-11-08 日志：ble_undefined 出现在模拟器） */
    if (BleManager.isDevtools()) {
      wx.showModal({
        title: '需要在手机上调试',
        content:
          '微信开发者工具模拟器不提供蓝牙能力，扫描/连接设备必须用真机。\n\n请点工具栏「真机调试」，或「预览」后用手机扫码运行。',
        showCancel: false,
        confirmText: '知道了',
      });
      return;
    }
    const isAndroid = (() => {
      try {
        if (typeof wx.getDeviceInfo === 'function') return wx.getDeviceInfo().platform === 'android';
        return wx.getSystemInfoSync().platform === 'android';
      } catch (e) {
        return false;
      }
    })();
    if (isAndroid && typeof wx.openSystemBluetoothSetting === 'function') {
      wx.showModal({
        title: '打开手机蓝牙',
        content:
          '当前系统蓝牙未开启，无法扫描和连接设备。\n\n是否前往系统蓝牙设置打开？打开后返回小程序会自动重连设备。',
        confirmText: '去开启',
        cancelText: '暂不',
        success: (res) => {
          if (!res.confirm) return;
          this.log('sys', '跳转系统蓝牙设置页：打开蓝牙后返回将自动重连');
          wx.openSystemBluetoothSetting({
            fail: () => {
              this.log('err', '跳转系统蓝牙设置失败，请到系统设置手动打开蓝牙');
              wx.showToast({ title: '跳转失败，请到系统设置打开蓝牙', icon: 'none' });
            },
          });
        },
      });
    } else {
      wx.showModal({
        title: '请打开蓝牙',
        content: 'iOS 上小程序无法代开蓝牙：请从控制中心（或设置-蓝牙）打开蓝牙后返回本页，会自动重连。',
        showCancel: false,
        confirmText: '知道了',
      });
    }
  },

  onShow() {
    this._pageVisible = true;
    protocol.onLog = (dir, text, extra) => this.logProtocol(dir, text, extra);
    protocol.onSessionInvalidated = this._onSessionInvalidated;

    // 别的页面（例如验收页的扫描项）可能已经停掉了扫描，这里以适配器真实状态为准
    if (this.data.discovering && !ble.scanning) this.setData({ discovering: false });

    if (ble.connected) {
      this.setData({
        connected: true,
        connectedId: ble.deviceId,
        deviceName: ble.deviceName,
        loggedIn: protocol.loggedIn,
        tokenLeft: protocol.tokenRemaining(),
      });
      if (ble.resolved) this._logResolved(ble.resolved);
      if (protocol.loggedIn) this.startTokenTimer();
      if (!this.data.deviceInfo) {
        protocol
          .deviceInfo()
          .then((d) => this.setData({ deviceInfo: d, infoRows: this.buildInfoRows(d) }))
          .catch(() => {});
      }
      /* 回到前台且已登录：内存行没拉过就补一次（例如从设置页回来） */
      if (protocol.loggedIn && !this.data.statusRows.length) this._refreshStatus();
    }

    if (!ble.available) {
      ble
        .open()
        .then(() => {
          this.setData({ adapterHint: '' });
          this._btAsked = false;
          this._maybeAutoConnect();
        })
        .catch((err) => {
          const d = describe(err);
          this.setData({ adapterHint: d.text });
          /* 环境不支持（模拟器）：再弹「去打开蓝牙」是错的，只留提示条 */
          if (err && err.code === 'ble_unsupported') {
            this.log('err', '当前环境不支持蓝牙：' + d.text);
            return;
          }
          this._promptOpenBluetooth(true); // 蓝牙未开就进小程序：弹窗引导（每次进入只问一次）
        });
    } else {
      this._maybeAutoConnect();
    }
  },

  /** 打开小程序/回到设备页后的自动连接：
   *  上次设备在场直连；缺席满 3 个扫描窗口 → 弹窗（连最强 / 手动选）；
   *  「手动选择」后暂停自动连接，手动连接成功后恢复。 */
  async _maybeAutoConnect(opts) {
    if (!AUTO_CONNECT_ENABLED) return;
    if (this._autoConnectPaused) return; // 用户已选择手动接管，不再抢
    if (this._autoConnecting) return;
    if (ble.connected || this.data.connecting || this.data.reconnecting || this.data.discovering) return;
    this._autoConnecting = true;
    const isRetry = !!(opts && opts.retry);
    try {
      const r = await attemptAutoConnect(ble, {
        log: (kind, text) => this.log('sys', text),
        windowMs: AUTO_CONNECT_SCAN_WINDOW_MS,
        // 重试驱动（断电观察）用短冷却：3 个窗口约 30s 内跑完，弹窗不必等用户来回切页
        cooldownMs: isRetry ? 2000 : undefined,
      });
      if (r.skipped) {
        const msSkipped = acNext(r);
        if (msSkipped === 0) return; // busy：占用中的那次调用负责续拍
        if (msSkipped > 0 && this._pageVisible && !ble.connected && !this._autoConnectPaused) {
          // scanning/cooldown 等占用也要续拍——观察链一断，3 窗计数停摆、弹窗永不出现（2026-11-07）
          this._scheduleAcRetry(msSkipped);
        }
        return;
      }
      if (r.ok) {
        this._autoConnectPaused = false;
        this.log('sys', '自动连接成功（' + (r.via === 'last' ? '上次设备' : '信号最强') + '）');
        wx.showToast({ title: '已自动连接 ' + (r.device.name || ''), icon: 'none' });
        // ble.connect 幂等：这里补发现/订阅/登录，链路不拆线
        await this._link(r.device.deviceId, r.device.name, true);
      } else if (r.reason === 'target_missing') {
        // 连续 3 个扫描窗口没见到记忆设备：弹窗交给用户，不静默切走
        this._promptFallbackDevice(r);
      } else if (r.reason === 'target_missed') {
        /* 2026-11-09：原来印「(4/3)」「(13/3)」，分母固定 3 而分子一路涨，读起来像进度条坏了；
         * 分母的真实含义是"每 3 次询问一次"，改用缺席次数表述 */
        this.log('sys', '扫描未发现上次设备「' + (r.target && (r.target.name || r.target.deviceId) || '') +
          '」（第 ' + r.misses + ' 次缺席，每 ' + TARGET_MISS_PROMPT_AT + ' 次询问一次），暂不自动换设备');
        if (this._pageVisible && !this._autoConnectPaused) this._scheduleAcRetry(2500);
      } else {
        // 观察链自愈（2026-11-07）：scan/adapter/connect_failed/no_candidate/no_device 等任何
        // 失败都要续拍——中途一次失败就让计数停摆的话，断电弹窗永远等不到
        const msFail = acNext(r);
        this.log('sys', '自动连接未成功（' + r.reason + (r.misses ? '，第 ' + r.misses + ' 次缺席' : '') + '），观察继续');
        if (msFail > 0 && this._pageVisible && !this._autoConnectPaused && !ble.connected) {
          this._scheduleAcRetry(msFail);
        }
      }
    } catch (e) {
      // 异常也要留痕+续拍，否则一次抛错就让观察链死掉、弹窗永不出现（2026-11-07）
      this.log('err', '自动连接观察异常：' + describe(e).text);
      if (this._pageVisible && !this._autoConnectPaused && !ble.connected) this._scheduleAcRetry(5000);
    } finally {
      this._autoConnecting = false;
    }
  },

  /* ---------------- 断电观察驱动与连接态心跳 ---------------- */

  /** 自动连接重试定时器：页面可见期间持续观察，直到连上/用户接管/页面隐藏 */
  _clearAcRetry() {
    if (this._acRetryTimer) {
      clearTimeout(this._acRetryTimer);
      this._acRetryTimer = null;
    }
  },

  _scheduleAcRetry(delayMs) {
    this._clearAcRetry();
    if (this._autoConnectPaused || ble.connected || this._pageVisible === false) return;
    /* 2026-11-09：弹窗还挂着时不再续拍。否则 stopScan 的兜底续拍会在用户读弹窗期间
     * 继续扫，把缺席计数推到下一个 3 的倍数，再叠一个弹窗上去（11-09 日志里
     * 「扫描停止」→ 4/3 → 6/3 连弹就是这个形态）。用户答完弹窗再由回调恢复观察。 */
    if (this._acPromptOpen) return;
    this._acRetryTimer = setTimeout(() => {
      this._acRetryTimer = null;
      this._maybeAutoConnect({ retry: true });
    }, delayMs || 2500);
  },

  /**
   * 连接态心跳：每 10s 查一次 RSSI（无数据面流量）。连续 2 次失败判定链路丢失——
   * 设备断电后系统断连事件可能不触发，UI 不能一直停在「已连接」。
   * 判定丢失后 notifyLinkLost 会 emit disconnected → _onDisconnected 统一清 UI
   * 并启动断电观察（3 窗口弹窗）。
   */
  _startHeartbeat() {
    this._stopHeartbeat();
    this._probeFails = 0;
    this.setData({ probeRssi: '检测中', probeAt: '' });
    const tick = async () => {
      if (!ble.connected) {
        this._stopHeartbeat();
        return;
      }
      try {
        const rssi = await ble.probeRssi();
        this._probeFails = 0;
        this.setData({ probeRssi: rssi + 'dBm', probeAt: stamp() });
      } catch (e) {
        this._probeFails += 1;
        const d = describe(e);
        this.log('err', '设备心跳失败（' + this._probeFails + '/' + DEVICE_PROBE_FAIL_LIMIT + '）：' + d.text);
        if (this._probeFails >= DEVICE_PROBE_FAIL_LIMIT) {
          this._stopHeartbeat();
          if (ble.notifyLinkLost('link_lost')) {
            this.log('err', '心跳连续失败，已判定链路丢失（设备可能已断电）');
          }
        }
      }
    };
    tick();
    this._hbTimer = setInterval(tick, DEVICE_PROBE_INTERVAL_MS);
  },

  _stopHeartbeat() {
    if (this._hbTimer) {
      clearInterval(this._hbTimer);
      this._hbTimer = null;
    }
    this._probeFails = 0;
  },

  /** 记忆设备连续 3 个扫描窗口缺席：是否切换设备？（每再满 3 窗会重新询问） */
  _promptFallbackDevice(r) {
    if (this._acPromptOpen) return; // 已有一个待答弹窗：叠第二个只会让人更困惑
    this._acPromptOpen = true;
    const tname = (r.target && (r.target.name || r.target.deviceId)) || '上次设备';
    const best = r.strongest;
    const emptyWindow = !best; // 窗口内没有任何设备广播——记忆设备断电的典型形态
    wx.showModal({
      title: emptyWindow ? '设备可能已断电' : '未找到上次的设备',
      content: emptyWindow
        ? '已连续 ' + r.misses + ' 个扫描窗口未发现「' + tname + '」，且本窗口没有任何设备在广播。\n\n设备可能已断电、关机或不在范围内。是否切换到其它设备？'
        : '已连续 ' + r.misses + ' 个扫描窗口未发现「' + tname + '」（可能已断电）。\n\n当前信号最强的是「' + (best.name || best.deviceId) + '」（' + best.rssi + 'dBm）。是否切换设备？',
      confirmText: emptyWindow ? '切换设备' : '连最强信号',
      cancelText: emptyWindow ? '继续等待' : '手动选择',
      success: (res) => {
        this._acPromptOpen = false;
        if (res.confirm && best) {
          this.log('sys', '按选择连接信号最强设备「' + (best.name || best.deviceId) + '」（' + best.rssi + 'dBm）');
          this._link(best.deviceId, best.name, true);
        } else if (res.confirm && emptyWindow) {
          // 切换设备：暂停自动连接，打开扫描由用户挑；手动连接成功后自动恢复
          this._autoConnectPaused = true;
          this.log('sys', '按选择切换设备：自动连接已暂停，请在列表中手动选择');
          this._startScan();
        } else if (emptyWindow) {
          // 继续等待：保持观察驱动，每再满 3 窗会再次弹窗询问
          this.log('sys', '继续等待「' + tname + '」恢复广播（每 ' + TARGET_MISS_PROMPT_AT + ' 次缺席会再次询问）');
          this._scheduleAcRetry(1000);
        } else {
          this._autoConnectPaused = true;
          this.log('sys', '自动连接已暂停：请在列表中手动选择设备（手动连接成功后自动恢复）');
          this._startScan(); // 顺手开一窗扫描，列表就绪供选择
        }
      },
      fail: () => {
        // 弹窗接口异常（页面销毁等）：别把观察链一起带走
        this._acPromptOpen = false;
        this._scheduleAcRetry(3000);
      },
    });
  },

  onHide() {
    protocol.onLog = null;
    protocol.onSessionInvalidated = null;
    this.stopScan();
  },

  onUnload() {
    protocol.onLog = null;
    protocol.onSessionInvalidated = null;
    this.stopScan();
    this.stopTokenTimer();
    ble.off('devices', this._onDevices);
    ble.off('adapter', this._onAdapter);
    ble.off('disconnected', this._onDisconnected);
  },

  /* ---------------- 日志 ---------------- */

  log(kind, text) {
    this._logSeq = (this._logSeq || 0) + 1;
    const logs = this.data.logs
      .concat([{ id: this._logSeq, kind: kind, t: stamp(), text: text }])
      .slice(-150);
    this.setData({ logs: logs, scrollTo: 'log-bottom' });
  },

  logProtocol(dir, text, extra) {
    const kind = dir === 'tx' ? 'tx' : extra && extra.error ? 'err' : 'rx';
    this.log(kind, (dir === 'tx' ? '→ ' : '← ') + (text.length > 400 ? text.slice(0, 400) + ' …' : text));
  },

  onClearLog() {
    this.setData({ logs: [] });
  },

  /** 复制连接日志（按屏显格式拼接，token 等敏感值在 logProtocol 层已脱敏后才入 logs） */
  onCopyLog() {
    const text = (this.data.logs || [])
      .map((l) => l.t + '  ' + l.text)
      .join('\n');
    if (!text) {
      wx.showToast({ title: '暂无日志可复制', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: text,
      success: () => {
        // 系统会弹"已复制"提示，这里补一条说明复制范围
        this.log('sys', '已复制 ' + this.data.logs.length + ' 条日志到剪贴板');
      },
      fail: () => {
        wx.showToast({ title: '复制失败，请重试', icon: 'none' });
      },
    });
  },

  /* ---------------- 扫描 ---------------- */

  /**
   * 只渲染「本次扫描窗口内实际收到的广播」，且只收 IotHub 设备：
   *  - 广播带服务 UUID 列表 → 必须含 NUS UUID 才收；
   *  - 广播没带 UUID 列表（部分手机不回填）→ 仅当名字以 IotHub 开头才收（兜底）；
   *  - 其余（包括无 UUID 且名字随机的设备）一律排除，不混进列表。
   * 不调用 getBluetoothDevices 补种历史列表，避免把系统/微信缓存的旧设备当成在线设备。
   */
  mergeDevices(list) {
    const map = this._devMap || {};
    const now = Date.now();
    list.forEach(function (d) {
      if (!d || !d.deviceId) return;
      const name = d.localName || d.name || '';
      const uuids = d.advertisServiceUUIDs || [];
      const nusHit = uuids.some(function (u) {
        return String(u).toLowerCase() === NUS_SERVICE;
      });
      // 部分 Android 不回填 advertisServiceUUIDs：此时按设备名前缀兜底，其余全排除
      const nameFallback = uuids.length === 0 && /^iothub/i.test(name);
      if (!nusHit && !nameFallback) return;
      const rssi = typeof d.RSSI === 'number' ? d.RSSI : typeof d.rssi === 'number' ? d.rssi : -127;
      const prev = map[d.deviceId];
      if (prev) {
        // RSSI 指数平滑（α=0.3）：广播级抖动 ±5dB 很常见，不平滑会让排序每帧翻面
        const sm = Math.round(prev.rssi * 0.7 + rssi * 0.3);
        map[d.deviceId] = {
          deviceId: d.deviceId,
          name: name || '（未命名设备）',
          rssi: sm,
          rssiText: rssiText(sm),
          bars: rssiBars(sm),
          seenAt: now,
        };
      } else {
        map[d.deviceId] = {
          deviceId: d.deviceId,
          name: name || '（未命名设备）',
          rssi: rssi,
          rssiText: rssiText(rssi),
          bars: rssiBars(rssi),
          seenAt: now,
        };
      }
    });
    this._devMap = map;
    this._scheduleRender();
  },

  /* 渲染节流：广播高频到达时 250ms 合并成一次 setData，列表不逐帧重绘 */
  _scheduleRender() {
    if (this._renderTimer) return;
    this._renderTimer = setTimeout(() => {
      this._renderTimer = null;
      this._renderDevices();
    }, 250);
  },

  _renderDevices() {
    const self = this;
    const now = Date.now();
    /* 排序滞回：信号差 < RSSI_HYST dBm 时维持上一帧相对顺序。
     * 否则两台信号接近的设备会随广播波动在列表里来回换位（视觉上翻滚闪烁）。 */
    const RSSI_HYST = 6;
    const prevOrder = this._devOrder || {};
    const devices = Object.keys(this._devMap || {})
      .map(function (k) {
        const d = self._devMap[k];
        const age = now - d.seenAt;
        return {
          deviceId: d.deviceId,
          name: d.name,
          rssi: d.rssi,
          rssiText: d.rssiText,
          bars: d.bars,
          ageText: age < 1500 ? '刚刚' : Math.round(age / 1000) + 's 前',
          stale: age > STALE_MS,
        };
      })
      .sort(function (a, b) {
        const diff = b.rssi - a.rssi;
        if (diff >= RSSI_HYST) return 1;
        if (diff <= -RSSI_HYST) return -1;
        // 信号接近：按上一帧顺序排（新设备视为最后，下一帧起有位置）
        const oa = prevOrder[a.deviceId];
        const ob = prevOrder[b.deviceId];
        return (oa === undefined ? 1e9 : oa) - (ob === undefined ? 1e9 : ob);
      });
    const order = {};
    devices.forEach(function (d, i) {
      order[d.deviceId] = i;
    });
    this._devOrder = order;
    this.setData({ devices: devices });
  },

  _startAgeTicker() {
    this._stopAgeTicker();
    this._ageTimer = setInterval(() => {
      if (this.data.devices.length) this._renderDevices();
    }, 1000);
  },

  _stopAgeTicker() {
    if (this._ageTimer) {
      clearInterval(this._ageTimer);
      this._ageTimer = null;
    }
    if (this._renderTimer) {
      clearTimeout(this._renderTimer);
      this._renderTimer = null;
    }
  },

  async onToggleScan() {
    if (this.data.connecting || this.data.reconnecting) return;
    // 状态自愈：连接时 ble.connect 内部已停掉底层扫描，但页面 discovering 可能还挂着
    // （按钮停在「停止」、再按就是静默 stopScan，用户看起来"扫描没反应"）。
    // 以 ble.scanning 真实状态为准，陈旧 discovering 先清掉再走正常分支。
    if (this.data.discovering && !ble.scanning) this.setData({ discovering: false });
    if (this.data.discovering) {
      await this.stopScan();
      return;
    }
    // 协议 §2.1：设备连接后停止广播。连接态扫描到 0 台是正常现象，不是固件故障，
    // 所以这里直接引导「先断开再扫」，而不是让用户以为设备坏了。
    if (this.data.connected) {
      wx.showModal({
        title: '需要先断开',
        content:
          '设备在连接后会停止广播，连接态下扫描不到目标是正常行为。\n\n要重新扫描，请先断开当前连接（断开后设备会恢复广播）。',
        confirmText: '断开并扫描',
        cancelText: '取消',
        success: (res) => {
          if (!res.confirm) return;
          this._disconnectThenScan();
        },
      });
      return;
    }
    await this._startScan();
  },

  async _disconnectThenScan() {
    await this.onDisconnect();
    await sleep(600); // 等设备侧恢复广播
    await this._startScan();
  },

  async _startScan() {
    this.setData({ errText: '', errHint: '' });
    try {
      this._devMap = {};
      this.setData({ devices: [] });
      await ble.startScan();
      this.setData({ discovering: true, adapterHint: '' });
      this._startAgeTicker();
      this.log('sys', '扫描开始（NUS 过滤，只统计本窗口广播）：' + NUS_SERVICE);
    } catch (err) {
      const d = describe(err);
      this.setData({ discovering: false, adapterHint: d.text });
      this.log('err', d.code + ' ' + d.text);
    }
  },

  async stopScan() {
    this._stopAgeTicker();
    if (!this.data.discovering && !ble.scanning) return;
    try {
      await ble.stopScan();
    } catch (e) {
      /* 忽略 */
    }
    this.setData({ discovering: false });
    this.log('sys', '扫描停止');
    // 手动扫描结束仍未连上：恢复断电观察驱动（3 窗后弹「是否切换设备」），
    // 否则弹窗里点过「切换设备/手动选择」后流程会死在扫描结束后
    if (
      !ble.connected &&
      !this.data.connecting &&
      !this._autoConnectPaused &&
      this._pageVisible
    ) {
      this._scheduleAcRetry(2000);
    }
  },

  /* ---------------- 连接 ---------------- */

  async onConnect(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    if (!id || this.data.connecting || this.data.reconnecting) return;
    // 已连接的设备再点 = 断开（标签显示「断开」，整行都是断开热区）
    if (id === this.data.connectedId) {
      await this.onDisconnect();
      return;
    }
    this.setData({ lastTarget: { id: id, name: name } });
    await this._link(id, name, false);
  },

  /** 连接 -> 发现 -> 订阅（先 CMD 后 DATA）-> device.info（登录由用户在表单点「登录」触发；
   *  autoLogin 参数为自动连接路径的兼容签名，现仅作标记，页面不再自动登录） */
  async _link(deviceId, name, autoLogin) {
    // 连接前收掉扫描态：ble.connect 内部会停底层扫描，这里同步页面 discovering
    // 与年龄 ticker，否则连接后按钮卡在「停止」、扫描键"没反应"（2026-10-29 用户反馈）
    await this.stopScan();
    this.setData({ connecting: deviceId, errText: '', errHint: '' });
    this.log('sys', '正在连接 ' + (name || deviceId));

    try {
      await ble.connect(deviceId, name);
      this.log('sys', 'GATT 已连接 · 会话 #' + ble.sessionId + '（旧缓冲已清空）');

      const info = await ble.discover();
      this._logResolved(info);

      // 顺序关键：先订阅 TX，再写 RX
      await ble.subscribe('CMD_TX');
      this.log('sys', '已订阅 CMD TX → ' + shortUuid(info.chars.CMD_TX.id));

      if (info.chars.DATA_TX) {
        try {
          await ble.subscribe('DATA_TX');
          this.log('sys', '已订阅 DATA TX → ' + shortUuid(info.chars.DATA_TX.id));
        } catch (err) {
          this.log('err', 'DATA TX 订阅失败：' + describe(err).text);
        }
      } else {
        this.log('err', '设备未提供 DATA TX 特征，DATA 通道不可用');
      }

      const device = await protocol.deviceInfo();
      /* 身份行（C/B）：把「这条链路到底是谁」写进日志。广播名是请求方带进来的，
         只有 device_id + build_sha 能自证——21:48 串台时界面上一直显示 65D8。 */
      this.log('sys', 'device.info ok：' + (device.model || '-') + ' / ' + (device.firmware || '-') +
        ' · ' + (device.device_id || '未报 device_id') +
        (device.build_sha ? ' · sha ' + device.build_sha : ''));
      const idc = compareIdentity({ name: name }, device);
      const identityWarn = !idc.ok;
      if (identityWarn) {
        /* 人工点选已表达意图，这里不强行拆链（拆了用户也没法看信息），
           但必须大声说明——并跳过凭据自动登录，避免往陌生设备上灌已存口令。 */
        this.log('err', '设备身份不符：目标是「' + idc.want + '」，实际连到「' + idc.got +
          '」——后续操作都会作用在实际设备上');
      }

      this.setData({
        connecting: '',
        connected: true,
        connectedId: deviceId,
        deviceName: name,
        deviceInfo: device,
        infoRows: this.buildInfoRows(device),
        loggedIn: protocol.loggedIn,
        tokenLeft: protocol.tokenRemaining(),
        identityWarn: identityWarn,
        errText: identityWarn ? '设备身份不符：实际连到 ' + idc.got : '',
        errHint: identityWarn ? '目标「' + idc.want + '」与实连设备不是同一台（同型号多台在场时常见），请确认后再操作' : '',
      });
      /* 自动登录路径：连接时已有 token，补一次内存行 */
      if (protocol.loggedIn) this._refreshStatus();

      // 手动/弹窗路径连接成功：恢复自动连接资格并清缺席计数，随后启动心跳
      this._manualUntil = 0;
      this._autoConnectPaused = false;
      resetMissState();
      this._clearAcRetry();
      this._startHeartbeat();

      // 连接后自动登录（勾选「记住密码」的存档存在才做，2026-11-06 用户要求）：
      // 存档不可用/被拒只提示，不重试不循环——表单始终在，用户可手动登录。
      // 验收中心/T4 自动链路用自己的 ensureLink 登录，不受此影响。
      if (!protocol.loggedIn && credstore.hasSaved() && !identityWarn) {
        const s = credstore.loadSaved();
        try {
          const ld = await protocol.login(s.username, s.password);
          this.log('sys', '已用记住的凭据自动登录（' + s.username + '），token TTL ' + (ld.expires_in || 600) + 's');
        } catch (e) {
          const ad = describe(e);
          this.log('err', '自动登录失败 [' + ad.code + '] ' + ad.text + '，请在上方手动登录');
        }
        this.setData({ loggedIn: protocol.loggedIn, tokenLeft: protocol.tokenRemaining() });
      }
      if (protocol.loggedIn) {
        this.startTokenTimer();
      } else {
        if (identityWarn && credstore.hasSaved()) {
          this.log('err', '身份不符，已跳过「记住的凭据」自动登录（避免把口令送到非目标设备）；请确认设备后再手动登录');
        }
        this.log('sys', '请在上方「设备登录」输入账号密码登录（已预填，确认无误直接点登录即可）');
      }
    } catch (err) {
      const d = describe(err);
      this.setData({ connecting: '', errText: d.text, errHint: d.hint, reconnecting: false });
      this.log('err', '连接失败 [' + d.code + '] ' + d.text);
      wx.showToast({ title: d.text, icon: 'none' });
      try {
        await ble.disconnect();
      } catch (e2) {
        /* 忽略 */
      }
      this.setData({ connected: false });
    }
  },

  _logResolved(info) {
    const rows = BleManager.CHAR_KEYS.map(function (k) {
      const c = info.chars[k];
      let by = '缺失';
      if (c) {
        by = c.by === 'uuid' ? 'UUID 命中' : c.by === 'property' ? '按属性回退' : 'UUID 兜底(属性不符)';
      }
      return {
        k: k.replace('_', ' '),
        v: c ? shortUuid(c.id) + ' · ' + by : '缺失',
        warn: !c || c.by === 'uuid-weak',
      };
    });
    this.setData({
      resolvedRows: rows,
      serviceText:
        shortService(info.serviceId) +
        ' · ' +
        (info.serviceSource === 'uuid' ? '按 UUID 定位' : '按特征布局定位') +
        ' · 共 ' + info.total + ' 个特征',
    });
    this.log(
      'sys',
      '服务 ' + shortService(info.serviceId) + '，特征 ' + info.total + ' 个' +
        (info.missing.length ? '，缺失：' + info.missing.join('、') : '')
    );
  },

  buildInfoRows(device) {
    const rows = [];
    const d = device || {};
    if (d.model) rows.push({ k: '型号', v: d.model });
    if (d.firmware) rows.push({ k: '固件', v: d.firmware + (d.build_sha ? '（' + d.build_sha + '）' : '') });
    if (d.device_id) rows.push({ k: '设备 ID', v: d.device_id });
    if (d.protocol_versions) rows.push({ k: '协议版本', v: [].concat(d.protocol_versions).join(', ') });
    if (d.security) {
      rows.push({ k: '链路加密', v: d.security.link_encrypted ? '是' : '否（明文）' });
      rows.push({ k: '敏感写', v: d.security.sensitive_writes_allowed ? '允许' : '禁止' });
    }
    return rows;
  },

  /* device.status.heap/stack/partition → 运行态行。字段缺失就少一行，不补 0。 */
  buildStatusRows(status) {
    const h = (status && status.heap) || {};
    const s = (status && status.stack) || {};
    const p = (status && status.partition) || {};
    const rows = [];
    if (typeof h.free === 'number') rows.push({ k: '堆空闲', v: formatBytes(h.free) });
    if (typeof h.min_free === 'number') rows.push({ k: '堆历史最低', v: formatBytes(h.min_free) });
    if (typeof h.largest === 'number') rows.push({ k: '堆最大可用块', v: formatBytes(h.largest) });
    if (typeof s.min_free === 'number') {
      rows.push({
        k: '任务栈历史最低',
        v: formatBytes(s.min_free) + (s.min_task ? '（' + s.min_task + '）' : ''),
      });
    }
    if (s.low) rows.push({ k: '栈 <2KB', v: String(s.low) });
    if (typeof p.flash_total === 'number') rows.push({ k: 'Flash 总容量', v: formatBytes(p.flash_total) });
    if (typeof p.size === 'number') {
      rows.push({
        k: '应用分区',
        v: typeof p.used === 'number'
          ? formatBytes(p.used) + ' / ' + formatBytes(p.size)
          : formatBytes(p.size),
      });
    }
    if (typeof p.free === 'number') rows.push({ k: '分区余量', v: formatBytes(p.free) });
    return rows;
  },

  /* 登录后拉一次 device.status 填运行态行；失败只记日志，不影响面板其余部分。
   * device.status 需要 token（ble_cmd.c:534），未登录时直接返回。 */
  async _refreshStatus() {
    if (!protocol.loggedIn) {
      if (this.data.statusRows.length) this.setData({ statusRows: [] });
      return;
    }
    const devId = ble.deviceId; // 迟到的应答不能落到另一台设备的界面上
    try {
      const st = await protocol.deviceStatus();
      if (!protocol.loggedIn || !ble.connected || ble.deviceId !== devId) return;
      this.setData({ statusRows: this.buildStatusRows(st) });
    } catch (err) {
      if (ble.deviceId !== devId) return;
      this.setData({ statusRows: [] });
      this.log('sys', 'device.status 不可用，运行态信息暂不显示：' + describe(err).text);
    }
  },

  /* ---------------- 登录 ---------------- */

  onUsername(e) {
    this.setData({ username: e.detail.value });
  },

  onPassword(e) {
    this.setData({ password: e.detail.value });
  },

  onRememberToggle(e) {
    this.setData({ remember: !!e.detail.value });
    this.log('sys', e.detail.value ? '记住密码：已开启（登录成功后本机保存，连接后自动登录）' : '记住密码：已关闭（登录成功后清除本机存档）');
  },

  async onLogin() {
    if (this.data.loggingIn) return;
    const username = (this.data.username || '').trim();
    const password = this.data.password || '';
    if (!username) {
      wx.showToast({ title: '请输入管理员账号', icon: 'none' });
      return;
    }
    this.setData({ loggingIn: true, errText: '', errHint: '' });
    try {
      const data = await protocol.login(username, password);
      const ttl = data.expires_in || 600;
      // 按「记住密码」开关决定存档：勾选→覆盖式保存（连接后自动登录）；取消→删旧存档
      if (this.data.remember) {
        try {
          credstore.save(username, password);
          this.log('sys', 'auth.login 成功，token TTL ' + ttl + 's（凭据已记住到本机，连接后将自动登录）');
        } catch (e) {
          this.log('err', '凭据本机保存失败（不影响本次登录）');
        }
      } else {
        credstore.clear();
        this.log('sys', 'auth.login 成功，token TTL ' + ttl + 's（未勾选记住密码：已清除本机存档，重连需手动登录）');
      }
      this.setData({ loggingIn: false, loggedIn: true, password: '', tokenLeft: ttl });
      this.startTokenTimer();
      /* token 到手后再拉内存（device.status 需要鉴权） */
      this._refreshStatus();
    } catch (err) {
      const d = describe(err);
      this.setData({ loggingIn: false, errText: d.text, errHint: d.hint });
      this.log('err', '登录失败 [' + d.code + '] ' + d.text);
    }
  },

  startTokenTimer() {
    this.stopTokenTimer();
    this._tokenTimer = setInterval(() => {
      const left = protocol.tokenRemaining();
      if (left <= 0) {
        this.stopTokenTimer();
        this.setData({ loggedIn: false, tokenLeft: 0 });
        this.log('err', 'token 已过期（600s），请重新登录');
        return;
      }
      if (left !== this.data.tokenLeft) this.setData({ tokenLeft: left });
    }, 1000);
  },

  stopTokenTimer() {
    if (this._tokenTimer) {
      clearInterval(this._tokenTimer);
      this._tokenTimer = null;
    }
  },

  /* ---------------- 跳转 / 断开 ---------------- */

  onGoProvision() {
    wx.switchTab({ url: '/pages/provision/provision' });
  },

  onGoAccept() {
    wx.switchTab({ url: '/pages/accept/accept' });
  },

  async onDisconnect() {
    this._manualUntil = Date.now() + 5000; // 页面主动断开：断连事件不算「设备断电」
    this.stopTokenTimer();
    this._stopHeartbeat();
    this._clearAcRetry();
    protocol.clearSession(false); // 主动断开：连凭据一起清掉
    try {
      await ble.disconnect();
    } catch (e) {
      /* 忽略 */
    }
    this._devMap = {};
    this.setData({
      connected: false,
      loggedIn: false,
      connectedId: '',
      deviceName: '',
      deviceInfo: null,
      infoRows: [],
      statusRows: [],
      resolvedRows: [],
      serviceText: '',
      devices: [],
      tokenLeft: 0,
    });
    // 断开时回填长期凭据（保存过才有），方便随手重连
    this._refillFromSaved();
    this.log('sys', '已断开连接');
  },
});
