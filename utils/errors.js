/**
 * 错误码 -> 面向用户的文案。
 * 覆盖协议 §9 的 v1 错误外壳、operation.get 的 data.error，以及 BLE 层错误。
 */

const TEXT = {
  /* v1 错误外壳 */
  unauthorized: '登录已失效，请重新登录',
  auth_required: '请求未带 token，请先登录',
  invalid_credentials: '管理员账号或口令错误',
  rate_limited: '设备限流，请稍后重试',
  invalid_argument: '参数不合法，请检查输入',
  unknown_command: '设备不支持该命令',
  line_too_long: '命令超过 512B 单行上限',
  invalid_json: '命令 JSON 解析失败',
  unsupported_version: '协议版本需为 1.0',
  busy: '设备已有进行中的配网任务',
  no_slot: '设备暂不能受理新的配网任务（终态记录占满操作槽且未自动回收）',
  not_found: '该操作已被回收，请重新发起配网',
  operation_state: '当前状态不允许该操作',
  trial_invalid: '试连会话已过期，请重新配网',

  /* operation / apply / scan 错误 */
  wrong_password: 'Wi-Fi 口令错误，请重新输入',
  ap_not_found: '未找到该 Wi-Fi，请重新扫描',
  wifi_scan_failed: '设备扫描 Wi-Fi 失败（自动重试一次仍失败），未发起连接',
  connect_failed: '设备连接 Wi-Fi 失败，请重试',
  timeout: '等待设备响应超时',
  network_failed: '网络操作失败，请稍后重试',
  internal_error: '设备内部错误，可重试或复位设备（与口令错误无关，不要重复输密码）',
  cleanup_failed: '设备清理临时候选失败',
  storage_failed: '设备保存配置失败，原配置不变',
  rollback_failed: '设备回滚失败，请检查设备状态',
  apply_failed: '配置应用失败，原配置不变',
  cancelled: '操作已取消',
  expired: '操作已过期，请重新发起',

  /* B 镜像 netcheck 语义三码（369f7d27…，2026-11-07 硬件侧 A3/A2 清单）：
     拿到 IP ≠ 换网成功——设备会等联网验证判决，验证不过自动回滚原网络。
     三码都表示"候选配置未提交，设备仍在原网络"，用户只需换网重试或查新网络。 */
  verify_timeout: '网络验证超时：设备已自动回滚到原网络，可重试或检查新网络能否访问 MQTT 服务器',
  internet_unverified: '新网络无法访问 MQTT 服务器（拿到 IP 但验证不过），设备已自动回滚到原网络',
  mqtt_unavailable: 'MQTT 服务器不可用（网络可达但会话未建立），设备已自动回滚到原网络',

  /* v1-only 静态 IP 安全锁（v1_only_迁移进度 2026-11-04 §5）
     2026-11-06 补引导：这是设计行为，不是错误——但用户只看到「拒绝切换」不知道下一步，
     换网场景的唯一正解是先关静态 IP（切 DHCP），否则静态地址会跟着写到新网段上。 */
  static_ip_pinned:
    '设备处于静态 IP 锁定：静态模式拒绝切换到其它 Wi-Fi。请先在「网络配置」页把静态 IP 关闭（切回 DHCP）并保存，再换网',

  /* 客户端本地错误 */
  not_connected: '蓝牙未连接',
  disconnected: '蓝牙连接已断开，请重新连接',
  service_missing: '未发现 NUS 服务，请确认设备固件',
  /* 2026-11-08 日志分诊：模拟器没有 BLE 适配器，openBluetoothAdapter 直接 fail；
     旧实现把它拼成 ble_undefined，页面只能显示「未知错误」 */
  ble_unsupported: '当前环境不支持蓝牙：微信开发者工具模拟器没有蓝牙适配器，请用「真机调试」或手机扫码预览',
  ble_failed: '蓝牙操作失败（微信未返回错误码，可看提示里的 errMsg）',
  ble_undefined: '蓝牙操作失败（微信既未返回错误码也未返回原因），请重试或重开蓝牙',
  /* 设备重启（如 config.set 重启生效）后旧 GATT 句柄全部失效，读写即报此码——
     是本机句柄过期，不是设备硬件缺特征；页面层应走 relink 分支而不是让用户重装设备 */
  characteristic_missing: 'BLE 特征不可用：设备可能已重启或链路已失效，请重新连接后再试',
  /* 2026-11-08 串台（65D8 掉线后连到 C8E4）：连上 ≠ 连对。
     device.info 的 device_id 与目标尾号不一致时由 ensureLink 返回，不允许静默继续。 */
  device_mismatch: '连到了另一台设备（与目标不是同一台），已断开：请确认目标设备在场、断电/刷机的设备恢复后再试',
  api_unsupported: '当前微信版本不支持该蓝牙接口',
  invalid_config: '配置项不被设备接受',
  aborted: '操作已中断',
};

const HINT = {
  unauthorized: 'token 过期、被改密作废或不被接受；客户端会自动重登一次，仍失败请手动登录',
  auth_required: 'v0 外壳专用码（请求根本没带 token）；v1 外壳统一映射为 unauthorized——两者都不是口令错误',
  invalid_credentials: '口令错误，请重新输入；不要与内部错误混淆（执行表 #2/#17）',
  no_slot: '不是密码错误；新固件槽满会自动覆盖最老终态记录（终态统一保留 600s），若仍出现多为旧固件，等最老记录回收或重启设备',
  busy: '先查询/取消当前任务，不要新开',
  trial_invalid: 'got_ip 的 trial 有效期 300s，超时需重新 tryconnect',
  rate_limited: '设备限制 5 次/秒、最短 200ms 间隔',
  wrong_password: '请确认 2.4GHz 频段与口令大小写；设备不支持 5GHz',
  ap_not_found: '确认路由器 2.4GHz 已开启，设备与路由器距离合适',
  wifi_scan_failed: '多为射频状态过渡态；设备已自动重试一次，偶发可直接重试，频繁出现请结合串口 pre-scan 日志排查',
  internal_error: '与口令无关，不要反复重输密码；偶发可重试，频发结合串口日志/复位设备排查',
  static_ip_pinned: '远程换网被静态 IP 安全锁拦截：静态 IP + 不同 SSID 需先在现场经 BLE 关闭静态或确认 allow_leave_static 策略；静态 + 同 SSID 不受影响',
  ble_unsupported:
    '微信开发者工具模拟器不提供蓝牙能力，与本项目代码无关：点工具栏「真机调试」，或「预览」后手机扫码运行',
  ble_failed: '多为系统蓝牙关闭/权限被拒；看日志里的 raw.errMsg，真机上先确认系统蓝牙已打开并授权小程序',
  ble_undefined: '真机上出现需确认系统蓝牙与权限；模拟器出现属预期（无适配器）',
  verify_timeout: '多为候选网络出网慢或验证窗口太紧；直接重试一次，仍失败检查该网络的出口',
  internet_unverified: '该网络能连但上不了网（无出口/门户拦截）；换网络或恢复出口后重试',
  mqtt_unavailable: '网络通但 MQTT 服务不在线/被拒；先确认测试服务器可用再重试',
  device_mismatch: '同型号多台设备在场时最容易发生；确认目标设备已上电并按名称核对后再连（也可回设备页直接点选目标设备）',
};

/* 链路级失败码：设备重启后旧 GATT 句柄全失效，读写都会落在这里。
 * characteristic_missing 不是「设备缺特征」，是本机句柄过期——请求根本没发出去。
 * 调用方用 isLinkError 把它和「设备返回的错误码」分开：后者才是协议答案，
 * 拿前者当协议答案会误判成契约违例（2026-11-11 #12 实证：busy 之后三次
 * 调用全落 characteristic_missing，被记成「未 got_ip 就 apply 违反契约」）。 */
const LINK_ERROR_CODES = ['characteristic_missing', 'not_connected', 'disconnected', 'ble_write_timeout'];
function isLinkError(err) {
  return !!err && LINK_ERROR_CODES.indexOf(err.code) >= 0;
}

function textOf(err) {
  if (!err) return '未知错误';
  if (typeof err === 'string') return TEXT[err] || err;
  const code = err.code;
  if (code && TEXT[code]) return TEXT[code];
  return err.message || String(code || err);
}

function hintOf(err) {
  if (!err) return '';
  const code = typeof err === 'string' ? err : err.code;
  return HINT[code] || '';
}

/** 统一成 { code, text, hint } 便于页面直接渲染 */
function describe(err) {
  const code = (err && err.code) || 'unknown';
  return {
    code: code,
    text: textOf(err),
    hint: hintOf(err),
    raw: err && err.message ? err.message : '',
  };
}

module.exports = { describe, textOf, hintOf, TEXT, HINT, LINK_ERROR_CODES, isLinkError };
