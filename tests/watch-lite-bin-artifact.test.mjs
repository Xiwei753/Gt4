// SPDX-License-Identifier: GPL-3.0-only
// ZIP/source-contract tests for the Lite single-BIN artifact.
// These do NOT sign and do NOT install on a device; a source-only CI job
// cannot sign without the private profile. Real device install is manual.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Syntax checks are valuable because signing runs on the user's machine.
for (const script of ['tools/sign_hap.sh', 'tools/build_watch_lite.sh',
  'tests/build_artifact_check.sh']) {
  const r = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, script + ': ' + r.stderr);
}

const signing = readFileSync('tools/sign_hap.sh', 'utf8');
const watchCI = readFileSync('.github/workflows/watch_lite_hap.yml', 'utf8');
const artifactCheck = readFileSync('tests/build_artifact_check.sh', 'utf8');

// HDEA discards the outer ZIP signature and only forwards the INNER .bin,
// so the inner BIN must be the thing that is signed (issue #4).
assert.ok(signing.includes('IN_FORM="bin"'));
assert.ok(signing.includes('-inForm "$IN_FORM"'));
assert.ok(signing.includes('SIGN_TARGET="$LITE_TMP/unsigned.bin"'));
assert.ok(signing.includes('check_lite_bin.py'));
assert.ok(signing.includes('LITE_BIN_SIGNED_OK'));

// Explicit, separate status grades (never collapsed into "install solved").
assert.ok(signing.includes('SIGNED_TOOL_OK'));
assert.ok(signing.includes('VERIFY_UNSUPPORTED_FOR_LITE_BIN'));
assert.ok(signing.includes('HAP_PACKAGED_OK'));

// The verify exemption must be narrow: gated on a strictly identified Lite
// single bin AND on the one known ELF-path failure -- never a global disable.
assert.ok(signing.includes('elf magic verify failed'));
assert.match(signing, /HAP_KIND" = "lite-bin"[\s\S]*elf magic verify failed/);
// No fake "signed success": repacking proves output != unsigned input.
assert.ok(signing.includes('bin signing did not change the unsigned payload'));

// CI must reuse the same rules and must not call the always-failing bare path.
assert.ok(!watchCI.includes('verify-app'),
  'workflow must not call verify-app directly for a 0xBE Lite bin');
assert.ok(artifactCheck.includes('--expect-bin-sha256'));

const root = mkdtempSync(join(tmpdir(), 'suyue-lite-bin-'));
const signed = join(root, 'entry-default-debug-signed.hap');
const source = join(root, 'config.json');
const fingerprint = '6917618613178762508';
const baseConfig = {
  app: { bundleName: 'con.xiwei.suyue.gt4' },
  module: {
    deviceType: ['liteWearable'],
    metaData: {
      customizeData: [{ name: 'supportLists',
        value: 'com.xiwei.suyue:' + fingerprint }]
    }
  }
};

function writeZip(target, entries) {
  const script = [
    'import json, sys, zipfile',
    "with zipfile.ZipFile(sys.argv[1], 'w', compression=zipfile.ZIP_DEFLATED) as z:",
    '    for name, value in json.loads(sys.argv[2]):',
    '        if value.startswith("LITEBIN:"):',
    '            nb = value.split(":", 1)[1].encode("utf-8")',
    '            value = bytes([0xbe]) + len(nb).to_bytes(4, "big") + nb + b"demo payload"',
    '        elif value.startswith("LITEBIN_TEMPLATE:"):',
    '            nb = value.split(":", 1)[1].encode("utf-8")',
    '            value = bytes([0xbe]) + len(nb).to_bytes(4, "big") + nb + b" tail com.example.myapplication tail"',
    '        elif value.startswith("BADMAGIC:"):',
    '            nb = value.split(":", 1)[1].encode("utf-8")',
    '            value = bytes([0xef]) + len(nb).to_bytes(4, "big") + nb + b"demo payload"',
    '        elif value.startswith("TRUNCATED:"):',
    '            nb = value.split(":", 1)[1].encode("utf-8")',
    '            value = bytes([0xbe]) + (len(nb) + 9).to_bytes(4, "big") + nb',
    '        z.writestr(name, value)'
  ].join('\n');
  const result = spawnSync('python3',
    ['-c', script, target, JSON.stringify(entries)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function check(extra = []) {
  return spawnSync('bash', ['tests/build_artifact_check.sh', signed,
    '--device', 'liteWearable', '--bundle', 'con.xiwei.suyue.gt4',
    '--mode', 'debug', ...extra], { encoding: 'utf8' });
}

function binSha() {
  const script = [
    'import hashlib, sys, zipfile',
    'with zipfile.ZipFile(sys.argv[1]) as z:',
    '    f = z.infolist()',
    '    print(hashlib.sha256(z.read(f[0])).hexdigest())'
  ].join('\n');
  const r = spawnSync('python3', ['-c', script, signed], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function reset(config = baseConfig) {
  writeFileSync(source, JSON.stringify(config));
  writeZip(signed,
    [['entry-default-unsigned.bin', 'LITEBIN:con.xiwei.suyue.gt4']]);
}

try {
  // (1) the real header bundle is allowed
  reset();
  const ok = check(['--source-manifest', source, '--expect-fingerprint', fingerprint]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /single_bin=1/);
  assert.match(ok.stdout, /manifest_origin=source-only/);

  // (2) template identity in the HEADER is rejected
  writeZip(signed, [['entry-default-unsigned.bin', 'LITEBIN:com.example.myapplication']]);
  const templateHeader = check(['--source-manifest', source]);
  assert.notEqual(templateHeader.status, 0);
  assert.match(templateHeader.stderr, /actual BIN header bundleName/);

  // (3) a different but plausible header is rejected
  writeZip(signed, [['entry-default-unsigned.bin', 'LITEBIN:com.xiwei.suyue.gt4']]);
  const wrongHeader = check(['--source-manifest', source]);
  assert.notEqual(wrongHeader.status, 0);
  assert.match(wrongHeader.stderr, /actual BIN header bundleName/);

  // (4) the old package string as NON-identity payload must NOT false-positive
  reset();
  writeZip(signed, [['entry-default-unsigned.bin',
    'LITEBIN_TEMPLATE:con.xiwei.suyue.gt4']]);
  const templatePayload = check(['--source-manifest', source,
    '--expect-fingerprint', fingerprint]);
  assert.equal(templatePayload.status, 0, templatePayload.stderr);
  assert.match(templatePayload.stdout, /single_bin=1/);

  // (5) bad magic and truncated/overrun headers are rejected
  reset();
  writeZip(signed, [['entry-default-unsigned.bin', 'BADMAGIC:con.xiwei.suyue.gt4']]);
  assert.notEqual(check(['--source-manifest', source]).status, 0);
  reset();
  writeZip(signed, [['entry-default-unsigned.bin', 'TRUNCATED:con.xiwei.suyue.gt4']]);
  assert.notEqual(check(['--source-manifest', source]).status, 0);

  // (6) source config.json is required for a Lite single bin
  reset();
  const missingSource = check();
  assert.notEqual(missingSource.status, 0);
  assert.match(missingSource.stderr, /requires a source config.json/);

  // (7) a source bundle mismatch is rejected
  reset({ ...baseConfig, app: { bundleName: 'com.wrong.bundle' } });
  const mismatch = check(['--source-manifest', source]);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /bundleName/);

  // (8) a non-single bin ZIP must never be accepted as Lite single bin
  reset();
  writeZip(signed, [
    ['entry-default-unsigned.bin', 'LITEBIN:con.xiwei.suyue.gt4'],
    ['unexpected.txt', 'must not be accepted']
  ]);
  const extraFile = check(['--source-manifest', source]);
  assert.notEqual(extraFile.status, 0, 'A two-file ZIP must not be Lite single-bin');

  // (9) fingerprint must appear in the source manifest
  reset();
  const missingFingerprint = check(['--source-manifest', source,
    '--expect-fingerprint', 'ffff0000']);
  assert.notEqual(missingFingerprint.status, 0);
  assert.match(missingFingerprint.stderr, /APP ID|fingerprint/);

  // (10) the BIN in the ZIP must byte-for-byte equal THIS signing output
  reset();
  const realSha = binSha();
  const shaMatch = check(['--source-manifest', source,
    '--expect-bin-sha256', realSha]);
  assert.equal(shaMatch.status, 0, shaMatch.stderr);
  assert.match(shaMatch.stdout, /BIN_SHA256_MATCH=/);
  const shaMismatch = check(['--source-manifest', source,
    '--expect-bin-sha256', 'deadbeef']);
  assert.notEqual(shaMismatch.status, 0);
  assert.match(shaMismatch.stderr, /与本次签名产物不一致/);

  // (11) the legacy multi-file HAP still requires an embedded manifest and
  //      .bc snapshots -- and must NOT be routed down the Lite single-bin path
  writeZip(signed, [
    ['config.json', JSON.stringify(baseConfig)],
    ['pages/index/index.js', 'export default {}'],
    ['pages/index/index.bc', 'compiled snapshot placeholder']
  ]);
  const oldFormat = check(['--expect-fingerprint', fingerprint]);
  assert.equal(oldFormat.status, 0, oldFormat.stderr);
  assert.match(oldFormat.stdout, /single_bin=0/);

  writeZip(signed, [
    ['config.json', JSON.stringify(baseConfig)],
    ['pages/index/index.js', 'export default {}']
  ]);
  const badSnapshot = check();
  assert.notEqual(badSnapshot.status, 0);
  assert.match(badSnapshot.stderr, /missing JerryScript snapshots/);

  console.log('Lite single-bin artifact contract: OK (signing and install untested)');
} finally {
  rmSync(root, { recursive: true, force: true });
}
