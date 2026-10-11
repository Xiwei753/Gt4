// SPDX-License-Identifier: GPL-3.0-only
// Run: node tests/watch_file_probe.test.mjs
// issue #9 A6：文件接口自检。没有 HiLog 时，用户可在手表上
// 逐项看到 @system.file 每个操作的真实结果（成功 / 错误码 /
// 无回调超时）。本测试用真实文件桩验证：
//   - 正常环境：全部项完成，rawfile 缺失时只该项失败；
//   - 无回调：单次超时兜底，整份报告仍能完成；
//   - 错误码：失败项带回真实 code；
//   - 只在 internal://app/gt4probe/ 下操作，绝不碰书架数据。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, existsSync, rmSync }
  from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSystemFileStub } from './helpers/system_file_stub.mjs';
import { createWatchLoader, writeWearEngineStub }
  from './helpers/watch_module_loader.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'suyue-probe-'));
const sandbox = mkdtempSync(join(tmpdir(), 'suyue-probefs-'));
const stubPath = writeSystemFileStub(tmp, sandbox);
const load = createWatchLoader({ tmpDir: tmp, stubPath,
  wearengineStubPath: writeWearEngineStub(tmp) });
const systemFile = (await import(stubPath)).default;
const probe = await load('storage/WatchFileProbe.js');

const runOnce = () => new Promise(
  (res) => probe.runFileProbe(res));
const findItem = (report, name) =>
  report.filter((r) => r.name.indexOf(name) >= 0)[0];
const okCount = (report) =>
  report.filter((r) => r.ok).length;

// ---- 1. 正常环境（rawfile 不存在）----
{
  const report = await runOnce();
  assert.equal(report.length, 12,
    'probe must run every independent operation');
  const rawfile = findItem(report, 'rawfile');
  assert.ok(rawfile, 'rawfile readability must be probed');
  assert.equal(rawfile.ok, false,
    'without a packed rawfile the probe must report failure, not lie');
  assert.ok(okCount(report) >= 11,
    'every real file op must succeed in a healthy sandbox');
  assert.ok(probe.formatProbe(report).indexOf('/12') > 0);
  assert.equal(existsSync(join(sandbox, 'gt4reader')), false,
    'the probe must never touch the book library');
}

// ---- 2. rawfile 存在时该项通过 ----
{
  mkdirSync(join(sandbox, 'rawfile/gt4books'), { recursive: true });
  const report = await runOnce();
  assert.equal(findItem(report, 'rawfile').ok, true,
    'a present rawfile dir must be reported accessible');
  assert.equal(okCount(report), 12);
}

// ---- 3. 无回调 → 单项超时，整份报告仍完成 ----
{
  const original = systemFile.get;
  systemFile.get = () => {};
  probe.setProbeTimeout(40);
  const report = await runOnce();
  probe.setProbeTimeout(4000);
  systemFile.get = original;
  const item = findItem(report, 'get');
  assert.equal(item.ok, false, 'a hung op must be marked failed');
  assert.equal(item.code, 'timeout',
    'a hung op must be reported as a timeout, not hang forever');
  assert.equal(report.length, 12,
    'the rest of the operations must still run');
}

// ---- 4. 真实错误码上屏 ----
{
  const original = systemFile.access;
  systemFile.access = (o) => o.fail && o.fail({}, 301);
  const report = await runOnce();
  systemFile.access = original;
  const item = findItem(report, 'access');
  assert.equal(item.ok, false);
  assert.equal(item.code, 301, 'the real error code must be surfaced');
}

console.info('PASS: watch file self-check runs every op independently, ' +
  'survives no-callback by timeout and reports real codes (issue #9 A6)');
