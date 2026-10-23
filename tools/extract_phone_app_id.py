#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Read the phone's HarmonyOS APP ID from its signing profile.

For a HarmonyOS 5.0+ native app, Wear Engine identifies the app by its APP ID,
which is stored as ``bundle-info.app-identifier`` in the signed profile.  In
this project it happens to equal the locally stored AGC client_id, but the
code reads the profile field explicitly and never treats the OAuth client_id
or a certificate SHA-256 as a substitute.

Only the APP ID is written to stdout; diagnostics go to stderr.
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile

from peer_identity_formats import (
    PHONE_BUNDLE,
    IdentityFormatError,
    validate_phone_app_id,
)


def fail(message):
    print('ERROR: ' + message, file=sys.stderr)
    raise SystemExit(1)


def short(data, limit=300):
    text = data.decode('utf-8', 'replace').strip()
    return text[:limit] + ('…' if len(text) > limit else '')


def openssl(args, stdin=None):
    try:
        return subprocess.run(
            ['openssl'] + args,
            input=stdin,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE)
    except FileNotFoundError:
        fail('找不到 openssl；无法解析 profile。')


def profile_json(path):
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
        return json.loads(verify.stdout.decode('utf-8'))
    except (UnicodeDecodeError, ValueError) as exc:
        fail('profile 内容不是 JSON（%s）：%s' % (path, exc))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--profile', default='',
                        help='手机应用 .p7b profile')
    parser.add_argument('--material-json', default='',
                        help='含 profileB64 的 PHONE_SIGNING_MATERIAL JSON')
    parser.add_argument('--bundle', default=PHONE_BUNDLE,
                        help='期望的手机 bundleName（默认 %s）' % PHONE_BUNDLE)
    parser.add_argument('--app-id', default='',
                        help='已确证的 APP ID；提供时必须与 profile 一致')
    args = parser.parse_args()

    if bool(args.profile) == bool(args.material_json):
        fail('必须且只能提供 --profile 或 --material-json 之一')

    temp_path = None
    profile_path = args.profile
    source = 'profile'
    if args.material_json:
        try:
            material = json.loads(args.material_json)
            raw = base64.b64decode(material['profileB64'], validate=True)
        except Exception:
            fail('--material-json 不合法或缺少 profileB64')
        if not raw:
            fail('profileB64 解码后为空')
        handle = tempfile.NamedTemporaryFile(
            prefix='suyue-phone-profile-', suffix='.p7b', delete=False)
        handle.write(raw)
        handle.close()
        temp_path = handle.name
        profile_path = temp_path
        source = 'material'

    try:
        profile = profile_json(profile_path)
        info = profile.get('bundle-info') or {}
        actual_bundle = info.get('bundle-name')
        if actual_bundle != args.bundle:
            fail('profile 的 bundle-name 是 %r，期望 %r；'
                 '不能拿手表或其他应用的 profile 冒充手机 APP ID'
                 % (actual_bundle, args.bundle))
        try:
            app_id = validate_phone_app_id(info.get('app-identifier'))
        except IdentityFormatError as exc:
            fail(str(exc))
        if args.app_id:
            try:
                expected = validate_phone_app_id(args.app_id)
            except IdentityFormatError as exc:
                fail('--app-id 不合法：' + str(exc))
            if expected != app_id:
                fail('显式 APP ID 与 profile 的 bundle-info.app-identifier '
                     '不一致')
        print(app_id)
        print('PHONE_APP_ID_SOURCE=%s bundle=%s prefix=%s…'
              % (source, args.bundle, app_id[:4]), file=sys.stderr)
    finally:
        if temp_path and os.path.exists(temp_path):
            os.unlink(temp_path)


if __name__ == '__main__':
    main()
