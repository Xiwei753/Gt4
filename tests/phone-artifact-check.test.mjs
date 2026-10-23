// SPDX-License-Identifier: GPL-3.0-only
// Run: node tests/phone-artifact-check.test.mjs
// issue #12：最终 installable HAP 必须真的把指纹编进 ets/modules.abc。
// 本测试只做容器/字节码级校验，不签名、不安装；真机结果另记。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = process.cwd();
const CHECK = join(REPO, 'tests/build_artifact_check.sh');
const tmp = mkdtempSync(join(tmpdir(), 'suyue-phone-artifact-'));
const hap = join(tmp, 'entry-default-debug-signed.hap');
const fingerprint =
  'fbdee2e124a2232509b1c614d452bded210d61fbd7fac62791199ac37a2701c1';

function writeZip(entries) {
  const script = [
    'import json, sys, zipfile',
    'with zipfile.ZipFile(sys.argv[1], "w", compression=zipfile.ZIP_DEFLATED) as z:',
    '    for name, value in json.loads(sys.argv[2]):',
    '        z.writestr(name, value)'
  ].join('\n');
  const result = spawnSync('python3',
    ['-c', script, hap, JSON.stringify(entries)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function manifest(clientId = '6917618613178762508') {
  return JSON.stringify({
    app: {
      bundleName: 'com.xiwei.suyue',
      versionCode: 1000000,
      versionName: '0.1.0'
    },
    module: {
      name: 'entry',
      type: 'entry',
      deviceTypes: ['phone'],
      metadata: [{ name: 'client_id', value: clientId }]
    }
  });
}

function check(extra = []) {
  return spawnSync('bash', [CHECK, hap,
    '--bundle', 'com.xiwei.suyue',
    '--device', 'phone',
    '--mode', 'debug',
    '--expect-metadata', 'client_id=6917618613178762508',
    ...extra], { encoding: 'utf8' });
}

try {
  // 1) 指纹出现在真正执行的 ABC 里 → 通过
  writeZip([
    ['module.json', manifest()],
    ['ets/modules.abc',
      'prefix INJECTED_WATCH_FINGERPRINT ' + fingerprint + ' suffix']
  ]);
  const ok = check(['--expect-compiled-string', fingerprint]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /COMPILED_STRING_OK/);
  assert.match(ok.stdout, /signed=yes/);

  // 2) 只在 sourceMaps.map 里出现、ABC 里没有 → 不能冒充包内已有值
  writeZip([
    ['module.json', manifest()],
    ['ets/modules.abc', 'INJECTED_WATCH_FINGERPRINT = ""'],
    ['ets/sourceMaps.map', fingerprint]
  ]);
  const sourceMapOnly = check(['--expect-compiled-string', fingerprint]);
  assert.notEqual(sourceMapOnly.status, 0,
    'source map presence must not satisfy the compiled-string check');
  assert.match(sourceMapOnly.stderr, /ets\/modules\.abc/);

  // 3) 完全没有 ABC → 明确失败
  writeZip([
    ['module.json', manifest()],
    ['ets/sourceMaps.map', fingerprint]
  ]);
  const noAbc = check(['--expect-compiled-string', fingerprint]);
  assert.notEqual(noAbc.status, 0);
  assert.match(noAbc.stderr, /no ets\/modules\.abc/);

  // 4) client_id 仍在最终 manifest 中；改错值必须失败
  writeZip([
    ['module.json', manifest('wrong-client-id')],
    ['ets/modules.abc', fingerprint]
  ]);
  const badClient = check(['--expect-compiled-string', fingerprint]);
  assert.notEqual(badClient.status, 0);
  assert.match(badClient.stderr, /client_id/);

  console.info('PASS: phone artifact check (compiled fingerprint, ' +
    'source-map false positive guard, missing ABC, client_id)');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
