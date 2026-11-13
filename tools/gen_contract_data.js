'use strict';
/**
 * 生成 contract/v1/data.js —— 小程序运行时消费的契约数据（确定性派生物）。
 *
 * 为什么必须有这一步（2026-11-10 真机事故，t3/t4/t5/t6 整页空白）：
 *   1. 微信小程序运行时对 require('.json') 的支持无官方保证（模块化文档只承诺 .js）；
 *   2. 「过滤无依赖文件」（ignoreDevUnusedFiles / ignoreUploadUnusedFiles）基于静态
 *      依赖分析，JS 里的 require('xx.json') 可能扫不到，JSON 会被剔出代码包，
 *      导致 contract.js 加载抛错 → 所有依赖它的页面整页空白。
 *
 * 结论：contract/v1/*.json 仍是最小事实源（与硬件侧逐字节镜像）+ Node 自测输入；
 *       运行时一律 require data.js。data.js 禁止手改。
 *
 * 用法：node tools/gen_contract_data.js
 * 改契约流程：硬件侧改 json → cp 镜像到 contract/v1 → 跑本脚本 → 跑 _verify/contract-selftest.js
 */
const fs = require('fs');
const path = require('path');

const FILES = ['errors.json', 'states.json', 'timing.json', 'commands.json'];

/** @param {string} v1Dir contract/v1 目录（含四个 json） @returns {string} data.js 全文 */
function build(v1Dir) {
  const data = {};
  FILES.forEach(function (f) {
    data[f.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(v1Dir, f), 'utf8'));
  });
  const payload = 'module.exports = ' + JSON.stringify(data, null, 2) + ';\n';
  const version = (data.states && data.states.contract_version) || 'unknown';
  const banner =
    '/**\n' +
    ' * 本文件由 tools/gen_contract_data.js 从 contract/v1/{errors,states,timing,commands}.json\n' +
    ' * 确定性生成（contract_version=' + version + '）。禁止手改；改契约流程见 contract/README.md。\n' +
    ' * 运行时不得直接 require .json：小程序运行时支持无保证，且无依赖文件过滤会把它\n' +
    ' * 剔出代码包（2026-11-10 真机事故：t3/t4/t5/t6 整页空白）。\n' +
    ' */\n';
  return banner + payload;
}

function main() {
  const v1Dir = path.join(__dirname, '..', 'contract', 'v1');
  const out = build(v1Dir);
  const target = path.join(v1Dir, 'data.js');
  fs.writeFileSync(target, out, 'utf8');
  console.log('[gen_contract_data] 已生成 ' + target + '（' + out.length + ' bytes）');
}

module.exports = { FILES: FILES, build: build };
if (require.main === module) main();
