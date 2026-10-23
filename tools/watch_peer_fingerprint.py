#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Extract the GT 4 Lite peer identity used by the phone's WATCH_PEER.

Huawei's Lite Wearable rule is:

    <bundleName>_<standard Base64(uncompressed EC public point)>

The point is the raw SEC1 point from the certificate that actually signs the
watch HAP (65/97/133 bytes, first byte 0x04).  A certificate SHA-256, the
Base64 of SPKI/DER, or the Base64 of the public-key hex text is NOT accepted.

The watch profile is the strongest source: it names the watch bundle and
embeds the development certificate.  A certificate/chain is accepted as a
fallback, but the end-entity certificate is identified by its issuer link,
never by "take the first certificate" (real chains are root-first).
"""
import argparse
import base64
import hashlib
import json
import re
import ssl
import subprocess
import sys

WATCH_BUNDLE = 'con.xiwei.suyue.gt4'
POINT_LENGTHS = (65, 97, 133)
EC_PUBLIC_KEY_OID = b'\x06\x07\x2a\x86\x48\xce\x3d\x02\x01'
BASE64_RE = re.compile(r'^[A-Za-z0-9+/]+={0,2}$')
PEM_CERT_RE = re.compile(
    rb'-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----',
    re.DOTALL)


def fail(message):
    print('ERROR: ' + message, file=sys.stderr)
    raise SystemExit(1)


def openssl(args, stdin=None):
    try:
        return subprocess.run(
            ['openssl'] + args, input=stdin,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError:
        fail('找不到 openssl，无法解析签名证书。')


def read_tlv(data, offset):
    if offset >= len(data):
        fail('DER 在偏移 %d 处截断' % offset)
    tag = data[offset]
    offset += 1
    if offset >= len(data):
        fail('DER 长度字段缺失')
    first = data[offset]
    offset += 1
    if first < 0x80:
        length = first
    elif first == 0x80:
        fail('不支持不定长 DER')
    else:
        count = first & 0x7f
        if count == 0 or count > 4:
            fail('DER 长度字段非法')
        if offset + count > len(data):
            fail('DER 长度字段截断')
        length = int.from_bytes(data[offset:offset + count], 'big')
        offset += count
    end = offset + length
    if end > len(data):
        fail('DER 对象长度越界')
    return tag, data[offset:end], end


def extract_point(spki):
    tag, body, end = read_tlv(spki, 0)
    if tag != 0x30 or end != len(spki):
        fail('公钥不是单个 SPKI SEQUENCE')
    tag, algorithm, pos = read_tlv(body, 0)
    if tag != 0x30:
        fail('SPKI 缺少 AlgorithmIdentifier')
    if not algorithm.startswith(EC_PUBLIC_KEY_OID):
        fail('签名公钥不是 EC 公钥（id-ecPublicKey）')
    tag, bits, pos = read_tlv(body, pos)
    if tag != 0x03 or pos != len(body):
        fail('SPKI 缺少 BIT STRING 或存在尾随数据')
    if not bits or bits[0] != 0:
        fail('EC 公钥 BIT STRING 为空或存在未使用位')
    point = bits[1:]
    if len(point) not in POINT_LENGTHS:
        fail('EC 公钥点长度必须是 65/97/133 字节，实际 %d' % len(point))
    if point[0] != 0x04:
        fail('EC 公钥点必须是未压缩格式（首字节 0x04），实际 0x%02x'
             % point[0])
    return point


def pem_digest(pem_text):
    try:
        der = ssl.PEM_cert_to_DER_cert(pem_text)
    except (ValueError, ssl.SSLError) as exc:
        fail('证书不是可解析的 PEM：%s' % exc)
    if not der:
        fail('证书解析后为空')
    return hashlib.sha256(der).hexdigest()


def certs_from_bytes(raw):
    blocks = PEM_CERT_RE.findall(raw)
    if blocks:
        return [block.decode('ascii') + '\n' for block in blocks]
    converted = openssl(['x509', '-inform', 'DER', '-outform', 'PEM'], raw)
    if converted.returncode != 0 or not converted.stdout:
        fail('无法把证书链解析为 PEM：%s'
             % converted.stderr.decode('utf-8', 'replace').strip()[:300])
    return [converted.stdout.decode('ascii')]


def names_of(pem_text):
    parsed = openssl(
        ['x509', '-noout', '-subject', '-issuer', '-nameopt', 'RFC2253'],
        pem_text.encode('ascii'))
    if parsed.returncode != 0:
        fail('无法解析证书主题：%s'
             % parsed.stderr.decode('utf-8', 'replace').strip()[:300])
    subject = ''
    issuer = ''
    for line in parsed.stdout.decode('utf-8', 'replace').splitlines():
        if line.startswith('subject='):
            subject = line[len('subject='):].strip()
        elif line.startswith('issuer='):
            issuer = line[len('issuer='):].strip()
    if not subject or not issuer:
        fail('证书缺少 subject/issuer')
    return subject, issuer


def leaf_from_chain(raw):
    certs = certs_from_bytes(raw)
    parsed = [names_of(cert) for cert in certs]
    leaves = []
    for index, (subject, _) in enumerate(parsed):
        issued_others = any(
            subject == parsed[other][1]
            for other in range(len(parsed)) if other != index)
        if not issued_others:
            leaves.append(index)
    if len(leaves) != 1:
        fail('无法唯一确定证书链中的叶证书（候选 %d 个）；'
             '请改用 --profile 指定手表 profile' % len(leaves))
    leaf = certs[leaves[0]]
    return leaf, pem_digest(leaf)


def read_profile(path, bundle):
    try:
        raw = open(path, 'rb').read()
    except OSError as exc:
        fail('无法读取 profile：%s' % exc)
    if not raw:
        fail('profile 为空：%s' % path)
    inform = 'DER' if raw[:1] == b'\x30' else 'PEM'
    verified = openssl(
        ['smime', '-verify', '-noverify', '-inform', inform,
         '-in', path])
    if verified.returncode != 0:
        verified = openssl(
            ['cms', '-verify', '-noverify', '-inform', inform,
             '-in', path])
    if verified.returncode != 0:
        fail('无法解析 profile：%s'
             % verified.stderr.decode('utf-8', 'replace').strip()[:300])
    try:
        profile = json.loads(verified.stdout.decode('utf-8'))
    except (UnicodeDecodeError, ValueError) as exc:
        fail('profile 内容不是 JSON：%s' % exc)
    info = profile.get('bundle-info') or {}
    actual_bundle = info.get('bundle-name')
    if actual_bundle != bundle:
        fail('profile 的 bundle-name 是 %r，期望 %r；'
             '不能拿别的应用的 profile 冒充 GT 4 身份'
             % (actual_bundle, bundle))
    certificate = info.get('development-certificate')
    if not isinstance(certificate, str) or not certificate.strip():
        fail('profile 缺少 bundle-info.development-certificate')
    return certificate, pem_digest(certificate)


def validate_watch_lite(value, bundle):
    text = str(value or '').strip()
    prefix = bundle + '_'
    if not text.startswith(prefix):
        fail('WATCH_PEER 必须是 <bundleName>_<Base64(EC 公钥点)>，'
             'bundle 必须是 %s：%r' % (bundle, value))
    payload = text[len(prefix):]
    if len(payload) % 4 != 0 or not BASE64_RE.match(payload):
        fail('WATCH_PEER 的 Base64 部分不是标准 Base64（保留大小写与 +/=）')
    try:
        point = base64.b64decode(payload, validate=True)
    except ValueError:
        fail('WATCH_PEER 的 Base64 部分不是合法 Base64')
    if base64.b64encode(point).decode('ascii') != payload:
        fail('WATCH_PEER 的 Base64 不是规范编码（大小写/填充不一致）')
    if len(point) not in POINT_LENGTHS:
        fail('WATCH_PEER 公钥必须是未压缩 EC 点（65/97/133 字节），'
             '实际 %d 字节' % len(point))
    if point[0] != 0x04:
        fail('WATCH_PEER 公钥首字节必须是 0x04（未压缩点），'
             '实际 0x%02x' % point[0])
    return text


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--profile', default='',
                        help='手表签名 profile（.p7b，最可靠）')
    parser.add_argument('--cert', default='',
                        help='手表签名证书链（PEM/DER，作为兜底）')
    parser.add_argument('--bundle', default=WATCH_BUNDLE,
                        help='手表真实包名（默认 %s）' % WATCH_BUNDLE)
    parser.add_argument('--expect', default='',
                        help='显式给定的完整 Lite 指纹；提供材料时必须一致')
    args = parser.parse_args()

    expected = ''
    if args.expect:
        expected = validate_watch_lite(args.expect, args.bundle)

    if not args.profile and not args.cert:
        if expected:
            print(expected)
            return
        fail('需要 --profile 或 --cert 才能确定手表签名证书；'
             '不允许猜测或生成假指纹')

    if args.profile:
        certificate, certificate_digest = read_profile(
            args.profile, args.bundle)
        if args.cert:
            chain = certs_from_bytes(open(args.cert, 'rb').read())
            chain_digests = {pem_digest(item) for item in chain}
            if certificate_digest not in chain_digests:
                fail('profile 的证书不在 --cert 证书链中；'
                     '无法确认二者是同一张签名证书')
    else:
        certificate, certificate_digest = leaf_from_chain(
            open(args.cert, 'rb').read())

    public_key = openssl(
        ['x509', '-pubkey', '-noout'], certificate.encode('ascii'))
    if public_key.returncode != 0:
        fail('无法读取证书公钥：%s'
             % public_key.stderr.decode('utf-8', 'replace').strip()[:300])
    spki = openssl(
        ['pkey', '-pubin', '-outform', 'DER'], public_key.stdout)
    if spki.returncode != 0 or not spki.stdout:
        fail('无法导出证书公钥 SPKI：%s'
             % spki.stderr.decode('utf-8', 'replace').strip()[:300])

    point = extract_point(spki.stdout)
    value = args.bundle + '_' + base64.b64encode(point).decode('ascii')
    value = validate_watch_lite(value, args.bundle)
    if expected and value != expected:
        fail('显式指纹与签名证书不一致：期望 %r，证书实际 %r'
             % (expected, value))

    print('WATCH_CERT_SHA256=' + certificate_digest, file=sys.stderr)
    print('WATCH_POINT_BYTES=%d' % len(point), file=sys.stderr)
    print(value)


if __name__ == '__main__':
    main()
