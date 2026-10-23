// SPDX-License-Identifier: GPL-3.0-only
// Run: node tests/inject_signing.test.mjs
// 构建期注入回归（第二轮 P0-1 / P1-9）：
//   - 手表 Manifest 的 supportLists 占位符必须被
//     真实手机指纹替换（只改 JS 不算授权）；
//   - 占位符缺失/格式不符时明确失败，不猜测；
//   - 指纹格式可配置：默认宽松（结构校验），
//     hex64 收紧；不无依据排斥合法格式；
//   - build-profile 的 signingConfigs 注入真实材料；
//   - 身份文件指纹注入。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync,
  copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'suyue-sign-'));
const REPO = process.cwd();

const material = (fingerprint, extra = {}) => JSON.stringify({
  storeFileB64: Buffer.from('key-bytes').toString('base64'),
  certpathB64: Buffer.from('cert-bytes').toString('base64'),
  profileB64: Buffer.from('profile-bytes').toString('base64'),
  keyAlias: 'alias', keyPassword: 'kp',
  storePassword: 'sp', signAlg: 'SHA256withECDSA',
  fingerprints: { phone: fingerprint, watch: fingerprint },
  ...extra
});

function stage(prefix, fingerprint, options = {}) {
  const dir = join(tmp, prefix);
  const buildProfile = join(dir, 'build-profile.json5');
  const identity = join(dir, 'PhonePeerConfig.g.js');
  const manifest = join(dir, 'config.json');
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(REPO, 'apps/watch/build-profile.json5'),
    buildProfile);
  copyFileSync(join(REPO,
    'apps/watch/entry/src/main/js/MainAbility/wear/PhonePeerConfig.g.js'),
    identity);
  copyFileSync(join(REPO, 'apps/watch/entry/src/main/config.json'),
    manifest);
  const args = [
    join(REPO, 'tools/inject_signing.py'),
    '--material-json', material(fingerprint, options.extra || {}),
    '--signing-dir', join(dir, 'staged'),
    '--build-profile', buildProfile,
    '--identity-file', identity,
    '--identity-var', 'INJECTED_PHONE_FINGERPRINT',
    '--fingerprint-key', 'phone',
    '--manifest', manifest,
    '--manifest-peer-bundle', 'com.xiwei.suyue'
  ];
  if (options.format) {
    args.push('--fingerprint-format', options.format);
  }
  if (options.external) args.push('--external-signing');
  const run = spawnSync('python3', args,
    { encoding: 'utf8' });
  return { dir, buildProfile, identity, manifest, run };
}

const { createRequire } = await import('node:module');

// ---- 1. 正常注入：Manifest + JS + signingConfigs ----
{
  const hex = 'ab'.repeat(32);
  const s = stage('ok', hex);
  assert.equal(s.run.status, 0, s.run.stderr);
  const manifest = JSON.parse(readFileSync(s.manifest, 'utf8'));
  const entry = manifest.module.metaData.customizeData
    .find((e) => e.name === 'supportLists');
  assert.equal(entry.value,
    'com.xiwei.suyue:' + hex,
    'supportLists must carry the real phone fingerprint');
  assert.ok(!JSON.stringify(manifest).includes(
    'CONFIGURE_WITH_SIGNED_PHONE_FINGERPRINT'),
    'placeholder must be gone');
  const identity = readFileSync(s.identity, 'utf8');
  assert.ok(identity.includes("'" + hex + "'"),
    'JS identity fingerprint injected');
  const profile = readFileSync(s.buildProfile, 'utf8');
  assert.ok(profile.includes('"signingConfigs": [{'),
    'real signingConfigs written');
  assert.ok(!profile.includes('"signingConfigs": []'),
    'empty signingConfigs replaced');
  assert.ok(/staged[/]key\.p12/.test(profile),
    'signing material paths point at the staged dir');
}

// ---- 2. 占位符已被改过 → 拒绝猜测，构建失败 ----
{
  const hex = 'cd'.repeat(32);
  const s = stage('tampered', hex);
  // 恢复成"已非占位符"的状态再跑一次。
  const manifest = JSON.parse(readFileSync(s.manifest, 'utf8'));
  const entry = manifest.module.metaData.customizeData
    .find((e) => e.name === 'supportLists');
  entry.value = 'com.xiwei.suyue:' + 'ff'.repeat(32);
  writeFileSync(s.manifest, JSON.stringify(manifest, null, 2));
  // 还原 build-profile / identity：本用例只验证
  // Manifest 占位符守卫，其余注入前置条件保持不变。
  copyFileSync(join(REPO, 'apps/watch/build-profile.json5'),
    s.buildProfile);
  copyFileSync(join(REPO,
    'apps/watch/entry/src/main/js/MainAbility/wear/PhonePeerConfig.g.js'),
    s.identity);
  const again = spawnSync('python3', [
    join(REPO, 'tools/inject_signing.py'),
    '--material-json', material(hex),
    '--signing-dir', join(s.dir, 'staged'),
    '--build-profile', s.buildProfile,
    '--identity-file', s.identity,
    '--identity-var', 'INJECTED_PHONE_FINGERPRINT',
    '--fingerprint-key', 'phone',
    '--manifest', s.manifest,
    '--manifest-peer-bundle', 'com.xiwei.suyue'
  ], { encoding: 'utf8' });
  assert.notEqual(again.status, 0,
    'non-placeholder supportLists must fail the build');
  assert.ok(again.stderr.includes('supportLists'),
    'failure must name the manifest field');
}

// ---- 3. 指纹含分隔符 → 失败（不破坏 supportLists） ----
{
  const s = stage('badformat', 'aa:bb' + 'cc'.repeat(30));
  assert.notEqual(s.run.status, 0,
    'fingerprint with separators must be rejected');
}

// ---- 4. hex64 严格模式 ----
{
  const s = stage('strict', 'not-hex-fingerprint',
    { format: 'hex64' });
  assert.notEqual(s.run.status, 0,
    'hex64 mode must reject non-hex fingerprints');
  const ok = stage('strict-ok', 'ef'.repeat(32),
    { format: 'hex64' });
  assert.equal(ok.run.status, 0, ok.run.stderr);
}

// ---- 5. 宽松模式的合法非 hex 指纹被接受（P1-9：不无依据排斥） ----
{
  const s = stage('raw-format', 'b64AGF0dGVzdA==');
  assert.equal(s.run.status, 0, s.run.stderr);
  const manifest = JSON.parse(readFileSync(s.manifest, 'utf8'));
  const entry = manifest.module.metaData.customizeData
    .find((e) => e.name === 'supportLists');
  assert.equal(entry.value,
    'com.xiwei.suyue:b64AGF0dGVzdA==');
}

// ---- 6. 缺指纹字段 → 失败 ----
{
  const s = stage('missing-fp', '');
  assert.notEqual(s.run.status, 0, 'empty fingerprint must fail');
}

// ---- 7. Lite 外部签名：不触发 legacy SignHap，凭据能安全载入 ----
{
  const s = stage('lite-external', 'ac'.repeat(32), {
    external: true,
    extra: { keyPassword: "a' b$\\\\c" }
  });
  assert.equal(s.run.status, 0, s.run.stderr);
  assert.equal(readFileSync(s.buildProfile, 'utf8'),
    readFileSync(join(REPO, 'apps/watch/build-profile.json5'), 'utf8'),
    'Lite legacy signingConfigs must remain empty');
  const envFile = join(s.dir, 'staged/credentials.env');
  const loaded = spawnSync('bash', [
    '-c', 'source "$1"; printf "%s" "$KEY_PASSWORD"', 'bash', envFile
  ], { encoding: 'utf8' });
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.equal(loaded.stdout, "a' b$\\\\c");
}

// ---- 8. 本地构建直接注入指纹（issue #12）----
// build_phone_hap.sh 已从证书/profile 解析出指纹，只复用这里的
// hex64 校验与空占位替换；不应要求伪造 material JSON。
{
  const hex = '12'.repeat(32);
  const dir = join(tmp, 'direct');
  mkdirSync(dir, { recursive: true });
  const identity = join(dir, 'PeerIdentityConfig.g.ts');
  copyFileSync(join(REPO,
    'apps/phone/entry/src/main/ets/services/PeerIdentityConfig.g.ts'),
    identity);
  const args = [
    join(REPO, 'tools/inject_signing.py'),
    '--fingerprint-value', hex,
    '--identity-file', identity,
    '--identity-var', 'INJECTED_WATCH_FINGERPRINT',
    '--fingerprint-key', 'watch',
    '--fingerprint-format', 'hex64'
  ];
  const run = spawnSync('python3', args, { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const afterDirect = readFileSync(identity, 'utf8');
  assert.ok(afterDirect.includes(
    "export const INJECTED_WATCH_FINGERPRINT = '" + hex + "';"),
    'direct mode must replace the empty placeholder');

  const bad = spawnSync('python3', [
    join(REPO, 'tools/inject_signing.py'),
    '--fingerprint-value', 'not-a-cert-sha256',
    '--identity-file', identity,
    '--identity-var', 'INJECTED_WATCH_FINGERPRINT',
    '--fingerprint-key', 'watch',
    '--fingerprint-format', 'hex64'
  ], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0,
    'direct mode must enforce hex64');
  assert.equal(readFileSync(identity, 'utf8'), afterDirect,
    'failed validation must not mutate the identity file');

  const both = spawnSync('python3', [
    join(REPO, 'tools/inject_signing.py'),
    '--material-json', material(hex),
    '--fingerprint-value', hex,
    '--identity-file', identity,
    '--identity-var', 'INJECTED_WATCH_FINGERPRINT',
    '--fingerprint-key', 'watch'
  ], { encoding: 'utf8' });
  assert.notEqual(both.status, 0,
    'material mode and direct fingerprint mode must be exclusive');
}

console.info('PASS: signing injection (manifest ' +
  'supportLists, placeholder guard, fingerprint format ' +
  'policy, signingConfigs, identity file, direct fingerprint value)');
