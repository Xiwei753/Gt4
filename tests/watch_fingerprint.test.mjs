// SPDX-License-Identifier: GPL-3.0-only
// Run: node tests/watch_fingerprint.test.mjs
// Issue #13: derive the GT 4 Lite identity from the real signing cert:
//   <watch bundle>_<standard Base64(raw uncompressed EC public point)>.
// The certificate SHA-256 is only a diagnostic (--format sha256), never the
// Wear Engine Lite fingerprint. Also covers phone APP ID extraction from the
// phone profile (bundle-info.app-identifier).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = process.cwd();
const SCRIPT = join(REPO, 'tools/extract_watch_fingerprint.py');
const APPID_SCRIPT = join(REPO, 'tools/extract_phone_app_id.py');
const WATCH_BUNDLE = 'con.xiwei.suyue.gt4';
const PHONE_BUNDLE = 'com.xiwei.suyue';
const APP_ID = '6917618613178762508';
const OFFICIAL_LITE = 'com.watch.wearengine_' +
  'BC1bSGDxiTcUEkNGNztsD6sLBFgFWQm9lPl05ktD1R8Bx8SvYQNhjlIMJJGRk' +
  'f8yVYNxMnwNCbxToR5xerVCp+o=';
const tmp = mkdtempSync(join(tmpdir(), 'suyue-watch-fp-'));

function runScript(script, args) {
  return spawnSync('python3', [script, ...args], { encoding: 'utf8' });
}

function run(args) {
  return runScript(SCRIPT, args);
}

function runAppId(args) {
  return runScript(APPID_SCRIPT, args);
}

function openssl(args, input) {
  const result = spawnSync('openssl', args, { encoding: 'utf8', input });
  assert.equal(result.status, 0,
    'openssl ' + args.join(' ') + ': ' + result.stderr);
  return result;
}

function expectedSha(pemPath) {
  const der = spawnSync('openssl',
    ['x509', '-in', pemPath, '-outform', 'DER']);
  assert.equal(der.status, 0, String(der.stderr));
  return createHash('sha256').update(der.stdout).digest('hex');
}

// Independently extract the last 65 bytes of the P-256 SPKI. This test leaf
// is always P-256; the SPKI suffix is exactly the raw uncompressed point.
function expectedLite(pemPath, bundle) {
  const pub = openssl(['x509', '-in', pemPath, '-pubkey', '-noout']).stdout;
  const der = spawnSync('openssl',
    ['pkey', '-pubin', '-outform', 'DER'], { input: pub });
  assert.equal(der.status, 0, String(der.stderr));
  const point = der.stdout.subarray(der.stdout.length - 65);
  assert.equal(point.length, 65);
  assert.equal(point[0], 0x04);
  return bundle + '_' + point.toString('base64');
}

try {
  const version = spawnSync('openssl', ['version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, 'openssl is required for this test');

  const leafPem = join(tmp, 'leaf.pem');
  const leafKey = join(tmp, 'leaf.key');
  const leafDer = join(tmp, 'leaf.der');
  const rootDer = join(tmp, 'root.der');
  const chainDer = join(tmp, 'chain.der');
  const rootPem = join(tmp, 'root.pem');
  const rootKey = join(tmp, 'root.key');
  const profileJson = join(tmp, 'profile.json');
  const profileP7b = join(tmp, 'profile.p7b');
  const phoneProfileJson = join(tmp, 'phone-profile.json');
  const phoneProfileP7b = join(tmp, 'phone-profile.p7b');
  const chainPem = join(tmp, 'chain.pem');

  openssl(['req', '-x509', '-newkey', 'ec',
    '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-keyout', leafKey, '-out', leafPem, '-days', '2',
    '-subj', '/CN=suyue-test-leaf',
    '-addext', 'basicConstraints=critical,CA:FALSE']);
  // The issuer is P-384 so the chain exercises mixed key sizes; the
  // selected end-entity leaf must still be the P-256 cert.
  openssl(['req', '-x509', '-newkey', 'ec',
    '-pkeyopt', 'ec_paramgen_curve:P-384', '-nodes',
    '-keyout', rootKey, '-out', rootPem, '-days', '2',
    '-subj', '/CN=suyue-test-root',
    '-addext', 'basicConstraints=critical,CA:FALSE']);
  openssl(['x509', '-in', leafPem, '-outform', 'DER', '-out', leafDer]);
  openssl(['x509', '-in', rootPem, '-outform', 'DER', '-out', rootDer]);
  writeFileSync(chainPem,
    readFileSync(leafPem, 'utf8') + readFileSync(rootPem, 'utf8'));
  writeFileSync(chainDer,
    Buffer.concat([readFileSync(leafDer), readFileSync(rootDer)]));

  const leafSha = expectedSha(leafPem);
  const leafLite = expectedLite(leafPem, WATCH_BUNDLE);
  assert.match(leafSha, /^[0-9a-f]{64}$/);

  // 1) Default is the Lite pubkey identity, from PEM or DER.
  for (const cert of [leafPem, leafDer]) {
    const result = run(['--cert', cert]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), leafLite,
      'Lite fingerprint must be bundle_Base64(raw EC point)');
    assert.match(result.stderr, /WATCH_FINGERPRINT_SOURCE=cert/);
    assert.match(result.stderr, /format=lite/);
  }

  // 2) SHA-256 remains available only as an explicit diagnostic mode.
  for (const cert of [leafPem, leafDer]) {
    const result = run(['--cert', cert, '--format', 'sha256']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), leafSha);
    assert.match(result.stderr, /format=sha256/);
  }

  // 3) Two end-entity certs cannot be disambiguated -> fail in either mode.
  for (const chain of [chainPem, chainDer]) {
    for (const format of ['lite', 'sha256']) {
      const ambiguous = run(['--cert', chain, '--format', format]);
      assert.notEqual(ambiguous.status, 0,
        'ambiguous chain must fail: ' + chain);
      assert.match(ambiguous.stderr, /候选终端证书/);
    }
  }

  // 4) Real PKCS#7 profiles embedding development-certificate/app-identifier.
  const profile = {
    'version-name': 'test',
    'type': 'debug',
    'bundle-info': {
      'bundle-name': WATCH_BUNDLE,
      'development-certificate': readFileSync(leafPem, 'utf8')
    }
  };
  writeFileSync(profileJson, JSON.stringify(profile));
  openssl(['smime', '-sign', '-in', profileJson,
    '-signer', leafPem, '-inkey', leafKey,
    '-outform', 'DER', '-nodetach', '-out', profileP7b]);

  for (const args of [
    ['--profile', profileP7b],
    ['--profile', profileP7b, '--cert', chainPem],
    ['--profile', profileP7b, '--cert', leafPem]
  ]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), leafLite);
  }
  const profileSha = run(['--profile', profileP7b,
    '--cert', chainPem, '--format', 'sha256']);
  assert.equal(profileSha.status, 0, profileSha.stderr);
  assert.equal(profileSha.stdout.trim(), leafSha);

  // 5) The watch profile must carry the watch bundle, not the phone bundle.
  const wrongBundle = run(['--profile', profileP7b,
    '--bundle', PHONE_BUNDLE]);
  assert.notEqual(wrongBundle.status, 0);
  assert.match(wrongBundle.stderr, /bundle-name/);

  // 6) An explicit Lite value must match the material exactly.
  const explicit = run(['--fingerprint', leafLite,
    '--profile', profileP7b, '--cert', leafPem]);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(explicit.stdout.trim(), leafLite);

  const mismatch = run(['--fingerprint', WATCH_BUNDLE + '_' +
    Buffer.alloc(65, 4).toString('base64'), '--profile', profileP7b]);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /不一致/);

  // 7) No material/explicit value -> fail.
  const missing = run([]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /没有可用的手表签名材料/);

  // 8) Official Huawei Lite example is accepted as an explicit identity.
  const official = run(['--bundle', 'com.watch.wearengine',
    '--fingerprint', OFFICIAL_LITE]);
  assert.equal(official.status, 0, official.stderr);
  assert.equal(official.stdout.trim(), OFFICIAL_LITE);

  // 9) Phone APP ID comes from the phone profile's app-identifier.
  const phoneProfile = {
    'version-name': 'test',
    'type': 'debug',
    'bundle-info': {
      'bundle-name': PHONE_BUNDLE,
      'app-identifier': APP_ID,
      'development-certificate': readFileSync(leafPem, 'utf8')
    }
  };
  writeFileSync(phoneProfileJson, JSON.stringify(phoneProfile));
  openssl(['smime', '-sign', '-in', phoneProfileJson,
    '-signer', leafPem, '-inkey', leafKey,
    '-outform', 'DER', '-nodetach', '-out', phoneProfileP7b]);

  const appId = runAppId(['--profile', phoneProfileP7b]);
  assert.equal(appId.status, 0, appId.stderr);
  assert.equal(appId.stdout.trim(), APP_ID);
  assert.match(appId.stderr, /PHONE_APP_ID_SOURCE=profile/);

  const appIdMaterial = runAppId(['--material-json', JSON.stringify({
    profileB64: readFileSync(phoneProfileP7b).toString('base64')
  })]);
  assert.equal(appIdMaterial.status, 0, appIdMaterial.stderr);
  assert.equal(appIdMaterial.stdout.trim(), APP_ID);
  assert.match(appIdMaterial.stderr, /PHONE_APP_ID_SOURCE=material/);

  const appIdWrongBundle = runAppId(
    ['--profile', phoneProfileP7b, '--bundle', WATCH_BUNDLE]);
  assert.notEqual(appIdWrongBundle.status, 0);
  assert.match(appIdWrongBundle.stderr, /bundle-name/);

  const appIdMismatch = runAppId(
    ['--profile', phoneProfileP7b, '--app-id', '1234567890']);
  assert.notEqual(appIdMismatch.status, 0);
  assert.match(appIdMismatch.stderr, /不一致/);

  // 10) Local real signing material must agree and produce the known values.
  const realProfile = join(REPO, 'signing/watch/debug.p7b');
  const realCert = join(REPO, 'signing/shared/debug.cer');
  if (existsSync(realProfile) && existsSync(realCert)) {
    const real = run(['--profile', realProfile, '--cert', realCert]);
    assert.equal(real.status, 0, real.stderr);
    assert.equal(real.stdout.trim(),
      'con.xiwei.suyue.gt4_BEWzvDkxDn4ueCkVNgwzqmrFXjhblq+CrbN+' +
      'HUw4tLR5tMCz5ovAToeq9JX2WFzIO7SoU4YKrDY85m5QgsLEWok=',
      'local GT 4 profile must yield the leaf Lite identity');
    const realSha = run(['--profile', realProfile,
      '--cert', realCert, '--format', 'sha256']);
    assert.equal(realSha.status, 0, realSha.stderr);
    assert.equal(realSha.stdout.trim(),
      'fbdee2e124a2232509b1c614d452bded210d61fbd7fac62791199ac37a2701c1',
      'local certificate SHA-256 is diagnostic only');
  }

  const realPhone = join(REPO, 'signing/phone/debug.p7b');
  if (existsSync(realPhone)) {
    const realAppId = runAppId(['--profile', realPhone]);
    assert.equal(realAppId.status, 0, realAppId.stderr);
    assert.equal(realAppId.stdout.trim(), APP_ID,
      'local phone profile app-identifier is the phone APP ID');
  }

  console.info('PASS: watch Lite fingerprint + phone APP ID extraction ' +
    '(PEM/DER, P-384 chain, p7b, bundle guard, explicit cross-check, ' +
    'official example)');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
