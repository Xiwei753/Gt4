// SPDX-License-Identifier: GPL-3.0-only
// Run: node tests/wear_auth_policy.test.mjs
// issue #5 P0-A/P0-B：Wear Engine 授权 / 设备发现分类回归。
// 纯逻辑模块（无 SDK 依赖），复制为 .mjs 后动态导入。
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const POLICY = 'apps/phone/entry/src/main/ets/services/WearAuthPolicy.js';
const src = readFileSync(POLICY, 'utf8');
// 纯逻辑不得引入 SDK，否则 Node 无法测试。
assert.ok(!src.includes('@kit'),
  'policy must stay SDK-free so Node can test it');
assert.ok(!/^\s*import\s/m.test(src),
  'policy must not import other modules');

const tmp = mkdtempSync(join(tmpdir(), 'suyue-wear-'));
const modPath = join(tmp, 'WearAuthPolicy.mjs');
writeFileSync(modPath, src);
const { describeWearError, authNotice, deviceNotice, shorten,
  isRetryable, planRetry, MAX_AUTO_RETRIES, RETRY_BACKOFF_MS,
  runDeviceRefresh } = await import(modPath);

// ---- 错误码分类：只认有官方依据的码，其余原样保留 ----
assert.equal(describeWearError('device_query', 1008500004, '').kind,
  'service_not_applied');
assert.equal(describeWearError('auth_query', 1008500005, '').kind,
  'not_authorized');
assert.equal(describeWearError('auth_query', 1008500006, '').kind,
  'privacy_not_agreed');
assert.equal(describeWearError('auth_request', 401, '').kind,
  'param_invalid');
// issue #6：1008509999 在设备发现路径上由「应用元数据缺少 client ID」触发，
// 必须专列为应用身份配置错误，且给出真实码与可执行指引。
const clientIdErr = describeWearError('device_query', 1008509999,
  'Internal error.');
assert.equal(clientIdErr.kind, 'app_client_id_not_configured');
assert.equal(clientIdErr.code, 1008509999);
assert.ok(clientIdErr.text.includes('1008509999'),
  'raw 1008509999 must surface');
assert.ok(clientIdErr.text.includes('应用身份配置错误'),
  'must be classified as app identity misconfiguration');
assert.ok(clientIdErr.text.includes('更新素阅安装包'),
  'must point the user at reinstalling the fixed package');
// 201：SDK d.ts 里属 P2pResultCode.REMOTE_APP_NOT_RUNNING，与文档示例的
// 「未授权」冲突，无法确证；不编结论，原样保留 code 走 api_error。
const p2p201 = describeWearError('auth_request', 201, '');
assert.equal(p2p201.kind, 'api_error');
assert.equal(p2p201.code, 201);
assert.ok(p2p201.text.includes('201'), 'raw code 201 must surface in text');
// d.ts 确证的其余 BusinessError 码各自可区分。
assert.equal(describeWearError('auth_query', 1008500001, '').kind,
  'network_error');
assert.equal(describeWearError('device_query', 1008500002, '').kind,
  'no_device_bound');
assert.equal(describeWearError('device_query', 1008500003, '').kind,
  'device_disconnected');
assert.equal(describeWearError('device_query', 1008500007, '').kind,
  'device_unsupported');
assert.equal(describeWearError('auth_query', 1008500008, '').kind,
  'account_not_logged_in');
assert.equal(describeWearError('auth_query', 1008500009, '').kind,
  'account_error');
const unknown = describeWearError('device_query', 12345, 'boom');
assert.equal(unknown.kind, 'api_error');
assert.equal(unknown.code, 12345, 'unknown code must be preserved verbatim');
assert.ok(unknown.text.includes('12345'), 'raw code must surface in text');
assert.ok(unknown.text.includes('设备发现'), 'stage must surface in text');
const noCode = describeWearError('auth_query', undefined, '');
assert.equal(noCode.kind, 'api_error');
assert.equal(noCode.code, 0);
// 绝不退化成旧的兜底错误。
for (const c of [1008500004, 1008500005, 1008500006, 201, 401, 0, 12345]) {
  const r = describeWearError('device_query', c, 'x');
  assert.ok(!r.text.includes('E_PEER_UNAVAILABLE'));
  assert.ok(!r.text.includes('Wear Engine 不可用'),
    'must not collapse every failure into “Wear Engine 不可用”');
}

// ---- 消息截断（不把长随机串整段带出）----
assert.equal(shorten('  hi  '), 'hi');
assert.ok(shorten('a'.repeat(300)).length <= 121,
  'long messages must be truncated');

// ---- 授权状态提示 ----
assert.equal(authNotice({ ok: true, granted: true }).kind, 'ok');
assert.equal(authNotice({ ok: true, granted: false }).kind, 'not_authorized');
assert.equal(authNotice({ ok: false, stage: 'auth_query',
  code: 1008500006, message: '' }).kind, 'privacy_not_agreed');
assert.equal(authNotice({ ok: false, stage: 'auth_client',
  code: 0, message: 'boom' }).kind, 'api_error');
assert.equal(authNotice(null).kind, 'unknown');

// ---- 设备发现提示：空列表 ≠ 蓝牙/配对问题 ----
const found = deviceNotice({ ok: true,
  devices: [{ randomId: 'r1', name: 'GT 4' }] });
assert.equal(found.kind, 'ok');
assert.ok(found.text.includes('发现 1 台'));
const empty = deviceNotice({ ok: true, devices: [] });
assert.equal(empty.kind, 'empty');
assert.ok(empty.text.includes('未返回可用设备'));
assert.ok(!empty.text.includes('请确认配对与蓝牙'),
  'empty list must not be reported as a pairing/bluetooth problem');
assert.equal(deviceNotice({ ok: false, stage: 'device_query',
  code: 1008500004, message: '' }).kind, 'service_not_applied');
assert.equal(deviceNotice({ ok: false, stage: 'device_query',
  code: 1008500005, message: '' }).kind, 'not_authorized');
assert.equal(deviceNotice({ ok: false, stage: 'device_query',
  code: 1008509999, message: '' }).kind, 'app_client_id_not_configured');

// ---- issue #6：自动重试状态机 ----
// 确定性失败绝不自动重试。
assert.equal(isRetryable('app_client_id_not_configured'), false);
assert.equal(isRetryable('service_not_applied'), false);
assert.equal(isRetryable('not_authorized'), false);
assert.equal(isRetryable('privacy_not_agreed'), false);
assert.equal(isRetryable('device_unsupported'), false);
assert.equal(isRetryable('param_invalid'), false);
assert.equal(isRetryable('no_device_bound'), false);
assert.equal(isRetryable('account_not_logged_in'), false);
assert.equal(isRetryable('api_error'), false);
// 只有短暂断连/网络错误可重试。
assert.equal(isRetryable('network_error'), true);
assert.equal(isRetryable('device_disconnected'), true);

const clientPlan = planRetry(0, describeWearError('device_query',
  1008509999, ''));
assert.equal(clientPlan.retry, false, '1008509999 must never auto-retry');
assert.ok(clientPlan.reason.startsWith('non_retryable'));
const deniedPlan = planRetry(0, describeWearError('auth_query',
  1008500005, ''));
assert.equal(deniedPlan.retry, false, 'user denial must never auto-retry');
const notAppliedPlan = planRetry(0, describeWearError('device_query',
  1008500004, ''));
assert.equal(notAppliedPlan.retry, false, 'unapproved service must not retry');

// 短暂错误：次数有限、退避 >= 1s、单调不缩短。
let attempt = 0;
const delays = [];
for (;;) {
  const p = planRetry(attempt, describeWearError('device_query',
    1008500003, ''));
  if (!p.retry) {
    assert.equal(p.reason, 'max_attempts');
    break;
  }
  delays.push(p.delayMs);
  attempt = p.attempt;
  assert.ok(attempt <= MAX_AUTO_RETRIES);
}
assert.equal(delays.length, MAX_AUTO_RETRIES,
  'transient errors retry at most MAX_AUTO_RETRIES times');
assert.deepEqual(delays, RETRY_BACKOFF_MS);
for (const d of delays) {
  assert.ok(d >= 1000, 'no sub-second retry storm');
}
assert.deepEqual(delays, [...delays].sort((a, b) => a - b),
  'backoff must not shrink');
// 成功/空列表不需要重试。
assert.equal(planRetry(0, { ok: true }).retry, false);
assert.equal(planRetry(0, null).retry, false);

// ---- 客户端初始化阶段错误：保留阶段 + 真实 code（P0-2a/P0-2d）----
const initErr = describeWearError('device_client', 1008509999, 'internal');
assert.equal(initErr.kind, 'api_error');
assert.ok(initErr.text.includes('设备客户端创建'),
  'client-init stage must be visible in text');
assert.ok(initErr.text.includes('1008509999'),
  'client-init raw code must surface in text');
const p2pInitErr = describeWearError('p2p_client', 1008509999, 'internal');
assert.ok(p2pInitErr.text.includes('P2P 客户端创建'),
  'p2p client-init stage must be visible');

// ---- 轮次并发/复位状态机（P0-2b/P0-3，非纯文本）----
{
  const state = { seq: 0, busy: false, applied: [] };
  const base = {
    start: () => { state.seq += 1; state.busy = true; return state.seq; },
    isCurrent: (seq) => seq === state.seq,
    apply: (r) => { state.applied.push(r.tag); },
    end: () => { state.busy = false; }
  };
  // 正常一轮：落地结果并复位进行中标志
  const ok = await runDeviceRefresh({ ...base,
    listDevices: async () => ({ ok: true, tag: 'first' }) });
  assert.equal(ok.superseded, false);
  assert.equal(state.busy, false, 'busy must reset after success');
  assert.deepEqual(state.applied, ['first']);

  // 异常结束：busy 必须复位，且不落地结果
  let threw = false;
  try {
    await runDeviceRefresh({ ...base,
      listDevices: async () => { throw new Error('boom'); } });
  } catch (e) { threw = true; }
  assert.equal(threw, true, 'refresh must propagate the error');
  assert.equal(state.busy, false, 'busy must reset after exception');

  // 并发：后一轮取代前一轮，前一轮结果作废
  let resolveStale;
  const a = runDeviceRefresh({ ...base,
    listDevices: () => new Promise((res) => { resolveStale = res; }) });
  const b = runDeviceRefresh({ ...base,
    listDevices: async () => ({ ok: true, tag: 'fresh' }) });
  resolveStale({ ok: true, tag: 'stale' });
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.superseded, true, 'stale round must be superseded');
  assert.equal(rb.superseded, false);
  assert.ok(state.applied.includes('fresh'));
  assert.ok(!state.applied.includes('stale'),
    'superseded round must not apply its result');
  assert.equal(state.busy, false, 'busy must be reset by the latest round');
}

// ---- 静态契约：不再依赖 DEVICE_IDENTIFIER，也不再有误导的授权按钮 ----
const svc = readFileSync(
  'apps/phone/entry/src/main/ets/services/WearDeviceService.ts', 'utf8');
assert.ok(!svc.includes('DEVICE_IDENTIFIER'),
  'device discovery must not depend on the DEVICE_IDENTIFIER permission');
assert.ok(svc.includes('device_client'),
  'service must surface the client-init stage');
assert.ok(svc.includes('ensureDeviceClient'),
  'service must lazily create the device client (constructor must not throw)');
const page = readFileSync(
  'apps/phone/entry/src/main/ets/pages/Index.ets', 'utf8');
assert.ok(!page.includes('requestAuth'),
  'page must not gate discovery/sending on an authorization request');
assert.ok(!page.includes('授权手表访问'),
  'page must not show the misleading authorization button');
assert.ok(page.includes('runDeviceRefresh'),
  'page must use the tested refresh flow');

console.info('PASS: Wear Engine auth/discovery policy ' +
  '(code classification, empty != bluetooth, raw code preserved, ' +
  'client-id non-retry, bounded backoff, ' +
  'init-stage errors, refresh state machine)');
