# WIFI-OP-RESOURCE-RACE · 最小设计评审（客户端侧，2026-11-12）

> 文档生命周期：**HISTORICAL**（历史设计/实现评审记录）。最终缺陷状态与设备回归结论以[缺陷主记录 §11](WIFI-OP-RESOURCE-RACE.md#11-关闭记录2026-11-22)为准；本文各轮评审结论按当时上下文保留。

评审对象：`/home/tc/esp/workspace/iothub/docs/WIFI-OP-RESOURCE-RACE-六问回答与最小设计_2026-11-12.md`（A1–A8）
评审依据：缺陷登记 §5 + 五条评审底线
结论：**条件通过——设计方向正确，但有 5 处必须补齐，暂不进入补丁阶段**。

## 0. 复核结论（独立读源码，不采信结论本身）

| 固件侧结论 | 复核结果 |
|---|---|
| `state=7` = `APP_OP_CANCELLED` | ✅ operation_state.h:5-15 枚举顺序为 0..8，7 确为 CANCELLED |
| `s_wifi_op_owner` 仅 NONE/APPLY/TRYX | ✅ wifi.c:90-94 |
| `tryconnect_begin` 在 `s_tryconnect_mux` 内 CAS 取得 TRYX | ✅ wifi.c:262-280 |
| `wait_connect_task_idle` 只等任务指针 | ✅ wifi.c:1400 `return s_wifi_connect_task == NULL;` |
| 预扫描无 STA 状态前置检查、500ms 原样重试 | ✅ wifi.c:3570-3585 |
| `claim_apply` 轮询等 owner 回 NONE（15s） | ✅ wifi.c:2596-2612 |
| `run -> init` 来自 auto_connect 的 disconnect | ✅ 打印顺序可证：`connect_profile_index` 先 disconnect，`selected` 打印在其返回 OK 之后（wifi.c:1183-1186） |

Q1.4（199650429 由哪个调度源创建）：**本批日志无法判定**。七个判别行均未命中（`apply_start_probe` 出现在 +800ms，属恢复链）。见 B5。

## 1. 五条底线逐条判定

| # | 底线 | 判定 | 说明 |
|---|---|---|---|
| 1 | 旧 op 不能在新 op 启动后修改 STA 配置 | **部分满足** | `cleanup_pending` 覆盖 apply 阶段，但见 B1：按 A3 的顺序，新 op 要么拿不到所有权，要么等待必然超时 |
| 2 | `auto_connect` 不能绕过仲裁 | **部分满足** | 执行入口唯一 ✅，但 A1 的 claim 条件只查 `owner==NONE`，漏了 `cleanup_pending`（B2）；另有 9 处直接驱动 STA 的调用点未做覆盖说明（B4） |
| 3 | `cancel` 终态不能冒充 cleanup 完成 | **满足** | 独立 pending 标志 + 终态后置位，符合底线 |
| 4 | cleanup 失败时不能假装资源已释放 | **不满足** | A3 的 20s 看门狗 `清 pending` 与 A4.2 的 `cleanup abandoned` 都等于宣告"资源可用"，而配置并未恢复（B3） |
| 5 | BLE 断开后的正常恢复仍有效 | **满足** | AUTO 只延迟不退出，120s formal-only monitor 不动 |

## 2. 必改点

### B1 所有权与等待顺序矛盾（**最关键**）

A3 的顺序是：`begin(claim TRYX) → wait_sta_quiescent → wait_cleanup_complete → 预扫描`。
但 cleanup 的完成依赖 `apply_cfg`，而 `apply_cfg` 必须拿到 `APPLY`，即 `owner==NONE`（wifi.c:2596-2612）。

于是只要新 op 先 claim 到 TRYX：
- `wait_cleanup_complete(5s)` 必然等不到（APPLY 被 TRYX 挡着）→ 超时返回 `wifi_config_offline`；
- 或者 apply 先 claim，`tryconnect_begin` 直接失败返回 `busy`，新增的等待代码根本走不到。

两条路都**到不了 A3 设计的成功路径**（等到 cleanup 完成后正常预扫描）。这不是参数问题，是所有权顺序问题。

建议（与"最小改动"一致，反而更少代码）：**把 CANCEL_CLEANUP 做成 owner 的一个值**，而不是与 owner 并列的标志。

- `owner = CLEANUP`：cleanup 开始时取得，`apply_cfg` 在 CLEANUP 所有权内执行，结束（含放弃）时释放；
- TRYX / AUTO / APPLY 一律 `claim` 失败即等 `owner==NONE`（复用现有 `claim_apply` 的等待原语）；
- 新 op 的等待从"两个等待"减为"一个 owner 等待"，`cleanup_pending` 不再需要单独维护；
- 死锁消失：谁都不会在自己持有时等对方释放。

若坚持保留 `cleanup_pending` 标志，则必须把等待放在 claim **之前**（`wait pending clear && owner==NONE` → 再 claim），并删除 claim 之后的 5s 等待。二者择一，不能同时保留。

### B2 `claim_auto` 必须同时检查 `cleanup_pending`

A1 表写的是 `CAS: owner==NONE`。CANCEL_CLEANUP 状态下 owner 可为 NONE，此时 AUTO 能顺利 claim —— 正是原始竞态的复现路径。A6 只给 `connect_task_fn` 加了 `!cleanup_pending` 复核，但 `connect_best_saved_profile` 的 claim 也要带这个条件，否则二次检查与 claim 之间仍有窗口。

### B3 看门狗与 abandoned 不能静默宣告释放

- A3：`cleanup_pending stuck >20s → 清 pending`；
- A4.2：`claim_apply 15s 超时 → 清 pending + 记 cleanup abandoned`。

两者都让后续主体看到"资源可用"，但配置实际未恢复。至少需要：

1. 清 pending 时置一个 **`cleanup_failed`** 终态标志（不是回到正常）；
2. 新的 op 遇到 `cleanup_failed` 时返回**独立错误码**（不得复用 `wifi_config_offline`，后者语义是"稍后就好"）；
3. 该标志只有"下一次 apply 成功"或"显式重配"才清除；
4. 日志必须带 `op_id` 与失败原因，便于现场定位。

否则底线 4 不成立，只是把 20s 前的问题推迟到 20s 后。

### B4 9 个直接驱动 STA 的调用点需要覆盖表

Q5 列了 9 处 `esp_wifi_disconnect/set_config/connect`，A6 只改 2 个函数。请补一张表：每一处 → 由哪个 owner 保护 / 为什么不可能在他人持有时执行（例如 BLE 连接态抑制、只在 TRYX 内部调用等）。

至少需要明确：`event_handler` 的 `retry_direct`（wifi.c:2157）与 `netcheck_on_result`（:2352）在任何 owner 下都可能被事件触发，若不在保护范围内，底線 2 仍有缺口。

### B5 A8 从"可选"升为"必需"

Q1.4 已经证明：现场无法从日志判定 auto_connect 的调度源。`schedule_connect_task(delay, caller)` + `scheduled by <caller>` 是本次评审唯一无法用源码替代的观测手段。建议随 B1 同批实施，否则修复后再次出现"谁先动手"的争议时仍无证据。

## 3. 建议（非阻断）

- **S1**：RACE-03 判据从"apply_cfg 先于 auto connect"改为"**CANCEL_CLEANUP 期间无任何 STA 发起操作**，结束后首条 STA 操作来自谁都可以"。顺序断言在 profile 切换时可能误判。
- **S2**：`wait_sta_quiescent(8s)` 与 `wait_cleanup_complete(5s)` 若按 B1 合并为 owner 等待，两个魔数可减为一个（建议 8s，覆盖 apply 尾段），少一个超时分支。
- **S3**：A6 里 `tryconnect` 超时返回 `BUSY` 的分支，客户端会按 transient 重试（`TRY_TRANSIENT_CODES` 含 `busy`），语义可接受；但 #12 的期望终态仍应是 `ap_not_found`，请在 RACE-02 判定里写明"不得以 busy 收尾"。

## 4. 结论

- 设计**方向**（单一所有权、终态≠释放、auto 只延迟不取消）通过。
- 设计**落地**在 B1 处存在自相矛盾，B2/B3/B4 是底线缺口，B5 是可观测性缺口。
- 补齐 B1–B5 后再评审一轮；**本轮不批准代码修改，不批准烧录/设备操作**。
- 客户端侧维持现状：#12 仍记 `failed/wifi_scan_failed`，不重跑；证据与时间线以缺陷登记为准。

---

## 5. 项目裁决（2026-11-12）

| 项 | 裁决 |
|---|---|
| B1 | **P0 阻断**。采纳"`CANCEL_CLEANUP` 成为 owner 正式枚举值"；`apply_cfg` 作为 cleanup 内部子阶段，不释放外层所有权、不再单独 claim APPLY；新 op 只等 `owner==NONE` |
| B2 | **P0 阻断**。`claim_auto` 必须检查完整仲裁状态（owner 四值 + pending + failed）；最终目标是让 `cleanup_pending` 不再承载第二套所有权语义 |
| B3 | **P0 阻断**。新增 `CLEANUP_FAILED`：超时/放弃不得转 NONE，auto 不得抢占，新 op 不得绕过，需独立恢复入口与独立错误码 |
| B4 | **P0 阻断**。9 个 STA 驱动调用点逐一提交覆盖表（模板见 §6） |
| B5 | **P1 阻断验收**。caller 标签升级为必需；在**调度发生时**记录，覆盖 BLE 恢复、event-chain retry、120s monitor、`auto_connect_resume`、`schedule_connect_task(400ms)` |

补充原则（写入验收矩阵）：

> owner 的释放必须发生在异步任务真正退出、或其后续 STA 操作已被可靠禁止之后。
> 不能因为函数返回、operation 状态改变或 generation 过期就认定资源已释放。

### 设计验收矩阵

| 要求 | 必须证明 |
|---|---|
| B1 | cleanup 能持有资源并完成 apply，不产生自锁 |
| B2 | auto_connect 无法绕过 cleanup 状态 |
| B3 | cleanup 失败不会错误释放资源 |
| B4 | 全部 9 个 STA 驱动调用点均受仲裁 |
| B5 | 每次自动连接调度均可追溯 caller |

### 下一轮交付物（仅两份）

1. 修订后设计文档（完整覆盖 B1–B5）；
2. 四路径调用关系图——补齐 9 个驱动调用点，标出 owner 取得/持有/交接/释放与异步任务真正退出的位置。

不重交六问结果，不重跑 #12。

## 6. 9 个 STA 驱动调用点覆盖表（待固件侧填写）

| # | 调用点（wifi.c） | 触发来源 | 执行上下文 | 现有 owner 检查 | 修订后归属 | 失败处理 |
|---|---|---|---|---|---|---|
| 1 | `connect_profile_index` :939/942/960 | 待填 | 待填 | 待填 | 待填 | 待填 |
| 2 | `connect_best_saved_profile` :1035/1036/1050 | 待填 | 待填 | 待填 | 待填 | 待填 |
| 3 | `retry_with_pmf_required` :1520/1526 | 待填 | 待填 | 待填 | 待填 | 待填 |
| 4 | `event_handler retry_direct` :2157 | 事件触发 | 待填 | 待填 | 待填 | 待填 |
| 5 | `netcheck_on_result` :2352 | 事件/结果触发 | 待填 | 待填 | 待填 | 待填 |
| 6 | `apply_cfg` :2999 | 待填 | 待填 | 待填 | 待填（B1：cleanup 内子阶段） | 待填 |
| 7 | `perform_scan_impl` :3426 | 待填 | 待填 | 无（预扫描无状态检查） | 待填 | 待填 |
| 8 | `tryconnect_finish` :3498/3501 | 待填 | 待填 | 待填 | 待填 | 待填 |
| 9 | `try_connect_common` :3661/3679/3688 | 待填 | 待填 | 待填 | 待填 | 待填 |

要求：不能用"上层函数已检查 owner"代替逐点证明；每个点必须给出源码位置与 owner 取得/释放的对应关系。

## 7. 证据存档

```
docs/evidence/WIFI-OP-RESOURCE-RACE/
    c8e4-12-serial.log     (973 行, 只读)
    SHA256SUMS             (3415217d163e623e07d9ac0cb92eee33b84899f5c778cf7ab00bdd25322f034f)
```
原始日志未过滤、未删行；后续设计验收与回归复用同一份证据。

---

## 8. 第二轮评审（修订设计 B1–B5 + 四路径图）

对象：
- `WIFI-OP-RESOURCE-RACE-修订设计_B1-B5_2026-11-12.md`
- `WIFI-OP-RESOURCE-RACE-四路径调用关系图_2026-11-12.md`

### 8.1 逐项判定

| 要求 | 判定 | 依据 |
|---|---|---|
| B1 无自锁、无窗口 | **满足** | `release_or_handover(from)` 在同锁内检查 `s_cleanup_requested` 直接移交；`apply_cfg` 全程在 CLEANUP 内、不再 claim APPLY；新 op 只等一个 owner（8s）。四路径图 §7 的 t0–t8 与源码调用顺序一致 |
| B2 auto 无法绕过 | **满足** | claim 矩阵四值 + CLEANUP_FAILED；`cleanup_pending` 删除，不再有第二套所有权语义 |
| B3 失败不误释放 | **满足（附条件）** | CLEANUP_FAILED 粘性、独立 wire 码 `cleanup_failed`（契约 op_terminal/check_device，语义相符）；条件见 8.3 |
| B4 9 点全覆盖 | **满足** | 覆盖表 9 行逐点给出触发来源/上下文/归属/失败处理；四路径图 §6 与 §2–§5 的 `(n)` 标注能对上 |
| B5 调度可追溯 | **满足** | 接口改为 `schedule_connect_task(delay, caller)`，**创建任务前**打印（含被拒分支），8 个 caller 覆盖评审五类 |

Q1.4 推断：方向可信，但存在一处时序不自洽，见 8.4。

### 8.2 新增阻断项（必须在修订版闭环）

**C1（P0）· AUTO 可能饿死 TRYX，缺优先级规则**

`claim_owner(TRYX, 8s)` 只接受 `owner==NONE`，而 AUTO 是非阻塞 claim + monitor 每 1s 重试。若 AUTO 在 TRYX 每次轮询的间隙反复取得 NONE（profile 扫描、PMF 重试、netcheck 拆链都可能短持有），TRYX 可能整整 8s 拿不到所有权，最终以 `busy` 收尾——RACE-02 要求的"最终 ap_not_found"就不可达。

设计必须定义**等待者优先**：例如存在 TRYX waiter 时 `claim_owner(AUTO,0)` 直接拒绝（置 pending），直到 TRYX 取得或放弃。仅靠"互斥"不足以保证进展性。

**C2（P1）· `cleanup_request()` 的 notify 失败无回退**

owner==NONE 时直接置 CLEANUP 并 notify restart 任务。若 notify 丢失或任务尚未建好，owner 会永久停在 CLEANUP：新 op 每次等 8s 后 `busy`，AUTO 永久被拒，且没有任何日志能区分"正在清理"与"通知丢了"。

需要：notify 失败即回退 NONE 并返回 false（operation 记 `cleanup_failed`）；或 restart 任务改为带超时的自轮询。同时在 owner 迁移日志里区分"取得"与"被唤醒"。

**C3（P1）· 事件旁路被拒后的恢复路径要写实**

- #3 `retry_with_pmf_required` 被拒 → 注释写"交 monitor"，但 monitor 只试 **formal-only**，PMF 强制且只在 profile 里的网络可能整轮连不上；
- #5 `netcheck_on_result` 被拒 → 跳过拆链，坏链路可能被保留到下一次判决。

两处都要写出"被拒后由谁在多久内接续"，否则等于把问题从 tryconnect 挪到了恢复路径。

### 8.3 B3 代价的评审意见

接受 CLEANUP_FAILED 的粘性语义——"失败不得假装释放"优先于可用性。附三个条件：

1. `config.set` 恢复入口必须不依赖 STA（BLE 命令 + effect=reboot），且要有明确文档；
2. 进入/离开 CLEANUP_FAILED 必须各有一条带 `op_id` 的日志（设备离线时 MQTT 不可用，日志是唯一现场证据）；
3. 三次重试的间隔（1/2/4s）与既有 `recover_from_apply_failure` 的 LKG/DHCP 链不冲突——需在实现时确认总时长不超过 op TTL（45s）。

### 8.4 Q1.4 推断的两处待对齐

修订设计称"finish 在其前，400ms 后任务创建 ≈1996455xx"，又称"新 op 的 `wait_connect_task_idle` 自 199645189 起等待，199650429 才返回"。两者不能同时成立：若任务 1996455xx 才创建，199645189 的那次等待应立刻返回。

可能解释有二：等待真正开始的时间晚于 `operation: run` 行（run 与 try_connect 之间有其它准备），或任务创建早于 199645190。请在下一版把这条推断的措辞改为可自洽的表述，或直接标注"待 B5 日志闭环"。**不影响设计评审结论**。

### 8.5 结论

- 设计 **通过**（B1–B5 满足评审矩阵）。
- 新增 **C1（P0）+ C2/C3（P1）**，需在进入补丁前闭环；C1 是进展性问题，不是实现细节。
- 仍未批准：代码修改、竞态验收代码、烧录、设备重启与配置变更。
- 下一轮只需提交：C1–C3 的修订说明（可附在修订设计末尾）+ B5 日志格式样例，不需要重交全量文档。

---

## 9. 第三轮评审（§11–§13 + B5 样例）

### 9.1 C1–C3 判定

| 项 | 判定 | 说明 |
|---|---|---|
| C1 TRYX 等待者优先 | **通过** | `s_tryx_waiter` 先置位再轮询；AUTO 取得点与 `schedule_connect_task` 入口统一前置检查；超时 12s 与 cleanup 6.5s 预算有 ≥5.5s 余量。进展性问题解决 |
| C2 notify 回退 + 看门狗 | **通过** | 创建失败同步回退 NONE 并返回 false；12s re-notify、25s 强制 FAILED 作为兜底，与 6.5s 正常预算不冲突 |
| C3 事件旁路接续 | **通过** | PMF pending 由下一次 AUTO 以 `fast_path + pmf.required=true` 消费（目标同为 `s_config.sta_ssid`，接得住）；netcheck teardown pending 由 monitor 每拍执行，gen 变化即失效 |
| B5 样例 | **通过** | 调度时刻打印、被拒分支、owner 迁移、waiter 字段齐备；样例明确标注"非设备实录" |

### 9.2 D1（必须修正）· §5 与 §11.4 自相矛盾

- §5（第 126 行）："`apply_cfg` 的既有恢复链（LKG→DHCP→离线）在每次尝试内部保持不变"；
- §11.4.3："cleanup 路径**不调用** LKG→DHCP 救援链……三次直连重试失败即 FAILED"。

两句话不能同时成立，且这是行为差异最大的一个决定（决定 CLEANUP_FAILED 的触发概率）。修订版必须二选一，并在 §5 同步改掉旧表述。

补充一个有利于该取舍的事实，请在修订里写明：`apply_cfg` 的 A8 只等 `STA_START`，而 `STA_START` 在**发起连接时**就会触发，与目标 AP 是否在场无关。因此"旧 SSID 的 AP 已消失"**不会**导致 `apply_cfg` 失败，`CLEANUP_FAILED` 只会由 set_config/start 这类真正的配置失败触发。把这一点写清，"不跑 LKG/DHCP"的取舍才站得住；否则会被读成"旧 AP 不在就锁死设备"。

### 9.3 两项实现约束（记录，不阻断）

- **R1 原子性**：`s_tryx_waiter > 0` 的判断与 `owner` 的 CAS 必须在**同一临界区**（`s_tryconnect_mux`）内完成，否则仍存在"检查通过→AUTO 插入→TRYX 落空"的窄窗口。§11.1 的措辞是"统一前置"，实现时请确认是同一把锁。
- **R2 恢复延迟**：TRYX waiter 最长 12s，期间 `sta_disconnected_ble` 的 250ms 恢复路径同样被拒。BLE 断开后的 Wi-Fi 恢复最坏延后 12s。这是可接受的（用户正在主动配网），但需写入 §10 遗留风险，避免以后被当成新缺陷。

### 9.4 结论

- 设计**通过**，C1–C3 闭环；仅剩 **D1（文档矛盾 + 取舍依据）** 必须修正。
- D1 修完即可提交补丁代码申请；**本轮仍未批准代码、竞态验收代码、烧录、设备重启与配置变更**。
- 下一轮交付：修订设计 §5 与 §11.4 的统一表述（一页以内即可），不需要第三次全量评审。

---

## 10. 第四轮评审（D1 修正核验）与设计签收

### 10.1 D1 核验：已修正

- §5 第 126-128 行：改为"cleanup 路径不调用 LKG→DHCP→离线救援链"，并指向 §14；
- §6-6：触发来源列改为"LKG/DHCP 救援链（仅 config apply 路径，cleanup 不走）"，失败处理写明"仅直接 apply_cfg×3"；
- §10 风险 1：已含 R1（同临界区）与 R2（≤12s 恢复延后，列为已知代价）；
- §14：新增唯一版本表述 + 三条理由 + 影响面表。

结论：全文口径一致，D1 关闭。

### 10.2 剩余一处数值漂移（补丁提交前必须统一）

`§0 摘要` / `§5 伪代码` 仍写 **1s / 2s / 4s** 退避；
`§5 正文` / `§14.1` / `§11.1.6` 写 **0.5s / 1s / 2s**。

这不是文字问题：按 1/2/4 算，CLEANUP 最坏 = 3×1 + 7 = **10s**，"≤6.5s、余量 ≥5.5s"的保证不成立（余量只剩 2s，已逼近 12s 上限）。请统一为 0.5/1/2 并把伪代码改掉；若有意改为 1/2/4，则 TRYX 等待需重新上调。

### 10.3 设计签收

**设计评审通过。** 结论仅覆盖设计文档，不含任何代码。

补丁代码申请需要包含（缺一不可）：

1. diff 范围：文件、函数、行数（预期 wifi.c + cmd.c，~110–140 行）；
2. B1–B5 + C1–C3 的实现点对照表（评审编号 → 函数 → 行为）；
3. 明确"不触碰"清单：operation 状态机、错误码契约、扫描重试策略、auto_connect 开关、120s BLE 恢复路径；
4. 编译零告警 + 现有自测通过；
5. RACE-01/02/03 的复现步骤与串口判据（沿用 §8 表）；
6. 回滚方案：单 commit 可 revert、无 NVS/配置迁移、回滚后老固件行为不变。

烧录与设备操作需**单独**授权，且需要窗口约定：设备可能进入 CLEANUP_FAILED（Wi-Fi 离线至重配+重启）、全程串口采集、不与验收并发。

---

## 11. 补丁代码申请 · 批准记录（2026-11-12）

对象：`/home/tc/esp/workspace/iothub/docs/WIFI-OP-RESOURCE-RACE-补丁申请_2026-11-12.md`

**决定：有条件批准代码修改。** 烧录/重启/配置变更仍不批准。

核验结果：退避已在 §0/§5/§14 统一为 0.5/1/2s（≤6.5s 成立）；六项材料齐备；13 个函数、净 +175 行与 C1–C3 的增量来源一致。

四项前置条件：

| # | 条件 | 原因 |
|---|---|---|
| P1 | owner 状态机抽成**纯逻辑**并纳入主机自测，+12 例从"建议"改为"必交" | R1（waiter 判断与 CAS 同临界区）无法靠 review 保证；至少要覆盖：waiter 置位期间 AUTO 被拒、requested 置位时的 handover、CLEANUP_FAILED 粘性、非法迁移拒绝 |
| P2 | 事件路径与 monitor 的拒绝日志**限流** | TRYX 等待 12s 期间 monitor 每秒一条 `schedule refused`，再加事件旁路，会淹没串口；按 caller+reason 变化打印或 ≥2s 限流 |
| P3 | `network.scan` 的 owner-busy 语义要与"扫描节流 busy"区分 | 客户端把 scan 的 `busy` 当节流处理（等 3s 残冷），不按运态 busy 的 1.5s；#4 连扫时可能空转。建议 owner-busy 改用契约里现有的 `conflict`（transient/1s），或证明 3s 等待不突破扫描预算 |
| P4 | R2 纳入真机验证清单 | 补丁后需实测：TRYX 结束后 BLE 断连，Wi-Fi 恢复 ≤12s+1s；否则 R2 只是文档承诺 |

另外：**合并前提交实际 diff 供评审**，不以自测报告代替。

批准范围内的动作：改码、编译、主机自测。范围外：竞态验收脚本、烧录、重启、配置变更。

---

## 12. 实现评审（patch 1deb26a3…，2026-11-12）

对象：`artifacts/wifi_op_race_20261112/wifi_op_race.patch`（10 文件，+1120 / −70）

### 12.1 独立复核（我自己跑的，不采信报告）

| 项 | 结果 |
|---|---|
| `git diff --check` | 通过 |
| `tests/wifi_owner` 重新编译（`-Wall -Wextra -Werror`）并运行 | **40 passed, 0 failed** |
| 变更文件清单 | 与申请一致（`wifi_op_owner.*`、`tests/wifi_owner`、`wifi.c`、`cmd.c`、`wifi.h`、`CMakeLists.txt`、docs），无夹带 |
| 契约/operation 状态机 | 未改动（`contract/`、`operation.c`、`operation_state.*` 无 diff） |

### 12.2 关键实现核对

- **B1**：`app_wifi_owner_step()` 的 `RELEASE_*` 在 `cleanup_requested` 为真时直接转 CLEANUP（`ACT_HANDOVER`），无 NONE 窗口；`tryconnect_finish` 的 `disconnect + restore set_config` 在 `tryconnect_release()` **之前**；`apply_cfg` 全程在 CLEANUP 内；APPLY 路径的 LKG/DHCP 链保留未动。
- **B2**：AUTO 取得点唯一在 `connect_best_saved_profile` 包装层，claim 检查 owner 六值；`cleanup_pending` 已删除。
- **C1**：`claim_tryx` 先置 waiter 再轮询，`step_locked` 与 waiter 同临界区；AUTO 判定顺序为 `CLEANUP_FAILED → owner 忙 → waiter`，与设计一致。
- **C2**：`cleanup_request` 在唤醒失败时 `CLEANUP_DONE` 回退 NONE 并返回 false；monitor 12s re-notify / 25s 强制 FAILED。
- **C3**：PMF 被拒置 pending、下一次 AUTO 以 `force_required` 消费；netcheck 被拒置 `teardown+gen`，monitor ≤1s 执行、gen 变化清除、>10s 告警——三处 claim/release 均成对。
- **B5**：8 个 caller 全部就位（`tryconnect_finish` 在 `tryconnect_release` 后 400ms 调度并带标签），**创建任务前**打印；被拒分支带 reason；另加 `pmf_pending` 第 9 个调度点。
- **P3**：命令扫描 `claim AUTO` 失败 → `conflict`，**不**打 3s 节流戳；节流拒绝仍是 `busy`。
- **扫描归属**：`perform_scan()` 三个调用点分别在 AUTO（profile 分支）与 TRYX（预扫描 ×2）持有期内，无"无主扫描"。

### 12.3 三项问题

**M1（建议提交前修，一行）· `s_wifi_pmf_force_required` 在 `set_config` 失败时泄漏**

`fast_path` 分支里该标志只在 `esp_wifi_set_config` 成功后清除（wifi.c:1345）。若 `set_config` 失败，标志保持为真，且此时 PMF pending 已在消费时清掉、30s 过期也管不到它——下一次**无关**的 fast_path 会被强制 `pmf.required=true`。

修法：`set_config` 失败分支一并清掉（配合设计里"失败再给一次机会"应由 pending 承担，而不是让一次性标志无限续命）。

**M2（二选一）· 申请里承诺的扫描 owner 断言未落地**

申请 §1 写 `app_wifi_perform_scan_impl()` 有"owner 断言/日志 +4 行"，patch 里该函数体只有原有的 scan 失败/超时日志，没有任何 owner 检查。当前三个调用点都有人持有 owner，所以不影响行为；但这是将来新增调用者的护栏。
要么补上（推荐：`owner ∈ {TRYX, AUTO}` 不满足时 `ESP_LOGE` 并继续），要么把申请表里那 4 行删掉，别留悬空承诺。

**M3（记录，不修）· 两处日志读取在锁外**

`app_wifi_owner_log_transition()` 与 `scheduled ... owner=NONE` 的字段在解锁后读取/硬编码；并发下日志可能显示陈旧的 waiter/requested 值。仅影响日志可读性，不影响仲裁。

### 12.4 结论

- **实现评审通过**：允许提交 commit（未批准烧录）。
- 条件：M1 提交前修掉；M2 二选一；M3 记录即可。
- 提交后请提供 commit sha 与 amend 后的 patch sha256，我按同一路径复核一次，然后才进入烧录申请。

---

## 13. 实现评审第二轮（commit 后复核）

本节是 2026-11-12 评审阶段预留的回填位置，后续关闭结果已统一归档在[缺陷主记录 §11](WIFI-OP-RESOURCE-RACE.md#11-关闭记录2026-11-22)。本节不再表示当前仍等待提交或复核。
