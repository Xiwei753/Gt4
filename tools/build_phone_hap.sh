#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Local/reproducible Stage HAP build for suyue phone (Pocket 2 / API 26).
# Requires a DevEco environment that provides `hvigorw` and the
# HarmonyOS Stage SDK. Never fabricates success: missing toolchain
# or signing material fails loudly.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/apps/phone"

MODE="${1:-debug}"   # debug | release
PRODUCT="${PRODUCT:-default}"

if [ "$MODE" != "debug" ] && [ "$MODE" != "release" ]; then
  echo "usage: $0 [debug|release]" >&2
  exit 2
fi

if ! command -v hvigorw >/dev/null 2>&1 && [ ! -x "./hvigorw" ]; then
  echo "ERROR: hvigorw not found. Build with the HarmonyOS Stage" >&2
  echo "       DevEco toolchain (API 26). Node-only checks cannot" >&2
  echo "       produce a Stage HAP." >&2
  exit 1
fi

HVIGORW="$(command -v hvigorw || echo ./hvigorw)"

# 清理本次输出：不能从历史产物中
# 捡到旧 HAP（施工单 P1-8）。
OUT_DIR="entry/build/default/outputs/default"
rm -rf entry/build
mkdir -p "$OUT_DIR"

# ---------- Client ID 注入（issue #6 P0-A）----------
# 真实应用级 Client ID 是该应用的唯一身份，不入库：仓库里 module.json5
# 只保留占位符。构建前从被 gitignore 的本地材料
# （signing/phone/client_id.env）或环境变量 SUYUE_CLIENT_ID 取真实值
# 临时注入，构建/清单校验结束后（EXIT trap）自动还原源码。
MODULE_JSON5="entry/src/main/module.json5"
CLIENT_ID_PLACEHOLDER="CONFIGURE_WITH_AGC_CLIENT_ID"
INJECT_CLIENT_ID="${SUYUE_CLIENT_ID:-}"
if [ -z "$INJECT_CLIENT_ID" ]; then
  for f in \
    "${PHONE_CLIENT_ID_FILE:-$REPO_ROOT/signing/phone/client_id.env}" \
    "$REPO_ROOT/signing/client_id.env"; do
    if [ -f "$f" ]; then
      INJECT_CLIENT_ID="$(sed -n \
        's/^[[:space:]]*CLIENT_ID[[:space:]]*=[[:space:]]*//p' "$f" \
        | head -n 1 | tr -d '"'"'"' \r')"
      [ -n "$INJECT_CLIENT_ID" ] && break
    fi
  done
fi

MODULE_JSON5_BACKUP=""
restore_module_json5() {
  if [ -n "$MODULE_JSON5_BACKUP" ] && [ -f "$MODULE_JSON5_BACKUP" ]; then
    cp -f "$MODULE_JSON5_BACKUP" "$MODULE_JSON5"
    rm -f "$MODULE_JSON5_BACKUP"
  fi
}
trap restore_module_json5 EXIT

if grep -q "\"$CLIENT_ID_PLACEHOLDER\"" "$MODULE_JSON5"; then
  if [ -z "$INJECT_CLIENT_ID" ]; then
    echo "ERROR: module.json5 的 client_id 仍是占位符" >&2
    echo "       $CLIENT_ID_PLACEHOLDER，但没有找到真实值。" >&2
    echo "       请创建 signing/phone/client_id.env（内容：CLIENT_ID=<应用级ClientID>）" >&2
    echo "       或设置环境变量 SUYUE_CLIENT_ID；该文件已被 .gitignore 忽略。" >&2
    exit 1
  fi
  MODULE_JSON5_BACKUP="$(mktemp)"
  cp -f "$MODULE_JSON5" "$MODULE_JSON5_BACKUP"
  python3 "$REPO_ROOT/tools/inject_client_id.py" \
    --manifest "$MODULE_JSON5" \
    --client-id "$INJECT_CLIENT_ID" \
    --placeholder "$CLIENT_ID_PLACEHOLDER"
fi

"$HVIGORW" --mode module -p product="$PRODUCT" -p buildMode="$MODE" assembleHap --no-daemon

# Stage 的产物命名随是否签名而变：
#   - signingConfigs 为空（本地默认）→ entry-default-unsigned.hap
#   - hvigor 签名成功              → entry-default-<mode>-signed.hap
# 只认 buildMode 那一种会漏掉未签名产物（本机实测），所以三种都收。
HAP="$(find "$OUT_DIR" -name "entry-default-$MODE-*.hap" -type f 2>/dev/null | head -n 1)"
if [ -z "$HAP" ]; then
  HAP="$(find "$OUT_DIR" -name 'entry-default-unsigned.hap' -type f 2>/dev/null | head -n 1)"
fi
if [ -z "$HAP" ]; then
  echo "ERROR: hvigor reported success but no $MODE HAP was produced under" >&2
  echo "       $OUT_DIR/" >&2
  exit 1
fi

# ---------- 外部签名 ----------
# 与手表侧同一套规则与同一份实现（tools/sign_hap.sh）：Stage 工程的
# signingConfigs 在本仓库同样为空，签名材料按用途放在 signing/ 下。
# 材料来源优先级：PHONE_SIGN_* 环境变量（CI）→ signing/phone|shared。
SIGNING_DIR="${PHONE_SIGNING_DIR:-$REPO_ROOT/signing}"
SIGN_P12="${PHONE_SIGN_P12:-}"
SIGN_CER="${PHONE_SIGN_CER:-}"
SIGN_PROFILE="${PHONE_SIGN_PROFILE:-}"
SIGN_ALIAS="${PHONE_SIGN_KEY_ALIAS:-}"
SIGN_KEY_PWD="${PHONE_SIGN_KEY_PASSWORD:-}"
SIGN_STORE_PWD="${PHONE_SIGN_STORE_PASSWORD:-}"

first_in() { find "$1" -maxdepth 1 -name "$2" -type f 2>/dev/null | head -n 1; }

if [ -d "$SIGNING_DIR" ]; then
  for f in "$SIGNING_DIR/shared/credentials.env" "$SIGNING_DIR/credentials.env"; do
    if [ -f "$f" ]; then
      set -a; . "$f"; set +a
      break
    fi
  done
  SIGN_ALIAS="${PHONE_SIGN_KEY_ALIAS:-${KEY_ALIAS:-$SIGN_ALIAS}}"
  SIGN_KEY_PWD="${PHONE_SIGN_KEY_PASSWORD:-${KEY_PASSWORD:-$SIGN_KEY_PWD}}"
  SIGN_STORE_PWD="${PHONE_SIGN_STORE_PASSWORD:-${STORE_PASSWORD:-$SIGN_STORE_PWD}}"

  if [ -z "$SIGN_P12" ]; then
    for d in "$SIGNING_DIR/shared" "$SIGNING_DIR"; do
      c="$(first_in "$d" '*.p12')"; [ -n "$c" ] && { SIGN_P12="$c"; break; }
    done
  fi
  if [ -z "$SIGN_CER" ]; then
    for d in "$SIGNING_DIR/shared" "$SIGNING_DIR/phone" "$SIGNING_DIR"; do
      c="$(first_in "$d" '*.cer')"; [ -n "$c" ] && { SIGN_CER="$c"; break; }
    done
  fi
  # profile 是按应用的：手机只认 phone/，绝不回退到 watch/
  if [ -z "$SIGN_PROFILE" ]; then
    for d in "$SIGNING_DIR/phone" "$SIGNING_DIR"; do
      c="$(first_in "$d" '*.p7b')"; [ -n "$c" ] && { SIGN_PROFILE="$c"; break; }
    done
  fi
fi

HAP_SIGN_TOOL="${HAP_SIGN_TOOL_JAR:-}"
if [ -z "$HAP_SIGN_TOOL" ]; then
  for candidate in \
    "$HOME/.harmony-cli/sdk/default/openharmony/toolchains/lib/hap-sign-tool.jar" \
    "$HOME/command-line-tools/sdk/default/openharmony/toolchains/lib/hap-sign-tool.jar" \
    /opt/deveco/toolchains/lib/hap-sign-tool.jar; do
    [ -f "$candidate" ] && HAP_SIGN_TOOL="$candidate" && break
  done
fi

UNSIGNED=1
if [ -n "$SIGN_P12" ] || [ -n "$SIGN_CER" ] || [ -n "$SIGN_PROFILE" ]; then
  missing=""
  [ -f "$SIGN_P12" ] || missing="$missing PHONE_SIGN_P12"
  [ -f "$SIGN_CER" ] || missing="$missing PHONE_SIGN_CER"
  [ -f "$SIGN_PROFILE" ] || missing="$missing PHONE_SIGN_PROFILE"
  [ -n "$SIGN_ALIAS" ] || missing="$missing PHONE_SIGN_KEY_ALIAS"
  [ -n "$SIGN_KEY_PWD" ] || missing="$missing PHONE_SIGN_KEY_PASSWORD"
  [ -n "$SIGN_STORE_PWD" ] || missing="$missing PHONE_SIGN_STORE_PASSWORD"
  if [ -n "$missing" ]; then
    echo "ERROR: 签名材料不完整，缺少：$missing" >&2
    echo "       拒绝用残缺材料签名（半套材料签出来的包不能装，却看着像成功）。" >&2
    exit 1
  fi
  if [ -z "$HAP_SIGN_TOOL" ]; then
    echo "ERROR: 找不到 hap-sign-tool.jar（可用 HAP_SIGN_TOOL_JAR 指定）。" >&2
    exit 1
  fi

  SIGNED_HAP="$OUT_DIR/entry-default-$MODE-signed.hap"
  if "$REPO_ROOT/tools/sign_hap.sh" \
      --in "$HAP" \
      --out "$SIGNED_HAP" \
      --bundle 'com.xiwei.suyue' \
      --p12 "$SIGN_P12" \
      --cer "$SIGN_CER" \
      --profile "$SIGN_PROFILE" \
      --alias "$SIGN_ALIAS" \
      --key-pwd "$SIGN_KEY_PWD" \
      --store-pwd "$SIGN_STORE_PWD" \
      --tool "$HAP_SIGN_TOOL"; then
    HAP="$SIGNED_HAP"
    UNSIGNED=0
  else
    status=$?
    if [ "$status" = "3" ]; then
      echo "（包名不匹配：本次退回未签名产物）" >&2
    else
      exit "$status"
    fi
  fi
fi

echo "HAP_PATH=$REPO_ROOT/apps/phone/$HAP"
# issue #6 P0-A：Wear Engine 需要应用级 client_id 元数据；源码里有不等于
# 最终 HAP 里还在。此时 module.json5 已被注入真实值（见上文注入块），
# 这里从源码取该值，再去最终 HAP 的清单里核对，缺项/空值/不一致一律失败
# ——不许打出「能装但发现手表必失败」的包。校验后 EXIT trap 会还原占位符。
CLIENT_ID="$(python3 - <<'PY'
import re
try:
    src = open('entry/src/main/module.json5', encoding='utf-8').read()
except OSError:
    print('')
    raise SystemExit(0)
m = re.search(r'"name"\s*:\s*"client_id"\s*,\s*"value"\s*:\s*"([^"]*)"', src)
print(m.group(1) if m else '')
PY
)"
if [ -z "$CLIENT_ID" ]; then
  echo "ERROR: 源码 module.json5 缺少 client_id 元数据（issue #6）——" >&2
  echo "       设备发现会报 1008509999，拒绝产出这种包。" >&2
  exit 1
fi
if [ "$CLIENT_ID" = "$CLIENT_ID_PLACEHOLDER" ]; then
  echo "ERROR: client_id 仍是占位符，真实值未注入（issue #6）——" >&2
  echo "       拒绝打出会报 1008509999 的包。" >&2
  exit 1
fi
"$REPO_ROOT/tests/build_artifact_check.sh" \
  "$REPO_ROOT/apps/phone/$HAP" \
  --bundle 'com.xiwei.suyue' \
  --device phone \
  --mode "$MODE" \
  --expect-metadata "client_id=$CLIENT_ID"

if [ "$UNSIGNED" = "1" ]; then
  cat >&2 <<'MSG'

========================================================================
注意：本次产物是 **未签名 HAP**，不可安装到 Pocket 2。

两种原因之一（上面的日志会指明是哪种）：
  1. 没有找到签名材料：PHONE_SIGN_* 未设置，且 signing/ 下没有
     .p12/.cer/.p7b；
  2. 找到了 profile，但它授权的包名与本 HAP 不一致，已拒绝签名。

材料就位后本脚本会自动走：未签名构建 →
tools/sign_hap.sh（sign-app + verify-app），产物名为
entry-default-<mode>-signed.hap。
本轮构建成功 ≠ 可安装。
========================================================================
MSG
fi
