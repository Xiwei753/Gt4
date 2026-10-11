#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""构建期注入手机应用级 Client ID（issue #6 P0-A）。

真实 Client ID 是 `com.xiwei.suyue` 的**唯一应用身份**，随 HAP 分发，
不进入 git 历史。因此仓库里 `apps/phone/entry/src/main/module.json5`
的 `module.metadata` 只保留占位符 `CONFIGURE_WITH_AGC_CLIENT_ID`。

本脚本由 `tools/build_phone_hap.sh` 在打包前调用，把占位符替换为真实值
（来自被 gitignore 的 `signing/phone/client_id.env` 或 `SUYUE_CLIENT_ID`），
构建/清单校验结束后由调用方还原源文件。

安全约束：

* 当前值**必须**是预期占位符，否则拒绝猜测格式（避免把真实值误当占位符
  再注入一次，也避免把别的字段改坏）。
* 注入值不得为空、不得含空白/引号/反斜杠，以免破坏 JSON 字面量。
* 输出只打印状态，**不打印真实值**（脚本可能在共享终端/CI 日志里跑）。
"""
import argparse
import re
import sys

DEFAULT_PLACEHOLDER = 'CONFIGURE_WITH_AGC_CLIENT_ID'
# 与 tests/source-contract.test.mjs 中的匹配保持一致。
ENTRY = re.compile(
    r'("name"\s*:\s*"client_id"\s*,\s*"value"\s*:\s*")([^"]*)(")')
BAD_VALUE = re.compile(r'[\s"\\]')


def fail(msg):
    print('ERROR: ' + msg, file=sys.stderr)
    sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--manifest', required=True,
                    help='apps/phone 下的 module.json5')
    ap.add_argument('--client-id', required=True,
                    help='真实应用级 Client ID（来自本地材料）')
    ap.add_argument('--placeholder', default=DEFAULT_PLACEHOLDER,
                    help='仓库中保留的占位符')
    args = ap.parse_args()

    value = args.client_id.strip()
    if not value:
        fail('提供的 Client ID 为空')
    if value == args.placeholder:
        fail('提供的 Client ID 仍是占位符，未取得真实值')
    if BAD_VALUE.search(value):
        fail('Client ID 含空白/引号/反斜杠，不接受')

    with open(args.manifest, encoding='utf-8') as handle:
        text = handle.read()

    match = ENTRY.search(text)
    if not match:
        fail('module.json5 缺少 client_id 元数据条目')
    current = match.group(2)
    if current != args.placeholder:
        fail('client_id 当前值不是预期占位符，拒绝猜测格式：' + current)

    text = text[:match.start(2)] + value + text[match.end(2):]
    with open(args.manifest, 'w', encoding='utf-8') as handle:
        handle.write(text)

    print('client_id 已注入（值已隐藏；来源为本地材料/环境变量）')


if __name__ == '__main__':
    main()
