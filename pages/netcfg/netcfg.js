const { ble, protocol } = require('../../utils/session');
const { describe, LINK_ERROR_CODES } = require('../../utils/errors');
const { stamp, authText, authNeedsAttention, rssiBars, rssiText } = require('../../utils/util');
const { provisionWifi, cancelOperation, timelineReset, setStep, tl, timelineText } = require('../../utils/provision');
const pwstore = require('../../utils/pwstore');
const netdiag = require('../../utils/netdiag');
const busy = require('../../utils/busy');

/* DEF-SCAN-001 客户端缓解：单次 network.scan 占用射频 ~5.8s，逼近 BLE 6s 监督超时；
 * 连续背靠背扫描（≥6 次）会把链路饿死（LL response timeout 0x222，新旧固件同病）。
 * 扫描结束后冷却 3s 才允许下一次，阻断"连点刷新"这种用户可触发的背靠背形态。
 * 固件侧命令层节流（busy）落地后，此冷却可保留作为双保险。 */
const SCAN_COOLDOWN_MS = 3000;

Page({
  data: {
    ready: false,
    loggedIn: false,
    cfgInfo: null, // 固件 ≥1.3 的 cfg_state 解读（null=旧固件，不显示）
    scanning: false,
    aps: [],
    apCount: 0,
    selectedSsid: '',
    selectedOpen: false,
    selectedAuth: -1,
    password: '',
    passwordFilled: false, // true=口令来自本地记忆（自动回填），手动输入即清除
    running: false,
    phase: '',
    phaseKind: '', // idle | run | ok | warn | err
    opState: '',
    statusRows: [],
    status: null,
    verdict: null,
    verdictKind: 'idle',
    profiles: [],
    connSummary: '',
    residueWarn: '',
    diagText: '',
    diagging: false,
    lastSync: '',
    /* 静态 IP 表单：refreshStatus 从 config.get(network) 回填；用户编辑后置 _staticDirty 不再覆盖 */
    staticCfg: {
      loaded: false,
      enabled: false,
      ip: '',
      gateway: '',
      netmask: '255.255.255.0',
      dns: '',
      saving: false,
      verify: '',
    },
    errText: '',
    errHint: '',
    logs: [],
    scrollTo: '',
    /* SSID 口令弹窗：点扫描列表项即弹出，确认后就地开始配网。
       visible=明文切换（小眼睛）；savedNoPw=设备已保存该 Wi-Fi 但本机无口令记忆 */
    pwModal: {
      show: false,
      ssid: '',
      open: false,
      password: '',
      remembered: false,
      visible: false,
      /* 焦点必须独立成标志位：一旦让 focus 依赖口令内容，每输入一个字
         setData 都会把它从 true 算成 false，微信重应用 focus=false 就把键盘收起。 */
      focus: false,
      savedNoPw: false,
      err: '',
    },
    formPwVisible: false,
  },

  onShow() {
    const ready = !!ble.connected;
    const loggedIn = ready && protocol.loggedIn;
    this.setData({ ready: ready, loggedIn: loggedIn });
    if (ready && loggedIn) {
      this.refreshStatus();
    }
  },

  onUnload() {
    this._cancelled = true;
    busy.setBusy(false);
  },

  /* ---------------- 日志 ---------------- */

  log(kind, text) {
    this._logSeq = (this._logSeq || 0) + 1;
    const logs = this.data.logs
      .concat([{ id: this._logSeq, kind: kind, t: stamp(), text: text }])
      .slice(-120);
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

  /* ---------------- 状态 ---------------- */

  /**
   * 状态行。判读不用「sta_connected + 正式 sta_ssid」——
   * 自动回退时这两个都为 true/正式值，只有 connected_ssid 才是运行态真相。
   */
  buildStatusRows(st, profiles, formalSsid) {
    const rows = [];
    if (!st) return rows;
    const objs = profiles || this._profileObjs || [];
    /* 正式 SSID 以 config.get(network) 为准：network.status.sta_ssid 也是正式配置域，
       但两份都取一次可以互相校验，避免某一侧字段缺失时把回退网络当成正式网络。 */
    const formal = formalSsid !== undefined && formalSsid !== null ? formalSsid : this._formalSsid || '';
    const v = netdiag.classify(st, formal || st.sta_ssid || '', objs);
    const ipOk = netdiag.ipValid(st);

    rows.push({
      k: '当前链路',
      v: v.label,
      tone: v.kind === 'formal' ? 'ok' : v.kind === 'offline' ? 'err' : 'warn',
    });
    rows.push({
      k: '实际连接 SSID',
      v: v.connectedSsid || '未暴露（固件未提供 connected_ssid）',
      tone: v.connectedSsid ? (v.kind === 'fallback' ? 'err' : 'ok') : 'warn',
    });
    rows.push({ k: 'IP 地址', v: ipOk ? st.sta_ip : '未获取', tone: ipOk ? 'ok' : 'err' });
    rows.push({
      k: 'STA 关联',
      v: st.sta_connected ? (ipOk ? '已连接并拿到 IP' : '已关联，但未拿到 IP') : '未连接',
      tone: st.sta_connected ? (ipOk ? 'ok' : 'warn') : 'err',
    });
    if (v.formalSsid) rows.push({ k: '正式配置 SSID', v: v.formalSsid });
    rows.push({ k: '口令已设置', v: st.password_set ? '是' : '否' });
    rows.push({
      k: 'MQTT',
      v: st.mqtt_connected ? '已连接' : '未连接' + (st.mqtt_last_error ? ' · ' + st.mqtt_last_error : ''),
      tone: st.mqtt_connected ? 'ok' : 'err',
    });
    rows.push({
      k: '最近断开',
      v: (st.last_disconnect || '-') + '（' + netdiag.lastDisconnectText(st.last_disconnect) + '）',
      tone: !st.last_disconnect || st.last_disconnect === 'none' ? '' : 'warn',
    });
    if (v.profiles.length) {
      rows.push({ k: '已保存 profile', v: v.profiles.join('、') });
    }
    if (v.others.length) {
      rows.push({
        k: '回退候选',
        v: v.others.join('、') + '（非正式 profile，T4 救援前需删除）',
        tone: 'warn',
      });
    }
    if (v.residue.length) {
      rows.push({
        k: '测试残留',
        v: v.residue.join('、') + '（T4 压测遗留，同样会触发回退）',
        tone: 'warn',
      });
    }
    if (st.trial && st.trial.state) {
      rows.push({ k: '试连会话', v: st.trial.state + (st.trial.ssid ? ' · ' + st.trial.ssid : '') });
    }
    /* 固件 ≥1.3：配置状态与运行态的分离（静态 re-apply P0 字段） */
    const ci = netdiag.cfgStateInfo(st);
    if (ci) {
      rows.push({ k: '配置状态', v: ci.text, tone: ci.tone });
      if (ci.fallback) {
        rows.push({
          k: '持久配置',
          v: st.persistent_use_static && st.persistent_static_ip
            ? '静态 ' + st.persistent_static_ip + '（未生效）'
            : '未生效',
          tone: 'warn',
        });
      }
    }
    return rows;
  },

  async refreshStatus() {
    try {
      const st = await protocol.networkStatus();
      let formal = '';
      let netCfg = null;
      try {
        const cfg = await protocol.configGet(['network']);
        netCfg = (cfg && cfg.network) || null;
        formal = String((cfg && cfg.network && cfg.network.sta_ssid) || '').trim();
      } catch (e) {
        formal = ''; // config.get 失败时退回 network.status.sta_ssid，不阻断状态显示
      }
      this._formalSsid = formal;
      if (netCfg) {
        this._lastNetCfg = netCfg;
        this._applyStaticCfg(netCfg); // 顺带回填静态 IP 表单（用户未在编辑时）
      }
      let objs = [];
      try {
        objs = netdiag.profilesOf(await protocol.profileList());
      } catch (e) {
        objs = []; // profile.list 失败不影响状态显示
      }
      const v = netdiag.classify(st, formal || st.sta_ssid || '', objs);
      this._profileObjs = objs;
      this.setData({
        status: st,
        cfgInfo: netdiag.cfgStateInfo(st),
        profiles: v.profiles,
        verdict: v,
        verdictKind: v.kind === 'formal' ? 'ok' : v.kind === 'offline' ? 'err' : 'warn',
        connSummary: v.summary,
        residueWarn: v.residueWarn,
        statusRows: this.buildStatusRows(st, objs, formal),
        lastSync: stamp(),
        diagText: '',
      });
    } catch (err) {
      const d = describe(err);
      this.setData({ errText: d.text, errHint: d.hint });
      this.log('err', 'network.status 失败 [' + d.code + '] ' + d.text);
    }
  },

  onRefreshStatus() {
    if (!this.data.ready) return;
    this.refreshStatus();
    wx.showToast({ title: '已刷新', icon: 'none' });
  },

  /* ---------------- 网络诊断（可粘贴给固件/协议方） ---------------- */

  async onDiag() {
    if (!this.data.ready || this.data.diagging) return;
    if (!this.data.loggedIn) {
      wx.showToast({ title: '请先在「设备」页登录', icon: 'none' });
      return;
    }
    this.setData({ diagging: true, errText: '', errHint: '' });
    try {
      const d = await netdiag.collect({ ble: ble, protocol: protocol });
      const text = netdiag.renderText(d, {
        time: stamp(),
        deviceName: ble.deviceName,
        deviceId: ble.deviceId,
        sessionId: ble.sessionId,
        env: ble.envInfo(),
      });
      this.setData({
        diagText: text,
        status: d.status || this.data.status,
        verdict: d.verdict,
        verdictKind: d.verdict.kind === 'formal' ? 'ok' : d.verdict.kind === 'offline' ? 'err' : 'warn',
        connSummary: d.verdict.summary,
        residueWarn: d.verdict.residueWarn,
        statusRows: this.buildStatusRows(d.status || this.data.status, d.profiles, d.cfgSsid || ''),
        profiles: d.verdict.profiles,
      });
      this._profileObjs = d.profiles;
      this._formalSsid = d.cfgSsid || '';
      if (d.status) this.setData({ lastSync: stamp() });
      wx.setClipboardData({
        data: text,
        success: () => wx.showToast({ title: '诊断已复制', icon: 'none' }),
      });
      this.log('sys', '网络诊断：' + d.verdict.label + '（status + config + profile.list 已复制）');
    } catch (err) {
      const d = describe(err);
      this.log('err', '网络诊断失败 [' + d.code + '] ' + d.text);
      wx.showToast({ title: '诊断失败：' + d.text, icon: 'none' });
    } finally {
      this.setData({ diagging: false });
    }
  },

  onDiagCopy() {
    if (!this.data.diagText) {
      this.onDiag();
      return;
    }
    wx.setClipboardData({ data: this.data.diagText, success: () => wx.showToast({ title: '已复制', icon: 'none' }) });
  },

  /* ---------------- 静态 IP ----------------
   * 固件键名（config_apply.c 配置表 2026-11-06 核实）：写入与回读同名，全部是
   * net_mode / sta_use_static / sta_static_ip / sta_static_gateway / sta_static_netmask /
   * sta_static_dns1（dns2 可选）。此前用的 sta_ip_addr/sta_gateway/sta_netmask/sta_dns_addr
   * 在配置表里根本不存在，且固件对未知键是「静默忽略」（config_apply.c:770）——
   * 写新地址会静默保持旧地址，属于必须杜绝的陷阱。
   * 生效语义：net 域全部是 CFG_EFFECT_REBOOT → 成功响应必带 restart_required=true、
   * 设备 1.5s 后复位。此时绝不能内联回读（回读会落在重启窗口里，实测响应发到一半
   * 被复位截断）：必须走「等断开 → 等重新广播 → relink → 回读校验」流程。
   * 旧固件 v0 外壳无 restart_required 字段：维持内联回读（双轨兼容，回读失败按原样提示）。
   * v1 优先（args.patch）；旧固件 v1 拒 network 域 → 自动降级 v0 外壳重试一次；
   * v1-only 固件上 v0 入口不存在（unsupported_version）→ 按 v1 的原始错误上报。
   * 写入时若链路已失效（设备重启后旧 GATT 句柄的典型表现是 characteristic_missing，
   * 不是设备缺特征）：先自动 relink 一次再重试写入。
   * 运行态生效确认：network.status 的 sta_ip 与配置一致（重新关联需时间，最多等 25s）。
   * BLE 是独立控制面：即使 IP 配错导致 Wi-Fi 失联，本页仍可经 BLE 一键切回 DHCP，不会把设备写死。 */

  _ipv4Ok(s) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s || '').trim());
    if (!m) return false;
    return m.slice(1).every(function (x) {
      return +x >= 0 && +x <= 255;
    });
  },

  /* 固件对 sta_use_static 的回报形态不保证是布尔（ESP 配置存储常见 1/"1"/"true"），
     统一归一化后再判定，否则启用静态后回读会把开关弹回「关」，看起来像标识接反 */
  _staticFlag(v) {
    return v === true || v === 1 || v === '1' || v === 'true';
  },

  /* 默认值推导：优先冻结设备当前运行态 IP（改静态最常见的动机就是固定现址），
     网关取同网段 .1；无运行态 IP 时给通用兜底 */
  _staticDefaults() {
    const cur = String((this.data.status && this.data.status.sta_ip) || '').trim();
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(cur);
    if (m && cur !== '0.0.0.0') {
      return { ip: cur, gateway: m[1] + '.' + m[2] + '.' + m[3] + '.1', netmask: '255.255.255.0', dns: '' };
    }
    return { ip: '192.168.1.50', gateway: '192.168.1.1', netmask: '255.255.255.0', dns: '' };
  },

  _applyStaticCfg(net) {
    net = net || {};
    if (this._staticDirty) return; // 用户正在编辑：不覆盖表单
    const d = this._staticDefaults();
    this.setData({
      staticCfg: {
        loaded: true,
        enabled: this._staticFlag(net.sta_use_static),
        /* 设备处于 DHCP 模式时不回报静态键：空字段预填默认值，避免用户凭空猜地址 */
        ip: net.sta_static_ip || d.ip,
        gateway: net.sta_static_gateway || d.gateway,
        netmask: net.sta_static_netmask || d.netmask,
        dns: net.sta_static_dns1 || d.dns,
        saving: false,
        /* 保留已有的写入/生效结论（✔ 已生效 / ✘ 提示）：refreshStatus 每次状态刷新
           都会走这里回填表单，直接置空会把刚出的结论抹掉（用户永远看不到「已生效」）。
           用户编辑时由 onStaticSwitch/onStaticInput 单独清。 */
        verify: (this.data.staticCfg && this.data.staticCfg.verify) || '',
      },
    });
  },

  onStaticSwitch(e) {
    const on = !!e.detail.value;
    const patch = { 'staticCfg.enabled': on, 'staticCfg.verify': '' };
    /* 直接拨开关进入静态模式且表单为空时补默认值（loaded 前的初始态路径） */
    if (on && !String(this.data.staticCfg.ip || '').trim()) {
      const d = this._staticDefaults();
      patch['staticCfg.ip'] = d.ip;
      patch['staticCfg.gateway'] = d.gateway;
      patch['staticCfg.netmask'] = d.netmask;
      if (!String(this.data.staticCfg.dns || '').trim()) patch['staticCfg.dns'] = '';
    }
    this._staticDirty = true;
    this.setData(patch);
  },

  onStaticInput(e) {
    this._staticDirty = true;
    const f = e.currentTarget.dataset.field;
    if (!f) return;
    this.setData({ ['staticCfg.' + f]: e.detail.value, 'staticCfg.verify': '' });
  },

  onStaticReload() {
    this._staticDirty = false;
    this._applyStaticCfg(this._lastNetCfg);
    wx.showToast({ title: '已回读设备配置', icon: 'none' });
  },

  async onSaveStatic() {
    if (!this.data.ready || !this.data.loggedIn || this.data.staticCfg.saving) return;
    const c = this.data.staticCfg;
    const enable = !!c.enabled;
    const params = { net_mode: 'sta', sta_use_static: enable };
    let warn = '';
    if (enable) {
      const ip = String(c.ip || '').trim();
      const gw = String(c.gateway || '').trim();
      const nm = String(c.netmask || '').trim();
      const dns = String(c.dns || '').trim();
      if (!this._ipv4Ok(ip)) return this._staticErr('IP 地址格式不正确');
      if (!this._ipv4Ok(nm)) return this._staticErr('子网掩码格式不正确');
      if (!this._ipv4Ok(gw)) return this._staticErr('网关格式不正确');
      if (dns && !this._ipv4Ok(dns)) return this._staticErr('DNS 格式不正确（留空则不下发）');
      params.sta_static_ip = ip;
      params.sta_static_netmask = nm;
      params.sta_static_gateway = gw;
      if (dns) params.sta_static_dns1 = dns;
      // 同网段检查（按掩码逐字节与）：不同网段几乎必然导致失联
      const a = ip.split('.').map((x) => +x);
      const b = gw.split('.').map((x) => +x);
      const m = nm.split('.').map((x) => +x);
      const sameNet = a.every((x, i) => (x & m[i]) === (b[i] & m[i]));
      if (!sameNet) warn = '注意：IP 与网关不在同一网段，保存后设备大概率无法上网。';
    }
    wx.showModal({
      title: enable ? '启用静态 IP？' : '切回 DHCP？',
      content:
        (enable
          ? '设备将改用固定地址 ' + params.sta_static_ip + '，保存后设备会自动重启生效。'
          : '设备将恢复由路由器自动分配 IP，保存后设备会自动重启生效。') +
        (warn ? '\n\n' + warn : '') +
        '\n\n写错地址会导致 MQTT 断连，但 BLE 不受影响，随时可回本页改回。',
      confirmText: '确认写入',
      success: async (res) => {
        if (!res.confirm) return;
        await this._staticWrite(params, enable);
      },
    });
  },

  _staticErr(text) {
    this.setData({ 'staticCfg.verify': '✘ ' + text });
    this.log('err', '静态 IP：' + text);
  },

  /* 链路级失败码：设备重启后旧 GATT 句柄全失效，写/读都会落在这里。
   * characteristic_missing 不是「设备缺特征」，是本机句柄过期——重新发现服务即可。
   * 定义收敛到 errors.LINK_ERROR_CODES，验收页与本页共用一套，避免两处漂移。 */
  _linkErrCodes: LINK_ERROR_CODES,

  /* 自动重连一次：断开残留链路 → 扫描 → 连接 → 发现 → 订阅 → 重登。
   * 凭据用会话内存凭据（protocol.credentials，与 unauthorized 自动重登同源）。 */
  async _relinkOnce(reason) {
    this.log('sys', reason + '，尝试自动重连…');
    try {
      if (ble.connected) await ble.disconnect();
    } catch (e) { /* 已断则忽略 */ }
    const cred = protocol.credentials || {};
    const r = await ensureLink(ble, protocol, {
      target: { deviceId: ble.deviceId, name: ble.deviceName },
      username: cred.username,
      password: cred.password,
    });
    if (r.ok && r.loggedIn) {
      this.log('sys', '自动重连成功，已重新登录（' + r.ms + 'ms）');
      this.setData({ ready: true, loggedIn: true });
      return true;
    }
    this.log('err', '自动重连失败（stage=' + r.stage + '）：' + (r.error || r.code || '未知原因'));
    return false;
  },

  async _staticWrite(params, enable) {
    this.setData({ 'staticCfg.saving': true, 'staticCfg.verify': '' });
    this.log('sys', 'config.set：' + Object.keys(params).join('、'));
    let viaV0 = false;
    let resp = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        resp = await protocol.configSet(params); // v1：args.patch（v1-only 固件已放开 network 域）
        this.log('sys', 'config.set(v1) 已受理' + (resp && resp.restart_required ? '（restart_required=true，设备将重启生效）' : ''));
        break;
      } catch (err1) {
        const d1 = describe(err1);
        if (attempt === 1 && this._linkErrCodes.indexOf(d1.code) >= 0) {
          const rl = await this._relinkOnce('写入时链路已失效（' + d1.code + '，设备重启后旧句柄即此形态）');
          if (!rl) {
            this.setData({ 'staticCfg.saving': false });
            this._staticErr('写入失败：链路已失效且自动重连未成功，请手动重连设备后重试');
            return;
          }
          continue;
        }
        const v1Text = '[' + d1.code + '] ' + d1.text + (d1.hint ? ' · ' + d1.hint : '');
        try {
          resp = await protocol.sendRaw(JSON.stringify({ method: 'config.set', params: params }));
          viaV0 = true;
          this.log('sys', 'config.set(v0 外壳，旧固件) 已受理，回读确认…');
          break;
        } catch (err2) {
          const d2 = describe(err2);
          this.setData({ 'staticCfg.saving': false });
          this._staticErr(
            d2.code === 'unsupported_version'
              ? '写入失败 ' + v1Text + '（v1/v0 双轨均被拒）'
              : '写入失败 [' + d2.code + '] ' + d2.text + (d2.hint ? ' · ' + d2.hint : '')
          );
          return;
        }
      }
    }

    /* restart_required=true（net 域全是 CFG_EFFECT_REBOOT）：绝不能在这个窗口内联回读
     * ——设备 1.5s 后复位，21:43 实测内联回读的响应发到一半就被复位截断。
     * 走「等断开 → 等重新广播 → relink → 回读校验」流程。
     * v0 外壳（旧固件）响应无此字段：维持内联回读的双轨兼容路径。 */
    if (resp && resp.restart_required === true) {
      await this._staticWaitRebootAndVerify(params, enable, viaV0);
      return;
    }

    // ① 持久化确认：config.get 回读与写入一致（键名与固件 config.get 回报键同名）
    let readback = null;
    try {
      const cfg = await protocol.configGet(['network']);
      readback = (cfg && cfg.network) || {};
    } catch (e) {
      readback = null;
    }
    const want = params;
    const rbOk =
      readback &&
      this._staticFlag(readback.sta_use_static) === want.sta_use_static &&
      (!enable ||
        (readback.sta_static_ip === want.sta_static_ip &&
          readback.sta_static_gateway === want.sta_static_gateway &&
          readback.sta_static_netmask === want.sta_static_netmask));
    if (!rbOk) {
      this.setData({ 'staticCfg.saving': false });
      this._staticErr(
        '已受理但回读不一致（设备返回 ' +
          (readback
            ? 'sta_use_static=' + readback.sta_use_static + ' / sta_static_ip=' + (readback.sta_static_ip || '-')
            : 'config.get 失败') +
          '），配置可能未持久化，请重试'
      );
      return;
    }
    this._staticDirty = false;
    this._lastNetCfg = Object.assign({}, this._lastNetCfg || {}, readback);
    this._applyStaticCfg(readback);
    this.log('sys', '回读一致：配置已持久化' + (viaV0 ? '（v0 外壳）' : '（v1）'));
    // ② 运行态生效确认：启用时等 sta_ip 与配置一致（重新关联/DHCP→静态切换需时间）
    await this._staticWaitRuntime(params, enable, 15000, '配置已持久化，但 15s 内运行态未达到 ');
    this.refreshStatus();
  },

  /* restart_required 流程：等断开 → 等重新广播 → relink → 回读校验 → 运行态确认 */
  async _staticWaitRebootAndVerify(params, enable, viaV0) {
    this.log('sys', '设备计划重启使配置生效，等待重启完成（约 5–10s）…');
    this.setData({ 'staticCfg.verify': '…设备重启中，等待自动恢复' });
    // 等断开：设备收到响应 1.5s 后复位；本机断链事件最迟 ~6s 到（链路监督超时兜底）
    let down = !ble.connected;
    for (let i = 0; i < 24 && !down; i++) {
      await new Promise((r) => setTimeout(r, 500));
      down = !ble.connected;
    }
    // 等重新广播 + 重连 + 重登（ensureLink 自带 12s 扫描窗 + 退避复扫）
    const rl = await this._relinkOnce('设备已重启');
    if (!rl) {
      this.setData({ 'staticCfg.saving': false });
      this._staticErr(
        '设备已重启但自动重连未成功：配置大概率已写入并生效。请手动重连设备后回本页点「重新回读」核对'
      );
      return;
    }
    // 回读校验
    let readback = null;
    try {
      const cfg = await protocol.configGet(['network']);
      readback = (cfg && cfg.network) || {};
    } catch (e) {
      readback = null;
    }
    const want = params;
    const rbOk =
      readback &&
      this._staticFlag(readback.sta_use_static) === want.sta_use_static &&
      (!enable ||
        (readback.sta_static_ip === want.sta_static_ip &&
          readback.sta_static_gateway === want.sta_static_gateway &&
          readback.sta_static_netmask === want.sta_static_netmask));
    if (!rbOk) {
      this.setData({ 'staticCfg.saving': false });
      this._staticErr(
        '重启后回读不一致（设备返回 ' +
          (readback
            ? 'sta_use_static=' + readback.sta_use_static + ' / sta_static_ip=' + (readback.sta_static_ip || '-')
            : 'config.get 失败') +
          '），请重试'
      );
      return;
    }
    this._staticDirty = false;
    this._lastNetCfg = Object.assign({}, this._lastNetCfg || {}, readback);
    this._applyStaticCfg(readback);
    this.log('sys', '重启后回读一致：配置已持久化' + (viaV0 ? '（v0 外壳）' : '（v1）'));
    if (!enable) {
      this.setData({ 'staticCfg.saving': false, 'staticCfg.verify': '✔ 已切回 DHCP（设备已重启，配置已持久化，IP 由路由器重新分配）' });
      this.refreshStatus();
      return;
    }
    // 重启后要重新关联 Wi-Fi + 重连 MQTT，预算放宽到 25s
    await this._staticWaitRuntime(params, enable, 25000, '重启完成且配置已持久化，但 25s 内运行态未达到 ');
    this.refreshStatus();
  },

  /* 运行态生效确认：等 network.status 的 sta_ip 与配置一致。
   * budget 内联回读 15000ms / 重启流程 25000ms（重启后还要重新关联 + 重连 MQTT）。 */
  async _staticWaitRuntime(params, enable, budget, timeoutPrefix) {
    if (!enable) {
      this.setData({ 'staticCfg.saving': false, 'staticCfg.verify': '✔ 已切回 DHCP（配置已持久化，IP 由路由器重新分配）' });
      return;
    }
    const deadline = Date.now() + budget;
    let cur = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        cur = await protocol.networkStatus();
      } catch (e) {
        continue;
      }
      if (cur && cur.sta_has_ip && cur.sta_ip === params.sta_static_ip) break;
    }
    this.setData({ 'staticCfg.saving': false });
    if (cur && cur.sta_has_ip && cur.sta_ip === params.sta_static_ip) {
      this.setData({ 'staticCfg.verify': '✔ 已生效：运行态 IP=' + cur.sta_ip + (cur.mqtt_connected ? ' · MQTT 已连接' : ' · MQTT 未连接') });
      this.log('sys', '静态 IP 已生效：' + cur.sta_ip);
    } else {
      this.setData({
        'staticCfg.verify':
          timeoutPrefix + params.sta_static_ip + '（当前 sta_ip=' +
          ((cur && cur.sta_ip) || '-') + '）。设备可能仍在重新关联；若长期不生效，检查网段/网关后切回 DHCP 重试',
      });
      this.log('err', '静态 IP 运行态确认超时');
    }
  },

  /* ---------------- 已保存 profile ---------------- */

  onProfiles() {
    if (!this.data.ready) return;
    const names = this.data.profiles || [];
    wx.showActionSheet({
      itemList: ['查看 profile 列表', '清理非正式 profile（T4 救援前置）'],
      success: (res) => {
        if (res.tapIndex === 0) {
          const formal = (this.data.verdict && this.data.verdict.formalSsid) || '';
          const lines = names.length
            ? names.map(function (s) {
                return s + (s === formal ? '（正式）' : '（回退候选）');
              })
            : ['（列表为空或读取失败）'];
          wx.showModal({ title: '已保存 profile', content: lines.join('\n'), showCancel: false });
        } else {
          this.onCleanProfiles();
        }
      },
    });
  },

  onCleanProfiles() {
    const v = this.data.verdict;
    if (!v) return;
    const keep = v.formalSsid;
    if (!keep) {
      wx.showToast({ title: '设备没有正式 SSID，已中止', icon: 'none' });
      return;
    }
    if (!v.others.length) {
      wx.showToast({ title: '只有正式 profile，无需清理', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '删除其它 profile？',
      content:
        '将删除：' + v.others.join('、') + '\n只保留正式配置「' + keep + '」。\n\n' +
        '这是 T4 无 IP 救援的前置条件：不删的话关掉正式 AP 后设备会自动回退，测不到真正的断网。' +
        '删除后如需恢复，重新配网即可。',
      confirmText: '确认删除',
      confirmColor: '#d93025',
      success: async (res) => {
        if (!res.confirm) return;
        this.setData({ running: true });
        busy.setBusy(true);
        try {
          const r = await netdiag.cleanupProfiles({ protocol: protocol }, keep);
          this.log('sys', '清理 profile：删除 ' + (r.deleted.join('、') || '无') + (r.failed.length ? '；失败 ' + r.failed.join('、') : ''));
          wx.showToast({
            title: r.deleted.length ? '已删除 ' + r.deleted.length + ' 个' : '已是最简',
            icon: 'none',
          });
        } catch (err) {
          const d = describe(err);
          this.log('err', '清理 profile 失败 [' + d.code + '] ' + d.text);
          wx.showToast({ title: d.text, icon: 'none' });
        } finally {
          this.setData({ running: false });
          busy.setBusy(false);
          this.refreshStatus();
        }
      },
    });
  },

  /* ---------------- Wi-Fi 扫描 ---------------- */

  async onScanWifi() {
    if (this.data.scanning || this.data.running) return;
    if (Date.now() < (this._scanCooldownUntil || 0)) {
      const left = Math.ceil(((this._scanCooldownUntil - Date.now()) / 1000));
      wx.showToast({ title: '扫描刚结束，' + left + 's 后可再扫（连续扫描会挤掉 BLE 链路）', icon: 'none' });
      return;
    }
    if (!this.data.loggedIn) {
      wx.showToast({ title: '请先在「设备」页登录', icon: 'none' });
      return;
    }
    this.setData({ scanning: true, errText: '', errHint: '' });
    this.log('sys', 'network.scan 开始（可能需要数秒）');
    // 时间线从扫描开始激活：断链定因时覆盖 scan -> tryconnect -> apply 全程
    timelineReset();
    setStep('wifi_scan');
    try {
      const data = await protocol.networkScan();
      tl('scan_done', 'ap=' + (((data && data.aps) || []).length));
      const raw = (data && data.aps) || [];

      // 同名 SSID 多个 BSSID 时只留信号最强的一条
      const bySsid = {};
      raw.forEach(function (ap) {
        if (!ap || !ap.ssid) return; // 隐藏 SSID 无法选择
        const key = ap.ssid;
        const item = {
          ssid: ap.ssid,
          rssi: typeof ap.rssi === 'number' ? ap.rssi : -127,
          auth: typeof ap.auth === 'number' ? ap.auth : -1,
          bssid: ap.bssid || '',
          authText: authText(ap.auth),
          needsAttention: authNeedsAttention(ap.auth),
          open: ap.auth === 0,
        };
        if (!bySsid[key] || item.rssi > bySsid[key].rssi) {
          const count = bySsid[key] ? bySsid[key].count + 1 : 1;
          item.count = count;
          bySsid[key] = item;
        } else {
          bySsid[key].count += 1;
        }
      });

      const savedNames = {};
      (netdiag.ssidList(this._profileObjs || []) || []).forEach(function (s) {
        if (s) savedNames[s] = true;
      });

      const aps = Object.keys(bySsid)
        .map(function (k) {
          const ap = bySsid[k];
          ap.rssiText = rssiText(ap.rssi);
          ap.bars = rssiBars(ap.rssi);
          ap.saved = !!savedNames[k];
          return ap;
        })
        .sort(function (a, b) {
          return b.rssi - a.rssi;
        });

      this.log('sys', '扫描完成，' + aps.length + ' 个可见 Wi-Fi（原始 ' + raw.length + ' 条）');
      this.setData({ aps: aps, apCount: data.count || aps.length, scanning: false });
    } catch (err) {
      const d = describe(err);
      // busy 特判：errors.js 的通用文案是配网语义（"设备已有进行中的配网任务"），
      // 对扫描节流（DEF-SCAN-001 ②，距上次扫描结束 <3s）会误导，改为扫描语义。
      if (d.code === 'busy') {
        const t = '扫描太频繁，稍候 ' + Math.ceil(SCAN_COOLDOWN_MS / 1000) + 's 再试';
        this.setData({ scanning: false, errText: t, errHint: '连续扫描会挤掉 BLE 链路，设备已做 3s 节流' });
        this.log('warn', 'network.scan 被节流 [busy] ' + t);
        wx.showToast({ title: t, icon: 'none' });
      } else {
        this.setData({ scanning: false, errText: d.text, errHint: d.hint });
        this.log('err', 'network.scan 失败 [' + d.code + '] ' + d.text);
        wx.showToast({ title: d.text, icon: 'none' });
      }
    } finally {
      // 成败都进入冷却：扫描结束到下一次允许之间留出 BLE 让路窗口（DEF-SCAN-001）
      this._scanCooldownUntil = Date.now() + SCAN_COOLDOWN_MS;
    }
  },

  onSelectAp(e) {
    if (this.data.running) return;
    const index = e.currentTarget.dataset.index;
    const ap = this.data.aps[index];
    if (!ap) return;
    /* 之前配网成功过的 Wi-Fi：自动回填口令；开放网络无需口令 */
    const remembered = ap.open ? '' : pwstore.lookup(ap.ssid);
    this.setData({
      selectedSsid: ap.ssid,
      selectedOpen: ap.open,
      selectedAuth: ap.auth,
      password: remembered,
      passwordFilled: !!remembered,
      errText: '',
      errHint: '',
      /* 点选即弹出口令弹窗：确认后就地开始配网；取消则保留下方表单回退 */
      pwModal: {
        show: true,
        ssid: ap.ssid,
        open: !!ap.open,
        password: remembered,
        remembered: !!remembered,
        visible: false,
        /* 无记忆口令才自动抬键盘；有回填时不打扰（打开即能直接确认） */
        focus: !remembered && !ap.open,
        savedNoPw: !ap.open && !!ap.saved && !remembered,
        err: '',
      },
    });
    if (remembered) {
      this.log('sys', '「' + ap.ssid + '」之前配网成功过，已自动填入口令');
    } else if (!ap.open && ap.saved) {
      this.log('sys', '「' + ap.ssid + '」设备已保存，但本机没有口令记忆（口令在设备侧不可读），请手动输入');
    }
  },

  /* ---------------- SSID 口令弹窗 ---------------- */

  onPwModalInput(e) {
    const value = e.detail.value;
    /* 只更新口令本身：不碰 focus、不做多余字段 setData，避免每敲一个字触发整块重渲染 */
    const patch = { 'pwModal.password': value };
    if (this.data.pwModal.remembered) patch['pwModal.remembered'] = false;
    if (this.data.pwModal.err) patch['pwModal.err'] = '';
    this.setData(patch);
  },

  onPwModalCancel() {
    this.setData({ 'pwModal.show': false, 'pwModal.err': '', 'pwModal.visible': false, 'pwModal.focus': false });
  },

  /** 小眼睛：弹窗口令明文/掩码切换 */
  onPwModalToggleEye() {
    const visible = !this.data.pwModal.visible;
    /* 切换会重建 input 的 password 属性，部分机型会丢焦点：先放焦点再收回，保持继续输入 */
    const refocus = this.data.pwModal.show && !!this.data.pwModal.password;
    this.setData({ 'pwModal.visible': visible, 'pwModal.focus': refocus ? false : this.data.pwModal.focus });
    if (refocus) {
      const tick = (wx.nextTick || function (fn) { setTimeout(fn, 30); });
      tick(() => this.setData({ 'pwModal.focus': true }));
    }
  },

  /** 小眼睛：底部表单口令明文/掩码切换 */
  onFormPwToggleEye() {
    this.setData({ formPwVisible: !this.data.formPwVisible });
  },

  /** 阻止点击弹窗本体时触发遮罩的取消 */
  onPwModalStop() {},

  onPwModalConfirm() {
    const m = this.data.pwModal;
    if (!m.show || this.data.running) return;
    const password = m.password || '';
    if (!m.open && password.length < 8) {
      this.setData({ 'pwModal.err': 'WPA 口令至少 8 位' });
      return;
    }
    /* 同步到底部表单（保持回退可用），随后就地开始配网 */
    this.setData({
      'pwModal.show': false,
      'pwModal.visible': false,
      'pwModal.focus': false,
      password: password,
      passwordFilled: m.remembered && password.length > 0,
    });
    this.onStart();
  },

  onPassword(e) {
    this.setData({ password: e.detail.value, passwordFilled: false });
  },

  /* ---------------- 配网 ---------------- */

  async onStart() {
    if (this.data.running) return;
    const ssid = this.data.selectedSsid;
    if (!ssid) {
      wx.showToast({ title: '请先选择 Wi-Fi', icon: 'none' });
      return;
    }
    const password = this.data.password || '';
    if (!this.data.selectedOpen && password.length < 8) {
      wx.showToast({ title: 'WPA 口令至少 8 位', icon: 'none' });
      return;
    }

    this._cancelled = false;
    this.setData({
      running: true,
      phase: '正在发起试连…',
      phaseKind: 'run',
      opState: '',
      errText: '',
      errHint: '',
    });
    busy.setBusy(true);
    this.log('sys', '开始配网：' + ssid + '（口令不落日志）');

    try {
      const result = await provisionWifi(protocol, {
        ssid: ssid,
        password: password,
        isCancelled: () => this._cancelled,
        onProgress: (p) => {
          this.setData({
            phase: p.text,
            phaseKind: 'run',
            opState: p.state || this.data.opState,
          });
          if (p.status) {
            this.setData({ status: p.status, statusRows: this.buildStatusRows(p.status) });
          }
          if (p.state === 'got_ip') this.log('sys', 'operation got_ip（trial 有效期 300s）');
          if (p.state === 'failed') this.log('err', 'operation failed: ' + (p.error || '-'));
        },
      });

      if (result.pending) {
        const why = result.mismatch
          ? '设备拿到了 IP，但实际连的是「' + result.mismatch + '」而不是「' + ssid +
            '」——这是自动回退，不是本次配置生效。请检查目标 AP 口令/信号，或先清理其它 profile 再试'
          : '配置已保存，但设备尚未上报 IP，请稍后刷新状态';
        this.setData({
          running: false,
          phase: why,
          phaseKind: 'warn',
          status: result.status,
          statusRows: this.buildStatusRows(result.status),
        });
        this.log('err', result.mismatch ? 'apply 后仍连在 ' + result.mismatch + '（回退）' : 'apply 成功但等待 IP 超时，可能仍在 DHCP');
        this.refreshStatus();
      } else {
        const st = result.status || {};
        const v = netdiag.classify(st, ssid, this._profileObjs || []);
        const okFormal = v.kind === 'formal' || (v.kind === 'unknown' && !v.others.length);
        this.setData({
          running: false,
          phase:
            '配网完成：' + (st.sta_ip || '') +
            (okFormal ? ' · 已连到 ' + ssid : ' · ' + v.label) +
            (st.mqtt_connected ? ' · MQTT 已连接' : ' · MQTT 连接中'),
          phaseKind: okFormal ? 'ok' : 'warn',
          status: st,
          statusRows: this.buildStatusRows(st),
          lastSync: stamp(),
          password: '',
        });
        this.log('sys', '配网成功，IP=' + (st.sta_ip || '-') + ' mqtt=' + (st.mqtt_connected ? 1 : 0) + ' · ' + v.label);
        wx.showToast({ title: okFormal ? '配网成功' : '已配置，但未连到目标', icon: 'none' });
        this.refreshStatus();
      }
    } catch (err) {
      const d = describe(err);
      const cancelled = this._cancelled || d.code === 'aborted';
      this.setData({
        running: false,
        phase: cancelled ? '已取消' : '配网失败：' + d.text,
        phaseKind: cancelled ? 'warn' : 'err',
        errText: cancelled ? '' : d.text,
        errHint: cancelled ? '' : d.hint,
      });
      this.log('err', (cancelled ? '已取消' : '配网失败') + ' [' + d.code + '] ' + d.text);
      // 断链/超时定因取证：把整条时间线落进页面日志（与串口日志对时用）
      if (!cancelled) this.log('sys', '配网时间线：\n' + timelineText());

      if (!cancelled) {
        // 口令错误时清空输入，方便用户重填
        if (d.code === 'wrong_password') this.setData({ password: '' });
        wx.showToast({ title: d.text, icon: 'none' });

        // 协议 §8.9：失败/退出时清理活动 operation，避免占着唯一的活动槽
        if (d.code === 'timeout' || d.code === 'disconnected' || d.code === 'network_failed') {
          cancelOperation(protocol, protocol.lastOperationId)
            .then(() => this.log('sys', '已清理未完成的活动 operation'))
            .catch(() => {});
        }
      }
      this.refreshStatus();
    } finally {
      busy.setBusy(false);
    }
  },

  async onCancel() {
    this._cancelled = true;
    const opId = protocol.lastOperationId;
    this.log('sys', '请求取消 operation ' + (opId || '(无)'));
    try {
      await cancelOperation(protocol, opId);
      this.log('sys', 'network.cancel 已发送');
    } catch (err) {
      const d = describe(err);
      this.log('err', '取消失败 [' + d.code + '] ' + d.text);
    }
    this.setData({ running: false, phase: '已取消', phaseKind: 'warn' });
    busy.setBusy(false);
  },

  /* ---------------- 配置核对 ---------------- */

  async onConfigGet() {
    if (!this.data.ready) return;
    try {
      const cfg = await protocol.configGet(['network', 'mqtt']);
      this.log('sys', 'config.get ok：net_mode=' + ((cfg.network && cfg.network.net_mode) || '-'));
      wx.showModal({
        title: '设备配置',
        content: this.summarizeConfig(cfg),
        showCancel: false,
        confirmText: '知道了',
      });
    } catch (err) {
      const d = describe(err);
      this.log('err', 'config.get 失败 [' + d.code + '] ' + d.text);
      wx.showToast({ title: d.text, icon: 'none' });
    }
  },

  summarizeConfig(cfg) {
    const n = (cfg && cfg.network) || {};
    const m = (cfg && cfg.mqtt) || {};
    const lines = [
      'net_mode: ' + (n.net_mode || '-'),
      'sta_ssid: ' + (n.sta_ssid || '(空)'),
      'sta_password_set: ' + (n.sta_password_set ? 'true' : 'false'),
      'sta_use_static: ' + (n.sta_use_static ? 'true' : 'false'),
      'sta_connected: ' + (n.sta_connected ? 'true' : 'false'),
      'sta_has_ip: ' + (n.sta_has_ip ? 'true' : 'false'),
      'sta_ip: ' + (n.sta_ip || '-'),
      'mqtt.enabled: ' + (m.enabled === undefined ? '-' : m.enabled),
    ];
    /* 固件 ≥1.3：cfg_state/persistent_* 有值才带进诊断（旧固件不占行） */
    if (n.cfg_state) {
      lines.push('cfg_state: ' + n.cfg_state);
      if (n.persistent_use_static !== undefined) {
        lines.push('persistent_use_static: ' + n.persistent_use_static);
      }
      if (n.persistent_static_ip) {
        lines.push('persistent_static_ip: ' + n.persistent_static_ip);
      }
    }
    if (n.sta_use_static) {
      lines.push('ip: ' + (n.sta_static_ip || n.sta_ip || '-'));
      lines.push('gw: ' + (n.sta_static_gateway || '-'));
      lines.push('mask: ' + (n.sta_static_netmask || '-'));
    }
    return lines.join('\n');
  },
});
