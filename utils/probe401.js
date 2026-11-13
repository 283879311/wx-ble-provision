/**
 * T4 #23 并发 401 时序实验（2026-11-08）
 *
 * 目的：只用观测回答一个问题——「两条请求同时携带同一个失效会话 token，
 * 各收到真实 unauthorized 后，客户端实际发出几条 auth.login」。
 *
 * 边界（重要）：
 *   本模块 **不修改任何 401 处理逻辑**，只做三件事：
 *     1. 缓存现场的 token，把会话槽临时指向一个 32 字符伪造 token；
 *     2. 并发发两条 network.status（走正常 `_call` 路径 → 会进入 401 重试分支）；
 *     3. 用 onLog 钩子 + stats 差值取证。
 *   token 注入走 `protocol.token` 赋值（会话槽），**不传 opts.token**——
 *   显式传 token 会命中 H8「负向探测不自动重登」分支，压根测不到重试路径。
 *
 * 为什么伪造会话 token 而不是走改密作废：
 *   改密是特权操作且中断不可恢复（#25 已冻结）。伪造一个设备不可能签发的
 *   token，设备同样回 unauthorized，走的是同一条 `_callDetailed` 401 分支，
 *   不依赖任何特权操作，可反复执行。
 *
 * 两段实验：
 *   E1 自然并发（默认 5 轮）：两条同时发，看 authLogins。
 *      只能证明「当前时序下没复现」，不能证明竞态不存在——设备回 401 很快，
 *      两条 401 通常都落在首次登录的在途窗口内。
 *   E2 可控迟到：A 先走完「401→登录→重试成功」（此时 H9 在途窗口已关闭），
 *      再把同一个失效 token 塞回会话槽发 B。若 B 又登录一次（authLogins=1），
 *      说明代码没有「请求带的 token 已被并发重登刷新过 → 直接用当前 token 重试」
 *      这一判断，迟到 401 会真实触发第二次登录。E2 的理想值是 0。
 */

const sleep = (ms) =>
  new Promise(function (r) {
    setTimeout(r, ms);
  });

/** 32 字符伪造 token：设备不可能签发，且日志里一眼可辨（不含任何真实凭据） */
function probeToken() {
  return ('T4stale401probe' + '00000000000000000000000000000000').slice(0, 32);
}

function settle(p) {
  return p.then(
    function (v) {
      return { ok: true, value: v };
    },
    function (e) {
      return { ok: false, error: e || {} };
    }
  );
}

/** 前置检查：必须有会话 token 与内存凭据，否则 401 后无法重登 */
function readinessOf(protocol) {
  if (!protocol) return { verdict: 'invalid', reason: 'not_ready', detail: '无协议实例' };
  if (!protocol.loggedIn) {
    return { verdict: 'invalid', reason: 'not_ready', detail: '未登录：请先连接设备并登录（本实验需要内存凭据来重登）' };
  }
  if (typeof protocol.hasCredentials === 'function' && !protocol.hasCredentials()) {
    return { verdict: 'invalid', reason: 'not_ready', detail: '无内存凭据：重连后凭据已清，请先在设备页重新登录' };
  }
  if (typeof protocol.snapshot !== 'function') {
    return { verdict: 'invalid', reason: 'not_ready', detail: '协议实例缺少 snapshot()，无法取计数基线' };
  }
  return null;
}

/** 把会话槽指向伪造 token；返回现场快照，供失败时回滚 */
function setStale(protocol, tok) {
  const keep = { token: protocol.token, tokenExpiresAt: protocol.tokenExpiresAt };
  protocol.token = tok;
  protocol.tokenExpiresAt = 0; // 置 0 可同时跳过「快过期主动续期」（该分支要求 tokenExpiresAt 为真）
  return keep;
}

/** 日志钩子：只旁观，不改内容；恢复时还原原 onLog */
function watch(protocol) {
  const prev = protocol.onLog;
  const rec = { tx: [], rx: [], stop: null };
  protocol.onLog = function (dir, text, extra) {
    try {
      if (extra && extra.id !== undefined) {
        if (dir === 'tx') rec.tx.push({ id: String(extra.id), cmd: String(extra.cmd || ''), at: Date.now() });
        /* 只有失败响应才带 error 字段；rx 的 id 就是响应 id */
        if (dir === 'rx' && extra.error) rec.rx.push({ id: String(extra.id), error: String(extra.error), at: Date.now() });
      }
    } catch (e) {
      /* 观测失败不能打断实验 */
    }
    if (typeof prev === 'function') {
      try {
        prev(dir, text, extra);
      } catch (e) {
        /* 页面自己的日志回调异常不影响取证 */
      }
    }
  };
  rec.stop = function () {
    protocol.onLog = prev;
  };
  return rec;
}

/**
 * 单轮：注入失效 token → 并发两条 network.status → 收集证据。
 * 返回结构化观测，不抛异常（异常一律折成 verdict=invalid/defect）。
 */
async function runConcurrentOnce(protocol, opts) {
  const bad = readinessOf(protocol);
  if (bad) return bad;
  const o = opts || {};
  const STALE = probeToken();
  const s0 = protocol.snapshot();
  const keep = setStale(protocol, STALE);
  const rec = watch(protocol);
  const t0 = Date.now();
  let outs;
  try {
    outs = await Promise.all([settle(protocol.networkStatus()), settle(protocol.networkStatus())]);
  } catch (e) {
    outs = [
      { ok: false, error: { code: 'harness_error', message: (e && e.message) || '' } },
      { ok: false, error: { code: 'harness_error', message: (e && e.message) || '' } },
    ];
  } finally {
    rec.stop();
  }
  if (!o.noSleep) await sleep(0);
  const s1 = protocol.snapshot();

  /* 实验没触发任何登录（token 仍是伪造值）：说明伪造 token 没被设备拒绝，
     或整轮被前置拦住——两种情况都不能判 PASS，必须回滚现场。 */
  const tokenStillStale = protocol.token === STALE;
  if (tokenStillStale) {
    protocol.token = keep.token;
    protocol.tokenExpiresAt = keep.tokenExpiresAt;
  }

  const rel = function (t) {
    return '+' + (t - t0) + 'ms';
  };
  const reqIds = rec.tx
    .filter(function (x) {
      return x.cmd === 'network.status';
    })
    .map(function (x) {
      return x.id;
    });
  const u401 = rec.rx.filter(function (x) {
    return x.error === 'unauthorized' || x.error === 'auth_required';
  });
  const logins = rec.tx.filter(function (x) {
    return x.cmd === 'auth.login';
  });
  const dLogin = s1.authLogins - s0.authLogins;
  const dRetry = s1.authRetries - s0.authRetries;
  const failCodes = outs
    .filter(function (r) {
      return !r.ok;
    })
    .map(function (r) {
      return (r.error && r.error.code) || 'unknown';
    });

  /* 判定链（严格按实验矩阵）：先证明「两条都是真实 401」，再谈登录条数 */
  const idMatched =
    u401.length === 2 &&
    u401[0].id !== u401[1].id &&
    u401.every(function (x) {
      return reqIds.indexOf(x.id) >= 0;
    });
  const counterConsistent = dLogin === logins.length; // 计数器与 tx 条数互为佐证
  const rotated = !!protocol.token && protocol.token !== STALE;
  const bothOk = outs.every(function (r) {
    return r.ok;
  });

  let verdict = 'invalid';
  let note = '';
  if (!bothOk && failCodes.every(function (c) { return c === 'timeout' || c === 'disconnected'; })) {
    verdict = 'invalid';
    note = '请求超时/断链，实验无效（不能判 PASS）：' + failCodes.join(',');
  } else if (u401.length === 0 && bothOk) {
    verdict = 'invalid';
    note = '伪造 token 未被拒绝（0 条 401 却成功），设备未校验 token 或注入未生效';
  } else if (u401.length !== 2) {
    verdict = 'invalid';
    note = '只取到 ' + u401.length + ' 条真实 401（应为 2），实验无效';
  } else if (!idMatched) {
    verdict = 'invalid';
    note = '401 响应 id 与请求 id 不匹配（请求 ' + reqIds.join(',') + ' / 响应 ' + u401.map(function (x) { return x.id; }).join(',') + '），实验无效';
  } else if (!counterConsistent) {
    verdict = 'invalid';
    note = 'authLogins 增量(' + dLogin + ') 与 auth.login tx 条数(' + logins.length + ') 不一致，计数点有误';
  } else if (dLogin >= 2) {
    verdict = 'defect';
    note = '重复登录：两条 401 各触发一次 auth.login';
  } else if (dLogin === 0) {
    verdict = 'invalid';
    note = '伪造 token 未被拒绝（0 次登录却成功），设备未校验 token 或注入未生效';
  } else if (!bothOk) {
    verdict = 'defect';
    note = '重试后仍失败（' + failCodes.join(',') + '）：token 槽被并发登录覆盖，属功能缺陷';
  } else if (!rotated) {
    verdict = 'invalid';
    note = '结束时 token 仍是伪造值或为空';
  } else {
    verdict = 'clean';
    note = 'authLogins=1，两条请求均成功';
  }

  const trace = u401
    .map(function (x) {
      return '401#' + x.id + '@' + rel(x.at);
    })
    .concat(
      logins.map(function (x) {
        return 'login#' + x.id + '@' + rel(x.at);
      })
    )
    .concat(
      reqIds.slice(2).map(function (id, i) {
        return 'retry#' + id + '@' + rel(rec.tx.filter(function (x) { return x.id === id; })[0].at);
      })
    )
    .join(' → ');

  return {
    verdict: verdict,
    reason: verdict === 'invalid' ? 'invalid' : '',
    detail: note,
    dLogin: dLogin,
    dRetry: dRetry,
    u401Ids: u401.map(function (x) {
      return x.id;
    }),
    loginIds: logins.map(function (x) {
      return x.id;
    }),
    reqIds: reqIds,
    bothOk: bothOk,
    failCodes: failCodes,
    rotated: rotated,
    counterConsistent: counterConsistent,
    trace: trace,
  };
}

/**
 * 单次「失效 token 请求」：注入 → 发一条 → 收集（供 E2 复用来分段测量）。
 * 与 runConcurrentOnce 的区别只是并发度为 1。
 */
async function fireStaleOnce(protocol) {
  const bad = readinessOf(protocol);
  if (bad) return bad;
  const STALE = probeToken();
  const s0 = protocol.snapshot();
  const keep = setStale(protocol, STALE);
  const rec = watch(protocol);
  const t0 = Date.now();
  const out = await settle(protocol.networkStatus());
  rec.stop();
  const s1 = protocol.snapshot();
  if (protocol.token === STALE) {
    protocol.token = keep.token;
    protocol.tokenExpiresAt = keep.tokenExpiresAt;
  }
  const u401 = rec.rx.filter(function (x) {
    return x.error === 'unauthorized' || x.error === 'auth_required';
  });
  const logins = rec.tx.filter(function (x) {
    return x.cmd === 'auth.login';
  });
  return {
    ok: out.ok,
    failCode: out.ok ? '' : (out.error && out.error.code) || 'unknown',
    dLogin: s1.authLogins - s0.authLogins,
    dRetry: s1.authRetries - s0.authRetries,
    u401Ids: u401.map(function (x) {
      return x.id;
    }),
    loginIds: logins.map(function (x) {
      return x.id;
    }),
    loginAt: logins.length ? logins[0].at - t0 : -1,
    firstTxId: (function () {
      const first = rec.rx[0];
      return first ? first.id : '';
    })(),
    rotated: !!protocol.token && protocol.token !== STALE,
  };
}

/**
 * E2 可控迟到 401（确定性构造，无需改协议、无需设备配合）
 *
 * 真实竞态的样子是：某条请求的**请求体**里带的还是旧 token，而会话槽里的
 * this.token 已被并发的重登刷新成新 token；该请求的 401 这时才到达处理器。
 *
 * 构造方式（利用 `_callDetailed` 先把 body 定型、再 await 的事实）：
 *   1. 会话槽写入失效 token；
 *   2. 调 networkStatus() —— 请求体在这一刻固化失效 token；
 *   3. **立刻**把会话槽恢复成刷新后的新 token（此时还没有任何 await 让出）；
 *   4. 等 401 回来：请求 token ≠ 当前 token，且没有在途登录。
 *
 * 判据：B 段 authLogins
 *   0 → 已有「请求 token 已被刷新 → 直接用当前 token 重试」的判断（理想）
 *  ≥1 → 迟到 401 会再登录一次（H9 只覆盖「登录在途」，覆盖不到这种迟到）
 *
 * 注意：A 段不是可有可无的。它先证明「设备确实拒绝这个伪造 token」，
 * 否则 B 段的 0 次登录可能只是设备没校验 token。
 */
async function runLateOnce(protocol, opts) {
  const bad = readinessOf(protocol);
  if (bad) return { verdict: 'invalid', detail: bad.detail, phaseA: null, phaseB: null };
  const o = opts || {};
  if (o.gapMs) await sleep(o.gapMs);

  /* A 段：完整走一遍「失效 token → 401 → 登录 → 重试成功」 */
  const a = await fireStaleOnce(protocol);
  if (!a.dLogin) {
    return {
      verdict: 'invalid',
      detail: 'A 段没有触发登录（伪造 token 未被拒绝），无法构造迟到场景',
      phaseA: a,
      phaseB: null,
    };
  }

  /* B 段：请求体固化失效 token 后立刻恢复当前 token */
  const fresh = protocol.token;
  const freshExpiry = protocol.tokenExpiresAt;
  const STALE = probeToken();
  const s0 = protocol.snapshot();
  const rec = watch(protocol);
  const t0 = Date.now();
  protocol.token = STALE;
  protocol.tokenExpiresAt = 0;
  const pending = protocol.networkStatus(); // body 在此刻定型为 STALE
  protocol.token = fresh; // 立刻恢复：模拟「401 迟到时 token 已被并发重登刷新」
  protocol.tokenExpiresAt = freshExpiry;
  const out = await settle(pending);
  rec.stop();
  const s1 = protocol.snapshot();

  const u401 = rec.rx.filter(function (x) {
    return x.error === 'unauthorized' || x.error === 'auth_required';
  });
  const logins = rec.tx.filter(function (x) {
    return x.cmd === 'auth.login';
  });
  const b = {
    ok: out.ok,
    failCode: out.ok ? '' : (out.error && out.error.code) || 'unknown',
    dLogin: s1.authLogins - s0.authLogins,
    dRetry: s1.authRetries - s0.authRetries,
    u401Ids: u401.map(function (x) {
      return x.id;
    }),
    loginIds: logins.map(function (x) {
      return x.id;
    }),
    loginAt: logins.length ? logins[0].at - t0 : -1,
    rotated: protocol.token !== STALE && !!protocol.token,
  };

  let verdict = 'invalid';
  let detail = '';
  if (!b.u401Ids.length) {
    detail = 'B 段未取到真实 401（请求可能没带失效 token，或设备未校验 token），实验无效';
  } else if (b.dLogin === 0) {
    verdict = 'clean';
    detail = 'B 段未再登录（已按「请求 token 已被刷新」直接用当前 token 重试，理想形态）';
  } else {
    verdict = 'late_login';
    detail =
      'B 段又登录了 ' + b.dLogin + ' 次：迟到 401 触发重复登录（请求 ' + b.u401Ids.join(',') +
      ' · 功能' + (b.ok ? '仍成功' : '最终失败（' + b.failCode + '）') + '）';
  }
  return { verdict: verdict, detail: detail, phaseA: a, phaseB: b };
}

/** 汇总（纯函数，自测可直接喂构造数据） */
function summarize(rounds) {
  const list = rounds || [];
  const cnt = function (k) {
    return list.filter(function (r) {
      return r && r.verdict === k;
    }).length;
  };
  let maxLogins = 0;
  list.forEach(function (r) {
    if (r && typeof r.dLogin === 'number' && r.dLogin > maxLogins) maxLogins = r.dLogin;
  });
  const defect = cnt('defect');
  const invalid = cnt('invalid');
  const clean = cnt('clean');
  let kind = 'invalid';
  if (defect) kind = 'defect';
  else if (clean && !invalid && clean === list.length) kind = 'clean';
  else if (clean) kind = 'partial';
  return {
    total: list.length,
    clean: clean,
    defect: defect,
    invalid: invalid,
    maxLogins: maxLogins,
    kind: kind,
  };
}

/** 口径文案：明确「没复现 ≠ 不存在」 */
function textOf(sum, late) {
  const lines = [];
  lines.push('#23 时序实验（只观测，未修改协议）');
  lines.push('自然并发：' + sum.total + ' 轮 · clean ' + sum.clean + ' / defect ' + sum.defect + ' / invalid ' + sum.invalid + ' · authLogins 峰值 ' + sum.maxLogins);
  if (sum.kind === 'defect') {
    lines.push('判读：发现重复登录（authLogins≥2）——登录去重只在「在途」生效，迟到 401 会再登一次；需先审查再改 protocol');
  } else if (sum.kind === 'clean') {
    lines.push('判读：' + sum.clean + '/' + sum.total + ' 轮 authLogins=1，**当前时序下未复现**；不能据此断言竞态不存在（设备回 401 很快，两条通常都落在首次登录在途窗口内）');
  } else if (sum.kind === 'partial') {
    lines.push('判读：部分轮次无效（' + sum.invalid + '/' + sum.total + '），不足以定性；请排除超时/断链后重跑');
  } else {
    lines.push('判读：全部轮次无效（' + sum.invalid + '/' + sum.total + '），不能判 PASS——检查是否取到两条真实 401、id 是否匹配、是否超时');
  }
  if (late) {
    if (late.verdict === 'late_login') {
      lines.push('可控迟到：' + late.detail + '（理想 0 次）⟹ 代码缺少「请求 token ≠ 当前 token 时直接用当前 token 重试」判断');
    } else if (late.verdict === 'clean') {
      lines.push('可控迟到：' + late.detail);
    } else {
      lines.push('可控迟到：' + (late.detail || '未执行/无效'));
    }
  }
  return lines.join('\n');
}

/**
 * 跑全套：E1 × rounds + E2 × 1。
 * opts: { rounds=5, gapMs=400, late=true }
 */
async function runAll(protocol, opts) {
  const o = opts || {};
  const rounds = o.rounds || 5;
  const gap = o.gapMs === undefined ? 400 : o.gapMs;
  const results = [];
  for (let i = 0; i < rounds; i++) {
    const r = await runConcurrentOnce(protocol);
    r.n = i + 1;
    results.push(r);
    if (r.reason === 'not_ready') {
      return { ok: false, reason: 'not_ready', detail: r.detail, rounds: results, late: null, verdict: 'not_ready', text: r.detail };
    }
    if (i < rounds - 1) await sleep(gap);
  }
  let late = null;
  if (o.late !== false) {
    if (gap) await sleep(gap);
    late = await runLateOnce(protocol);
  }
  const sum = summarize(results);
  return {
    ok: true,
    rounds: results,
    late: late,
    summary: sum,
    verdict: late && late.verdict === 'late_login' ? 'late_login' : sum.kind,
    text: textOf(sum, late),
  };
}

module.exports = {
  probeToken,
  readinessOf,
  runConcurrentOnce,
  fireStaleOnce,
  runLateOnce,
  summarize,
  textOf,
  runAll,
};
