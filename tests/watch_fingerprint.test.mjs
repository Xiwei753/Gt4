// SPDX-License-Identifier: GPL-3.0-only
// Run: node tests/watch_fingerprint.test.mjs
// issue #12：本地构建必须从真实签名材料解析 GT 4 证书 SHA-256，
// 不能取 HAP 文件哈希、公钥哈希、profile 文件哈希或随机值。
// 这里用临时生成的自签名证书/PKCS#7 profile 覆盖 PEM、DER、
// 证书链歧义、profile 包名校验和显式指纹交叉校验。
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
const tmp = mkdtempSync(join(tmpdir(), 'suyue-watch-fp-'));

function run(args) {
  return spawnSync('python3', [SCRIPT, ...args], {
    encoding: 'utf8'
  });
}

function openssl(args) {
  const result = spawnSync('openssl', args, { encoding: 'utf8' });
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
  const chainPem = join(tmp, 'chain.pem');

  openssl(['req', '-x509', '-newkey', 'ec',
    '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-keyout', leafKey, '-out', leafPem, '-days', '2',
    '-subj', '/CN=suyue-test-leaf',
    '-addext', 'basicConstraints=critical,CA:FALSE']);
  openssl(['req', '-x509', '-newkey', 'ec',
    '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
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
  assert.match(leafSha, /^[0-9a-f]{64}$/);

  // 1) PEM / DER 单证书
  for (const cert of [leafPem, leafDer]) {
    const result = run(['--cert', cert]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), leafSha,
      'certificate DER-SHA256 must be the fingerprint');
    assert.match(result.stderr, /WATCH_FINGERPRINT_SOURCE=cert/);
  }

  // 2) 两张终端证书的链无法判定 → 失败，不能静默取第一张。
  //    PEM 和“多个 DER 对象直接拼接”的链都必须识别，不能只读第一张。
  for (const chain of [chainPem, chainDer]) {
    const ambiguous = run(['--cert', chain]);
    assert.notEqual(ambiguous.status, 0,
      'ambiguous chain must fail: ' + chain);
    assert.match(ambiguous.stderr, /候选终端证书/);
  }

  // 3) 生成一个真实的 PKCS#7 profile（内嵌 development-certificate）
  const profile = {
    'version-name': 'test',
    'type': 'debug',
    'bundle-info': {
      'bundle-name': 'con.xiwei.suyue.gt4',
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
    assert.equal(result.stdout.trim(), leafSha);
  }

  // 4) profile 包名必须是手表包名，不能拿手机 profile 冒充
  const wrongBundle = run(['--profile', profileP7b,
    '--bundle', 'com.xiwei.suyue']);
  assert.notEqual(wrongBundle.status, 0);
  assert.match(wrongBundle.stderr, /bundle-name/);

  // 5) 显式指纹可带大写/冒号，但必须与材料一致
  const colon = leafSha.toUpperCase().match(/../g).join(':');
  const explicit = run(['--fingerprint', colon,
    '--profile', profileP7b, '--cert', leafPem]);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(explicit.stdout.trim(), leafSha);

  const mismatch = run(['--fingerprint', 'ab'.repeat(32),
    '--profile', profileP7b]);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /不一致/);

  // 6) 没有材料/没有显式值 → 失败
  const missing = run([]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /没有可用的手表签名材料/);

  // 7) 本机真实材料存在时，profile 和证书链必须给出同一个值
  const realProfile = join(REPO, 'signing/watch/debug.p7b');
  const realCert = join(REPO, 'signing/shared/debug.cer');
  if (existsSync(realProfile) && existsSync(realCert)) {
    const real = run(['--profile', realProfile, '--cert', realCert]);
    assert.equal(real.status, 0, real.stderr);
    assert.equal(real.stdout.trim(),
      'fbdee2e124a2232509b1c614d452bded210d61fbd7fac62791199ac37a2701c1',
      'local GT 4 profile and certificate chain must agree');
  }

  console.info('PASS: watch fingerprint extraction ' +
    '(PEM/DER, chain ambiguity, p7b profile, bundle guard, explicit cross-check)');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
