/**
 * PST 帧协议（Pressure / Stress Transfer）—— **协议冻结层**
 *
 * 这是 BLE DATA 通道与 UART1 压测共用的唯一帧定义。`stress` 引擎与
 * `pages/stress` 都必须走这里，禁止再各自拼字节。`tools/uart_bridge.py`
 * 是电脑侧参考实现，两端一致性由 `_verify/pframe-vectors.json` 锁定：
 * 任何一端改了编码，`node ../_verify/pframe-selftest.js` 立刻变红。
 *
 * ---------------------------------------------------------------- 字节布局
 *
 *   off   size  field
 *    0     2    magic   0xA5 0x5A
 *    2     1    type    0x01 DATA / 0x02 START / 0x03 END
 *    3     2    seq     BE
 *    5     2    len     BE，payload 字节数，0..4096
 *    7   len    payload
 *  7+len   2    crc16   CRC-16/CCITT-FALSE，覆盖 type..payload（**不含 magic**）
 *
 *   固定开销 9B（HEADER 7 + CRC 2）。
 *
 * CRC 不含 magic 是刻意的：重同步时先靠 magic 定位帧头，再用 CRC 验证
 * 「type+seq+len+payload」这一段。若 CRC 把 magic 也盖进去，一个被改写的
 * magic 字节就会让整帧看起来像 CRC 错，无法区分「串道」和「内容损坏」。
 *
 * ---------------------------------------------------------------- seq 语义
 *
 *   DATA   0..65535 递增，按 payload 长度连续，最后一个 DATA 的 seq = total-1
 *   START  填 runId（本轮轮次号），不参与 DATA 序号空间
 *   END    填 runId，必须与 START 一致才被接受
 *
 * 控制帧用 runId 而不是 0，是为了防**串轮**：上一轮迟到的 END 帧如果
 * seq 恒为 0，会被本轮当成自己的结束信号，直接结算出一个假的 100%。
 * runId 不匹配的 START/END 一律丢弃并计入 `staleControl`。
 *
 * ---------------------------------------------------------------- 关键约定
 *
 * 1. `START.total` 是**预期 DATA 帧数**，不含 START/END 自身。结算时
 *    `expected` 必须只与 DATA 帧比较。把控制帧算进去会让每轮凭空多 2 帧，
 *    在 500 帧的用例里表现为 99.6% 的「神秘丢失」。
 *
 * 2. 收到 END **不等于**传输完整。END 只说明「发送端到此为止」，三种状态
 *    必须分开：`no_end`（END 没到达）、`seq_gap`（序号缺口）、
 *    `end_partial`（END 到了但 DATA 不足）。判定逻辑在 stress 引擎，
 *    这里只保证帧语义能支撑这三种区分。
 *
 * 3. payload 不落盘、不留副本：同一 seq 由 LCG 确定性重建，收到就地比对。
 *    JS 侧必须用 `Math.imul` —— 见 lcgPayload 上方注释。
 */

const MAGIC0 = 0xa5;
const MAGIC1 = 0x5a;

const TYPE_DATA = 0x01;
const TYPE_START = 0x02;
const TYPE_END = 0x03;

const HEADER_LEN = 7; // magic(2) + type(1) + seq(2) + len(2)
const CRC_LEN = 2;
const FRAME_OVERHEAD = HEADER_LEN + CRC_LEN; // 9

/** payload 上限。超过即判定为假 magic / 长度字段损坏，只丢 1 字节重新找头。 */
const MAX_PAYLOAD = 4096;

const SEQ_MOD = 0x10000;

/** START payload: total(4) + plen(2) */
const START_PAYLOAD_LEN = 6;
/** END payload: sent(4) */
const END_PAYLOAD_LEN = 4;

/* ---------------------------------------------------------------- CRC */

/**
 * CRC-16/CCITT-FALSE
 *   width=16 poly=0x1021 init=0xFFFF refin=false refout=false xorout=0x0000
 *   check("123456789") = 0x29B1
 *
 * 用 256 项查表：2048B 的帧从 16k 次移位降到 2k 次查表，长稳压测时
 * 手机上不会因为校验本身产生可观测的 CPU 抖动。
 */
const CRC_TABLE = (function () {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let j = 0; j < 8; j++) {
      c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    }
    t[i] = c;
  }
  return t;
})();

/**
 * @param {Uint8Array} bytes
 * @param {number} [start]
 * @param {number} [end] 不传则到末尾
 * @returns {number} 0..65535
 */
function crc16(bytes, start, end) {
  const s = start || 0;
  const e = end === undefined ? bytes.length : end;
  let crc = 0xffff;
  for (let i = s; i < e; i++) {
    crc = ((crc << 8) & 0xffff) ^ CRC_TABLE[((crc >> 8) ^ bytes[i]) & 0xff];
  }
  return crc;
}

/* ---------------------------------------------------------------- LCG */

/**
 * 确定性伪随机载荷：同一 (seq, n) 在 JS / Python 两端生成完全相同的字节，
 * 所以发送端不需要保存副本，接收端收到任何一帧都能就地重建并比对。
 *
 * ⚠️ 必须用 Math.imul。
 * x 可达 2^31，乘以 1103515245 约为 2.4e18，超过 2^53 的整数精度上限。
 * 写成 `x * 1103515245` 会静默丢低位，两端 payload 对不上、CRC 全错，
 * 现象看起来像串口坏了。Math.imul 取低 32 位，与 Python 大整数
 * `& 0x7FFFFFFF` 的结果严格一致（已验证 seq=2e9 边界）。
 *
 * @param {number} seq 帧序号（实际帧里是 16 位；此处不截断，保证与 Python 对任意 seq 都一致）
 * @param {number} n   载荷字节数
 * @returns {Uint8Array}
 */
function lcgPayload(seq, n) {
  const len = n > 0 ? n : 0;
  const out = new Uint8Array(len);
  if (len === 0) return out;
  // 不做 seq & 0xffff：Math.imul 内部按 ToInt32 取低 32 位，与 Python 的大整数
  // 乘积在 mod 2^32 下同余，再 & 0x7FFFFFFF 必然得到相同的低 31 位。
  let x = (Math.imul(seq, 1103515245) + 12345) & 0x7fffffff;
  for (let i = 0; i < len; i++) {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}

/** 按 seq 重建期望载荷并与实收比较；长度不同直接 false */
function payloadMatches(seq, payload) {
  if (!payload) return false;
  const expect = lcgPayload(seq, payload.length);
  for (let i = 0; i < expect.length; i++) {
    if (expect[i] !== payload[i]) return false;
  }
  return true;
}

/* ---------------------------------------------------------------- 组帧 */

function u16(v) {
  return [(v >>> 8) & 0xff, v & 0xff];
}

function u32(v) {
  const n = v >>> 0;
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/**
 * 组一帧。
 * @param {number} type TYPE_*
 * @param {number} seq  DATA 用序号；控制帧用 runId
 * @param {Uint8Array} payload
 * @returns {Uint8Array}
 */
function buildFrame(type, seq, payload) {
  const body = payload || new Uint8Array(0);
  if (body.length > MAX_PAYLOAD) {
    throw new Error('payload 超限：' + body.length + ' > ' + MAX_PAYLOAD);
  }
  const total = FRAME_OVERHEAD + body.length;
  const out = new Uint8Array(total);
  out[0] = MAGIC0;
  out[1] = MAGIC1;
  out[2] = type & 0xff;
  out[3] = (seq >>> 8) & 0xff;
  out[4] = seq & 0xff;
  out[5] = (body.length >>> 8) & 0xff;
  out[6] = body.length & 0xff;
  out.set(body, HEADER_LEN);
  // CRC 覆盖 type..payload，不含 magic
  const c = crc16(out, 2, HEADER_LEN + body.length);
  out[total - 2] = (c >>> 8) & 0xff;
  out[total - 1] = c & 0xff;
  return out;
}

/** DATA 帧，payload 由 LCG 生成 */
function dataFrame(seq, payloadLen) {
  return buildFrame(TYPE_DATA, seq, lcgPayload(seq, payloadLen));
}

/**
 * START 帧。
 * @param {number} runId 轮次号，回填到 seq 字段
 * @param {number} total 预期 **DATA 帧数**（不含控制帧）
 * @param {number} payloadLen 每帧 DATA 的载荷长度
 */
function startFrame(runId, total, payloadLen) {
  const p = new Uint8Array(START_PAYLOAD_LEN);
  p.set(u32(total), 0);
  p.set(u16(payloadLen), 4);
  return buildFrame(TYPE_START, runId, p);
}

/**
 * END 帧。
 * @param {number} runId
 * @param {number} sent 发送端实际发出的 DATA 帧数（可能 < START.total）
 */
function endFrame(runId, sent) {
  return buildFrame(TYPE_END, runId, new Uint8Array(u32(sent)));
}

/* ---------------------------------------------------------------- 解帧 */

/** @returns {{total:number, payloadLen:number}|null} 长度不符返回 null */
function decodeStart(payload) {
  if (!payload || payload.length !== START_PAYLOAD_LEN) return null;
  return {
    total: ((payload[0] << 24) >>> 0) + (payload[1] << 16) + (payload[2] << 8) + payload[3],
    payloadLen: (payload[4] << 8) | payload[5],
  };
}

/** @returns {{sent:number}|null} */
function decodeEnd(payload) {
  if (!payload || payload.length !== END_PAYLOAD_LEN) return null;
  return {
    sent: ((payload[0] << 24) >>> 0) + (payload[1] << 16) + (payload[2] << 8) + payload[3],
  };
}

/** seq 差值，自动处理 65535→0 回绕。用于丢帧/乱序判定，别自己写减法。 */
function seqDelta(prev, cur) {
  return (cur - prev + SEQ_MOD) % SEQ_MOD;
}

function isData(type) {
  return type === TYPE_DATA;
}

function typeName(type) {
  if (type === TYPE_DATA) return 'DATA';
  if (type === TYPE_START) return 'START';
  if (type === TYPE_END) return 'END';
  return '0x' + (type & 0xff).toString(16);
}

function toHex(bytes, max) {
  const n = max && max < bytes.length ? max : bytes.length;
  let s = '';
  for (let i = 0; i < n; i++) {
    s += (i ? ' ' : '') + (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  }
  if (n < bytes.length) s += ' …(' + bytes.length + 'B)';
  return s;
}

/* ---------------------------------------------------------------- 流解析器 */

/**
 * 增量流解析器：处理粘包、拆包、垃圾字节、失步重同步、半帧超时。
 *
 * 压测里 DATA 通道是裸字节流，一次 notify 可能只有 20B（半个帧头），
 * 也可能一次塞进好几帧。所有「按帧切分」的事必须在这里做完，
 * 上层只拿完整帧。
 *
 * 统计口径（这四项是**解析层**的账，不要和 BLE 层/UART 层混）：
 *   frames        成功解析出的帧数
 *   crcErrors     magic 对上但 CRC 不符 → 内容损坏或错位
 *   resyncBytes   为重新对齐帧头而丢弃的字节
 *   truncBytes    半帧超时被判为残缺、整体丢弃的字节
 *   oversize      长度字段 > MAX_PAYLOAD 被当作假 magic 的次数
 *   unknownType   CRC 正确但 type 不认识（理论上不该出现，出现即两端版本不一致）
 *
 * @param {{maxPayload?:number, staleMs?:number, onFrame?:function(Object)}|undefined} opts
 */
function FrameParser(opts) {
  const o = opts || {};
  this.maxPayload = o.maxPayload || MAX_PAYLOAD;
  this.staleMs = o.staleMs === undefined ? 2000 : o.staleMs;
  this.onFrame = typeof o.onFrame === 'function' ? o.onFrame : null;
  this.reset();
}

FrameParser.prototype.reset = function () {
  this._buf = new Uint8Array(4096);
  this._len = 0;
  this._lastRx = 0;
  this.stats = {
    frames: 0,
    bytes: 0,
    crcErrors: 0,
    resyncBytes: 0,
    truncBytes: 0,
    oversize: 0,
    unknownType: 0,
  };
};

FrameParser.prototype._append = function (bytes) {
  const need = this._len + bytes.length;
  if (need > this._buf.length) {
    let cap = this._buf.length;
    while (cap < need) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this._buf.subarray(0, this._len), 0);
    this._buf = nb;
  }
  this._buf.set(bytes, this._len);
  this._len = need;
};

FrameParser.prototype._drop = function (n) {
  if (n <= 0) return;
  if (n >= this._len) {
    this._len = 0;
    return;
  }
  this._buf.copyWithin(0, n, this._len);
  this._len -= n;
};

/**
 * 喂入一段字节，返回本次解析出的完整帧数组。
 * @param {Uint8Array|Array<number>} bytes
 * @param {number} [now] 注入时钟便于自测
 * @returns {Array<{type:number,seq:number,len:number,payload:Uint8Array,bytes:number,at:number}>}
 */
FrameParser.prototype.push = function (bytes, now) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const out = [];
  if (arr.length === 0) return out;

  this._append(arr);
  this._lastRx = now === undefined ? Date.now() : now;

  const buf = this._buf;
  for (;;) {
    // 1. 定位 magic
    let start = -1;
    for (let i = 0; i + 1 < this._len; i++) {
      if (buf[i] === MAGIC0 && buf[i + 1] === MAGIC1) {
        start = i;
        break;
      }
    }
    if (start < 0) {
      // 没有 magic：留最后 1 字节（可能是半个 magic），其余都是垃圾
      const drop = this._len > 1 ? this._len - 1 : 0;
      this.stats.resyncBytes += drop;
      this._drop(drop);
      return out;
    }
    if (start > 0) {
      this.stats.resyncBytes += start;
      this._drop(start);
    }

    // 2. 帧头是否到齐
    if (this._len < HEADER_LEN) return out;

    const len = (buf[5] << 8) | buf[6];
    if (len > this.maxPayload) {
      // 长度不合理 → 这个 magic 是巧合或已损坏，只丢 1 字节继续找
      this.stats.oversize += 1;
      this.stats.resyncBytes += 1;
      this._drop(1);
      continue;
    }

    const total = HEADER_LEN + len + CRC_LEN;
    if (this._len < total) return out; // 半帧，等下一批

    const calc = crc16(buf, 2, HEADER_LEN + len);
    const got = (buf[total - 2] << 8) | buf[total - 1];
    if (calc !== got) {
      this.stats.crcErrors += 1;
      this.stats.resyncBytes += 1;
      this._drop(1); // 只丢 1 字节，让后面的 magic 有机会重新对齐
      continue;
    }

    const type = buf[2];
    if (type !== TYPE_DATA && type !== TYPE_START && type !== TYPE_END) {
      this.stats.unknownType += 1;
    }

    const frame = {
      type: type,
      seq: (buf[3] << 8) | buf[4],
      len: len,
      payload: buf.slice(HEADER_LEN, HEADER_LEN + len),
      bytes: total,
      at: now === undefined ? Date.now() : now,
    };
    this.stats.frames += 1;
    this.stats.bytes += total;
    this._drop(total);
    out.push(frame);
    if (this.onFrame) this.onFrame(frame);
  }
};

/**
 * 半帧超时检查：调用方在「一段时间没有新数据」时调它。
 * 缓冲里还剩字节说明最后一帧没发完（或链路断了），整段丢弃并计入 truncBytes
 * —— 不丢的话，残留的半帧会和下一轮的字节拼在一起，产生一个 CRC 永远
 * 对不上的假帧，把后续整轮都带偏。
 *
 * @param {number} [now]
 * @returns {number} 丢弃的字节数
 */
FrameParser.prototype.tick = function (now) {
  if (this._len === 0) return 0;
  const t = now === undefined ? Date.now() : now;
  if (this.staleMs <= 0 || t - this._lastRx < this.staleMs) return 0;
  const dropped = this._len;
  this.stats.truncBytes += dropped;
  this._len = 0;
  return dropped;
};

/** 当前缓冲里未成帧的字节数（诊断用） */
FrameParser.prototype.pending = function () {
  return this._len;
};

module.exports = {
  MAGIC0,
  MAGIC1,
  TYPE_DATA,
  TYPE_START,
  TYPE_END,
  HEADER_LEN,
  CRC_LEN,
  FRAME_OVERHEAD,
  MAX_PAYLOAD,
  START_PAYLOAD_LEN,
  END_PAYLOAD_LEN,
  SEQ_MOD,
  crc16,
  lcgPayload,
  payloadMatches,
  buildFrame,
  dataFrame,
  startFrame,
  endFrame,
  decodeStart,
  decodeEnd,
  seqDelta,
  isData,
  typeName,
  toHex,
  FrameParser,
};
