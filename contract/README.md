# contract/v1 —— 协议契约镜像（客户端仓）

单一事实源在硬件侧仓 `contract/v1/`，本目录是**逐字节镜像**，供小程序代码与 Node 自测消费。

| 项 | 值 |
| --- | --- |
| contract_version | 1.1-draft（双方 7 条冻结基线全签，2026-11-10） |
| firmware_baseline | 1.3-2ef2a38 / ELF 98f2465cb（2026-11-10 修正，原 9e1d6c5 为陈旧值） |
| 镜像时间 | 2026-11-10 21:1x（自 /home/tc/esp/workspace/iothub/contract/v1 同步：timing 增 client_adv_wait_ms=12000 与 client_link_stale_code——P2-2 契约化），data.js 已重新生成 |

## 同步规则

- **改契约只在硬件侧仓改**，改完同步到本目录（cp 四个 json + 更新本文件的版本/时间戳）；
- 同步后**必须重跑 `node tools/gen_contract_data.js`** 生成 `data.js`——小程序运行时不直接消费 json
  （运行时对 require('.json') 支持无保证 + 「过滤无依赖文件」会把静态分析扫不到的 json 剔出代码包，
  2026-11-10 真机事故：t3/t4/t5/t6 整页空白）。`data.js` 是确定性派生物，禁止手改；
- 客户端代码**只准经 `utils/contract.js` 消费**，不得散落硬编码同一常量；
- 自测 `_verify/contract-selftest.js` 同时校验：契约自洽、data.js 与 json 派生一致（新鲜度）、
  运行时代码无 .json require、客户端实现与契约一致（TIMEOUTS 表、终态集合、瞬态预算）；
- 镜像与源不一致 = 测试红，不许合（Phase 3 CI 闸的客户端半边）。

## 客户端已消费的点（Phase 2）

1. `terminal_states`（含 expired）→ `bmirror.js OP_TERMINAL`、`acceptance.js waitOpTerminal`；
2. `busy/wifi_config_offline/rate_limited` 的 class 与 retry_after_ms → `acceptance.js` 瞬态重试；
3. `wifi.scan_throttle_s=3` 残余冷却（自扫描结束起算，客户端记 scanDoneAt）→ `checkScanRepeat`；
4. `got_ip_semantics` → provision 成功判据与 #13 核验统一为 `internet_verified && mqtt_connected`。
