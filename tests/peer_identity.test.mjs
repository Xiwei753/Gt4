// SPDX-License-Identifier: GPL-3.0-only
// Run: node tests/peer_identity.test.mjs
// Issue #14: WATCH_PEER is the GT 4 Lite identity
//   con.xiwei.suyue.gt4_<Base64(raw uncompressed EC point)>
// and must keep Base64 case, '+', '/', '='; a 64-hex SHA-256 is invalid.
import assert from 'node:assert/strict';
import {
  PHONE_SELF, WATCH_PEER, injectFingerprint, isConfigured
} from '../apps/phone/entry/src/main/ets/model/PeerIdentity.ts';

const BUNDLE = 'con.xiwei.suyue.gt4';
const P256 = BUNDLE + '_' +
  'BEWzvDkxDn4ueCkVNgwzqmrFXjhblq+CrbN+HUw4tLR5tMCz5ovAToeq9JX2' +
  'WFzIO7SoU4YKrDY85m5QgsLEWok=';
const P384 = BUNDLE + '_' +
  'BFonZBpw0jsN/xxNsthh5fn6VgSGuUviJZza7BlL8AtSNkFr7agh1psBZRSvecy' +
  'l4jPLPcld1VV4e4rzfGSTt0guTdUwq7wdpaRzAcHM+AwNJIBwjJv8A3nOpDh8d' +
  'cbwkQ==';
const SHA256 = 'fbdee2e124a2232509b1c614d452bded210d61fbd7fac62791199ac37a2701c1';

// 合法 Lite 指纹原样保留大小写和 +/=。
for (const value of [P256, P384]) {
  injectFingerprint('watch', value);
  assert.equal(WATCH_PEER.fingerprint, value);
  assert.equal(isConfigured(WATCH_PEER), true);
}
assert.ok(P256.includes('+') && P256.includes('=') &&
  P384.includes('/') && P384.includes('='),
  'test vectors must exercise +, / and =');

// 旧的 64 位证书摘要、错包名、坏 Base64、错长度、非 0x04 首字节都必须失败。
assert.equal(isConfigured({ bundleName: BUNDLE, fingerprint: SHA256 }), false);
assert.throws(() => injectFingerprint('watch', SHA256), /Base64/);
assert.throws(() => injectFingerprint('watch',
  'com.xiwei.suyue.gt4_' + P256.substring(BUNDLE.length + 1)), /Base64/);
assert.throws(() => injectFingerprint('watch',
  BUNDLE + '_' + P256.substring(BUNDLE.length + 1).replace('+', '-')),
  /Base64/);
assert.throws(() => injectFingerprint('watch',
  BUNDLE + '_' + Buffer.alloc(64, 7).toString('base64')), /Base64/);
assert.throws(() => injectFingerprint('watch',
  BUNDLE + '_' + Buffer.alloc(65, 0).toString('base64')), /Base64/);
assert.throws(() => injectFingerprint('watch', ''), /Base64/);

// PHONE_SELF 方向保持原有 64 位 hex 规则，不能把 Lite 指纹塞进去。
injectFingerprint('phone', 'AB'.repeat(32));
assert.equal(PHONE_SELF.fingerprint, 'ab'.repeat(32));
assert.equal(isConfigured(PHONE_SELF), true);
assert.throws(() => injectFingerprint('phone', P256), /64 hex/);

console.info('PASS: peer identity (Lite Base64 preserved, SHA-256 and ' +
  'wrong bundle/length/tag rejected, PHONE_SELF unchanged)');
