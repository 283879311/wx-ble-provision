# WIFI-OP-RESOURCE-RACE · 调用关系确认清单（设计前置）

> 文档生命周期：**HISTORICAL**（历史调查材料）。对应缺陷已关闭；本清单仅保留 2026-11-12 设计前置阶段的问题与证据，不再作为当前待办或固件修改授权。

配套文档：[WIFI-OP-RESOURCE-RACE.md](WIFI-OP-RESOURCE-RACE.md)（最终关闭结论见主记录 §11）。
历史状态（2026-11-12）：**待固件侧回答**。当时未批准固件修改。

## 使用方式

- 一问一条，逐条回答；每条必须给出 **文件 · 函数 · 调用者 · 被调用者 · 关键状态变量**，不接受纯口头解释。
- 每条分三栏填写：**已证实**（串口日志可验证）/ **待确认**（读源码才能确定）/ **结论**（对方案 A 的影响）。
- 引用日志时带 boot ms，便于与本文时间线对齐。

## 证据分级

| 级别 | 含义 |
|---|---|
| ✅ 已证实 | 串口日志直接可见，无需源码 |
| ❓ 待确认 | 需源码/调用链才能定论 |
| ⚠️ 待讨论 | 需与客户端侧对齐语义 |

## 时间线基线（已修正）

| boot ms | 事件 | 级别 |
|---|---|---|
| 199641619 | `cmd: rescue=restore_persistent op-5737… (cleanup without commit)` | ✅ |
| 199642589 | `ble_cmd: rx v1 cmd=network.tryconnect id=45` | ✅ |
| 199642609 | `operation: accepted op-1273… owner=1 ttl=45000ms` | ✅ |
| 199645179 | `cmd: async tryconnect op=op-5737… stale after wait (gen=15 state=7), no job touch` | ✅ |
| 199645189 | `operation: run op-1273… -> connecting` | ✅ |
| 199650419 | `wifi:state: run -> init (0x0)` | ✅ |
| 199650419 | `wifi: auto_connect: selected saved profile index=1 ssid=CMCC-502` | ✅ |
| 199650439 | `tryconnect: old disconnect consumed reason=8(ASSOC_LEAVE)` | ✅ |
| 199650449 | `wifi: scan: start failed: ESP_ERR_WIFI_STATE`（预扫描 #1） | ✅ |
| 199650479 | `tryconnect: pre-scan failed (ESP_ERR_WIFI_STATE), one retry in 500ms` | ✅ |
| 199650999 | `wifi:sta_scan: STA is connecting, scan are not allowed!` | ✅ |
| 199650999 | `wifi: scan: start failed: ESP_ERR_WIFI_STATE`（预扫描 #2）+ `abort before connect` | ✅ |
| 199651009 | 新 op 终态（`op_set_state/terminal`） | ✅ |
| 199651029 | `wifi: apply_cfg: ssid='TQ2026'` ← 旧 op 恢复此刻才落地 | ✅ |

**关键间隔**：新 op 受理（199642609）→ 真正启动（199645189）= **2.58s**，这 2.58s 正是旧异步 job 在 `stale after wait` 中挂着的窗口。

---

## Q1 auto_connect 有哪些触发源？

**要回答**
1. 列出所有调用 `auto_connect`（及 `connect_profile`、`fast_path`）的位置：`文件:函数()`。
2. 每个触发源的条件：STA_DISCONNECTED 事件 / 定时器 / profile 切换 / 手动命令。
3. 进入前检查了哪些状态（scan 标志？op 状态？STA 是否 connecting？），变量名是什么。
4. 199650429 那一刻，具体是哪条路径调用了它。
5. `STA down with BLE connected: event-chain retry suppressed; 120s formal-only monitor owns recovery`（199656249）里的 120s monitor 与 event-chain retry 各是什么，归属哪个模块。

**当前证据**
- ✅ `199650419 wifi:state: run -> init`
- ✅ 同毫秒 `auto_connect: selected saved profile index=1 ssid=CMCC-502`
- ✅ 199656249 `STA down with BLE connected: … 120s formal-only monitor owns recovery`

**待确认**
- ❓ 是订阅了 `STA_DISCONNECTED` 事件后立即触发，还是定时器恰好命中。
- ❓ 选择 profile 的依据（index=1）与 `apply_cfg TQ2026` 为什么不一致（见 Q3）。

**对方案 A 的影响**：决定 `AUTO_CONNECT` 状态的入口点，以及"不得抢占 OP_ACTIVE"要加在哪一层。

---

## Q2 pre-scan 从哪里进入？

**要回答**
1. `tryconnect` 预扫描的调用链：`文件:函数()` → scan API，逐层列出。
2. 拆链（`run -> init`）到 `esp_wifi_scan_start` 之间做了什么、间隔多少。
3. 调用 scan 前是否检查 STA 状态；若检查，检查的是什么；若不检查，为什么 500ms 重试仍撞 connecting。
4. `pre-scan failed twice … abort before connect` 的判定位置与计数器。
5. `sta_scan: STA is connecting, scan are not allowed!` 是哪一层打印的（驱动封装 or 业务层）。

**当前证据**
- ✅ 199650449 / 199650999 两次 `scan: start failed: ESP_ERR_WIFI_STATE`
- ✅ 第二次明确 `STA is connecting, scan are not allowed!`
- ✅ 199650479 500ms 后重试

**待确认**
- ❓ 预扫描是否有独立的 ready 条件；失败重试是否只做了时间退避、没做状态等待。
- ❓ `state=7`（Q4）与"connecting"是否同一个状态量。

**对方案 A 的影响**：确定"扫描入口"的仲裁点；若扫描前已有一个 ready 判据，最小改动可以复用它。

---

## Q3 restore_persistent 由谁驱动？apply_cfg 为什么延迟？

> 本项与 Q5 是设计评审的两个关键项：配置源冲突不查清，只修扫描竞争会留下"旧配置覆盖新配置"的隐患。

**要回答**
1. `restore_persistent` 的调用者与执行上下文（cancel handler / 异步 worker / 事件）。
2. `apply_cfg` 的实际执行点：为何直到 199651029（新 op 终态之后 20ms）才落地。
3. `restore_persistent` 是否等待旧 op 的异步 job 退出；等待条件是什么。
4. 当前是否已有"cleanup complete"的可观测判据（日志、状态变量、回调）。
5. **两份配置分别来自哪里**：`apply_cfg` 用的 TQ2026 与 `auto_connect` 选的 CMCC-502，各自的存储位置（NVS？persistent profile？RAM 缓存？）与写入者。
6. **谁拥有配置恢复的最终决定权**：restore_persistent 与 auto_connect 冲突时，优先级由什么决定。
7. **是否可能出现旧配置覆盖新配置**；**`apply_cfg` 是否可能在新 operation 运行期间执行**（本次落在终态后 20ms，需确认是否只是时序巧合）。

**当前证据**
- ✅ 199641619 `rescue=restore_persistent … (cleanup without commit)`
- ✅ 199651029 `apply_cfg: ssid='TQ2026'`
- ✅ 199651409 `fast_path: ssid='TQ2026'`
- ✅ 199661159 `connect_profile: ssid='CMCC-502'`

**待确认**
- ❓ 恢复配置延迟是设计使然（等 worker 释放）还是缺陷（被事件链阻塞）。
- ❓ 两条恢复路径（TQ2026 与 CMCC-502）是否各自独立持有 STA 操作权。

**对方案 A 的影响**：`CANCEL_CLEANUP` 的完成条件就落在这里——这是整个方案的核心判据。

---

## Q4 旧 job 的真正退出条件是什么？

**要回答**
1. `stale after wait (gen=15 state=7), no job touch` 的打印位置。
2. `gen` 与 `state=7` 的含义；"no job touch" 表示不操作 job，还是表示 job 已不可达。
3. 该异步 job 在 199645179 之后是否已销毁；还持有哪些资源（STA 操作权？socket？定时器？）。
4. 新 op 启动（199645189）前是否等待该 job 退出；等待了多久、依据什么。
5. `async tryconnect … stale after wait` 与 `old disconnect consumed`（199650439，晚了 5.2s）之间的因果关系。

**当前证据**
- ✅ 199645179 stale 宣告；10ms 后新 op 启动
- ✅ 199650439 `old disconnect consumed reason=8(ASSOC_LEAVE)` —— 旧链断开事件直到新 op 启动 5.2s 后才被消费

**待确认**
- ❓ stale 之后 job 是否仍在事件队列里；`no job touch` 是否意味着它还会继续持有状态。

**对方案 A 的影响**：决定"新 operation 不得越过 CANCEL_CLEANUP"是等 job 退出、还是等 cleanup 标志。

---

## Q5 是否存在统一 STA 状态机或资源仲裁机制？

**要回答**
1. 是否有封装 STA 状态/操作的模块；`文件:函数()`。
2. 列出所有**直接**调用 `esp_wifi_scan_start` / `esp_wifi_connect` / `esp_wifi_set_config` 的模块。
3. 现有哪些状态变量可复用（如 `sta_connecting`、`scan_active`、`op_owner`），各自由谁写、谁读。
4. 是否已存在互斥/所有权概念（哪怕只覆盖单一路径）。

**当前证据**
- ✅ 日志中出现 `probe first schedule deferred to monitor (gen=35)`、`sta_start_evt gen=35 ignored (probe completed this gen)` —— 说明已有一层 gen/事件消费逻辑。

**待确认**
- ❓ 该 gen 机制覆盖范围（仅 probe？还是覆盖 connect/scan）。
- ❓ 若无统一状态机，最小仲裁应作为独立模块还是嵌在现有封装内。

**边界提醒（评审要求）**
- ⚠️ **generation 防止旧事件污染新操作，不等于资源互斥。** 两者不能混为一谈：gen 能丢弃过期事件，但不能阻止两个主体同时驱动 STA。
- 需要明确 gen 机制目前是否具备这四项能力，缺哪项就必须由仲裁层补：
  1. 异步事件归属（事件属于哪次操作/哪一代）；
  2. 过期事件丢弃；
  3. 操作权交接；
  4. 清理完成确认。

**对方案 A 的影响**：决定是复用现有状态机还是新增轻量仲裁层；这是"最小改动"的边界。

---

## Q6 terminal、cleanup、release 三者在哪里耦合？

**要回答**
1. operation 终态的写入点与通知点：`文件:函数()`。
2. cleanup 与 release 的现有调用位置；是否由终态触发。
3. 三者是否串行；有无完成回调/事件；失败时如何回滚。
4. 若要在执行入口加仲裁，最小插入点是哪一个函数。

**当前证据**
- ✅ 199651009 终态 → 199651029 apply_cfg，顺序固定且间隔 20ms
- ✅ 199650999 `abort before connect` 发生在终态之前

**待确认**
- ❓ 终态是否被当作"资源已释放"使用（若是，这是本次缺陷的核心成因之一）。
- ❓ release 是否幂等、能否被新 op 触发。

**对方案 A 的影响**：给出最小改动落点，以及"终态 ≠ 资源释放"这一语义要在哪里表达。

---

## 回答模板（每条复制填写）

```
Qn：
- 证据（日志行 + boot ms）：
- 文件 / 函数：
- 调用者：
- 被调用者：
- 关键状态变量（名 / 写入点 / 读取点）：
- 已证实：
- 待确认：
- 结论（对方案 A 的影响）：
```

## 设计评审底线（评审硬性条件）

设计方案必须能回答一个核心问题：

> **任何时刻，究竟哪个 operation 拥有 STA 的操作权？**

并且必须逐条证明：

1. 旧 operation 不能在新 operation 启动后继续修改 STA 配置；
2. `auto_connect` 不能绕过资源仲裁；
3. `cancel` 的终态不能冒充 cleanup 完成；
4. cleanup 失败时不能假装资源已经释放；
5. BLE 断开后的正常网络恢复机制仍然有效。

评审取向：优先复用现有机制的最小补丁，不引入新的 Wi-Fi 管理框架。

## 交付要求

1. 六项回答完成后，**先提交最小改动设计**，内容至少包括：
   - 资源所有权定义与持有者；
   - 状态转换（IDLE / OP_ACTIVE / CANCEL_CLEANUP / AUTO_CONNECT）与非法转换处理；
   - 取消与清理时序（谁等谁、超时怎么办）；
   - 失败回滚；
   - 三个竞态验收场景（WIFI-RACE-01/02/03）的判定方式。
2. **未经单独批准，不提交代码修改**；本轮边界仍是"只取证、只设计"。
3. 设计评审通过后，再单独申请烧录与设备操作授权。
