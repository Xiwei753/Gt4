#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Resolve the GT 4 Lite Wear Engine peer identity.

For a Lite Wearable target, the Huawei Wear Engine identity is
``bundleName + '_' + Base64(raw EC public point)``.  The point is the
uncompressed SEC1 point from the signing certificate (first byte 0x04),
NOT a certificate SHA-256 and NOT Base64 of the SPKI/DER or of the hex text.

``--format sha256`` keeps the old certificate-digest output for diagnostics
only.  It is not the phone->watch peer identity.

Sources, in order of strength:

1. ``--profile``: a HarmonyOS ``.p7b`` profile.  Its signed JSON contains
   ``bundle-info.bundle-name`` and ``bundle-info.development-certificate``.
   This directly names the certificate that can sign the app, and gives us
   a bundle-name check for the watch (``con.xiwei.suyue.gt4``).
2. ``--cert``: a PEM/DER certificate or chain.  When a profile is also
   supplied, the profile certificate must be present in the chain.  Without
   a profile, exactly one end-entity certificate must be identifiable; an
   ambiguous chain is an error (never "take the first").
3. ``--fingerprint``: an explicit, already-verified value in the selected
   format.  When material is supplied, it must match.

Only the normalised identity is written to stdout.  Diagnostics go to
stderr.
"""
import argparse
import hashlib
import json
import os
import re
import ssl
import subprocess
import sys

from peer_identity_formats import (
    IdentityFormatError,
    extract_ec_point_from_spki_der,
    format_watch_lite,
    validate_watch_lite,
)

WATCH_BUNDLE = 'con.xiwei.suyue.gt4'
HEX64 = re.compile(r'^[0-9a-f]{64}$')
PEM_CERT = re.compile(
    rb'-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----',
    re.DOTALL)
PEM_CERT_TEXT = re.compile(
    r'-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----',
    re.DOTALL)


def fail(message):
    print('ERROR: ' + message, file=sys.stderr)
    raise SystemExit(1)


def openssl(args, stdin=None):
    try:
        return subprocess.run(
            ['openssl'] + args,
            input=stdin,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE)
    except FileNotFoundError:
        fail('找不到 openssl；无法解析证书/profile。')


def short(text, limit=300):
    value = text.decode('utf-8', 'replace').strip()
    return value[:limit] + ('…' if len(value) > limit else '')


def normalize_fingerprint(value, where):
    text = str(value or '').strip()
    if not text:
        fail('%s 指纹为空' % where)
    # Accept the common uppercase/colon display form, then enforce the
    # on-wire form: lowercase, 64 hex chars, no separators.
    text = text.lower().replace(':', '')
    if not HEX64.match(text):
        fail('%s 指纹不是 64 位十六进制 SHA-256：%r' % (where, value))
    return text


def sha256_pem(pem, where):
    try:
        der = ssl.PEM_cert_to_DER_cert(pem)
    except Exception as exc:
        fail('%s 不是可解析的 PEM 证书：%s' % (where, exc))
    if not der:
        fail('%s 证书解析后为空' % where)
    return hashlib.sha256(der).hexdigest(), der


def read_profile(path, bundle):
    if not os.path.isfile(path):
        fail('profile 不存在：%s' % path)
    raw = open(path, 'rb').read()
    if not raw:
        fail('profile 为空：%s' % path)
    inform = 'DER' if raw[:1] == b'\x30' else 'PEM'
    verify = openssl(
        ['smime', '-verify', '-noverify', '-inform', inform,
         '-in', path])
    if verify.returncode != 0:
        verify = openssl(
            ['cms', '-verify', '-noverify', '-inform', inform,
             '-in', path])
    if verify.returncode != 0:
        fail('无法解析 profile（%s）：%s' % (path, short(verify.stderr)))
    try:
        profile = json.loads(verify.stdout.decode('utf-8'))
    except (UnicodeDecodeError, ValueError) as exc:
        fail('profile 内容不是 JSON（%s）：%s' % (path, exc))

    info = profile.get('bundle-info') or {}
    actual_bundle = info.get('bundle-name')
    if actual_bundle != bundle:
        fail('profile 的 bundle-name 是 %r，期望 %r；'
             '不能拿别的应用的 profile 冒充手表身份'
             % (actual_bundle, bundle))
    pem = info.get('development-certificate')
    if not isinstance(pem, str) or not pem.strip():
        fail('profile 缺少 bundle-info.development-certificate')
    digest, der = sha256_pem(pem, 'profile development-certificate')
    return digest, der, pem


def split_der_objects(raw):
    """Split concatenated DER objects without silently dropping bytes."""
    raw = raw.rstrip(b'\r\n\t ')
    objects = []
    offset = 0
    while offset < len(raw):
        if raw[offset] != 0x30:
            fail('DER 文件偏移 %d 处不是 ASN.1 SEQUENCE；'
                 '拒绝忽略尾部数据' % offset)
        if offset + 2 > len(raw):
            fail('DER 文件在偏移 %d 处截断' % offset)
        first = raw[offset + 1]
        if first < 0x80:
            length = first
            header = 2
        elif first == 0x80:
            fail('不支持不定长 DER 编码')
        else:
            count = first & 0x7f
            if count == 0 or count > 8:
                fail('DER 长度字段非法（偏移 %d）' % offset)
            if offset + 2 + count > len(raw):
                fail('DER 文件在偏移 %d 处截断' % offset)
            length = int.from_bytes(
                raw[offset + 2:offset + 2 + count], 'big')
            header = 2 + count
        end = offset + header + length
        if end > len(raw):
            fail('DER 对象长度越界（偏移 %d）' % offset)
        objects.append(raw[offset:end])
        offset = end
    return objects


def load_cert_chain(path):
    if not os.path.isfile(path):
        fail('证书不存在：%s' % path)
    raw = open(path, 'rb').read()
    if not raw:
        fail('证书文件为空：%s' % path)

    if b'-----BEGIN CERTIFICATE-----' in raw:
        pems = [m.group(0).decode('ascii')
                for m in PEM_CERT.finditer(raw)]
        if not pems:
            fail('PEM 文件中没有证书：%s' % path)
        return pems

    # DER: split top-level objects first.  `openssl x509` happily parses
    # the first certificate in a concatenated DER chain and ignores the
    # rest; doing that here would silently "take the first" — exactly the
    # ambiguity issue #12 forbids.
    objects = split_der_objects(raw)
    if len(objects) > 1:
        pems = []
        for index, obj in enumerate(objects):
            check = openssl(
                ['x509', '-inform', 'DER', '-noout', '-subject'],
                stdin=obj)
            if check.returncode != 0:
                fail('DER 链第 %d 个对象不是 X.509 证书：%s'
                     % (index + 1, short(check.stderr)))
            pems.append(ssl.DER_cert_to_PEM_cert(obj))
        return pems

    # A single DER object is either one X.509 certificate or a PKCS#7
    # certificate bundle (the latter is what some .cer exports use).
    single = openssl(
        ['x509', '-inform', 'DER', '-in', path, '-outform', 'PEM'])
    if single.returncode == 0:
        text = single.stdout.decode('ascii', 'replace')
        pems = PEM_CERT_TEXT.findall(text)
        if len(pems) == 1 and len(objects) == 1:
            return pems

    bundle = openssl(
        ['pkcs7', '-inform', 'DER', '-in', path, '-print_certs'])
    if bundle.returncode == 0:
        text = bundle.stdout.decode('utf-8', 'replace')
        pems = PEM_CERT_TEXT.findall(text)
        if pems:
            return pems

    fail('无法把证书文件解析为 PEM/DER/证书链：%s' % path)


def cert_fields(pem):
    result = openssl(
        ['x509', '-noout', '-subject', '-issuer', '-text'],
        stdin=pem.encode('ascii'))
    if result.returncode != 0:
        fail('无法解析证书内容：%s' % short(result.stderr))
    text = result.stdout.decode('utf-8', 'replace')
    subject = ''
    issuer = ''
    for line in text.splitlines():
        if line.startswith('subject='):
            subject = line[len('subject='):].strip()
        elif line.startswith('issuer='):
            issuer = line[len('issuer='):].strip()
    is_ca = bool(re.search(r'CA:TRUE', text))
    is_end_entity = bool(re.search(r'CA:FALSE', text))
    return subject, issuer, is_ca, is_end_entity


def choose_chain_certificate(chain, expected_der=None):
    """Return (fingerprint, der) for the one unambiguous signing cert."""
    entries = []
    for index, pem in enumerate(chain):
        digest, der = sha256_pem(pem, '证书链第 %d 张' % (index + 1))
        subject, issuer, is_ca, is_end_entity = cert_fields(pem)
        entries.append({
            'index': index,
            'pem': pem,
            'sha256': digest,
            'der': der,
            'subject': subject,
            'issuer': issuer,
            'is_ca': is_ca,
            'is_end_entity': is_end_entity,
        })

    if expected_der is not None:
        matches = [e for e in entries if e['der'] == expected_der]
        if len(matches) != 1:
            fail('证书链中找不到 profile 指定的开发证书'
                 '（或找到多张相同证书），拒绝猜测')
        return matches[0]['sha256'], matches[0]['der'], matches[0]['pem']

    if len(entries) == 1:
        return entries[0]['sha256'], entries[0]['der'], entries[0]['pem']

    # Prefer an explicit end-entity certificate.  A chain normally has
    # exactly one CA:FALSE leaf; roots/intermediates are CA:TRUE.
    candidates = [e for e in entries if e['is_end_entity']]
    if not candidates:
        candidates = [e for e in entries if not e['is_ca']]
    if len(candidates) == 1:
        return candidates[0]['sha256'], candidates[0]['der'], candidates[0]['pem']
    if not candidates:
        fail('证书链中没有可识别的终端证书（CA:FALSE）；'
             '请用 --profile 或 --fingerprint 明确指定')

    # Sometimes an intermediate also lacks Basic Constraints.  Keep only
    # certs that are not the issuer of another cert in the chain, then
    # require exactly one.
    subjects = {e['subject'] for e in entries}
    leaves = [
        e for e in candidates
        if e['issuer'] in subjects and
        not any(other['issuer'] == e['subject'] for other in entries
                if other['index'] != e['index'])
    ]
    if len(leaves) == 1:
        return leaves[0]['sha256'], leaves[0]['der'], leaves[0]['pem']

    fail('证书链中有 %d 张候选终端证书，无法确定哪张签了 GT 4 应用；'
         '请用 --profile 或 --fingerprint 明确指定，不能静默取第一张'
         % len(candidates))


def public_key_spki_der(pem):
    result = openssl(['x509', '-pubkey', '-noout'],
                     stdin=pem.encode('ascii'))
    if result.returncode != 0:
        fail('无法从证书提取公钥：%s' % short(result.stderr))
    der = openssl(['pkey', '-pubin', '-outform', 'DER'],
                  stdin=result.stdout)
    if der.returncode != 0:
        fail('无法把证书公钥转为 SPKI DER：%s' % short(der.stderr))
    return der.stdout


def lite_from_pem(pem, bundle):
    try:
        point = extract_ec_point_from_spki_der(public_key_spki_der(pem))
        return format_watch_lite(point, bundle)
    except IdentityFormatError as exc:
        fail('无法生成 GT 4 Lite 公钥指纹：%s' % exc)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--profile', default='',
                        help='手表应用 .p7b profile（含 development-certificate）')
    parser.add_argument('--cert', default='',
                        help='PEM/DER 证书或证书链')
    parser.add_argument('--bundle', default=WATCH_BUNDLE,
                        help='期望的手表 bundleName（默认 %s）' % WATCH_BUNDLE)
    parser.add_argument('--format', default='lite',
                        choices=['lite', 'sha256'],
                        help='lite=官方 Lite 公钥指纹（默认）；'
                             'sha256=仅诊断用的证书摘要')
    parser.add_argument('--fingerprint', action='append', default=[],
                        help='已确证的完整身份值，可重复；必须与材料一致')
    args = parser.parse_args()

    explicit = []
    for value in args.fingerprint:
        if args.format == 'lite':
            try:
                explicit.append(validate_watch_lite(value, args.bundle))
            except IdentityFormatError as exc:
                fail('--fingerprint 不是合法的 GT 4 Lite 身份：%s' % exc)
        else:
            explicit.append(normalize_fingerprint(value, '--fingerprint'))
    if len(set(explicit)) > 1:
        fail('给出的多个身份值不一致，拒绝猜测')

    profile_digest = None
    profile_der = None
    profile_pem = None
    if args.profile:
        profile_digest, profile_der, profile_pem = read_profile(
            args.profile, args.bundle)

    material_digest = profile_digest
    material_pem = profile_pem
    if args.cert:
        chain = load_cert_chain(args.cert)
        cert_digest, _, cert_pem = choose_chain_certificate(
            chain, expected_der=profile_der)
        if material_digest and cert_digest != material_digest:
            fail('证书链终端证书与 profile 的开发证书不是同一张：'
                 'profile=%s cert=%s'
                 % (material_digest[:8] + '…',
                    cert_digest[:8] + '…'))
        material_digest = cert_digest
        material_pem = cert_pem

    actual = None
    if material_pem:
        actual = (lite_from_pem(material_pem, args.bundle)
                  if args.format == 'lite' else material_digest)
    if explicit and actual:
        if explicit[0] != actual:
            fail('显式身份值与签名材料不一致：explicit=%s material=%s'
                 % (explicit[0][:20] + '…', actual[:20] + '…'))
    elif explicit:
        actual = explicit[0]
    elif not actual:
        fail('没有可用的手表签名材料或身份值；请提供 '
             '--profile/--cert，或已确证的 --fingerprint')

    source = []
    if args.profile:
        source.append('profile')
    if args.cert:
        source.append('cert')
    if explicit:
        source.append('explicit')
    if not source:
        source.append('material')
    print(actual)
    print('WATCH_FINGERPRINT_SOURCE=%s bundle=%s format=%s prefix=%s…'
          % ('+'.join(source), args.bundle, args.format, actual[:20]),
          file=sys.stderr)


if __name__ == '__main__':
    main()
