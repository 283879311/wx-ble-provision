# BLE DATA / UART 传输压测方案（小程序端实现，不改固件）

> 状态：**方案已定稿，待实现**（小程序端未动代码）
> 已确认：`/dev/ttyUSB1` = ESP UART1 TX/RX 数据口 · `/dev/ttyUSB10` = 调试日志口 · 电脑侧 L1 回显 **+ L2 灌流** · 验收中心选 **方案 A（hub + 三子页）** · 回显桥已实现（`tools/uart_bridge.py`）

---

## 1. 目标与非目标

### 目标

1. 标定 **BLE DATA 通道**手机侧能力：写入吞吐、分片写回调失败率、通知接收吞吐、纯链路 RTT。
2. 标定 **UART1 通路**在带载下的字节完整性，并从 RTT 反推 UART 段实际耗时。
3. 建立**可复现基线**，后续固件改动用同一套用例回归对比。
4. 用 `/dev/ttyUSB10` 日志做**设备侧旁证**，把丢包定责到具体一层。

### 非目标

| 不做 | 原因 |
|---|---|
| 改固件加序号 / ACK / 流控 | 不改硬件代码；DATA 就是裸字节无确认 |
| 测 Wi-Fi / MQTT 吞吐 | 本轮范围是 BLE DATA + UART1 |
| 靠 `data.loopback` 以外的内部回环 | 无固件配合只能靠该开关或外部串口对端 |

---

## 2. 前置条件（已按实际接法落实）

| 项 | 实际情况 |
|---|---|
| BLE 数据面 | `/dev/ttyUSB1` → ESP **UART1 TX/RX**（数据口，非日志） |
| 设备日志 | `/dev/ttyUSB10` → ESP 调试口，压测期间**全程落盘** |
| 电脑侧 | **L1 回显 + L2 灌流**，`tools/uart_bridge.py`（零依赖，`--mode echo/listen/flood`） |
| 手机 | 小程序前台常驻，不锁屏不切后台（`onHide` 会 `off('data')`） |
| UART 参数 | 压测前 `config.get(['uart'])` 读回真实值写进报告；**压测本身不改波特率** |
| 链路 | 已登录、已订阅 `CMD_TX` / `DATA_TX` |

> UART1 是数据口意味着**日志不会污染帧流**，这一点很关键：数据口上出现的任何非本协议字节都能确定为「串口层异常」而不是日志干扰。

---

## 3. 拓扑与两条路径

```
                  ┌──────────── 手机（小程序 accept/stress） ────────────┐
                  │  发帧 / CRC / 位图统计 / 判定 / 报告               │
                  └──────────────┬───────────────────────┬─────────────┘
                     BLE 20B 分片写                ▲ DATA_TX 通知
                                 ▼                 │
                  ┌───────────────────────────────────────────────┐
                  │                ESP（固件不改）                  │
                  │  DATA_RX ──┬── data.loopback=on ──► DATA_TX     │ ① 纯 BLE
                  │            └── 数据面路由 ──► UART1 TX           │ ② 真实通路
                  │  DATA_TX ◄── 数据面路由 ◄── UART1 RX            │
                  └───────┬──────────────────────────────┬─────────┘
                          │ UART1 TX/RX                  │ 调试 UART
                  /dev/ttyUSB1                      /dev/ttyUSB10
                          │                              │
                    ┌─────▼─────┐                 ┌──────▼──────┐
                    │ 回显桥 L1/L2│                 │ 日志落盘     │
                    │ 回写 / 灌流  │                 │ grep 定责    │
                    └───────────┘                 └─────────────┘
```

**切换点只有 `data.loopback` 一个字段**：

- `on` → 字节在设备内部掉头，**不经过 UART**。此时电脑侧回显是空转（收不到字节），用来隔离手机侧与 BLE 链路。
- `off` → 字节走真实路由到 UART1。此时必须靠电脑回显才有回程。

> 注意：`loopback=on` 和 PC 回显**不能同时生效**——on 时字节根本不出设备，谈回显没有意义。压测页要在 UI 上把这两者的关系说清楚，避免用户以为「开了回显但收不到」是故障。

### 回显桥：一个脚本覆盖三档（已实现）

`tools/uart_bridge.py`，**零第三方依赖**（只用 `termios` / `select` / `os`），Linux 直接跑：

```bash
# L1 回显：收到什么原样写回（UART 闭环完整性 + RTT）
python3 tools/uart_bridge.py /dev/ttyUSB1 --baud 115200 --mode echo

# L0 只监听：不回写，只报累计字节（UART 单向到达率）
python3 tools/uart_bridge.py /dev/ttyUSB1 --baud 115200 --mode listen

# L2 灌流：按 PST 帧主动灌下行（手机接收吞吐 / data_pipe 满载）
python3 tools/uart_bridge.py /dev/ttyUSB1 --baud 115200 --mode flood \
    --rate 4000 --frames 500 --len 200 --delay 5
```

**它只做三件机械事**：回显、计数、按速率灌流。不做任何判定——逐字节比对与 PASS/FAIL 全在小程序。

两条实现硬要求：
1. **收到即写，不攒批**——攒批会把 PC 缓冲延迟算进手机的 RTT；
2. **`echo`/`listen` 按字节流处理，不解析帧**——回显桥不该懂协议，否则 PC 侧就有了判定逻辑。
   唯一的例外是 `flood` 必须会**组帧**（它得主动构造合法 PST 帧），但仍然不做判定。

串口按 **raw 模式**打开（`iflag=0 / oflag=0 / lflag=0 / CS8`）：二进制帧里会出现 `0x00`、`0xFF`、`0x0D`，任何行规程处理都会破坏字节流。已实测：含 `0x00` 的 128B 回显逐字节一致。

---

## 4. 电脑侧能签收什么（L1 vs L2）

**回显是 1:1 的，下行量永远等于上行量**——所以 L1 单独压不满下行，必须让 PC 主动灌。加了 `flood` 之后覆盖面才完整：

| 能力 | L1 回显 | L2 灌流 | 说明 |
|---|---|---|---|
| BLE 上行写入吞吐与失败率 | ✅ | — | 不依赖回程 |
| BLE 纯链路 RTT（`loopback=on`） | ✅ | — | 不经 UART |
| UART1 字节完整性（双向） | ✅ | — | 闭环逐字节比对 |
| UART 段耗时（RTT 反推波特率） | ✅ | — | 见下 |
| **手机接收吞吐上限** | ❌ | ✅ | 只有 PC 能比手机发得更快 |
| **设备 UART RX 溢出边界** | ❌ | ✅ | 超速灌才能把 RX 缓冲打满 |
| **`data_pipe` 下行满载丢帧** | ❌ | ✅ | 构造 ≥16 帧在途 |

### flood 怎么让手机自己算清满额与丢失

手机不知道 PC 打算发多少，靠帧里的**边界帧**自洽，不需要 PC 告诉它：

```
PC:  START(total=N, plen=L) → DATA(seq 0..N-1) → END(sent=M)
手机:  收到 START 记 expected=N
       逐帧统计 seq（位图去重 / 乱序 / CRC）
       收到 END 记 actualSent=M
       结算 lost = N - 已收帧数；若 M < N 说明 PC 侧自己中断
```

两端唯一要对齐的是**帧编码规则**（LCG 公式 + CRC16-CCITT-FALSE），不需要握手、不需要端口、不需要 PC 参与判定。

> **JS 侧必须用 `Math.imul`**：`x * 1103515245` 里 x 可达 2³¹，乘积约 2.4×10¹⁸ 超过 2⁵³，直接乘会丢精度，两端 payload 对不上、CRC 全错。用 `Math.imul(x, 1103515245)` 取低 32 位再 `& 0x7FFFFFFF`，与 Python 的大整数取模结果一致（已验证含 seq=2×10⁹ 的边界值）。

### 从 RTT 反推 UART 实际波特率（很有用的一招）

闭环 RTT ≈ 2 × UART 传输耗时 + BLE 双程 + PC 回写。同一帧长下：

```
UART 单向耗时 ≈ (RTT_echo - RTT_loopback) / 2
有效波特率 ≈ 帧字节数 × 10 / UART 单向耗时        (8N1 每字节 10 bit)
```

如果 `config.get` 报 921600 而实测反推只有 115200，说明**配置读回来了但串口没按新值重应用**——这类「配置生效假象」只有靠测时序才能发现，功能测试看不出来。方案把这条作为 S4 的固定输出项。

---

## 5. 日志旁证规范（`/dev/ttyUSB10`）

压测从「只能看结果」变成「能说清楚为什么」，靠的就是这一路日志。

**采集方式**（压测前起，压测后停）：

```bash
stty -F /dev/ttyUSB10 115200 raw -echo
cat /dev/ttyUSB10 | ts '%.s' > stress-$(date +%H%M%S).log
```

**报告固定记录 `T0`（压测开始时刻，毫秒）**，与日志时间戳对齐。

**压测后按现象 grep**：

| 现象 | grep 关键词 | 指向 |
|---|---|---|
| 整帧丢、前后完好 | `pipe.*full` / `drop` / `overflow` | `data_pipe` 深度 16 被打满 |
| 连续 magic 消失 | `uart.*err` / `fifo` / `rx.*overflow` | UART1 RX 缓冲溢出 |
| CRC 高但 magic 多中 | `frame` / `parity` / `baud` | 波特率不匹配或噪声 |
| 压测中断链 | `disconnect` / `reason` | 链路层主动断开 |
| 长稳期间 | `heap` / `free` / `largest` | 内存趋势（T5 已在关注） |

这一步的产出是**报告里的一段「设备侧证据」小节**，不是让用户自己去翻日志。压测页在结束时提示「请把这行时间戳贴进串口日志过滤」，或者直接让用户手动核对（小程序读不到电脑的文件，不假装能自动化）。

> 边界要说清：小程序没法读电脑上的日志文件。所以「日志对时」是**半自动**——程序给时间戳，人来 grep。方案不承诺全自动定责。

---

## 6. 用例矩阵

编号用 `S` 前缀，与 T4/T5 并列。三组共 10 项，必做组任何一次压测都跑。

### 必做组（约 3–4 分钟）

| 编号 | 场景 | loopback | 变量 | 量 | 主判定 |
|---|---|---|---|---|---|
| **S1** | BLE 回环阶梯 | `on` | 帧长 20 / 64 / 200 / 512 | 各 200 帧 | ≤200B 必须 100% 逐字节一致；记录 B/s 与写片耗时 P50/P95 |
| **S2** | BLE 盲发对照 | `off` | 帧长 200 | 200 帧 | 只统计写成功与耗时，与 S1 同档对比 → 看回环本身是否拖慢写入 |
| **S3** | UART 单向到达 | `off` | 帧长 200 | 300 帧 | 需 `--mode listen`：桥侧计数 vs 手机发送字节数 |
| **S4** | UART 闭环完整性 | `off` + echo | 帧长 64 / 200 | 各 150 帧 | 字节一致 + RTT 分布 + **反推有效波特率** |

### 边界组（约 4 分钟）

| 编号 | 场景 | 变量 | 量 | 判定口径 |
|---|---|---|---|---|
| **S5** | 突发边界 | `on`，576 / 600 / 1024 / 2048 背靠背 | 各 30 帧 | 丢帧率曲线对照 `data_pipe=16`；丢帧记 EXPECTED |
| **S6** | 片间隔下限 | `on`，gap = 20 / 10 / 5 / 0ms | 各 100 帧 | 找丢帧拐点；<20ms 属超基线使用，只记录不判定 |
| **S7** | 下行灌流阶梯 | `off` + `--mode flood` | rate 1K / 4K / 8K / 16K B/s，帧长 200 | 各 300 帧 | 收到帧数 / `lost` / `truncated` / 下行 B/s；找丢帧率拐点 |

**S7 的操作流程**（这是唯一需要人配合电脑的用例）：

```
① 手机选「下行灌流」，点开始 → 进入等待 START 帧状态（30s 超时）
② 手机显示可复制的命令：
   python3 tools/uart_bridge.py /dev/ttyUSB1 --baud 115200 --mode flood \
       --rate 4000 --frames 300 --len 200
③ 电脑执行 → 脚本 5s 后自动开始（START → 300 帧 → END）
④ 手机收到 END 自动结算：lost = total - received，并出报告
```

超时未收到 START 就提示「未检测到灌流，检查命令与串口」——不静默等，也不假装跑过了。

### 稳定性组（约 2 分钟 + 长稳）

| 编号 | 场景 | 量 | 判定 |
|---|---|---|---|
| **S8** | 双通道并发 | `on`，DATA 持续 200B + CMD `device.info` 每 400ms，30s | DATA 计数增长、CMD 无 `rate_limited`、`unmatched=0` |
| **S9** | 长稳 60s | `off` + echo，定速 200B，同步抓 ttyUSB10 | 后半程吞吐衰减 <20%、无断链、日志无 overflow |
| **S10** | 中断链恢复 | 跑到一半强制 `disconnect` → 重连 | 重连首帧必须是新 seq magic（无旧字节）、会话号递增 |

---

## 7. 帧协议（PST v1，已冻结）

**唯一实现**：`utils/pframe.js`（小程序）/ `tools/uart_bridge.py`（电脑）。`stress` 引擎和页面不得再拼字节。

### 7.1 字节布局

```
 offset  size  field
   0      2    magic  0xA5 0x5A
   2      1    type   0x01=DATA  0x02=START  0x03=END
   3      2    seq    BE（DATA=序号；START/END=runId）
   5      2    len    payload 长度，BE，0..4096
   7    len    payload  DATA: LCG(seed=seq)；START/END: 见 7.2
  7+len    2   crc16   CRC-16/CCITT-FALSE，覆盖 type..payload（**不含 magic**）
```

固定开销 **9B**，各档有效载荷：

| 帧长 | 20 | 64 | 128 | 200 | 512 | 1024 | 2048 |
|---|---|---|---|---|---|---|---|
| payload | 11 | 55 | 119 | 191 | 503 | 1015 | 2039 |

**CRC 为什么不盖 magic**：重同步时先靠 magic 定位帧头，再用 CRC 验证 `type+seq+len+payload`。若把 magic 也纳入 CRC，一个被改写的 magic 字节会让整帧看起来像「内容损坏」，就无法区分「串道」和「错位」。

CRC 参数（固定，不得改）：`poly=0x1021 init=0xFFFF refin=false refout=false xorout=0x0000`，`check("123456789")=0x29B1`。

### 7.2 type 与 seq 语义

| type | seq 字段 | payload | 含义 |
|---|---|---|---|
| `0x01 DATA` | 0..65535 递增 | `LCG(seed=seq)`，长度 = START.plen | 数据帧，最后一个是 `total-1` |
| `0x02 START` | **runId** | `total(4B BE) + plen(2B BE)` | `total` = 预期 **DATA 帧数** |
| `0x03 END` | **runId** | `sent(4B BE)` | 发送端实际发出的 DATA 帧数 |

**控制帧用 runId 而不是 0**：上一轮迟到的 END 若 seq 恒为 0，会被本轮当成结束信号，直接结算出假的 100%。接收端只接受 `runId` 与当前轮次一致的 START/END，不匹配的计入 `staleControl` 并丢弃。电脑侧默认取时间低位，也可 `--run-id` 指定。

**`START.total` 只数 DATA 帧，不含 START/END 自身。** 把控制帧算进去会让每轮凭空多 2 帧——500 帧用例上表现为 99.6% 的「神秘丢失」，是最容易犯且最难查的错。

### 7.3 收尾三态（不能用「收到 END」代替完整性）

`without-response` 下 START / DATA / END 都可能丢，所以结算必须分三态，禁止合并成一个「丢失」：

| 状态 | 判据 | 结论 |
|---|---|---|
| `no_end` | 收到 DATA，但 `endWaitMs`（默认 3s）内无 END | END 丢失。数据可能完整，但**不可断言完整** |
| `end_partial` | END 到达，且 `received < END.sent` | 链路丢了帧（或 START.total 与 sent 不一致） |
| `seq_gap` | 位图出现空洞 | 定位到具体 seq，可与 `end_partial` 同时成立 |
| `complete` | END 到达且 `received == END.sent == START.total` | 才能判完整 |

三条独立证据必须都记录，报告里不能只写「丢失 N 帧」。

### 7.4 分层字节账（46KB 差值的正确归因）

不同阶段测到的字节数**不能直接相减**，每一层单独列，注明来源：

| 层 | 字段 | 来源 | 说明 |
|---|---|---|---|
| 计划 | `plannedBytes` | 手机 | `total × (9 + plen)`，用例配置推算 |
| 提交 | `submittedBytes` | 手机 | BLE `write` 调用成功返回的累计字节（含分片） |
| 设备收 | `deviceRxBytes` | 设备日志 / 回显 | 需要 `/dev/ttyUSB10` 或回显侧旁证，缺失标 `n/a` |
| 串口出 | `uartOutBytes` | 电脑 `uart_bridge` 汇总行 | PC 侧计数，人工抄录 |

`sent`（帧数）、`received`、`crc_error`、`seq_gap`、`duplicate`、`timeout`、`disconnect` 各自独立计数，任何一个都不代表「丢了 N 帧」。

### 7.5 解析器统计口径

`FrameParser` 只负责把裸字节切回帧，四类异常分开记账：

| 字段 | 触发条件 | 指向 |
|---|---|---|
| `crcErrors` | magic 对上但 CRC 不符 | 内容损坏 / 错位 |
| `resyncBytes` | 为重新对齐而丢弃的字节 | 串道 / 帧边界破坏 |
| `truncBytes` | 半帧超过 `staleMs`（默认 2s） | 链路中断 / 帧被截断 |
| `oversize` | len > 4096 | 假 magic 或长度字段损坏 |

`payload` 不存副本，收到就地按 seq 重算（`payloadMatches`），1000 帧 × 1KB 时内存恒定。

统计用 2048 位 seq 滑动窗口位图区分 `lost` / `dup` / `outOfOrder`，不用 `已发 - 已收` 减法。

### 7.6 跨语言契约与门禁

任何一端改编码，自测必须变红。三道门：

```bash
# 1. 重新生成向量（Python 权威实现 -> JSON + 真实灌流字节流）
python3 tools/gen_vectors.py
python3 tools/gen_vectors.py --check      # 产物是否与当前实现一致

# 2. JS 侧逐条比对（69 项基础 + 15 项跨语言闭环）
node ../_verify/pframe-selftest.js
```

产物：
- `_verify/pframe-vectors.json` —— 8 条 CRC、45 条 LCG（含 seq=2e9 精度边界）、21 条帧，全部为十六进制字面量
- `_verify/pframe-flood.bin` —— 真实 `mode_flood` 跑出来的 4028B 字节流（1 START + 20 DATA + 1 END），JS 端用 20B 分片喂进去必须还原成同样 22 帧

**JS 侧 LCG 必须用 `Math.imul`**：`x` 可达 2³¹，乘 1.1e9 约 2.4e18 超过 2⁵³，直接相乘会静默丢低位，两端 payload 对不上、CRC 全错，现象像串口坏了。

判定分档：**≤200B 零丢零错零乱序才算 PASS**；≥576B 只与首轮基线比，不设绝对零。

---

## 8. 验收中心导航分页（本次新增，需先做）

### 现状问题

`pages/accept` 现在是单页装两套：页首 + T4 的 1 张操作卡 + **15 张检查项卡** + 报告卡 + T5 的 4 张卡。JS 942 行、WXML 240 行。再加一个压测模块（参数 + 实时统计 + 结果 + 报告），单页会到 400+ 行 WXML，滚动深度超过 20 屏。

### 方案对比

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A. hub + 子页**（推荐） | `accept` 留作 hub，三个入口跳子页 | 与**配置中心已有范式完全一致**；每页职责单一；页面长度可控 | 点「验收」后多一次点击 |
| B. 页内吸顶目录 + 折叠 | 保留单页，加锚点导航，检查项默认折叠 | 改动小，状态不用拆 | 页面还是长；每次进页面要重新渲染 15 张卡 |
| C. 二级 tabBar | 页内 seg 扩到三个模块 | 改动最小 | **不解决长度问题**，T4 自己就超长 |

**推荐 A**，理由是项目里 `pages/provision` 已经是这个结构（hub + netcfg/mqttcfg/blecfg/uartcfg 四子页），用户对这套交互已经熟悉，验收中心跟着走不会产生新的心智负担。

### 目标结构

```
pages/accept/accept          hub：链路状态 + 三张入口卡 + 上次结果摘要 + 报告复制
pages/t4/t4                  T4 功能自检（原 15 项 + 报告）
pages/t5/t5                  T5 长稳韧性（M1 取证 + soak + 报告）
pages/stress/stress          传输压测（新增，S1–S10）
```

命名与 `netcfg` / `mqttcfg` 平级一致，不嵌套。

### hub 长什么样

```
┌ 验收中心 ────────────────────────────────┐
│ 设备 XXX · 会话 #12          [已登录]     │
│ [重新连接并登录] [网络诊断] [设备页]      │
└──────────────────────────────────────────┘
┌ T4 功能自检 ─────────── 14P 1S  ── 进入 ─┐
│ 15 项协议检查 · 2 小时前                  │
└──────────────────────────────────────────┘
┌ T5 长稳韧性 ─────────── 7P 3F  ── 进入 ─┐
│ M1 取证 + soak · 昨天                     │
└──────────────────────────────────────────┘
┌ 传输压测 ───────────── 基线未标定 ─ 进入 ┐
│ BLE / UART1 · 串口 /dev/ttyUSB1 (L1/L2)   │
└──────────────────────────────────────────┘
┌ 最近报告 ────────────────────────────────┐
│ T4 报告 [复制]   T5 报告 [复制]  压测 [复制]│
└──────────────────────────────────────────┘
```

### 三处需要新增的机制

**① 结果摘要跨页留存** —— hub 要显示「上次 14P 1S」，子页跑完必须把摘要写出去。

新增 `utils/accept-store.js`（~60 行），存储键 `accept_results_v1`：

```js
{ t4: {at, pass, expected, fail, skip, verdict},
  t5: {at, pass, expected, fail, other, rounds},
  stress: {at, verdict, caseId, baseline:{upBps, downBps, rttP50}} }
```

只存摘要，**不存完整报告**（报告可能几十 KB，storage 单键上限吃紧）；完整报告仍留在各自页面内存里，跨页要用就单独存 `accept_report_t4` 之类。

**② 子页间直接切换** —— hub → T4 → 想直接去压测，否则要退两级。

子页底部放一行模块切换，用 `redirectTo`（替换当前页，栈深度不增长）：

```js
wx.redirectTo({ url: '/pages/stress/stress' })
```

**③ 压测进行中切页的保护** —— hub 显示「压测进行中」，子页 `onHide` 主动中止。

`globalData.stressRunning` 一个布尔就够，hub `onShow` 读它渲染状态。

### 对既有自测的影响

`_verify/page-accept-selftest.js` 现在 30 项，全是针对单页的静态/行为校验。拆页后需要：

- 新增「navigateTo 目标必须在 app.json 注册」（这条现有 page-provision 自测已有范式，`app.json` 漏注册导致点不动是踩过的坑）
- 三个子页文件齐全 + 都有 `.json` 标题
- 结果摘要写入/读取往返
- hub 入口数量与文案
- 预计 30 → **55 项**；`page-provision-selftest` 105 项不受影响

全项目自测总数从 443 → **约 500**（拆页 55 + 压测 45）。

---

## 9. 实现拆分（已落地）

| 文件 | 职责 | 实际行数 | 状态 |
|---|---|---|---|
| `tools/uart_bridge.py` | 电脑侧回显 / 监听 / 灌流桥（零依赖） | 343 | **已完成并自测** |
| `tools/gen_vectors.py` | 从权威实现生成跨语言向量 + 灌流样本 | 200 | **已完成** |
| `utils/pframe.js` | 帧编解码 + LCG + CRC16 + 流解析器 | 470 | **已完成** |
| `utils/stress.js` | 引擎：用例编排、计数、位图、判定、报告 | 620 | **已完成** |
| `utils/accept-core.js` | 验收共享逻辑（链路/自动连接/元信息） | 189 | **已完成** |
| `utils/accept-store.js` | 验收结果摘要读写 | 90 | **已完成** |
| `pages/accept/accept` | hub（三个入口 + 摘要 + 链路状态） | 190 | 从 942 缩到 190 |
| `pages/t4/t4` | 从 accept 抽出 T4 | 546 | 迁移，逻辑未改 |
| `pages/t5/t5` | 从 accept 抽出 T5 + M1 | 270 | 迁移，逻辑未改 |
| `pages/stress/stress` | 压测控制台 | 470 + 180(wxml) | **已完成** |
| `app.json` | 注册三个新页 | +3 | 已完成，hub 自测锁定目标已注册 |
| `_verify/pframe-selftest.js` | 跨语言向量 + 解析器 + 语义守卫 | 84 项 | **全绿** |
| `_verify/stress-selftest.js` | 三模式 / 丢帧 / 乱序 / 断链 / 收尾三态 | 94 项 | **全绿** |
| `_verify/page-stress-selftest.js` | 帧长换算 / 对端命令 / 报告格式 | 37 项 | **全绿** |
| `_verify/page-accept-selftest.js` | hub 导航 + T4 断开态 + T5 子页 | 34 项 | **全绿** |

**未做**：`utils/ble.js` 的 `write(key, bytes, {gapMs})` 可选参数——本轮压测统一走默认 20B/20ms 基线，
片间隔探测（S7）留到真机标定后再决定要不要开放。

**迁移结论**：T4/T5 拆页前先核对了跨模块字段引用（T4 段不引用任何 T5 字段，T5 段只用局部
变量 `report`/`summary`），拆分后 T4 断开态流程的 34 项页面级断言全绿，未出现回归。

---

## 10. 状态守卫（压测页）

压测改 `data.loopback`，**五处**必须 `finally` 还原：正常结束、用户中止、`onHide`、`onUnload`、断链。

报告固定写一行 `loopback 已还原=on→off` 作为可核对证据。

`onHide` 主动中止并写「被中断」，不留半截数据当结论。

---

## 11. 风险

| 编号 | 风险 | 应对 |
|---|---|---|
| R1 | 上行 20B 片是硬瓶颈，200 帧×512B ≈ 3 分钟 | UI 给预估耗时；提供「快速档」50 帧先跑通 |
| R2 | 压测改波特率后进程被杀，设备留在错误 baud | **默认不改 baud**；要扫波特率走可选开关 + `finally` 还原 |
| R3 | 用户以为「开了回显收不到」是故障（实际 loopback=on） | UI 上把两者互斥关系写死提示 |
| R4 | 把 `data_pipe=16` 的已知丢帧判成回归失败 | 判定分档 + 只与首轮基线比 |
| R5 | T4/T5 拆页引入回归 | 纯搬迁、不动逻辑；迁完先真机各跑一遍 |
| R6 | 日志对时靠人工，容易漏 | 报告直接输出可复制的 grep 命令 + T0 时间戳 |
| R7 | S7 灌流要人工在电脑敲命令，容易输错参数 | 手机页直接给出可复制命令（含正确 rate/frames/len）；30s 收不到 START 明确提示 |

---

## 12. 决策记录

| 项 | 结论 |
|---|---|
| 验收中心分页 | **A：hub + 三子页**（与配置中心同范式） |
| 电脑侧脚本 | 已实现 `tools/uart_bridge.py`，三档 `echo` / `listen` / `flood` |
| S7 下行灌流 | **完整签收**，靠 START/END 边界帧让手机自结算 |

### 已完成的验证（脚本层）

| 项 | 结果 |
|---|---|
| CRC-16/CCITT-FALSE 标准向量 `"123456789"` | `0x29B1` ✓ |
| 帧结构往返（magic/type/seq/len/crc） | 200B 载荷 → 209B 帧 ✓ |
| LCG 两端一致性（含 seq=2×10⁹ 边界） | 可复现、不同 seq 不同内容 ✓ |
| `echo` 模式：128B 含 `0x00` 逐字节回显 | ✓（raw 模式未被行规程破坏） |
| `listen` 模式：不回写、计数准确 | ✓ |
| `flood` 模式：START + N×DATA + END，全 CRC 正确 | ✓（5 帧 17B 验证，类型序列与 seq 连续） |

> 沙箱内没有 `/dev/pts`，串口本身跑不起来，所以用 socketpair 直接驱动三种模式的读写路径；真实串口行为（波特率、缓冲、溢出）要等真机。

### 剩下的工作

按 §9 顺序：`pframe` → `stress` 引擎 → 验收分页改造 → `pages/stress` → 真机标定基线。
