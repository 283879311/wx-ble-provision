/**
 * 协议契约加载器（单一事实源消费口）。
 *
 * 契约文件在 `contract/v1/*.json`（自硬件侧 `contract/v1` 镜像，带版本戳）。
 * 铁律（docs/协议契约整改方案_2026-11-10.md §2.4）：改语义先改契约；
 * 代码与契约冲突以契约为准——本模块就是把"以契约为准"落成代码可消费的常量。
 *
 * 客户端消费的三类值：
 *  1. op 终态集合（轮询跳出条件必须等于 terminal_states，含 expired）；
 *  2. 瞬态码与重试预算（busy/wifi_config_offline/rate_limited 的 retry_after_ms）；
 *  3. scan 节流残余冷却（scan_throttle_s，自扫描结束起算——与 busy 的 1500ms 不同语义）。
 *
 * 运行时数据口是 contract/v1/data.js（由 tools/gen_contract_data.js 从 *.json 确定性生成）。
 * 为什么不直接 require json（2026-11-10 真机事故，t3/t4/t5/t6 整页空白）：
 *  1. 小程序运行时对 json 模块的支持无官方保证（模块化文档只承诺 js）；
 *  2. 「过滤无依赖文件」静态分析可能扫不到 JS→JSON 依赖，把契约 JSON 剔出代码包。
 * *.json 仍是唯一事实源（与硬件侧逐字节镜像）+ Node 自测输入；改契约后必须重跑生成脚本。
 */

const data = require('../contract/v1/data.js');

const errors = data.errors;
const states = data.states;
const timing = data.timing;
const commands = data.commands;

const version = states.contract_version;

/* ---- 1. op 状态机 ---- */
const TERMINAL_STATES = states.terminal_states.slice();
const ACTIVE_STATES = states.active_states.slice();

function isTerminal(state) {
  return TERMINAL_STATES.indexOf(String(state || '')) >= 0;
}

/* ---- 2. 错误码 / 瞬态 ---- */
const CODE_TABLE = {};
errors.codes.forEach(function (c) {
  CODE_TABLE[c.code] = c;
});

function codeInfo(code) {
  return CODE_TABLE[String(code || '')] || null;
}

/** 瞬态码（class=transient）：按 retry_after_ms 重试，同码连续多次才按缺陷上报 */
function isTransient(code) {
  const c = codeInfo(code);
  return !!(c && c.class === 'transient');
}

/** 瞬态码重试预算：契约值；无登记返回 0（调用方自行兜底） */
function retryAfterMs(code) {
  const c = codeInfo(code);
  return c && typeof c.retry_after_ms === 'number' ? c.retry_after_ms : 0;
}

function maxRetries(code) {
  const c = codeInfo(code);
  return c && typeof c.max_retries === 'number' ? c.max_retries : 0;
}

/* ---- 3. scan 节流（与 busy 的 op 语义不同码不同义）---- */
const SCAN_THROTTLE_MS = (timing.wifi.scan_throttle_s || 3) * 1000;

/* ---- 4. 计时派生预算（客户端侧消费，见 timing.json#derived_client_budgets）---- */
const BUDGETS = {
  tryconnectWorstCaseMs: timing.derived_client_budgets.tryconnect_worst_case_ms,
  opPollIntervalMs: timing.derived_client_budgets.op_poll_interval_recommended_ms,
  postApplyVerifyBudgetMs: timing.derived_client_budgets.post_apply_verify_budget_ms,
  cancelThenNewOpMinWaitMs: timing.derived_client_budgets.cancel_then_new_op_min_wait_ms,
};

/** got_ip 语义（v1.1 冻结）：IP + 联网验证 + MQTT 就绪，三者缺一不交付 */
const GOT_IP_SEMANTICS = states.got_ip_semantics;

module.exports = {
  version: version,
  errors: errors,
  states: states,
  timing: timing,
  commands: commands,
  TERMINAL_STATES: TERMINAL_STATES,
  ACTIVE_STATES: ACTIVE_STATES,
  isTerminal: isTerminal,
  isTransient: isTransient,
  retryAfterMs: retryAfterMs,
  maxRetries: maxRetries,
  codeInfo: codeInfo,
  SCAN_THROTTLE_MS: SCAN_THROTTLE_MS,
  BUDGETS: BUDGETS,
  GOT_IP_SEMANTICS: GOT_IP_SEMANTICS,
};
