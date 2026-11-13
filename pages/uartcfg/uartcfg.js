const { ble, protocol } = require('../../utils/session');
const { describe } = require('../../utils/errors');
const { stamp } = require('../../utils/util');
const busy = require('../../utils/busy');

/**
 * UART 配置（配置中心 · 独立页）
 *
 * 固件能力（config_apply.c / cmd.c 核实）：
 * - 读 config.get(['uart'])：uart_baudrate / uart_data_bits / uart_stop_bits /
 *   uart_parity_mode（**字符串** none|even|odd）/ uart_rx_gpio / uart_tx_gpio
 * - 写 config.set(uart 域)：uart_baudrate(1..4000000) / uart_data_bits(5..8) /
 *   uart_stop_bits(1..2) / uart_parity_mode（**数字** 0|2|3）
 *   生效方式 = CFG_EFFECT_SUBSYS（串口子系统重应用，不整机重启）
 * - RX/TX 引脚由固件固定，不可配置，只做展示
 *
 * 注意读写不对称：parity 读出来是字符串、写进去必须是数字，这里统一在
 * PARITY 表里做双向映射，避免把 "even" 当数字发下去被固件判非法。
 *
 * 收发窗口走 BLE DATA 通道（裸字节，无 ACK/重传）：能否到达串口取决于设备
 * 数据面路由 data_route_uart1 / data_route_ble，固件默认 UART1↔BLE↔MQTT。
 */

const BAUDS = [9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600];
const DATA_BITS = [5, 6, 7, 8];
const STOP_BITS = [1, 2];
/** parity：固件写侧是数字枚举，读侧是字符串 */
const PARITY = [
  { label: 'None', text: 'none', value: 0 },
  { label: 'Even', text: 'even', value: 2 },
  { label: 'Odd', text: 'odd', value: 3 },
];

const FMT_KEY = 'uart_console_fmt_v1';
const RX_CAP = 2048; // 接收缓冲上限（字节）；控制台只做人工观察，不做长期留档

function parityIndex(text) {
  for (let i = 0; i < PARITY.length; i++) {
    if (PARITY[i].text === text) return i;
  }
  return 0;
}

/** UTF-8 解码（小程序环境没有可靠的 TextDecoder，自己实现，非法字节用 · 代替） */
function utf8Decode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
    } else if (b >= 0xc0 && b < 0xe0 && i + 1 < bytes.length) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if (b >= 0xe0 && b < 0xf0 && i + 2 < bytes.length) {
      out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f));
      i += 3;
    } else if (b >= 0xf0 && i + 3 < bytes.length) {
      const cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
      out += String.fromCodePoint(cp);
      i += 4;
    } else {
      out += '·';
      i += 1;
    }
  }
  return out;
}

function utf8Encode(str) {
  const out = [];
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return out;
}

/** hex 渲染：每行 32 字节，便于人工对帧 */
function hexDump(bytes) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 32) {
    const chunk = [];
    for (let j = i; j < Math.min(i + 32, bytes.length); j++) {
      chunk.push(('0' + bytes[j].toString(16)).slice(-2).toUpperCase());
    }
    lines.push(chunk.join(' '));
  }
  return lines.join('\n');
}

/** 文本渲染：原样输出，行尾统一（保留设备侧换行） */
function plainDump(bytes) {
  return utf8Decode(bytes);
}

function dump(bytes, fmt) {
  return fmt === 'hex' ? hexDump(bytes) : plainDump(bytes);
}

/** 解析待发送数据：hex 模式忽略空白并按字节配对 */
function parseTx(text, fmt) {
  if (fmt === 'hex') {
    const clean = (text || '').replace(/\s+/g, '');
    if (clean.length === 0) return { bytes: [] };
    if (!/^[0-9a-fA-F]+$/.test(clean)) return { error: 'hex 模式只能输入 0-9/A-F 和空格' };
    if (clean.length % 2 !== 0) return { error: 'hex 位数必须是偶数（两个字符一个字节）' };
    const bytes = [];
    for (let i = 0; i < clean.length; i += 2) bytes.push(parseInt(clean.slice(i, i + 2), 16));
    return { bytes: bytes };
  }
  return { bytes: utf8Encode(text || '') };
}

Page({
  data: {
    ready: false,
    loggedIn: false,
    querying: false,
    saving: false,

    /* 探测结果（引脚由固件固定，只读） */
    rxGpio: '-',
    txGpio: '-',

    /* 串口参数表单 */
    baudLabels: BAUDS.map(String).concat(['自定义…']),
    baudIndex: 5, // 默认 115200，与固件默认值一致
    customBaud: '',
    isCustomBaud: false,
    dataBitsLabels: DATA_BITS.map(String),
    dataBitsIndex: 3,
    stopBitsLabels: STOP_BITS.map(String),
    stopBitsIndex: 0,
    parityLabels: PARITY.map(function (p) { return p.label; }),
    parityIndex: 0,

    /* 收发窗口 */
    fmtLabels: ['Plain（文本）', 'Hex（十六进制）'],
    rxFormat: 'plain',
    txFormat: 'plain',
    rxFmtIndex: 0,
    txFmtIndex: 0,
    rxText: '',
    rxBytes: 0,
    rxFrames: 0,
    rxScrollTo: '',
    txData: '',
    sending: false,

    saveResult: '',
    trace: '等待加载 UART 配置…',
    traceKind: '',

    logs: [],
    scrollTo: '',
  },

  onLoad() {
    let fmt = {};
    try {
      const raw = wx.getStorageSync(FMT_KEY);
      if (raw && typeof raw === 'object') fmt = raw;
    } catch (e) { /* 读不到就用默认 */ }
    const rxFormat = fmt.rx === 'hex' ? 'hex' : 'plain';
    const txFormat = fmt.tx === 'hex' ? 'hex' : 'plain';
    this.setData({
      rxFormat: rxFormat,
      txFormat: txFormat,
      rxFmtIndex: rxFormat === 'hex' ? 1 : 0,
      txFmtIndex: txFormat === 'hex' ? 1 : 0,
    });
    this._rxBuf = [];
    this._onData = (bytes) => this.appendRx(bytes);
  },

  onShow() {
    const ready = !!ble.connected;
    const loggedIn = ready && protocol.loggedIn;
    this.setData({ ready: ready, loggedIn: loggedIn });
    if (!ready) return;
    ble.on('data', this._onData);
    this.ensureDataSubscribed();
    if (loggedIn && !this._loaded && !this.data.querying) {
      this.onQuery();
    }
  },

  onHide() {
    ble.off('data', this._onData);
  },

  onUnload() {
    ble.off('data', this._onData);
  },

  /* ---------------- 日志 ---------------- */

  log(kind, text) {
    this._logSeq = (this._logSeq || 0) + 1;
    const logs = this.data.logs
      .concat([{ id: this._logSeq, kind: kind, t: stamp(), text: text }])
      .slice(-60);
    this.setData({ logs: logs, scrollTo: 'log-bottom' });
  },

  /* 复制日志：每行「时间  文本」，方便贴给硬件侧/存档 */
  onCopyLog() {
    const logs = this.data.logs || [];
    if (logs.length === 0) {
      wx.showToast({ title: '暂无日志可复制', icon: 'none' });
      return;
    }
    const text = logs.map(function (l) { return l.t + '  ' + l.text; }).join('\n');
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制 ' + logs.length + ' 行', icon: 'none' }),
    });
  },

  onClearLog() {
    this.setData({ logs: [] });
  },

  goDevice() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  /* ---------------- UART 配置：查询 ---------------- */

  async onQuery() {
    if (this.data.querying || busy.isBusy()) return;
    this.setData({ querying: true, saveResult: '' });
    try {
      const cfg = await protocol.configGet(['uart']);
      const u = (cfg && cfg.uart) || {};
      if (u.uart_baudrate === undefined) {
        this.setData({ querying: false, trace: '设备未返回 uart 域（固件版本过旧）', traceKind: 'err' });
        this.log('err', 'config.get(uart) 返回中没有 uart 域');
        return;
      }
      const baud = Number(u.uart_baudrate) || 0;
      const bits = Number(u.uart_data_bits) || 8;
      const stop = Number(u.uart_stop_bits) || 1;
      const pIdx = parityIndex(u.uart_parity_mode);

      const inList = BAUDS.indexOf(baud);
      const isCustom = inList < 0;

      this.setData({
        querying: false,
        rxGpio: 'GPIO' + (u.uart_rx_gpio !== undefined ? u.uart_rx_gpio : '-'),
        txGpio: 'GPIO' + (u.uart_tx_gpio !== undefined ? u.uart_tx_gpio : '-'),
        baudIndex: isCustom ? BAUDS.length : inList,
        customBaud: isCustom ? String(baud) : '',
        isCustomBaud: isCustom,
        dataBitsIndex: Math.max(0, DATA_BITS.indexOf(bits)),
        stopBitsIndex: Math.max(0, STOP_BITS.indexOf(stop)),
        parityIndex: pIdx,
        trace: '已加载设备当前 UART 配置',
        traceKind: 'ok',
      });
      /* 基线 = 设备当前值，保存时只发有差异的字段 */
      this._baseline = { baud: baud, dataBits: bits, stopBits: stop, parity: pIdx };
      this._loaded = true;
      this.log('sys', 'config.get(uart)：baud=' + baud + ' data=' + bits + ' stop=' + stop +
        ' parity=' + PARITY[pIdx].text + ' rx=GPIO' + u.uart_rx_gpio + ' tx=GPIO' + u.uart_tx_gpio);
    } catch (err) {
      const d = describe(err);
      this.setData({ querying: false, trace: '查询失败：' + d.text, traceKind: 'err' });
      this.log('err', 'config.get(uart) 失败 [' + d.code + '] ' + d.text);
      wx.showToast({ title: d.text, icon: 'none' });
    }
  },

  /* ---------------- 表单交互 ---------------- */

  onBaudChange(e) {
    const idx = Number(e.detail.value) || 0;
    const custom = idx >= BAUDS.length;
    this.setData({ baudIndex: idx, isCustomBaud: custom });
  },
  onCustomBaudInput(e) {
    this.setData({ customBaud: e.detail.value });
  },
  onDataBitsChange(e) {
    this.setData({ dataBitsIndex: Number(e.detail.value) || 0 });
  },
  onStopBitsChange(e) {
    this.setData({ stopBitsIndex: Number(e.detail.value) || 0 });
  },
  onParityChange(e) {
    this.setData({ parityIndex: Number(e.detail.value) || 0 });
  },

  /** 当前表单值 → 规范化数值（自定义波特率走输入框） */
  formValues() {
    const f = this.data;
    let baud = BAUDS[f.baudIndex];
    if (f.isCustomBaud) {
      baud = parseInt(f.customBaud, 10);
    }
    return {
      baud: baud,
      dataBits: DATA_BITS[f.dataBitsIndex],
      stopBits: STOP_BITS[f.stopBitsIndex],
      parity: f.parityIndex,
    };
  },

  /* ---------------- UART 配置：保存 ---------------- */

  async onSave() {
    if (this.data.saving || busy.isBusy()) return;
    const v = this.formValues();
    if (!(v.baud >= 1 && v.baud <= 4000000)) {
      wx.showToast({ title: '波特率必须是 1–4000000', icon: 'none' });
      this.setData({ trace: '波特率必须是 1–4000000', traceKind: 'err' });
      return;
    }
    const baseline = this._baseline || null;
    const patch = {};
    if (!baseline || v.baud !== baseline.baud) patch.uart_baudrate = v.baud;
    if (!baseline || v.dataBits !== baseline.dataBits) patch.uart_data_bits = v.dataBits;
    if (!baseline || v.stopBits !== baseline.stopBits) patch.uart_stop_bits = v.stopBits;
    /* 固件写侧要数字枚举 0/2/3，不能把 "none"/"even"/"odd" 发下去 */
    if (!baseline || v.parity !== baseline.parity) patch.uart_parity_mode = PARITY[v.parity].value;
    if (Object.keys(patch).length === 0) {
      wx.showToast({ title: '没有要保存的修改', icon: 'none' });
      return;
    }

    this.setData({ saving: true, saveResult: '' });
    this.log('sys', 'config.set(uart)：' + Object.keys(patch).join('、'));
    try {
      const resp = await protocol.configSet(patch);
      const changed = resp && resp.changed ? resp.changed.join('、') : '';
      const line =
        'saved=' + (resp && resp.saved ? 'true' : 'false') +
        ' · applied=' + (resp && resp.applied ? 'true' : 'false') +
        ' · restart_required=' + (resp && resp.restart_required ? 'true' : 'false') +
        ' · changed=[' + (changed || '无') + ']';
      /* 保存成功后基线跟进到已下发值：连点两次「保存」不应重复下发同一份差异 */
      if (!resp || resp.saved !== false) {
        this._baseline = { baud: v.baud, dataBits: v.dataBits, stopBits: v.stopBits, parity: v.parity };
      }
      this.setData({ saving: false, saveResult: line, trace: '配置已受理（串口子系统重应用）', traceKind: 'ok' });
      this.log('sys', 'config.set(uart) 完成：' + line);
      /* 串口重应用后回读一次，确认设备侧真的按新参数生效 */
      setTimeout(() => {
        if (this.data.ready && this.data.loggedIn && !this.data.querying) this.onQuery();
      }, 1200);
    } catch (err) {
      const d = describe(err);
      this.setData({ saving: false, trace: '保存失败：' + d.text, traceKind: 'err' });
      this.log('err', 'config.set(uart) 失败 [' + d.code + '] ' + d.text + (d.hint ? ' · ' + d.hint : ''));
      wx.showModal({ title: 'UART 配置失败', content: d.text + (d.hint ? '\n\n' + d.hint : ''), showCancel: false });
    }
  },

  /* ---------------- 收发窗口（BLE DATA 通道） ---------------- */

  async ensureDataSubscribed() {
    if (!ble.connected || !ble.hasChar('DATA_TX')) return;
    if (ble.isSubscribed('DATA_TX')) return;
    try {
      await ble.subscribe('DATA_TX');
    } catch (e) {
      this.log('err', 'DATA_TX 订阅失败：' + (e && e.message ? e.message : e));
    }
  },

  /** DATA 通道收到字节：缓冲并渲染（只做人工观察，超上限丢最旧） */
  appendRx(bytes) {
    if (!bytes || !bytes.length) return;
    const buf = this._rxBuf || (this._rxBuf = []);
    for (let i = 0; i < bytes.length; i++) buf.push(bytes[i]);
    if (buf.length > RX_CAP) buf.splice(0, buf.length - RX_CAP);
    const text = dump(buf, this.data.rxFormat);
    this.setData({
      rxText: text,
      rxBytes: buf.length,
      rxFrames: this.data.rxFrames + 1,
      rxScrollTo: 'rx-bottom',
    });
  },

  onClearRx() {
    this._rxBuf = [];
    this.setData({ rxText: '', rxBytes: 0, rxFrames: 0 });
  },

  /** 接收显示格式：本地偏好，存 storage（设备侧无此配置） */
  onRxFmtChange(e) {
    const idx = Number(e.detail.value) || 0;
    const fmt = idx === 1 ? 'hex' : 'plain';
    this.setData({ rxFmtIndex: idx, rxFormat: fmt, rxText: dump(this._rxBuf || [], fmt) });
    this.saveFmt();
  },

  onTxFmtChange(e) {
    const idx = Number(e.detail.value) || 0;
    this.setData({ txFmtIndex: idx, txFormat: idx === 1 ? 'hex' : 'plain' });
    this.saveFmt();
  },

  saveFmt() {
    try {
      wx.setStorageSync(FMT_KEY, { rx: this.data.rxFormat, tx: this.data.txFormat });
    } catch (e) { /* 存不下不影响功能 */ }
  },

  onTxInput(e) {
    this.setData({ txData: e.detail.value });
  },

  async onSend() {
    if (this.data.sending) return;
    if (!ble.connected) {
      wx.showToast({ title: '蓝牙未连接', icon: 'none' });
      return;
    }
    if (!ble.hasChar('DATA_RX')) {
      wx.showToast({ title: '当前链路没有 DATA 写特征', icon: 'none' });
      return;
    }
    const parsed = parseTx(this.data.txData, this.data.txFormat);
    if (parsed.error) {
      wx.showToast({ title: parsed.error, icon: 'none' });
      return;
    }
    if (!parsed.bytes.length) {
      wx.showToast({ title: '没有要发送的数据', icon: 'none' });
      return;
    }
    this.setData({ sending: true });
    try {
      await this.ensureDataSubscribed();
      await ble.write('DATA_RX', new Uint8Array(parsed.bytes));
      this.log('tx', '发送 ' + parsed.bytes.length + 'B（' + (this.data.txFormat === 'hex' ? 'hex' : 'plain') + '）：' +
        preview(parsed.bytes, this.data.txFormat));
    } catch (err) {
      const d = describe(err);
      this.log('err', '发送失败 [' + d.code + '] ' + d.text);
      wx.showToast({ title: d.text, icon: 'none' });
    } finally {
      this.setData({ sending: false });
    }
  },
});

/** 日志里的发送预览：只留前 24 字节，避免长报文刷屏 */
function preview(bytes, fmt) {
  const head = bytes.slice(0, 24);
  const body = fmt === 'hex'
    ? head.map(function (b) { return ('0' + b.toString(16)).slice(-2).toUpperCase(); }).join(' ')
    : utf8Decode(head);
  return body + (bytes.length > 24 ? ' …' : '');
}
