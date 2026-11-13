/**
 * T3 · 人工测试：功能自测中无法自动完成的部分 + T4 迁入的人工配合卡。
 *
 * 两块内容：
 *   A. 页面级人工走查（host-only 的 page-* mock 断言在真机上的等价人工项）
 *      与需要真实环境的操作核对（切后台恢复、脱敏目视检查等）；
 *   B. 自 T4 迁入的 8 张人工配合卡（acceptance.js CHECKS 里 page:'t3' 的项）：
 *      #13 成功配网与 apply、#14 网络救援、#15 双端证据（拆成 iOS/Android 两张卡）、
 *      切设备 A→B 走查、并发 401 走查（2026-10-29 配合清单转入）、#19 权限/MTU 记录、
 *      #16 受控改密卡——都必须人工配合真实 Wi-Fi / 上游 AP / 口令 / 第二台设备，无法自动取证。
 *   与 T4/T5/stress 的自动取证项不重复；摘要（PASS/FAIL 计数）入 accept-store。
 */
const core = require('../../utils/accept-core');
const store = require('../../utils/accept-store');
const { ble, protocol } = require('../../utils/session');
const { ensureLink } = require('../../utils/link');
const { describe } = require('../../utils/errors');
const { stamp } = require('../../utils/util');
const netdiag = require('../../utils/netdiag');
const BleManager = require('../../utils/ble');
const {
  CHECKS,
  verifyApply,
  rescueCapture,
  rescueCleanup,
  rescueVerify,
  pwdChangeControlled,
  skip,
  blocked,
  pass,
  fail,
  stateOf,
  STATE_TEXT,
} = require('../../utils/acceptance');
const probe401 = require('../../utils/probe401');

const STATUS = ['待测', 'PASS', 'FAIL', 'N/A'];

/** 走查/配合卡状态的跨页持久化键：去配网中心/设备页再回来不丢已测结果 */
const STATE_KEY = 't3_state_v1';

function saveState(snap) {
  try {
    wx.setStorageSync(STATE_KEY, snap);
  } catch (e) { /* 存储满：持久化只是便利功能，不影响当页使用 */ }
}

function loadState() {
  try {
    const v = wx.getStorageSync(STATE_KEY);
    return v && typeof v === 'object' ? v : null;
  } catch (e) {
    return null;
  }
}

function clearState() {
  try {
    wx.removeStorageSync(STATE_KEY);
  } catch (e) { /* ignore */ }
}

/* v2（2026-11-08）：人工卡也走 5 状态。skip 一律显示 NOT_RUN，
 * 只有人显式声明「客观条件不具备」才是 BLOCKED（带解除条件），
 * 避免 BLOCKED 变成永远不重试的黑洞。 */
const MANUAL_STATUS_TEXT = Object.assign(
  { idle: '未运行', running: '进行中', skip: 'NOT_RUN' },
  STATE_TEXT
);

const ITEMS = [
  {
    id: 'nav',
    name: '验收中心导航走查',
    steps: '从验收中心依次进入 T4 / T5 / 压测 / 本页并返回；先跑任一子页再看 hub 摘要',
    expect: '四张入口卡可达、返回正常；hub 摘要计数随子页运行刷新',
    from: 'page-accept（34 项 mock 断言的真机等价）',
  },
  {
    id: 'provision',
    name: '配置页状态流转走查',
    steps: '配置中心完整走一遍：扫描 → 选 AP → 输口令 → accepted → got_ip → apply；再故意输错口令走一遍失败路径',
    expect: '每步提示与实际一致；失败有明确文案与建议（口令错误不误导为内部错误）',
    from: 'page-provision（105 项 mock 断言的真机等价）',
  },
  {
    id: 'stress-ui',
    name: '压测页交互走查',
    steps: '压测页选参数、生成命令、跑一轮短压测；运行中切到「设备」tab 再切回来',
    expect: '参数与命令生成含 runId；切页不中断压测；回来后进度与状态还原',
    from: 'page-stress（37 项 mock 断言的真机等价）',
  },
  {
    id: 'console',
    name: '调试控制台走查',
    steps: '调试页发送 device.info 与 network.status，目视检查请求/响应日志方向、id 配对与脱敏',
    expect: 'tx/rx 方向正确；日志无口令与 token 明文（tx 行只有 hasToken 布尔）',
    from: 'session/netdiag 自测无法覆盖的目视脱敏确认',
  },
  {
    id: 'background',
    name: '切后台 / 回前台链路恢复',
    steps: '连接登录后把小程序切到后台约 30 秒，再回前台；观察链路状态提示与恢复路径',
    expect: '状态提示与实际链路一致；断链时给出明确提示且重连后自动重新登录',
    from: '真机生命周期行为，上位机无法模拟',
  },
];

Page(Object.assign({}, core.shared, {
  data: {
    ready: false,
    loggedIn: false,
    linking: false,
    linkText: '',
    busy: false,
    running: false,
    deviceId: '',
    deviceName: '',
    sessionId: 0,
    items: [],
    statusOptions: STATUS,
    manuals: [],
    rescueHint: '',
    reconnecting: false,
  },

  onLoad() {
    this.setData({
      items: ITEMS.map((it) => Object.assign({}, it, { status: '待测', note: '' })),
      manuals: CHECKS.filter((c) => c.page === 't3').map((c) => ({
        id: c.id,
        name: c.name,
        desc: c.desc,
        manualHint: c.manualHint || '',
        status: 'idle',
        state: 'idle',
        statusText: MANUAL_STATUS_TEXT.idle,
        detail: '',
        blockedBy: '',
        ms: 0,
      })),
    });
    this._restore();
  },

  /** 从 storage 恢复上次进度（按 id 合并，CHECKS/ITEMS 变更后自动只取交集） */
  _restore() {
    const snap = loadState();
    if (!snap) return;
    if (Array.isArray(snap.items)) {
      const saved = {};
      snap.items.forEach((it) => { if (it && it.id) saved[it.id] = it; });
      this.setData({
        items: this.data.items.map((it) => {
          const s = saved[it.id];
          if (!s) return it;
          return Object.assign({}, it, {
            status: STATUS.indexOf(s.status) >= 0 ? s.status : '待测',
            note: typeof s.note === 'string' ? s.note : '',
          });
        }),
      });
    }
    if (Array.isArray(snap.manuals)) {
      const saved = {};
      snap.manuals.forEach((m) => { if (m && m.id) saved[m.id] = m; });
      this.setData({
        manuals: this.data.manuals.map((m) => {
          const s = saved[m.id];
          if (!s) return m;
          /* running 只可能来自上次页面被销毁时的中断：回落未运行，保留 detail 供查看 */
          const st = s.status === 'running' ? 'idle' : s.status;
          return Object.assign({}, m, {
            status: st,
            state: st === 'skip' ? 'not_run' : st,
            statusText: MANUAL_STATUS_TEXT[st] || MANUAL_STATUS_TEXT.idle,
            detail: typeof s.detail === 'string' ? s.detail : '',
            /* v2：BLOCKED 必须带着解除条件一起恢复，否则就成了无出路的黑洞 */
            blockedBy: typeof s.blockedBy === 'string' ? s.blockedBy : '',
            ms: typeof s.ms === 'number' ? s.ms : 0,
          });
        }),
      });
    }
    if (snap.rescue && typeof snap.rescue === 'object') {
      this._rescueSnapshot = snap.rescue;
      this.setData({
        rescueHint:
          '已恢复上次断网现场 · 目标「' + (snap.rescue.ssid || '-') + '」· 可直接点「验证救援」（会等最多 20s）',
      });
    }
  },

  /** 把当前进度写进 storage：任何状态变化与配合卡结束后都调用 */
  _persist() {
    saveState({
      items: this.data.items.map((it) => ({ id: it.id, status: it.status, note: it.note })),
      manuals: this.data.manuals.map((m) => ({ id: m.id, status: m.status, detail: m.detail, ms: m.ms, blockedBy: m.blockedBy || '' })),
      rescue: this._rescueSnapshot || null,
      at: Date.now(),
    });
  },

  onShow() {
    this._syncState();
  },

  /* ---------------- A. 人工走查清单 ---------------- */

  onStatusTap(e) {
    const { idx, s } = e.currentTarget.dataset;
    const item = this.data.items[idx];
    if (!item || item.status === s) return;
    this.setData({ ['items[' + idx + '].status']: s });
  },

  onNoteInput(e) {
    const idx = e.currentTarget.dataset.idx;
    this.setData({ ['items[' + idx + '].note']: e.detail.value });
  },

  /* ---------------- B. T4 迁入的人工配合卡 ---------------- */

  _markM(id, patch) {
    const manuals = this.data.manuals.map(function (m) {
      if (m.id !== id) return m;
      const next = Object.assign({}, m, patch);
      if (patch.status) {
        next.state = patch.status === 'running' ? 'running' : stateOf(next);
        next.statusText =
          patch.status === 'running' ? MANUAL_STATUS_TEXT.running : MANUAL_STATUS_TEXT[next.state] || patch.status;
      }
      return next;
    });
    this.setData({ manuals: manuals });
  },

  /** 人工卡：先把状态置为 running，跑 fn() 后写回结果（自 t4._runManual 迁入） */
  async _runManual(id, fn) {
    if (this._anyRunning()) return;
    this.setData({ running: true });
    this._syncBusy();
    this._markM(id, { status: 'running', detail: '核验中…' });
    const started = Date.now();
    try {
      const r = await fn();
      this._markM(id, { status: r.status, detail: r.detail, ms: Date.now() - started });
    } catch (err) {
      this._markM(id, { status: 'fail', detail: '异常：' + (err.message || err), ms: Date.now() - started });
    } finally {
      this.setData({ running: false });
      this._syncBusy();
      this._syncState();
      this._persist(); // 配合卡结果跨页留存（救援卡正是“记快照→去配网页→回来核验”）
    }
  },

  async onVerifyApply(e) {
    if (this._anyRunning()) return;
    const item = this.data.manuals[e.currentTarget.dataset.index];
    if (!(await this._ensureForManual())) return;
    wx.showModal({
      title: '核验配网结果',
      editable: true,
      placeholderText: '目标 SSID（可留空，仅核对设备当前配置）',
      content: this._lastSsid || '',
      confirmText: '开始核验',
      success: (res) => {
        if (!res.confirm) return;
        const ssid = String(res.content || '').trim();
        if (ssid) this._lastSsid = ssid;
        this._runManual(item.id, () => verifyApply(this._ctx(), { ssid: ssid }));
      },
    });
  },

  async onRescueCapture(e) {
    if (this._anyRunning()) return;
    const item = this.data.manuals[e.currentTarget.dataset.index];
    if (!(await this._ensureForManual())) return;
    await this._runManual(item.id, async () => {
      const r0 = await rescueCapture(this._ctx());
      this._rescueSnapshot = r0.snapshot;
      return r0.result;
    });
    /* 记到真 no-IP 之后直接把用户送去网络配置页：中间这一步最容易漏，
       漏了就会在几秒后点「核验」而拿到一个假 FAIL。 */
    if (this._rescueSnapshot) {
      this.setData({
        rescueHint:
          '已记录断网现场 · 目标「' + (this._rescueSnapshot.ssid || '-') + '」· 现在去网络配置页做 scan → tryconnect → apply，' +
          '回来再点「验证救援」（会等最多 20s）',
      });
      wx.showModal({
        title: '已记录断网现场',
        content:
          '下一步：到网络配置页对「' + (this._rescueSnapshot.ssid || '正式 SSID') + '」重新 scan → tryconnect → apply。' +
          '设备拿到 IP、MQTT 连上后回本页点「验证救援」。\n\n' +
          '核验会等最多 20s，不需要一 apply 就马上点。',
        confirmText: '去网络配置',
        cancelText: '稍后',
        success: (res) => {
          if (res.confirm) this.goProvision();
        },
      });
    }
  },

  async onRescueVerify(e) {
    if (this._anyRunning()) return;
    const item = this.data.manuals[e.currentTarget.dataset.index];
    if (!this._rescueSnapshot) {
      wx.showToast({ title: '请先记录断网状态', icon: 'none' });
      return;
    }
    if (!(await this._ensureForManual())) return;
    wx.showToast({ title: '等待设备恢复（最多 20s）', icon: 'none' });
    await this._runManual(item.id, () =>
      rescueVerify(this._ctx(), this._rescueSnapshot, {
        waitMs: 20000,
        /* 实时进度：每次轮询更新提示，让等待可见 */
        onPoll: (p) => {
          const remain = Math.ceil(p.remainMs / 1000);
          this.setData({
            rescueHint:
              '核验中：已读 ' + p.polls + ' 次设备状态（剩 ' + remain + 's）· ' +
              (p.problems.length ? p.problems.join('；') : '状态正常，即将出结论'),
          });
        },
      })
    );
    this.setData({ rescueHint: '' });
  },

  async onRescueCleanup(e) {
    if (this._anyRunning()) return;
    const item = this.data.manuals[e.currentTarget.dataset.index];
    if (!(await this._ensureForManual())) return;

    let keep = '';
    let others = [];
    try {
      const st = await protocol.networkStatus();
      const profiles = netdiag.profilesOf(await protocol.profileList());
      const v = netdiag.classify(st, st.sta_ssid || '', profiles);
      keep = v.formalSsid;
      others = v.others;
    } catch (err) {
      const d = describe(err);
      wx.showToast({ title: '读取 profile 失败：' + d.text, icon: 'none' });
      return;
    }

    if (!keep) {
      wx.showToast({ title: '设备没有正式 SSID，无法确定保留哪个', icon: 'none' });
      return;
    }
    if (!others.length) {
      wx.showToast({ title: '只有正式 profile，无需清理', icon: 'none' });
      return;
    }

    wx.showModal({
      title: '删除其它 profile？',
      content:
        '将删除：' + others.join('、') + '\n只保留正式配置「' + keep + '」。\n\n' +
        '不删的话，关掉正式 AP 后设备会自动回退到这些网络，sta_connected 仍为 true，' +
        '就测不到真正的断网。删除后需要时重新配网即可恢复。',
      confirmText: '确认删除',
      confirmColor: '#d93025',
      success: (res) => {
        if (!res.confirm) return;
        this._rescueSnapshot = null; // 清理会改变运行时状态，旧快照作废
        this._runManual(item.id, async () => {
          const r = await rescueCleanup(this._ctx());
          return r.result;
        });
      },
    });
  },

  async onMtuRecord(e) {
    if (this._anyRunning()) return;
    const item = this.data.manuals[e.currentTarget.dataset.index];
    if (!(await this._ensureForManual())) return;
    await this._runManual(item.id, () => this._mtuRecordFlow());
  },

  async _mtuRecordFlow() {
    let sys = {};
    try {
      sys = wx.getSystemInfoSync() || {};
    } catch (err) {
      sys = {};
    }
    const env = ble.envInfo();

    // wx.setBLEMTU(512) 实际返回值：只记录，不作为判定
    const mtuRes = await new Promise((resolve) => {
      if (typeof wx.setBLEMTU !== 'function') return resolve('API 不存在（基础库过旧）');
      wx.setBLEMTU({
        deviceId: ble.deviceId,
        mtu: 512,
        success: (r) => resolve('success ' + JSON.stringify(r || {})),
        fail: (r) =>
          resolve('fail[' + (r && r.errCode === undefined ? '-' : r.errCode) + '] ' + ((r && r.errMsg) || '')),
      });
    });

    const fill = await new Promise((resolve) => {
      wx.showModal({
        title: '补记环境事实',
        content: '',
        editable: true,
        placeholderText: '定位权限=已授/未授，定位服务=开/关',
        confirmText: '完成记录',
        cancelText: '取消',
        success: (r) => resolve(r.confirm ? String(r.content || '').trim() : ''),
        fail: () => resolve(''),
      });
    });
    if (!fill) return skip('用户取消补记，定位权限/定位服务未记录，本项记录不完整', 'incomplete');

    const lines = [
      '平台 ' + (sys.platform || '-') + ' · ' + (sys.system || sys.model || '-') + ' · 微信 ' + (sys.version || '-'),
      '用户补记：' + fill,
      'wx.setBLEMTU(512) → ' + mtuRes,
      '写分片 ' + BleManager.CHUNK_SIZE + 'B 固定（即使协商到更大 MTU 也不改） · 通知分片 ' +
        (env.notifyCount
          ? env.notifyMin + '–' + env.notifyMax + 'B（均 ' + env.notifyAvg + 'B / ' + env.notifyCount + ' 片）'
          : '未记录（先跑 Notify 订阅项）'),
    ];
    if (/未授|关闭|禁用| denied |已拒/.test(fill)) {
      return fail(lines.join('\n') + '\n定位权限/定位服务不满足：扫描会扫不到设备，先解决再测');
    }
    return pass(lines.join('\n') + '\n环境事实记录完整（按执行表 #15 只记录不断言，MTU 行为以实测为准）');
  },

  /** 双端证据卡（iOS/Android 各一张）：自动采集本机环境事实 + 弹框补记，两份报告合并成对 */
  async onBothosRecord(e) {
    if (this._anyRunning()) return;
    const item = this.data.manuals[e.currentTarget.dataset.index];
    if (!(await this._ensureForManual())) return;
    await this._runManual(item.id, () => this._bothosRecordFlow(item.id));
  },

  async _bothosRecordFlow(cardId) {
    const targetPlatform = cardId === 'bothos-ios' ? 'ios' : 'android';
    let sys = {};
    try {
      sys = wx.getSystemInfoSync() || {};
    } catch (err) {
      sys = {};
    }
    const env = ble.envInfo();

    /* 平台守卫：iOS 卡必须在 iPhone 上点，Android 卡必须在 Android 手机上点。
     * 开发工具（devtools）两个都算不匹配——真机证据不能拿工具里的环境冒充。 */
    if (sys.platform !== targetPlatform) {
      return fail(
        '本卡是「' + (targetPlatform === 'ios' ? '双端证据 · iOS 端' : '双端证据 · Android 端') +
          '」，需要在 ' + (targetPlatform === 'ios' ? 'iPhone' : 'Android 手机') +
          '上打开小程序记录；本机平台是 ' + (sys.platform || '未知') +
          '，环境事实不能跨平台冒充。请在对应平台的手机上执行这张卡。'
      );
    }

    const extra = await new Promise((resolve) => {
      wx.showModal({
        title: '补记本机情况',
        content: '',
        editable: true,
        placeholderText: '其它需要说明的情况（可留空）',
        confirmText: '完成记录',
        cancelText: '取消',
        success: (r) => resolve(r.confirm ? String(r.content || '').trim() : null),
        fail: () => resolve(null),
      });
    });
    if (extra === null) return skip('用户取消补记，本机证据未记录完整', 'incomplete');

    const name = this.data.deviceName || ble.deviceName || '-';
    const lines = [
      '平台 ' + (sys.platform || '-') + ' · ' + (sys.system || sys.model || '-') + ' · 微信 ' + (sys.version || '-'),
      '设备 ' + name + ' · 会话 #' + (env.sessionId || this.data.sessionId),
      'MTU ' + (env.mtu || '-') + ' · 写分片 ' + env.writeChunk + 'B 固定（即使协商到更大 MTU 也不改）',
      '通知分片 ' +
        (env.notifyCount
          ? env.notifyMin + '–' + env.notifyMax + 'B（均 ' + env.notifyAvg + 'B / ' + env.notifyCount + ' 片）'
          : '未记录（先跑 T4 Notify 订阅项）'),
      '断链 被动 ' + env.disconnects + ' 次 · 主动 ' + env.manualDisconnects + ' 次',
    ];
    if (extra) lines.push('用户补记：' + extra);
    return pass(lines.join('\n') + '\n本机证据记录完整；T4 结论需与另一张双端证据卡（' +
      (targetPlatform === 'ios' ? 'Android 端' : 'iOS 端') + '）的报告合并后才能签收');
  },

  /**
   * #23 时序实验（2026-11-08）：只观测，不改协议。
   * 观测器见 utils/probe401.js（含「为什么伪造会话 token 而不是走改密」的说明）。
   */
  async onProbe401(e) {
    if (this._anyRunning()) return;
    const item = this.data.manuals[e.currentTarget.dataset.index];
    if (!(await this._ensureForManual())) return;
    wx.showModal({
      title: '#23 时序实验',
      content: '连续 5 轮「两条并发请求 + 失效 token」，再做 1 轮可控迟到实验。'
        + '只观测、不改协议，约 20 秒，期间请勿操作小程序。',
      confirmText: '开始',
      success: (res) => {
        if (!res.confirm) return;
        this._runManual(item.id, async () => {
          const out = await probe401.runAll(protocol, { rounds: 5, gapMs: 500 });
          if (!out.ok) {
            return { status: 'skip', detail: '实验无效（INCOMPLETE，不能判 PASS）：' + out.text };
          }
          const lines = [out.text];
          out.rounds.forEach(function (r) {
            lines.push(
              '#' + r.n + ' authLogins=' + r.dLogin + ' authRetries=' + r.dRetry +
                ' 401id=' + (r.u401Ids.join(',') || '无') +
                ' ' + (r.bothOk ? '双成功' : '失败:' + r.failCodes.join(',')) +
                (r.verdict === 'clean' ? '' : ' [' + r.verdict + '] ' + r.detail) +
                (r.trace ? ' · ' + r.trace : '')
            );
          });
          if (out.late && out.late.phaseA && out.late.phaseB) {
            lines.push(
              '可控迟到：A 段 authLogins=' + out.late.phaseA.dLogin +
                ' · B 段 authLogins=' + out.late.phaseB.dLogin + '（理想 0）· B 段' +
                (out.late.phaseB.ok ? '成功' : '失败:' + out.late.phaseB.failCode)
            );
          }
          if (out.verdict === 'defect') {
            return {
              status: 'fail',
              detail: lines.join('\n') + '\n判定：自然并发出现重复登录（authLogins≥2），需先审查 protocol 修复方案再改',
            };
          }
          if (out.verdict === 'invalid') {
            return {
              status: 'skip',
              detail: lines.join('\n') + '\n判定：实验无效（INCOMPLETE，不能判 PASS）——先排除「取不到两条真实 401 / id 不匹配 / 超时」',
            };
          }
          if (out.verdict === 'late_login') {
            return {
              status: 'pass',
              detail:
                lines.join('\n') +
                '\n⚠ 未决缺陷：自然并发未复现，但可控迟到会再登录一次（H9 只覆盖「登录在途」）。' +
                '功能未失败，修复需改 protocol 并单独审批；本卡 PASS 仅覆盖自然并发时序',
            };
          }
          return { status: 'pass', detail: lines.join('\n') };
        });
      },
    });
  },

  /** 走查卡通用结果标记（cross-device / concurrent401 等纯人工项：没有自动取证流程） */
  onCardMark(e) {
    if (this._anyRunning()) return;
    const item = this.data.manuals[e.currentTarget.dataset.index];
    wx.showActionSheet({
      itemList: ['标记 PASS（已按卡上判据核验）', '标记 FAIL', '标记 SKIP（未执行）', '标记 BLOCKED（条件不具备）'],
      success: (r) => {
        const st = ['pass', 'fail', 'skip', 'blocked'][r.tapIndex];
        if (st === 'blocked') {
          /* v2：BLOCKED 不许空手声明——必须写清解除条件，否则无法判断何时该重试 */
          wx.showModal({
            title: '标记 BLOCKED',
            content: '',
            editable: true,
            placeholderText: '解除条件（必填），例如：接入 iPhone 后重跑本卡',
            confirmText: '确认 BLOCKED',
            cancelText: '取消',
            success: (res) => {
              if (!res.confirm) return;
              const why = String(res.content || '').trim();
              if (!why) {
                wx.showToast({ title: '必须填写解除条件', icon: 'none' });
                return;
              }
              this._runManual(item.id, async () => blocked('客观条件不具备：' + why, why));
            },
          });
          return;
        }
        const note = {
          pass: '人工核验通过（走查卡）',
          fail: '人工核验不通过（走查卡）',
          skip: '未执行',
        }[st];
        this._runManual(item.id, async () => ({ status: st, detail: note + ' · ' + stamp() }));
      },
    });
  },

  async onPwdChangeCard(e) {
    if (this._anyRunning()) return;
    const item = this.data.manuals[e.currentTarget.dataset.index];
    if (!(await this._ensureForManual())) return;
    wx.showModal({
      title: '受控改密卡（#16）',
      content:
        '流程：原口令登录 → 改密到临时口令 → 验证 sessions_invalidated 与本地 token 清空 → ' +
        '临时口令登录 → 恢复原口令 → 原口令登录验证。\n临时口令内存生成，异常时自动恢复；全程不写入报告。',
      editable: true,
      placeholderText: '输入当前管理员口令',
      confirmText: '开始改密',
      cancelText: '取消',
      success: (res) => {
        if (!res.confirm) return;
        const oldPwd = String(res.content || '');
        if (!oldPwd) {
          wx.showToast({ title: '口令不能为空', icon: 'none' });
          return;
        }
        this._runManual(item.id, () => pwdChangeControlled(this._ctx(), oldPwd));
      },
    });
  },

  /* ---------------- 报告 / 工具 ---------------- */

  _counts() {
    const passN =
      this.data.items.filter((i) => i.status === 'PASS').length +
      this.data.manuals.filter((m) => m.status === 'pass').length;
    const failN =
      this.data.items.filter((i) => i.status === 'FAIL').length +
      this.data.manuals.filter((m) => m.status === 'fail').length;
    return { pass: passN, fail: failN };
  },

  buildReport() {
    const lines = [];
    lines.push('T3 人工测试报告 ' + stamp());
    lines.push('设备: ' + (this.data.deviceName || '未连接') + ' · 会话 #' + this.data.sessionId);
    lines.push('说明: 功能自测不可自动化部分（页面级走查 + T4 迁入的人工配合卡）');
    lines.push('');
    lines.push('== 人工走查 ==');
    this.data.items.forEach((it) => {
      lines.push('[' + it.status + '] ' + it.name + (it.note ? ' · 备注: ' + it.note : ''));
      lines.push('    步骤: ' + it.steps);
      if (it.status === 'FAIL') lines.push('    预期: ' + it.expect);
    });
    lines.push('');
    lines.push('== 人工配合卡（自 T4 迁入） ==');
    this.data.manuals.forEach((m) => {
      lines.push('[' + (m.statusText || m.status) + '] ' + m.name + (m.ms ? '（' + Math.round(m.ms / 100) / 10 + 's）' : ''));
      if (m.detail) {
        m.detail.split('\n').forEach((l) => lines.push('    ' + l));
      }
    });
    const c = this._counts();
    lines.push('');
    lines.push('汇总: PASS ' + c.pass + ' / FAIL ' + c.fail + '（走查 ' + this.data.items.length + ' 项 + 配合卡 ' + this.data.manuals.length + ' 项）');
    return lines.join('\n');
  },

  onCopyReport() {
    const report = this.buildReport();
    wx.setClipboardData({
      data: report,
      success: () => wx.showToast({ title: '报告已复制', icon: 'success' }),
    });
    store.save('t3', this._counts());
  },

  onReset() {
    this.setData({
      items: this.data.items.map((it) => Object.assign({}, it, { status: '待测', note: '' })),
      manuals: this.data.manuals.map((m) =>
        Object.assign({}, m, { status: 'idle', state: 'idle', statusText: MANUAL_STATUS_TEXT.idle, detail: '', blockedBy: '', ms: 0 })
      ),
      rescueHint: '',
    });
    this._rescueSnapshot = null;
    clearState(); // 重置 = 明确清空持久化进度
  },

  /** 断连重连（从设备页迁移）：模拟设备侧 token 作废 → 重连 → 自动重登 */
  async onReconnect() {
    if (this.data.reconnecting || this.data.busy) return;
    const target = this._target();
    if (!target.deviceId && !target.name) {
      wx.showToast({ title: '没有可重连的目标', icon: 'none' });
      return;
    }
    this.setData({ reconnecting: true });
    try {
      await ble.disconnect();
    } catch (e) { /* 忽略 */ }
    protocol.clearSession(true); // 保留内存凭据，仅清 token → 重连后自动重登
    await new Promise((r) => setTimeout(r, 400));
    try {
      const out = await ensureLink(ble, protocol, {
        target: { deviceId: target.deviceId, name: target.name },
      });
      if (out.ok) {
        wx.showToast({ title: '已重连' + (out.loggedIn ? '并重新登录' : ''), icon: 'success' });
      } else {
        wx.showToast({ title: '重连失败：' + (out.error || out.stage), icon: 'none' });
      }
    } catch (e) {
      const d = describe(e);
      wx.showToast({ title: '重连失败：' + d.text, icon: 'none' });
    } finally {
      this.setData({ reconnecting: false });
      this._syncState();
    }
  },
}));
