#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""CI 签名与身份注入（施工单 P1-7 / 第二轮 P0-1）。

把 Secrets 中的签名材料（JSON：base64 编码的
storeFile/certpath/profile + 别名/口令 + 双端
证书指纹）落盘到构建目录，并把：

  1. 真实 signingConfigs 写入 build-profile.json5；
  2. 对端证书指纹写入身份配置文件
     （手表 PhonePeerConfig.g.js / 手机
     PeerIdentityConfig.g.ts）；
  3. 手表 Manifest（config.json）中
     metaData.customizeData 的 supportLists
     占位符替换为真实手机指纹。

指纹格式（第二轮 P1-9 / issue #14）：默认只做
结构性校验（非空、不含空白/引号/冒号等破坏
分隔符的字符）。确认为 64 位 hex 时可用
--fingerprint-format hex64；手机→GT 4 的
WATCH_PEER 必须用 --fingerprint-format watch-lite，
即 <bundle>_<Base64(未压缩 EC 公钥点)>，旧 hex64
会在注入阶段直接失败。

绝不提交材料：所有写入都在工作区，
workflow 的清理步骤（if: always()）负责
git checkout 还原并删除目录。
"""
import argparse
import base64
import json
import os
import re
import shlex
import sys

HEX64 = re.compile(r'^[0-9a-f]{64}$')
LITE_B64 = re.compile(r'^[A-Za-z0-9+/]+={0,2}$')
EC_POINT_LENGTHS = (65, 97, 133)
# 指纹字符串不得包含会破坏 manifest 值
# （bundle:fingerprint）或 JS 字面量的字符。
FORBIDDEN = re.compile(r'[\s:;,\'"\\]')


def fail(msg):
    print('ERROR: ' + msg, file=sys.stderr)
    sys.exit(1)


def validate_watch_lite(text, bundle, where):
    prefix = bundle + '_'
    if not text.startswith(prefix):
        fail('%s 必须是 <%s>_<Base64(未压缩 EC 公钥点)>；'
             '64 位证书 SHA-256 不能作为 Lite 对端指纹' % (where, bundle))
    payload = text[len(prefix):]
    if not payload or len(payload) % 4 != 0 \
            or not LITE_B64.match(payload):
        fail('%s 的 Base64 部分不是标准 Base64（保留大小写与 +/=）'
             % where)
    try:
        point = base64.b64decode(payload, validate=True)
    except ValueError:
        fail('%s 的 Base64 部分不是合法 Base64' % where)
    if base64.b64encode(point).decode('ascii') != payload:
        fail('%s 的 Base64 不是规范编码（大小写/填充不一致）' % where)
    if len(point) not in EC_POINT_LENGTHS:
        fail('%s 公钥必须是未压缩 EC 点（65/97/133 字节），实际 %d'
             % (where, len(point)))
    if point[0] != 0x04:
        fail('%s 公钥首字节必须是 0x04（未压缩点），实际 0x%02x'
             % (where, point[0]))
    return text


def validate_fingerprint(value, fmt, where, watch_lite_bundle):
    text = str(value or '').strip()
    if not text:
        fail('%s 指纹为空' % where)
    if FORBIDDEN.search(text):
        fail('%s 指纹包含空白或分隔符，'
             '不接受（格式以 SDK 实测为准）' % where)
    if fmt == 'hex64' and not HEX64.match(text.lower()):
        fail('%s 指纹不是 64 位十六进制'
             '（--fingerprint-format hex64）' % where)
    if fmt == 'watch-lite':
        validate_watch_lite(text, watch_lite_bundle, where)
    if fmt == 'raw' and len(text) > 256:
        fail('%s 指纹长度异常（>256）' % where)
    return text


def inject_manifest(path, peer_bundle, fingerprint):
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
        fail('config.json 缺少 metaData.customizeData '
             'supportLists 条目')
    value = str(target.get('value') or '')
    placeholder = (peer_bundle +
                   ':CONFIGURE_WITH_SIGNED_PHONE_FINGERPRINT')
    if value != placeholder:
        fail('supportLists 当前值不是预期占位符，拒绝猜测格式：'
             + value)
    target['value'] = peer_bundle + ':' + fingerprint
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write('\n')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--material-json', required=True,
                    help='SIGNING_MATERIAL 环境变量（JSON）')
    ap.add_argument('--signing-dir', required=True,
                    help='材料落盘目录（跨 step 持久）')
    ap.add_argument('--build-profile', default='',
                    help='要写入 signingConfigs 的 build-profile.json5')
    ap.add_argument('--external-signing', action='store_true',
                    help='Lite HAP 走独立 sign-app，不注入 legacy signingConfigs；输出本地签名凭据')
    ap.add_argument('--identity-file', required=True,
                    help='身份配置文件（注入对端指纹）')
    ap.add_argument('--identity-var', required=True,
                    help='身份文件中的指纹常量名')
    ap.add_argument('--fingerprint-key', required=True,
                    choices=['phone', 'watch'],
                    help='注入哪一个对端指纹')
    ap.add_argument('--fingerprint-format', default='raw',
                    choices=['raw', 'hex64', 'watch-lite'],
                    help='指纹格式校验（默认 raw 宽松；'
                         '64 位 hex 用 hex64；手机→GT 4 的'
                         'WATCH_PEER 用 watch-lite）')
    ap.add_argument('--watch-lite-bundle',
                    default='con.xiwei.suyue.gt4',
                    help='watch-lite 格式的手表包名')
    ap.add_argument('--manifest', default='',
                    help='手表 config.json（注入 supportLists）')
    ap.add_argument('--manifest-peer-bundle', default='',
                    help='supportLists 中的对端（手机）包名')
    args = ap.parse_args()

    try:
        material = json.loads(args.material_json)
    except ValueError as exc:
        fail('SIGNING_MATERIAL 不是合法 JSON: %s' % exc)

    for field in ('storeFileB64', 'certpathB64',
                  'profileB64', 'keyAlias',
                  'keyPassword', 'storePassword'):
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
            raw = base64.b64decode(material[field],
                                   validate=True)
        except Exception:
            fail('字段 %s 不是合法 base64' % field)
        if not raw:
            fail('字段 %s 解码后为空' % field)
        target = os.path.join(args.signing_dir, name)
        with open(target, 'wb') as handle:
            handle.write(raw)
        paths[field] = target

    # legacy Lite 的 SignHap 会查找不存在的 material 目录。
    # 外部签名模式只落盘凭据，让 build_watch_lite.sh 走
    # unsigned -> sign-app -> verify-app；手机 Stage 路径保持不变。
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
        # 真实 signingConfigs：替换空数组。
        sign_alg = material.get('signAlg',
                                'SHA256withECDSA')
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
        with open(args.build_profile, 'r',
                  encoding='utf-8') as handle:
            profile_text = handle.read()
        if '"signingConfigs": []' not in profile_text:
            fail('build-profile.json5 中未找到 '
                 '"signingConfigs": []')
        profile_text = profile_text.replace(
            '"signingConfigs": []',
            '"signingConfigs": ' + json.dumps([block]))
        with open(args.build_profile, 'w',
                  encoding='utf-8') as handle:
            handle.write(profile_text)

    # 对端证书指纹注入身份配置。
    fingerprints = material.get('fingerprints') or {}
    fingerprint = validate_fingerprint(
        fingerprints.get(args.fingerprint_key),
        args.fingerprint_format,
        'fingerprints.%s' % args.fingerprint_key,
        args.watch_lite_bundle)
    with open(args.identity_file, 'r',
              encoding='utf-8') as handle:
        identity_text = handle.read()
    pattern = ("export const %s = '';" %
               args.identity_var)
    if pattern not in identity_text:
        fail('身份文件中未找到 %s 的空占位' %
             args.identity_var)
    identity_text = identity_text.replace(
        pattern,
        'export const %s = \'%s\';' % (
            args.identity_var, fingerprint))
    with open(args.identity_file, 'w',
              encoding='utf-8') as handle:
        handle.write(identity_text)

    # 手表 Manifest：supportLists 必须与真实
    # 手机证书指纹一致，否则手表不会授权
    # 接收（第二轮 P0-1）。
    if args.manifest:
        if not args.manifest_peer_bundle:
            fail('--manifest 需要同时提供 '
                 '--manifest-peer-bundle')
        inject_manifest(args.manifest,
                        args.manifest_peer_bundle,
                        fingerprint)

    print('signing material staged at %s '
          '(content hidden); fingerprint %s injected '
          '(format=%s)%s'
          % (args.signing_dir,
             args.fingerprint_key,
             args.fingerprint_format,
             '; supportLists updated'
             if args.manifest else ''))


if __name__ == '__main__':
    main()
