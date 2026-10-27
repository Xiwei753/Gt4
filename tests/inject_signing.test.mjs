// SPDX-License-Identifier: GPL-3.0-only
// Run: node tests/inject_signing.test.mjs
// Issue #13 identity injection contracts:
//   - WATCH_PEER = <watch bundle>_<Base64(raw EC point)> for phone -> watch;
//   - PHONE_SELF/supportLists = phone APP ID for watch -> phone;
//   - invalid/ambiguous values fail closed and name the identity/format;
//   - signing material staging and signingConfigs remain intact.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync,
  copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'suyue-sign-'));
const REPO = process.cwd();
const APP_ID = '6917618613178762508';
const WATCH_LITE = 'con.xiwei.suyue.gt4_' +
  'BEWzvDkxDn4ueCkVNgwzqmrFXjhblq+CrbN+HUw4tLR5tMCz5ovAToeq9JX2' +
  'WFzIO7SoU4YKrDY85m5QgsLEWok=';
const OFFICIAL_LITE = 'com.watch.wearengine_' +
  'BC1bSGDxiTcUEkNGNztsD6sLBFgFWQm9lPl05ktD1R8Bx8SvYQNhjlIMJJGRk' +
  'f8yVYNxMnwNCbxToR5xerVCp+o=';

const material = (fingerprints, extra = {}) => JSON.stringify({
  storeFileB64: Buffer.from('key-bytes').toString('base64'),
  certpathB64: Buffer.from('cert-bytes').toString('base64'),
  profileB64: Buffer.from('profile-bytes').toString('base64'),
  keyAlias: 'alias', keyPassword: 'kp',
  storePassword: 'sp', signAlg: 'SHA256withECDSA',
  fingerprints,
  ...extra
});

function dirFor(name) {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function stageWatch(name, value) {
  const dir = dirFor(name);
  const buildProfile = join(dir, 'build-profile.json5');
  const identity = join(dir, 'PhonePeerConfig.g.js');
  const manifest = join(dir, 'config.json');
  copyFileSync(join(REPO, 'watch/huawei/watch-lite/build-profile.json5'),
    buildProfile);
  copyFileSync(join(REPO,
    'watch/huawei/watch-lite/entry/src/main/js/MainAbility/wear/PhonePeerConfig.g.js'),
    identity);
  copyFileSync(join(REPO, 'watch/huawei/watch-lite/entry/src/main/config.json'),
    manifest);
  return { dir, buildProfile, identity, manifest };
}

function injectWatch(dir, value, format = 'appid') {
  const args = [
    join(REPO, 'tools/inject_signing.py'),
    '--material-json', material({ phone: value, watch: WATCH_LITE }),
    '--signing-dir', join(dir.dir, 'staged'),
    '--build-profile', dir.buildProfile,
    '--identity-file', dir.identity,
    '--identity-var', 'INJECTED_PHONE_APP_ID',
    '--fingerprint-key', 'phone',
    '--fingerprint-format', format,
    '--manifest', dir.manifest,
    '--manifest-peer-bundle', 'com.xiwei.suyue'
  ];
  return spawnSync('python3', args, { encoding: 'utf8' });
}

function stagePhone(name) {
  const dir = dirFor(name);
  const identity = join(dir, 'PeerIdentityConfig.g.ts');
  copyFileSync(join(REPO,
    'harmony/entry/src/main/ets/services/PeerIdentityConfig.g.ts'),
    identity);
  return { dir, identity };
}

function injectPhoneLite(dir, value, extraArgs = [], bundle = '') {
  const args = [
    join(REPO, 'tools/inject_signing.py'),
    '--material-json', material({ watch: value }),
    '--signing-dir', join(dir.dir, 'staged'),
    '--external-signing',
    '--identity-file', dir.identity,
    '--identity-var', 'INJECTED_WATCH_LITE_FINGERPRINT',
    '--fingerprint-key', 'watch',
    '--fingerprint-format', 'lite',
    ...extraArgs
  ];
  if (bundle) args.push('--watch-bundle', bundle);
  return spawnSync('python3', args, { encoding: 'utf8' });
}

// ---- 1. Watch side: phone APP ID + supportLists + signingConfigs ----
{
  const s = stageWatch('watch-ok', APP_ID);
  const run = injectWatch(s, APP_ID);
  assert.equal(run.status, 0, run.stderr);
  const manifest = JSON.parse(readFileSync(s.manifest, 'utf8'));
  const entry = manifest.module.metaData.customizeData
    .find((e) => e.name === 'supportLists');
  assert.equal(entry.value, 'com.xiwei.suyue:' + APP_ID,
    'supportLists must carry the phone APP ID, not a cert digest');
  assert.ok(!JSON.stringify(manifest).includes(
    'CONFIGURE_WITH_PHONE_APP_ID'), 'placeholder must be gone');
  const identity = readFileSync(s.identity, 'utf8');
  assert.ok(identity.includes(
    "export const INJECTED_PHONE_APP_ID = '" + APP_ID + "';"),
    'watch peer identity must be the phone APP ID');
  const profile = readFileSync(s.buildProfile, 'utf8');
  assert.ok(profile.includes('"signingConfigs": [{'),
    'real signingConfigs written');
  assert.ok(!profile.includes('"signingConfigs": []'),
    'empty signingConfigs replaced');
  assert.ok(/staged[/]key\.p12/.test(profile),
    'signing material paths point at the staged dir');
}

// ---- 2. Tampered supportLists -> fail, name the field ----
{
  const s = stageWatch('watch-tampered', APP_ID);
  const manifest = JSON.parse(readFileSync(s.manifest, 'utf8'));
  manifest.module.metaData.customizeData
    .find((e) => e.name === 'supportLists').value =
    'com.xiwei.suyue:' + 'ff'.repeat(32);
  writeFileSync(s.manifest, JSON.stringify(manifest, null, 2));
  copyFileSync(join(REPO, 'watch/huawei/watch-lite/build-profile.json5'),
    s.buildProfile);
  copyFileSync(join(REPO,
    'watch/huawei/watch-lite/entry/src/main/js/MainAbility/wear/PhonePeerConfig.g.js'),
    s.identity);
  const run = injectWatch(s, APP_ID);
  assert.notEqual(run.status, 0,
    'non-placeholder supportLists must fail the build');
  assert.ok(run.stderr.includes('supportLists'),
    'failure must name the manifest field');
}

// ---- 3. APP ID must not be a cert SHA, bundle, or wrong direction ----
{
  for (const [name, value] of [
    ['watch-hex', 'ab'.repeat(32)],
    ['watch-bundle', 'com.xiwei.suyue'],
    ['watch-short', '12345']
  ]) {
    const s = stageWatch(name, value);
    const run = injectWatch(s, value);
    assert.notEqual(run.status, 0, name + ' must be rejected');
    assert.ok(run.stderr.includes('APP ID'),
      name + ' error must name the APP ID format');
  }
  const s = stageWatch('watch-wrong-direction', WATCH_LITE);
  const run = injectWatch(s, WATCH_LITE, 'lite');
  assert.notEqual(run.status, 0,
    'Lite fingerprint must not be injected as PHONE_APP_ID');
}

// ---- 4. Phone side: Lite identity preserved case/+/= ----
{
  const s = stagePhone('phone-lite');
  const run = injectPhoneLite(s, WATCH_LITE);
  assert.equal(run.status, 0, run.stderr);
  const injected = readFileSync(s.identity, 'utf8');
  assert.ok(injected.includes(
    "export const INJECTED_WATCH_LITE_FINGERPRINT = '" + WATCH_LITE + "';"),
    'full Lite value must be preserved, including case and +/=');

  const official = stagePhone('phone-official');
  const officialRun = injectPhoneLite(official, OFFICIAL_LITE, [],
    'com.watch.wearengine');
  assert.equal(officialRun.status, 0, officialRun.stderr);
  assert.ok(readFileSync(official.identity, 'utf8').includes(OFFICIAL_LITE),
    'official Huawei Lite example must be accepted verbatim');
}

// ---- 5. Wrong Lite bundle / 64-hex cert SHA -> fail without mutation ----
{
  const s = stagePhone('phone-lite-bad');
  const before = readFileSync(s.identity, 'utf8');
  const run = injectPhoneLite(s, 'con.xiwei.suyue.gt4_' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==');
  assert.notEqual(run.status, 0,
    'wrong EC point / length must fail');
  assert.equal(readFileSync(s.identity, 'utf8'), before,
    'failed validation must not mutate the identity file');

  const hex = spawnSync('python3', [
    join(REPO, 'tools/inject_signing.py'),
    '--fingerprint-value', 'cd'.repeat(32),
    '--identity-file', s.identity,
    '--identity-var', 'INJECTED_WATCH_LITE_FINGERPRINT',
    '--fingerprint-key', 'watch',
    '--fingerprint-format', 'lite'
  ], { encoding: 'utf8' });
  assert.notEqual(hex.status, 0,
    'a certificate SHA-256 must not be accepted as a Lite identity');
  assert.ok(hex.stderr.includes('SHA-256'),
    'Lite error must explain the rejected cert digest');
  assert.equal(readFileSync(s.identity, 'utf8'), before,
    'failed direct injection must not mutate the identity file');
}

// ---- 6. Material-only staging + external credentials ----
{
  const dir = dirFor('material-only');
  const run = spawnSync('python3', [
    join(REPO, 'tools/inject_signing.py'),
    '--material-json', material({ phone: APP_ID, watch: WATCH_LITE },
      { keyPassword: "a' b$\\\\c" }),
    '--signing-dir', join(dir, 'staged'),
    '--external-signing'
  ], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.includes('identity injection skipped'),
    'material-only mode must not invent an identity');
  const envFile = join(dir, 'staged/credentials.env');
  const loaded = spawnSync('bash', [
    '-c', 'source "$1"; printf "%s" "$KEY_PASSWORD"', 'bash', envFile
  ], { encoding: 'utf8' });
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.equal(loaded.stdout, "a' b$\\\\c");
}

// ---- 7. Direct mode: empty placeholder, no silent overwrite, opt-in ----
{
  const s = stagePhone('direct');
  const args = [
    join(REPO, 'tools/inject_signing.py'),
    '--fingerprint-value', WATCH_LITE,
    '--identity-file', s.identity,
    '--identity-var', 'INJECTED_WATCH_LITE_FINGERPRINT',
    '--fingerprint-key', 'watch',
    '--fingerprint-format', 'lite'
  ];
  const first = spawnSync('python3', args, { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const afterFirst = readFileSync(s.identity, 'utf8');

  const again = spawnSync('python3', args, { encoding: 'utf8' });
  assert.notEqual(again.status, 0,
    'a different/existing injected identity must not be silently replaced');
  assert.equal(readFileSync(s.identity, 'utf8'), afterFirst);

  const replace = spawnSync('python3', [...args, '--allow-replace'],
    { encoding: 'utf8' });
  assert.equal(replace.status, 0, replace.stderr);
}

// ---- 8. Material and direct modes are mutually exclusive ----
{
  const s = stagePhone('exclusive');
  const both = spawnSync('python3', [
    join(REPO, 'tools/inject_signing.py'),
    '--material-json', material({ watch: WATCH_LITE }),
    '--fingerprint-value', WATCH_LITE,
    '--identity-file', s.identity,
    '--identity-var', 'INJECTED_WATCH_LITE_FINGERPRINT',
    '--fingerprint-key', 'watch'
  ], { encoding: 'utf8' });
  assert.notEqual(both.status, 0,
    'material mode and direct fingerprint mode must be exclusive');
}

console.info('PASS: signing injection (phone APP ID supportLists, ' +
  'Lite pubkey identity, strict formats, material staging)');
