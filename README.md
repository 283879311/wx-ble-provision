# IotHub BLE 配网小程序

按 `docs/BLE微信小程序交互协议_T4_2026-10-24.md` 实现的微信小程序：BLE 扫描 → 连接 → 订阅 → 登录 → Wi-Fi 扫描 → 试连 → apply → 确认上线，并内置一份可跑的 T4 验收自检。

面向固件 `feature/shared-config-cmd`（STA-only，AP 配置 schema 已删除）。

## 四个页面

| 页面 | 作用 |
| --- | --- |
| 设备 | 扫描（只认本窗口广播）、连接、特征解析结果与属性、`device.info`、`auth.login`、断连重连 |
| 配置 | 配置中心：四个独立子页入口——网络配置（`network.status` 判读、Wi-Fi 扫描配网、诊断导出、profile 清理）、MQTT 配置（服务器查询与配置）、BLE 配置（状态查询与判读，固件只读）、UART 配置（串口参数读写 + DATA 通道收发窗口）；联网失败时网络配置页直接当救援通道用 |
| 验收 | 统一验收中心：T4 15 项功能自检（10 自动 + 3 人工 + 2 重复性）+ T5 长稳韧性（soak/M1 取证），页内模块切换、同一套报告规范 |
| 调试 | 原始 JSON 命令（含 v0 `config.set` 静态 IP 预置）、分片统计、DATA 回环逐字节比对 |

## 目录

```
app.js / app.json / app.wxss        全局入口、tabBar、样式
project.config.json                 项目配置（appid 为 touristappid，需替换）
utils/
  ble.js        GATT 传输层：扫描/连接/特征解析/订阅/20B 分片串行写/通道分流
  protocol.js   CMD 命令层：v1 封装、id 匹配、超时、token、重试、日志脱敏
  json-stream.js CMD TX 字节流 → JSON 对象（字节级括号配对）
  bytes.js      UTF-8 编解码（不依赖 TextDecoder）
  config.js     默认管理员账号（admin/123456）与目标设备记忆 key
  link.js       一键拉起链路：扫描 → 连接 → 发现 → 订阅 → 登录
  provision.js  配网状态机
  netdiag.js    网络诊断：运行态 SSID 判读、证据导出、profile 清理
  acceptance.js 验收自检（纯逻辑，可在 Node 下跑）
  accept-core.js 验收中心共享逻辑：链路状态/自动连接登录/报告元信息（T4/T5/压测共用）
  accept-store.js 验收结果摘要（只存计数，不存报告全文）
  pframe.js     PST v1 帧协议：编解码 + LCG + CRC16 + 流解析（协议冻结层）
  stress.js     压测引擎：L0/L1/L2 调度、位图统计、分层记账、收尾三态、判定
  errors.js     错误码 → 中文提示
  session.js    ble/protocol 单例
  busy.js       跨页互斥标志（配网/清理进行中时其它配置页写操作暂缓）
  util.js       时间戳、幂等键、RSSI/auth 文案、UUID 缩写
pages/{index,provision,accept,console}      provision=配置中心 hub，accept=验收中心 hub
pages/{t4,t5,stress}                         验收中心三个子页：功能自检 / 长稳韧性 / 传输压测
pages/{netcfg,mqttcfg,blecfg,uartcfg}       配置中心四个独立子页：网络 / MQTT / BLE / UART
tools/uart_bridge.py                         电脑侧回显/监听/灌流桥（零第三方依赖）
tools/gen_vectors.py                         生成跨语言帧测试向量与灌流样本
```

## 运行

1. 微信开发者工具 → 导入项目 → 选择本目录。
2. 把 `project.config.json` 的 `appid` 换成你的小程序 AppID（`touristappid` 只能开工具预览，真机 BLE 需真实 AppID）。
3. 真机调试（模拟器没有蓝牙）：预览 → 扫码。
4. Android 需开启系统定位开关并允许微信定位，否则扫不到设备。
5. iOS 扫不到时，先在系统蓝牙里「忽略此设备」清缓存。

管理员账号默认填好 `admin / 123456`（`utils/config.js` 里改）：连上设备后会自动登录一次；断开后会自动回填，重连不用再手输。

## 关键实现口径

| 要求 | 做法 |
| --- | --- |
| 不凭 UUID 写死流程 | `discover()` 先按 UUID 命中**并校验属性**（RX 必须 write/writeNoResponse，TX 必须 notify/indicate）；不满足时在同服务内按属性回退；每条特征的解析依据（`uuid` / `property` / `uuid-weak`）都显示在设备页 |
| 服务定位 | 优先 NUS Service UUID；找不到时退化为「具备 ≥2 可写 + ≥2 可通知特征」的服务，并标注「按特征布局定位」 |
| 通知分流 | 用**实际解析出的特征 ID** 建分流表，不写死 UUID；其它特征的通知只计数，不进重组缓冲 |
| 扫描时序 | 连接前扫描才作数；连接态点「扫描」会先提示「设备已停止广播」，确认后**断开再扫**（§2.1：连接态 0 台不是故障） |
| 扫描不依赖缓存 | 不调用 `getBluetoothDevices` 补种历史列表；只渲染本次扫描窗口内的广播，显示「刚刚 / Ns 前」，>12s 标灰 |
| 20 字节分包 | 固定 20B、串行等 success、片间 20ms；**不主动协商 MTU**（`ENABLE_MTU_NEGOTIATION=false`），真机 MTU 更大也不改基线 |
| 订阅顺序 | 连接后先订阅 CMD TX，再订阅 DATA TX，最后才发命令 |
| 长响应 | 字节级括号配对重组，配对完整后才整体 UTF-8 解码；`config.get` / `network.scan` 超时 30s，其余 ≥10s |
| 超时计时 | 从**写入完成**开始计（275B 命令光分片写入就要约 300ms） |
| 命令节流 | 两条命令之间 ≥210ms（设备 5 次/秒、最短 200ms） |
| 断连重连 | 断开要**确认链路真的断了**（等系统断连事件，收不到就探测 `getBLEDeviceServices`，仍不通再 close 一次），不是改个标志位就算；重连后重新发现/订阅/登录，旧响应无处可落 |
| 错误处理 | `unauthorized` 自动重登录重试一次、`rate_limited` 退避 350ms、`busy` 先取消旧 operation、`no_slot` 单独提示不当密码错误 |
| 断连态可测 | 断开/没登录都不再拦「运行全部」：`link.js` 的 `ensureLink()` 自动扫描（记忆目标优先，`deviceId` 漂移时按广播名回退）→ 连接 → 发现 → 订阅 → 用默认账号登录；连不上或登录失败时其余项记 `SKIP` 并写明原因，不会被误判成设备 FAIL |
| 目标设备记忆 | `ble.connect()` 把 `{deviceId,name}` 存 storage；`disconnect()` 会清空内存里的 `deviceId`，重连和报告都靠这条记录回填 |
| 链路判读 | **不用 `sta_connected` + 正式 `sta_ssid` 判「当前 Wi-Fi 还连着」**：自动回退时两者都为 true/正式值，但设备连的其实是别的 profile。判定顺序固定为 `sta_has_ip`+`sta_ip`（在线/断网）→ `connected_ssid`（连的哪个 SSID）→ `mqtt_connected`（是否真上线）→ `last_disconnect`（为什么掉/为什么切） |
| 回退识别 | 固件新增加法字段 `connected_ssid` / `connected_profile`（运行态，取 `esp_wifi_sta_get_ap_info()` 并按 SSID 反查 profile 下标）；只有 `connected_ssid === sta_ssid` 才算「正式网络在线」。旧固件没有该字段时记「未取证」：存在其它 profile 一律不给 PASS，只有正式 profile 才允许按「回退不可能」推断 |
| 日志脱敏 | 收发日志里 `token` / `password` / `sta_password` 统一替换为 `<redacted:N>`，报告与日志都不出现明文 |

## 网络诊断（AP 关停后到底连在哪）

`sta_connected=true` 只说明 STA 链路起来了。非静态模式下正式 AP 关停后，设备会自动复用另一个已保存 profile（例如 CMCC-502 关掉后连到 TQ2018），此时：

- `sta_connected=true`、`sta_ssid` 仍是正式配置 → 只看这两个字段会误判「还连着」；
- `sta_ip` 已经变成另一个网段；
- `connected_ssid`（运行态）才是真正连着的网络。

网络配置页「设备状态」会逐项显示：当前链路判读、**实际连接 SSID**、正式配置 SSID、IP、STA 关联、MQTT、最近断开（含 `reason xx(NAME)` 解释）、已保存 profile、回退候选。判读分四种：

| 判定 | 条件 | 含义 |
| --- | --- | --- |
| 在线 · 正式网络 | 有 IP 且 `connected_ssid === sta_ssid` | 唯一可以作为「配网成功」的状态 |
| 在线 · 已连接其他已保存网络 | 有 IP 但 `connected_ssid ≠ sta_ssid` | `sta_connected`/`sta_ssid` 都是真的，但不代表正式 AP 恢复 |
| 在线 · 但无法确认 SSID | 有 IP 但没有 `connected_ssid`（旧固件） | 有其它 profile 时按「疑似回退」处理，不给 PASS |
| 断网 | 无 IP / `sta_ip=0.0.0.0` | 按 `last_disconnect` 说明原因 |

页面顶部固定两行定调，直接对应现场口径：

```
正式配置：TQ2018
当前连接：CMCC-502（192.168.1.28）
```

只有当这两行的 SSID 相同、且 `mqtt_connected=true` 时，才算「正式网络在线」。不同则显示「已连接其他已保存网络」并标红——`sta_connected=true`、`sta_ssid=TQ2018`、有 IP、MQTT 通，全都不构成证据。

profile 列表里形如 `P0-NOAP-*` 的条目会被单列为**测试残留**（T4 压测建的假 AP 名），它们同样会被自动回退选中，清理时和普通回退候选一起删。

**一键诊断**：点「采集并复制」，串行读 `network.status` + `config.get(network)` + `network.profile.list`，生成可直接粘贴的文本：

```
=== BLE 网络诊断（T4） ===
结论: 在线 · 已连接其他已保存网络
正式配置：TQ2018
当前连接：CMCC-502（192.168.1.28）
解读: sta_ip=192.168.31.7 · mqtt_connected=true · connected_ssid=TQ2018 · 正式 sta_ssid=CMCC-502 · last_disconnect=none。…
--- network.status (raw) ---
{"sta_connected":true,...,"connected_ssid":"TQ2018","connected_profile":1,...}
--- config.get(network) (raw) ---
{"net_mode":"sta","sta_ssid":"CMCC-502",...}
--- network.profile.list (raw) ---
{"profiles":[{"ssid":"CMCC-502","password_set":true},{"ssid":"TQ2018","password_set":true}]}
--- 判读 ---
last_disconnect=none（正常（当前无断开原因））
非正式 profile（自动回退候选，救援前需删除）: TQ2018
风险: 存在自动回退可能，当前「在线」不能证明正式 AP 连着；T4 #14 需先清理上述 profile。
```

原始 JSON 一律保留（口令只以 `*_set` 出现），因为「回退」还是「DHCP 没起来」只能从原文判断。

**救援前置口径**：第 14 项要求 `sta_has_ip=false`、`sta_ip=0.0.0.0`、`mqtt_connected=false` 三者同时成立才允许「记录断网状态」。只要还有 IP（哪怕是回退到别的 AP，或 DHCP 租约还没过期），就拒绝记快照并说明原因——否则救援核验会变成走过场。

**profile 清理**：`profile 列表 / 清理` 可查看当前保存的 profile 并删除非正式项（只保留正式 SSID，需二次确认）。T4 的「无 IP 救援」必须先做这一步，否则关掉正式 AP 只会触发回退，`sta_connected` 仍为 true，测不到真正的 no-IP。验收页第 14 项的「清理其它 profile」按钮做的是同一件事，并且会在记录断网状态前拦下「还有其它 profile」的情况。

## MQTT 服务器配置与查询（配置中心 · MQTT 配置页）

- **查询**：`config.get(['mqtt'])` + `network.status` 一并取回——配置段 `mqtt_backend/mqtt_host/mqtt_port/mqtt_use_tls/mqtt_token_set`，运行态 `connected/publish_count/outbox/last_error` 与 `mqtt_connected/mqtt_last_error`。查完回填表单（token 只回显「已设置」）。
- **配置**：`config.set` mqtt 域（`protocol.configSet` v1 通用封装）。固件语义：`mqtt_backend/mqtt_host/mqtt_token` 留空=保留原值（empty_keeps），`mqtt_port` 1–65535，`mqtt_use_tls` 布尔，`token_clear=true` 清已存 token；生效=子系统重连（`applied=true`、不整机重启）。
- **backend 三选项（与固件 `mqtt.c` 对齐）**：`tb_cloud`（ThingsBoard 云，固件默认）、`tb_selfhost`（自建 ThingsBoard，两者都走 `v1/devices/me/*` 主题）、`custom`（通用自定义，走 `iothub/telemetry` 等通用主题；固件对非 tb_* 值统一按此处理）。下拉选择，设备侧未知值显示为 custom 但未主动改动前不会下发（不覆盖原值）。
- **口令小眼睛**：配网页两个口令输入框（弹窗 + 底部表单）均带可见切换（SVG 眼睛图标，掩码/明文）；记忆口令预填时弹窗不自动抬键盘。
- **回填口径**：只有本机之前配网成功过的 SSID 才会自动回填口令（`utils/pwstore.js`）；设备侧「已保存 profile」不等于本机有口令记忆——口令在设备侧不可读，此时弹窗会提示手动输入。
- **保守策略**：保存只下发与查询基线有差异的字段（未查询时只发非空输入，绝不主动发 `mqtt_use_tls=false` 误关 TLS）；token 与 token_clear 互斥；token 在请求日志与流程日志中由 `redactBody` 自动脱敏。
- **保存后**：显示统一事务字段 `saved/applied/restart_required/changed`，约 2.5s 自动复查运行态——保存只表示配置已受理，连接结果以查询的运行态为准。

## UART 配置（配置中心 · UART 配置页）

- **探测**：`config.get(['uart'])` 取回 `uart_baudrate / uart_data_bits / uart_stop_bits / uart_parity_mode / uart_rx_gpio / uart_tx_gpio`。RX/TX 引脚由固件固定（`app_uart_rx_gpio()/app_uart_tx_gpio()`），只读展示。
- **配置**：`config.set` uart 域，`uart_baudrate` 1–4,000,000、`uart_data_bits` 5–8、`uart_stop_bits` 1–2、`uart_parity_mode` 数字枚举 `0(none)/2(even)/3(odd)`；生效=串口子系统重应用（`applied=true`、不整机重启）。
- **读写不对称（易踩）**：`config.get` 的 `uart_parity_mode` 是**字符串** `none/even/odd`，`config.set` 却只收**数字** `0/2/3`。页面用一张 parity 表做双向映射，保存时发数字，避免把 `even` 发下去被固件判非法。
- **波特率**：下拉给常用值（9600–921600）+「自定义」；设备侧值不在表内时自动落到自定义并回填原值，保存前按 1–4,000,000 校验。
- **收发窗口**：走 BLE DATA 通道（`DATA_RX` 写 / `DATA_TX` 通知），与命令通道分离。接收按 Plain（UTF-8 解码）/ Hex（每行 32 字节）渲染，缓冲上限 2048B；发送支持 Plain（UTF-8 编码）与 Hex（忽略空白、按字节配对，奇位数/非法字符直接拦下）。收发显示与发送编码是**本机偏好**，存 `uart_console_fmt_v1`，设备侧无对应配置。
- **路由前提**：能否真正到达串口取决于设备数据面路由 `data_route_uart1 / data_route_ble`（固件默认 UART1↔BLE↔MQTT）。该字段不在 `config.get` 里，页面无法回读，只提示排查方向；收发无反应时先确认设备侧路由没被改过。
- **口径**：DATA 是裸字节通道，无帧头/序号/ACK/重传，收发成功只代表字节已写入链路，不代表对端业务已处理。

## 验收自检怎么用

- **断开状态也能直接开始**（不必先去设备页连）。点「自动连接并运行」：先按断开态跑第 1 项扫描（只有这时才是真证据），然后自动「扫描 → 连接 → 发现 → 订阅 → 用默认账号登录」，再跑其余 14 项。
- 已连接时点「运行全部」，会先问一次：
  - **断开后跑（推荐）**：自动断开 → 等设备重新广播（最多 12s）→ 跑第 1 项扫描 → 重连 → 重新发现/订阅/登录 → 跑其余 14 项。这样第 1 项拿到的是 `PASS`，不再是 `EXPECTED`。
  - **保持连接**：第 1 项仍记 `EXPECTED`（协议允许，但不构成 T4 证据）。
- 单跑某一项时若链路已断，会先自动连接并登录再执行；连不上就给原因，不会静默跳过。
- 顶部「仅连接并登录」可单独把链路拉起来（不跑检查），人工核验 13/14 前也能用它补链路。

判定语义按协议 §11.1：

| 状态 | 含义 |
| --- | --- |
| `PASS` | 现象符合预期，且证据是实际收发的字节 |
| `EXPECTED` | 协议允许的正常行为（连接态扫描 0 台、DATA 大块丢帧），**不算失败，但也不等于 PASS** |
| `FAIL` | 与协议不符 |
| `SKIP` | 无条件执行（人工项），**不计入 PASS**，报告结论会标「不可签收」 |

| # | 验收项 | 自动判定依据 |
| --- | --- | --- |
| 1 | BLE 扫描与发现 | 停扫后重扫 6s，记录 `name`/`localName`/RSSI；断开态 = 真实证据。连接态仍只记 EXPECTED 并提示断开重测；「运行全部」选「断开后跑」时会自动断开→扫描→重连，一次跑完即 PASS |
| 2 | 服务与特征发现 | 重新 `discover()`，把 4 个特征的属性（`write+writeNoResponse` / `notify`）与解析依据写进证据；`uuid-weak` 直接 FAIL |
| 3 | Notify 订阅 | 订阅后发 `device.info`，CMD 通知计数必须增加；再开 `data.loopback` 写 20B，DATA 必须逐字节回传 |
| 4 | 10 次 `network.scan` | 每次校验 `count`/`aps` 结构、id 匹配、未匹配 0、缓冲残留 0；记录响应字节与分片数范围（总预算 120s，单次约 5–6s，跑满 10 次） |
| 5 | 20 字节分包 | 发一条 **420B** 的探测命令（`cmd:"acceptance.probe"`，零副作用），记录**完整命令原文 + 请求 id + 响应 id**；设备回 `unknown_command` 才能证明整行按序重组并被解析；每片必须 ≤20B |
| 6 | 长响应完整性 | `config.get`：统计字节/片数/对象数；**含 AP 字段或 `net_mode≠sta` 直接 FAIL**；再调 `network.status` 交叉核对 `sta_has_ip`/`mqtt_connected` |
| 7 | 10 次 `config.get` | 10 次全部完整，记录每次字节/片数与波动；波动 >32B 记 EXPECTED 提示核对 |
| 8 | 长响应期间发命令 | `config.get` 发出 60ms 后插入 `operation.get`（假 id），要求响应 id 匹配、返回 `not_found`、且**排在长响应之后**（§4.3 FIFO） |
| 9 | 双通道并发 | `config.get` 发出 80ms 后同时写 200B DATA，要求两个通道计数都增长、DATA 逐字节一致、无未匹配响应 |
| 10 | DATA 全矩阵 | 单帧 20B / 长帧 200B 必须逐字节一致；600B(30 片) 与 640B(32 片) 突发记录丢帧数，丢帧记 EXPECTED（`data_pipe` 深度 16、无流控）；退订后必须 0B |
| 11 | 断连与重连 | ①先用**假 token** 发一条命令，必须回 `unauthorized`（证明这条命令真受鉴权保护，否则假 token 被照收 = 鉴权没生效，直接 FAIL）；②断开后**必须扫到设备重新广播**才算「设备侧确认断连」（固件只在 DISCONNECT 事件里重启广播；系统事件/`getBLEDeviceServices` 只代表手机本地 GATT 关闭，Android 连接缓存能把 ACL 留住）；扫不到就记 SKIP 并说明「链路可能仍在、本项未取证」，不冤枉设备；③重连后会话号递增、重连必须重新发现+订阅；④**旧 token** 发同一命令必须 `unauthorized`，否则 FAIL 并写出请求/响应 id；⑤重新登录的 token 必须与旧的不同；⑥DATA 首帧必须就是新 marker（无旧字节） |
| 12 | operation 语义 | 起一个不存在的 SSID 候选：第二次 `tryconnect` 必须 `busy`、未 got_ip 就 `apply` 必须 `operation_state`、`cancel` 必须 `cancelled` 且重复 cancel 幂等；**不得出现 `wrong_password`** |
| 13 | 成功配网与 apply | 人工操作 + 自动核验：必须先在网络配置页走通 got_ip → apply（小程序会记下本次 `operation_id` 与时间，作为「这次真的配过网」的凭据，30 分钟内有效；没有这条记录就记 SKIP，避免把历史配置当成这次的成果）。回验收页点「核验配网结果」（可填目标 SSID）→ 小程序**自动断开→等重新广播→重连→再读 `config.get`/`network.status`**，要求 `net_mode=sta`、无 AP 字段、`sta_has_ip`、`mqtt_connected`、**实际连接 SSID（`connected_ssid`）与目标一致**、且重连后仍成立；若设备实际连在别的 profile（自动回退）直接 FAIL，旧固件没暴露该字段且有其它 profile 时记 EXPECTED |
| 14 | 网络救援 | 人工操作 + 两段取证：制造断网后点「① 记录断网状态」（此时必须真的无 IP/MQTT，否则只记 EXPECTED 并拒绝记录）→ 在网络配置页重新 scan→tryconnect→apply → 点「② 核验救援结果」，要求恢复 IP + MQTT、**没有回退到其它 profile**、全程 `net_mode=sta`、无 AP 字段，并写出救援前后对比与耗时。前置的「清理其它 profile」不通过时不记快照（否则测的是回退而不是 no-IP）。

第 14 项是**有状态**的，不能「记完快照就点核验」：

| 情况 | 结论 | 说明 |
| --- | --- | --- |
| 快照之后没有任何 apply | `EXPECTED` | 还没做救援，不是失败；文案会提示去网络配置页 scan → tryconnect → apply |
| 有 apply（含试连被拒） | 轮询等待最多 20s | apply 后要重新关联 + DHCP + MQTT，单次读取必然过早 |
| 20s 内恢复且连的是目标 SSID | `PASS` | 写出 operation_id、恢复耗时、轮询次数 |
| 20s 后仍无 IP / MQTT 断 / 回退 | `FAIL` | 写出 operation_id、阶段（tryconnect/apply）、等待时长、last_disconnect |

试连阶段就被拒（口令错、扫不到 AP）也算「救援动作已发生」，会走 FAIL 而不是 EXPECTED，并直接提示检查口令与 AP。 |
| 15 | iOS / Android 双端证据 | 人工项（必须两台手机）：两端各跑一遍，合并两份报告的「环境」段。单端报告不能签收 |

报告头部会自动记录：平台、系统、微信版本、会话号、写分片、通知分片长度范围、断链次数（主动/被动分开，并标出「本机确认关闭」与「设备侧广播确认」各几次）——正好是验收矩阵要求记录的那几项。

13/14 两项核验通过后会直接变成 `PASS` 并写进报告（不是 SKIP），所以一份报告可以同时包含自动化项与现场人工项的完整证据；再跑一次「运行全部」会重置这两项，需要重新核验。

运行完点「复制报告」，得到可直接贴进验收记录的文本；结论行会明确「可签收 / 不可签收 / 有条件通过」，并且 `SKIP` 永远不会被算成 `PASS`。

## 已知边界（照文档，不做额外承诺）

- 链路不加密、不配对，token 是应用层鉴权，明文链路上可被本机嗅探。
- Android 上 `closeBLEConnection` 后立刻重连，系统可能复用同一条 ACL 链路：外设收不到断连事件，连接级 token 也就不会作废。这时「旧 token 仍被接受」是**测试没断成**，不是固件问题。
- 因此本项的取证只认**设备侧信号**：断开后等外设重新广播（固件收到断连才会 `restart_advertising`）。等待窗口本身也让 ACL 自然超时（连接参数 supervision 6s），避免立刻重连又把它续上。
- 管理凭据和 Wi-Fi 口令只存内存，不写 storage、不进日志；主动断开时连凭据一起清掉。
- DATA 通道没有帧头/序号/ACK/重传，**只签收功能与边界，未签收端到端可靠性**。
- 隐藏 SSID（空 SSID）无法从列表选择。
- WPA2-企业 / WPA3 是否可用取决于设备侧支持，列表只做「需设备支持」提示。
- 未做 `config.set` + `effect:"reboot"` 后的自动重连；静态 IP 产线配置走调试页的 v0 `config.set` 预置手发。

## 回归测试（Node，无需真机）

`../_verify/` 下用 `wx` 桩驱动真实收发：

```bash
node ../_verify/ble-selftest.js          # 传输层 + 命令层 36 项
node ../_verify/provision-selftest.js    # 配网状态机 12 项
node ../_verify/acceptance-selftest.js   # 验收自检 15 项（带设备模拟器）104 项断言
node ../_verify/link-selftest.js         # 断开态自动连接/登录 35 项
node ../_verify/page-accept-selftest.js  # 验收中心 hub + T4 断开态流程 + T5 子页 34 项
node ../_verify/netdiag-selftest.js      # 网络判读/回退识别/诊断导出/profile 清理 66 项
node ../_verify/page-provision-selftest.js # 配置中心 hub + 网络/MQTT/BLE/UART 配置页 105 项
node ../_verify/t5-selftest.js             # T5 韧性测试器 41 项
node ../_verify/pframe-selftest.js         # 帧协议冻结：跨语言向量 + 流解析 + 结算口径 84 项
node ../_verify/stress-selftest.js         # 压测引擎：三模式/丢帧/乱序/断链/收尾三态 94 项
node ../_verify/page-stress-selftest.js    # 压测页面：帧长换算/对端命令/报告格式 37 项
```

### 帧协议门禁（PST v1）

`utils/pframe.js` 是压测帧的唯一实现，电脑侧对应 `tools/uart_bridge.py`。

```bash
cd tools
python3 gen_vectors.py           # 生成 ../_verify/pframe-vectors.json + pframe-flood.bin
python3 gen_vectors.py --check   # 校验产物与当前实现是否一致（改一端必红）
```

向量含 8 条 CRC、45 条 LCG（含 seq=2e9 精度边界）、21 条帧，以及一段真实 `mode_flood` 输出的 4028B 字节流。改任一端编码后必须重新生成并跑 `pframe-selftest.js`，否则跨语言一致性无声失守。

## T5 长稳韧性测试（验收页 · T5 模块）

验收中心已拆成 hub + 子页（pages/accept 只做导航与链路状态）：`pages/t4`（T4 功能自检）、`pages/t5`（T5 长稳韧性，M1 取证归此页）、`pages/stress`（传输压测）。hub 显示三个入口和各自上次结果摘要（只存计数），子页返回后自动刷新。设备页「T5 长稳测试」入口经 globalData 带模块跳转，由 hub 转发到 T5 子页。T4/T5 的判定与取证逻辑在拆分时原样搬迁，未改行为。方案与签收标准见固件仓库 `docs/BLE常态化韧性验收_T5_2026-10-24.md`。

- **计划生成**：混合场景按 3:3:2:2 分四类轮次（A 试连后取消 / B 设计内失败：错口令或不存在 SSID / C 成功 apply / D 断连重登）；也可选失败场景或连接场景单集。轮数 10（冒烟）/ 50（首轮 soak）/ 100 可选，节奏分串行（每轮冷却 1s）与紧凑（250ms）。
- **逐轮证据**：每轮保留原始请求（口令/token 脱敏为 `***`）、响应、operation_id、状态迁移序列、起止计时与结果分类；`no_slot`/`busy` 独立计数，失败轮遇到 busy/no_slot 判 FAIL 而非 EXPECTED。口令证据只记「非空布尔+长度」（`pw=非空(N)`），配合 C v2 判据：口令非空时不应出现快速 `connect_failed` 特征（基线 `t5c_cv2_20261025_130605.json`）。
- **`wifi_scan_failed`（P1-10 方案 A 配套）**：预扫描两次均败的独立错误码，配置页文案与排查提示见 `utils/errors.js`；T5 B 轮设计内失败不含它，出现即 FAIL 并计入错误分布——保持与 `ap_not_found`（扫描成功但不在场）可分辨。
- **B 轮「正式配置未被覆盖」按起始实测判**：runT5 启动时读设备实测正式 SSID 作为期望值（目标≠正式的场景——如热点只当目标——不再把正确分类的 B 轮误报成 FAIL），C 轮 apply 成功后期望更新为目标；正式配置意外漂移仍判 FAIL。
- **中止与补链**：可随时中止——停发新轮并按协议 cancel 当前活动操作；意外断连只自动补链一次（重新登录，不复用旧 token），再失败即终止整个 run。
- **M1 取证**：页内「M1 · 终态槽回收取证」按钮自动执行 slotProbe——连造 4 个失败操作占满槽 → 第 5 次 tryconnect 断言受理或 no_slot → 查旧 operation_id 是否 not_found，报告给出「新语义成立 / 旧固件行为 / 结合 busy 区分」三种结论，并提示与串口 `reclaim oldest terminal` 日志对时。
- **heap 边界**：协议层暂无 heap 字段，堆曲线以串口 diag 日志按时间戳对时；`device.status` 加法字段为 T5 二期候选。
- **口令记忆（utils/pwstore.js）**：仅当配网真正成功（拿到 IP 且 connected_ssid 为目标）才把口令存入本地 storage；`wrong_password` 时自动作废。扫描列表点选已记忆 SSID 自动回填，手动编辑即清除；扫描列表对设备已保存 profile 标「已保存」。
- **点选即弹窗配网**：点扫描列表项直接弹出口令弹窗（自定义弹层，`pages/provision/provision.wxss`）——记忆口令自动回填、开放网络免口令「直接配网」、短口令弹窗内报错；确认后就地开始配网流程。取消则保留底部表单回退（原「选 SSID → 填口令 → 开始」路径不变）。

## 输入框与已保存网络

- `.input` 固定 `height/line-height: 92rpx`、垂直 padding 为 0：Android 原生 input 在有垂直 padding 时文字与占位符会基线错位出现「重影」。
- 切换到设备已保存过的 Wi-Fi 时自动填入口令（见上文 pwstore），无需手输。

## 传输压测（验收中心 · S · 传输压测）

在 `pages/stress` 里选参数起停，调度与判定在 `utils/stress.js`，帧编解码在 `utils/pframe.js`；电脑侧对端是 `tools/uart_bridge.py`（零依赖，只需 `python3`）。

| 模式 | 本机 | 对端 | 签收什么 |
| --- | --- | --- | --- |
| L0 只收 | 不发，只解析 | `--mode flood` | 下行到达率、解析层异常 |
| L1 回显 | 发 START+DATA+END | 设备回环 或 `--mode echo` | 完整性、CRC、序号、帧级 RTT |
| L2 灌流 | 按速率主动发 | `--mode listen` / `echo` | 提交量（提交 = 写调用成功返回的字节） |

**分层字节账**：`plannedBytes`（计划）/ `submittedBytes`（BLE 写成功）/ `deviceRxBytes`（设备侧，需日志或回显旁证）/ `uartOutBytes`（PC 汇总行）。四层独立列出，缺证据写 `n/a`，**不允许相减归因**。

**收尾三态**：`no_end`（END 未到，无法断言完整）、`end_partial`（END 到了但 DATA 不足）、`complete`。收到 END 不等于传输完整；END 也可能晚于乱序的 DATA 到达，所以结算前必须等满一个静默窗口。

**判定分档**：≤200B 要求零丢零错零乱序；更大帧只要求 CRC 与内容正确，丢帧记 `EXPECTED` 并与首轮基线比（`data_pipe` 深度 16 是已知边界）。样本不足（<1KB 或 <300ms）时速率显示「数据不足」，不给数字。

**状态还原**：压测按「对端」选择改写 `data.loopback`（设备回环=on / PC 回显=off / 不改=不动）。正常结束、中止、断链、页面卸载都会还原，报告里固定写一行还原证据——否则回到 UART 页会看到发出去的数据被原样回弹。

**对端命令**由页面直接给出（含 runId），复制到电脑执行即可；runId 两端必须一致，否则上一轮迟到的 END 会被当成本轮结束，结算出假的 100%。
# wx-ble-provision
