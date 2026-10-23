// SPDX-License-Identifier: GPL-3.0-only
// Run: node tests/watch_peer_fingerprint.test.mjs
// Issue #14: derive the phone->GT 4 WATCH_PEER from the certificate that
// actually signs the watch HAP.  The value is
//   con.xiwei.suyue.gt4_<Base64(uncompressed EC point)>
// not a certificate SHA-256 and not the Base64 of SPKI/hex text.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = process.cwd();
const TOOL = join(REPO, 'tools/watch_peer_fingerprint.py');
const BUNDLE = 'con.xiwei.suyue.gt4';
const tmp = mkdtempSync(join(tmpdir(), 'suyue-watch-peer-'));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0 && !options.allowFail) {
    throw new Error(command + ' failed: ' + (result.stderr || result.stdout));
  }
  return result;
}

function tool(args) {
  return run('python3', [TOOL, ...args], { allowFail: true });
}

function publicPoint(certPath) {
  const pem = run('openssl', ['x509', '-in', certPath, '-pubkey', '-noout']);
  const text = run('openssl', ['ec', '-pubin', '-text', '-noout'],
    { input: pem.stdout });
  let inside = false;
  let hex = '';
  for (const line of text.stdout.split('\n')) {
    const value = line.trim();
    if (value === 'pub:') {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (!/^[0-9a-f:]+$/.test(value)) break;
    hex += value.replace(/:/g, '');
  }
  assert.ok(hex.length >= 130 && hex.startsWith('04'),
    'expected an uncompressed EC point, got: ' + hex);
  return Buffer.from(hex, 'hex');
}

function expected(certPath) {
  return BUNDLE + '_' + publicPoint(certPath).toString('base64');
}

function makeSelfSigned(name, curve) {
  const key = join(tmp, name + '.key');
  const cert = join(tmp, name + '.pem');
  run('openssl', ['req', '-x509', '-newkey', 'ec',
    '-pkeyopt', 'ec_paramgen_curve:' + curve, '-nodes',
    '-keyout', key, '-out', cert, '-days', '2',
    '-subj', '/CN=' + name]);
  return { key, cert };
}

// ---- 1. P-256 certificate: point -> Base64 -> bundle_ value ----
const p256 = makeSelfSigned('suyue-p256', 'prime256v1');
const p256Value = expected(p256.cert);
const p256Run = tool(['--cert', p256.cert]);
assert.equal(p256Run.status, 0, p256Run.stderr);
assert.equal(p256Run.stdout.trim(), p256Value);
assert.ok(p256Run.stdout.includes(BUNDLE + '_'));
assert.ok(p256Run.stdout.includes('+') || p256Run.stdout.includes('/'),
  'Base64 must be preserved verbatim');
assert.ok(!/^[0-9a-f]{64}$/.test(p256Run.stdout.trim()),
  'must not emit a certificate SHA-256');

// ---- 2. P-384 support and root-first chain must select the leaf ----
const ca = makeSelfSigned('suyue-p384-ca', 'secp384r1');
const leafKey = join(tmp, 'suyue-chain-leaf.key');
const leafCsr = join(tmp, 'suyue-chain-leaf.csr');
const leafCert = join(tmp, 'suyue-chain-leaf.pem');
run('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout',
  '-out', leafKey]);
run('openssl', ['req', '-new', '-key', leafKey, '-out', leafCsr,
  '-subj', '/CN=suyue-chain-leaf']);
run('openssl', ['x509', '-req', '-in', leafCsr, '-CA', ca.cert,
  '-CAkey', ca.key, '-CAcreateserial', '-out', leafCert,
  '-days', '2', '-sha256']);
const chain = join(tmp, 'chain.pem');
writeFileSync(chain, readFileSync(ca.cert, 'utf8') + '\n' +
  readFileSync(leafCert, 'utf8'));
const leafValue = expected(leafCert);
const caValue = expected(ca.cert);
assert.notEqual(leafValue, caValue);
const chainRun = tool(['--cert', chain]);
assert.equal(chainRun.status, 0, chainRun.stderr);
assert.equal(chainRun.stdout.trim(), leafValue,
  'root-first chain must select the end-entity certificate');

// ---- 3. Watch profile is the authoritative source and checks bundle ----
const profileJson = join(tmp, 'profile.json');
writeFileSync(profileJson, JSON.stringify({
  'bundle-info': {
    'bundle-name': BUNDLE,
    'development-certificate': readFileSync(leafCert, 'utf8')
  }
}));
const profile = join(tmp, 'profile.p7b');
run('openssl', ['smime', '-sign', '-in', profileJson,
  '-signer', leafCert, '-inkey', leafKey, '-outform', 'DER',
  '-nodetach', '-binary', '-out', profile]);
const profileRun = tool(['--profile', profile]);
assert.equal(profileRun.status, 0, profileRun.stderr);
assert.equal(profileRun.stdout.trim(), leafValue);

const crossCheck = tool(['--profile', profile, '--cert', chain]);
assert.equal(crossCheck.status, 0, crossCheck.stderr);
assert.equal(crossCheck.stdout.trim(), leafValue);

const wrongProfileJson = join(tmp, 'wrong-profile.json');
writeFileSync(wrongProfileJson, JSON.stringify({
  'bundle-info': {
    'bundle-name': 'com.xiwei.suyue',
    'development-certificate': readFileSync(leafCert, 'utf8')
  }
}));
const wrongProfile = join(tmp, 'wrong-profile.p7b');
run('openssl', ['smime', '-sign', '-in', wrongProfileJson,
  '-signer', leafCert, '-inkey', leafKey, '-outform', 'DER',
  '-nodetach', '-binary', '-out', wrongProfile]);
const wrongRun = tool(['--profile', wrongProfile]);
assert.notEqual(wrongRun.status, 0,
  'a phone profile must not be accepted as the GT 4 profile');

// ---- 4. Explicit value must match the certificate ----
const expectOk = tool(['--profile', profile, '--expect', leafValue]);
assert.equal(expectOk.status, 0, expectOk.stderr);
assert.equal(expectOk.stdout.trim(), leafValue);
const expectBad = tool([
  '--profile', profile, '--expect', 'ab'.repeat(32)
]);
assert.notEqual(expectBad.status, 0,
  'old 64-hex SHA-256 must be rejected for WATCH_PEER');

// ---- 5. Mismatched certificate material must fail ----
const mismatch = tool(['--profile', profile, '--cert', p256.cert]);
assert.notEqual(mismatch.status, 0,
  'profile certificate must exist in the supplied chain');

console.info('PASS: watch peer fingerprint (EC point -> Base64, ' +
  'profile/chain identity, bundle guard, old SHA-256 rejected)');
