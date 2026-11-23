'use strict';

/* P1 cleanup_state 契约与配网状态机回归；纯 Node，无 BLE/设备 IO。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const originalLoad = Module._load;
const fakeBle = { on: function () {} };
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename.indexOf('/utils/provision.js') >= 0) {
    if (request === './session') return { ble: fakeBle };
    if (request === './pwstore') return { forget: function () {}, remember: function () {} };
    if (request === './util') return { sleep: function () { return Promise.resolve(); } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const contract = require('../utils/contract');
const provision = require('../utils/provision');
const generator = require('../tools/gen_contract_data');
Module._load = originalLoad;

function protocolFor(states, status) {
  let gets = 0;
  let applies = 0;
  return {
    getCount: function () { return gets; },
    applyCount: function () { return applies; },
    tryConnect: async function () { return { operation_id: 'op-test' }; },
    operationGet: async function () {
      const index = Math.min(gets, states.length - 1);
      gets += 1;
      return states[index];
    },
    networkApply: async function () {
      applies += 1;
      return { state: 'success', saved: true, applied: true };
    },
    networkStatus: async function () { return status || {}; },
  };
}

async function expectTerminal(state, cleanupState, expectedCode) {
  const p = protocolFor([{ state: state, cleanup_state: cleanupState, error: 'none' }]);
  let error;
  try {
    await provision.provisionWifi(p, { ssid: 'fixture', verifyTimeoutMs: 5, verifyIntervalMs: 1 });
  } catch (e) { error = e; }
  assert(error, state + '+' + cleanupState + ' must terminate');
  assert.strictEqual(error.code, expectedCode);
  assert.strictEqual(p.getCount(), 1, 'terminal state must not be polled again');
  assert.strictEqual(p.applyCount(), 0, 'terminal state must not trigger apply');
}

async function main() {
  assert.strictEqual(contract.isTerminal('failed'), true);
  assert.strictEqual(contract.isTerminal('cancelled'), true);
  assert.strictEqual(contract.isTerminal('expired'), true);
  assert.strictEqual(contract.isTerminal('got_ip'), false);
  assert.deepStrictEqual(contract.states.operation_get.success_data.cleanup_state, 'none|running|ok|fail（P1 1.1-draft 加法字段）');
  const operationGet = contract.commands.commands['operation.get'];
  assert.strictEqual(operationGet.data, '见 states.json#operation_get（1.3-2ef2a38 起含 error_detail/finished_uptime_ms/stages_source；P1 起含 cleanup_state）');
  assert.strictEqual(operationGet.notes, '轮询跳出=state 的 terminal_states(4)；500ms 间隔建议。cleanup_state 为独立资源清理诊断字段：state 才是 operation 终态依据，cleanup_state=running 不得覆盖/否定终态且终态下仍可能为 running；不得以 running 永久轮询，也不得把 ok 当作 Wi-Fi restore 完成');
  assert(operationGet.notes.includes('不得以 running 永久轮询'));
  assert.deepStrictEqual(contract.commands.commands['network.profile.delete'].args, { ssid: 'string, required' });
  assert.deepStrictEqual(contract.commands.commands['data.loopback'].args, { enabled: 'bool, required' });
  const v1Dir = path.join(__dirname, '..', 'contract', 'v1');
  assert.strictEqual(fs.readFileSync(path.join(v1Dir, 'data.js'), 'utf8'), generator.build(v1Dir), 'data.js must match generated Contract');

  await expectTerminal('failed', 'running', 'failed');
  await expectTerminal('cancelled', 'ok', 'cancelled');
  await expectTerminal('cancelled', 'fail', 'cancelled');
  await expectTerminal('expired', 'running', 'expired');

  const ready = protocolFor([{ state: 'got_ip', cleanup_state: 'running', error: 'none' }],
    { sta_has_ip: true, sta_ip: '192.0.2.10', connected_ssid: 'fixture',
      internet_verified: true, mqtt_connected: true });
  const result = await provision.provisionWifi(ready, { ssid: 'fixture', verifyTimeoutMs: 5, verifyIntervalMs: 1 });
  assert.strictEqual(result.pending, false);
  assert.strictEqual(ready.getCount(), 1);
  assert.strictEqual(ready.applyCount(), 1);

  const noIp = protocolFor([{ state: 'got_ip', cleanup_state: 'ok', error: 'none' }],
    { sta_has_ip: false, sta_ip: '0.0.0.0', connected_ssid: 'fixture',
      internet_verified: true, mqtt_connected: true });
  const pending = await provision.provisionWifi(noIp, { ssid: 'fixture', verifyTimeoutMs: 5, verifyIntervalMs: 1 });
  assert.strictEqual(pending.pending, true);

  await expectTerminal('success', 'running', 'operation_state');
  await expectTerminal('failed', 'future_value', 'failed');
  process.stdout.write('contract-selftest: PASS (14 assertion groups)\n');
}

main().catch(function (err) {
  process.stderr.write((err && err.stack) || String(err));
  process.exitCode = 1;
});
