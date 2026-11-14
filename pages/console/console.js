const { ble, protocol } = require('../../utils/session');
const { describe } = require('../../utils/errors');
const { stamp } = require('../../utils/util');
const { equals } = require('../../utils/bytes');

const PRESETS = [
  { label: 'device.info', text: '{"cmd":"device.info","args":{}}' },
  { label: 'network.status', text: '{"cmd":"network.status","args":{}}' },
  { label: 'io.get', text: '{"cmd":"io.get","args":{}}' },
  { label: 'config.get(all)', text: '{"cmd":"config.get","args":{}}' },
  { label: 'config.get(network)', text: '{"cmd":"config.get","args":{"domains":["network"]}}' },
  { label: 'network.scan', text: '{"cmd":"network.scan","args":{}}' },
  { label: 'profile.list', text: '{"cmd":"network.profile.list","args":{}}' },
  { label: 'loopback on', text: '{"cmd":"data.loopback","args":{"enabled":true}}' },
  { label: 'loopback off', text: '{"cmd":"data.loopback","args":{"enabled":false}}' },
  // v1-only 固件：network/静态 IP 走 v1 args.patch（v1-only_迁移进度 2026-11-04）；
  // 旧固件如需 v0 外壳对照，请手动发 {"method":"config.set","params":{...}}
  {
    label: 'config.set 静态IP',
    text:
      '{"version":"1.0","cmd":"config.set","args":{"patch":{"net_mode":"sta","sta_use_static":true,' +
      '"sta_static_ip":"192.168.1.50","sta_static_gateway":"192.168.1.1","sta_static_netmask":"255.255.255.0"}}}',
  },
];

Page({
  data: {
    connected: false,
    loggedIn: false,
    presets: PRESETS,
    input: PRESETS[0].text,
    sending: false,
    logs: [],
    scrollTo: '',
    stats: { notifyCount: 0, notifyBytes: 0, fragments: '-', chunks: 0, objects: 0, dataFrames: 0 },
    dataSubscribed: false,
    dataResult: '',
    dataResultKind: '',
  },

  onLoad() {
    this._onData = (bytes) => this.collectData(bytes);
  },

  onShow() {
    protocol.onLog = (dir, text, extra) => this.logProtocol(dir, text, extra);
    // G1：会话被作废时给出可见提示（协议层日志已落 logProtocol）
    protocol.onSessionInvalidated = () => {
      this.setData({ loggedIn: false });
      wx.showToast({ title: '会话已失效，请重新登录', icon: 'none' });
    };
    ble.on('data', this._onData);
    this.setData({
      connected: ble.connected,
      loggedIn: protocol.loggedIn,
      dataSubscribed: ble.isSubscribed('DATA_TX'),
    });
    this.updateStats();
    this._statsTimer = setInterval(() => this.updateStats(), 1000);
  },

  onHide() {
    protocol.onLog = null;
    protocol.onSessionInvalidated = null;
    ble.off('data', this._onData);
    this.clearStatsTimer();
  },

  onUnload() {
    protocol.onLog = null;
    protocol.onSessionInvalidated = null;
    ble.off('data', this._onData);
    this.clearStatsTimer();
  },

  clearStatsTimer() {
    if (this._statsTimer) {
      clearInterval(this._statsTimer);
      this._statsTimer = null;
    }
  },

  /* ---------------- 日志 ---------------- */

  log(kind, text) {
    this._logSeq = (this._logSeq || 0) + 1;
    const logs = this.data.logs
      .concat([{ id: this._logSeq, kind: kind, t: stamp(), text: text }])
      .slice(-200);
    this.setData({ logs: logs, scrollTo: 'log-bottom' });
  },

  logProtocol(dir, text, extra) {
    const kind = dir === 'tx' ? 'tx' : extra && extra.error ? 'err' : 'rx';
    this.log(kind, (dir === 'tx' ? '→ ' : '← ') + (text.length > 500 ? text.slice(0, 500) + ' …' : text));
  },

  onClearLog() {
    this.setData({ logs: [] });
  },

  onCopyLog() {
    const text = this.data.logs
      .map(function (l) {
        return l.t + ' ' + l.text;
      })
      .join('\n');
    if (!text) {
      wx.showToast({ title: '暂无日志', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制', icon: 'none' }),
    });
  },

  /* ---------------- 统计 ---------------- */

  updateStats() {
    const fs = ble.fragmentStats();
    this.setData({
      connected: ble.connected,
      loggedIn: protocol.loggedIn,
      dataSubscribed: ble.isSubscribed('DATA_TX'),
      stats: {
        notifyCount: ble.stats.notifyCount,
        notifyBytes: ble.stats.notifyBytes,
        fragments: fs.count ? fs.min + '~' + fs.max + '（均 ' + fs.avg + '）' : '-',
        chunks: ble.stats.chunksWritten,
        objects: ble.stats.objects,
        dataFrames: ble.stats.dataFrames,
      },
    });
  },

  /* ---------------- 原始命令 ---------------- */

  onInput(e) {
    this.setData({ input: e.detail.value });
  },

  onPickPreset(e) {
    const index = e.currentTarget.dataset.index;
    const preset = PRESETS[index];
    if (!preset) return;
    this.setData({ input: preset.text });
  },

  async onSend() {
    if (this.data.sending) return;
    if (!ble.connected) {
      wx.showToast({ title: '蓝牙未连接', icon: 'none' });
      return;
    }
    this.setData({ sending: true });
    try {
      const data = await protocol.sendRaw(this.data.input);
      this.log('sys', '✔ 返回 ' + JSON.stringify(data).slice(0, 500));
    } catch (err) {
      const d = describe(err);
      this.log('err', '✘ [' + d.code + '] ' + d.text);
    } finally {
      this.setData({ sending: false });
      this.updateStats();
    }
  },

  async onRelogin() {
    try {
      await protocol.relogin();
      this.log('sys', '重新登录成功');
      this.setData({ loggedIn: true });
    } catch (err) {
      const d = describe(err);
      this.log('err', '重新登录失败 [' + d.code + '] ' + d.text);
      wx.showToast({ title: '请到「设备」页登录', icon: 'none' });
    }
  },

  /* ---------------- DATA 通道 ---------------- */

  async ensureDataSubscribed() {
    if (ble.isSubscribed('DATA_TX')) return true;
    await ble.subscribe('DATA_TX');
    this.log('sys', '已订阅 DATA TX(0003)');
    this.setData({ dataSubscribed: true });
    return true;
  },

  collectData(bytes) {
    if (!this._dataExpect) return;
    const merged = new Uint8Array((this._dataGot ? this._dataGot.length : 0) + bytes.length);
    if (this._dataGot) merged.set(this._dataGot, 0);
    merged.set(bytes, this._dataGot ? this._dataGot.length : 0);
    this._dataGot = merged;
  },

  async onLoopback(e) {
    const enabled = e.currentTarget.dataset.enabled === true || e.currentTarget.dataset.enabled === 'true';
    try {
      const data = await protocol.dataLoopback(enabled);
      this.log('sys', 'data.loopback=' + enabled + ' → ' + JSON.stringify(data));
    } catch (err) {
      const d = describe(err);
      this.log('err', 'data.loopback 失败 [' + d.code + '] ' + d.text);
    }
  },

  /**
   * DATA 回环测试：写入 N 字节，等 DATA TX 回来，逐字节比较。
   * 注意：DATA 无帧头/序号/ACK，失败是已知边界，不代表协议异常。
   */
  async onDataTest(e) {
    if (!ble.connected) {
      wx.showToast({ title: '蓝牙未连接', icon: 'none' });
      return;
    }
    const size = Number(e.currentTarget.dataset.size) || 20;
    this.setData({ dataResult: '进行中…', dataResultKind: '' });

    try {
      await this.ensureDataSubscribed();
      await protocol.dataLoopback(true);

      const payload = new Uint8Array(size);
      for (let i = 0; i < size; i++) payload[i] = (i * 7 + 13) & 0xff;

      this._dataExpect = payload;
      this._dataGot = new Uint8Array(0);

      const t0 = Date.now();
      await ble.write('DATA_RX', payload);
      const arrived = await this.waitData(size, 3000);
      const elapsed = Date.now() - t0;

      if (!arrived) {
        this.setData({
          dataResult: '超时：写入 ' + size + 'B，3s 内未回环（' + this._dataGot.length + 'B）',
          dataResultKind: 'err',
        });
        this.log('err', 'DATA ' + size + 'B 回环超时');
      } else {
        const ok = equals(payload, this._dataGot.slice(0, size));
        this.setData({
          dataResult: (ok ? 'PASS' : 'FAIL') + '：' + size + 'B / 收到 ' + this._dataGot.length + 'B / ' + elapsed + 'ms',
          dataResultKind: ok ? 'ok' : 'err',
        });
        this.log(ok ? 'sys' : 'err', 'DATA ' + size + 'B 逐字节比对 ' + (ok ? '一致' : '不一致'));
      }

      this._dataExpect = null;
      await protocol.dataLoopback(false);
      this.log('sys', '已关闭 data.loopback');
    } catch (err) {
      const d = describe(err);
      this._dataExpect = null;
      this.setData({ dataResult: '异常：' + d.text, dataResultKind: 'err' });
      this.log('err', 'DATA 测试失败 [' + d.code + '] ' + d.text);
    }
    this.updateStats();
  },

  waitData(size, timeoutMs) {
    const self = this;
    return new Promise(function (resolve) {
      const started = Date.now();
      const tick = function () {
        if (self._dataGot && self._dataGot.length >= size) {
          resolve(true);
          return;
        }
        if (Date.now() - started > timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(tick, 40);
      };
      tick();
    });
  },
});
