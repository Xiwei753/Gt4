#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Wear Engine peer-identity formats used by the phone and GT 4 Lite apps.

The two directions are deliberately different and must never be normalized
into the same string:

* phone -> watch (``AppInfo.fingerprint`` / ``setFingerprint``):
  ``<watch bundleName>_<standard Base64 of the raw EC public point>``.
  The point is the uncompressed SEC1 point (first byte 0x04), not a
  certificate digest, not the Base64 of the hex text, and not the
  SubjectPublicKeyInfo/DER Base64.
* watch -> phone (``supportLists`` / ``setFingerprint``):
  the phone's HarmonyOS APP ID, which is the 19-digit
  ``bundle-info.app-identifier`` in the phone profile.  It is not the OAuth
  client_id, not the project Client ID, and not a certificate SHA-256.
"""
import base64
import binascii
import re

WATCH_BUNDLE = 'con.xiwei.suyue.gt4'
PHONE_BUNDLE = 'com.xiwei.suyue'
EC_POINT_LENGTHS = (65, 97, 133)  # P-256, P-384, P-521 uncompressed points
_b64_re = re.compile(r'^[A-Za-z0-9+/]+={0,2}$')
_app_id_re = re.compile(r'^[0-9]{10,32}$')
_hex64_re = re.compile(r'^[0-9a-fA-F]{64}$')


class IdentityFormatError(ValueError):
    pass


def canonical_base64(raw):
    """Standard Base64 with canonical padding."""
    return base64.b64encode(bytes(raw)).decode('ascii')


def strict_base64decode(text, where):
    text = str(text or '')
    if not text or len(text) % 4 != 0 or not _b64_re.match(text):
        raise IdentityFormatError(
            '%s 不是标准 Base64（不允许 URL-safe、空白或换行）' % where)
    try:
        raw = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        raise IdentityFormatError('%s 不是合法 Base64' % where)
    if canonical_base64(raw) != text:
        raise IdentityFormatError(
            '%s 不是规范的 Base64（大小写/填充/尾随字符不一致）' % where)
    return raw


def validate_phone_app_id(value):
    text = str(value or '').strip()
    if not _app_id_re.match(text):
        raise IdentityFormatError(
            '手机 APP ID 必须是 10–32 位数字（profile 的 '
            'bundle-info.app-identifier）；不能使用 OAuth Client ID、'
            '证书 SHA-256 或包名：%r' % value)
    return text


def validate_watch_lite(value, bundle=WATCH_BUNDLE):
    text = str(value or '').strip()
    prefix = bundle + '_'
    if _hex64_re.match(text):
        raise IdentityFormatError(
            '手表 Lite 指纹不能使用 64 位证书 SHA-256；需要 '
            '<bundleName>_<Base64(raw EC point)>（公钥点首字节 0x04）')
    if _app_id_re.match(text):
        raise IdentityFormatError(
            '手表 Lite 指纹不能使用手机 APP ID；APP ID 只用于 '
            'PHONE_APP_ID/supportLists 方向')
    if not text.startswith(prefix):
        raise IdentityFormatError(
            '手表 Lite 指纹必须为 <bundleName>_<Base64(raw EC point)>，'
            'bundle 必须是 %s：%r' % (bundle, value))
    suffix = text[len(prefix):]
    raw = strict_base64decode(suffix, '手表 Lite 指纹的 Base64 部分')
    if len(raw) not in EC_POINT_LENGTHS:
        raise IdentityFormatError(
            '手表 Lite 指纹公钥必须是未压缩 EC 点（65/97/133 字节），'
            '实际 %d 字节；不能使用整张证书 DER 或 SPKI 的 Base64'
            % len(raw))
    if raw[0] != 0x04:
        raise IdentityFormatError(
            '手表 Lite 指纹公钥首字节必须是 0x04（未压缩 EC 点），'
            '实际 0x%02x' % raw[0])
    return text


def format_watch_lite(raw_point, bundle=WATCH_BUNDLE):
    raw = bytes(raw_point)
    if len(raw) not in EC_POINT_LENGTHS:
        raise IdentityFormatError(
            'EC 公钥点长度必须是 65/97/133 字节，实际 %d' % len(raw))
    if raw[0] != 0x04:
        raise IdentityFormatError(
            'EC 公钥点必须是非压缩格式（首字节 0x04），实际 0x%02x'
            % raw[0])
    return bundle + '_' + canonical_base64(raw)


def _read_tlv(data, offset):
    if offset >= len(data):
        raise IdentityFormatError('DER 在偏移 %d 处截断' % offset)
    tag = data[offset]
    offset += 1
    if offset >= len(data):
        raise IdentityFormatError('DER 长度字段缺失')
    first = data[offset]
    offset += 1
    if first < 0x80:
        length = first
    elif first == 0x80:
        raise IdentityFormatError('不支持不定长 DER')
    else:
        count = first & 0x7F
        if count == 0 or count > 4:
            raise IdentityFormatError('DER 长度字段非法')
        if offset + count > len(data):
            raise IdentityFormatError('DER 长度字段截断')
        length = int.from_bytes(data[offset:offset + count], 'big')
        offset += count
    end = offset + length
    if end > len(data):
        raise IdentityFormatError('DER 对象长度越界')
    return tag, data[offset:end], end


def extract_ec_point_from_spki_der(spki):
    """Return the uncompressed EC point from a SubjectPublicKeyInfo DER."""
    tag, body, end = _read_tlv(spki, 0)
    if tag != 0x30 or end != len(spki):
        raise IdentityFormatError('公钥不是单个 SPKI SEQUENCE')
    tag, algorithm, pos = _read_tlv(body, 0)
    if tag != 0x30:
        raise IdentityFormatError('SPKI 缺少 AlgorithmIdentifier')
    # id-ecPublicKey: 1.2.840.10045.2.1
    if not algorithm.startswith(b'\x06\x07\x2a\x86\x48\xce\x3d\x02\x01'):
        raise IdentityFormatError('签名公钥不是 EC 公钥（id-ecPublicKey）')
    tag, bits, pos2 = _read_tlv(body, pos)
    if tag != 0x03 or pos2 != len(body):
        raise IdentityFormatError('SPKI 缺少 BIT STRING 或存在尾随数据')
    if not bits:
        raise IdentityFormatError('SPKI BIT STRING 为空')
    unused = bits[0]
    if unused != 0:
        raise IdentityFormatError('EC 公钥 BIT STRING 存在未使用位')
    point = bits[1:]
    if len(point) not in EC_POINT_LENGTHS:
        raise IdentityFormatError(
            'EC 公钥点长度必须是 65/97/133 字节，实际 %d' % len(point))
    if point[0] != 0x04:
        raise IdentityFormatError(
            'EC 公钥点必须是未压缩格式（0x04），实际 0x%02x' % point[0])
    return point
