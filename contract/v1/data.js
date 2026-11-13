/**
 * 本文件由 tools/gen_contract_data.js 从 contract/v1/{errors,states,timing,commands}.json
 * 确定性生成（contract_version=1.1-draft）。禁止手改；改契约流程见 contract/README.md。
 * 运行时不得直接 require .json：小程序运行时支持无保证，且无依赖文件过滤会把它
 * 剔出代码包（2026-11-10 真机事故：t3/t4/t5/t6 整页空白）。
 */
module.exports = {
  "errors": {
    "contract_version": "1.1-draft",
    "firmware_baseline": "1.3-2ef2a38 / build_sha 98f2465cb (2026-11-10)",
    "status": "基线冻结候选：先按当前真实行为成文，双方逐条签字后冻结；不签字不得据此改码",
    "$comment": "错误码登记表（单一事实源候选）。任何新增/改义必须走 docs/协议契约整改方案_2026-11-10.md §4 变更流程。",
    "wire_shapes": {
      "shell_error": {
        "where": "任何 v1 命令响应 {\"id\",\"ok\":false,\"error\":{...}}",
        "shape": {
          "code": "string",
          "message": "string"
        },
        "status": "v1 冻结，2.0 前不得改形状"
      },
      "operation_error": {
        "where": "operation.get 的 data.error",
        "shape": "flat string",
        "no_error_value": "none",
        "status": "v1 冻结；1.1 起并行新增 data.error_detail={code,message}（可选字段），2.0 再统一"
      }
    },
    "classes": {
      "auth": "认证/会话：重登一次或提示重新登录",
      "input": "参数/协议错误：不改参数重试无意义",
      "transient": "瞬态：按 retry_after_ms 重试；同码连续 N 次才按缺陷上报",
      "capacity": "容量：等待资源回收后重试",
      "state": "状态机拒绝：按当前 state 处置",
      "op_terminal": "op 终态失败码：不要原样重试，按语义处置",
      "internal": "内部错误：可重试一次，频发上报"
    },
    "codes": [
      {
        "code": "unauthorized",
        "scope": "shell",
        "class": "auth",
        "action": "relogin_once"
      },
      {
        "code": "auth_required",
        "scope": "shell",
        "class": "auth",
        "action": "relogin_once",
        "note": "v0 外壳遗留码；v1 统一为 unauthorized"
      },
      {
        "code": "invalid_credentials",
        "scope": "shell",
        "class": "auth",
        "action": "show_input_error"
      },
      {
        "code": "forbidden",
        "scope": "shell",
        "class": "auth",
        "action": "none"
      },
      {
        "code": "invalid_old_password",
        "scope": "shell",
        "class": "auth",
        "action": "show_input_error"
      },
      {
        "code": "invalid_argument",
        "scope": "shell",
        "class": "input",
        "action": "fix_request"
      },
      {
        "code": "params_required",
        "scope": "shell",
        "class": "input",
        "action": "fix_request",
        "note": "缺必填参数（如 operation_id）"
      },
      {
        "code": "invalid_param",
        "scope": "shell",
        "class": "input",
        "action": "fix_request"
      },
      {
        "code": "invalid_config",
        "scope": "shell",
        "class": "input",
        "action": "fix_request"
      },
      {
        "code": "domain_not_supported",
        "scope": "shell",
        "class": "input",
        "action": "fix_request"
      },
      {
        "code": "invalid_json",
        "scope": "shell",
        "class": "input",
        "action": "fix_request"
      },
      {
        "code": "unknown_command",
        "scope": "shell",
        "class": "input",
        "action": "fix_request"
      },
      {
        "code": "unknown_method",
        "scope": "shell",
        "class": "input",
        "action": "fix_request"
      },
      {
        "code": "unsupported_version",
        "scope": "shell",
        "class": "input",
        "action": "fix_request",
        "note": "只接受 version=1.0"
      },
      {
        "code": "line_too_long",
        "scope": "shell",
        "class": "input",
        "action": "fix_request",
        "note": "单行上限 512B"
      },
      {
        "code": "password_too_short",
        "scope": "shell",
        "class": "input",
        "action": "show_input_error"
      },
      {
        "code": "rate_limited",
        "scope": "shell",
        "class": "transient",
        "action": "retry",
        "retry_after_ms": 350,
        "note": "全通道 5 次/秒、最短 200ms；客户端内部 auth.login 重试同样受限"
      },
      {
        "code": "busy",
        "scope": "shell",
        "class": "transient",
        "action": "retry",
        "retry_after_ms": 1500,
        "note": "仅适用「op 占用」场景：有活动 op，先 operation.get，必要时 network.cancel 再重试。scan 节流是另一语义（见 timing.json#wifi.scan_throttle：残余冷却自扫描结束起算 ≤3s），不套用本值"
      },
      {
        "code": "conflict",
        "scope": "shell",
        "class": "transient",
        "action": "retry",
        "retry_after_ms": 1000
      },
      {
        "code": "network_failed",
        "scope": "shell",
        "class": "transient",
        "action": "retry",
        "retry_after_ms": 2000
      },
      {
        "code": "connect_timeout",
        "scope": "shell",
        "class": "transient",
        "action": "retry",
        "retry_after_ms": 2000
      },
      {
        "code": "restart_failed",
        "scope": "shell",
        "class": "internal",
        "action": "retry_once"
      },
      {
        "code": "save_failed",
        "scope": "shell",
        "class": "op_terminal",
        "action": "check_device"
      },
      {
        "code": "internal_error",
        "scope": "both",
        "class": "internal",
        "action": "retry_once",
        "note": "与口令无关，禁止引导用户重输密码"
      },
      {
        "code": "no_slot",
        "scope": "shell",
        "class": "capacity",
        "action": "wait",
        "wait_hint": "终态保留 600s；满表时新请求会回收最老终态记录；仍出现多为旧固件"
      },
      {
        "code": "not_found",
        "scope": "both",
        "class": "state",
        "action": "reprovision",
        "note": "op 已被回收或 id 不存在"
      },
      {
        "code": "operation_state",
        "scope": "both",
        "class": "state",
        "action": "read_state",
        "note": "当前 state 不允许该动作（如 got_ip 前 apply、success 后 cancel）"
      },
      {
        "code": "trial_invalid",
        "scope": "both",
        "class": "state",
        "action": "reprovision",
        "note": "试用会话过期（300s）或已拆链"
      },
      {
        "code": "cancelled",
        "scope": "both",
        "class": "state",
        "action": "none"
      },
      {
        "code": "expired",
        "scope": "both",
        "class": "state",
        "action": "reprovision",
        "note": "accepted 45s / got_ip 300s 到期；终态集合成员（客户端必须处理）"
      },
      {
        "code": "guard_rejected",
        "scope": "shell",
        "class": "state",
        "action": "none",
        "note": "静态 IP 锁定等策略门（见 static_ip_pinned）"
      },
      {
        "code": "wrong_password",
        "scope": "op",
        "class": "op_terminal",
        "action": "fix_credentials",
        "note": "无线层实测=4WAY_HANDSHAKE_TIMEOUT(15/202/2)、关联成功但密钥协商失败"
      },
      {
        "code": "ap_not_found",
        "scope": "op",
        "class": "op_terminal",
        "action": "rescan",
        "note": "对应 reason 201/203"
      },
      {
        "code": "connect_failed",
        "scope": "op",
        "class": "op_terminal",
        "action": "retry",
        "note": "其余 reason 一律此码；≤4s 快速 abort 属瞬态（旧链断开事件未观测），可重试一次"
      },
      {
        "code": "wifi_scan_failed",
        "scope": "op",
        "class": "op_terminal",
        "action": "retry",
        "note": "候选预扫描两次失败，未进入连接"
      },
      {
        "code": "cleanup_failed",
        "scope": "op",
        "class": "op_terminal",
        "action": "check_device"
      },
      {
        "code": "rollback_failed",
        "scope": "op",
        "class": "op_terminal",
        "action": "check_device"
      },
      {
        "code": "storage_failed",
        "scope": "op",
        "class": "op_terminal",
        "action": "check_device"
      },
      {
        "code": "apply_failed",
        "scope": "op",
        "class": "op_terminal",
        "action": "check_device"
      },
      {
        "code": "verify_timeout",
        "scope": "op",
        "class": "op_terminal",
        "action": "retry_once_then_check_network",
        "note": "验证等待 25s 上限到期"
      },
      {
        "code": "internet_unverified",
        "scope": "op",
        "class": "op_terminal",
        "action": "change_network",
        "note": "拿到 IP 但 broker 路径不通；已自动回滚"
      },
      {
        "code": "mqtt_unavailable",
        "scope": "op",
        "class": "op_terminal",
        "action": "check_broker",
        "note": "TCP 通但 MQTT 会话未建立；已自动回滚"
      },
      {
        "code": "wifi_config_offline",
        "scope": "op",
        "class": "transient",
        "action": "retry",
        "retry_after_ms": 1500,
        "max_retries": 3,
        "note": "cancel/expire 清理的 restore 窗口（实测 2-6s）内入口门拒绝；瞬态非缺陷"
      },
      {
        "code": "static_ip_pinned",
        "scope": "both",
        "class": "op_terminal",
        "action": "turn_off_static_first"
      },
      {
        "code": "last_profile",
        "scope": "both",
        "class": "op_terminal",
        "action": "none",
        "note": "不允许删除最后一个 profile"
      },
      {
        "code": "timeout",
        "scope": "op",
        "class": "state",
        "action": "reprovision",
        "note": "与 expired 配对出现的 error 值（expired/timeout）"
      },
      {
        "code": "none",
        "scope": "op",
        "class": "state",
        "action": "none",
        "note": "无错误的规范值；客户端不得把缺省/空串当 none"
      }
    ]
  },
  "states": {
    "contract_version": "1.1-draft",
    "firmware_baseline": "1.3-9e1d6c5 / build_sha 8cc566bd0 (2026-11-10)",
    "states": [
      "free",
      "accepted",
      "connecting",
      "got_ip",
      "committing",
      "success",
      "failed",
      "cancelled",
      "expired"
    ],
    "active_states": [
      "accepted",
      "connecting",
      "got_ip",
      "committing"
    ],
    "terminal_states": [
      "success",
      "failed",
      "cancelled",
      "expired"
    ],
    "$comment_terminal": "客户端轮询跳出条件必须等于本集合。2026-11-08 事故：客户端漏 expired → op 到期后空转到超时，误报客户端超时。",
    "transitions": {
      "accepted": [
        "connecting",
        "cancelled",
        "expired",
        "failed"
      ],
      "connecting": [
        "got_ip",
        "failed",
        "cancelled",
        "expired"
      ],
      "got_ip": [
        "committing",
        "success",
        "failed",
        "cancelled",
        "expired"
      ],
      "committing": [
        "success",
        "failed"
      ],
      "success": [],
      "failed": [],
      "cancelled": [],
      "expired": []
    },
    "ttl": {
      "accepted_ms": 45000,
      "got_ip_ms": 300000,
      "terminal_retention_ms": 600000,
      "slots": 4,
      "reclaim_rule": "满表时新请求回收最老终态记录；同 key 重试在保留期内幂等返回原终态"
    },
    "got_ip_semantics": {
      "definition": "IP + 联网验证（broker TCP 路径）+ MQTT 会话就绪；三者缺一不交付 got_ip",
      "since": "DEF-NET-001（2026-11-07），在 wire 版本 1.0 内实施",
      "freeze": "契约 v1.1 起冻结；再改语义必须升 minor 并双方同批上线"
    },
    "stages": {
      "fields": [
        "wifi_connected",
        "ip_acquired",
        "internet_verified",
        "mqtt_connected"
      ],
      "source": "operation 交付 got_ip 时刻的 per-op 快照（P6）",
      "assertion_rule": "客户端只在 state=got_ip 的当次响应上断言四阶段；终态之后不得断言",
      "v1_known_caveat": "op job 清理后 operation.get 回落读活运行态，apply 后重建链路的数秒内可能四项全 false；1.1 计划新增 stages_source: snapshot|live 显式标注",
      "failed_trace_rule": "失败终态保留已完成阶段（failed 时 stages 仍可读到最后快照）"
    },
    "operation_get": {
      "args": {
        "operation_id": "string, required"
      },
      "success_data": {
        "operation_id": "string",
        "state": "enum above",
        "error": "flat string（无错=none）",
        "trial_id": "string, 仅试用存在时",
        "ssid": "string, 仅试用存在时",
        "stages": {
          "wifi_connected": "bool",
          "ip_acquired": "bool",
          "internet_verified": "bool",
          "mqtt_connected": "bool"
        }
      },
      "implemented_1_1": {
        "since": "1.3-2ef2a38 (2026-11-10, C8E4 已烧写)",
        "fields": [
          "error_detail:{code,message}",
          "finished_uptime_ms",
          "stages_source"
        ],
        "stages_source": "snapshot|live——命中 job/终态快照缓存=snapshot；仅未命中才 live",
        "terminal_snapshot_retention": "4 槽按 op id 的进程内缓存；job 清理后仍返回该 op 最后阶段真值",
        "wire_evidence": "op-36A936F9E7909901 终态 +5s：stages 四项全 true、stages_source=snapshot、finished_uptime_ms=61305"
      }
    },
    "apply_preconditions": {
      "required_state": "got_ip",
      "gate": "per-op 快照 internet_verified 必须为 true；否则 apply 返回 verify_timeout 语义拒绝",
      "violations": {
        "before_got_ip": "operation_state",
        "after_terminal": "not_found 或 operation_state",
        "gate_missing": "apply rejected: trial verification missing（服务端日志）"
      }
    }
  },
  "timing": {
    "contract_version": "1.1-draft",
    "firmware_baseline": "1.3-2ef2a38 / build_sha 98f2465cb (2026-11-10)",
    "$comment": "计时与容量常量登记表。改任何一个值都算语义变更（§4 变更流程）。",
    "ble_transport": {
      "cmd_line_max_bytes": 512,
      "cmd_line_overflow_error": "line_too_long",
      "write_fragment_bytes_default": 20,
      "mtu_default": 23,
      "notify_fragment_max_bytes_default": 20,
      "cmd_rate_per_sec": 5,
      "cmd_min_interval_ms": 200,
      "rate_limit_error": "rate_limited",
      "rate_limit_retry_ms": 350,
      "$comment_rate": "限流按通道（transport）计，认证重登与业务请求共用同一配额。2026-11-09 实测：并发 401 后合并重登撞 200ms 窗被拒，客户端再发一次——属客户端应节流的盲区。"
    },
    "auth": {
      "token_ttl_ms": 600000,
      "token_storage": "RAM only（不落 NVS，重启即失效）",
      "token_invalidated_on": [
        "BLE 断连",
        "同来源重新登录",
        "改密（全来源作废）"
      ],
      "token_slots": "按来源分槽（BLE/UART/MQTT/HTTP 互不覆盖）",
      "cross_device_rule": "token 绑定设备实例；A 的 token 在 B 上必须 unauthorized"
    },
    "operation": {
      "accepted_ttl_ms": 45000,
      "got_ip_ttl_ms": 300000,
      "terminal_retention_ms": 600000,
      "slots": 4,
      "$comment_accepted": "45s 覆盖连接 15s + 验证 25s + 余量；测试钩子可 clamp [500,60000]"
    },
    "netcheck": {
      "budget_ms": 25000,
      "tcp_timeout_ms": 2500,
      "tcp_attempts": 3,
      "tcp_retry_gap_ms": 2000,
      "dns_budget_ms": 3000,
      "mqtt_grace_ms": 4000,
      "poll_ms": 100,
      "verify_wait_ms": 25000,
      "fail_stages": [
        "internet",
        "mqtt"
      ],
      "skipped_when": "mqtt_host 为空或 port=0（stage=skipped，不伪装成已验证）"
    },
    "wifi": {
      "tryconnect_connect_timeout_ms": 15000,
      "scan_done_wait_ms": 15000,
      "scan_lock_max_ms": 20000,
      "scan_time_rule": "BLE 开启时必须用默认 active scan time（0/0）；自定义 50/100ms 会被共存调度饿死（DEF-SCAN-002）",
      "scan_throttle_s": 3,
      "scan_throttle_client_rule": "残余冷却自「扫描结束」起算（客户端记 scanDoneAt，≤3s）；固定等 1s 是 2026-11-09 实测的待修行为（连接吃 2 次 busy、单轮 ~7.6s），不冻结",
      "scan_throttle_error": "busy（与 op 占用的 busy 同码不同语义；本项不套用 retry_after_ms=1500）"
    },
    "ble_link": {
      "idle_terminate_unsubscribed_s": 90,
      "idle_terminate_subscribed_s": 300,
      "idle_terminate_subscribed_s_note": "自 1.3-9e1d6c5 起生效（C8E4 已烧写 2026-11-10 08:02）；65D8 仍为 1.3-1ebfc70（订阅豁免），待刷同镜像。端到端 300s 回收时延待手机侧验证（PC 适配器 LL 过程超时无法覆盖）。11-09 及以前固件=订阅豁免，不得按本值判旧机。",
      "idle_terminate_rule": "双向静默（无 GATT 写且无 notify 成功交出）≥ 阈值；无在途 net op；终止后自动广播",
      "adv_watchdog_silent_s": 5,
      "conn_param_policy": "设备按 policy 请求 itvl/sup 更新（如对端 sup=420ms 会请求调整）"
    },
    "network_recovery": {
      "backoff_sequence_s": [
        5,
        10,
        30,
        60
      ],
      "ble_connected_suppress": "BLE 连接期间事件链重试抑制，120s formal-only monitor 接管",
      "note": "BLE 连接态拆链后不自动重连是产品决策 A；apply 正常提交时由 config 重放接管"
    },
    "derived_client_budgets": {
      "tryconnect_worst_case_ms": 45000,
      "op_poll_interval_recommended_ms": 500,
      "post_apply_verify_budget_ms": 60000,
      "cancel_then_new_op_min_wait_ms": 2000,
      "$comment_cancel_wait": "cancel/expire 清理的 restore 窗口实测 2-6s；立即重发会得 wifi_config_offline 或快速 connect_failed（瞬态）",
      "link_recovery": {
        "device_self_heal_subscribed_s": 300,
        "client_scan_budget_ms": 26000,
        "rule": "设备订阅态僵尸链路自救上限 300s，远大于客户端 26s 扫描预算——客户端必须在扫描两窗失败后提供适配器级重启（resetAdapter，按钮触发）作为唯一快速恢复路径；不得依赖等待",
        "evidence": "2026-11-09/11-10 两次实测：conn=1/rx_age>90s 期间设备依规不广播，客户端 26s 扫不到"
      },
      "client_adv_wait_ms": 12000,
      "client_adv_wait_rule": "断链后等外设重新广播的窗口（设备侧断连证据）；与 scan 预算分开计。客户端 P2-2 已收口为单常量，Phase 3 起改读本值",
      "client_link_stale_code": "link_stale（客户端本地结果码，非 wire 错误码）：拆旧链后 waitForAdvertising 未见广播 → 走适配器重启，不烧扫描窗口"
    },
    "status": "基线冻结候选（与 errors.json/states.json 同版本）"
  },
  "commands": {
    "contract_version": "1.1-draft",
    "firmware_baseline": "1.3-9e1d6c5 / build_sha 8cc566bd0 (2026-11-10)",
    "$comment": "命令表（单一事实源候选）。args 命名冻结：ssid/password/operation_id/idempotency_key。改任何既有字段名=破坏性变更。",
    "envelope": {
      "request": {
        "id": "string|number（回显必须一致）",
        "version": "1.0",
        "cmd": "string",
        "args": "object"
      },
      "success": {
        "id": "echo",
        "ok": true,
        "data": "object"
      },
      "error": {
        "id": "echo",
        "ok": false,
        "error": {
          "code": "string",
          "message": "string"
        }
      }
    },
    "commands": {
      "device.info": {
        "args": {},
        "data": {
          "model": "string",
          "firmware": "string（1.3-<git短SHA>）",
          "build_sha": "string（ELF SHA-256 前 9 位）",
          "device_id": "IotHub-<尾号>",
          "build_variant": "string",
          "protocol_versions": "array",
          "security": {
            "link_encrypted": "bool",
            "bonded": "bool",
            "l2_ready": "bool",
            "sensitive_writes_allowed": "bool"
          }
        },
        "client_timeout_ms": 10000,
        "notes": "不含 uptime_ms/reset_reason（在 device.status，见下）。身份绑定以 device_id 尾号为准（MAC 尾号不同源，不参与）。wire 实录 2026-11-10（1.3-9e1d6c5）核对。"
      },
      "device.status": {
        "args": {},
        "data": {
          "model": "string",
          "firmware": "string",
          "build_sha": "string",
          "device_id": "string",
          "uptime_ms": "number（客户端时间线与串口对时的唯一锚）",
          "reset_reason": "string（poweron|sw|…）",
          "partition": "object",
          "heap": "object",
          "mqtt": {
            "connected": "bool",
            "connecting": "bool",
            "last_error": "string",
            "outbox": "number",
            "telemetry_shed": "number"
          },
          "network": {
            "mode": "string",
            "cfg_state": "string",
            "sta_connected": "bool",
            "sta_has_ip": "bool",
            "sta_ip": "string",
            "sta_ssid": "string",
            "connected_ssid": "string",
            "connected_profile": "number",
            "internet_verified": "bool",
            "net_verify_stage": "string",
            "mqtt_connected": "bool",
            "nc_tcp_fails_last": "number",
            "nc_tcp_last_errno": "number",
            "last_disconnect": "string",
            "rssi": "number",
            "rssi_valid": "bool",
            "channel": "number",
            "bssid": "string",
            "persistent_use_static": "bool",
            "persistent_static_ip": "string",
            "password_set": "bool",
            "trial": "object"
          },
          "ble": {
            "advertising": "bool",
            "connected": "bool",
            "conn_find": "number",
            "mtu": "number",
            "adv_retry_count": "number",
            "rx_age_ms": "number",
            "runtime_mode": "number",
            "last_error": "string"
          }
        },
        "client_timeout_ms": 10000,
        "notes": "僵尸链路判据：ble.connected=true 且 ble.rx_age_ms>90000（adv_retry_count 恒 0 不代表看门狗正常——设备认为自己还连着，从未进广播重试）。wire 实录 2026-11-10（1.3-9e1d6c5）逐字段核对。"
      },
      "auth.login": {
        "args": {
          "username": "string",
          "password": "string"
        },
        "data": {
          "token": "string(32)",
          "expires_in": "number(600)"
        },
        "errors": [
          "invalid_credentials",
          "rate_limited"
        ],
        "client_timeout_ms": 10000,
        "notes": "token 只存内存；断连即作废；重登作废旧 token（同来源单槽）"
      },
      "network.status": {
        "args": {},
        "data": {
          "sta_connected": "bool",
          "sta_has_ip": "bool",
          "sta_ip": "string",
          "last_disconnect": "string",
          "connected_ssid": "string",
          "connected_profile": "number",
          "internet_verified": "bool",
          "net_verify_stage": "string(none|internet|mqtt|skipped)",
          "nc_tcp_fails_last": "number",
          "nc_tcp_last_errno": "number",
          "rssi": "number",
          "channel": "number",
          "bssid": "string",
          "rssi_valid": "bool",
          "net_mode": "string",
          "mqtt_connected": "bool",
          "sta_ssid": "string",
          "bluetooth": {
            "advertising": "bool",
            "adv_retry_count": "number",
            "rx_age_ms": "number",
            "conn": "number"
          }
        },
        "client_timeout_ms": 10000,
        "notes": "sta_has_ip≠已联网；判联网看 internet_verified。僵尸链路判据：conn=1 且 rx_age_ms>90000（adv_retry_count 恒 0 不代表看门狗正常）"
      },
      "network.scan": {
        "args": {
          "$ref": "见固件 cmd.c"
        },
        "data": {
          "aps": "array",
          "count": "number"
        },
        "errors": [
          "busy",
          "wifi_scan_failed"
        ],
        "client_timeout_ms": 30000,
        "notes": "固件 3s 节流回 busy（等 1s 重试）；BLE 开启下扫描 5-8s 属正常"
      },
      "network.tryconnect": {
        "args": {
          "ssid": "string",
          "password": "string",
          "idempotency_key": "string, 建议"
        },
        "data": {
          "operation_id": "string",
          "state": "accepted"
        },
        "possible_errors": [
          "busy",
          "wifi_config_offline",
          "invalid_argument",
          "static_ip_pinned",
          "wifi_scan_failed"
        ],
        "client_timeout_ms": 20000,
        "notes": "受理回包必须在操作完成前出站；got_ip 语义见 states.json"
      },
      "operation.get": {
        "args": {
          "operation_id": "string, required"
        },
        "data": "见 states.json#operation_get（1.3-2ef2a38 起含 error_detail/finished_uptime_ms/stages_source）",
        "possible_errors": [
          "not_found",
          "params_required",
          "invalid_argument"
        ],
        "client_timeout_ms": 10000,
        "notes": "轮询跳出=terminal_states(4)；500ms 间隔建议"
      },
      "network.apply": {
        "args": {
          "operation_id": "string, required"
        },
        "data": {
          "operation_id": "string",
          "state": "success",
          "saved": "bool",
          "applied": "bool"
        },
        "possible_errors": [
          "params_required",
          "operation_state",
          "not_found",
          "verify_timeout",
          "storage_failed",
          "apply_failed",
          "static_ip_pinned"
        ],
        "client_timeout_ms": 15000,
        "notes": "前置 state=got_ip；apply success≠已拿到 IP，需继续轮询 network.status 直到 sta_has_ip 且 connected_ssid=目标"
      },
      "network.cancel": {
        "args": {
          "operation_id": "string, required"
        },
        "data": {
          "operation_id": "string",
          "state": "cancelled"
        },
        "possible_errors": [
          "operation_state",
          "not_found"
        ],
        "client_timeout_ms": 10000,
        "notes": "cancel 返回≠清理收敛：restore 窗口 2-6s 内新 tryconnect 可能得 wifi_config_offline（瞬态，重试）"
      },
      "config.get": {
        "args": {},
        "data": "配置对象（~1.1KB）",
        "client_timeout_ms": 30000
      },
      "config.set": {
        "args": "配置对象（域级）",
        "data": {
          "effect": "none|reboot",
          "changed": "array"
        },
        "client_timeout_ms": 30000
      },
      "network.profile.list": {
        "args": {},
        "client_timeout_ms": 15000
      },
      "network.profile.delete": {
        "args": {
          "profile_id": "string"
        },
        "possible_errors": [
          "last_profile",
          "not_found"
        ],
        "client_timeout_ms": 15000
      },
      "data.loopback": {
        "args": {
          "on": "bool"
        },
        "client_timeout_ms": 10000
      }
    }
  }
};
