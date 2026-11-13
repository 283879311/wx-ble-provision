const { ble, protocol } = require('../../utils/session');
const { describe } = require('../../utils/errors');
const { stamp } = require('../../utils/util');

Page({
  data: {
    ready: false,
    loggedIn: false,
    querying: false,
    btRows: [],
    btVerdict: null, // { kind: 'ok'|'warn'|'err', text }
    btNote: '固件 config.set(bluetooth) 暂未开放：本页仅查询。BLE 角色、设备名等参数变更需设备侧配合。',
    lastSync: '',
  },

  onShow() {
    const ready = !!ble.connected;
    const loggedIn = ready && protocol.loggedIn;
    this.setData({ ready: ready, loggedIn: loggedIn });
    if (ready && loggedIn && this.data.btRows.length === 0 && !this.data.querying) {
      this.onBtQuery();
    }
  },

  goDevice() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  /**
   * 查询 config.get(['bluetooth'])：
   * bt_role / bt_device_name / runtime_mode / adv_active / connected / adv_retry_count / last_error。
   * adv_retry_count 来自广播看门狗（>0 = 曾自动恢复广播），判读见 buildVerdict。
   */
  async onBtQuery() {
    if (this.data.querying) return;
    if (!this.data.ready || !this.data.loggedIn) {
      wx.showToast({ title: '请先连接并登录设备', icon: 'none' });
      return;
    }
    this.setData({ querying: true });
    try {
      const cfg = await protocol.configGet(['bluetooth']);
      const b = (cfg && cfg.bluetooth) || null;
      const rows = [];
      if (b) {
        rows.push({ k: '配置角色 bt_role', v: b.bt_role || '-' });
        rows.push({ k: '设备名', v: b.bt_device_name || '-' });
        rows.push({
          k: '运行角色 runtime_mode',
          v: b.runtime_mode || '-',
          tone: b.runtime_mode && b.bt_role && b.runtime_mode !== b.bt_role ? 'warn' : '',
        });
        rows.push({
          k: '广播中 adv_active',
          v: b.adv_active ? 'true' : 'false',
          tone: b.adv_active ? 'ok' : 'warn',
        });
        rows.push({
          k: '连接中 connected',
          v: b.connected ? 'true' : 'false',
          tone: b.connected ? 'ok' : '',
        });
        rows.push({
          k: '看门狗介入次数 adv_retry_count',
          v: b.adv_retry_count !== undefined ? String(b.adv_retry_count) : '字段缺失',
          tone: b.adv_retry_count > 0 ? 'warn' : 'ok',
        });
        rows.push({
          k: '最近错误 last_error',
          v: b.last_error || '（无）',
          tone: b.last_error ? 'err' : 'ok',
        });
      }
      this.setData({
        btRows: rows,
        btVerdict: this.buildVerdict(b),
        querying: false,
        lastSync: stamp(),
      });
    } catch (err) {
      const d = describe(err);
      this.setData({
        querying: false,
        btRows: [],
        btVerdict: { kind: 'err', text: '查询失败 [' + d.code + '] ' + d.text },
        lastSync: stamp(),
      });
    }
  },

  /**
   * 判读（不武断）：
   * - adv_retry_count > 0：看门狗曾介入并成功恢复广播——偶发属预期行为；
   *   持续增长/反复出现才指向广播稳定性问题（串口 diag 行 adv=/conn=/role= 佐证）。
   * - adv_active=false 且 connected=false：若无主机在连，符合 BLE 静默缺陷特征。
   * - adv_retry_count=0 只是「读到的即时值为 0」，不代表从未介入。
   */
  buildVerdict(b) {
    if (!b) {
      return { kind: 'warn', text: '固件未返回 bluetooth 域（版本过旧或字段缺失）。' };
    }
    const parts = [];
    let kind = 'ok';
    const n = b.adv_retry_count;
    if (n > 0) {
      parts.push('看门狗曾介入 ' + n + ' 次：广播曾被自动重启并恢复。偶发属预期恢复行为；若计数持续增长或反复出现，按设备侧广播稳定性排查（串口 diag 30s dump 行 adv=/conn=/role= 佐证）。');
      kind = 'warn';
    } else if (n === 0) {
      parts.push('本次读到看门狗介入计数为 0：未发现介入痕迹（即时值，不代表从未介入）。');
    }
    if (!b.adv_active && !b.connected) {
      parts.push('设备当前未广播且无连接：若无主机在连，符合 BLE 静默缺陷特征，建议复位设备并抓串口日志。');
      kind = 'err';
    } else if (!b.adv_active && b.connected) {
      parts.push('当前有连接、未广播：正常（连接态可停广播，视固件策略）。');
    }
    if (b.last_error) {
      parts.push('设备上报最近错误：' + b.last_error);
      kind = 'err';
    }
    if (!parts.length) parts.push('BLE 运行状态正常。');
    return { kind: kind, text: parts.join(' ') };
  },
});
