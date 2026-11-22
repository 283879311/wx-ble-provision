# 缺陷登记：WIFI-OP-RESOURCE-RACE

> 文档生命周期：**CURRENT**（已关闭缺陷的当前权威记录）。缺陷状态以 §11 关闭记录为准；前序章节保留发现、分析与修复过程，不作为当前执行步骤。


**Tryconnect 预扫描与 Auto Connect 争抢 STA 资源，旧 Operation 清理未完成即接受新 Operation**

| 项 | 内容 |
|---|---|
| 缺陷号 | `WIFI-OP-RESOURCE-RACE` |
| 类别 | Wi-Fi 资源交接 / 生命周期并发 |
| 状态 | **已关闭（2026-11-22）**：修复 `185e029`/`dc254d5` 已入 `1.3-1ff92db`；RACE-01/02/03 与 #12 设备回归 PASS（证据见 §11） |
| 发现 | 2026-11-12 |
| 设备 | IotHubBLE-C8E4 · B0:A7:32:28:C8:E6（调试口 `/dev/ttyUSB1`） |
| 固件 | 1.3-2ef2a38（build_sha 98f2465cb） |
| 入口用例 | T4 #12 `operation 语义` |
| 复现 | **2/2**（23:10 轮 9329ms、本轮回 9569ms，终态均为 `failed/wifi_scan_failed`） |
| 证据 | `docs/evidence/WIFI-OP-RESOURCE-RACE/c8e4-12-serial.log`（973 行，boot ms 199574349–199861479，只读存档）· SHA256 `3415217d…f034f` · 校验见同目录 `SHA256SUMS` |

## 1. 现象

`cancel` 后立即发起的新 `tryconnect` 被正常受理，随后终态为 `failed/wifi_scan_failed`，期望 `failed/ap_not_found`。目标 SSID 为 `__ble_selftest_absent__`（不存在），因此**目标不存在不是失败原因**——预扫描从未获准启动。

## 2. 复现步骤

1. 设备处于 `sta` 模式、DHCP、已配网（本次为 CMCC-502 / TQ2026 双 profile 共存状态）。
2. 手机连上设备并登录。
3. T4 功能自检 → 第 12 项 `operation 语义` → 单项运行。
4. 同步抓调试口串口（115200 8N1）。

## 3. 根因（两个层面，同一缺陷下的两个修复点）

### 3.1 直接触发：auto_connect 抢占 STA

| boot ms | 事件 | 结论 |
|---|---|---|
| 199650419 | `wifi:state: run -> init` | **auto_connect 的 `esp_wifi_disconnect()`**（`connect_profile_index` wifi.c:939）——预扫描不拆链 |
| 199650429 | `auto_connect: selected saved profile index=1 ssid=CMCC-502` | 该打印在 `connect_profile_index` 返回**之后**（wifi.c:1183-1186），是事后标记，不代表此刻才开始 |
| 199650439 | `tryconnect: old disconnect consumed reason=8(ASSOC_LEAVE)` | 旧链断开事件此时才被消费 |
| 199650449 | `wifi: scan: start failed: ESP_ERR_WIFI_STATE` | 预扫描 #1 未获准启动 |
| 199650999 | `wifi:sta_scan: STA is connecting, scan are not allowed!` | 预扫描 #2 被明确拒绝 |
| 199650999 | `tryconnect: pre-scan failed twice (ESP_ERR_WIFI_STATE), abort before connect` | 终态来源 |

要点：
- 扫描代码本身不一定有问题；`ESP_ERR_WIFI_STATE` 是状态机拒绝。
- 500ms 重试无效：重试时 STA 仍处于 connecting。
- `wifi_scan_failed` 是最终状态，**不是准确的根因分类**。

### 3.2 深层问题：旧 op 清理与新 op 生命周期重叠

| boot ms | 事件 |
|---|---|
| 199641619 | 旧 op 开始 `restore_persistent`（cleanup without commit） |
| 199642609 | 新 op 被受理 |
| 199645189 | 新 op 异步任务真正启动 |
| 199650419 | STA 被拆（run -> init）——由 auto_connect 发起，非新 op |
| 199651009 | 新 op 终态 `wifi_scan_failed` |
| 199651029 | **旧 op 的 `apply_cfg: ssid='TQ2026'` 才落地** |

旧 operation 的恢复动作直到新 operation 结束后才执行。`cancelled` 只代表 operation 终态，**不代表 Wi-Fi 资源已释放**；当前缺少独立的 cleanup 完成边界。

另：恢复路径存在两个主体——`restore_persistent`（apply_cfg TQ2026）与 `auto_connect`（saved profile CMCC-502），二者在本次日志中先后介入同一段 STA 状态。

## 3.3 证据注记（2026-11-12 固件侧源码复核）

- `199650419 run -> init` **不是**新 op 为扫描拆链——预扫描（`perform_scan_impl`）直接调 `esp_wifi_scan_start`，不做 disconnect；该行来自 auto_connect 的 `connect_profile_index`（wifi.c:939）。即 **auto_connect 先动手，预扫描才被挡**。
- `auto_connect: selected saved profile …` 打印在 `connect_profile_index` 返回 OK **之后**（wifi.c:1183-1186），是事后标记，**不能用来判定 connect task 的启动时刻**。
- `state=7` 是 operation 状态机的 `APP_OP_CANCELLED`（operation_state.h:5-15），**不是** STA 的 connecting；两者只是恰好同窗出现。
- 旧 job 侧必须区分两件事，不能混为一谈：
  1. **job 本身**：`no job touch` 表示该路径早退、不写回（cleanup 已 `clear_job`），job 已释放，不再触碰 `s_net_async`/`s_net_trial`；
  2. **恢复链副作用**：`tryconnect_finish` 仍会执行 `auto_connect_resume()` + `schedule_connect_task(400ms)`，**会改变后续 Wi-Fi 行为**。
  即："旧任务没有再碰 job" ≠ "恢复链没有后续影响"。
- Q1.4（199650429 那一发由哪个调度源创建）**无法从本批日志判定**：七个判别行均未命中，`apply_start_probe` 在 +800ms 才出现且属恢复链。需 `schedule_connect_task(delay, caller)` 加标签后才能定案。

## 4. 影响

- 取消操作后立刻发起新连接（客户端重试、用户改网）会以 `wifi_scan_failed` 失败，且码义误导为"扫描失败"。
- 旧配置恢复可能落在新 op 之后，存在把新 op 结果覆盖掉的窗口。
- 与 BLE 侧无关；链路全程健康（测试前 `conn=1 adv=0`，heap 31KB 余量，非资源耗尽）。

## 5. 修复方案 A（批准进入设计，未批准实施）

在现有架构上增加轻量 STA 操作仲裁，不引入新框架、不大规模重构。

> 固件侧已交付落地草案（六问回答 + A1–A8）：`/home/tc/esp/workspace/iothub/docs/WIFI-OP-RESOURCE-RACE-六问回答与最小设计_2026-11-12.md`。评审意见见本仓 `docs/WIFI-OP-RESOURCE-RACE-设计评审_2026-11-12.md`。

状态：

| 状态 | 含义 |
|---|---|
| `IDLE` | 无独占 STA 操作 |
| `OP_ACTIVE` | 新 operation 正在使用 STA |
| `CANCEL_CLEANUP` | 旧 operation 正在恢复配置、释放资源 |
| `AUTO_CONNECT` | 后台自动连接正在执行 |

规则：

1. 同一时间只允许一个主体持有 STA 操作权。
2. `AUTO_CONNECT` 不得抢占 `OP_ACTIVE`。
3. 新 operation 不得越过 `CANCEL_CLEANUP`。
4. `restore_persistent` 的配置恢复必须在资源交接完成之前执行。
5. operation 终态与资源释放状态必须分开表达（新增 cleanup 完成条件，不以终态代替）。

流程：

```
旧 op → cancel → CANCEL_CLEANUP
                    ├─ 停止旧异步任务
                    ├─ 恢复 persistent 配置
                    └─ 释放旧 STA 操作权
                          ↓
                    cleanup complete
                          ├─→ 允许新 op 执行
                          └─→ 允许 auto_connect 执行
```

新 operation 可提前**受理并排队**，但不得在旧资源未交接时进入实际 Wi-Fi 执行阶段。保留现有 operation 接口与异步 worker，只在执行入口加仲裁。

## 6. 三个必须避免的修复陷阱

1. **只加 `scan_active` 标志**——不够。auto_connect 可能在标志置位前已进入 connecting；仲裁必须在**连接启动入口**，不只是扫描入口。
2. **`cancel` 返回 `cancelled` 就放行新 op**——不够。本日志证明恢复配置可能晚于新 op 终态；cleanup 完成必须纳入交接条件。
3. **直接取消 auto_connect**——不可。它是正常恢复机制；只可延迟调度，不可削弱功能。

## 7. 验收场景（建议新增，未批准实施）

| 编号 | 操作 | 预期 |
|---|---|---|
| WIFI-RACE-01 | auto_connect 与 tryconnect 同时触发 | 不允许两个主体同时操作 STA |
| WIFI-RACE-02 | cancel 后立即发起新 tryconnect | 新 op 等待旧 cleanup 完成 |
| WIFI-RACE-03 | cancel 恢复配置与 auto_connect 同时触发 | 配置恢复完成后才允许自动连接 |

保留原 #12 判定不变：目标 SSID 不存在；两次预扫描必须真正开始并完成；应得到空扫描结果而非 `ESP_ERR_WIFI_STATE`；最终错误来自实际的网络发现/连接结果，而非资源竞争。

## 8. 待固件侧确认的调用关系（设计前置）

1. `auto_connect` 的触发源（STA_DISCONNECTED 事件 / 定时器 / profile 切换），是否检查 scan 与 op 状态。
2. `tryconnect` 预扫描入口：拆链后是否立即调用 scan、有无前置状态检查与重试。
3. `restore_persistent` 的驱动者与 `apply_cfg` 的执行时机，是否与 operation 终态解耦。
4. 旧 op 的异步 tryconnect job（本次 `stale after wait, no job touch`）的取消与退出条件。
5. 是否存在统一的 STA 状态机封装；哪些模块直接调用 `esp_wifi_*`。
6. 现有 terminal → cleanup → release 的耦合点，确定仲裁最小插入位置。

## 9. 边界

- 未修改、未烧录固件；未重启设备；未改设备配置。
- 未修改 `wifi_scan_failed` 错误分类、扫描重试策略、cancel/cleanup 逻辑、错误码契约。
- 客户端仅修改了 #12 的串口取证提示文案（见 §10）。

## 10. 客户端取证文案（已批准并实施）

`utils/acceptance.js` #12 失败分支的 grep 提示改为按序给出：

```
ESP_ERR_WIFI_STATE / STA is connecting, scan are not allowed / pre-scan failed
auto_connect: selected saved profile / wifi:state: run -> init
restore_persistent / apply_cfg
```

旧关键词（`tryconnect: old link disconnect not observed` / `set_config failed` / `connect failed` / `ssid .* not in scan results`）保留，对应其它故障形态。

---

## 11. 关闭记录（2026-11-22）

### 11.1 结论

`WIFI-OP-RESOURCE-RACE` 判定为**已解决并关闭**。依据是修复后在 `1.3-1ff92db` 上完成的设备回归：三个竞态场景与 #12 全部 PASS，原 `wifi_scan_failed` 现象不再复现。

### 11.2 修复与证据

| 项 | 内容 |
|---|---|
| 修复提交 | `185e029`（owner 状态机：TRYX/AUTO/APPLY/CLEANUP/CLEANUP_FAILED）· `dc254d5`（status 快照字段，同期基线） |
| 验证镜像 | `1.3-1ff92db`（`build_sha 32b10dfa5`），设备 65D8 `10:97:bd:d3:65:d8` |
| 设备回归记录 | 固件仓 `docs/reviews/WIFI-OP-RESOURCE-RACE_CMD-01_设备复测记录_2026-11-22.md`（提交 `00b5e3a`） |
| 状态登记 | 固件仓 `docs/status/S6现场验收总览.md`（提交 `7def7cd`） |

### 11.3 关闭条件对照

| 条件 | 结果 |
|---|---|
| RACE-01：auto_connect 与 tryconnect 争抢 | PASS：`scheduled(400ms) → task run(410ms) → schedule refused owner_busy`，拒绝发生在 TRYX 持有期间；释放前 auto 连接 0 次 |
| RACE-02：cancel 后立即新 tryconnect | PASS：`TRYX → CLEANUP → cleanup complete → 新 TRYX`，新 op 在 cleanup 完成后 10ms 取得；终态 `ap_not_found` |
| RACE-03：cleanup 恢复与 auto 同时 | PASS：CLEANUP 窗口 370ms 内 auto 连接 0 次、被拒 2 次；完成后 1.61s 才出现 auto 连接 |
| 原 #12 现象回归 | PASS：`busy → operation_state → cancelled×2 → ap_not_found`；`wifi_scan_failed=0`、`ESP_ERR_WIFI_STATE=0` |
| 观察性修复 | 原缺陷的 `wifi_scan_failed`（预扫描被状态机拒绝）未再出现 |

### 11.4 边界

- 设备结果由执行方采集整理（PC BLE central + 串口）；评审方独立核验的是远端提交、文档与源码逻辑，**未独立连接设备复跑或重算原始证据哈希**。
- 结论限定在设备 65D8、镜像 `1.3-1ff92db` 与记录覆盖范围内；不推广为其它镜像或全量验收。
- 本轮只归档与状态变更，未修改代码、Contract 或设备配置；`CMD-01` 已转 `PASS`，`PROTO-ID-01` 保持已关闭。
- 若后续复测推翻本节结论，重新打开并追加说明，不改写 §1–§10。

## 附录：关键日志原文

```
I (199650419) wifi:state: run -> init (0x0)
I (199650429) wifi: auto_connect: selected saved profile index=1 ssid=CMCC-502
E (199650449) wifi: scan: start failed: ESP_ERR_WIFI_STATE
W (199650479) wifi: tryconnect: pre-scan failed (ESP_ERR_WIFI_STATE), one retry in 500ms
W (199650999) wifi:sta_scan: STA is connecting, scan are not allowed!
E (199650999) wifi: scan: start failed: ESP_ERR_WIFI_STATE
W (199650999) wifi: tryconnect: pre-scan failed twice (ESP_ERR_WIFI_STATE), abort before connect
I (199651029) wifi: apply_cfg: ssid='TQ2026' pwd_len=8 threshold=2(WPA) pmf(capable=1,required=0) scan=0
```
