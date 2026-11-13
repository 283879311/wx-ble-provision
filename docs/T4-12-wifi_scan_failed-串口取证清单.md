# T4 #12 `failed/wifi_scan_failed` 串口取证清单

状态：**待取证**（2026-11-12 定稿）。在拿到串口日志前，不改错误分类、不加扫描重试、不放宽判定、不动 cancel 与新 operation 的资源交接。

- 现场：C8E4 / 固件 1.3-2ef2a38（2026-11-11 23:10 那轮）
- 现象：`cancel` 后新 tryconnect 被受理，9.3s 后终态 `failed/wifi_scan_failed`；期望 `failed/ap_not_found`
- 已有线索：终态耗时 9329ms、无 fast abort → 支持"扫描路径确实执行过"，**不足以证明两次预扫描都完整跑完**
- 注意：**9329ms 是「受理 → 终态」的端到端时长，不是两次扫描耗时之和**。每轮扫描的耗时必须由该轮自己的起止行计算。

## 一、采集前置

1. 手机与设备对时（记下手机侧 #12 的起止墙钟，精确到秒）。
2. 采集窗口：跑 #12 之前开始，新 op 触达终态后再留 10s。
3. 同时抓小程序侧该轮 detail（含 operation_id、9329ms）。
4. 现场只跑 #12 单项，避免其它用例的 scan 干扰时间线。

## 二、采集命令

```bash
stty -F /dev/ttyUSB0 115200 raw -echo
cat /dev/ttyUSB0 | while IFS= read -r l; do printf '%s %s\n' "$(date +%H:%M:%S.%3N)" "$l"; done \
  | tee t4-12-opsem-serial.log
```

（端口/波特率按现场改；日志与小程序 detail 一并归档，命名带设备与时间。）

## 三、必采节点

| 关键节点 | 必须获得的信息 | 备注 |
|---|---|---|
| cancel 发出 / 返回 | 时刻、返回状态 `cancelled` | 与小程序侧对齐 |
| restore_persistent（第 1/2/3 次） | 是否执行、每次返回值、耗时、最终状态 | 三次都要 |
| scan start | 扫描开始时刻、调用参数（信道/被动主动/ dwell） | 每轮各一条 |
| scan return | API 返回值（成功/错误码） | 这是区分"没扫到"与"扫描失败"的关键 |
| scan done | 完成事件时刻、该轮耗时（start→done） | 用于算真实单轮耗时 |
| scan result | 获取到的 AP 数量 | 0 条 ≠ 扫描失败 |
| cancel cleanup | 清理完成时刻 | 判定危险窗是否已关闭 |
| Wi-Fi release | 资源释放是否完成（何时） | 判定旧 op 是否仍占资源 |
| 新 op 受理 → 终态 | operation_id、终态、9329ms | 与手机侧一致 |

补充排查串（报告中已列，用于交叉验证）：
`tryconnect: old link disconnect not observed`、`set_config failed`、`connect failed`、`ssid .* not in scan results`。前三者指向 cancel 的 restore 与新 op 抢占，最后一条才是 `ap_not_found` 应走的路径。

## 四、时间线模板

| 相对时刻 | 事件 | 证据行 | 备注 |
|---|---|---|---|
| T0 | cancel 发出 | | |
| T0+ | cancel 返回 `cancelled` | | |
| T0+ | restore_persistent #1 起/止（返回、耗时） | | |
| T0+ | restore_persistent #2 / #3（有无） | | |
| T0+ | 新 tryconnect 受理（operation_id） | | |
| T0+ | scan #1 start → return → done（单轮耗时） | | 分别填，勿合并 |
| T0+ | scan #1 result（AP 数） | | |
| T0+ | scan #2 start → return → done（单轮耗时） | | |
| T0+ | scan #2 result（AP 数） | | |
| T0+ | Wi-Fi release 完成 | | |
| T0+ | 终态 `failed/wifi_scan_failed` | | 端到端 9329ms |

## 五、判定矩阵

| 排查结果 | 后续处理 |
|---|---|
| restore_persistent 未收敛或失败 | 固件缺陷，修复后重测 |
| cancel 完成后旧 op 仍占用扫描资源 | 固件生命周期/资源释放问题 |
| 清理已完成，射频环境导致扫描失败 | 再讨论「接受扫描失败为等效终态」 |
| 确认属于 cancel 窗口的合法瞬态 | 才评估把 `wifi_scan_failed` 标 transient，并同步改契约与测试 |

## 六、本轮禁止项

- 不修改 `wifi_scan_failed` 的错误分类
- 不增加扫描重试次数
- 不放宽扫描失败判定
- 不修改 cancel 与新 operation 的资源交接逻辑
- 不在取证前烧写固件、重启设备或修改设备配置
- 若当前日志级别下缺少 `scan return` / `scan done` / `Wi-Fi release` 等行，**不要为此调整设备日志级别或配置**：先按现状采一份，缺项在时间线里记「未记录」，再单独评估是否需要更高日志级别

## 七、结果回填

- 结论档位（1–4）：
- 依据行（时间线编号）：
- 是否进入固件修改：
- 若否，下一步：#12 保持 `failed/wifi_scan_failed` 原样归档
