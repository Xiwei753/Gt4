#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Stage signing material and inject Wear Engine peer identities.

Issue #13: the two directions have different, non-interchangeable formats.

* phone -> watch: ``con.xiwei.suyue.gt4_<Base64(raw EC point)>``
  (Lite Wearable fingerprint, see :mod:`peer_identity_formats`);
* watch -> phone: the phone's 19-digit HarmonyOS APP ID from the profile
  (``bundle-info.app-identifier``), not the OAuth client_id and not a
  certificate SHA-256.

Modes:

* ``--material-json`` stages the CI secret material (and optionally injects
  one identity/manifest value).  It never prints secret contents.
* ``--fingerprint-value`` only validates and injects an already-derived
  identity.  It never writes signing material.

The old ``raw`` mode (arbitrary non-empty string) is intentionally gone:
an unconfigured or mistyped identity must fail closed.
"""
import argparse
import base64
import json
import os
import re
import shlex
import sys

from peer_identity_formats import (
    PHONE_BUNDLE,
    WATCH_BUNDLE,
    IdentityFormatError,
    validate_phone_app_id,
    validate_watch_lite,
)

HEX64 = re.compile(r'^[0-9a-f]{64}$')
PLACEHOLDER = ':CONFIGURE_WITH_PHONE_APP_ID'


def fail(msg):
    print('ERROR: ' + msg, file=sys.stderr)
    sys.exit(1)


def validate_identity(value, fmt, key, watch_bundle):
    if not fmt:
        fmt = 'lite' if key == 'watch' else 'appid'
    text = str(value or '').strip()
    if not text:
        fail('待注入身份为空；拒绝把空值当成“已配置”')
    try:
        if fmt == 'lite':
            if key != 'watch':
                fail('Lite 公钥指纹只用于 WATCH_PEER（手机 -> 手表），'
                     '不能用于 PHONE_APP_ID')
            return validate_watch_lite(text, watch_bundle)
        if fmt == 'appid':
            if key != 'phone':
                fail('手机 APP ID 只用于 PHONE_APP_ID（手表 -> 手机），'
                     '不能用于 WATCH_PEER')
            return validate_phone_app_id(text)
        if fmt == 'hex64':
            # Legacy only.  Issue #13 flows must not use this for either
            # direction, but keeping it lets unrelated callers/tests fail
            # with an explicit format instead of the removed "raw" mode.
            if not HEX64.match(text.lower()):
                fail('%s 不是 64 位十六进制（legacy hex64）' % key)
            return text.lower()
    except IdentityFormatError as exc:
        fail(str(exc))
    fail('未知身份格式: %s' % fmt)


def inject_manifest(path, peer_bundle, app_id):
    with open(path, 'r', encoding='utf-8') as handle:
        manifest = json.load(handle)
    module = manifest.get('module') or {}
    meta = module.get('metaData') or {}
    entries = meta.get('customizeData') or []
    target = None
    for entry in entries:
        if entry.get('name') == 'supportLists':
            target = entry
            break
    if target is None:
        fail('config.json 缺少 metaData.customizeData supportLists 条目')
    try:
        app_id = validate_phone_app_id(app_id)
    except IdentityFormatError as exc:
        fail('supportLists 只能写入手机 APP ID：' + str(exc))
    value = str(target.get('value') or '')
    expected = peer_bundle + ':' + app_id
    if value == expected:
        return
    placeholder = peer_bundle + PLACEHOLDER
    if value != placeholder:
        fail('supportLists 当前值不是预期占位符 %r，拒绝猜测格式：%r'
             % (placeholder, value))
    target['value'] = expected
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write('\n')


def inject_identity(path, identity_var, value, allow_replace=False):
    with open(path, 'r', encoding='utf-8') as handle:
        identity_text = handle.read()
    pattern = "export const %s = '';" % identity_var
    if pattern not in identity_text:
        if not allow_replace:
            fail('身份文件中未找到 %s 的空占位' % identity_var)
        current = re.compile(
            r"export const %s = '([^']*)';" % re.escape(identity_var))
        match = current.search(identity_text)
        if match is None:
            fail('身份文件中未找到 %s 声明' % identity_var)
        pattern = match.group(0)
    identity_text = identity_text.replace(
        pattern,
        'export const %s = \'%s\';' % (identity_var, value), 1)
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write(identity_text)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--material-json', default='',
                    help='SIGNING_MATERIAL 环境变量（JSON）')
    ap.add_argument('--fingerprint-value', default='',
                    help='已由 profile/cert 推导出的对端身份值')
    ap.add_argument('--signing-dir', default='',
                    help='材料落盘目录（仅材料模式需要）')
    ap.add_argument('--build-profile', default='',
                    help='要写入 signingConfigs 的 build-profile.json5')
    ap.add_argument('--external-signing', action='store_true',
                    help='Lite HAP 走独立 sign-app，只输出本地签名凭据')
    ap.add_argument('--identity-file', default='',
                    help='身份配置文件（注入对端身份）')
    ap.add_argument('--identity-var', default='',
                    help='身份文件中的身份常量名')
    ap.add_argument('--fingerprint-key', default='',
                    choices=['', 'phone', 'watch'],
                    help='phone=手机 APP ID；watch=GT4 Lite 公钥指纹')
    ap.add_argument('--fingerprint-format', default='',
                    choices=['', 'lite', 'appid', 'hex64'],
                    help='默认按 key 推导：phone=appid, watch=lite')
    ap.add_argument('--watch-bundle', default=WATCH_BUNDLE,
                    help='WATCH_PEER 的 Lite bundleName（默认 %s）'
                         % WATCH_BUNDLE)
    ap.add_argument('--allow-replace', action='store_true',
                    help='允许覆盖已经注入的同名身份（构建脚本核对后使用）')
    ap.add_argument('--manifest', default='',
                    help='手表 config.json（注入 supportLists）')
    ap.add_argument('--manifest-peer-bundle', default='',
                    help='supportLists 中的对端（手机）包名')
    args = ap.parse_args()

    if args.material_json and args.fingerprint_value:
        fail('--material-json 与 --fingerprint-value 不能同时使用')
    if not args.material_json and not args.fingerprint_value:
        fail('必须提供 --material-json 或 --fingerprint-value')

    wants_identity = bool(
        args.identity_file or args.identity_var or args.fingerprint_key)
    if wants_identity:
        if not (args.identity_file and args.identity_var
                and args.fingerprint_key):
            fail('注入身份必须同时提供 --identity-file、--identity-var、'
                 '--fingerprint-key')
    if args.manifest and not wants_identity:
        fail('--manifest 需要同时注入手机 APP ID')
    if args.manifest and not args.manifest_peer_bundle:
        fail('--manifest 需要同时提供 --manifest-peer-bundle')
    if args.manifest_peer_bundle and args.manifest_peer_bundle != PHONE_BUNDLE:
        fail('supportLists 对端包名必须是 %s，实际 %r'
             % (PHONE_BUNDLE, args.manifest_peer_bundle))

    if args.fingerprint_value:
        if not wants_identity:
            fail('--fingerprint-value 必须配合身份注入参数使用')
        value = validate_identity(args.fingerprint_value,
                                  args.fingerprint_format,
                                  args.fingerprint_key,
                                  args.watch_bundle)
        inject_identity(args.identity_file, args.identity_var, value,
                        args.allow_replace)
        if args.manifest:
            inject_manifest(args.manifest, args.manifest_peer_bundle, value)
        print('identity %s injected (format=%s)%s'
              % (args.fingerprint_key,
                 args.fingerprint_format or
                 ('lite' if args.fingerprint_key == 'watch' else 'appid'),
                 '; supportLists updated' if args.manifest else ''))
        return

    if not args.signing_dir:
        fail('材料模式必须提供 --signing-dir')
    try:
        material = json.loads(args.material_json)
    except ValueError as exc:
        fail('SIGNING_MATERIAL 不是合法 JSON: %s' % exc)

    for field in ('storeFileB64', 'certpathB64', 'profileB64',
                  'keyAlias', 'keyPassword', 'storePassword'):
        if not material.get(field):
            fail('签名材料缺少字段: %s' % field)

    os.makedirs(args.signing_dir, exist_ok=True)
    files = {
        'storeFileB64': 'key.p12',
        'certpathB64': 'cert.cer',
        'profileB64': 'profile.p7b',
    }
    paths = {}
    for field, name in files.items():
        try:
            raw = base64.b64decode(material[field], validate=True)
        except Exception:
            fail('字段 %s 不是合法 base64' % field)
        if not raw:
            fail('字段 %s 解码后为空' % field)
        target = os.path.join(args.signing_dir, name)
        with open(target, 'wb') as handle:
            handle.write(raw)
        paths[field] = target

    if args.external_signing:
        env_path = os.path.join(args.signing_dir, 'credentials.env')
        with open(env_path, 'w', encoding='utf-8') as handle:
            for key, value in (
                ('KEY_ALIAS', material['keyAlias']),
                ('KEY_PASSWORD', material['keyPassword']),
                ('STORE_PASSWORD', material['storePassword']),
            ):
                handle.write(key + '=' + shlex.quote(str(value)) + '\n')
        os.chmod(env_path, 0o600)
    else:
        if not args.build_profile:
            fail('非 external-signing 模式必须指定 --build-profile')
        sign_alg = material.get('signAlg', 'SHA256withECDSA')
        block = {
            'name': 'default',
            'type': 'HarmonyOS',
            'material': {
                'storeFile': paths['storeFileB64'],
                'certpath': paths['certpathB64'],
                'profile': paths['profileB64'],
                'signAlg': sign_alg,
                'storePassword': material['storePassword'],
                'keyAlias': material['keyAlias'],
                'keyPassword': material['keyPassword'],
            }
        }
        with open(args.build_profile, 'r', encoding='utf-8') as handle:
            profile_text = handle.read()
        if '"signingConfigs": []' not in profile_text:
            fail('build-profile.json5 中未找到 "signingConfigs": []')
        profile_text = profile_text.replace(
            '"signingConfigs": []',
            '"signingConfigs": ' + json.dumps([block]))
        with open(args.build_profile, 'w', encoding='utf-8') as handle:
            handle.write(profile_text)

    if wants_identity:
        fingerprints = material.get('fingerprints') or {}
        value = validate_identity(
            fingerprints.get(args.fingerprint_key),
            args.fingerprint_format,
            args.fingerprint_key,
            args.watch_bundle)
        inject_identity(args.identity_file, args.identity_var, value,
                        args.allow_replace)
        if args.manifest:
            inject_manifest(args.manifest, args.manifest_peer_bundle, value)
    else:
        value = None

    print('signing material staged at %s (content hidden)%s'
          % (args.signing_dir,
             ('; identity %s injected' % args.fingerprint_key)
             if value else '; identity injection skipped'))


if __name__ == '__main__':
    main()
