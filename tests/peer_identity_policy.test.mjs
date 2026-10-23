// SPDX-License-Identifier: GPL-3.0-only
// Run: node tests/peer_identity_policy.test.mjs
// Issue #13: phone/watch identity formats must stay distinct and fail closed.
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const tmp = mkdtempSync(join(tmpdir(), 'suyue-peer-policy-'));
const copy = join(tmp, 'PeerIdentityPolicy.mjs');
copyFileSync(join(process.cwd(),
  'apps/phone/entry/src/main/ets/model/PeerIdentityPolicy.js'), copy);
const policy = await import(pathToFileURL(copy).href);

const WATCH_BUNDLE = 'con.xiwei.suyue.gt4';
const APP_ID = '6917618613178762508';
const P256 = WATCH_BUNDLE + '_' +
  'BEWzvDkxDn4ueCkVNgwzqmrFXjhblq+CrbN+HUw4tLR5tMCz5ovAToeq9JX2' +
  'WFzIO7SoU4YKrDY85m5QgsLEWok=';
const P384 = WATCH_BUNDLE + '_' +
  'BFonZBpw0jsN/xxNsthh5fn6VgSGuUviJZza7BlL8AtSNkFr7agh1psBZRSvecy' +
  'l4jPLPcld1VV4e4rzfGSTt0guTdUwq7wdpaRzAcHM+AwNJIBwjJv8A3nOpDh8d' +
  'cbwkQ==';
const OFFICIAL = 'com.watch.wearengine_' +
  'BC1bSGDxiTcUEkNGNztsD6sLBFgFWQm9lPl05ktD1R8Bx8SvYQNhjlIMJJGRk' +
  'f8yVYNxMnwNCbxToR5xerVCp+o=';

// Official and real signed material both pass, preserving the exact text.
for (const value of [OFFICIAL, P256, P384]) {
  const bundle = value.substring(0, value.indexOf('_'));
  const result = policy.validateWatchLiteFingerprint(value, bundle);
  assert.equal(result.ok, true, value);
  assert.equal(result.value, value, 'case/+/= must be preserved');
  assert.ok([65, 97].includes(result.pointLength));
}

assert.equal(policy.identityConfigured(P256, policy.WATCH_LITE_KIND),
  true);
assert.equal(policy.identityConfigured(APP_ID, policy.PHONE_APP_ID_KIND),
  true);

// A 64-hex certificate SHA-256 is not a Lite identity.
const sha = policy.validateWatchLiteFingerprint(
  'fbdee2e124a2232509b1c614d452bded210d61fbd7fac62791199ac37a2701c1',
  WATCH_BUNDLE);
assert.equal(sha.ok, false);
assert.equal(sha.code, 'lite-prefix');
assert.ok(sha.message.includes('SHA-256'));

// Wrong bundle, APP ID in the wrong direction, malformed Base64,
// non-canonical padding, wrong point tag and wrong length all fail.
assert.equal(policy.validateWatchLiteFingerprint(
  OFFICIAL, WATCH_BUNDLE).ok, false);
assert.equal(policy.validateWatchLiteFingerprint(
  APP_ID, WATCH_BUNDLE).ok, false);
assert.equal(policy.validateWatchLiteFingerprint(
  WATCH_BUNDLE + '_not-base64!', WATCH_BUNDLE).ok, false);
assert.equal(policy.validateWatchLiteFingerprint(
  WATCH_BUNDLE + '_' + 'A'.repeat(86) + 'B=', WATCH_BUNDLE).ok, false);
const zeroPoint = Buffer.alloc(65, 0).toString('base64');
const zero = policy.validateWatchLiteFingerprint(
  WATCH_BUNDLE + '_' + zeroPoint, WATCH_BUNDLE);
assert.equal(zero.ok, false);
assert.equal(zero.code, 'lite-point-prefix');
const shortPoint = Buffer.concat([Buffer.from([4]), Buffer.alloc(63, 7)])
  .toString('base64');
assert.equal(policy.validateWatchLiteFingerprint(
  WATCH_BUNDLE + '_' + shortPoint, WATCH_BUNDLE).ok, false);

// Phone APP ID: digits only, 10-32; not a digest and not a Lite value.
assert.equal(policy.validatePhoneAppId(APP_ID).ok, true);
assert.equal(policy.validatePhoneAppId('1234567890').ok, true);
for (const bad of ['', '12345', 'ab'.repeat(32), P256,
  'com.xiwei.suyue', APP_ID + 'x']) {
  const result = policy.validatePhoneAppId(bad);
  assert.equal(result.ok, false, bad);
  assert.equal(result.kind, policy.PHONE_APP_ID_KIND);
}

assert.equal(policy.identityConfigured('', policy.WATCH_LITE_KIND), false);
assert.equal(policy.identityConfigured(sha, policy.WATCH_LITE_KIND), false);
assert.equal(policy.identityConfigured('', policy.PHONE_APP_ID_KIND), false);
assert.ok(policy.describeIdentity(P256, policy.WATCH_LITE_KIND)
  .includes('Base64'));
assert.ok(policy.describeIdentity(APP_ID, policy.PHONE_APP_ID_KIND)
  .includes('APP ID'));

console.info('PASS: peer identity policy (Lite P-256/P-384 base64, ' +
  'official example, APP ID separation, fail-closed negatives)');
