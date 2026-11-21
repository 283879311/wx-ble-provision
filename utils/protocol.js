/**
 * CMD 命令层（协议 v1 JSON-RPC 风格）。
 *
 * 请求：{"id","version":"1.0","cmd","args","token"?}  末尾带 \n
 * 成功：{"id","ok":true,"data"}
 * 失败：{"id","ok":false,"error":{"code","message"}}
 *
 * 客户端职责：
 *  1. id 自增并与响应匹配；
 *  2. 单行 <=512B，否则设备返回 line_too_long；
 *  3. 长响应超时要给足（scan/config.get 建议 30s）；
 *  4. unauthorized -> 重新 login 后重试一次；rate_limited -> 等 350ms 重试；
 *     收到 sessions_invalidated:true（改密作废全部会话）-> 丢 token 与凭据、
 *     回调 onSessionInvalidated 提示 UI，不用旧凭据自动重登；
 *  5. token 只存内存，不落盘、不打日志。
 *
 * 时序细节（易踩坑）：一条 275B 命令按 20B 分片 + 20ms 片间隔要写约 300ms，
 * 所以响应超时必须从「写入完成」开始算，否则会在还在写的时候误判超时。
 */

const { utf8Encode } = require('./bytes');
const { sleep, newIdempotencyKey } = require('./util');

/* 每类命令的默认超时（从写入完成后开始计时）。长响应命令必须给足。 */
const TIMEOUTS = {
  'device.info': 10000,
  'device.status': 10000, // 契约 commands.json#device.status.client_timeout_ms（此前漏登记，兜底 8000）
  'auth.login': 10000,
  'config.get': 30000, // MTU23 下约 1107B / 60 片
  'config.set': 30000,
  'network.scan': 30000, // 扫描本身耗时数秒
  'network.status': 10000,
  'io.get': 10000, // 契约 commands.json#io.get.client_timeout_ms
  'io.set': 10000, // 契约 commands.json#io.set.client_timeout_ms
  'network.tryconnect': 20000,
  'operation.get': 10000,
  'network.apply': 15000,
  'network.cancel': 10000,
  'network.profile.list': 15000,
  'network.profile.delete': 15000,
  'data.loopback': 10000,
};

const MAX_LINE_BYTES = 512;
const MIN_COMMAND_INTERVAL_MS = 210; // 设备 5 次/秒、最短 200ms 间隔
/* token TTL 600s：剩 <90s 时发请求先主动重登续期，避免会话中途 401 */
const TOKEN_RENEW_AHEAD_MS = 90 * 1000;

/* 日志脱敏：token / 口令不上屏、不进报告（协议 §11.1 P1） */
const SECRET_KEY_RE = /(password|token|^pin$|_pin$)/i;
const SECRET_TEXT_RE = /"(token|password|sta_password|admin_password|wifi_password|pin|provisioning_pin)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

function redactText(text) {
  return String(text || '').replace(SECRET_TEXT_RE, function (all, key, value) {
    return '"' + key + '":"<redacted:' + value.length + '>"';
  });
}

function redactBody(obj) {
  const out = {};
  Object.keys(obj || {}).forEach(function (k) {
    const v = obj[k];
    if (SECRET_KEY_RE.test(k)) {
      out[k] = '<redacted:' + String(v === undefined || v === null ? '' : v).length + '>';
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redactBody(v);
    } else {
      out[k] = v;
    }
  });
  return out;
}

class ProtocolError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ProtocolError';
    this.code = code;
    this.detail = message || '';
  }
}

class Protocol {
  constructor(ble) {
    this.ble = ble;
    this.pending = new Map();
    this.seq = 0;
    this.token = '';
    this.tokenExpiresAt = 0;
    this.credentials = null; // 仅内存，用于 unauthorized 自动重登录 / 断线重连
    this.lastOperationId = '';
    /* 节流基准 = 上一条命令「写完」时刻（_transact 在 ble.write 返回后打戳）。
       设备按「收到完整行」计 200ms 限流；长命令 20B 分片要 200-300ms 才写完，
       按「发送开始」计时会让「长命令→短命令」必然踩 rate_limited
       （2026-11-10 评审 P1-1；串口证据：#23 auth.login id=21 rate limited）。 */
    this.lastDispatchAt = 0;
    this.onLog = null; // (dir:'tx'|'rx', text, extra) => void
    /* 日志多订阅者（2026-11-08 C）：onLog 是单槽，页面 onHide 置 null 后
       「登录成功 → 18s 静默 → 断链」这种窗口就完全没有报文证据。挂 sink 的页面/跑批
       互不覆盖；再配一份环形留档，跑批页用 logMark/logRange 把本批报文带进报告。 */
    this._logSinks = [];
    this.logRing = [];
    this.logCap = 600;
    this._logSeq = 0;
    this._logWrapped = false; // 环形缓冲发生过淘汰（P3-1，2026-11-10 评审）
    this._logEvictedMin = 0; // 被挤掉的最小日志序号
    this._logEvictedMax = 0; // 被挤掉的最大日志序号（= 最后一次 shift 掉的）
    this.lastDeviceInfo = null; // 最近一次 device.info 应答（身份判定/报告用）
    this.onSessionInvalidated = null; // ({at, responseId}) => void，改密等作废全部会话时回调
    this.sessionInvalidatedAt = 0;
    this._lastInvalidatedId = '';
    this.linkDeviceId = ''; // 当前 token 所在链路的 deviceId；跨设备复用 token 在 onLinkUp 挡住
    this._renewing = false; // 主动续期互斥：并发请求只触发一次重登
    // H9：登录串行化。_loginActiveKey/_loginActivePromise 用于同凭据并发去重
    // （只发一次 auth.login），_loginTail 是登录队列尾，保证不同凭据先后执行、
    // 不并发抢占设备 BLE token 单槽。
    this._loginActiveKey = '';
    this._loginActivePromise = null;
    this._loginTail = null;

    // 验收用计数：tx/rx 条数、id 命中率、超时、自动重登录/重试次数
    this.stats = {
      tx: 0,
      rx: 0,
      matched: 0,
      unmatched: 0,
      timeouts: 0,
      authRetries: 0, // 收到 401/auth_required 的**请求**条数（两条并发各 +1，故并发应为 2）
      authLogins: 0, // 真正发出去的 auth.login 条数（#23 去重判据；只在 tx 点累加）
      rateRetries: 0,
      sessionInvalidations: 0,
      tokenRenewals: 0,
      linkUps: 0,
      writeAckLost: 0, // 写 success 回调丢失但响应已到（不算失败，单独留证）
      lineFlushes: 0, // 写中断后为清设备侧残行发的裸换行次数
      lastTxId: '',
      lastRxId: '',
    };
    this.lastTxAckLost = false;

    ble.on('message', (obj) => this._onMessage(obj));
    ble.on('disconnected', () => this.clearSession(true));
    ble.on('connected', (info) => this.onLinkUp(info && info.deviceId));
  }

  /* ---------------- 生命周期 ---------------- */

  /** keepCredentials=true 时保留凭据以便重连自动登录；手动断开请传 false */
  clearSession(keepCredentials) {
    this.token = '';
    this.tokenExpiresAt = 0;
    if (!keepCredentials) this.credentials = null;
    this.pending.forEach((entry) => {
      clearTimeout(entry.timer);
      entry.reject(new ProtocolError('disconnected', '连接已断开'));
    });
    this.pending.clear();
  }

  /**
   * BLE 链路建立（ble.connect 成功即触发）：token 一律作废。
   * 设备侧 token 与连接绑定，重连/换设备后旧 token 只会换来 unauthorized；
   * 这里直接清掉，让链路建立后的自动登录拿全新 token——
   * 「每次重连必须重新 auth.login、旧 token 作废」在小程序侧的落实点。
   * 凭据保留（内存内、本小程序会话内有效），跨设备不携带任何 token。
   */
  onLinkUp(deviceId) {
    const switched = !!(this.linkDeviceId && deviceId && this.linkDeviceId !== deviceId);
    if (deviceId) this.linkDeviceId = deviceId;
    this.stats.linkUps += 1;
    if (this.token || this.tokenExpiresAt) {
      this.token = '';
      this.tokenExpiresAt = 0;
      this._log('sys', '链路已建立：旧 token 已作废，重连后需重新 auth.login' +
        (switched ? '（设备已切换，跨设备 token 不复用）' : ''), {
        linkUp: true,
        deviceId: this.linkDeviceId,
        switched: switched,
      });
    }
  }

  hasCredentials() {
    return !!(this.credentials && this.credentials.username);
  }

  get loggedIn() {
    return !!this.token;
  }

  tokenRemaining() {
    if (!this.tokenExpiresAt) return 0;
    return Math.max(0, Math.round((this.tokenExpiresAt - Date.now()) / 1000));
  }

  /** 计数器快照：验收时用差值判断命令是否一一对应 */
  snapshot() {
    return {
      tx: this.stats.tx,
      rx: this.stats.rx,
      matched: this.stats.matched,
      unmatched: this.stats.unmatched,
      timeouts: this.stats.timeouts,
      authRetries: this.stats.authRetries,
      authLogins: this.stats.authLogins,
      rateRetries: this.stats.rateRetries,
      sessionInvalidations: this.stats.sessionInvalidations,
      writeAckLost: this.stats.writeAckLost,
      lastTxId: this.stats.lastTxId,
      lastRxId: this.stats.lastRxId,
      pending: this.pending.size,
    };
  }

  _log(dir, text, extra) {
    const ex = extra || null;
    /* 环形留档：不依赖任何订阅者，跑批期（页面 onHide、onLog=null）照样有报文可回溯。
       text 截到 600 字符：留档只用于「有没有这一条、id 谁发的」，全文由实时日志负责。 */
    this._logSeq += 1;
    const entry = { n: this._logSeq, t: Date.now(), dir: dir, text: String(text || '').slice(0, 600), extra: ex };
    this.logRing.push(entry);
    if (this.logRing.length > this.logCap) {
      const evicted = this.logRing.shift();
      this._logWrapped = true;
      if (!this._logEvictedMin) this._logEvictedMin = evicted.n;
      this._logEvictedMax = evicted.n;
    }

    if (typeof this.onLog === 'function') {
      try {
        this.onLog(dir, text, ex);
      } catch (e) {
        /* 页面回调异常不能打断协议层 */
      }
    }
    const sinks = this._logSinks.slice();
    for (let i = 0; i < sinks.length; i++) {
      try {
        sinks[i](dir, text, ex);
      } catch (e) {
        /* 同上 */
      }
    }
  }

  /** 挂一个日志 sink，返回注销函数（页面各自持有，互不覆盖） */
  addLogSink(fn) {
    if (typeof fn !== 'function') return function () {};
    this._logSinks.push(fn);
    const self = this;
    let off = false;
    return function () {
      if (off) return;
      off = true;
      const i = self._logSinks.indexOf(fn);
      if (i >= 0) self._logSinks.splice(i, 1);
    };
  }

  /** 跑批起点：返回当前日志序号，配 logRange 取「本批」报文 */
  logMark() {
    return this._logSeq;
  }

  /** 取 mark 之后的所有报文（含 tx/rx/sys），供报告附页与取证 */
  logRange(mark) {
    const from = mark || 0;
    return this.logRing.filter(function (e) {
      return e.n > from;
    });
  }

  /** 本批报文的紧凑摘要：条数 + id 序列，写进报告附页，避免整段报文撑爆报告 */
  logSummary(mark) {
    const rows = this.logRange(mark);
    const tx = [];
    const rx = [];
    const rxIds = Object.create(null);
    rows.forEach(function (e) {
      if (!e.extra || e.extra.id === undefined) return;
      if (e.dir === 'tx') tx.push(String(e.extra.id));
      else if (e.dir === 'rx') {
        rx.push(String(e.extra.id));
        rxIds[String(e.extra.id)] = true;
      }
    });
    const clip = function (arr, n) {
      return arr.length <= n ? arr.join(',') : arr.slice(0, n).join(',') + '…(共' + arr.length + ')';
    };
    /* 本批有 tx 无 rx 的 id：报告正文的「未匹配 0」只统计「有 rx 无 tx」，
     * 漏了这一侧——请求超时在正文里是隐形的，只能靠附页对账看出来。 */
    const unpaired = tx.filter(function (id) {
      return !rxIds[id];
    });
    return {
      count: rows.length,
      txCount: tx.length,
      rxCount: rx.length,
      /* 非报文事件（断链/订阅等）：count - tx - rx。此前报告只印 count 与 tx/rx，
       * 读者按 75 ≠ 37+36 对不上账。 */
      sysCount: rows.length - tx.length - rx.length,
      unpairedIds: unpaired,
      from: rows.length ? rows[0].n : 0,
      to: rows.length ? rows[rows.length - 1].n : 0,
      txIds: clip(tx, 24),
      rxIds: clip(rx, 24),
      /* P3-1：环形缓冲淘汰后 from 不再是"本批真实起点"。wrapped=true 时调用方
         不得把 from…to 表述为完整批次，须注明区间 [evicted.from…evicted.to] 已被挤掉。 */
      wrapped: this._logWrapped === true,
      evicted: this._logWrapped
        ? { from: this._logEvictedMin, to: this._logEvictedMax }
        : null,
    };
  }

  /* ---------------- 发送内核 ---------------- */

  async _throttle() {
    /* 只等不打戳：打戳挪到 _transact 写完之后（见 P1-1 注释）。
       旧行为（发送开始打戳）会让 20B 分片的长命令占掉 200ms 预算的
       大半，紧随的短命令在设备侧必踩 rate_limited → 350ms 重试多一轮。 */
    const wait = MIN_COMMAND_INTERVAL_MS - (Date.now() - this.lastDispatchAt);
    if (wait > 0) await sleep(wait);
  }

  /** 注册一个待响应槽；返回 { promise, resolve, reject, timer } */
  _register(id, cmd) {
    /* 同一 id 不允许覆盖在途槽：旧 entry 的超时回调带「被顶替即返回」保护，
     * 覆盖会让旧 promise 既不 resolve 也不 reject（静默挂起，日志里连超时都没有）。
     * 控制台手填 id 与自动编号撞车就会命中——改成显式失败，别让它静默吞掉。 */
    if (this.pending.has(id)) {
      throw new ProtocolError(
        'duplicate_id',
        '请求 id ' + id + ' 已在途，拒绝覆盖（等它完成或换一个 id）'
      );
    }
    const entry = { id: id, cmd: cmd, resolve: null, reject: null, timer: null };
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    this.pending.set(id, entry);
    return entry;
  }

  _armTimeout(entry, timeoutMs) {
    entry.timer = setTimeout(() => {
      if (this.pending.get(entry.id) !== entry) return;
      this.pending.delete(entry.id);
      this.stats.timeouts += 1;
      entry.reject(
        new ProtocolError('timeout', entry.cmd + ' 响应超时（' + (timeoutMs / 1000).toFixed(1) + 's）')
      );
    }, timeoutMs);
  }

  _settle(id, ok, payload) {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    if (ok) entry.resolve(payload);
    else entry.reject(payload);
  }

  /**
   * 发一条已经序列化好的命令，等它的响应。
   * @param {{id:string, line:string, cmd:string, timeout:number, label?:string}} job
   */
  async _transact(job) {
    const bytes = utf8Encode(job.line);
    if (bytes.length > MAX_LINE_BYTES) {
      throw new ProtocolError('line_too_long', '命令 ' + bytes.length + 'B 超过 ' + MAX_LINE_BYTES + 'B 上限');
    }

    await this._throttle();
    const entry = this._register(job.id, job.cmd);
    // 立刻挂上处理器：避免超时/断连早于 await 造成 unhandled rejection
    const settled = entry.promise.then(
      function (value) {
        return { ok: true, value: value };
      },
      function (error) {
        return { ok: false, error: error };
      }
    );

    // 写入看门狗：响应超时本来要等写入完成后才挂表，但 ble 层写入若挂死
    // （GATT 假死且 ble 层兜底失效），这里会永远等不到 → 登录永远转圈。
    // 双保险：写入超过 30s 直接按超时结算，条目不再滞留。
    const writeGuard = setTimeout(() => {
      if (this.pending.get(job.id) !== entry) return;
      this.stats.timeouts += 1;
      this._settle(job.id, false, new ProtocolError(
        'timeout',
        job.cmd + ' 写入未能在 30s 内完成（链路假死或已断开），请断开重连'
      ));
    }, 30000);

    let writeErr = null;
    this.lastTxAckLost = false;
    try {
      await this.ble.write('CMD_RX', bytes);
    } catch (err) {
      writeErr = err;
    } finally {
      clearTimeout(writeGuard);
      /* P1-1（2026-11-10 评审）：节流戳在「写完」后打（含 ack 丢失/写失败——
         设备可能已收到全部或部分字节），与设备「完整行到达 +200ms」限流口径对齐。 */
      this.lastDispatchAt = Date.now();
    }

    if (writeErr) {
      /* 写回调丢失但响应已到达（Android + 微信 GATT 的已知形态：数据已写进外设，
         writeBLECharacteristicValue 的 success 回调却不回来）。此时 entry 已被
         响应结算——应答是有效证据，不能因为写 ack 没回来就把它丢掉：
         否则负向探测（错误 token / 大小写变体）会被记成 ble_write_timeout，
         把「设备答得很对」误判成设备缺陷。 */
      if (this.pending.get(job.id) === entry) {
        this._settle(job.id, false, writeErr);
        /* 写到一半失败：设备侧行缓冲里留着半截 JSON，下一条命令会被拼在这半截
           后面 → JSON 解析失败 → 设备回 invalid_json 或干脆不回，客户端看到的是
           「下一条命令莫名 timeout」。发一个裸换行把残行顶出去，让下一条命令从
           干净的行首开始（设备对空行是忽略/报错，不会执行任何东西）。 */
        await this._flushPartialLine();
        throw writeErr;
      }
      this.stats.writeAckLost += 1;
      this.lastTxAckLost = true;
    }

    // 走到这里：要么写成功，要么写 ack 丢失但响应已到（同样算一次 tx——
    // 字节确实送达了外设，否则不会有响应）
    this.stats.tx += 1;
    this.stats.lastTxId = job.id;
    /* #23 判据（2026-11-08）：authLogins 只在「登录命令真的写进外设」时累加。
       不在 login() / _doLogin() 入口累加——那里的调用可能被 H9 去重直接合并掉，
       入口计数会把「一次真发」记成两次，反而看不出重复登录。 */
    if (job.cmd === 'auth.login') this.stats.authLogins += 1;
    this.lastTxHasToken = !!job.hasToken;
    this._log('tx', (job.logLine || job.line).trim(), {
      bytes: bytes.length,
      cmd: job.label || job.cmd,
      id: job.id,
      hasToken: !!job.hasToken,
      writeAckLost: this.lastTxAckLost,
    });

    // 写入完成后再开始计响应超时（长命令分片写入本身就要 300ms 级）
    if (this.pending.get(job.id) === entry) this._armTimeout(entry, job.timeout);

    const res = await settled;
    if (!res.ok) throw res.error;
    return res.value;
  }

  /**
   * 发送一条 v1 命令，返回 { id, data }。
   * opts.token 可指定本次使用的 token（用于验证旧 token 已失效），默认用会话 token。
   * H8：显式 token 收到 unauthorized/auth_required 时不自动重登重试——
   * 自动重试会把负向探测换成新 token 重发，掩盖断言。
   * @param {string} cmd
   * @param {Object} args
   * @param {{timeout?:number, token?:string, noAuthRetry?:boolean, noRateRetry?:boolean}} [opts]
   */
  async _callDetailed(cmd, args, opts) {
    const options = opts || {};
    const id = options.id === undefined ? String(++this.seq) : String(options.id);
    const needsToken = cmd !== 'auth.login' && cmd !== 'device.info';
    const usingSessionToken = options.token === undefined;

    // 快过期主动续期：TTL 600s、剩 <90s 时先重登再发请求，失败不拦（由 401 重试兜底）。
    // 显式传 options.token 的探测请求不续期；续期进行中的并发请求跳过（互斥）。
    if (
      needsToken && usingSessionToken && !options.noAuthRetry && !this._renewing &&
      this.token && this.tokenExpiresAt && Date.now() >= this.tokenExpiresAt - TOKEN_RENEW_AHEAD_MS &&
      this.hasCredentials()
    ) {
      this._renewing = true;
      this.stats.tokenRenewals += 1;
      try {
        await this.login(this.credentials.username, this.credentials.password);
      } catch (e) {
        this._log('sys', 'token 主动续期失败，按现有 token 继续发送', {
          renewFailed: true,
          error: (e && e.code) || '',
        });
      } finally {
        this._renewing = false;
      }
    }

    // 续期之后再取 token，保证请求带的是最新会话 token
    // 注意（#23 实验依赖）：body 与 token 必须在这里同步定型，不能挪到任何 await 之后。
    // utils/probe401.js 的「可控迟到 401」正是靠「调用返回瞬间 body 已含旧 token」来构造
    // 「请求 token ≠ 当前 token」的时序；若改成 await 后再读 this.token，该实验会静默
    // 退化成普通并发（仍然 green），迟到竞态就再也测不出来了。
    const body = { id: id, version: '1.0', cmd: cmd, args: args || {} };
    const token = usingSessionToken ? this.token : options.token;
    if (needsToken && token) body.token = token;

    try {
      const data = await this._transact({
        id: id,
        line: JSON.stringify(body) + '\n',
        logLine: JSON.stringify(redactBody(body)) + '\n',
        cmd: cmd,
        timeout: options.timeout || TIMEOUTS[cmd] || 10000,
        hasToken: !!body.token,
      });
      this.lastTxHasToken = !!body.token; // 验收探测用：最近一条 tx 是否带 token
      return { id: id, data: data, writeAckLost: !!this.lastTxAckLost };
    } catch (err) {
      // 记下请求 id：验收报告要把「请求 id / 响应 id」一起写出来
      if (err && typeof err === 'object' && !err.requestId) err.requestId = id;
      // 未授权（v1 unauthorized / v0 auth_required）：重新登录后按同样参数重试一次（新 id）。
      // 只重试命令，绝不当成链路错误去断开 BLE——链路生命周期归 ble 层管。
      // H8：显式传 options.token 的探测请求（旧 token/错误 token/大小写探测）
      // 一律不自动重试——否则负向断言会被「换成新会话 token 重发」掩盖，
      // T4 的鉴权矩阵就会全绿假象。rawCall 之外的第二道保险。
      if (
        (err.code === 'unauthorized' || err.code === 'auth_required') &&
        cmd !== 'auth.login' && usingSessionToken && !options.noAuthRetry && this.hasCredentials()
      ) {
        this.stats.authRetries += 1;
        await this.login(this.credentials.username, this.credentials.password);
        return this._callDetailed(cmd, args, Object.assign({}, options, { noAuthRetry: true, token: undefined, id: undefined }));
      }
      if (
        (err.code === 'unauthorized' || err.code === 'auth_required') &&
        !usingSessionToken
      ) {
        this._log('sys', '显式 token 被拒，不自动重登重试（负向探测保持原样）', {
          id: id,
          authRetrySuppressed: true,
          explicitToken: true,
        });
      }
      // 限流：等 350ms 再试一次
      if (err.code === 'rate_limited' && !options.noRateRetry) {
        this.stats.rateRetries += 1;
        await sleep(350);
        return this._callDetailed(cmd, args, Object.assign({}, options, { noRateRetry: true, id: undefined }));
      }
      throw err;
    }
  }

  /** 尽力而为地把设备侧残行顶出去（发送失败就说明链路已死，无需再管） */
  async _flushPartialLine() {
    try {
      await this.ble.write('CMD_RX', utf8Encode('\n'));
      this.stats.lineFlushes += 1;
    } catch (e) {
      /* 链路已断/特征缺失：残行会随断链一起消失，不用补救 */
    }
  }

  async _call(cmd, args, opts) {
    const res = await this._callDetailed(cmd, args, opts);
    return res.data;
  }

  /**
   * 原样发一条 v1 命令（不改写、不自动重试），用于验收探测。
   * 返回 { id, data }，便于把请求 id 与响应 id 一起写进报告。
   */
  rawCall(cmd, args, opts) {
    const options = Object.assign({ noAuthRetry: true, noRateRetry: true }, opts || {});
    return this._callDetailed(cmd, args, options);
  }

  /** 原始发送（调试页用）：接受任意 JSON 文本，自动补 id/version/token */
  async sendRaw(rawText) {
    const text = String(rawText || '').trim();
    if (!text) throw new ProtocolError('invalid_argument', '命令为空');
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      throw new ProtocolError('invalid_json', 'JSON 解析失败：' + e.message);
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      throw new ProtocolError('invalid_argument', '命令必须是 JSON 对象');
    }

    const isV0 = !obj.cmd && !!obj.method;
    /* 固件契约（ble_cmd.c 11-03 核实）：v0 帧只认数字 id（cJSON_IsNumber），
       字符串 id 会被固件丢弃、回包 id=-1，小程序永远匹配不上 → 30s 假超时
       （命令其实在设备上执行了）。自动编号用数字；v1 帧数字 id 同样合法。 */
    if (!obj.id) obj.id = ++this.seq;
    const id = String(obj.id);

    if (isV0) {
      if (!obj.params || typeof obj.params !== 'object') obj.params = {};
      if (this.token && !obj.token) obj.token = this.token;
    } else {
      obj.version = obj.version || '1.0';
      if (!obj.args || typeof obj.args !== 'object') obj.args = {};
      if (this.token && obj.cmd !== 'auth.login' && obj.cmd !== 'device.info' && !obj.token) {
        obj.token = this.token;
      }
    }

    this.lastTxHasToken = !!obj.token; // 与 _callDetailed 同口径（调试控制台发的命令也计数）
    return this._transact({
      id: id,
      line: JSON.stringify(obj) + '\n',
      logLine: JSON.stringify(redactBody(obj)) + '\n',
      cmd: obj.cmd || obj.method,
      label: (obj.cmd || obj.method) + (isV0 ? '(v0)' : ''),
      timeout: 30000,
      hasToken: !!obj.token,
    });
  }

  /* ---------------- 响应处理 ---------------- */

  _onMessage(obj) {
    if (!obj || typeof obj !== 'object') return;

    if (obj.id === undefined || obj.id === null) {
      this.stats.rx += 1;
      this.stats.unmatched += 1;
      this._log('rx', JSON.stringify(obj), { unsolicited: true });
      return;
    }
    const id = String(obj.id);
    const known = this.pending.has(id);
    this.stats.rx += 1;
    this.stats.lastRxId = id;
    if (known) this.stats.matched += 1;
    else this.stats.unmatched += 1; // 迟到的 / 上一会话残留的响应

    if (obj.ok === true) {
      this._log('rx', redactText(JSON.stringify(obj)), { id: id, matched: known });
      /* v1 包装用 data；v0 包装（ble_cmd.c）用 result——都透传，避免 v0 结果被丢成 {} */
      const payload =
        obj.data !== undefined ? obj.data : obj.result !== undefined ? obj.result : {};
      this._settle(id, true, payload);
      this._checkSessionInvalidated(id, obj);
      return;
    }

    if (obj.ok === false || obj.error) {
      /* v0 错误的 error 是裸字符串（如 "guard_rejected"）；v1 是 {code,message} */
      const raw = obj.error || {};
      const error = typeof raw === 'string' ? { code: raw, message: '' } : raw;
      const failure = new ProtocolError(error.code || 'internal_error', error.message || '');
      failure.responseId = id; // 供验收核对「请求 id == 响应 id」
      this._log('rx', redactText(JSON.stringify(obj)), { id: id, matched: known, error: error.code });
      this._settle(id, false, failure);
      this._checkSessionInvalidated(id, obj);
      return;
    }

    // v0 兼容响应：{id, result} 或不带 ok 的纯数据
    this._log('rx', redactText(JSON.stringify(obj)), { id: id, matched: known });
    this._settle(id, true, obj.result !== undefined ? obj.result : obj);
    this._checkSessionInvalidated(id, obj);
  }

  /**
   * G1（执行表 #2/#16 前置）：固件在 auth.admin.set（v0 名 web.auth.set）成功后返回
   * {saved:true, sessions_invalidated:true} 并作废全部既有 token（含其它客户端会话）。
   * 客户端收到后必须：
   *   1. 立即丢弃本地 token（本会话已被作废，继续用只会收到 unauthorized）；
   *   2. 丢弃内存凭据——旧口令已不再有效，禁止 unauthorized 自动重登复用旧凭据；
   *   3. 回调 UI 明确提示「会话已失效」，强制重新登录（改密发起方已知新口令，
   *      由调用方自行用新口令 login；其它客户端只能重新输入）。
   * 不 reject 其它 pending：当前响应正常结算，在途命令按各自超时/错误自然收敛。
   */
  _checkSessionInvalidated(responseId, obj) {
    let flag = false;
    if (obj && typeof obj === 'object') {
      flag =
        obj.sessions_invalidated === true ||
        (obj.data && obj.data.sessions_invalidated === true) ||
        (obj.result && obj.result.sessions_invalidated === true);
    }
    if (!flag) return;
    // 按响应 id 去重：同一条响应只处理一次。不用时间窗口——受控改密卡里
    // 「改密 → 恢复」两次 sessions_invalidated 可能间隔小于 1s，都是独立事件。
    if (this._lastInvalidatedId === responseId) return;
    this._lastInvalidatedId = responseId;
    const now = Date.now();
    this.sessionInvalidatedAt = now;
    this.stats.sessionInvalidations += 1;
    this.token = '';
    this.tokenExpiresAt = 0;
    this.credentials = null;
    this._log('rx', 'sessions_invalidated: 设备已作废全部会话，本地 token 与凭据已清空，请重新登录', {
      id: responseId,
      error: 'session_invalidated',
      sessionInvalidated: true,
    });
    if (typeof this.onSessionInvalidated === 'function') {
      this.onSessionInvalidated({ at: now, responseId: responseId });
    }
  }

  /* ---------------- 认证 ---------------- */

  /**
   * 登录入口（H9 串行化/去重）：
   *  - 同凭据并发调用（如多个请求同时收到 401 各自触发重登）只发一次 auth.login，
   *    大家共享同一个结果——设备 BLE token 单槽，并发两次登录会后写覆盖前写；
   *  - 不同凭据的登录排队执行（_loginTail），不并发抢占 token 槽。
   * 主动续期、401 重试、手动 relogin、页面直接 login 全部经由这里，天然串行。
   */
  login(username, password) {
    if (!username) return Promise.reject(new ProtocolError('invalid_argument', '请输入管理员账号'));
    const pw = password || '';
    const key = username + '\u0000' + pw;
    // 同凭据在途：直接复用，不再发第二条 auth.login
    if (this._loginActiveKey === key && this._loginActivePromise) {
      return this._loginActivePromise;
    }
    let resolveP;
    let rejectP;
    const p = new Promise((res, rej) => { resolveP = res; rejectP = rej; });
    this._loginActiveKey = key;
    this._loginActivePromise = p;
    const prev = this._loginTail || Promise.resolve();
    prev.then(
      () => this._doLogin(username, pw).then(resolveP, rejectP),
      () => this._doLogin(username, pw).then(resolveP, rejectP)
    );
    const done = () => {
      if (this._loginActiveKey === key) {
        this._loginActiveKey = '';
        this._loginActivePromise = null;
      }
    };
    p.then(done, done);
    this._loginTail = p.then(function () {}, function () {});
    return p;
  }

  /** 登录执行体：只应由 login() 调用，外部一律走 login()。 */
  async _doLogin(username, password) {
    const data = await this._call(
      'auth.login',
      { username: username, password: password || '' },
      { timeout: TIMEOUTS['auth.login'], noAuthRetry: true }
    );
    if (!data || !data.token) throw new ProtocolError('unauthorized', '设备未返回 token');
    this.token = data.token;
    this.tokenExpiresAt = Date.now() + (data.expires_in || 600) * 1000;
    this.credentials = { username: username, password: password || '' };
    return data;
  }

  async relogin() {
    if (!this.hasCredentials()) throw new ProtocolError('unauthorized', '需要重新输入账号密码');
    return this.login(this.credentials.username, this.credentials.password);
  }

  logout() {
    this.token = '';
    this.tokenExpiresAt = 0;
    this.credentials = null;
  }

  /* ---------------- 业务命令 ---------------- */

  deviceInfo() {
    /* 顺带缓存身份三元组：device_id 是判定「这条链路是谁」的唯一权威字段
       （广播名可能被请求方臆造，MAC 尾号与 id 不同源）。 */
    return this._call('device.info', {}, { timeout: TIMEOUTS['device.info'] }).then((data) => {
      this.lastDeviceInfo = data || null;
      this.lastDeviceInfoFirmware = (data && data.firmware) || '';
      this.lastDeviceId = (data && data.device_id) || '';
      this.lastBuildSha = (data && data.build_sha) || '';
      return data;
    });
  }

  configGet(domains) {
    const args = domains && domains.length ? { domains: domains } : {};
    return this._call('config.get', args, { timeout: TIMEOUTS['config.get'] });
  }

  /**
   * v1 config.set（mqtt / bluetooth / uart 等 v1 允许的域；network 域走 configSetNetwork 的 v0 外壳）。
   * 固件契约（ble_cmd.c 11-03 核实）：补丁必须包在 args.patch 里，平铺在 args 下会被
   * 以 invalid_argument 拒绝；net 域字段在固件侧同样被 v1 显式拒绝（走 v0 外壳）。
   * 返回统一事务字段：saved / applied / restart_required / changed / effect。
   * 口令类字段（mqtt_token 等）由日志层 redactBody 自动脱敏。
   */
  configSet(patch) {
    return this._call('config.set', { patch: patch || {} }, { timeout: TIMEOUTS['config.set'] });
  }

  networkStatus() {
    return this._call('network.status', {}, { timeout: TIMEOUTS['network.status'] });
  }

  /** 设备运行态（ble.advertising / adv_retry_count / heap …）：T4 断链与扫描判读用 */
  deviceStatus() {
    return this._call('device.status', {}, { timeout: TIMEOUTS['device.status'] });
  }

  networkScan() {
    return this._call('network.scan', {}, { timeout: TIMEOUTS['network.scan'] });
  }

  /** 试连候选；新事务必须换新 idempotency_key */
  tryConnect(ssid, password, key) {
    const args = {
      ssid: ssid,
      password: password || '',
      idempotency_key: key || newIdempotencyKey(),
    };
    return this._call('network.tryconnect', args, {
      timeout: TIMEOUTS['network.tryconnect'],
    }).then((data) => {
      if (data && data.operation_id) this.lastOperationId = data.operation_id;
      return data;
    });
  }

  operationGet(operationId) {
    return this._call('operation.get', { operation_id: operationId }, {
      timeout: TIMEOUTS['operation.get'],
    });
  }

  networkApply(operationId) {
    return this._call('network.apply', { operation_id: operationId }, {
      timeout: TIMEOUTS['network.apply'],
    });
  }

  networkCancel(operationId) {
    return this._call('network.cancel', { operation_id: operationId }, {
      timeout: TIMEOUTS['network.cancel'],
    });
  }

  profileList() {
    return this._call('network.profile.list', {}, { timeout: TIMEOUTS['network.profile.list'] });
  }

  profileDelete(ssid) {
    return this._call('network.profile.delete', { ssid: ssid });
  }

  dataLoopback(enabled) {
    return this._call('data.loopback', { enabled: !!enabled });
  }

  /**
   * v0 config.set（产线 / 静态 IP 场景）。
   * v1 config.set 不接受 network 域，改 network 字段只能用 v0 外壳。
   */
  async configSetNetwork(patch) {
    const params = Object.assign({ net_mode: 'sta' }, patch || {});
    const id = ++this.seq; // v0 习惯用数字 id
    const body = { id: id, method: 'config.set', params: params };
    if (this.token) body.token = this.token;
    return this._transact({
      id: String(id),
      line: JSON.stringify(body) + '\n',
      logLine: JSON.stringify(redactBody(body)) + '\n',
      cmd: 'config.set',
      label: 'config.set(v0)',
      timeout: TIMEOUTS['config.set'],
    });
  }
}

Protocol.TIMEOUTS = TIMEOUTS;
/* 契约互锁用：commands.json#client_timeout_ms 与本表逐条对账（_verify/contract-selftest.js） */
Protocol.MIN_COMMAND_INTERVAL_MS = MIN_COMMAND_INTERVAL_MS;
Protocol.ProtocolError = ProtocolError;
Protocol.MAX_LINE_BYTES = MAX_LINE_BYTES;

module.exports = Protocol;
