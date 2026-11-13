const { ble, protocol } = require('../../utils/session');
const { describe } = require('../../utils/errors');
const { stamp } = require('../../utils/util');
const busy = require('../../utils/busy');

/**
 * backend 三选项，与固件 mqtt.c 对齐：
 * - tb_cloud    ThingsBoard 云（固件默认值，v1/devices/me/* 主题）
 * - tb_selfhost 自建 ThingsBoard（同上主题）
 * - custom      通用自定义（固件对非 tb_* 值统一走 iothub/telemetry 等通用主题）
 */
const BACKENDS = ['tb_cloud', 'tb_selfhost', 'custom'];
const BACKEND_LABELS = ['ThingsBoard 云（tb_cloud）', '自建 ThingsBoard（tb_selfhost）', '通用自定义（custom）'];

/** 下拉索引：设备侧未知值（固件按通用主题处理）映射到 custom */
function backendIndex(v) {
  const i = BACKENDS.indexOf(v);
  return i >= 0 ? i : 2;
}

Page({
  data: {
    ready: false,
    loggedIn: false,
    mqttQuerying: false,
    mqttRows: [],
    mqttSaving: false,
    mqttResult: '',
    backendLabels: BACKEND_LABELS,
    mqttForm: { backendIndex: 0, host: '', port: '', useTls: false, token: '', clearToken: false },
    logs: [],
    scrollTo: '',
  },

  onShow() {
    const ready = !!ble.connected;
    const loggedIn = ready && protocol.loggedIn;
    this.setData({ ready: ready, loggedIn: loggedIn });
    if (ready && loggedIn && this.data.mqttRows.length === 0 && !this.data.mqttQuerying) {
      this.onMqttQuery();
    }
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

  /* ---------------- MQTT 服务器：查询与配置 ---------------- */

  /**
   * 查询 config.get(['mqtt']) + network.status：
   * 配置段（backend/host/port/use_tls/token_set）+ 运行态（connected/publish_count/outbox/last_error）。
   * 查完把可编辑项回填进表单（token 设备侧只暴露 token_set，永远不回显）。
   */
  async onMqttQuery() {
    if (this.data.mqttQuerying || busy.isBusy()) return;
    this.setData({ mqttQuerying: true, mqttResult: '' });
    try {
      const [cfg, st] = await Promise.all([
        protocol.configGet(['mqtt']),
        protocol.networkStatus().catch(() => null),
      ]);
      const m = (cfg && cfg.mqtt) || {};
      this.log('sys', 'config.get(mqtt)：host=' + (m.mqtt_host || '-') + ' port=' + (m.mqtt_port || '-') +
        ' tls=' + (m.mqtt_use_tls ? 1 : 0) + ' token=' + (m.mqtt_token_set ? '已设' : '未设'));
      const rows = [];
      rows.push({
        k: '连接状态',
        v: m.connected ? '已连接' : '未连接' + (m.last_error ? ' · ' + m.last_error : ''),
        tone: m.connected ? 'ok' : 'err',
      });
      rows.push({ k: 'backend', v: m.mqtt_backend || '-' });
      rows.push({ k: 'host', v: m.mqtt_host || '-' });
      rows.push({ k: 'port', v: m.mqtt_port !== undefined ? String(m.mqtt_port) : '-' });
      rows.push({ k: 'TLS', v: m.mqtt_use_tls ? '开启' : '关闭' });
      rows.push({ k: 'token', v: m.mqtt_token_set ? '已设置（不回显）' : '未设置', tone: m.mqtt_token_set ? '' : 'warn' });
      rows.push({ k: 'publish 计数', v: m.publish_count !== undefined ? String(m.publish_count) : '-' });
      rows.push({ k: 'outbox 积压', v: m.outbox !== undefined ? String(m.outbox) : '-' });
      if (st) {
        rows.push({
          k: 'network.status 侧',
          v: st.mqtt_connected ? 'mqtt_connected=true' : 'mqtt_connected=false' + (st.mqtt_last_error ? ' · ' + st.mqtt_last_error : ''),
          tone: st.mqtt_connected ? 'ok' : 'err',
        });
      }
      this.setData({
        mqttRows: rows,
        mqttQuerying: false,
        mqttForm: {
          backendIndex: backendIndex(m.mqtt_backend),
          host: m.mqtt_host || '',
          port: m.mqtt_port !== undefined ? String(m.mqtt_port) : '',
          useTls: !!m.mqtt_use_tls,
          token: '',
          clearToken: false,
        },
      });
      /* 查询回填后表单基线 = 设备当前值：保存时只发有差异的字段，use_tls 也只在此前提下下发。
         设备侧非三选项的值（固件按通用主题处理）映射到 custom 展示，基线也用映射值比较。 */
      this._mqttQueried = true;
      this._backendTouched = false;
      this._mqttBaseline = {
        backend: BACKENDS[backendIndex(m.mqtt_backend)],
        backendRaw: m.mqtt_backend || '',
        host: m.mqtt_host || '',
        port: m.mqtt_port !== undefined ? String(m.mqtt_port) : '',
        useTls: !!m.mqtt_use_tls,
      };
    } catch (err) {
      const d = describe(err);
      this.setData({ mqttQuerying: false });
      this.log('err', 'config.get(mqtt) 失败 [' + d.code + '] ' + d.text);
      wx.showToast({ title: d.text, icon: 'none' });
    }
  },

  /** backend 下拉：选中即视为主动修改（保存时才可能下发） */
  onMqttBackendChange(e) {
    const idx = Number(e.detail.value) || 0;
    this._backendTouched = true;
    this.setData({ 'mqttForm.backendIndex': idx });
  },
  onMqttHostInput(e) { this.setData({ 'mqttForm.host': e.detail.value }); },
  onMqttPortInput(e) { this.setData({ 'mqttForm.port': e.detail.value }); },
  onMqttTokenInput(e) { this.setData({ 'mqttForm.token': e.detail.value }); },
  onMqttTlsChange(e) { this.setData({ 'mqttForm.useTls': !!e.detail.value }); },
  onMqttClearTokenChange(e) { this.setData({ 'mqttForm.clearToken': !!e.detail.value }); },

  /**
   * 写入：v1 config.set 优先（10-25 固件源码口径：mqtt 域 v1 可写）。
   * 真机 11-03 实测 v1 带 mqtt_token 被拒 invalid_argument——烧录固件的 config.set
   * 可能只开放 v0 外壳（静态 IP 同款教训：v1 拒 network 域、v0 外壳通过）。
   * 策略：v1 失败且错误码为 invalid_argument/unknown_command 时，v0 外壳重试一次。
   */
  async _writeMqttConfig(patch) {
    try {
      return { resp: await protocol.configSet(patch), viaV0: false };
    } catch (err) {
      const code = (err && err.code) || '';
      if (code !== 'invalid_argument' && code !== 'unknown_command') throw err;
      this.log('sys', 'v1 config.set 被拒[' + code + ']，改走 v0 外壳重试一次');
      try {
        const resp = await protocol.sendRaw(JSON.stringify({ method: 'config.set', params: patch }));
        this.log('sys', 'v0 外壳写入已受理');
        return { resp: resp, viaV0: true };
      } catch (err2) {
        if ((err2 && err2.code) === 'unsupported_version') {
          /* v1-only 固件：v0 入口整体不存在 → 按原始 v1 错误上报，不误导为版本问题 */
          throw err;
        }
        throw err2;
      }
    }
  },

  /**
   * 保存 config.set(mqtt 域)：生效方式=子系统重连（applied=true，不整机重启）。
   * 固件 empty_keeps：host/backend/token 留空 = 保留原值，所以只发非空字段；
   * token_clear=true 时单独发（清空已存 token）。
   */
  async onMqttSave() {
    if (this.data.mqttSaving || busy.isBusy()) return;
    const f = this.data.mqttForm;
    const patch = {};
    /* baseline = 查询时的设备值：有基线只发差异字段，无基线只发非空输入（保守） */
    const baseline = this._mqttQueried ? (this._mqttBaseline || null) : null;
    const backend = BACKENDS[f.backendIndex] || BACKENDS[0];
    const host = (f.host || '').trim();
    const port = (f.port || '').trim();
    /* 粘贴的 token 常带尾随空格/换行：真机对参数校验严格，先 trim 再本地拦截非可打印 ASCII */
    const token = (f.token || '').trim();
    if (token && !/^[\x21-\x7E]+$/.test(token)) {
      wx.showToast({ title: 'token 需为不含空格/中文的可打印字符', icon: 'none' });
      return;
    }
    /* backend 只有在下拉里主动改过、且与基线（未知值按映射后比较）不同才下发，
       避免未查询时把默认 tb_cloud 误发上去 */
    if (this._backendTouched && (!baseline || backend !== baseline.backend)) patch.mqtt_backend = backend;
    if (host && (!baseline || host !== baseline.host)) patch.mqtt_host = host;
    if (port) {
      const p = parseInt(port, 10);
      if (!(p >= 1 && p <= 65535)) {
        wx.showToast({ title: '端口必须是 1–65535', icon: 'none' });
        return;
      }
      if (!baseline || port !== baseline.port) patch.mqtt_port = p;
    }
    if (baseline && !!f.useTls !== !!baseline.useTls) patch.mqtt_use_tls = !!f.useTls;
    if (token) patch.mqtt_token = token;
    if (f.clearToken) patch.token_clear = true;
    if (token && f.clearToken) {
      wx.showToast({ title: '「填新 token」和「清除 token」二选一', icon: 'none' });
      return;
    }
    if (Object.keys(patch).length === 0) {
      wx.showToast({ title: '没有要保存的修改', icon: 'none' });
      return;
    }

    this.setData({ mqttSaving: true, mqttResult: '' });
    this.log('sys', 'config.set(mqtt)：' + Object.keys(patch).join('、') + (patch.mqtt_token ? '（token 已脱敏）' : ''));
    try {
      const w = await this._writeMqttConfig(patch);
      const resp = w.resp;
      const changed = resp && resp.changed ? resp.changed.join('、') : '';
      const line = w.viaV0
        ? '已按 v0 外壳写入（v1 被固件拒绝后自动降级）；连接结果以「查询」运行态为准'
        : 'saved=' + (resp && resp.saved ? 'true' : 'false') +
          ' · applied=' + (resp && resp.applied ? 'true' : 'false') +
          ' · restart_required=' + (resp && resp.restart_required ? 'true' : 'false') +
          ' · changed=[' + (changed || '无') + ']';
      this.setData({ mqttSaving: false, mqttResult: line });
      this.log('sys', 'config.set(mqtt) 完成：' + line);
      /* MQTT 子系统在设备侧重连需要一点时间：2.5s 后自动复查一次运行态 */
      setTimeout(() => {
        if (this.data.ready && this.data.loggedIn && !this.data.mqttQuerying) {
          this.onMqttQuery();
        }
      }, 2500);
    } catch (err) {
      const d = describe(err);
      this.setData({ mqttSaving: false });
      const extra =
        d.code === 'invalid_argument'
          ? '若反复出现：①确认 token 无多余字符；②烧录固件的键位可能与源码口径不一致，可在「调试」页发 config.get 看设备实际返回的 mqtt 键名。'
          : '';
      this.log('err', 'config.set(mqtt) 失败 [' + d.code + '] ' + d.text + (d.hint ? ' · ' + d.hint : ''));
      wx.showModal({
        title: 'MQTT 配置失败',
        content: d.text + (d.hint ? '\n\n' + d.hint : '') + (extra ? '\n\n' + extra : ''),
        showCancel: false,
      });
    }
  },
});
