/**
 * 真机验收自检（对应协议 §11 验收矩阵 + §11.1 P0 清单）。
 *
 * 判定语义（协议 §11.1 明确要求）：
 *   PASS     观测到的现象与预期一致，且证据是「实际收发的字节」，不是「没报错」
 *   EXPECTED 协议规定的正常行为（如连接态扫描 0 台），不算失败，但不能等同于 PASS
 *   FAIL     与协议不符
 *   SKIP     没有条件执行（人工项 / 未登录 / 无设备），**不得计入 PASS**
 *
 * 纯逻辑，不直接调用 wx，便于在 Node 下用桩跑回归。
 */

const { sleep, shortUuid, shortService } = require('./util');
const { equals, utf8Encode } = require('./bytes');
const { describe, isLinkError } = require('./errors');
const { DEFAULT_USERNAME, DEFAULT_PASSWORD } = require('./config');
const credstore = require('./credstore');
const { ensureLink } = require('./link');
const provision = require('./provision');
const netdiag = require('./netdiag');
const BleManager = require('./ble');
/* 契约单一事实源（contract/v1 镜像）：终态集合/瞬态预算/scan 节流一律从此取，
 * 不得再散落硬编码——契约与代码冲突以契约为准（docs/协议契约整改方案_2026-11-10.md §2.4）。 */
const contract = require('./contract');

const CHAR_KEYS = BleManager.CHAR_KEYS;

/* 分包探测用的不存在的命令：设备回 unknown_command 即证明「整行 512B 重组 + UTF-8 解码 + JSON 解析 + 命令分发」全部成功，
   且零副作用（不读也不改任何状态）。 */
const PROBE_CMD = 'acceptance.probe';
const PROBE_TARGET_BYTES = 420;

/* 第 14 项核验的等待窗口：apply 之后设备要重新关联 + DHCP + MQTT，
   单次读取必然过早（现场就出现过 apply 后几秒读仍 0.0.0.0）。 */
const RESCUE_WAIT_MS = 20000;
const RESCUE_POLL_MS = 1500;

/* waitForAdvertising 的取证等待窗（#11/#21 设备侧广播证据）。原 12s 硬编码 ×3
 * （2026-11-10 评审 P2-2 收口）；TODO：硬件侧把它登记进契约
 * derived_client_budgets.client_adv_wait_ms 后改读 contract（Phase 3 双绿接入点）。 */
const ADV_EVIDENCE_WAIT_MS = 12000;

const CHECKS = [
  {
    id: 'scan',
    name: 'BLE 扫描与发现',
    desc: '连接前扫描，记录 name/localName（运行全部时可自动断开重扫并恢复链路）',
    p0: true,
    needConnection: false,
  },
  {
    id: 'gatt',
    name: '服务与特征发现',
    desc: '按实际发现的 UUID + 属性解析 4 个特征，记录属性',
    p0: true,
  },
  {
    id: 'notify',
    name: 'Notify 订阅',
    desc: '先订阅后发送；CMD 与 DATA 两条 TX 都确实收到通知',
    p0: true,
  },
  {
    id: 'scanRepeat',
    name: '10 次 network.scan',
    desc: '验收矩阵 #4：每次 JSON 完整、id 匹配、AP 列表可解析',
    p0: false,
  },
  {
    id: 'fragment',
    name: '20 字节分包',
    desc: '420B 探测命令按序写入，记录完整命令与请求/响应 id',
    p0: true,
  },
  {
    id: 'long',
    name: '长响应完整性',
    desc: 'config.get 完整重组，无 AP 字段，与 network.status 交叉核对',
    p0: true,
  },
  {
    id: 'longRepeat',
    name: '10 次 config.get',
    desc: '验收矩阵 #5：每次长响应完整，分片数/字节数稳定',
    p0: false,
  },
  {
    id: 'pipeline',
    name: '长响应期间发命令',
    desc: '长响应发送中插入 operation.get，响应排在长响应之后且可解析',
    p0: true,
  },
  {
    id: 'dual',
    name: '双通道并发',
    desc: 'CMD 长响应期间 DATA 回环仍逐字节一致，无串道',
    p0: true,
  },
  {
    id: 'data',
    name: 'DATA 全矩阵',
    desc: '单帧/长帧/连续帧/退订逐字节比对（可靠性不签收）',
    p0: true,
  },
  {
    id: 'reconnect',
    name: '断连与重连',
    desc: '重新发现/订阅/登录；旧 token 失效；无旧字节混入',
    p0: true,
  },
  {
    id: 'opsem',
    name: 'operation 语义',
    desc: 'busy / operation_state / cancel 幂等 / cancel 后立即新 op 受理，不误判为口令错误',
    p0: true,
  },
  {
    id: 'apply',
    name: '成功配网与 apply',
    desc: '真实 SSID/口令走通 got_ip → apply → IP/MQTT → 重连后配置仍在',
    p0: true,
    manual: true,
    page: 't3', // 2026-10-27 迁 T3 人工测试页：必须人工配合真实 Wi-Fi，无法自动跑
    manualHint:
      '本项必须用现场真实 Wi-Fi 完成，无法自动跑。步骤：网络配置页选 SSID、输口令 → ' +
      'accepted → 500ms operation.get → got_ip（契约 v1.1=IP+联网验证+MQTT 就绪）→ apply → 等 sta_has_ip=true、internet_verified=true 且 mqtt_connected=true。' +
      '回到本页点「核验配网结果」：小程序会自动断开→等设备重新广播→重连→再读 config.get 与 network.status，' +
      '证明配置已持久化。口令不要写进报告。',
  },
  {
    id: 'rescue',
    name: '网络救援',
    desc: 'STA 失败/无 IP/MQTT down 时仍能 scan→tryconnect→apply 恢复',
    p0: true,
    manual: true,
    page: 't3', // 2026-10-27 迁 T3：需人工关闭上游 AP / 改错口令配合
    manualHint:
      '前置：先点「清理其它 profile」只留正式 SSID（含 P0-NOAP-* 这类压测残留）—— 否则关掉正式 AP 后设备会自动回退，' +
      'sta_connected 仍为 true，测到的不是真正的 no-IP。' +
      '然后关掉上游 AP（或改错口令）制造断网，确认 sta_has_ip=false、sta_ip=0.0.0.0、mqtt_connected=false → ' +
      '点「① 记录断网状态」留下救援前证据 → 在网络配置页重新 scan→tryconnect→operation.get→apply → ' +
      '恢复后回本页点「② 核验救援结果」。' +
      '核验要求 sta_has_ip=true、internet_verified=true、mqtt_connected=true（v1.1 got_ip 语义），且实际连的是目标 SSID（connected_ssid 一致）、' +
      'net_mode=sta、无 AP 字段；不要引导用户去找设备 AP。' +
      '记完快照就点核验不会判失败：没有新的 apply 只记 EXPECTED（未取证）；有 apply 会等最多 20s，' +
      '等满仍无 IP 才 FAIL，并给出 operation_id 与等待时长。',
  },
  {
    id: 'bothos-ios',
    name: '双端证据 · iOS 端',
    desc: '在 iPhone 上记录 OS、微信版本、名字、MTU、通知分片长度、断链次数',
    p0: true,
    /* v2（2026-11-08）：本卡属 T4-B（iOS 侧）证据。无 iOS 设备时由人显式声明
     * BLOCKED，scope=t4b 属正式豁免——不阻塞 T4-A，但豁免依据写在口径文档里，
     * 不是悄悄放过。P0 BLOCKED 的默认语义仍是阻塞。 */
    scope: 't4b',
    manual: true,
    page: 't3', // 2026-10-28 迁 T3：要在另一台手机上重跑才能出双端结论，单机无法自动取证
    platform: 'ios', // 2026-10-28 拆分：iOS/Android 各一张卡，各自在本机记录，报告合并成对
    manualHint:
      '本卡只记录 iOS 手机上的环境事实，必须在 iPhone 上打开小程序执行；在 Android 手机上点会判 FAIL。' +
      '点「记录本机证据」：自动采集系统/微信版本、设备名、MTU 与写分片、通知分片统计、断链次数，' +
      '并弹框补记其它需要说明的情况（可留空）。与「双端证据 · Android 端」两份报告合并才是 T4 结论。',
  },
  {
    id: 'bothos-android',
    name: '双端证据 · Android 端',
    desc: '在 Android 手机上记录 OS、微信版本、名字、MTU、通知分片长度、断链次数',
    p0: true,
    /* v2：证据记录类——采集的是环境事实，没有功能断言，缺了不代表功能失败。
     * 降 P1 后不进否决链，只在「证据完整度」里体现。 */
    tier: 'p1',
    manual: true,
    page: 't3',
    platform: 'android',
    manualHint:
      '本卡只记录 Android 手机上的环境事实，必须在 Android 手机上打开小程序执行；在 iPhone 上点会判 FAIL。' +
      '点「记录本机证据」：自动采集系统/微信版本、设备名、MTU 与写分片、通知分片统计、断链次数，' +
      '并弹框补记其它需要说明的情况（可留空）。与「双端证据 · iOS 端」两份报告合并才是 T4 结论。' +
      '证据来源（v2）：本卡采集与报告头同一份 env 快照，产出里带采集时刻与会话号；' +
      '原始分片与逐条报文只在 BLE 日志中，不声称报告已留存原始证据。取消补记记 INCOMPLETE，不是 PASS。',
  },
  {
    id: 'authinfo',
    name: '登录与 device.info',
    desc: '验收矩阵 #3：device.info 无 token 可读 protocol_versions；login 返回 32 位 token、expires_in=600',
    p0: true,
  },
  {
    id: 'badcred',
    name: '错误口令登录',
    desc: '验收矩阵 #6：错误口令被拒、既有会话不受影响，提示不与内部错误混淆',
    p0: true,
  },
  {
    id: 'tokencase',
    name: 'token 大小写',
    desc: '验收矩阵 #17：大写 token 必须被拒（原样保存比对），原 token 仍有效',
    p0: true,
  },
  {
    // 2026-10-29 配合清单第 2 条：原断联现象回归（自动取证）
    id: 'loopback-status',
    name: '原现象回归：loopback→network.status',
    desc: '登录态下 data.loopback → network.status 一次通过：无 auth_required、无 401 重试、tx 带 token',
    p0: true,
  },
  {
    // 2026-10-29 配合清单第 3 条前半：重连路径连续回归（自动取证）
    id: 'relink3',
    name: '重连 3 轮：断开→重连→重登→业务请求',
    desc: '连续 3 轮断开重连重登后业务请求无 auth_required（原 0x213 断链路径回归）',
    p0: true,
  },
  {
    // 2026-10-29 配合清单第 3 条后半：跨设备隔离需要第二台设备，人工配合
    id: 'cross-device',
    name: '切设备 A→B：token 隔离与重登',
    desc: 'B 设备首请求不携带 A 的 token（onLinkUp switched 日志 + 首请求前自动重登）',
    p0: true,
    /* v2：本条依赖第二台物理设备且要求 B 配到不同 SSID，属「条件具备才做」的
     * 证据项。客户端 switched 逻辑已有 autoconnect 自测覆盖，故降 P1 不阻塞 T4-A。 */
    tier: 'p1',
    manual: true,
    page: 't3',
    manualHint:
      '前置（v2 收紧）：两台已配网设备，A=C8E4，B 必须配到**不同于 A 的正式 SSID**——' +
      '两机同 SSID 时 B 断链后会回连原网，会拿到看似 PASS 的假证据，此时本卡保持 P1 NOT_RUN。\n' +
      '步骤：设备 A 连接并登录 → 在调试控制台看 tx 日志（hasToken=true）→ 断开 → 连接设备 B 并登录 → ' +
      '观察重连日志出现「设备已切换（跨设备 token 不复用）」→ B 的第一条业务请求 hasToken=true 且是新 token。\n' +
      '判据：A 的 token 在 B 上不可用；切换日志 switched 出现；无 A token 复用。完成后点「记录走查结果」。',
  },
  {
    // 2026-10-29 配合清单第 1 条 H9 的真机佐证：制造真实 401 需作废会话（特权操作），人工配合
    id: 'concurrent401',
    name: '并发 401：只发一次 auth.login',
    desc: '两条并发请求各收到真实 unauthorized 时，只发出一次 auth.login（H9 去重 + 迟到 401 检查）',
    p0: true,
    manual: true,
    page: 't3',
    manualHint:
      '点「跑 #23 时序实验」自动执行：5 轮自然并发（两条请求同时带同一个失效 token）+ 1 轮可控迟到。\n' +
      '不需要改密、不需要第二台设备，只需已连接并登录（重连后凭据已清，需重新登录）。\n' +
      '判据：两条 401 的 responseId 各自对应请求 id；authLogins 增量=1；authRetries 增量=2；两条请求最终成功；伪造 token 不残留。\n' +
      '判读：自然并发出现 authLogins=2 → FAIL（真实重复登录）；取不到两条真实 401 / id 不匹配 / 超时 → INCOMPLETE，不能判 PASS；' +
      '自然并发为 1 但可控迟到又登录 → 记 PASS 并在 detail 保留「未决缺陷」（迟到 401 竞态仍存在，需改 protocol 才能消除）。',
  },
  {
    id: 'mtu',
    name: 'Android 权限与 MTU 记录',
    desc: '验收矩阵 #15：定位权限/定位服务、wx.setBLEMTU 实际返回、协商分片（环境事实，不做自动断言）',
    p0: true,
    /* v2：纯环境事实记录，无功能断言；「定位服务关了扫不到设备」本来会由
     * #1/#4 直接暴露，故降 P1，只进证据完整度。 */
    tier: 'p1',
    manual: true,
    page: 't3', // 2026-10-27 迁 T3：环境事实需人工目视补记
    manualHint:
      '点「记录权限/MTU」：自动采集平台/微信版本与 wx.setBLEMTU(512) 实际返回值，' +
      '再弹框补记定位权限与定位服务状态。记录完整且满足要求才 PASS。',
  },
  {
    id: 'pwdchange',
    name: '改密与会话作废（受控卡）',
    desc: '验收矩阵 #16：改密→sessions_invalidated→token 清空→临时口令登录→恢复原口令→原口令登录',
    p0: true,
    /* 2026-11-11：卡片自带禁令（临时口令只在内存，进程被杀/断电即不可知），
     * 记 blocked 而不是 manual——否则结论会催人执行一张禁止执行的卡。 */
    blockedBy: '临时口令持久化与应急恢复通道落实前不得执行（当前临时口令仅存内存，中断即不可恢复）',
    manual: true,
    page: 't3', // 2026-10-27 迁 T3：特权状态变更需人工输入口令受控执行
    manualHint:
      '受控手工卡（不进一键自动化，改密是特权状态变更）：点「受控改密卡」输入当前管理员口令。' +
      '临时口令内存生成，finally 恢复原口令并自动验证；中断可能把设备留在临时口令上，请保持链路稳定。' +
      'v2 口径：本卡属**一次性特权验收**，首次 PASS 后归档证据即可，后续回归复用有效历史证据，不要求每轮重跑。' +
      '执行前注意（2026-11-08 审查）：当前临时口令为随机数且只在内存，进程被杀/断电后即不可知——' +
      '在临时口令持久化与应急恢复通道落实前，不要执行本卡。',
  },
];

/* ---------------- 结果构造 ---------------- */

function pass(detail, extra) {
  return { status: 'pass', detail: detail, extra: extra || null };
}
function expected(detail, extra) {
  return { status: 'expected', detail: detail, extra: extra || null };
}
function fail(detail, extra) {
  return { status: 'fail', detail: detail, extra: extra || null };
}
/** 未执行：reason 由卡片显式声明（manual/incomplete/blocked/link_down/n_a），别让文案决定判定 */
function skip(detail, reason) {
  return { status: 'skip', detail: detail, reason: reason || '', extra: null };
}
/** 客观条件不具备：必须由人显式声明，并给出解除条件（blockedBy） */
function blocked(detail, blockedBy) {
  return { status: 'blocked', detail: detail, blockedBy: blockedBy || '', extra: null };
}

/* ---------------- 验收状态模型 v2（2026-11-08） ----------------
 *
 * 动机：v1 只有 pass/fail/expected/skip 四种执行结果，却同时用来表达
 *   「功能是否通过」「要不要人做」「证据是否齐全」三件事，于是
 *   记录类卡片（#16/#24，只记录环境事实、没有断言）与功能卡一样能
 *   否决整包签收——报告长期停在「不可签收：N 项 P0 待人工」，
 *   既说不清要修什么，也让真缺陷淹没在形式项里。
 *
 * v2 把三件事拆成三个正交维度：
 *   state  判定状态：pass | fail | expected | not_run | incomplete | blocked
 *   tier   优先级：  p0（功能必做）| p1（证据/条件项，不进否决链）
 *   scope  签收范围：t4a（本机 Android 侧）| t4b（iOS 侧证据，可显式豁免）
 *
 * 阻塞规则：
 *   P0 + fail                → 阻塞（功能失败）
 *   P0 + not_run(manual/凭据) → 阻塞（该做的没做）
 *   P0 + incomplete          → 阻塞（证据不齐，P0 不能拿半份证据签收）
 *   P0 + blocked             → 阻塞（核心功能未验证；须正式豁免或降为 P1）
 *   P0 + not_run(link_down)  → 不阻塞但判「待重跑」
 *     例外：SELF_LINK_IDS 里的卡片（#11 断连与重连、#21 重连 3 轮）自身就是
 *     链路恢复用例，不得用 link_down 豁免，否则「测重连的项」会被「重连失败」免掉。
 *   P1 任何状态              → 不阻塞，只进「证据完整度」
 *   scope=t4b                → 不阻塞（豁免须在口径文档列明）
 */

const STATE_TEXT = {
  pass: 'PASS',
  fail: 'FAIL',
  expected: 'EXPECTED',
  not_run: 'NOT_RUN',
  incomplete: 'INCOMPLETE',
  blocked: 'BLOCKED',
};

/** 卡片优先级：显式 tier 优先；未标 tier 的老对象沿用 p0 布尔（无 p0 字段即 P1） */
function tierOf(r) {
  if (r && (r.tier === 'p1' || r.tier === 'p0')) return r.tier;
  return r && r.p0 ? 'p0' : 'p1';
}
function scopeOf(r) {
  return (r && r.scope) || 't4a';
}

/**
 * T4-B 豁免白名单（2026-11-08 定稿）。
 *
 * scope!=t4a 的卡片会绕开否决链，语义上等价「正式豁免」。这种口子必须逐条登记：
 * 靠人工 grep 兜底，一旦有人新增一处 scope 就悄悄放宽了签收口径，而报告上看不出来。
 * 新增豁免 = 改这里 + 在口径文档 §3 写明依据，两处缺一不可。
 */
const T4B_WHITELIST = ['bothos-ios'];

/**
 * 校验 scope 使用是否合规：未登记的豁免、白名单里已不存在的卡、白名单卡未标 scope。
 * 返回违规描述数组（空数组=合规）。供自测与发版前核对调用。
 */
function scopeViolations(checks) {
  const list = checks && checks.length ? checks : CHECKS;
  const out = [];
  list.forEach(function (c) {
    if (scopeOf(c) === 't4a') return;
    if (T4B_WHITELIST.indexOf(c.id) < 0) out.push('未登记豁免：' + c.id + '（scope=' + scopeOf(c) + '）');
  });
  T4B_WHITELIST.forEach(function (id) {
    const hit = list.filter(function (c) {
      return c.id === id;
    })[0];
    if (!hit) out.push('白名单卡片已不存在：' + id);
    else if (scopeOf(hit) === 't4a') out.push('白名单卡片未标豁免 scope：' + id);
  });
  return out;
}

/**
 * SKIP 归因。参数兼容三种形态：结果对象（优先 reason 字段）、detail 字符串、空值。
 * 有结构化 reason 就用 reason；老调用点只传 detail 时回退文案正则。
 */
function skipReason(input) {
  if (input && typeof input === 'object') {
    if (input.reason) return input.reason;
    if (input.status === 'blocked') return 'blocked';
    return skipReason(input.detail);
  }
  const s = String(input || '');
  if (/^待人工/.test(s)) return 'manual';
  if (/^证据不完整|未记录完整|取消补记/.test(s)) return 'incomplete';
  if (/^客观条件不具备|无 iOS 设备|设备条件不具备/.test(s)) return 'blocked';
  if (/蓝牙未连接|自动重连未恢复|链路|未登录/.test(s)) return 'link_down';
  return 'n/a';
}

const SKIP_REASON_TEXT = {
  manual: '待人工',
  link_down: '链路级联/前置未满足',
  n_a: '不适用',
  incomplete: '证据不完整',
  blocked: '客观条件不具备',
};

/**
 * 「自身就是链路恢复用例」的卡片：失败不能算前置未满足。
 * #11 停在「设备没重新广播」、#21 停在「两窗扫描超时」，若按 link_down 处理，
 * 它们会被写成「非缺陷，重连后重跑即可」——而它们自己就是那个前置；上游项
 * 被下游豁免掉，后面 6 项「等重连后重跑」就永远排不上队。
 */
const SELF_LINK_IDS = ['reconnect', 'relink3'];
function isSelfLink(r) {
  return !!r && typeof r === 'object' && SELF_LINK_IDS.indexOf(r.id) >= 0;
}

/** 该条是否阻塞签收（v2：先看 tier/scope，再看状态与归因） */
function skipBlocking(input) {
  const r = input && typeof input === 'object' ? input : null;
  if (r) {
    if (scopeOf(r) !== 't4a') return false;
    if (tierOf(r) === 'p1') return false;
    if (isSelfLink(r)) return true;
  }
  const why = skipReason(input);
  if (why === 'manual' || why === 'incomplete' || why === 'blocked') return true;
  /* 凭据/拒登类前置失败优先于 link_down 归类：登录失败重跑也不会变好，
   * 不能因为文案里带「未登录」就被当成「断链了重连即可」。 */
  if (/登录失败|拒登|口令|凭据/.test(String(r ? r.detail : input || ''))) return true;
  if (why === 'link_down') return false;
  return false;
}

/** 判定状态投影：把 pass/fail/expected/skip(+reason)/blocked 映射成 5+1 状态 */
function stateOf(r) {
  if (!r) return 'not_run';
  /* 注意：不从 r.state 读——state 是本函数的投影产物，页面回写时会残留
   * 上一次的 'running'，读它会造出「永远进行中」的假状态。 */
  if (r.status === 'pass' || r.status === 'fail' || r.status === 'expected') return r.status;
  if (r.status === 'blocked') return 'blocked';
  if (r.status === 'skip') {
    const why = skipReason(r);
    if (why === 'incomplete') return 'incomplete';
    if (why === 'blocked') return 'blocked';
    return 'not_run';
  }
  return 'not_run';
}

/** 状态 → 是否属于「已采集到证据」（P1 证据完整度用） */
function hasEvidence(r) {
  const st = stateOf(r);
  return st === 'pass' || st === 'fail' || st === 'expected';
}

/**
 * 统一结论（页面 _verdictOf 与报告文本共用这一份，避免两套逻辑漂移）。
 * @returns {{kind:'ok'|'warn'|'fail', text:string, blocking:Array, evidence:{done:number,total:number}}}
 */
function verdictOf(results, opts) {
  const o = opts || {};
  const rows = (results || []).slice();
  const scoped = rows.filter(function (r) { return scopeOf(r) === 't4a'; });
  const p0 = scoped.filter(function (r) { return tierOf(r) === 'p0'; });
  const p1 = scoped.filter(function (r) { return tierOf(r) === 'p1'; });
  const pick = function (list, s) { return list.filter(function (r) { return stateOf(r) === s; }); };
  const names = function (list) {
    /* 2026-11-11：不再只印前 3 个再补「等 N 项」。#25 改密卡正是被这句
     * 「等 4 项」吞掉的——结论里从头到尾没出现过它的名字，于是没人发现
     * 它一边被算成「待执行」，一边在卡片里写着「不要执行」。 */
    return list.map(function (r) { return (r.no ? r.no + '.' : '') + r.name; }).join('、');
  };
  const failL = pick(p0, 'fail');
  const incL = pick(p0, 'incomplete');
  const blkL = pick(p0, 'blocked');
  const notRun = pick(p0, 'not_run');
  /* NOT_RUN 分两类：链路级联（重跑即可）与真没做（含凭据前置失败） */
  const cascade = notRun.filter(function (r) { return !skipBlocking(r) && skipReason(r) === 'link_down'; });
  const todo = notRun.filter(function (r) { return cascade.indexOf(r) < 0; });
  const expL = pick(p0, 'expected');
  const evidence = { done: p1.filter(hasEvidence).length, total: p1.length };
  const blocking = p0.filter(function (r) {
    const st = stateOf(r);
    if (st === 'fail' || st === 'incomplete' || st === 'blocked') return true;
    return st === 'not_run' && todo.indexOf(r) >= 0;
  });
  const tail = cascade.length
    ? '；另有 ' + cascade.length + ' 项 P0 因链路级联/前置未满足未执行（非缺陷，重连后重跑即可）：' + names(cascade)
    : '';
  const p1Tail = p1.length
    ? '；P1 证据 ' + evidence.done + '/' + evidence.total + '（不影响 T4-A 签收）'
    : '';
  const res = { blocking: blocking, evidence: evidence };

  if (o.partial) {
    return Object.assign(res, { kind: 'warn', text: '单次运行结果，仅供取证；整机结论请运行全部' });
  }
  /* 一次列全所有阻塞类别。旧写法命中第一类就 return：本轮 #11 一旦记
   * incomplete，#25 的 BLOCKED 与 todo 就再也不会出现在结论里。 */
  const segs = [];
  if (failL.length) segs.push(failL.length + ' 项失败：' + names(failL));
  if (todo.length) segs.push(todo.length + ' 项未执行：' + names(todo) + '（未执行不计入 PASS）');
  if (incL.length) segs.push(incL.length + ' 项证据不完整：' + names(incL) + '（补齐后重跑）');
  if (blkL.length) {
    /* 带解除条件的（#25 特权改密卡）不能建议「降为 P1」——那是一次性安全验收，
     * 降级等于让它消失；只有纯条件项才适用降级。 */
    const hasWhy = blkL.some(function (r) { return !!r.blockedBy; });
    segs.push(
      blkL.length + ' 项客观条件不具备：' + names(blkL) +
        (hasWhy ? '（需正式豁免，或落实解除条件后重跑）' : '（需正式豁免或降为 P1）')
    );
  }
  if (segs.length) {
    return Object.assign(res, {
      kind: failL.length ? 'fail' : 'warn',
      text: '不可签收（P0）：' + segs.join('；') + tail + p1Tail,
    });
  }
  if (cascade.length) {
    return Object.assign(res, { kind: 'warn', text: '待重跑：无 FAIL，' + cascade.length + ' 项 P0 因链路级联/前置未满足未执行（非缺陷）：' + names(cascade) + p1Tail });
  }
  if (expL.length) {
    return Object.assign(res, { kind: 'warn', text: '有条件通过：P0 中 ' + expL.length + ' 项为协议允许的 EXPECTED（' + names(expL) + '），需人工确认' + p1Tail });
  }
  return Object.assign(res, { kind: 'ok', text: 'T4-A 可签收：P0 全部 PASS' + p1Tail });
}

/* ---------------- 小工具 ---------------- */

async function waitFor(pred, timeoutMs, intervalMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (pred()) return true;
    await sleep(intervalMs || 40);
  }
  return !!pred();
}

function pattern(size, seed) {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 7 + (seed || 13)) & 0xff;
  return out;
}

function appendBytes(base, chunk) {
  const merged = new Uint8Array(base.length + chunk.length);
  merged.set(base, 0);
  merged.set(chunk, base.length);
  return merged;
}

function propText(p) {
  const props = p || {};
  const on = ['read', 'write', 'writeNoResponse', 'notify', 'indicate'].filter(function (k) {
    return !!props[k];
  });
  return on.length ? on.join('+') : '无属性';
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : n;
}

/* ---------------- 1. 扫描 ---------------- */

async function checkScan(ctx) {
  const ble = ctx.ble;
  const target = ctx.target;
  const seen = {}; // deviceId -> 广播名
  const names = [];
  const connected = !!ble.connected;

  const off = ble.on('devices', function (list) {
    (list || []).forEach(function (d) {
      if (!d || !d.deviceId) return;
      if (!seen[d.deviceId]) {
        const label = d.localName || d.name || '(无名)';
        seen[d.deviceId] = label;
        names.push(label + '@' + (typeof d.RSSI === 'number' ? d.RSSI : '-') + 'dBm');
      }
    });
  });

  try {
    await ble.stopScan();
    await sleep(300);
    await ble.startScan();
    await sleep(6000); // 收满 6s，只认本窗口广播
    await ble.stopScan();
  } catch (err) {
    off();
    return fail('扫描失败：' + describe(err).text);
  }
  off();

  const count = Object.keys(seen).length;
  const list = names.slice(0, 4).join('、');

  // 协议 §2.1：设备连接后停止广播是正常行为，0 台不是故障；本项也不能作为 T4 证据
  if (connected) {
    return expected(
      '当前处于连接态，6s 扫描到 ' + count + ' 台' + (count ? '（' + list + '）' : '') +
        '。设备连接后停止广播属正常行为（§2.1），本项要在「断开状态」下重测才算 T4 证据'
    );
  }

  if (count === 0) {
    return fail(
      '6s 扫描窗口内没有收到任何 NUS 广播：确认设备上电且未被其它手机连着；' +
        'Android 还需开启系统定位并授予微信定位权限'
    );
  }

  if (target && target.deviceId && !seen[target.deviceId]) {
    // Android 的 deviceId 会随系统重新分配而漂移，名称通常稳定：按名字命中仍算找到目标
    const byName = target.name
      ? Object.keys(seen).filter(function (id) {
          return seen[id] === target.name;
        })[0]
      : '';
    if (!byName) {
      return fail('收到 ' + count + ' 台广播（' + list + '），但目标设备不在其中；请靠近设备或确认广播已恢复');
    }
    return pass(
      '连接前扫描：6s 内收到 ' + count + ' 台 NUS 广播（' + list + '）；目标按名称「' + target.name +
        '」命中（deviceId 由系统重新分配，已从 ' + target.deviceId + ' 变为 ' + byName + '）；未使用 getBluetoothDevices 补种缓存'
    );
  }

  return pass(
    '连接前扫描：6s 内收到 ' + count + ' 台 NUS 广播' + (list ? '（' + list + '）' : '') +
      '；未使用 getBluetoothDevices 补种缓存'
  );
}

/**
 * 在断开状态下跑第 1 项，然后恢复链路。
 * T4 要求扫描必须在连接前做：连接态扫描只能记 EXPECTED，永远拿不到证据。
 * 这里代跑「断开 → 等设备重新广播 → 扫描 → 重连 → 重新发现/订阅/登录」，
 * 让一次「运行全部」就能产出第 1 项的 PASS。
 */
async function scanDisconnected(ctx) {
  const ble = ctx.ble;
  const protocol = ctx.protocol;
  const target = ctx.target || {};
  const started = Date.now();

  if (!target.deviceId) {
    if (!ble.connected) {
      // 从来没连过（没有历史目标）：断开态直接扫，收到 NUS 广播即可，不需要「目标是哪台」
      const r = await checkScan({ ble: ble, protocol: protocol, target: {} });
      return { result: r, restored: true, adv: null, ms: Date.now() - started };
    }
    return { result: skip('没有目标设备记录，无法自动断开重扫（请先扫描并连接一次）'), restored: false, adv: null };
  }
  if (!ble.connected) {
    // 本来就断开：直接扫，不需要恢复
    const r = await checkScan(ctx);
    return { result: r, restored: true, adv: null, ms: Date.now() - started };
  }

  const drop = await ble.disconnect();
  const adv = drop.closed
    ? await ble.waitForAdvertising(target.deviceId, target.name, ADV_EVIDENCE_WAIT_MS)
    : { seen: false, ms: 0, rssi: 0 };

  const r = await checkScan(ctx);

  // 恢复链路：重新发现 + 重新订阅 + 重新登录，供后续 10 项继续取证
  let restored = false;
  let restoreErr = '';
  try {
    await ble.connect(target.deviceId, target.name);
    const info = await ble.discover();
    await ble.subscribe('CMD_TX');
    await ble.subscribe('DATA_TX');
    if (protocol.hasCredentials()) await protocol.relogin();
    restored = !info.missing.length;
  } catch (e) {
    restoreErr = describe(e).text;
  }

  const advText = adv.seen
    ? '断开后 ' + (adv.ms / 1000).toFixed(1) + 's 扫到设备重新广播（RSSI ' + adv.rssi + 'dBm）'
    : '断开后 12s 内未扫到重新广播';

  let result = r;
  if (r.status === 'pass') {
    result = pass(advText + '；' + r.detail + '；已重新连接并恢复订阅');
  } else if (!drop.closed) {
    // 链路没断成：设备很可能仍在连接态、不广播。这不是扫描能力的问题，不能记 FAIL。
    result = expected(
      '未能确认链路断开（' + (drop.attempts || 1) + ' 次 close，系统未上报断连且仍能读到服务），' +
        '设备很可能仍处于连接态、不广播，本次扫描不构成 T4 证据：' + r.detail
    );
  } else if (r.status === 'expected') {
    result = fail('已在断开状态下扫描，仍判为 EXPECTED（判定逻辑异常）：' + r.detail);
  } else {
    // 链路确实断了但仍扫不到：这是真的发现性问题
    result = fail(advText + '：' + r.detail);
  }

  return {
    result: result,
    restored: restored,
    restoreErr: restoreErr,
    adv: adv,
    drop: drop,
    ms: Date.now() - started,
  };
}

/* ---------------- 人工项取证：apply / rescue ---------------- */

function hasIp(st) {
  return !!st && !!st.sta_has_ip && !!st.sta_ip && st.sta_ip !== '0.0.0.0';
}

function apFieldOf(net) {
  if (!net) return '';
  const keys = ['ap_ssid', 'ap_password_set', 'ap_enabled', 'startup_fallback_to_ap', 'ap_ip'];
  const hit = keys.filter(function (k) {
    return net[k] !== undefined;
  });
  return hit.join('/');
}

async function readProvisioned(ctx) {
  const cfg = await ctx.protocol.configGet();
  const st = await ctx.protocol.networkStatus();
  let profiles = [];
  try {
    profiles = netdiag.profilesOf(await ctx.protocol.profileList());
  } catch (e) {
    profiles = []; // 旧固件没有 profile.list 时不能阻断核验
  }
  const net = (cfg && cfg.network) || {};
  return {
    cfg: cfg || {},
    net: net,
    st: st || {},
    profiles: profiles,
    verdict: netdiag.classify(st || {}, net.sta_ssid || (st && st.sta_ssid) || '', profiles),
  };
}

/**
 * 第 13 项：人工完成配网后，一键核验「真的上线」且「断开重连后仍在」。
 * @param {{ssid?:string, reconnect?:boolean}} [opts]
 */
async function verifyApply(ctx, opts) {
  const o = opts || {};
  const ble = ctx.ble;
  const protocol = ctx.protocol;
  const target = ctx.target || {};

  if (!ble.connected) return skip('蓝牙未连接，无法核验配网结果');
  if (!protocol.loggedIn) return skip('未登录，无法读取 config.get / network.status');

  // 只读当前状态会把「历史配置」误当成这次配网的成果：必须有本次 apply 的记录
  const rec = provision.lastProvision();
  if (!rec) {
    return skip('未记录到本次配网：请先在网络配置页走完 scan → tryconnect → apply，再回来核验');
  }
  const ageMin = Math.round((Date.now() - rec.at) / 60000);
  if (Date.now() - rec.at > 30 * 60 * 1000) {
    return skip('最近一次配网成功是 ' + ageMin + ' 分钟前（超过 30 分钟），请重新走一次配网再核验');
  }

  const before = await readProvisioned(ctx);
  const issues = [];
  const risks = [];
  const notes = [];
  const ap = apFieldOf(before.net);
  if (ap) issues.push('config.get 仍含 AP 字段（' + ap + '）');
  if (before.net.net_mode && before.net.net_mode !== 'sta') {
    issues.push('net_mode=' + before.net.net_mode + '（应为 sta）');
  }
  if (!hasIp(before.st)) {
    issues.push('network.status 无有效 IP（sta_ip=' + (before.st.sta_ip || '-') + '）');
  }
  if (!before.st.mqtt_connected) issues.push('MQTT 未连接');
  /* 契约 v1.1 got_ip 语义（states.json#got_ip_semantics）：IP + 联网验证 + MQTT 就绪三者缺一不交付。
   * 核验判据与 provision 成功判据统一：internet_verified=false 即未完成联网交付（sta_has_ip≠已联网）。 */
  if (before.st.internet_verified === false) issues.push('联网验证未通过（internet_verified=false，broker 路径不通）');

  const ssid = o.ssid || rec.ssid || before.verdict.formalSsid || '';
  if (!ssid) issues.push('未取到 sta_ssid');
  if (o.ssid && before.verdict.formalSsid && o.ssid !== before.verdict.formalSsid) {
    issues.push('正式配置 SSID 与目标不一致（目标 ' + o.ssid + '，配置 ' + before.verdict.formalSsid + '）');
  }
  /* 运行态判读：sta_connected + 正式 sta_ssid 不能证明「正式 AP 还连着」。
     只有 connected_ssid（运行态）与正式 SSID 一致才算真在线；否则要么是回退（FAIL），
     要么固件没暴露该字段只能记 EXPECTED。 */
  if (before.verdict.kind === 'fallback') {
    issues.push(
      '设备实际连在「' + before.verdict.connectedSsid + '」，不是正式配置的「' +
        before.verdict.formalSsid + '」（自动回退，正式 AP 并未恢复）'
    );
  } else if (before.verdict.kind === 'unknown' && before.verdict.others.length) {
    risks.push(
      '固件未暴露 connected_ssid，且仍保存其它 profile（' + before.verdict.others.join('、') +
        '），无法排除自动回退'
    );
  } else if (before.verdict.kind === 'unknown') {
    notes.push('固件未暴露 connected_ssid，SSID 一致性按「无其它 profile ⇒ 不可能回退」推断（非直读证据）');
  }
  if (issues.length) {
    return fail('核验未通过：' + issues.join('；') + '。请确认已在网络配置页走完 accepted → got_ip → apply');
  }

  const inSession =
    '本次配网 operation_id=' + rec.operationId + '（' + ageMin + ' 分钟前 apply 成功）· ' +
    '正式 sta_ssid=' + ssid + ' · ' + before.verdict.label + ' · ' +
    (before.verdict.connectedSsid ? 'connected_ssid=' + before.verdict.connectedSsid + ' · ' : '') +
    'sta_ip=' + before.st.sta_ip + ' · mqtt_connected=true · net_mode=sta' +
    (notes.length ? '；' + notes.join('；') : '');
  const riskText = risks.length ? '；' + risks.join('；') + '（只记 EXPECTED，不计 PASS）' : '';

  if (o.reconnect === false) {
    const d = inSession + '；未做断开重连持久化核验（本次仅会话内核验）';
    return risks.length ? expected(d + riskText) : pass(d);
  }

  // 持久化：断开 → 等广播 → 重连 → 重新读取，证明配置真的写进 NVS 而不是只活在这次连接里
  const s0 = ble.snapshot();
  const drop = await ble.disconnect();
  const adv = drop.closed
    ? await ble.waitForAdvertising(target.deviceId, target.name, ADV_EVIDENCE_WAIT_MS)
    : { seen: false, ms: 0, rssi: 0 };

  if (!drop.closed || !adv.seen) {
    let restored = false;
    try {
      await ble.connect(target.deviceId, target.name);
      const info = await ble.discover();
      await ble.subscribe('CMD_TX');
      await ble.subscribe('DATA_TX');
      await protocol.relogin();
      restored = !info.missing.length;
    } catch (e) {
      restored = false;
    }
    return expected(
      '会话内已核对通过（' + inSession + riskText + '），但未能确认链路断开' +
        (adv.seen ? '' : '（12s 内未扫到设备重新广播）') +
        '，持久化未取证。' + (restored ? '已恢复连接与订阅。' : '重连恢复失败，请手动重连。') +
        '请重试本项或在设备页断开后再核验'
    );
  }

  let after = null;
  try {
    await ble.connect(target.deviceId, target.name);
    const info = await ble.discover();
    await ble.subscribe('CMD_TX');
    await ble.subscribe('DATA_TX');
    await protocol.relogin();
    if (info.missing.length) throw new Error('重连后发现特征不完整：' + info.missing.join('/'));
    after = await readProvisioned(ctx);
  } catch (e) {
    return fail('断开重连后核验失败：' + describe(e).text);
  }

  const s1 = ble.snapshot();
  const problems = [];
  if (!hasIp(after.st)) problems.push('重连后无 IP');
  if (!after.st.mqtt_connected) problems.push('重连后 MQTT 未连接');
  if (!after.verdict.formalSsid) problems.push('重连后未取到正式 SSID');
  else if (after.verdict.formalSsid !== ssid) problems.push('重连后正式配置 SSID 变为 ' + after.verdict.formalSsid);
  if (after.verdict.kind === 'fallback') {
    problems.push('重连后实际连在「' + after.verdict.connectedSsid + '」，不是正式配置（自动回退）');
  }
  if (!after.net.net_mode || after.net.net_mode !== 'sta') problems.push('重连后 net_mode 异常');
  if (problems.length) return fail('配置未持久化：' + problems.join('；'));

  const afterRisk =
    after.verdict.kind === 'unknown' && after.verdict.others.length
      ? '；重连后仍无法确认实际 SSID（connected_ssid 未暴露，存在其它 profile）'
      : '';

  const detail =
    '会话内：' + inSession + '；' +
    '断开重连（设备侧确认：' + (adv.ms / 1000).toFixed(1) + 's 恢复广播，RSSI ' + adv.rssi + 'dBm）后配置仍在：' +
    '正式 sta_ssid=' + after.verdict.formalSsid + ' · ' + after.verdict.label +
    (after.verdict.connectedSsid ? '（connected_ssid=' + after.verdict.connectedSsid + '）' : '') +
    ' · sta_ip=' + after.st.sta_ip +
    ' · mqtt_connected=true · 会话 #' + s0.sessionId + ' → #' + s1.sessionId +
    '；未匹配响应 0 条，缓冲残留 0B';

  // 有「无法确认实际 SSID」的风险时不升格为 PASS（阶段可签收，但这一项证据不完整）
  return risks.length ? expected(detail + riskText + afterRisk) : pass(detail + afterRisk);
}

/**
 * 第 14 项第一步：确认设备确实处于断网状态（没有 IP 或 MQTT 断开）。
 *
 * T4 前置（协议 §11.1 P0-5）：必须关掉**所有**已保存 AP 或先删掉其它 profile，
 * 否则设备会自动回退到另一个已保存网络，sta_connected 仍为 true，测不到真正的 no-IP。
 * 这里先查 profile 列表，发现有非正式 profile 就拦下来，不让「假断网」被当成救援证据。
 *
 * 返回快照，供第二步对比。
 */
async function rescueCapture(ctx) {
  if (!ctx.ble.connected) return { result: skip('蓝牙未连接，无法读取设备状态'), snapshot: null };
  /* 断网时 network.status 的 sta_ssid 可能为空，正式 SSID 必须从 config.get 取；
     否则「正式 profile」会被误判成「其它 profile」，救援前置检查自己把自己拦住。 */
  const cur0 = await readProvisioned(ctx);
  const st = cur0.st;
  const profiles = cur0.profiles;
  const v = netdiag.classify(st, cur0.net.sta_ssid || '', profiles);
  const snapshot = {
    at: Date.now(),
    ip: st.sta_ip || '',
    hasIp: hasIp(st),
    ssid: v.formalSsid,
    connectedSsid: v.connectedSsid,
    mqtt: !!st.mqtt_connected,
    mode: st.mode || '',
    lastDisconnect: st.last_disconnect || '',
    profiles: v.profiles,
    /* 记下此刻之前的救援动作基线：核验时只有「比它更晚的 apply」才算这次救援 */
    attemptAt: (provision.lastRescueAttempt() || {}).at || 0,
  };

  if (v.others.length) {
    return {
      result: expected(
        '设备还保存了其它 profile（' + v.others.join('、') + '）' +
          (v.residue.length ? '，其中 ' + v.residue.length + ' 个是压测残留（' + v.residue.join('、') + '）' : '') +
          '：关掉正式 AP 后会自动回退到它们，sta_connected 仍然为 true，测到的不是真正的 no-IP。' +
          '先点「清理其它 profile」只留「' + (v.formalSsid || '-') + '」，再回来记录断网状态'
      ),
      snapshot: null,
      needCleanup: true,
      keep: v.formalSsid,
      others: v.others,
    };
  }

  /* T4 #14 要的是「真 no-IP」。只要还有 IP，链路就还在——可能是回退到别的已保存 AP，
     也可能只是 DHCP 租约没过期；此时记快照会让后面的核验变成走过场。 */
  if (snapshot.hasIp) {
    const where = v.connectedSsid || '未暴露';
    return {
      result: expected(
        '设备仍有 IP：sta_has_ip=true、sta_ip=' + snapshot.ip + '、connected_ssid=' + where +
          '、mqtt_connected=' + snapshot.mqtt + '，不算断网，也不是 no-IP 现场。' +
          'T4 #14 要求 sta_has_ip=false / sta_ip=0.0.0.0 / mqtt_connected=false。' +
          (v.kind === 'fallback'
            ? '当前实际连在「' + where + '」（正式配置是「' + (v.formalSsid || '-') + '」）：' +
              '说明关停正式 AP 后设备回退了，先清理其它 profile 或关闭所有已保存 AP。'
            : '请关掉上游 AP（或改错口令）并等关联/租约超时后再记录')
      ),
      snapshot: null,
    };
  }
  if (snapshot.mqtt) {
    return {
      result: expected('设备 mqtt_connected=true，说明网络还在（无 IP 却有 MQTT 属异常状态），请先确认真正断网'),
      snapshot: null,
    };
  }
  return {
    result: expected(
      '已确认真 no-IP：sta_has_ip=false、sta_ip=0.0.0.0、mqtt_connected=false' +
        '（last_disconnect=' + (snapshot.lastDisconnect || '-') + '、mode=' + (snapshot.mode || '-') +
        '、connected_ssid=' + (v.connectedSsid || '空') +
        '、已保存 profile 仅「' + (snapshot.ssid || '-') + '」）。' +
        '现在在网络配置页重新 scan → tryconnect → operation.get → apply，恢复后点「核验救援结果」'
    ),
    snapshot: snapshot,
  };
}

/** 删除除正式 SSID 之外的已保存 profile（T4 无 IP 救援的前置清理） */
async function rescueCleanup(ctx) {
  if (!ctx.ble.connected) return { result: skip('蓝牙未连接，无法读改 profile'), cleaned: false };
  if (!ctx.protocol.loggedIn) return { result: skip('未登录，无法修改 profile'), cleaned: false };

  let cfg;
  try {
    cfg = await ctx.protocol.configGet(['network']);
  } catch (e) {
    return { result: fail('读取 config.get 失败：' + describe(e).text), cleaned: false };
  }
  const keep = ((cfg && cfg.network && cfg.network.sta_ssid) || '').trim();
  if (!keep) {
    return { result: fail('设备没有正式 SSID（sta_ssid 为空），无法确定保留哪个 profile，已中止'), cleaned: false };
  }

  const r = await netdiag.cleanupProfiles(ctx, keep);
  if (r.error) return { result: fail(r.error), cleaned: false };

  let left = [];
  try {
    left = netdiag.profilesOf(await ctx.protocol.profileList()).map(function (p) {
      return p && p.ssid;
    });
  } catch (e) {
    left = [];
  }
  const otherLeft = left.filter(function (s) {
    return s && s !== keep;
  });

  if (otherLeft.length) {
    return {
      result: fail(
        '仍有其它 profile 未删除：' + otherLeft.join('、') +
          (r.failed.length ? '（删除失败：' + r.failed.join('、') + '）' : '')
      ),
      cleaned: false,
    };
  }
  if (!r.deleted.length) {
    return {
      result: expected('本来就只有正式 profile「' + keep + '」，无需清理。可以直接关掉上游 AP 测 no-IP'),
      cleaned: true,
    };
  }
  return {
    result: pass(
      '已删除 ' + r.deleted.length + ' 个非正式 profile（' + r.deleted.join('、') + '）' +
        (r.residue && r.residue.length ? '，其中测试残留 ' + r.residue.length + ' 个' : '') +
        '，只保留「' + keep + '」。现在关掉该 AP 才是真正的无 IP，救援测试才有效'
    ),
    cleaned: true,
  };
}

/**
 * 第 14 项第二步：救援后必须恢复 IP + MQTT，且恢复到的就是目标 SSID（不是回退）。
 *
 * 不能「点一下核验」就下结论：
 *   1) snapshot 之后没有新的 apply → 记 EXPECTED（还没做救援 ≠ 救援失败；
 *      真机上出现过「记完快照 5s 就点核验」被误判成 FAIL 的情况）；
 *   2) 有 apply → 轮询等待恢复（apply 后 DHCP + MQTT 需要时间），
 *      只有等满 waitMs 仍不恢复才 FAIL，并把 operation_id / 等待时长 / last_disconnect 写进证据。
 */
async function rescueVerify(ctx, snapshot, opts) {
  const o = opts || {};
  if (!snapshot) return skip('请先点「记录断网状态」（救援前取证）');
  if (!ctx.ble.connected) return skip('蓝牙未连接，无法读取设备状态');

  const attempt = provision.lastRescueAttempt();
  const since = Math.round((Date.now() - snapshot.at) / 1000);
  const base = snapshot.attemptAt || snapshot.at;
  if (!attempt || !attempt.at || attempt.at <= base) {
    return expected(
      '距记录断网 ' + since + 's，但还没检测到救援动作（没有晚于该快照的 apply）。' +
        '本项不判 FAIL：请先去网络配置页对「' + (snapshot.ssid || '正式 SSID') + '」重新走 scan → tryconnect → apply，' +
        '设备拿到 IP 后回本页再点「核验救援结果」'
    );
  }

  const waitMs = o.waitMs === undefined ? RESCUE_WAIT_MS : o.waitMs;
  const intervalMs = o.intervalMs || RESCUE_POLL_MS;
  const deadline = Date.now() + waitMs;
  let cur = null;
  let problems = [];
  let polls = 0;

  for (;;) {
    cur = await readProvisioned(ctx);
    polls += 1;
    problems = [];
    if (!hasIp(cur.st)) problems.push('仍无有效 IP（sta_ip=' + (cur.st.sta_ip || '-') + '）');
    if (!cur.st.mqtt_connected) problems.push('MQTT 仍未连接');
    const ap = apFieldOf(cur.net);
    if (ap) problems.push('出现 AP 字段（' + ap + '）');
    if (cur.net.net_mode && cur.net.net_mode !== 'sta') problems.push('net_mode=' + cur.net.net_mode);
    /* 有 IP 不等于救回来了：回退到别的 profile 也会「有 IP + MQTT」 */
    if (cur.verdict.kind === 'fallback') {
      problems.push(
        '实际连在「' + cur.verdict.connectedSsid + '」，不是目标「' + (cur.verdict.formalSsid || snapshot.ssid || '-') +
          '」（自动回退，正式 AP 并未恢复）'
      );
    }
    if (cur.verdict.others.length) {
      problems.push('仍保存其它 profile（' + cur.verdict.others.join('、') + '），救援结论不可信，先清理再测');
    }
    if (!problems.length) break;
    /* 结构性问题（profile 列表 / AP 字段 / net_mode）不会随等待自愈——等满 20s 只是
       让用户对着"等待设备恢复"干瞪眼。首次出现立即终止并出结论。 */
    const staticProblem = problems.some(
      (p) => p.indexOf('仍保存其它') === 0 || p.indexOf('出现 AP 字段') === 0 || p.indexOf('net_mode=') === 0
    );
    /* 进度回报：页面用它显示"已读 N 次 / 剩余 Xs / 当前卡在哪"，避免黑盒等待 */
    if (typeof o.onPoll === 'function') {
      o.onPoll({
        polls: polls,
        remainMs: Math.max(0, deadline - Date.now()),
        problems: problems.slice(),
      });
    }
    if (staticProblem || Date.now() >= deadline) break;
    await sleep(intervalMs);
  }

  const waited = Math.max(0, Math.round((Date.now() - attempt.at) / 1000));
  const took = Math.round((Date.now() - snapshot.at) / 1000);

  if (problems.length) {
    return fail(
      '救援未恢复（operation_id=' + (attempt.operationId || '-') + '，阶段 ' + (attempt.stage || 'apply') +
        '，已等 ' + waited + 's / ' + polls + ' 次轮询）：' +
        problems.join('；') +
        '。最后状态：sta_ip=' + (cur.st.sta_ip || '-') + '、mqtt_connected=' + (cur.st.mqtt_connected ? 'true' : 'false') +
        '、connected_ssid=' + (cur.verdict.connectedSsid || '未暴露') +
        '、last_disconnect=' + (cur.st.last_disconnect || '-') +
        '（距记录断网 ' + took + 's）。' +
        (attempt.stage === 'tryconnect'
          ? '试连阶段就中断了，没有提交 apply：先确认口令正确、上游 AP 已开、扫描能看到该 SSID'
          : '请确认上游 AP 确实已恢复、口令未变，再重新 scan → tryconnect → apply')
    );
  }

  const note =
    cur.verdict.kind === 'unknown'
      ? '；connected_ssid 未暴露（旧固件），实际 SSID 按「只剩正式 profile」推断'
      : '';
  const detail =
    '救援前：sta_ip=' + (snapshot.ip || '无') + '、mqtt_connected=' + snapshot.mqtt +
    '、last_disconnect=' + (snapshot.lastDisconnect || '-') +
    '、已保存 profile=' + ((snapshot.profiles && snapshot.profiles.length) ? snapshot.profiles.join('、') : '仅正式 1 个') + '；' +
    '救援动作：operation_id=' + (attempt.operationId || '-') + '（apply 后 ' + waited + 's 恢复，' + polls + ' 次轮询）；' +
    '救援后：' + cur.verdict.label +
    (cur.verdict.connectedSsid ? '（connected_ssid=' + cur.verdict.connectedSsid + '）' : '') +
    '、sta_ip=' + cur.st.sta_ip + '、mqtt_connected=true、last_disconnect=' + (cur.st.last_disconnect || '-') +
    '；全程 net_mode=sta、无 AP 字段；距记录断网 ' + took + 's（BLE 单通道完成）' + note;

  return pass(detail);
}

/* ---------------- 2. 服务与特征 ---------------- */

async function checkGatt(ctx) {
  const info = await ctx.ble.discover();
  const rows = CHAR_KEYS.map(function (k) {
    const c = info.chars[k];
    return k + '=' + (c ? shortUuid(c.id) + '[' + propText(c.properties) + '](' + c.by + ')' : '缺失');
  });
  const weak = CHAR_KEYS.filter(function (k) {
    return info.chars[k] && info.chars[k].by === 'uuid-weak';
  });
  const byProperty = CHAR_KEYS.filter(function (k) {
    return info.chars[k] && info.chars[k].by === 'property';
  });

  if (info.missing.length) {
    return fail('缺少特征：' + info.missing.join('、') + '；' + rows.join(' '));
  }
  if (weak.length) {
    return fail('特征 UUID 命中但属性不符：' + weak.join('、') + '，设备侧 GATT 定义有问题；' + rows.join(' '));
  }
  return pass(
    '服务 ' + shortService(info.serviceId) + '（' + info.serviceSource + '，共 ' + info.total + ' 个特征）· ' +
      rows.join(' ') +
      (byProperty.length ? ' · ' + byProperty.join('、') + ' 按属性回退解析' : '')
  );
}

/* ---------------- 3. 订阅 ---------------- */

async function checkNotify(ctx) {
  const ble = ctx.ble;
  const protocol = ctx.protocol;

  await ble.subscribe('CMD_TX');
  await ble.subscribe('DATA_TX');

  // CMD 方向：订阅后发 device.info，必须真的收到通知
  const b0 = ble.snapshot();
  await protocol.deviceInfo();
  const b1 = ble.snapshot();
  if (b1.cmdNotify <= b0.cmdNotify) {
    return fail('已订阅 CMD TX，但 device.info 没有触发任何通知（订阅未生效？）');
  }

  // DATA 方向：开回环 → 订阅后写 20B → 必须收到回传
  const before = ble.snapshot().dataFrames;
  const payload = pattern(20, 3);
  let got = new Uint8Array(0);
  const off = ble.on('data', function (chunk) {
    got = appendBytes(got, chunk);
  });
  try {
    await protocol.dataLoopback(true);
    await ble.write('DATA_RX', payload);
    await waitFor(function () {
      return got.length >= 20;
    }, 2500);
  } finally {
    off();
    try {
      await protocol.dataLoopback(false);
    } catch (e) {
      /* 关闭失败不影响判定 */
    }
  }
  const after = ble.snapshot().dataFrames;

  if (after <= before) {
    return fail('DATA TX 已订阅，但写 DATA RX 后没有任何回传（先确认 data.loopback 已打开）');
  }
  if (got.length < 20) {
    return fail('DATA 回传不完整：期望 20B，收到 ' + got.length + 'B');
  }
  if (!equals(payload, got.slice(0, 20))) {
    return fail('DATA 回传字节不一致（首个差异位于第 ' + firstDiff(payload, got.slice(0, 20)) + ' 字节）');
  }
  return pass(
    '订阅在写之前完成：CMD 通知 +' + (b1.cmdNotify - b0.cmdNotify) + ' 片，DATA 回环 +' +
      (after - before) + ' 帧且 20B 逐字节一致'
  );
}

/* ---------------- 4. 10 次 network.scan ---------------- */

/**
 * scan 超时（network.scan 的 30s 命令超时到期）后的归因，2026-11-08 00:12 真机 #4 新增。
 *
 * 背景：那轮第 1 次 scan 就 timeout，紧接着 relink 两次扫描 26s 扫不到设备 →
 * `_relinkFailedOnce` 锁死 → 后续 21 项 SKIP、报告结论"不可签收"。
 * 但 timeout 的成因有四种，混在一起就会把主机侧问题写成设备缺陷：
 *   - 设备侧断链（30s 内链路被断，scan 期间射频被独占/LL 超时）：只能 relink
 *   - 迟到响应（30s 后才回，链活）：拆链反而更糟——设备要 12s 才恢复广播；不 relink
 *   - 半帧残留：设备发到一半断链，与"被动断链"同类
 *   - 无回声且链路报活：设备卡在 scan（命令没被消费），先探链再决定
 * 纯逻辑，主机自测直接覆盖。
 */
function classifyScanTimeout(d) {
  const x = d || {};
  const dDisc = Number(x.dDisc) || 0;
  const dUnm = Number(x.dUnm) || 0;
  const pending = Number(x.pending) || 0;
  if (dDisc > 0) {
    return { kind: 'device_drop', action: 'relink', text: '设备侧断链（被动断链 +' + dDisc + '）' };
  }
  if (dUnm > 0) {
    return { kind: 'late_rsp', action: 'continue', text: '迟到响应 +' + dUnm + '（链路仍活，判设备侧慢）' };
  }
  if (pending > 0) {
    return { kind: 'half_frame', action: 'relink', text: '半帧残留 ' + pending + 'B（响应发到一半断链）' };
  }
  if (x.linked === false) {
    return { kind: 'link_down', action: 'relink', text: '链路已断（无断连事件，连接态滞后）' };
  }
  return { kind: 'no_echo', action: 'probe', text: '无回声（链路报活但命令 30s 未被执行；2026-11-08 串口实证成因=设备侧扫描被 BLE 共存饿死 DEF-SCAN-002，固件已改默认 scan time，若复现请抓串口 scan 行）' };
}

async function checkScanRepeat(ctx) {
  const ble = ctx.ble;
  const protocol = ctx.protocol;

  // 前置登录保障（T4 2026-11-05 #4 教训）：无凭据时明确报因，
  // 而不是让协议层落到 unauthorized 的通用文案里猜。
  if (!protocol.loggedIn && !protocol.hasCredentials()) {
    return fail('未登录且无凭据，请先在设备页登录（network.scan 需要登录态）');
  }

  const p0 = protocol.snapshot();
  const started = Date.now();
  // BUDGET 180s：固件 DEF-SCAN-001 ② 节流后，每次 scan 结束后有 3s 冷却，
  // 10 次连扫 ≈ 10×5.8s（单次耗时 > 3s 节流窗，残余冷却大多为 0）+ 偶发 busy 重试 ≈ 90–110s，180s 余量足够。
  const BUDGET = 180000;
  let okCount = 0;
  let netFail = 0;
  let relinked = 0;
  let busyCount = 0; // 固件节流拒绝次数（DEF-SCAN-001 ② 预期行为，不是失败）
  let lateRsp = 0;   // 30s 超时后迟到响应（链活，未拆链）次数
  const scanNotes = []; // 每次链路级失败的成因轨迹
  const frames = [];
  const bytes = [];

  /* scan 节流（契约 timing.json#wifi.scan_throttle_s=3）：冷却自「扫描结束」起算。
   * 记 scanDoneAt 等残余冷却——2026-11-09 实证固定等 1s 每次成功连吃 2 次 busy、
   * 单轮 ~7.6s；scan 的 busy 与 op 占用的 busy 同码不同语义，不套 1500ms。
   * 锚点规则：成功回包到达 ≈ 扫描结束，记 scanDoneAt；busy 时设备在忙别人的扫描，
   * 结束时刻未知，以本次 busy 时刻重锚按满窗冷却（每次 busy 至多等 3s，预算内收敛）。 */
  const SCAN_THROTTLE_MS = contract.SCAN_THROTTLE_MS;
  let scanDoneAt = 0;
  const waitScanResidual = async function () {
    if (!scanDoneAt) return; // 首轮无锚不空等
    const residual = scanDoneAt + SCAN_THROTTLE_MS - Date.now();
    if (residual > 0) await sleep(residual);
  };

  const durs = []; // 单次 scan 耗时：DEF-SCAN-002 饿死会表现为单次时长异常拉长
  let tried = 0; // 用掉的轮次（成功 + 被超时/重连/network_failed 占用的）
  for (let i = 1; i <= 10 && Date.now() - started <= BUDGET; i++) {
    tried = i;
    const b0 = ble.snapshot();
    const t0 = Date.now();
    let d;
    try {
      // 固件 3s 扫描节流回 busy：先等残余冷却再发，busy 时以 busy 时刻重锚再等——
      // 不消耗槽位、不走重连（链路活着，relink 分支语义又慢又脏）。预算耗尽则上抛。
      for (;;) {
        try {
          await waitScanResidual();
          d = await protocol.networkScan();
          break;
        } catch (e) {
          if (e.code === 'busy' && Date.now() - started <= BUDGET) {
            busyCount += 1;
            scanDoneAt = Date.now(); // 重锚：从本次 busy 起按满窗（≤3s）冷却
            continue;
          }
          throw e;
        }
      }
      scanDoneAt = Date.now();
      const b1 = ble.snapshot();
      if (!d || typeof d.count !== 'number' || !Array.isArray(d.aps)) {
        return fail('第 ' + i + ' 次 network.scan 结构不完整（缺 count/aps）：' + JSON.stringify(d).slice(0, 120));
      }
      okCount += 1;
      durs.push(Date.now() - t0);
      frames.push(b1.cmdNotify - b0.cmdNotify);
      bytes.push(
        typeof b1.cmdBytes === 'number' && typeof b0.cmdBytes === 'number'
          ? b1.cmdBytes - b0.cmdBytes
          : b1.notifyBytes - b0.notifyBytes
      );
    } catch (e) {
      if (e.code === 'network_failed') {
        netFail += 1;
        continue; // 协议允许偶发失败，提示稍后重试即可
      }
      // 链路级失败（timeout/disconnected 等）：先标定成因，再决定要不要拆链重连。
      // T4 2026-11-05 #4 教训：一次失败曾让本轮后续 12 项全部 SKIP。重连也失败才终止本项。
      // 2026-11-08 00:12 真机 #4：第 1 次 scan 超时 → 立即 relink → 设备广播未恢复
      // （主动断链后 ~12s 不广播）→ 两次扫描 26s 全空 → _relinkFailedOnce 锁死 → 21 项 SKIP。
      // 这里先给 4s 迟到响应窗口；late_rsp 说明链活，拆链只会更糟。
      const sA = ble.snapshot();
      const pA = protocol.snapshot();
      await sleep(4000);
      const sB = ble.snapshot();
      const pB = protocol.snapshot();
      const cls = classifyScanTimeout({
        dDisc: (sB.disconnects || 0) - (sA.disconnects || 0),
        dUnm: (pB.unmatched || 0) - (pA.unmatched || 0),
        pending: sB.pendingBytes || 0,
        linked: !!ble.connected,
      });
      scanNotes.push('#' + i + ' ' + e.code + '/' + cls.kind);
      if (cls.action === 'continue') {
        lateRsp += 1;
        continue;
      }
      const rel = await tryRelink(ctx);
      if (rel.ok) {
        relinked += 1;
        continue;
      }
      return fail(
        '第 ' + i + ' 次 network.scan 失败：' + e.code + ' ' + describe(e).text +
        '（成因=' + cls.text + '；自动重连未恢复：' + rel.reason + '）' +
        (scanNotes.length > 1 ? '；轨迹=' + scanNotes.join(', ') : '')
      );
    }
  }

  const p1 = protocol.snapshot();
  if (!okCount) return fail('10 次扫描均未成功（network_failed ' + netFail + ' 次）');
  if (p1.unmatched !== p0.unmatched) return fail('扫描期间出现未匹配响应（串包/串道）');
  if (ble.snapshot().pendingBytes !== 0) return fail('扫描结束后重组缓冲残留 ' + ble.snapshot().pendingBytes + 'B');

  const span = function (arr) {
    return Math.min.apply(null, arr) + '–' + Math.max.apply(null, arr);
  };
  const detail =
    okCount + ' 次成功' + (busyCount ? ' / 固件节流 busy ' + busyCount + ' 次（按残余冷却 ≤3s 重试）' : '') +
    (netFail ? ' / network_failed ' + netFail + ' 次' : '') +
    (lateRsp ? ' / 迟到响应 ' + lateRsp + ' 次（未拆链）' : '') +
    (relinked ? ' / 断链重连 ' + relinked + ' 次' : '') +
    ' · 响应 ' + span(bytes) + 'B / ' + span(frames) + ' 片 · 每次 id 匹配、AP 列表可解析、未匹配 0' +
    /* DEF-SCAN-002（2026-11-08）：扫描被 BLE 共存饿死时，要么 30s 无回包超时，要么单次耗时
     * 被拉到接近超时。把单次耗时带上，才能在下一次「侥幸成功」里看出劣化趋势。 */
    (durs.length ? ' · 单次耗时 ' + Math.min.apply(null, durs) + '–' + Math.max.apply(null, durs) + 'ms' : '');

  if (okCount < 10) {
    /* 旧文案把「已用时长」写成「N s 预算」，还会把「某一轮被超时+重连占用、
     * 循环次数已用尽」笼统说成「预算或设备 scan 失败」——两种成因要分开写，
     * 否则跨轮对比时这个数字没法用。 */
    const usedMs = Date.now() - started;
    const lost = tried - okCount;
    return expected(
      detail + ' · 未跑满 10 次：成功 ' + okCount + ' / 用掉 ' + tried + ' 轮' +
        (lost > 0 ? '（' + lost + ' 轮被超时/重连/network_failed 占用，未补跑）' : '') +
        ' · 预算 ' + Math.round(BUDGET / 1000) + 's，已用 ' + Math.round(usedMs / 1000) + 's，剩余 ' +
        Math.max(0, Math.round((BUDGET - usedMs) / 1000)) + 's'
    );
  }
  return pass(detail);
}

/* ---------------- 5. 20B 分包 ---------------- */

async function checkFragment(ctx) {
  const ble = ctx.ble;
  const protocol = ctx.protocol;

  const id = 'frag' + (Date.now() % 1000000);
  // 按目标总长反推填充长度（JSON 骨架 + 填充 + token 大约 420B）
  const base = JSON.stringify({ id: id, version: '1.0', cmd: PROBE_CMD, args: { pad: '' } });
  const tokenLen = protocol.token ? protocol.token.length + 12 : 0;
  const padLen = Math.max(40, PROBE_TARGET_BYTES - utf8Encode(base).length - tokenLen);
  const args = { pad: 'x'.repeat(padLen) };
  const shown = JSON.stringify({ id: id, version: '1.0', cmd: PROBE_CMD, args: args });

  const b0 = ble.snapshot();
  let err = null;
  let res = null;
  try {
    res = await protocol.rawCall(PROBE_CMD, args, { id: id });
  } catch (e) {
    err = e;
  }
  const b1 = ble.snapshot();

  const sizes = b1.chunkSizes.slice(b0.chunkSizes.length);
  const total = sizes.reduce(function (a, b) {
    return a + b;
  }, 0);
  const expectChunks = Math.ceil(total / 20);
  const cap = String(id) + ' / ' + total + 'B / ' + sizes.length + ' 片';

  if (!sizes.length) return fail('没有记录到任何写入分片');

  const oversize = sizes.filter(function (s) {
    return s > 20;
  });
  if (oversize.length) {
    return fail('存在超过 20B 的写片（' + oversize.join(',') + '），违反 20B 基线');
  }
  if (sizes.length < 12) {
    return fail('只写了 ' + sizes.length + ' 片，命令长度不足以证明跨片重组（实发 ' + total + 'B）');
  }

  if (!err) {
    // 设备居然 ok 了：说明这条"不存在"的命令被接受，探测失效
    return fail('探测命令返回 ok（' + res.id + '），无法用它证明解析路径；请换一条不存在但语法合法的 cmd');
  }

  const code = err.code;
  const reqId = err.requestId || id;
  const respId = err.responseId || '';
  const idText = '请求 id=' + reqId + ' → 响应 id=' + (respId || '(无)') +
    (respId ? (String(respId) === String(reqId) ? '(匹配)' : '(不匹配)') : '(未收到响应)');

  if (code === 'invalid_json') {
    return fail('设备 JSON 解析失败：' + cap + '，分片顺序或边界有问题 · ' + idText);
  }
  if (code === 'line_too_long') {
    return fail('设备判定超长 ' + cap + '（单行上限 512B），检查是否把多条命令拼在一行');
  }
  if (code === 'timeout') {
    return fail('设备未在超时内响应：' + cap + ' · ' + idText + '（可能丢片或未按 \\n 断行）');
  }
  if (respId && String(respId) !== String(reqId)) {
    return fail('响应 id 与请求 id 不一致，存在串包 · ' + idText);
  }
  if (code !== 'unknown_command' && code !== 'invalid_argument') {
    return fail('探测命令返回意外错误 ' + code + '：' + cap + ' · ' + idText);
  }

  return pass(
    cap + '（' + sizes.length + '/' + expectChunks + ' 片，每片 ≤20B，串行等待 success）· ' +
      idText + ' · 设备回 ' + code + '：整行被按序重组并解析 · 命令原文：' + shown,
    { command: shown, requestId: reqId, responseId: respId, code: code, bytes: total, chunks: sizes.length }
  );
}

/* ---------------- 5. 长响应 ---------------- */

/* 字节口径（2026-11-06 修）：
 * 报告里的「响应字节」过去取 ble.stats.notifyBytes，那是**全部通道**的通知字节
 * （含 DATA / 非协议通道）。20:34 那轮出现 3840B/56 片、2525B/57 片——都超过
 * 「片数×20B」的算术上限（1120/1140），说明该口径被别的通道或重复投递污染了。
 * 现在三线并列 + 交叉校验：
 *   cmdBytes   仅 CMD_TX 通道累计（响应字节的正确口径）
 *   objBytes   重组出的完整 JSON 对象字节（权威值，应 ≈1100B）
 *   bound      片数 × 单片上限：超过即客户端计数异常（重复投递/片被合并）
 */
function byteAccounting(b0, b1) {
  const num = function (v, fb) {
    return typeof v === 'number' ? v : fb;
  };
  const frames = num(b1.cmdNotify, 0) - num(b0.cmdNotify, 0);
  // 旧桩/旧快照没有 cmdBytes：退回旧的 notifyBytes 口径（自测兼容）
  const bytes = num(b1.cmdBytes, num(b1.notifyBytes, 0)) - num(b0.cmdBytes, num(b0.notifyBytes, 0));
  const objBytes =
    typeof b1.objectBytes === 'number' && typeof b0.objectBytes === 'number'
      ? b1.objectBytes - b0.objectBytes
      : bytes;
  const objects = num(b1.objects, 0) - num(b0.objects, 0);
  const chunkBound = Math.max(20, num(b1.notifyMaxLen, 0));
  return {
    frames: frames,
    bytes: bytes,
    objBytes: objBytes,
    objects: objects,
    chunkBound: chunkBound,
    bound: frames * chunkBound,
    overBound: frames > 0 && bytes > frames * chunkBound,
    overChunk: num(b1.notifyOverChunk, 0) - num(b0.notifyOverChunk, 0),
    dataBytes: num(b1.dataBytes, 0) - num(b0.dataBytes, 0),
    otherBytes: num(b1.otherBytes, 0) - num(b0.otherBytes, 0),
    allBytes: num(b1.notifyBytes, 0) - num(b0.notifyBytes, 0),
  };
}

/** 一行说明三线口径，供 detail 复用 */
function bytesText(a) {
  /* 「算术上限」= 片数 × 片长，只用于抓客户端计数异常（重复投递/片被合并）；
   * 它不是协议最大长度（协议首行上限 MAX_LINE_BYTES 只管请求），也不代表剩余容量，
   * 所以不能按「1118/1120 还差 2B」去解读。 */
  let t = 'CMD ' + a.bytes + 'B（' + a.frames + ' 片 × ≤' + a.chunkBound + 'B，算术上限 ' + a.bound +
    'B，仅用于片数×片长一致性校验）' +
    ' · 重组 ' + a.objBytes + 'B/' + a.objects + ' 对象';
  if (a.dataBytes) t += ' · DATA ' + a.dataBytes + 'B';
  if (a.otherBytes) t += ' · 其它通道 ' + a.otherBytes + 'B';
  if (a.overBound) t += ' · 累计超出算术上限（客户端计数异常，响应本体见重组字节）';
  if (a.overChunk) t += ' · ' + a.overChunk + ' 片长度 >20B（片被合并/MTU 变化）';
  return t;
}

async function checkLong(ctx) {
  const ble = ctx.ble;
  const protocol = ctx.protocol;

  const b0 = ble.snapshot();
  const p0 = protocol.snapshot();
  const started = Date.now();
  const data = await protocol.configGet();
  const ms = Date.now() - started;
  const b1 = ble.snapshot();
  const p1 = protocol.snapshot();
  const acc = byteAccounting(b0, b1);
  const bytes = acc.bytes;
  const frames = acc.frames;
  const objs = acc.objects;

  if (!data || typeof data !== 'object') return fail('config.get 返回为空');
  if (!data.network) return fail('config.get 缺 network 域，响应可能不完整');

  if (p1.unmatched !== p0.unmatched) return fail('出现未匹配 id 的响应（疑似串包/会话残留）');
  if (b1.parseErrors !== b0.parseErrors) return fail('重组过程中出现 JSON 解析错误');
  if (b1.pendingBytes !== 0) return fail('重组缓冲仍有 ' + b1.pendingBytes + 'B 未消化');

  const n = data.network;
  const apFields = ['ap_ssid', 'ap_password_set', 'startup_fallback_to_ap', 'ap_password'].filter(function (k) {
    return Object.prototype.hasOwnProperty.call(n, k);
  });
  if (apFields.length) {
    return fail('响应仍含已删除的 AP schema 字段：' + apFields.join('、') + '（固件未清理或读错了域）');
  }
  if (n.net_mode !== 'sta') {
    return fail('network.net_mode=' + (n.net_mode || '(空)') + '，只允许 sta（AP schema 已删除）');
  }

  // 与运行时交叉核对：config.get 是配置，network.status 是运行时
  let rt = null;
  try {
    rt = await protocol.networkStatus();
  } catch (e) {
    return fail('config.get 成功但 network.status 失败：' + describe(e).text);
  }

  const detail =
    bytesText(acc) + ' / ' + ms + 'ms · net_mode=' + n.net_mode +
    ' · cfg.sta_ssid=' + (n.sta_ssid || '(空)') + ' · cfg.sta_has_ip=' + (n.sta_has_ip ? 'true' : 'false') +
    ' · rt.sta_has_ip=' + (rt && rt.sta_has_ip ? 'true' : 'false') +
    ' · rt.mqtt_connected=' + (rt && rt.mqtt_connected ? 'true' : 'false');

  if (!n.hasOwnProperty('sta_ssid') || !n.hasOwnProperty('sta_password_set')) {
    return fail(detail + ' · network 缺 sta_ssid/sta_password_set 字段');
  }

  const warnings = [];
  // 判据用重组字节（权威值），不再用被污染的累计口径
  if (acc.objBytes < 900) warnings.push('重组对象仅 ' + acc.objBytes + 'B，明显小于 ~1100B，可能被截断');
  if (acc.overBound) warnings.push('通知累计 ' + acc.allBytes + 'B 超出算术上限 ' + acc.bound + 'B（客户端计数异常，仅记录不判失败）');
  if (rt && !rt.mqtt_connected) warnings.push('MQTT 当前未连接（运行时状态，非重组问题）');
  if (warnings.length) return expected(detail + ' · ' + warnings.join('；'));

  return pass(detail);
}

/* ---------------- 5b. 10 次 config.get ---------------- */

async function checkLongRepeat(ctx) {
  const ble = ctx.ble;
  const protocol = ctx.protocol;

  const p0 = protocol.snapshot();
  const rows = [];
  let incomplete = '';

  for (let i = 1; i <= 10; i++) {
    const b0 = ble.snapshot();
    let d = null;
    try {
      d = await protocol.configGet();
    } catch (e) {
      return fail('第 ' + i + ' 次 config.get 失败：' + e.code + ' ' + describe(e).text);
    }
    const b1 = ble.snapshot();
    if (!d || !d.network) {
      incomplete = '第 ' + i + ' 次响应不完整（缺 network）';
      break;
    }
    rows.push(byteAccounting(b0, b1));
  }

  const p1 = protocol.snapshot();
  if (incomplete) return fail(incomplete);
  if (p1.unmatched !== p0.unmatched) return fail('重复期间出现未匹配响应（串包）');
  if (ble.snapshot().pendingBytes !== 0) return fail('重复结束后重组缓冲残留 ' + ble.snapshot().pendingBytes + 'B');

  const span = function (arr) {
    return Math.min.apply(null, arr) + '–' + Math.max.apply(null, arr);
  };
  const pick = function (k) {
    return rows.map(function (r) {
      return r[k];
    });
  };
  const cmdBytes = pick('bytes');
  const objBytes = pick('objBytes');
  const frames = pick('frames');
  // 波动判据用重组字节（权威值）：CMD 累计口径可能被重复投递污染，不能当判据
  const drift = Math.max.apply(null, objBytes) - Math.min.apply(null, objBytes);
  const overRows = rows.filter(function (r) {
    return r.overBound;
  }).length;

  const detail =
    '10 次全部完整 · 重组 ' + span(objBytes) + 'B（波动 ' + drift + 'B）· CMD 累计 ' +
    span(cmdBytes) + 'B / ' + span(frames) + ' 片 · 未匹配 0';
  if (drift > 32) {
    return expected(detail + ' · 重组字节波动偏大，可能响应域变化（如 MQTT 状态/时间字段），建议核对');
  }
  if (overRows) {
    return expected(
      detail + ' · 其中 ' + overRows + ' 次 CMD 累计超出「片数×片长」算术上限（客户端计数异常，' +
        '重组字节一致可证响应完整）· 已按 CMD 通道口径计数，仍异常则记录 notifyOverChunk 用于定位'
    );
  }
  return pass(detail);
}

/* ---------------- 6. 长响应期间插入命令 ---------------- */

async function checkPipeline(ctx) {
  const ble = ctx.ble;
  const protocol = ctx.protocol;

  const b0 = ble.snapshot();
  const p0 = protocol.snapshot();

  const t0 = Date.now();
  const cfgP = protocol.configGet().then(function (d) {
    return { ok: true, data: d, at: Date.now() - t0 };
  }, function (e) {
    return { ok: false, error: e, at: Date.now() - t0 };
  });

  await sleep(60); // 长响应已经发出一部分
  /* 一次原始发送。重发时用新的请求 id：协议自身的限流重试也是新 id
   * （protocol.js:532 传 id: undefined），响应关联始终按 id 完成。
   * sentAt 用来判定「这一发有没有落在长响应窗口内」——FIFO 证据的前提。 */
  const opOnce = function (retried) {
    const sentAt = Date.now() - t0;
    return protocol
      .rawCall('operation.get', { operation_id: 'selftest-none-' + Date.now() }, { timeout: 15000 })
      .then(function (r) {
        return { ok: true, id: r.id, at: Date.now() - t0, sentAt: sentAt, retried: !!retried };
      }, function (e) {
        return {
          ok: false,
          code: e.code,
          id: e.requestId,
          respId: e.responseId,
          at: Date.now() - t0,
          sentAt: sentAt,
          retried: !!retried,
        };
      });
  };

  let opRes = await opOnce(false);
  let rateWaitMs = 0;
  if (!opRes.ok && opRes.code === 'rate_limited') {
    /* rawCall 主动关了限流重试（noRateRetry），而 rate_limited 在契约里是
     * transient / retry_after 350ms（errors.json）。按契约补一次重发——
     * 不能把协议允许的瞬态码记成语义违例。两个 id 都写进 detail 供核对。 */
    rateWaitMs = contract.retryAfterMs('rate_limited') || 350;
    await sleep(rateWaitMs);
    const firstId = opRes.id;
    opRes = await opOnce(true);
    opRes.firstId = firstId;
    opRes.rateWaitMs = rateWaitMs;
  }
  const cfgRes = await cfgP;
  const b1 = ble.snapshot();
  const p1 = protocol.snapshot();

  if (!cfgRes.ok) return fail('并发期间的 config.get 失败：' + describe(cfgRes.error).text);
  if (!cfgRes.data || !cfgRes.data.network) return fail('并发期间 config.get 响应不完整');
  if (opRes.ok) {
    return expected(
      '长响应期间发出的 operation.get 返回了 ok（非预期，设备对该假 operation_id 返回了数据）；' +
        '响应时刻 ' + opRes.at + 'ms，config.get 完成于 ' + cfgRes.at + 'ms'
    );
  }
  if (String(opRes.respId || '') !== String(opRes.id || '')) {
    return fail('operation.get 响应 id 与请求 id 不匹配（请求 ' + opRes.id + ' / 响应 ' + (opRes.respId || '无') + '）');
  }
  if (opRes.code !== 'not_found' && opRes.code !== 'invalid_argument') {
    if (opRes.retried && opRes.code === 'rate_limited') {
      return expected(
        '长响应期间 operation.get 两次都被限流（rate_limited）：首次 id=' + opRes.firstId +
          '，按契约等 ' + rateWaitMs + 'ms 后以新 id=' + opRes.id + ' 重发仍被拒——' +
          '未取得 FIFO 证据，不判语义失败（rate_limited 按契约是 transient）'
      );
    }
    return fail('长响应期间 operation.get 返回意外错误：' + opRes.code);
  }
  /* FIFO 证据要求请求是在长响应还没结束时发出的。限流重发若已落到窗口外，
   * 就只验证了语义，不能声称覆盖了并发窗口。 */
  if (opRes.sentAt >= cfgRes.at) {
    return expected(
      'operation.get 发出时（' + opRes.sentAt + 'ms）长响应已结束（' + cfgRes.at + 'ms）' +
        (opRes.retried ? '，首次撞 rate_limited 后重发落在窗口外' : '') +
        '——只验证了 ' + opRes.code + '，FIFO 未覆盖'
    );
  }
  if (p1.unmatched !== p0.unmatched) return fail('长响应期间出现未匹配响应（串包）');
  if (b1.pendingBytes !== 0) return fail('结束后重组缓冲残留 ' + b1.pendingBytes + 'B');

  return pass(
    'config.get ' + cfgRes.at + 'ms 完成；期间发出的 operation.get（请求 id=' + opRes.id +
      (opRes.retried
        ? '；首次 id=' + opRes.firstId + ' 撞 rate_limited，按契约等 ' + rateWaitMs + 'ms 后以新 id 重发'
        : '') +
      '）在 ' + opRes.at + 'ms 收到 ' + opRes.code + '，' +
      (opRes.at >= cfgRes.at ? '响应排在长响应之后（符合 §4.3 FIFO）' : '响应早于长响应结束') +
      '；未匹配响应 0，缓冲残留 0B'
  );
}

/* ---------------- 7. 双通道并发 ---------------- */

async function checkDual(ctx) {
  const ble = ctx.ble;
  const protocol = ctx.protocol;

  await ble.subscribe('DATA_TX');
  await protocol.dataLoopback(true);

  const payload = pattern(200, 21);
  let got = new Uint8Array(0);
  const off = ble.on('data', function (chunk) {
    got = appendBytes(got, chunk);
  });

  const b0 = ble.snapshot();
  const p0 = protocol.snapshot();

  const cfgPromise = protocol.configGet(); // 长响应
  await sleep(80); // 让长响应先发出一部分
  const writePromise = ble.write('DATA_RX', payload); // 同时写 DATA

  let cfg = null;
  let cfgErr = null;
  try {
    cfg = await cfgPromise;
  } catch (e) {
    cfgErr = e;
  }
  try {
    await writePromise;
  } catch (e) {
    /* 下面统一判定 */
  }
  await waitFor(function () {
    return got.length >= 200;
  }, 3000);
  off();
  try {
    await protocol.dataLoopback(false);
  } catch (e) {
    /* 忽略 */
  }

  const b1 = ble.snapshot();
  const p1 = protocol.snapshot();
  const echoed = equals(payload, got.slice(0, 200));

  if (cfgErr) return fail('并发期间 config.get 失败：' + describe(cfgErr).text);
  if (!cfg || !cfg.network) return fail('并发期间 config.get 响应不完整');
  if (!echoed) {
    return fail(
      '并发期间 DATA 回环不一致：期望 200B，收到 ' + got.length + 'B' +
        (got.length >= 200 ? '，首个差异在第 ' + firstDiff(payload, got.slice(0, 200)) + ' 字节' : '')
    );
  }
  if (p1.unmatched !== p0.unmatched) return fail('并发期间出现未匹配响应（串道）');
  if (b1.cmdNotify <= b0.cmdNotify) return fail('并发期间 CMD 通道没有收到通知');
  if (b1.dataFrames <= b0.dataFrames) return fail('并发期间 DATA 通道没有收到通知');

  return pass(
    '同一时间窗：CMD 通知 +' + (b1.cmdNotify - b0.cmdNotify) + ' 片、DATA +' +
      (b1.dataFrames - b0.dataFrames) + ' 帧；DATA 200B 逐字节一致，config.get 完整，未匹配 0'
  );
}

/* ---------------- 8. DATA 全矩阵 ---------------- */

/** 写一段数据并收集回传，返回 { got, exact, ms } */
async function roundTrip(ble, payload, timeoutMs) {
  let got = new Uint8Array(0);
  const off = ble.on('data', function (chunk) {
    got = appendBytes(got, chunk);
  });
  const started = Date.now();
  try {
    await ble.write('DATA_RX', payload);
    await waitFor(function () {
      return got.length >= payload.length;
    }, timeoutMs || 2500);
  } finally {
    off();
  }
  return { got: got, exact: equals(payload, got.slice(0, payload.length)), ms: Date.now() - started };
}

async function checkData(ctx) {
  const ble = ctx.ble;
  const protocol = ctx.protocol;

  await ble.subscribe('DATA_TX');
  await protocol.dataLoopback(true);

  const rows = [];
  let hardFail = null;

  async function run(label, size, seed, required) {
    const payload = pattern(size, seed);
    const r = await roundTrip(ble, payload, 2500 + size * 4);
    const lost = Math.max(0, size - r.got.length);
    rows.push(
      label + ' ' + size + 'B → ' + r.got.length + 'B' + (r.exact ? ' 一致' : ' 丢/乱 ' + lost + 'B')
    );
    if (!r.exact && required && !hardFail) {
      hardFail =
        label + ' ' + size + 'B 回环不一致：收到 ' + r.got.length + 'B' +
        (r.got.length >= size ? '，首个差异在第 ' + firstDiff(payload, r.got.slice(0, size)) + ' 字节' : '');
    }
    return r;
  }

  try {
    await run('单帧', 20, 11, true);
    await run('长帧', 200, 23, true);
    await run('长帧', 600, 37, false); // 30 片，可能触及 data_pipe 深度 16 的边界
    await run('突发', 640, 41, false); // 32×20B 连续写
  } finally {
    try {
      await protocol.dataLoopback(false);
    } catch (e) {
      /* 忽略 */
    }
  }

  if (hardFail) return fail(hardFail);

  // 退订后不应再有数据；这是「订阅才收得到」的反向证据
  let leak = 0;
  await ble.unsubscribe('DATA_TX');
  try {
    let got = new Uint8Array(0);
    const off = ble.on('data', function (chunk) {
      got = appendBytes(got, chunk);
    });
    try {
      await ble.write('DATA_RX', pattern(20, 55));
      await sleep(500);
    } finally {
      off();
    }
    leak = got.length;
  } finally {
    await ble.subscribe('DATA_TX');
  }
  if (leak > 0) return fail('DATA TX 退订后仍收到 ' + leak + 'B，订阅状态不可信');

  const lossy = rows.filter(function (r) {
    return r.indexOf('一致') < 0;
  });

  const tail =
    '· 退订后 0B · 无应用层帧头/序号/ACK/重传，GATT 写 success 不等于送达，' +
    '可靠性不签收（只签收功能与边界）';

  if (lossy.length) {
    return expected(
      '单帧/长帧 200B 逐字节一致，但大块回环有丢失：' + lossy.join('；') + '。' +
        'data_pipe 队列深度 16 且无流控，这是协议边界，不是小程序缺陷 · ' + tail
    );
  }
  return pass(rows.join('；') + ' ' + tail);
}

/* ---------------- 9. 断连重连 ---------------- */

async function checkReconnect(ctx) {
  const ble = ctx.ble;
  const protocol = ctx.protocol;
  const target = ctx.target;

  if (!target || !target.deviceId) return skip('没有目标设备记录（先扫描连接一次）');
  if (!protocol.hasCredentials()) return skip('内存中无管理员凭据，无法自动重新登录（请先在设备页登录一次）');

  const staleToken = protocol.token;
  if (!staleToken) return skip('当前没有 token，无法验证旧 token 失效');

  // 0) 先证明探测命令确实受 token 保护：拿一个格式合法的假 token 去发
  //    设备若照收，说明鉴权没生效（P0），或者这条命令本来就不校验 token（要换命令）
  const probe = await pickAuthedCommand(ctx);
  if (probe.error) return fail(probe.error);

  const restore = async function () {
    try {
      await ble.connect(target.deviceId, target.name);
      const inf = await ble.discover();
      await ble.subscribe('CMD_TX');
      await ble.subscribe('DATA_TX');
      return !inf.missing.length;
    } catch (e) {
      return false;
    }
  };

  const s0 = ble.snapshot();
  const d = await ble.disconnect();

  // 设备侧证据：固件只在收到断连事件时才重启广播，所以「扫得到设备」= 外设真的断了。
  // 系统的连接状态事件 / getBLEDeviceServices 只代表手机本地 GATT 关了，Android 的连接缓存
  // 还能把 ACL 留住——那期间立刻重连，外设根本不知道断过，token 当然还在。
  const adv = await ble.waitForAdvertising(target.deviceId, target.name, ADV_EVIDENCE_WAIT_MS);
  if (!adv.seen) {
    const restored = await restore();
    return skip(
      '断开后 ' + (adv.ms / 1000).toFixed(1) + 's 内设备未重新广播（close ' + d.attempts + ' 次；' +
        '系统断连事件：' + (d.eventSeen ? '有' : '无') + '）。' +
        '外设没恢复广播，说明链路很可能仍被系统连接缓存维持、设备端没收到断连，旧 token 未作废无从判定。' +
        '本项不判 FAIL（无法区分固件缺陷与手机栈缓存），但「断连→重新广播→旧 token 失效」本轮没有证据，' +
        '记 INCOMPLETE——P0 不能凭未验证项签收。' +
        (restored ? '已恢复连接与订阅。' : '恢复订阅失败，请手动重连。') +
        '重跑时请同时记下设备串口 conn 与 rx_age_ms（conn=1 且 rx_age_ms>90000 即僵尸链路，' +
        '此模式下 adv_retry_count 恒 0，不能用它佐证看门狗健康）；恢复办法：手机关蓝牙再开，或强制停止微信',
      'incomplete'
    );
  }

  const p0 = protocol.snapshot();

  await ble.connect(target.deviceId, target.name);
  const s1 = ble.snapshot();
  if (s1.sessionId <= s0.sessionId) return fail('会话号未递增，说明会话状态没有重置');
  if (s1.pendingBytes !== 0) return fail('重连后重组缓冲残留 ' + s1.pendingBytes + 'B');

  const info = await ble.discover();
  if (info.missing.length) return fail('重连后发现特征不全：' + info.missing.join('、'));

  await ble.subscribe('CMD_TX');
  await ble.subscribe('DATA_TX');

  // 1) 旧 token 必须失效：带旧 token 直接发命令（不走自动重登录）
  let staleCode = 'ok';
  let staleIds = { req: '', res: '' };
  try {
    const r = await protocol.rawCall(probe.cmd, {}, { token: staleToken, timeout: 8000 });
    staleIds = { req: r.id, res: r.id };
  } catch (e) {
    staleCode = e.code || 'error';
    staleIds = { req: e.requestId || '', res: e.responseId || '' };
  }
  if (staleCode !== 'unauthorized') {
    return fail(
      '重连后旧 token 仍被接受（' + probe.cmd + ' 返回 ' + staleCode + '），连接级 token 未作废' +
        '（已确认外设收到断连：断开后 ' + (adv.ms / 1000).toFixed(1) + 's 恢复广播）' +
        (staleIds.req ? '；请求 id=' + staleIds.req + ' 响应 id=' + (staleIds.res || '?') : '')
    );
  }

  // 2) 旧会话字节不应混入新会话：先发唯一 marker，第一帧必须就是它
  const marker = pattern(20, 99);
  let first = null;
  let got = new Uint8Array(0);
  const off = ble.on('data', function (chunk) {
    if (first === null) first = chunk.slice(0, 20);
    got = appendBytes(got, chunk);
  });
  let markerOk = false;
  try {
    await protocol.dataLoopback(true);
    await ble.write('DATA_RX', marker);
    await waitFor(function () {
      return got.length >= 20;
    }, 2500);
    markerOk = first ? equals(marker, first) : false;
  } finally {
    off();
    try {
      await protocol.dataLoopback(false);
    } catch (e) {
      /* 忽略 */
    }
  }
  if (!markerOk) {
    return fail('重连后 DATA 首帧不是 marker（收到 ' + got.length + 'B），存在旧会话字节混入');
  }

  // 3) 重新登录 + 两条命令确认链路可用
  await protocol.relogin();
  const newToken = protocol.token;
  if (!newToken) return fail('重新登录后仍未拿到 token');
  if (newToken === staleToken) return fail('重新登录后设备下发了与旧 token 相同的值，无法证明按连接轮换');
  await protocol.deviceInfo();
  const cfg = await protocol.configGet();
  if (!cfg || !cfg.network) return fail('重连后 config.get 响应不完整');

  const p1 = protocol.snapshot();
  const s2 = ble.snapshot();
  if (p1.unmatched !== p0.unmatched) {
    return fail('重连后出现 ' + (p1.unmatched - p0.unmatched) + ' 条未匹配响应（旧会话数据混入）');
  }
  if (s2.pendingBytes !== 0) return fail('重连后重组缓冲残留 ' + s2.pendingBytes + 'B');
  if (p1.pending > 0) return fail('重连后仍有 ' + p1.pending + ' 个请求未结算');

  return pass(
    '会话 #' + s0.sessionId + ' → #' + s1.sessionId + '（设备侧确认断连：断开后 ' +
      (adv.ms / 1000).toFixed(1) + 's 恢复广播，RSSI ' + adv.rssi + 'dBm），重新发现 ' + info.total + ' 个特征并订阅；' +
      '旧 token 在 ' + probe.cmd + ' 上被拒（unauthorized）；新 token 已轮换；' +
      'DATA 首帧即 marker（无旧字节）；重新登录后 device.info/config.get 正常；' +
      '未匹配响应 0 条，缓冲残留 0B'
  );
}

/**
 * 选一条「确实校验 token」的命令做旧 token 探测。
 * 先用格式合法的假 token 发一次：只有回 unauthorized 才能说明该命令受鉴权保护。
 * 若假 token 被照收，说明设备鉴权没生效（P0），不能拿去当「旧 token 未作废」的旁证。
 */
async function pickAuthedCommand(ctx) {
  const protocol = ctx.protocol;
  const candidates = ['network.status', 'config.get'];
  const fake = 'zz' + String(Date.now() % 1e8).padStart(8, '0') + 'deadbeefdeadbeefdeadbeef';
  const notes = [];

  for (let i = 0; i < candidates.length; i++) {
    const cmd = candidates[i];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await protocol.rawCall(cmd, {}, { token: fake, timeout: 8000 });
        // 假 token 被执行了 → 鉴权没生效，直接判失败，不换命令掩盖
        return {
          error:
            '鉴权未生效：用伪造 token 执行 ' + cmd + ' 返回 ok（§5.2 要求除 device.info 外都必须带有效 token）',
        };
      } catch (e) {
        if (e.code === 'unauthorized') {
          return { cmd: cmd };
        }
        if (e.code === 'rate_limited') {
          await sleep(Math.max(contract.retryAfterMs('rate_limited'), 350));
          continue;
        }
        notes.push(cmd + ' → ' + e.code);
        break; // 换下一条候选
      }
    }
  }
  return { error: '没有可用于旧 token 探测的命令：' + notes.join('；') };
}

/* ---------------- 10. operation 语义 ---------------- */

/* cancel 之后立即重发 tryconnect，会落在 cancel 清理的 restore_persistent 危险窗里
 * （apply_begin/apply_cfg 期间试连入口门按设计拒绝 → wifi_config_offline）。
 * 2026-11-08 硬件侧串口实证（uptime）：
 *   442029 cancel 生效 → 442039 apply_begin(source=runtime_restart) → 442079 rejected
 * ⟹ 这是**可重试瞬态**，不是语义违规；等窗口关闭后重发即得 ap_not_found。
 * 注意：首次仍**立即**发（保留 R5 回归覆盖——旧固件此处回 internal_error）。 */
/* tryconnect 重试白名单：契约 class=transient 且**适用本场景**的码。
 * 注意与契约的关系：白名单 ⊆ 契约瞬态集（contract-selftest 断言这点）；
 * rate_limited/conflict 虽也是 transient，但重试语义不同（限流节拍/先查 op），不进本白名单。 */
const TRY_TRANSIENT_CODES = ['wifi_config_offline', 'busy'].filter(function (c) {
  if (!contract.isTransient(c)) {
    throw new Error('[contract] ' + c + ' 在 contract/v1 中不再是 transient，重试白名单需重新评审');
  }
  return true;
});
/* 重试节拍取契约值：wifi_config_offline 1500ms×3；busy（op 占用）1500ms。
 * scan 节流的 busy 是另一语义，不适用此表（见 checkScanRepeat 的残余冷却）。 */
function transientRetryDelayMs(code) {
  return contract.retryAfterMs(code) || 1500;
}

function isTransientTryCode(code) {
  return TRY_TRANSIENT_CODES.indexOf(String(code || '')) >= 0;
}

/** 等 op 到终态（failed/got_ip/cancelled/expired），带预算；超时返回空 state。
 *  elapsedMs 是本轮从**发起受理后**到首见终态的时长——区分「快速 abort」与
 *  「真跑完失败」的唯一客户端证据（见 FAST_ABORT_MS）。
 *  终态集合取自契约（states.json#terminal_states，4 元含 expired）：
 *  2026-11-08 事故——漏 expired 曾让 op 到期后客户端空转到超时、误报「客户端超时」。 */
async function waitOpTerminal(protocol, oid, budgetMs, pollMs) {
  const step = pollMs || contract.BUDGETS.opPollIntervalMs;
  const t0 = Date.now();
  const end = t0 + (budgetMs || 20000);
  let state = '';
  let error = '';
  while (Date.now() < end) {
    await sleep(step);
    let st = null;
    try {
      st = await protocol.operationGet(oid);
    } catch (e) {
      return { state: 'error', error: (e && e.code) || 'unknown', elapsedMs: Date.now() - t0 };
    }
    state = String((st && st.state) || '');
    error = String((st && st.error) || '');
    /* got_ip 是试连语义下的「成功停留态」：本函数的调用方（缺席重试/#12 语义）
       都不需要等到 apply，见到 got_ip 即可收口；其余按契约终态跳出。 */
    if (state === 'got_ip' || contract.isTerminal(state)) break;
  }
  return {
    state: state,
    error: error === 'none' ? '' : error,
    elapsedMs: Date.now() - t0,
  };
}

/* 2026-11-08 16:25 T4 #12 新形态：cancel 后新 op 不是被入口门拒（wifi_config_offline），
 * 而是**被受理**后极快以 failed/connect_failed 收尾。
 * 固件侧只有三条路会产出 CONNECT_FAILED（cmd.c:413 默认分支）：
 *   ① wifi.c:3669 `old link disconnect not observed` —— 旧链有界等待 2s 超时
 *      （cancel 的 restore_persistent 刚把 STA 拉起来，disconnect 事件不来）
 *   ② wifi.c:3691 set_config 失败  ③ wifi.c:3682/3575 get_config/connect 失败
 * 三者都在 ~2s 内返回，而「缺席 SSID 真跑一遍驱动」要全信道扫描 >5s。
 * ⟹ 终态 connect_failed + 耗时 ≤4s = cancel 清理**未收敛**的可重试瞬态；
 *    耗时更长的 connect_failed 才是真的连不上，按 FAIL 处理。 */
const FAST_ABORT_MS = 4000;

function isFastConnectFailed(t) {
  return !!(
    t &&
    t.state === 'failed' &&
    t.error === 'connect_failed' &&
    typeof t.elapsedMs === 'number' &&
    t.elapsedMs <= FAST_ABORT_MS
  );
}

/**
 * cancel 后新 tryconnect（含瞬态重试）。返回轨迹，供 detail 直出"第几次才成功"。
 * opts: { maxTries=4, budgetMs=20000, pollMs=500, backoff=[1000,2000,3000] }
 * 快速 abort（见 FAST_ABORT_MS）**只额外重试 1 次**，避免把真实缺陷用重试抹平。
 */
async function retryTryconnectAbsent(protocol, tag, opts) {
  const o = opts || {};
  /* 重试预算取契约（errors.json#wifi_config_offline：1500ms×3）：
   * maxTries = max_retries+1（首次 + 3 次重试）；busy/op 占用同表取 1500ms。 */
  const wcoRetryMs = contract.retryAfterMs('wifi_config_offline') || 1500;
  const wcoMax = contract.maxRetries('wifi_config_offline') || 3;
  const maxTries = o.maxTries || (wcoMax + 1);
  const backoff = o.backoff || [wcoRetryMs, wcoRetryMs, wcoRetryMs];
  const tries = [];
  const fastAborts = [];
  let fastRetryUsed = false;
  let oid = null;
  for (let i = 0; i < maxTries; i++) {
    if (i > 0) await sleep(backoff[i - 1] === undefined ? 2000 : backoff[i - 1]);
    let op = null;
    let err = null;
    try {
      op = await protocol.tryConnect('__ble_selftest_absent__', 'not-a-real-password-0', tag + '-' + i);
    } catch (e) {
      err = e;
    }
    if (err) {
      tries.push('#' + (i + 1) + ' 被拒(' + (err.code || 'unknown') + ')');
      if (isTransientTryCode(err.code)) continue;
      return { fatal: err.code || 'unknown', tries: tries, fastAborts: fastAborts };
    }
    const cur = op && (op.operation_id || (op.data && op.data.operation_id));
    if (!cur) return { fatal: 'no_operation_id', tries: tries, fastAborts: fastAborts };
    oid = cur;
    const t = await waitOpTerminal(protocol, oid, o.budgetMs, o.pollMs);
    tries.push('#' + (i + 1) + ' ' + (t.state || '超时') +
      (t.error ? '/' + t.error : '') + '@' + (t.elapsedMs || 0) + 'ms');
    if (t.state === 'failed' && isTransientTryCode(t.error)) continue;
    if (isFastConnectFailed(t)) {
      fastAborts.push(tries[tries.length - 1]);
      if (!fastRetryUsed) { fastRetryUsed = true; continue; }
    }
    return {
      oid: oid,
      state: t.state,
      error: t.error,
      elapsedMs: t.elapsedMs,
      tries: tries,
      fastAborts: fastAborts,
      accepted: true,
    };
  }
  return {
    oid: oid,
    state: 'transient_exhausted',
    error: 'wifi_config_offline',
    tries: tries,
    fastAborts: fastAborts,
    accepted: !!oid,
  };
}

async function checkOpSemantics(ctx) {
  const protocol = ctx.protocol;
  const stampNow = Date.now();

  /* link 错误 ≠ 协议答案：characteristic_missing 之类是本机句柄失效，
   * 请求根本没发出去。若当成设备回复，就会把「链路死了」判成契约违例。 */
  const linkDrop = function (step, e) {
    return skip(
      step + ' 时链路失效 [' + e.code + ']（' + describe(e).text + '）：本机 GATT 句柄过期或设备重启，' +
        '请求没有送到设备——不能记成「设备返回了 ' + e.code + '」。apply/cancel 语义本轮未测到，记 INCOMPLETE。' +
        '重连后重跑；若反复出现，按「设备重启/链路稳定性」单独立案，不要记成本项的契约缺陷',
      'incomplete'
    );
  };

  /* 静态 IP 安全锁（cmd.c app_cmd_static_switch_blocked）：
   * sta_use_static=1 时，换 SSID 或带 ip_mode=dhcp 的 tryconnect 一律回
   * static_ip_pinned——这是 v1-only 的设计行为，不是失败。
   * 11-06 之前本用例无条件用「不存在的 SSID」起候选，在静态锁定设备（C8E4/.50）
   * 上必然撞锁，被记成 P0 FAIL；同一用例在 DHCP 设备（65D8）上通过。
   * 现在先读配置判定：静态锁定 → 只验证「锁是否生效」，判 EXPECTED 并给出
   * 换设备/改模式的做法，不再把设计行为算成缺陷。 */
  let net = null;
  try {
    const cfg = await protocol.configGet();
    net = (cfg && cfg.network) || null;
  } catch (e) {
    /* 读不到配置不阻塞原有用例：按原路径继续，由后续断言说话 */
  }
  if (net && (net.sta_use_static === true || net.sta_use_static === 1)) {
    let pinErr = null;
    try {
      await protocol.tryConnect('__ble_selftest_absent__', 'not-a-real-password-0', 'selftest-static-' + stampNow);
    } catch (e) {
      pinErr = e;
    }
    const cur = net.sta_ssid || '(空)';
    if (!pinErr) {
      return fail(
        '静态锁定设备（sta_use_static=true，正式 SSID=' + cur + '）上，换 SSID 的 tryconnect 被受理了：' +
          '安全锁未生效（cmd.c app_cmd_static_switch_blocked 应回 static_ip_pinned）'
      );
    }
    if (pinErr.code !== 'static_ip_pinned') {
      return fail(
        '静态锁定设备上换 SSID 的 tryconnect 返回 ' + pinErr.code + '（' + describe(pinErr).text +
          '），应为 static_ip_pinned'
      );
    }
    return expected(
      '静态 IP 锁定生效 [static_ip_pinned]：静态模式下拒绝切换到其它 Wi-Fi（正式 SSID=' + cur +
        '，静态地址 ' + (net.sta_static_ip || '-') + '）· 这是 v1-only 的安全设计，不是缺陷' +
        ' · 本用例的 busy/early-apply/cancel 语义需在 DHCP 设备上执行（65D8 已 PASS）' +
        ' · 若要在本机执行：先在网络配置页把静态 IP 切为 DHCP（config.set），再换网'
    );
  }

  // 用不存在的目标 SSID 起一个候选：不修改正式配置，超时前会自行失败
  let op = null;
  let opErr = null;
  try {
    op = await protocol.tryConnect('__ble_selftest_absent__', 'not-a-real-password-0', 'selftest-a-' + stampNow);
  } catch (e) {
    opErr = e;
  }
  if (opErr) {
    if (isLinkError(opErr)) return linkDrop('第 1 步 tryconnect', opErr);
    if (opErr.code === 'static_ip_pinned') {
      // 配置读失败但锁生效：仍按设计行为判定，避免误报
      return expected(
        'tryconnect 被静态 IP 安全锁拦截 [static_ip_pinned]：静态模式拒绝换 SSID（设计行为）· ' +
          '本用例的 operation 语义需在 DHCP 设备上执行，或先 config.set 切 DHCP'
      );
    }
    if (opErr.code === 'no_slot') {
      return expected('设备终态槽占满且未自动回收（no_slot）：多为旧固件（新固件槽满会覆盖最老终态记录），稍后重试或重启设备（不要当成口令错误）');
    }
    if (opErr.code === 'busy') {
      return expected('设备已有 active operation（busy）：先取消或等其结束再测本项');
    }
    return fail('tryconnect 意外失败：' + opErr.code + ' ' + describe(opErr).text);
  }

  const opId = op && op.operation_id;
  if (!opId) return fail('tryconnect 未返回 operation_id');

  const results = [];

  // busy：已有 active operation 时用新 key 再发一条
  let busyCode = 'ok';
  try {
    await protocol.tryConnect('__ble_selftest_absent__', 'not-a-real-password-0', 'selftest-b-' + stampNow);
  } catch (e) {
    if (isLinkError(e)) return linkDrop('第 2 步 second tryconnect', e);
    busyCode = e.code;
  }
  results.push('second tryconnect → ' + busyCode);

  // operation_state：未到 got_ip 就 apply
  let applyCode = 'ok';
  try {
    await protocol.networkApply(opId);
  } catch (e) {
    if (isLinkError(e)) return linkDrop('第 3 步 early apply', e);
    applyCode = e.code;
  }
  results.push('early apply → ' + applyCode);

  // cancel 幂等
  let c1 = '';
  let c2 = '';
  try {
    const r = await protocol.networkCancel(opId);
    c1 = (r && r.state) || 'ok';
  } catch (e) {
    if (isLinkError(e)) return linkDrop('第 4 步 cancel', e);
    c1 = e.code;
  }
  try {
    const r = await protocol.networkCancel(opId);
    c2 = (r && r.state) || 'ok';
  } catch (e) {
    if (isLinkError(e)) return linkDrop('第 4 步重复 cancel', e);
    c2 = e.code;
  }
  results.push('cancel → ' + c1 + '，重复 cancel → ' + c2);

  const busyOk = busyCode === 'busy';
  const applyOk = applyCode === 'operation_state' || applyCode === 'trial_invalid';
  const cancelOk = c1 === 'cancelled';
  const twiceOk = c2 === 'cancelled' || c2 === 'operation_state' || c2 === 'not_found';

  if (!busyOk) {
    return fail('已有 active operation 时第二次 tryconnect 返回 ' + busyCode + '，应为 busy：' + results.join('；'));
  }
  if (!applyOk) {
    return fail('未 got_ip 就 apply 返回 ' + applyCode + '，应为 operation_state/trial_invalid：' + results.join('；'));
  }
  if (!cancelOk) {
    return fail('cancel 返回 ' + c1 + '，应为 cancelled：' + results.join('；'));
  }
  if (!twiceOk) {
    return fail('重复 cancel 返回 ' + c2 + '，应为 cancelled/operation_state：' + results.join('；'));
  }

  // cancel 后立即新 op（R5 板测真实回归点：旧固件此处回 internal_error，修复后应正常受理并走完终态）
  // 2026-11-08：cancel 清理会开一个 restore 危险窗，窗内受理的新 op 被入口门按设计拒绝
  // （failed/wifi_config_offline）——瞬态，等窗关闭后重发即得 ap_not_found。
  const rt = await retryTryconnectAbsent(protocol, 'selftest-c-' + stampNow);
  if (rt.fatal) {
    return fail(
      'cancel 后立即新 tryconnect 失败（' + rt.fatal + '），应正常受理返回 operation_id：' +
        results.join('；') + '；轨迹=' + rt.tries.join(', ')
    );
  }
  const recovered = rt.tries.length > 1;
  results.push('cancel 后新 op 受理' +
    (recovered ? '（首次撞 restore 危险窗：' + rt.tries.join(', ') + '）' : ''));
  results.push('新 op 终态=' + (rt.state || '超时') + (rt.error ? '/' + rt.error : '') +
    (rt.elapsedMs ? '（' + rt.elapsedMs + 'ms 见终态）' : ''));
  if (rt.fastAborts && rt.fastAborts.length) {
    results.push('快速 abort=' + rt.fastAborts.join(' / ') +
      '（≤' + FAST_ABORT_MS + 'ms 的 connect_failed：cancel 清理未收敛时旧链断开事件不来，' +
      '固件 wifi.c:3669 的 2s 有界等待超时即 abort；已重试一次，非最终判据）');
  }

  if (rt.state === 'got_ip') {
    return fail('absent SSID 不可能连上，新 op 却 got_ip（现场存在同名 AP？换一个 absent 前缀重测）：' + results.join('；'));
  }
  if (rt.state === 'transient_exhausted') {
    return fail(
      'cancel 后新 op 连续 ' + rt.tries.length + ' 次都落在 cancel 清理的 restore 危险窗（wifi_config_offline）：' +
        rt.tries.join(', ') + '，应为 failed/ap_not_found。' +
        '请确认 cancel 清理是否卡住（apply 长时间持锁会让入口门一直拒绝）：' + results.join('；')
    );
  }
  if (rt.state !== 'failed' || rt.error !== 'ap_not_found') {
    return fail(
      'cancel 后新 op 终态 ' + (rt.state || '超时无响应') + (rt.error ? '/' + rt.error : '') +
        (rt.elapsedMs ? '（' + rt.elapsedMs + 'ms）' : '') +
        '，应为 failed/ap_not_found：' + results.join('；') + '；轨迹=' + rt.tries.join(', ') +
        /* 2026-11-12：原提示只列了 restore 抢占的四种串口签名，但实测（WIFI-OP-RESOURCE-RACE）
         * 的主因是 auto_connect 抢 STA，扫描被 ESP_ERR_WIFI_STATE 拒绝——按旧关键词grep 一条都
         * 不会命中。新签名放前面，旧关键词保留（仍对应其它故障形态）。 */
        ' · 取证：串口 grep 按序查 —— "ESP_ERR_WIFI_STATE" / "STA is connecting, scan are not allowed" / ' +
        '"pre-scan failed"（预扫描未获准启动）；"auto_connect: selected saved profile" / "wifi:state: run -> init" ' +
        '（STA 操作权被后台自动连接抢占）；"restore_persistent" / "apply_cfg"（旧 op 清理是否在新 op 终态之后才落地）。' +
        '旧关键词仍保留："tryconnect: old link disconnect not observed"/"set_config failed"/"connect failed"/' +
        '"ssid .* not in scan results"（对应其它故障形态）'
    );
  }
  return pass(
    results.join('；') +
      ' · 全程未出现 wrong_password，busy/no_slot 不应被提示成口令错误 · ' +
      '本项占用 2 个终态槽（终态统一保留 600s；满表时覆盖最老记录）' +
      (recovered ? ' · wifi_config_offline 是 cancel 清理窗口的瞬态码，重发即恢复（非语义缺陷）' : '')
  );
}

/* ---------------- 11. 登录与 device.info（矩阵 #3） ---------------- */

async function checkAuthInfo(ctx) {
  const protocol = ctx.protocol;
  const notes = [];

  // device.info：唯一无 token 的探测入口
  let info = null;
  let infoErr = null;
  try {
    info = await protocol.rawCall('device.info', {}, { noRateRetry: true });
  } catch (e) {
    infoErr = e;
  }
  if (infoErr) return fail('device.info 失败：' + infoErr.code + ' ' + describe(infoErr).text);
  const data = info.data || {};
  const versions = data.protocol_versions;
  const vText = Array.isArray(versions) ? versions.join('/') : String(versions || '-');
  notes.push('device.info: protocol_versions=' + vText);
  if (Array.isArray(versions) ? versions.indexOf('1.0') < 0 : !/1\.0/.test(vText)) {
    return fail('protocol_versions 不含 1.0：' + vText);
  }
  // 固件构建标识（复审要求报告记录）。
  // 2026-11-06 修正：旧判词按 `1.2-g<短SHA>` 一个格式匹配，把 `1.3-a35eef9-dirty`
  // 判成「无 git 短 SHA」，属于套件误判——版本串确实带短 SHA（只是脏树后缀、
  // 且分隔符不是 -g）。同时 device.info 新增 build_sha（ELF SHA-256 前缀），
  // 才是「同版本串不同二进制」的区分依据，必须直接展示。
  const fw = String(data.firmware || '');
  protocol.lastDeviceInfoFirmware = fw;
  if (fw) {
    // 兼容三种形态：1.2-g<sha>（mainline）、1.3-<sha>（本仓当前）、1.3-<sha>-dirty
    const m = /(?:^|[-_.])g?([0-9a-f]{7,40})(-dirty)?$/i.exec(fw);
    notes.push(
      'firmware=' + fw +
        (m ? '（git 短 SHA ' + m[1] + (m[2] ? '，脏树构建' : '') + '）' : '（版本串不含 git 短 SHA，构建标识无区分度）')
    );
  } else {
    notes.push('firmware=未上报');
  }
  const buildSha = String(data.build_sha || '');
  protocol.lastBuildSha = buildSha;
  if (buildSha) {
    notes.push('build_sha=' + buildSha + '（ELF SHA-256 前缀，同版本串换二进制也会变）');
  } else {
    notes.push('build_sha=未上报（旧固件或长度配置为 0：本轮无法用 SHA 区分二进制，只能靠版本串）');
  }
  if (data.build_variant) notes.push('variant=' + String(data.build_variant));

  // auth.login：签发新 token（登录本来就轮换 token，不破坏既有会话语义）
  // 凭据优先级：用户保存的长期凭据 → 出厂默认（仅出厂配置设备兜底）
  try {
    if (protocol.hasCredentials()) await protocol.relogin();
    else {
      const la = credstore.loadSaved();
      await protocol.login((la && la.username) || DEFAULT_USERNAME, la ? la.password : DEFAULT_PASSWORD);
    }
  } catch (e) {
    return fail('auth.login 失败：' + e.code + ' ' + describe(e).text);
  }
  const len = protocol.token.length;
  const expiresIn = Math.round((protocol.tokenExpiresAt - Date.now()) / 1000);
  notes.push('auth.login: token 长度 ' + len + '（原样保存，值不入报告） · expires_in=' + expiresIn + 's');
  if (len !== 32) return fail('token 长度 ' + len + '，应为 32（APP_TOKEN_HEX_LEN）：' + notes.join(' · '));
  if (Math.abs(expiresIn - 600) > 5) {
    return fail('expires_in=' + expiresIn + '，应为 600（APP_TOKEN_TTL_MS）：' + notes.join(' · '));
  }
  return pass(notes.join(' · '));
}

/* ---------------- 12. 错误口令（矩阵 #6） ---------------- */

async function checkBadCred(ctx) {
  const protocol = ctx.protocol;
  if (!protocol.loggedIn) return skip('未登录，无法验证「既有会话不受影响」');
  const beforeToken = protocol.token;

  let err = null;
  try {
    await protocol.rawCall(
      'auth.login',
      { username: DEFAULT_USERNAME, password: '__definitely_wrong__' },
      { noAuthRetry: true, noRateRetry: true }
    );
  } catch (e) {
    err = e;
  }
  if (!err) return fail('错误口令登录被接受：鉴权未生效（执行表 #6）');
  if (err.code !== 'unauthorized' && err.code !== 'invalid_credentials') {
    return fail('错误口令登录返回 ' + err.code + '，应为 unauthorized（v1）/ invalid_credentials（v0）');
  }

  // 既有会话不受影响：登录失败不应作废其它会话
  let err2 = null;
  try {
    await protocol.rawCall('network.status', {});
  } catch (e) {
    err2 = e;
  }
  if (err2) return fail('错误口令登录后既有 token 失效（' + err2.code + '）：登录失败不应作废其它会话');
  if (protocol.token !== beforeToken) return fail('错误口令登录后客户端 token 发生了变化');

  return pass(
    '错误口令被拒 [' + err.code + ']（' + describe({ code: err.code }).text + '）' +
      ' · 既有会话 token 仍有效 · 未与内部错误混淆'
  );
}

/* ---------------- 13. token 大小写（矩阵 #17） ---------------- */

async function checkTokenCase(ctx) {
  const protocol = ctx.protocol;
  if (!protocol.loggedIn) return skip('未登录，无 token 可测');
  const tok = protocol.token;
  // 固件契约：32 位大写 hex（auth_token.c kHex="0..9A-F"）。探测方向按 token
  // 实际形态自适应：含小写→探大写变体；含大写→探小写变体；纯无字母才无差异。
  const hasLower = /[a-z]/.test(tok);
  const hasUpper = /[A-Z]/.test(tok);
  if (!hasLower && !hasUpper) {
    return expected('token 无字母，大小写探测无差异（token 长度 ' + tok.length + '）');
  }
  const dirText = hasLower ? '大写' : '小写';
  const probe = hasLower ? tok.toUpperCase() : tok.toLowerCase();
  if (probe === tok) {
    return expected('token 大小写变体与原值相同（长度 ' + tok.length + '），本项无差异可测');
  }

  /* 11-06 修：本项断言的是**设备对首个回包的判定**。
   *  - noAuthRetry + 显式 token：protocol 层禁止自动重登重试（H8），否则测到的
   *    是「换新 token 重发」后的结果，不是首个回包；
   *  - ble_write_timeout 单独处理：微信 Android 偶发「写已送达、success 回调不回」，
   *    此时响应可能已到（protocol 会保留），仍失败则重发一次（负向探测无副作用），
   *    两次都拿不到回包只能判未取证，不能判成设备拒绝失败。 */
  const auth0 = protocol.stats.authRetries;
  const ackLost0 = protocol.stats.writeAckLost;
  const attempts = [];
  let err = null;
  let reqId = '';

  for (let i = 1; i <= 2; i++) {
    const t0 = Date.now();
    try {
      const r = await protocol.rawCall('network.status', {}, { token: probe, noAuthRetry: true, noRateRetry: true });
      attempts.push('第 ' + i + ' 次 ' + (Date.now() - t0) + 'ms 回包 ok');
      return fail(
        dirText + '变体 token 被接受：token 未按原样比对（执行表 #17）· 请求 id=' + (r && r.id) +
          ' · ' + attempts.join('；')
      );
    } catch (e) {
      const ms = Date.now() - t0;
      err = e;
      reqId = (e && e.requestId) || '';
      attempts.push(
        '第 ' + i + ' 次 ' + ms + 'ms → ' + ((e && e.code) || '?') +
          (e && e.responseId ? '（响应 id=' + e.responseId + '）' : '（无响应 id：客户端侧失败）')
      );
      if (e && e.code === 'ble_write_timeout') {
        await sleep(600);
        continue; // 写 ack 丢失：重发一次，再取首个回包
      }
      break;
    }
  }

  if (!err) return fail(dirText + '变体探测未产生结果');
  if (err.code === 'ble_write_timeout') {
    return skip(
      '两次写入的 success 回调均未返回（' + attempts.join('；') +
        '）：本轮未取得设备回包，不能据此判定大小写比对。链路疑似假死，断开重连后单独重跑本项'
    );
  }
  if (err.code !== 'unauthorized') {
    return fail(
      dirText + '变体 token 返回 ' + err.code + '，应为 unauthorized（' + attempts.join('；') + '）'
    );
  }
  // 设备侧判定的硬证据：错误响应带回了本次请求 id（客户端自造的超时/断链不会有 responseId）
  if (!err.responseId || String(err.responseId) !== String(reqId)) {
    return fail(
      'unauthorized 未能对上请求 id（请求 ' + (reqId || '?') + ' / 响应 ' + (err.responseId || '无') +
        '）：无法证明是设备对该请求的判定 · ' + attempts.join('；')
    );
  }

  const authDelta = protocol.stats.authRetries - auth0;
  if (authDelta !== 0) {
    return fail('负向探测触发了 ' + authDelta + ' 次自动重登（H8 要求零重登，否则测到的是重试结果）· ' + attempts.join('；'));
  }

  let err2 = null;
  try {
    await protocol.rawCall('network.status', {});
  } catch (e) {
    err2 = e;
  }
  if (err2) return fail('探测后原 token 失效（' + err2.code + '）：拒绝变体不应影响原 token');

  const ackLost = protocol.stats.writeAckLost - ackLost0;
  return pass(
    dirText + '变体 token 被拒 [unauthorized]，响应 id=' + err.responseId + ' 与请求 id 一致（设备侧判定，非客户端超时）' +
      ' · 长度 ' + tok.length + '，原样保存比对生效 · 原 token 仍有效' +
      ' · 负向探测未触发重登（authRetries +' + authDelta + '）' +
      (ackLost ? ' · 期间有 ' + ackLost + ' 次写 ack 丢失但响应已到（已保留响应，不再误判为超时）' : '') +
      ' · ' + attempts.join('；')
  );
}

/* ---------------- 13b. 原现象回归：loopback→network.status（配合清单第 2 条） ---------------- */

/**
 * 复现最初断联事件的操作序列：登录态下 data.loopback → network.status。
 * 判据（对应配合清单三分支）：
 *  - network.status 一次通过 = 无 auth_required；
 *  - stats.authRetries 零增量 = 没有被 401 重试"治好"；
 *  - lastTxHasToken=true = 该调用点确实带了会话 token（调用点漏带假设的动态排除）。
 */
async function checkLoopbackStatus(ctx) {
  const protocol = ctx.protocol;
  if (!protocol.loggedIn) return skip('未登录，无法回归原现象');
  const before = protocol.stats.authRetries;
  try {
    await protocol.dataLoopback(true);
  } catch (e) {
    return fail('data.loopback 失败：' + describe(e).text);
  }
  let st = null;
  try {
    st = await protocol.networkStatus();
  } catch (e) {
    return fail(
      'network.status 失败（原现象复现：' + ((e && e.code) || '未知') + '）：' + describe(e).text
    );
  }
  const delta = protocol.stats.authRetries - before;
  if (delta !== 0) return fail('network.status 触发了 ' + delta + ' 次 401 自动重试（原现象仍在）');
  if (protocol.lastTxHasToken !== true) {
    return fail('network.status 的 tx 未带 token（lastTxHasToken=false）：调用点漏带 token，须修调用点而不是依赖重试');
  }
  return pass(
    'data.loopback ok → network.status ok · 无 auth_required · 无 401 重试 · tx hasToken=true' +
      '（sta_ssid=' + (st && st.sta_ssid ? st.sta_ssid : '-') + '）'
  );
}

/* ---------------- 13c. 重连 3 轮（配合清单第 3 条前半） ---------------- */

/**
 * 连续 3 轮：断开 → 重连（扫描/连接/发现/订阅）→ 重登 → 业务请求。
 * 每轮断言 ensureLink ok + loggedIn + network.status 无 auth_required 重试。
 * 串口判据（无 0x213 或 0x213 前无 auth_required）由硬件侧对时取证，本项是应用层等价判据。
 */
async function checkRelink3(ctx) {
  const ble = ctx.ble;
  const protocol = ctx.protocol;
  const target = (typeof ble.lastTarget === 'function' && ble.lastTarget()) || {};
  if (!target.deviceId && !target.name) return skip('没有历史连接目标，无法回归重连场景');

  /* 轮次间隔（2026-11-06 加）：Android 对 startBluetoothDevicesDiscovery 有
   * 「30s 内 ≤5 次」的扫描配额，超了就是 10008「系统异常，请重试」——扫描根本
   * 没起来。20:34 那轮 #19 与 #21 紧邻，3 轮重连里有多次 startScan，
   * 第 3 轮恰好撞配额，被记成 P0 FAIL（设备侧同期 soak 360/360 全绿）。
   * 因此：轮间留 ≥6s 让配额窗口滑过去，并把每轮的 startScan 次数/失败数/错误码
   * 写进证据——是「设备不广播」还是「手机侧配额」，必须能区分。 */
  const ROUND_GAP_MS = ctx.roundGapMs === undefined ? 6000 : Math.max(0, Number(ctx.roundGapMs) || 0);
  const rounds = [];
  /* 凭据优先级：ctx 显式提供 > 会话内存凭据（此前登录用过的）> 用户保存的长期凭据 > 默认账号。
   * 不能硬编码默认口令：改过口令的设备上会把「重连回归」误判成「登录失败」。 */
  const creds = (protocol && protocol.credentials) || {};
  const savedCred = credstore.loadSaved();
  const username =
    (ctx && ctx.username) || creds.username || (savedCred && savedCred.username) || DEFAULT_USERNAME;
  const password =
    ctx && ctx.password !== undefined
      ? ctx.password
      : creds.password !== undefined
        ? creds.password
        : savedCred
          ? savedCred.password
          : DEFAULT_PASSWORD;
  for (let i = 1; i <= 3; i++) {
    if (i > 1) await sleep(ROUND_GAP_MS);
    const s0 = ble.snapshot();
    /* 断链前的设备侧快照：adv_retry_count 稳定 + connected=true 说明设备健康，
       若随后手机「扫不到」，责任在主机侧扫描（而不是设备不广播）。 */
    let preBle = null;
    try {
      const ds = await protocol.deviceStatus();
      preBle = (ds && ds.ble) || null;
    } catch (e) {
      preBle = null; // 旧固件无 device.status：留空，不阻断
    }
    const preText = preBle
      ? '断开前 ble.connected=' + (preBle.connected ? 'true' : 'false') +
        ' adv_retry=' + preBle.adv_retry_count + ' last_error=' + (preBle.last_error || 'none')
      : '断开前 device.status 不可用';
    try {
      await ble.disconnect();
    } catch (e) { /* 已断则忽略 */ }
    let r = await ensureLink(ble, protocol, {
      target: { deviceId: target.deviceId, name: target.name },
      username: username,
      password: password,
      scanTimeout: ctx.scanTimeoutMs, // 未传走 link.js 默认 12s×2 窗（自测桩可缩短）
    });
    const s1 = ble.snapshot();
    const scanStarts = (s1.scanStarts || 0) - (s0.scanStarts || 0);
    const scanFails = (s1.scanFailures || 0) - (s0.scanFailures || 0);
    const scanNote =
      '扫描 ' + scanStarts + ' 次' + (scanFails ? '（失败 ' + scanFails + ' 次：' + (s1.lastScanError || '未知') + '）' : '');
    let adapterResetNote = '';
    if (!r.ok || !r.loggedIn) {
      const scanHint =
        r.scan && r.scan.attempts > 1
          ? '（已退避复扫 ' + r.scan.attempts + ' 次窗口，累计约 ' + Math.round(r.scan.ms / 1000) + 's 仍未发现）'
          : '';
      const errText = r.error || '未知原因';
      /* 扫描 API 级失败：错误来自 startBluetoothDevicesDiscovery，设备侧根本没被问到。
         这类失败不能算「重连回归失败」，要指明是主机侧扫描条件。 */
      const apiFail = /系统异常|10008|startBluetooth/i.test(errText) || (scanFails > 0 && !r.linked);
      /* P1-3（2026-11-10 评审）：扫描两窗超时 + 断开前设备侧 connected=true
         → 订阅态僵尸链路形态（手机栈半开：本地 disconnect 只关 GATT，设备
         conn=1 依规不广播；#11/#21 同一现象两种结论的根源）。按契约
         timing.derived_client_budgets.link_recovery（设备自救 300s ≫ 客户端 26s，
         适配器重启是唯一快速恢复路径）：先试一次 resetAdapter，救回则本轮继续；
         仍失败记 INCOMPLETE——不判 FAIL（设备侧未证实缺陷），但重连回归本轮
         没有证据，P0 不能凭它签收，与 #11 同判。 */
      const lockStaleShape =
        !apiFail && r.scan && r.scan.outcome === 'timeout' && preBle && preBle.connected === true;
      if (lockStaleShape) {
        let r2 = null;
        let resetFail = '';
        try {
          await ble.resetAdapter();
          r2 = await ensureLink(ble, protocol, {
            target: { deviceId: target.deviceId, name: target.name },
            username: username,
            password: password,
            scanTimeout: ctx.scanTimeoutMs,
          });
        } catch (e) {
          resetFail = 'resetAdapter 后重连异常 [' + ((e && e.code) || '?') + ']：' + describe(e).text;
        }
        if (r2 && r2.ok && r2.loggedIn) {
          r = r2;
          adapterResetNote =
            '（第 ' + i + ' 轮原扫描超时，经 resetAdapter 恢复后重连成功）';
        } else {
          return skip(
            '第 ' + i + '/3 轮重连未完成（stage=' + r.stage + '）：' + errText + scanHint +
              ' · ' + scanNote + ' · ' + preText + (resetFail ? ' · ' + resetFail : '') +
              ' · 判读：lock_stale 形态（断开前 connected=true + adv_retry=' +
              (preBle ? preBle.adv_retry_count : '?') + ' + 两窗扫描超时；rx_age_ms>90s 需串口复核）——' +
              '手机栈半开、设备依规不广播，本项不判 FAIL（无法区分固件缺陷与手机栈缓存），' +
              '但「断开→重连→重登→业务请求」本轮无证据，记 INCOMPLETE；' +
              'resetAdapter 已试一次未恢复，请手动关开手机蓝牙后重跑本项',
            'incomplete'
          );
        }
      } else {
        return fail(
          '第 ' + i + '/3 轮重连未完成（stage=' + r.stage + '）：' + errText + scanHint +
            ' · ' + scanNote + ' · ' + preText +
            (apiFail
              ? ' · 判读：扫描 API 级失败（设备未被询问），优先查手机侧扫描配额/扫描冷却；重连回归需在扫描可用时重跑'
              : '')
        );
      }
    }
    const before = protocol.stats.authRetries;
    try {
      await protocol.networkStatus();
    } catch (e) {
      return fail('第 ' + i + '/3 轮业务请求失败（' + ((e && e.code) || '?') + '）：' + describe(e).text + ' · ' + scanNote);
    }
    if (protocol.stats.authRetries - before !== 0) {
      return fail('第 ' + i + '/3 轮业务请求出现 auth_required 重试（原现象复现）');
    }
    rounds.push(
      '#' + i + ' link=' + r.ms + 'ms' + (r.scan && r.scan.attempts > 1 ? '（复扫命中）' : '') +
        ' · ' + scanNote + ' · adv_retry=' + (preBle ? preBle.adv_retry_count : '?') +
        adapterResetNote
    );
  }
  const drift = ble.snapshot();
  return pass(
    '3 轮断开→重连→重登全部成功，业务请求均无 auth_required（' + rounds.join(' · ') + '）' +
      ' · 轮间间隔 ' + ROUND_GAP_MS + 'ms 规避 Android 扫描配额 · 本次扫描失败累计 ' +
      (drift.scanFailures || 0) + ' 次'
  );
}

/* ---------------- 14. 受控改密卡（矩阵 #16） ---------------- */

/**
 * #16 受控流程（不进一键自动化）：原口令登录 → 改密到内存临时口令 → 断言
 * sessions_invalidated=true 且本地 token 被清空（G1）→ 临时口令登录 → 恢复
 * 原口令 → 原口令登录验证。finally 兜底：设备仍停在非原口令时尽力恢复。
 * 口令（含临时口令）一律不写入 detail，只记长度与布尔。
 */
async function pwdChangeControlled(ctx, oldPwd) {
  const protocol = ctx.protocol;
  if (!oldPwd) return fail('未提供当前管理员口令');
  const temp = 'T4a-Tmp-' + Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);
  const steps = [];
  const inv0 = protocol.stats.sessionInvalidations;
  let current = oldPwd; // 设备当前生效口令（finally 兜底用）

  const login = async function (pwd) {
    await protocol.login(DEFAULT_USERNAME, pwd);
  };
  const adminSet = async function (oldP, newP) {
    return protocol.rawCall(
      'auth.admin.set',
      { old_password: oldP, new_password: newP },
      { noAuthRetry: true, noRateRetry: true }
    );
  };
  // 改密成功响应断言 + G1 断言（token 必须已被清空；expectedInv：② 时 +1、⑤ 时 +2）
  const assertInvalidated = function (resp, stage, expectedInv) {
    const d = (resp && resp.data) || {};
    if (!d.saved) return stage + '：响应不含 saved=true';
    if (d.sessions_invalidated !== true) return stage + '：固件未返回 sessions_invalidated=true（旧固件？执行表 #16 必测项）';
    if (protocol.token !== '') return stage + '：收到 sessions_invalidated 后本地 token 未清空（G1 未生效）';
    if (protocol.stats.sessionInvalidations !== expectedInv) {
      return stage + '：sessionInvalidations 计数异常 ' + protocol.stats.sessionInvalidations + '（预期 ' + expectedInv + '）';
    }
    return '';
  };

  try {
    // ① 原口令登录
    try {
      await login(oldPwd);
    } catch (e) {
      return fail('① 原口令登录失败 [' + e.code + ']：' + describe(e).text + '（未做任何改密）');
    }
    steps.push('① 原口令登录成功');

    // ② 改密到临时口令
    let bad = '';
    try {
      bad = assertInvalidated(await adminSet(oldPwd, temp), '② 改密', inv0 + 1);
    } catch (e) {
      bad = '② 改密失败 [' + e.code + ']：' + describe(e).text;
    }
    if (bad) return fail(bad);
    current = temp;
    steps.push('② 改密成功，响应含 sessions_invalidated=true');
    steps.push('③ 本地 token 与凭据已自动清空（G1 生效）');

    // ④ 临时口令登录（改密立即生效）
    try {
      await login(temp);
    } catch (e) {
      return fail('④ 临时口令登录失败 [' + e.code + ']：' + describe(e).text);
    }
    steps.push('④ 临时口令登录成功（改密立即生效）');

    // ⑤ 恢复原口令
    try {
      bad = assertInvalidated(await adminSet(temp, oldPwd), '⑤ 恢复', inv0 + 2);
    } catch (e) {
      bad = '⑤ 恢复原口令失败 [' + e.code + ']：' + describe(e).text;
    }
    if (bad) return fail(bad);
    current = oldPwd;
    steps.push('⑤ 已恢复原口令（sessions_invalidated=true，token 再次清空）');

    // ⑥ 原口令登录验证
    try {
      await login(oldPwd);
    } catch (e) {
      return fail('⑥ 恢复后原口令登录失败 [' + e.code + ']：设备可能仍停在临时口令，请手动改回');
    }
    steps.push('⑥ 原口令登录验证成功（凭据已回填会话）');

    return pass(
      steps.join('\n') +
        '\nsessions_invalidated ×2 · sessionInvalidations ' + inv0 + '→' + protocol.stats.sessionInvalidations +
        ' · 临时口令长度 ' + temp.length + '（值不入报告） · 全程未把任何口令写入本报告'
    );
  } finally {
    if (current !== oldPwd) {
      try {
        await login(current);
        await adminSet(current, oldPwd);
        current = oldPwd;
      } catch (e) {
        /* 兜底失败只能上抛信息：设备可能停在临时口令 */
      }
    }
  }
}

/* ---------------- 执行 ---------------- */

/* ---------------- 用例间自动重连（T4 2026-11-05 #4 教训） ----------------
 * 整轮 runAll 中一次被动断链曾让后续 12 项全部 SKIP。runCheck 发现断链时先
 * 尝试一次 ensureLink（复用会话凭据；失败后本轮不再逐项重试，避免每项空耗
 * ~30s 扫描窗口），成功则该项正常执行，证据里标注「自动重连恢复」。 */
let _relinkFailedOnce = false;
/* 本轮实际在跑的设备：链路还活着时持续刷新，断链后靠它把「重连目标」
 * 钉在原设备上，避免回退到存储里上一台的记录。 */
let _batchTarget = null;

/**
 * 自动重连失败的归类。
 * - 身份不一致（device_mismatch）：扫描窗口里没有目标设备、只有别的 NUS 设备。
 *   这是「选错设备/目标不在场」，人介入前重跑也不会变好 → INCOMPLETE（阻塞）。
 * - 自身即链路恢复用例（#11/#21）：同样不能按「前置未满足」豁免 → INCOMPLETE。
 * - 其余：链路抖动，重连后可重跑 → link_down（不阻塞）。
 */
function relinkFailure(def, rel) {
  const msg = (rel && rel.reason) || '未知原因';
  if (rel && rel.code === 'device_mismatch') {
    return {
      detail:
        '目标设备身份不一致：' + msg + '；本项未执行——这不是「重连后重跑」能解决的，' +
        '须回设备页选对设备后再跑',
      reason: 'incomplete',
    };
  }
  if (isSelfLink(def)) {
    return {
      detail:
        '蓝牙未连接，自动重连未恢复（' + msg + '）；本项自身即链路恢复用例，' +
        '不能按「前置未满足」豁免，记 INCOMPLETE',
      reason: 'incomplete',
    };
  }
  return { detail: '蓝牙未连接，自动重连未恢复（' + msg + '）；请回设备页连接后单独运行', reason: 'link_down' };
}

async function tryRelink(ctx) {
  const ble = ctx.ble;
  const protocol = ctx.protocol;
  if (!ble || !protocol) return { ok: false, reason: 'ctx 缺 ble/protocol', code: 'no_ctx' };
  if (_relinkFailedOnce) return { ok: false, reason: '本轮此前自动重连已失败，不再逐项重试', code: 'latched' };
  /* 目标优先用「本轮实际跑的那台」，而不是断链后回退到上次连过的记录。
   * 断链会把 ble.deviceId 清空，_target() 的三级回退（当前链路 > 页面缓存 >
   * 上次记录）这时可能取到上一台的记录——2026-11-11 22:58 那轮就是这么把
   * 65D8 的批次重连到 C8E4 上、又因身份校验拒绝连接，连带废掉 5 项。 */
  const pinned = _batchTarget || {};
  const t = ctx.target || {};
  const target = {
    deviceId: ble.deviceId || pinned.deviceId || t.deviceId || '',
    name: ble.deviceName || pinned.name || t.name || '',
  };
  const creds = protocol.credentials || {};
  const r = await ensureLink(ble, protocol, {
    target: target,
    username: creds.username || DEFAULT_USERNAME,
    password: creds.password === undefined ? DEFAULT_PASSWORD : creds.password,
  });
  if (!r.ok) {
    _relinkFailedOnce = true;
    return { ok: false, reason: r.error || r.code || 'ensureLink 失败', code: r.code || '' };
  }
  return { ok: true, ms: r.ms, loggedIn: r.loggedIn };
}

const RUNNERS = {
  scan: checkScan,
  gatt: checkGatt,
  notify: checkNotify,
  scanRepeat: checkScanRepeat,
  fragment: checkFragment,
  long: checkLong,
  longRepeat: checkLongRepeat,
  pipeline: checkPipeline,
  dual: checkDual,
  data: checkData,
  reconnect: checkReconnect,
  opsem: checkOpSemantics,
  authinfo: checkAuthInfo,
  badcred: checkBadCred,
  tokencase: checkTokenCase,
  'loopback-status': checkLoopbackStatus,
  relink3: checkRelink3,
};

async function runCheck(id, ctx) {
  const def = CHECKS.filter(function (c) {
    return c.id === id;
  })[0];
  if (!def) throw new Error('未知检查项 ' + id);

  const started = Date.now();
  let result;

  // 链路已在（含单项运行时刚被页面级 _autoLink 恢复）：重置失败标记，
  // 让后续用例间重连能力可用
  if (ctx.ble && ctx.ble.connected) {
    _relinkFailedOnce = false;
    if (ctx.ble.deviceId) {
      _batchTarget = { deviceId: ctx.ble.deviceId, name: ctx.ble.deviceName || '' };
    }
  }

  if (def.manual) {
    /* 卡片自带 blockedBy = 客观不可执行（#25 改密卡在恢复通道落实前禁止执行）。
     * 这类不能记 manual：manual 会进 todo，结论就变成「去跑一下」，而卡片
     * 恰恰写着不许跑；blocked 会带着解除条件进阻塞清单。 */
    result = def.blockedBy
      ? blocked('客观条件不具备：本卡当前不得执行（解除条件见阻塞项清单）——' + (def.manualHint || ''), def.blockedBy)
      : skip('待人工执行：' + (def.manualHint || ''), 'manual');
  } else if (def.needConnection !== false && (!ctx.ble || !ctx.ble.connected)) {
    // 断链不再直接 SKIP：先尝试自动重连（T4 2026-11-05 #4 教训：
    // 一次被动断链曾让本轮后续 12 项全部失去证据）
    const rel = await tryRelink(ctx);
    if (!rel.ok) {
      const f = relinkFailure(def, rel);
      result = skip(f.detail, f.reason);
    } else {
      try {
        result = await RUNNERS[id](ctx);
      } catch (err) {
        const d = describe(err);
        result = fail('异常：' + d.text + (err && err.code ? ' [' + err.code + ']' : ''));
      }
      result.detail = '[自动重连恢复 ' + rel.ms + 'ms] ' + result.detail;
    }
  } else if (!RUNNERS[id]) {
    result = skip('未实现');
  } else {
    try {
      result = await RUNNERS[id](ctx);
    } catch (err) {
      const d = describe(err);
      result = fail('异常：' + d.text + (err && err.code ? ' [' + err.code + ']' : ''));
    }
  }

  const tier = tierOf(def);
  const row = {
    id: def.id,
    name: def.name,
    desc: def.desc,
    p0: tier === 'p0',
    tier: tier,
    scope: scopeOf(def),
    manual: !!def.manual,
    ms: Date.now() - started,
    status: result.status,
    detail: result.detail,
    reason: result.reason || '',
    blockedBy: result.blockedBy || '',
    extra: result.extra || null,
  };
  row.state = stateOf(row);
  return row;
}

async function runAll(ctx, onUpdate, opts) {
  const o = opts || {};
  const except = o.except || [];
  const results = [];
  for (let i = 0; i < CHECKS.length; i++) {
    const def = CHECKS[i];
    if (except.indexOf(def.id) >= 0) continue;
    if (onUpdate) onUpdate(def.id, 'running', results.slice());
    const r = await runCheck(def.id, ctx);
    results.push(r);
    if (onUpdate) onUpdate(def.id, r.status, results.slice(), r);
  }
  return results;
}

/**
 * 把除 except 之外的项统一记 SKIP（附原因）。
 * 用于「链路没建起来」这类前置失败：SKIP 不会被算成 PASS，但报告里能看清为什么没跑，
 * 也不会把「没连上」误判成设备 FAIL。
 */
function skipRest(reason, except) {
  const ex = except || [];
  return CHECKS.filter(function (c) {
    return ex.indexOf(c.id) < 0;
  }).map(function (c) {
    const tier = tierOf(c);
    const row = {
      id: c.id,
      name: c.name,
      desc: c.desc,
      p0: tier === 'p0',
      tier: tier,
      scope: scopeOf(c),
      manual: !!c.manual,
      ms: 0,
      status: 'skip',
      detail: reason,
      reason: 'link_down',
      blockedBy: '',
      state: 'not_run',
      extra: null,
    };
    /* 卡片自带禁令的（#25）与链路无关：整批跳过时也不能被写成「等重连后重跑」。 */
    if (c.blockedBy) {
      row.status = 'blocked';
      row.detail = '客观条件不具备：本卡当前不得执行（解除条件见阻塞项清单）——' + (c.manualHint || '');
      row.reason = '';
      row.blockedBy = c.blockedBy;
      row.state = 'blocked';
    }
    return row;
  });
}

/** 生成可粘贴进验收记录的文本 */
function buildReport(results, meta) {
  const lines = [];
  const m = meta || {};
  lines.push('BLE 小程序验收自检报告（T4）');
  lines.push('时间：' + (m.time || '-'));
  lines.push('设备：' + (m.deviceName || '-') + ' · ' + (m.deviceId || '-'));
  if (m.targetName || m.targetId) {
    const same =
      (m.targetId || '') === (m.deviceId || '') && (m.targetName || '') === (m.deviceName || '');
    lines.push(
      '目标设备：' + (m.targetName || '-') + ' · ' + (m.targetId || '-') +
        (same ? '' : '（与实连设备不一致：本轮自动重连按目标查找，先核对是否选错设备）')
    );
  }

  if (m.env) {
    const e = m.env;
    lines.push(
      '环境：平台 ' + (m.platform || '-') + ' / ' + (m.system || '-') + ' · 微信 ' + (m.wechat || '-') +
        (m.firmware ? ' · 固件 ' + m.firmware : '')
    );
    lines.push(
      '链路：会话 #' + (e.sessionId || '-') + ' · 写分片 ' + e.writeChunk + 'B（不主动协商 MTU' +
        (e.mtu ? '，实际 ' + e.mtu + '）' : '）') +
        ' · 通知分片 ' + (e.notifyCount ? e.notifyMin + '–' + e.notifyMax + 'B（均 ' + e.notifyAvg + 'B / ' + e.notifyCount + ' 片）' : '未记录') +
        ' · 断链 主动 ' + (e.manualDisconnects || 0) + ' / 被动 ' + (e.disconnects || 0) + ' 次' +
        '（本机确认关闭 ' + (e.linkCloseConfirmed || 0) + ' 次 / 设备侧广播确认 ' + (e.advConfirmed || 0) + ' 次）' +
        /* 扫描证据（#21 判读用）：启动次数/失败次数＝手机侧扫描配额是否被打满 */
        (e.scanStarts ? ' · 扫描启动 ' + e.scanStarts + ' 次' + (e.scanFailures ? '（失败 ' + e.scanFailures + ' 次）' : '') : '') +
        (e.notifyOverChunk ? ' · 超 20B 通知 ' + e.notifyOverChunk + ' 片（片被合并/MTU 变化）' : '')
    );
  }
  // 运行态网络判读（connected_ssid / IP / MQTT / last_disconnect）：有采集才写，避免编造
  if (m.net) lines.push('网络：' + m.net);

  lines.push('');
  /* v2（2026-11-08）：条目状态直接打 5 状态，不再用统一的 [SKIP] 抹平
   * 「未执行/证据不完整/无条件不具备」；P1 与 T4-B 范围在行尾标注。 */
  results.forEach(function (r, i) {
    const st = stateOf(r);
    const why = st === 'not_run' || st === 'incomplete' || st === 'blocked' ? skipReason(r) : '';
    lines.push(
      (i + 1) + '. ' + r.name + ' [' + (STATE_TEXT[st] || st) + '] (' + r.ms + 'ms)' +
        (tierOf(r) === 'p1' ? ' [P1]' : '') +
        (scopeOf(r) !== 't4a' ? ' [' + String(scopeOf(r)).toUpperCase() + ']' : '') +
        (why && why !== 'manual' ? ' · 归因=' + (SKIP_REASON_TEXT[why] || why) : '') +
        (r.blockedBy ? ' · 解除条件=' + r.blockedBy : '')
    );
    if (r.detail) lines.push('   ' + r.detail);
  });

  const countState = function (s) {
    return results.filter(function (r) {
      return stateOf(r) === s;
    }).length;
  };
  const passN = countState('pass');
  const expN = countState('expected');
  const failN = countState('fail');
  const notRunN = countState('not_run');
  const incN = countState('incomplete');
  const blkN = countState('blocked');

  lines.push('');
  lines.push(
    '汇总：PASS ' + passN + ' / EXPECTED ' + expN + ' / FAIL ' + failN +
      ' / NOT_RUN ' + notRunN + ' / INCOMPLETE ' + incN + ' / BLOCKED ' + blkN +
      '（旧口径 SKIP 合计 ' + (notRunN + incN + blkN) + '，仅用于与 v1 报告对照）'
  );

  const rowsOfTier = function (t) {
    return results.filter(function (r) {
      return tierOf(r) === t && scopeOf(r) === 't4a';
    });
  };
  const p0rows = rowsOfTier('p0');
  const p1rows = rowsOfTier('p1');
  const exempt = results.filter(function (r) {
    return scopeOf(r) !== 't4a';
  });
  const cntIn = function (list, s) {
    return list.filter(function (r) {
      return stateOf(r) === s;
    }).length;
  };
  const nameList = function (list) {
    return list.map(function (r) {
      return r.name;
    }).join('、');
  };
  lines.push(
    '  P0（T4-A 功能项 ' + p0rows.length + ' 项）：PASS ' + cntIn(p0rows, 'pass') +
      ' / FAIL ' + cntIn(p0rows, 'fail') +
      ' / NOT_RUN ' + cntIn(p0rows, 'not_run') +
      ' / INCOMPLETE ' + cntIn(p0rows, 'incomplete') +
      ' / BLOCKED ' + cntIn(p0rows, 'blocked')
  );
  const linkDown = results.filter(function (r) {
    /* #11 已是 INCOMPLETE，正常不会命中；这里是 skipRest 整批跳过时的兜底，
     * 免得「自身即链路用例」又被列进「非缺陷、重跑即可」。 */
    return stateOf(r) === 'not_run' && skipReason(r) === 'link_down' && !isSelfLink(r);
  });
  if (linkDown.length) {
    lines.push('  NOT_RUN 归因：链路级联/前置未满足 ' + linkDown.length + ' 项（非缺陷，重连后重跑即可）：' + nameList(linkDown));
  }
  if (p1rows.length) {
    const done = p1rows.filter(hasEvidence);
    const miss = p1rows.filter(function (r) {
      return !hasEvidence(r);
    });
    lines.push(
      '  证据完整度（P1）：' + done.length + '/' + p1rows.length + ' 已采集' +
        (miss.length ? '（未采集：' + nameList(miss) + '；不影响 T4-A 签收，但不得写成已留存）' : '')
    );
  }
  const blkRows = results.filter(function (r) {
    return stateOf(r) === 'blocked';
  });
  if (blkRows.length) {
    lines.push(
      '  阻塞项及解除条件：' + blkRows.map(function (r) {
        return r.name + '（' + (r.blockedBy || '未填解除条件') + '）';
      }).join('；')
    );
  }
  if (exempt.length) {
    lines.push(
      '  范围豁免（不阻塞 T4-A）：' + exempt.map(function (r) {
        return r.name + ' [' + STATE_TEXT[stateOf(r)] + ']' + (r.blockedBy ? '（' + r.blockedBy + '）' : '');
      }).join('；')
    );
  }

  /* v2（2026-11-08）：结论由 verdictOf 统一产出，页面与报告共用同一份规则，
   * 不再各写一套（v1 曾出现页面说「待重跑」、报告说「不可签收」的漂移）。 */
  const v = verdictOf(results, { partial: !!m.partial });
  lines.push('口径：v2（P0/P1 + 5 状态，2026-11-08 起）；v1 对照见 docs/T4验收口径v2_状态模型与审计对照_2026-11-08.md');
  /* 修订说明只在真的触发时写进报告，不然每份报告都挂一条与本次无关的话。 */
  const revHit = results.some(function (r) {
    return stateOf(r) === 'blocked' || (isSelfLink(r) && stateOf(r) === 'incomplete');
  });
  if (revHit) {
    lines.push(
      '口径修订 2026-11-11：#11 断连与重连、#21 重连 3 轮不再按「链路级联」豁免' +
        '（自身即链路恢复用例，记 INCOMPLETE）；' +
        '#25 改密卡在恢复通道落实前记 BLOCKED；报文留档补 sys 条数与无配对 tx id'
    );
  }
  lines.push('T4 结论：' + v.text);
  lines.push('DATA 备注：只签收功能与边界，未签收端到端可靠性（无帧头/序号/ACK/重传/流控）');

  /* P1 证据附页（2026-11-08）：i/n 只说明「采没采」，附页要说明「采到的东西能追到哪」。
     避免把「摘要采集完整」写成「原始证据已留存」。 */
  if (p1rows.length) {
    lines.push('');
    lines.push('证据附页（P1，不阻塞签收）');
    const dev = (m.deviceName || '-') + (m.deviceId ? ' / ' + m.deviceId : '');
    const fw = m.firmware ? m.firmware + (m.buildSha ? '（build_sha ' + m.buildSha + '）' : '') : '未记录';
    const at = m.time || '未记录';
    const sid = m.env && m.env.sessionId ? '#' + m.env.sessionId : '未记录';
    p1rows.forEach(function (r) {
      const st = STATE_TEXT[stateOf(r)];
      const got = hasEvidence(r);
      lines.push(
        '- ' + r.name + ' | ' + st + (got ? '' : '（未采集）') +
          ' | 设备 ' + dev + ' | 固件 ' + fw + ' | 采集 ' + at + ' | 会话 ' + sid +
          ' | 原始数据：' + (got ? '仅摘要（逐条报文/分片见调试日志，未随报告留存）' : '无')
      );
    });
    lines.push('  说明：以上为同轮 env 快照摘要，可用于核对「设备身份/固件/时间/会话」一致性；原始报文未随报告留存，不得表述为已留存。');
  }

  /* 报文留档（C，2026-11-08）：设备页 onHide 会把 protocol.onLog 置 null，
     跑批期从此没有任何报文证据（21:48 串台那 7.7s 空窗就是这么来的）。
     协议层现自带环形留档，这里把本批 tx/rx 的 id 序列写进报告。 */
  if (m.batchLog && m.batchLog.count) {
    const b = m.batchLog;
    lines.push('');
    lines.push('报文留档（本批）');
    const sysN = b.sysCount || 0;
    const unpaired = b.unpairedIds || [];
    lines.push(
      '条数 ' + b.count + '（日志序号 ' + b.from + '–' + b.to + '）· tx ' + b.txCount + ' / rx ' + b.rxCount +
        (sysN ? ' / sys ' + sysN + '（断链/订阅等非报文事件）' : '')
    );
    if (unpaired.length) {
      lines.push(
        'tx 无配对 rx：' + unpaired.join(',') +
          '（本批内没有对应响应：超时，或响应落在批次外。正文的「未匹配」只统计「有 rx 无 tx」，不含此项）'
      );
    }
    lines.push('tx id：' + (b.txIds || '-'));
    lines.push('rx id：' + (b.rxIds || '-'));
    lines.push('说明：环形缓冲保留最近 600 条原始报文，全文未随报告导出；跨设备/跨会话核对以 device_id + 设备串口为准。');
  }
  return lines.join('\n');
}

module.exports = {
  CHECKS,
  runCheck,
  runAll,
  skipRest,
  buildReport,
  scanDisconnected,
  verifyApply,
  rescueCapture,
  rescueCleanup,
  rescueVerify,
  pwdChangeControlled,
  byteAccounting,
  classifyScanTimeout,
  isTransientTryCode,
  retryTryconnectAbsent,
  waitOpTerminal,
  skipReason,
  skipBlocking,
  relinkFailure,
  skip,
  blocked,
  pass,
  fail,
  /* 状态模型 v2（2026-11-08）：页面与报告共用，避免两套判定漂移 */
  STATE_TEXT,
  SKIP_REASON_TEXT,
  stateOf,
  tierOf,
  scopeOf,
  T4B_WHITELIST,
  scopeViolations,
  hasEvidence,
  verdictOf,
  PROBE_CMD,
};
