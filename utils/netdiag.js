/**
 * 网络诊断：判断「设备当前到底连在哪个 Wi-Fi」，并产出可复核的原始证据。
 *
 * 背景（协议 §6.3）：
 *   `sta_connected=true` 只说明 STA 链路起来了，**不代表「正式配置的 AP 还连着」**。
 *   非静态模式下正式 AP 关停后，固件会自动回退到其它已保存 profile：
 *     sta_connected=true / sta_has_ip=true / sta_ip=另一个网段，
 *     sta_ssid 却仍是正式配置（那是 config 域，不是运行时）。
 *   所以不能用 `sta_connected + sta_ssid` 判「当前 Wi-Fi 还连着」。
 *
 * 判定顺序固定：
 *   1. sta_has_ip + sta_ip != 0.0.0.0  → 在线 / 断网
 *   2. connected_ssid（运行态，固件 1.3-x 起加法字段）→ 连的是哪个 SSID
 *   3. mqtt_connected                  → 是否真的上线
 *   4. last_disconnect                 → 为什么掉线/为何切换
 * 固件未暴露 connected_ssid 时只能给「未知」，再用 profile 列表提示回退风险，
 * 绝不因为「有 IP」就冒充「正式网络在线」。
 */

const LAST_DISCONNECT_TEXT = {
  none: '正常（当前无断开原因）',
  switching_profile: '正在切换到另一个已保存 profile（自动回退的直接迹象）',
  fast_path: '按正式配置快连（未走扫描）',
  no_saved_profile: '没有任何已保存 profile',
  no_saved_ap: '保存的 AP 都不在扫描结果里',
  scan_failed: '扫描失败',
};

const KIND_TEXT = {
  offline: '断网',
  trial: '在线 · 试连网络（尚未 apply）',
  formal: '在线 · 正式网络',
  fallback: '在线 · 已连接其他已保存网络',
  unknown: '在线 · 但无法确认 SSID',
};

/**
 * 测试残留 profile：T4 压测会临时建 P0-NOAP-xxxx 这类 AP，
 * 用过之后 profile 会留在设备里，成为自动回退候选（真实案例里一次留下 2 个）。
 * 它们不是产品网络，清理时不需要人工确认，直接在 UI 标出来。
 */
const RESIDUE_RE = /^(P0[-_])?NOAP[-_]/i;

function isResidue(ssid) {
  return RESIDUE_RE.test(String(ssid || '').trim());
}

function residueOf(list) {
  return (list || []).filter(isResidue);
}

function ipValid(st) {
  if (!st) return false;
  if (!st.sta_has_ip) return false;
  const ip = String(st.sta_ip || '');
  return !!ip && ip !== '0.0.0.0' && ip !== '-';
}

/** 运行态 SSID：固件新增字段，旧固件没有 → 空串 */
function runtimeSsid(st) {
  if (!st) return '';
  const v = st.connected_ssid;
  return v === undefined || v === null ? '' : String(v).trim();
}

function runtimeProfile(st) {
  if (!st) return '';
  const v = st.connected_profile;
  if (v === undefined || v === null || v === '') return '';
  return String(v);
}

function lastDisconnectText(raw) {
  const s = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!s) return '未上报';
  if (LAST_DISCONNECT_TEXT[s]) return LAST_DISCONNECT_TEXT[s];
  // 固件格式 "201(NO_AP_FOUND)" 或纯 reason 码
  const m = /^(\d+)\(([^)]+)\)$/.exec(s);
  if (m) return 'reason ' + m[1] + '（' + m[2] + '）';
  if (/^\d+$/.test(s)) return 'reason ' + s;
  return s;
}

/** network.profile.list 的返回可能是 {profiles:[]} / {count,profiles} / 数组，统一成数组 */
function profilesOf(res) {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  if (Array.isArray(res.profiles)) return res.profiles;
  if (res.data && Array.isArray(res.data.profiles)) return res.data.profiles;
  return [];
}

function ssidList(profiles) {
  return (profiles || [])
    .map(function (p) {
      return p && p.ssid ? String(p.ssid) : '';
    })
    .filter(function (s) {
      return !!s;
    });
}

/**
 * 判读运行时状态。
 * @param {object} st      network.status 的 data
 * @param {string} cfgSsid config.get 里的正式 sta_ssid
 * @param {Array}  profiles network.profile.list 的 profiles
 */
function classify(st, cfgSsid, profiles) {
  const s = st || {};
  const formal = String(cfgSsid || (s.sta_ssid || '')).trim();
  const cur = runtimeSsid(s);
  const online = ipValid(s);
  const mqtt = !!s.mqtt_connected;
  const all = ssidList(profiles);
  const others = all.filter(function (x) {
    return x !== formal;
  });
  const residue = residueOf(others);
  const candidates = others.filter(function (x) {
    return !isResidue(x);
  });

  /* 试连期间固件就是连在候选 SSID 上，此时 connected_ssid ≠ 正式 SSID 属于正常现象，
     不能报成「自动回退」，否则配网过程中会一直闪红。 */
  const trialSsid =
    s.trial && s.trial.state && s.trial.state !== 'idle' && s.trial.ssid ? String(s.trial.ssid) : '';

  let kind;
  if (!online) {
    kind = 'offline';
  } else if (cur && trialSsid && cur === trialSsid && cur !== formal) {
    kind = 'trial';
  } else if (cur && (!formal || cur === formal)) {
    kind = 'formal';
  } else if (cur) {
    kind = 'fallback';
  } else {
    kind = 'unknown';
  }

  const parts = [];
  parts.push(kind === 'offline' ? '无有效 IP' : 'sta_ip=' + (s.sta_ip || '-'));
  if (s.sta_connected && !online) parts.push('STA 已关联但未拿到 IP');
  if (!s.sta_connected && !online) parts.push('STA 未连接');
  parts.push('mqtt_connected=' + (mqtt ? 'true' : 'false'));
  if (cur) parts.push('connected_ssid=' + cur);
  else parts.push('connected_ssid=未暴露（旧固件）');
  if (formal) parts.push('正式 sta_ssid=' + formal);
  parts.push('last_disconnect=' + (s.last_disconnect || '-'));

  let hint = '';
  if (kind === 'fallback') {
    hint =
      '设备连的是「' + cur + '」（sta_ip=' + (s.sta_ip || '-') + '，是该网络的网段），不是正式配置的「' + formal + '」；' +
      'sta_connected/sta_ssid 仍为 true/正式值，只有 connected_ssid 与 IP 段能识别出这次切换。' +
      '这不是配网成功，也不是「正式 AP 还连着」。';
  } else if (kind === 'trial') {
    hint = '设备正连在试连候选「' + trialSsid + '」上，尚未 apply 到正式配置；这不是回退，等 apply 后再看。';
  } else if (kind === 'unknown' && online && others.length) {
    hint =
      '固件未暴露 connected_ssid，而设备还保存了其它 profile（' + others.join('、') + '），' +
      '当前 sta_ip 有可能来自回退网络——这条只能记「未取证」，不能算正式网络在线。' +
      '做 T4 无 IP 救援前先删除这些 profile。';
  } else if (kind === 'unknown' && online) {
    hint = '固件未暴露 connected_ssid；没有其它 profile，暂按正式 SSID 推断，但仍是推断而非证据。';
  } else if (kind === 'offline' && s.last_disconnect && s.last_disconnect !== 'none') {
    hint = '断开原因：' + lastDisconnectText(s.last_disconnect);
  }

  /* 给页面直接绑定的整句提示（WXML 里不能再套 {{}}，只能预先拼好） */
  let unknownWarn = '';
  if (kind === 'unknown' && online) {
    unknownWarn =
      '设备有 IP（' + (s.sta_ip || '-') + '）' + (mqtt ? '且 MQTT 已连接' : '但 MQTT 未连接') +
      '，但固件未暴露 connected_ssid，无法确认实际连的是哪个 SSID' +
      (others.length
        ? '；且仍保存其它 profile（' + others.join('、') + '），存在自动回退可能。这只算「未取证」，不能当成正式网络在线。'
        : '。');
  }

  let offlineWarn = '';
  if (kind === 'offline') {
    offlineWarn =
      '设备当前' + (s.sta_connected ? '已关联但没拿到 IP' : '没有连接到 Wi-Fi') +
      (s.last_disconnect && s.last_disconnect !== 'none' ? '（last_disconnect=' + s.last_disconnect + '）' : '') +
      '。BLE 是唯一的配置通道：直接在下方重新扫描并配网即可完成救援，不需要找设备的 AP（固件已删除 AP 模式）。';
  }

  /* 产品口径的两行：正式配置是「应该连的」，当前连接是「实际连着的」。
     只有两者相同且 MQTT 为真，才算正式网络在线；其余一律不能当配网成功。 */
  const formalLine = '正式配置：' + (formal || '（未配置）');
  const connLine =
    kind === 'offline'
      ? '当前连接：无（sta_ip=' + (s.sta_ip || '0.0.0.0') + '）'
      : '当前连接：' + (cur || '未暴露（旧固件）') + (online ? '（' + s.sta_ip + '）' : '（未拿到 IP）');

  let residueWarn = '';
  if (residue.length) {
    residueWarn =
      '检测到 ' + residue.length + ' 个测试残留 profile（' + residue.join('、') + '）：' +
      '它们是 T4 压测留下的 AP 名，同样会被自动回退选中。做无 IP 救援前必须一起删掉。';
  }

  return {
    kind: kind,
    label: KIND_TEXT[kind],
    online: online,
    mqtt: mqtt,
    connectedSsid: cur,
    connectedProfile: runtimeProfile(s),
    formalSsid: formal,
    profiles: all,
    others: others,
    othersText: others.join('、'),
    profilesText: all.join('、'),
    residue: residue,
    residueText: residue.join('、'),
    residueWarn: residueWarn,
    candidates: candidates,
    candidatesText: candidates.join('、'),
    formalLine: formalLine,
    connLine: connLine,
    summary: formalLine + '\n' + connLine,
    unknownWarn: unknownWarn,
    offlineWarn: offlineWarn,
    fallbackRisk: kind === 'fallback' || (kind === 'unknown' && others.length > 0),
    verifiedSsid: kind === 'formal' && !!formal,
    text: parts.join(' · ') + (hint ? '。' + hint : ''),
    hint: hint,
  };
}

/** 一行证据串（报告 / 检查项 detail 用） */
function evidence(st, cfgSsid, profiles) {
  const c = classify(st, cfgSsid, profiles);
  return {
    verdict: c,
    line:
      c.label + '：' + (c.connectedSsid ? 'connected_ssid=' + c.connectedSsid : 'connected_ssid=未暴露') +
      ' · sta_ip=' + ((st && st.sta_ip) || '-') +
      ' · sta_has_ip=' + (st && st.sta_has_ip ? 'true' : 'false') +
      ' · mqtt_connected=' + (c.mqtt ? 'true' : 'false') +
      ' · last_disconnect=' + ((st && st.last_disconnect) || '-') +
      ' · 正式 sta_ssid=' + (c.formalSsid || '(空)'),
  };
}

/**
 * 采集一次完整证据：network.status + config.get(network) + network.profile.list + config.get(bluetooth)。
 * 四个命令串行（协议要求 ≥200ms 间隔，命令层已处理），任一失败都不阻断其余几项。
 */
async function collect(ctx) {
  const protocol = ctx.protocol;
  const out = {
    at: Date.now(),
    status: null,
    config: null,
    profiles: [],
    bluetooth: null,
    errors: {},
    verdict: null,
  };

  try {
    out.status = await protocol.networkStatus();
  } catch (e) {
    out.errors.status = e && (e.code || e.message);
  }
  try {
    out.config = await protocol.configGet(['network']);
  } catch (e) {
    out.errors.config = e && (e.code || e.message);
  }
  try {
    out.profiles = profilesOf(await protocol.profileList());
  } catch (e) {
    out.errors.profiles = e && (e.code || e.message);
  }
  try {
    out.bluetooth = await protocol.configGet(['bluetooth']);
  } catch (e) {
    out.errors.bluetooth = e && (e.code || e.message);
  }

  const net = (out.config && out.config.network) || {};
  out.cfgSsid = net.sta_ssid || (out.status && out.status.sta_ssid) || '';
  out.verdict = classify(out.status, out.cfgSsid, out.profiles);
  return out;
}

/**
 * A1 看门狗证据（三态，绝不把"没读到"当成 0）：
 *   source='ok'           → 字段已获取，adv_retry_count 可判读
 *   source='read-failed'  → config.get(bluetooth) 命令失败（未获取，不能判 0）
 *   source='field-missing'→ 命令成功但字段缺失（旧固件未暴露，未获取）
 */
function btEvidence(d) {
  const raw = (d && d.bluetooth && d.bluetooth.bluetooth) || null;
  if (d && d.errors && d.errors.bluetooth) {
    return {
      source: 'read-failed',
      advRetryCount: null,
      advActive: null,
      lastError: null,
      verdict: '未获取（读取失败: ' + d.errors.bluetooth + '；不能据此判 0）',
    };
  }
  if (!raw || typeof raw.adv_retry_count !== 'number') {
    return {
      source: 'field-missing',
      advRetryCount: null,
      advActive: typeof (raw || {}).adv_active === 'boolean' ? raw.adv_active : null,
      lastError: (raw && raw.last_error) || null,
      verdict: '未获取（固件未暴露 adv_retry_count；不能据此判 0）',
    };
  }
  const rc = raw.adv_retry_count;
  return {
    source: 'ok',
    advRetryCount: rc,
    advActive: typeof raw.adv_active === 'boolean' ? raw.adv_active : null,
    lastError: raw.last_error || '',
    verdict:
      rc > 0
        ? '看门狗曾介入（adv_retry_count=' + rc + '，设备曾出现广播恢复异常）'
        : '未发现介入计数（adv_retry_count=0 表示本次设备运行以来看门狗未触发过；不能据此断言看门狗从未介入）',
  };
}

function jsonLine(v) {
  try {
    return JSON.stringify(v);
  } catch (e) {
    return '<不可序列化>';
  }
}

/**
 * 生成可直接粘贴给固件/协议方的文本块：结论 + 三段原始 JSON。
 * 原始 JSON 必须保留（不要摘要），否则无法判断是回退还是 DHCP 没起来。
 */
function renderText(d, meta) {
  const m = meta || {};
  const st = d.status || {};
  const net = (d.config && d.config.network) || {};
  const v = d.verdict || classify(st, d.cfgSsid, d.profiles);

  const lines = [];
  lines.push('=== BLE 网络诊断（T4） ===');
  if (m.time) lines.push('时间: ' + m.time);
  if (m.deviceName || m.deviceId) lines.push('设备: ' + (m.deviceName || '-') + ' / ' + (m.deviceId || '-'));
  if (m.sessionId !== undefined) lines.push('会话: #' + m.sessionId);
  if (m.env) lines.push('环境: ' + m.env);
  lines.push('结论: ' + v.label);
  lines.push(v.formalLine);
  lines.push(v.connLine);
  lines.push('解读: ' + v.text);
  lines.push('');
  lines.push('--- network.status (raw) ---');
  lines.push(d.errors.status ? '<失败: ' + d.errors.status + '>' : jsonLine(d.status));
  lines.push('');
  lines.push('--- config.get(network) (raw) ---');
  lines.push(
    d.errors.config
      ? '<失败: ' + d.errors.config + '>'
      : jsonLine({ net_mode: net.net_mode, sta_ssid: net.sta_ssid, sta_password_set: net.sta_password_set,
          sta_use_static: net.sta_use_static, sta_connected: net.sta_connected, sta_has_ip: net.sta_has_ip,
          sta_ip: net.sta_ip, last_disconnect: net.last_disconnect })
  );
  lines.push('');
  lines.push('--- network.profile.list (raw) ---');
  lines.push(d.errors.profiles ? '<失败: ' + d.errors.profiles + '>' : jsonLine({ profiles: d.profiles }));
  lines.push('');
  lines.push('--- config.get(bluetooth) (raw) ---');
  lines.push(
    d.errors.bluetooth
      ? '<失败: ' + d.errors.bluetooth + '>'
      : jsonLine(d.bluetooth && d.bluetooth.bluetooth ? d.bluetooth.bluetooth : {})
  );
  lines.push('');
  lines.push('--- 判读 ---');
  lines.push(
    'sta_ip=' + (st.sta_ip || '-') + ' · sta_has_ip=' + (st.sta_has_ip ? 'true' : 'false') +
      ' · mqtt_connected=' + (st.mqtt_connected ? 'true' : 'false')
  );
  lines.push('last_disconnect=' + (st.last_disconnect || '-') + '（' + lastDisconnectText(st.last_disconnect) + '）');
  lines.push(
    '运行态 connected_ssid=' + (v.connectedSsid || '<固件未暴露>') +
      (v.connectedProfile ? ' · connected_profile=' + v.connectedProfile : '')
  );
  lines.push('正式配置 sta_ssid=' + (v.formalSsid || '<空>'));
  lines.push('已保存 profile: ' + (v.profiles.length ? v.profiles.join('、') : '（取不到或为空）'));
  if (v.others.length) lines.push('非正式 profile（自动回退候选，救援前需删除）: ' + v.others.join('、'));
  if (v.residue.length) lines.push('测试残留 profile（T4 压测遗留，需一并删除）: ' + v.residue.join('、'));
  if (v.fallbackRisk) {
    lines.push('风险: 存在自动回退可能，当前「在线」不能证明正式 AP 连着；T4 #14 需先清理上述 profile。');
  }
  /* A1 看门狗证据（三态：介入 / 未发现介入计数 / 未获取） */
  const bt = btEvidence(d);
  lines.push(
    '蓝牙广播: adv_active=' + (bt.advActive === null ? '未获取' : bt.advActive ? 'true' : 'false') +
      ' · last_error=' + (bt.lastError || '（空/未获取）')
  );
  lines.push('看门狗判读: ' + bt.verdict);
  if (bt.source === 'ok' && bt.lastError && bt.lastError.indexOf('adv_restart:22') === 0) {
    lines.push('分诊: adv_restart:22 持续出现 = NimBLE host 级故障，看门狗无能为力，直接复位设备。');
  }
  return lines.join('\n');
}

/* ---------------------------------------------------------------------------
 * cfg_state 消费（固件 ≥1.3 / 静态 re-apply P0）：
 * network.status 新增 cfg_state(static/dhcp/fallback/offline…)、
 * persistent_use_static、persistent_static_ip。旧固件（≤1.2）无这些字段，
 * 全部特征探测：缺 cfg_state 时返回 null，页面不显示，不做任何降级假设。
 * fallback = 运行期恢复链把静态降级成了 DHCP 救援——持久配置还在，但要提示。
 * ------------------------------------------------------------------------- */
const CFG_STATE_TEXT = {
  static: '静态 IP 生效',
  dhcp: 'DHCP',
  fallback: '救援网络（DHCP 回退）',
  offline: '离线',
};

function cfgStateInfo(st) {
  const s = st || {};
  if (!s.cfg_state) {
    return null; // 旧固件无此字段：不显示、不告警
  }
  const state = String(s.cfg_state);
  const info = {
    state: state,
    text: CFG_STATE_TEXT[state] || state,
    tone: state === 'fallback' || state === 'offline' ? 'warn' : 'ok',
    fallback: state === 'fallback',
  };
  if (info.fallback) {
    info.warnText = '当前为救援网络（DHCP），持久配置未生效';
    info.hint =
      s.persistent_use_static && s.persistent_static_ip
        ? '持久配置为静态 ' + s.persistent_static_ip + '：可重新应用网络配置或重启设备恢复'
        : '持久配置未生效：可重新应用网络配置或重启设备恢复';
  }
  return info;
}

/**
 * 删除除 keepSsid 之外的所有已保存 profile（T4 无 IP 救援的前置条件）。
 * 不删 keepSsid：它是救援后要恢复的目标；空 keepSsid 时拒绝执行，避免把设备清空。
 */async function cleanupProfiles(ctx, keepSsid) {
  const keep = String(keepSsid || '').trim();
  if (!keep) {
    return { deleted: [], failed: [], kept: [], error: '未指定要保留的 SSID，拒绝清空 profile' };
  }
  const protocol = ctx.protocol;
  const list = profilesOf(await protocol.profileList());
  const deleted = [];
  const failed = [];
  const kept = [];
  for (let i = 0; i < list.length; i++) {
    const ssid = list[i] && list[i].ssid ? String(list[i].ssid) : '';
    if (!ssid) continue;
    if (ssid === keep) {
      kept.push(ssid);
      continue;
    }
    try {
      await protocol.profileDelete(ssid);
      deleted.push(ssid);
    } catch (e) {
      const code = (e && (e.code || e.message)) || 'unknown';
      // 正在使用的 profile 可能拒绝删除；这属于可接受结果，交由调用方提示
      failed.push(ssid + '(' + code + ')');
    }
  }
  return {
    deleted: deleted,
    failed: failed,
    kept: kept,
    residue: residueOf(deleted),
    error: '',
  };
}

module.exports = {
  classify,
  evidence,
  collect,
  renderText,
  btEvidence,
  cleanupProfiles,
  profilesOf,
  ssidList,
  ipValid,
  runtimeSsid,
  lastDisconnectText,
  isResidue,
  residueOf,
  cfgStateInfo,
};
