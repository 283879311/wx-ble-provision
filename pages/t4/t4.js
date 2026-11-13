/**
 * T4 · 功能自检（自 pages/accept 迁出，**逻辑未改**）。
 *
 * 迁移动机：验收中心页长度已经失控（15+ 张卡），拆成 hub + 子页
 * 才能继续挂新测试。这里只搬代码，不改任何判定与取证流程。
 */
const { ble, protocol } = require('../../utils/session');
const {
  CHECKS,
  runCheck,
  runAll,
  skipRest,
  buildReport,
  scanDisconnected,
  skipReason,
  STATE_TEXT: MODEL_TEXT,
  stateOf,
  tierOf,
  verdictOf,
} = require('../../utils/acceptance');
const netdiag = require('../../utils/netdiag');
const { DEFAULT_USERNAME } = require('../../utils/config');
const { describe } = require('../../utils/errors');
const core = require('../../utils/accept-core');
const store = require('../../utils/accept-store');

/* v2（2026-11-08）：条目显示 5 状态；内部 status 仍保留 pass/fail/expected/skip，
 * 由 stateOf 投影，避免老存档/自测读数断裂。 */
const STATUS_TEXT = Object.assign({ idle: '未运行', running: '进行中' }, MODEL_TEXT);

Page(Object.assign({}, core.shared, {
  data: {
    ready: false,
    loggedIn: false,
    linking: false,
    linkText: '',
    busy: false,
    defaultUser: DEFAULT_USERNAME,
    deviceId: '',
    deviceName: '',
    sessionId: 0,
    /* T4 */
    running: false,
    items: [],
    report: '',
    verdict: '',
    verdictKind: '',
    summary: { pass: 0, expected: 0, fail: 0, skip: 0 },
  },

  onLoad() {
    this._resetItems();
  },

  onShow() {
    this._syncState();
  },

  /** 结果摘要回写 hub（只存计数，不存完整报告：storage 单键上限吃紧） */
  _saveSummary(partial) {
    const s = this.data.summary;
    store.save('t4', {
      pass: s.pass,
      expected: s.expected,
      fail: s.fail,
      /* 存档沿用 skip 字段名（旧存档可读）；值=三个未完成状态之和 */
      skip: (s.not_run || 0) + (s.incomplete || 0) + (s.blocked || 0),
      verdict: this.data.verdict,
      verdictKind: this.data.verdictKind,
      partial: !!partial,
    });
  },

  /* ---------------- T4 · 功能自检 ---------------- */

  _resetItems() {
    // 2026-10-27/28：apply/rescue/bothos/mtu/pwdchange（page:'t3'）迁 T3 人工测试页，T4 只留可自动取证项
    const items = CHECKS.filter(function (c) {
      return c.page !== 't3';
    }).map(function (c, i) {
      return {
        no: i + 1,
        id: c.id,
        name: c.name,
        desc: c.desc,
        p0: tierOf(c) === 'p0',
        tier: tierOf(c),
        scope: c.scope || 't4a',
        manual: !!c.manual,
        manualHint: c.manualHint || '',
        status: 'idle',
        state: 'idle',
        statusText: STATUS_TEXT.idle,
        detail: '',
        reason: '',
        ms: 0,
      };
    });
    this.setData({
      items: items,
      report: '',
      verdict: '',
      verdictKind: '',
      summary: { pass: 0, expected: 0, fail: 0, not_run: 0, incomplete: 0, blocked: 0 },
    });
  },

  /**
   * 结论：v2（2026-11-08）统一走 acceptance.verdictOf。
   * 页面不再自写一套分级——v1 曾出现「页面说待重跑、报告说不可签收」的漂移。
   */
  _verdictOf(items, partial) {
    return verdictOf(items, { partial: partial });
  },

  _apply(results) {
    const byId = {};
    results.forEach(function (r) {
      byId[r.id] = r;
    });
    const items = this.data.items.map(function (it) {
      const r = byId[it.id];
      if (!r) return it;
      const st = stateOf(r);
      return Object.assign({}, it, {
        status: r.status,
        state: st,
        statusText: STATUS_TEXT[st] || r.status,
        detail: r.detail || '',
        reason: r.reason || (r.status === 'skip' ? skipReason(r) : ''),
        blockedBy: r.blockedBy || '',
        ms: r.ms || 0,
      });
    });
    const summary = { pass: 0, expected: 0, fail: 0, not_run: 0, incomplete: 0, blocked: 0 };
    items.forEach(function (it) {
      if (summary[it.state] !== undefined) summary[it.state] += 1;
    });
    // 还在跑的时候不要给结论：中间态会把「未执行的项」当成通过
    const running = items.some(function (it) {
      return it.status === 'running';
    });
    const partial = items.some(function (it) {
      return it.status === 'idle';
    });
    const v = running ? { text: '', kind: '' } : this._verdictOf(items, partial);
    this.setData({ items: items, summary: summary, verdict: v.text, verdictKind: v.kind });
    if (!running) this._saveSummary(partial);
  },

  _mark(id, patch) {
    const items = this.data.items.map(function (it) {
      if (it.id !== id) return it;
      const next = Object.assign({}, it, patch);
      if (patch.status) {
        next.state = patch.status === 'running' ? 'running' : stateOf(next);
        next.statusText = patch.status === 'running' ? STATUS_TEXT.running : STATUS_TEXT[next.state] || patch.status;
      }
      return next;
    });
    this.setData({ items: items });
  },

  async onRunAll() {
    if (this._anyRunning()) return;

    const connectedAtStart = !!ble.connected;
    // 第 1 项只有在断开状态才有证据。已连接时先问一次，避免又跑出 EXPECTED。
    let disconnectFirst = false;
    if (connectedAtStart) {
      disconnectFirst = await new Promise((resolve) => {
        wx.showModal({
          title: '第 1 项需要断开状态',
          content:
            'T4 要求扫描在连接前做；连接态扫描 0 台只能记 EXPECTED，不算证据。\n\n' +
            '「断开后跑」= 自动断开 → 等设备重新广播 → 扫描 → 重连 → 跑其余 14 项（多约 10 秒）。',
          confirmText: '断开后跑',
          cancelText: '保持连接',
          success: (r) => resolve(!!r.confirm),
          fail: () => resolve(false),
        });
      });
    }

    this._resetItems();
    this.setData({ running: true });
    this._syncBusy();
    /* C：跑批起点打标——报告据此取「本批」报文（设备页 onHide 后 onLog 为 null，
       但协议层环形留档照旧记录，见 protocol._log）。 */
    this._logMark = protocol.logMark();
    const ctxLive = () => this._ctx();
    const onUpdate = (id, status) => this._mark(id, { status: status });
    // 第 1 项由本方法自己完成（断开态直接扫 / 先断开再扫），其余项不再重复跑
    const scanHandledHere = !connectedAtStart || disconnectFirst;

    try {
      let results = [];

      if (!connectedAtStart) {
        // 断开状态：第 1 项就是真证据，不需要「先建立连接」
        this._mark('scan', { status: 'running' });
        const prep = await scanDisconnected(ctxLive());
        const scanResult = Object.assign(
          { id: 'scan', name: 'BLE 扫描与发现', p0: true, ms: prep.ms || 0 },
          prep.result
        );
        results.push(scanResult);
        this._apply(results);

        // 扫完自动把链路建起来，否则其余项无从取证
        const link = await this._autoLink({ scanTimeout: 12000 });
        if (!link.ok) {
          results = results.concat(
            skipRest('自动连接失败，本项未执行：' + (link.error || '未知原因'), ['scan'])
          );
          this._apply(results);
          this.setData({ report: buildReport(results, this._meta()) });
          wx.showModal({
            title: link.linked ? '已连接但登录失败' : '自动连接失败',
            content:
              (link.error || '') +
              '\n\n第 1 项已取证；其余项记为 SKIP（不计入 PASS）。' +
              '\n可回设备页手动连接/登录后回来重跑，或点「仅连接并登录」重试。',
            showCancel: false,
          });
          return;
        }
      } else if (disconnectFirst) {
        this._mark('scan', { status: 'running' });
        const prep = await scanDisconnected(ctxLive());
        const scanResult = Object.assign(
          { id: 'scan', name: 'BLE 扫描与发现', p0: true, ms: prep.ms || 0 },
          prep.result
        );
        results.push(scanResult);
        this._apply(results);
        if (!prep.restored) {
          wx.showModal({
            title: '重连失败',
            content:
              '第 1 项已取证，但重连未能恢复' + (prep.restoreErr ? '：' + prep.restoreErr : '') +
              '。其余项会记为 SKIP，请回设备页重新连接后单独运行。',
            showCancel: false,
          });
        }
      }

      // 已连接但没 token：先自动登录，避免一堆项都返回 unauthorized
      if (ble.connected && !protocol.loggedIn) {
        const lg = await this._autoLogin();
        if (!lg.ok) {
          results = results.concat(
            skipRest('未登录（默认账号 ' + DEFAULT_USERNAME + ' 登录失败：' + lg.error + '），本项未执行', ['scan'])
          );
          this._apply(results);
          this.setData({ report: buildReport(results, this._meta()) });
          wx.showModal({
            title: '登录失败',
            content: lg.error + '\n\n请在设备页确认管理员账号密码后重新登录；其余项记为 SKIP。',
            showCancel: false,
          });
          return;
        }
      }

      const rest = await runAll(ctxLive(), onUpdate, scanHandledHere ? { except: ['scan'] } : null);
      results = results.concat(rest);
      this._apply(results);
      this.setData({ report: buildReport(results, this._meta()) });
      const failed = results.filter(function (r) {
        return r.status === 'fail';
      }).length;
      wx.showToast({ title: failed ? failed + ' 项 FAIL' : '自检完成', icon: 'none' });
    } catch (err) {
      wx.showToast({ title: '自检中断：' + (err.message || err), icon: 'none' });
    } finally {
      this.setData({ running: false });
      this._syncBusy();
      this._syncState();
    }
  },

  async onRunOne(e) {
    if (this._anyRunning()) return;
    const index = e.currentTarget.dataset.index;
    const item = this.data.items[index];
    if (!item) return;

    if (item.manual) {
      wx.showModal({
        title: '第 ' + item.no + ' 项：' + item.name,
        content: item.manualHint,
        confirmText: '去配网',
        cancelText: '知道了',
        success: (res) => {
          if (res.confirm) this.goProvision();
        },
      });
      return;
    }

    // 扫描项本来就要在断开态跑；其余项缺链路就先自动连上，不再把用户赶回设备页
    if (item.id !== 'scan') {
      if (!ble.connected) {
        const link = await this._autoLink();
        if (!link.ok) return;
      }
      if (!protocol.loggedIn) {
        const lg = await this._autoLogin();
        if (!lg.ok) {
          wx.showToast({ title: '登录失败：' + lg.error, icon: 'none' });
          return;
        }
      }
    }

    this.setData({ running: true });
    this._syncBusy();
    this._logMark = protocol.logMark(); // C：单项也要能从报告追到本条报文
    this._mark(item.id, { status: 'running', detail: '' });
    try {
      const r = await runCheck(item.id, this._ctx());
      // _apply 会按 items 重新统计 summary，这里不要再累加一次
      this._apply(
        this.data.items.map(function (it) {
          return it.id === r.id ? r : { id: it.id, status: it.status, detail: it.detail, ms: it.ms };
        })
      );
      this._reportFromItems(true);
    } catch (err) {
      this._apply([{ id: item.id, status: 'fail', detail: '异常：' + (err.message || err), ms: 0 }]);
    } finally {
      this.setData({ running: false });
      this._syncBusy();
      this._syncState();
    }
  },

  /** 由当前 items 重新生成报告（partial=true 表示只跑了部分项） */
  _reportFromItems(partial) {
    const meta = this._meta();
    if (partial) meta.partial = true;
    const results = this.data.items.map(function (it) {
      const idle = it.status === 'idle' || it.status === 'running';
      return {
        id: it.id,
        name: it.name,
        p0: it.p0,
        tier: it.tier,
        scope: it.scope,
        status: idle ? 'skip' : it.status,
        detail: idle ? '未运行' : it.detail,
        /* blockedBy 要跟着回写，否则单项重出报告时阻塞项只剩「未填解除条件」 */
        blockedBy: it.blockedBy || '',
        /* 未运行按「证据不完整」计入，避免漏掉 partial 标志时被当成可签收 */
        reason: idle ? 'incomplete' : it.reason || '',
        ms: it.ms,
      };
    });
    this.setData({ report: buildReport(results, meta) });
  },


  /** 顶部一键导出网络诊断（status + config + profile.list），用于粘贴给固件侧 */
  async onNetDiag() {
    if (this._anyRunning()) return;
    if (!(await this._ensureForManual())) return;
    try {
      const d = await netdiag.collect(this._ctx());
      const v = d.verdict;
      this._netLine =
        v.label + ' · connected_ssid=' + (v.connectedSsid || '未暴露') +
        ' · sta_ip=' + ((d.status && d.status.sta_ip) || '-') +
        ' · mqtt_connected=' + (v.mqtt ? 'true' : 'false') +
        ' · last_disconnect=' + ((d.status && d.status.last_disconnect) || '-') +
        ' · 正式 sta_ssid=' + (v.formalSsid || '(空)') +
        (v.others.length ? ' · 其它 profile=' + v.othersText : '');
      const text = netdiag.renderText(d, this._meta());
      wx.setClipboardData({
        data: text,
        success: () => wx.showToast({ title: '诊断已复制', icon: 'none' }),
      });
    } catch (err) {
      const d2 = describe(err);
      wx.showToast({ title: '诊断失败：' + d2.text, icon: 'none' });
    }
  },

  onCopyReport() {
    if (!this.data.report) {
      wx.showToast({ title: '先运行一次自检', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: this.data.report,
      success: () => wx.showToast({ title: '报告已复制', icon: 'none' }),
    });
  },

  /* ---------------- T5 · 长稳韧性 ---------------- */
}));
