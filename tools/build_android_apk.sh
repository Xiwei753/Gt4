#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Local/reproducible Android APK build for suyue (issue #3).
#
# 产物：android/app/build/outputs/apk/<mode>/app-<mode>.apk
#
# 诚实边界（照抄 HAP 侧的规矩）：
#   - 需要一个真实的 Android SDK（ANDROID_HOME / ANDROID_SDK_ROOT /
#     android/local.properties 三者之一）。缺工具链就大声失败，
#     不伪造成功。
#   - 构建成功 ≠ 可安装到 nova 7 Pro，更 ≠ 能与 GT 4 配对传书。
#     Wear Engine 配对还依赖 AGC 注册、签名指纹、Huawei Health 等，
#     本脚本只保证 APK 容器/清单/签名信息自洽。
#   - debug APK 用本机 debug 证书签名，其指纹**不是**手表端
#     supportLists / Wear Engine 认可的正式手机指纹；要跑真机配对，
#     需用注册过的 keystore 出 release 包（见 android/README.md）。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$REPO_ROOT/android"
cd "$APP_DIR"

MODE="${1:-debug}"   # debug | release
if [ "$MODE" != "debug" ] && [ "$MODE" != "release" ]; then
  echo "usage: $0 [debug|release]" >&2
  exit 2
fi

# ---------- 定位 Android SDK ----------
ANDROID_SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -z "$ANDROID_SDK" ] && [ -f "$APP_DIR/local.properties" ]; then
  ANDROID_SDK="$(sed -n 's/^sdk\.dir=//p' "$APP_DIR/local.properties" | head -n 1)"
fi
if [ -z "$ANDROID_SDK" ] || [ ! -d "$ANDROID_SDK" ]; then
  echo "ERROR: 找不到 Android SDK。请设置 ANDROID_HOME/ANDROID_SDK_ROOT，" >&2
  echo "       或在 android/local.properties 写 sdk.dir=..." >&2
  exit 1
fi

BUILD_TOOLS="$(ls -d "$ANDROID_SDK"/build-tools/* 2>/dev/null | sort -V | tail -n 1 || true)"
if [ -z "$BUILD_TOOLS" ]; then
  echo "ERROR: $ANDROID_SDK/build-tools/ 下没有 build-tools。" >&2
  exit 1
fi
APKSIGNER="$BUILD_TOOLS/apksigner"
AAPT2="$BUILD_TOOLS/aapt2"
[ -x "$APKSIGNER" ] || { echo "ERROR: 缺少 apksigner: $APKSIGNER" >&2; exit 1; }
[ -x "$AAPT2" ] || { echo "ERROR: 缺少 aapt2: $AAPT2" >&2; exit 1; }

echo "SDK=$ANDROID_SDK"
echo "BUILD_TOOLS=$BUILD_TOOLS"

# ---------- 可选：注入手表指纹（正式包） ----------
# 与手机 HAP 侧 tools/inject_signing.py 同思路：指纹不进仓库，
# 由 CI/本机通过环境变量在构建前注入，构建后无条件还原。
# 未注入 = 占位空串，App 里 isConfigured()=false，发送按钮保持禁用。
IDENTITY_FILE="$APP_DIR/app/src/main/java/com/xiwei/suyue/wear/PeerIdentityConfig.kt"
WATCH_FP="${SUYUE_ANDROID_WATCH_FINGERPRINT:-}"
IDENTITY_BACKUP=""
restore_identity() {
  if [ -n "$IDENTITY_BACKUP" ] && [ -f "$IDENTITY_BACKUP" ]; then
    cp "$IDENTITY_BACKUP" "$IDENTITY_FILE"
    rm -f "$IDENTITY_BACKUP"
  fi
}
trap restore_identity EXIT

if [ -n "$WATCH_FP" ]; then
  IDENTITY_BACKUP="$(mktemp)"
  cp "$IDENTITY_FILE" "$IDENTITY_BACKUP"
  echo "注入手表指纹到 PeerIdentityConfig.kt（构建后还原）"
  WATCH_FP_ENV="$WATCH_FP" python3 - "$IDENTITY_FILE" <<'PY'
import os, re, sys
path = sys.argv[1]
value = os.environ["WATCH_FP_ENV"]
if re.search(r"[\s:;,'\"\\]", value):
    sys.stderr.write("ERROR: 手表指纹含非法字符（空白/冒号/分号/引号/反斜杠）\n")
    sys.exit(2)
with open(path, encoding="utf-8") as fh:
    text = fh.read()
new = re.sub(r'(INJECTED_WATCH_FINGERPRINT\s*(?::\s*String)?\s*=\s*)""',
             lambda m: m.group(1) + '"' + value + '"', text, count=1)
if new == text:
    sys.stderr.write("未找到 INJECTED_WATCH_FINGERPRINT 占位\n")
    sys.exit(1)
with open(path, "w", encoding="utf-8") as fh:
    fh.write(new)
PY
fi

# ---------- 清理本次输出 ----------
# 不能从历史产物里捡到旧 APK（照抄 HAP 侧 P1-8）。
rm -rf app/build/outputs

# ---------- Gradle 构建 ----------
if [ "$MODE" = "release" ]; then
  TASK=":app:assembleRelease"
else
  TASK=":app:assembleDebug"
fi
echo "运行 ./gradlew $TASK --no-daemon"
./gradlew "$TASK" --no-daemon

OUT_DIR="app/build/outputs/apk/$MODE"
APK="$(find "$OUT_DIR" -maxdepth 1 -name '*.apk' -type f 2>/dev/null | head -n 1)"
if [ -z "$APK" ]; then
  echo "ERROR: gradle 报成功，但 $OUT_DIR/ 下没有 APK。" >&2
  exit 1
fi

# ---------- 产物检查（容器/清单/签名） ----------
SIZE="$(stat -c%s "$APK" 2>/dev/null || stat -f%z "$APK")"
if [ "$SIZE" -le 0 ]; then
  echo "FAIL: APK 为空（0 字节）：$APK" >&2
  exit 1
fi

MAGIC="$(head -c 4 "$APK" | od -An -tx1 | tr -d ' \n')"
if [ "$MAGIC" != "504b0304" ]; then
  echo "FAIL: APK 不是 ZIP 容器（magic=$MAGIC）：$APK" >&2
  exit 1
fi
if ! unzip -tqq "$APK" >/dev/null 2>&1; then
  echo "FAIL: APK ZIP 逐项解压/CRC 校验失败：$APK" >&2
  exit 1
fi

# 包名 / 版本 / 标签。
BADGING="$("$AAPT2" dump badging "$APK" 2>/dev/null || true)"
PKG="$(printf '%s\n' "$BADGING" | sed -n "s/^package: name='\([^']*\)'.*/\1/p" | head -n 1)"
if [ -z "$PKG" ]; then
  echo "FAIL: 无法从 APK 读取包名（aapt2 dump badging）：$APK" >&2
  exit 1
fi
EXPECT_PKG="com.xiwei.suyue.android"
if [ "$PKG" != "$EXPECT_PKG" ]; then
  echo "FAIL: APK applicationId=$PKG，期望 $EXPECT_PKG：$APK" >&2
  exit 1
fi

# 签名校验（P0-F）：apksigner 退出码必须为 0，且必须存在证书；
# 旧实现用 `|| true` 吞掉退出码，未签名/校验失败也照打 APK_OK。
VERIFY_STATUS=0
VERIFY="$("$APKSIGNER" verify --print-certs "$APK" 2>&1)" || VERIFY_STATUS=$?
if [ "$VERIFY_STATUS" -ne 0 ]; then
  echo "FAIL: apksigner verify 返回非 0（status=$VERIFY_STATUS）：$APK" >&2
  printf '%s\n' "$VERIFY" >&2
  exit 1
fi
if printf '%s' "$VERIFY" | grep -qi 'does not verify\|DOES NOT VERIFY'; then
  echo "FAIL: apksigner verify 报告签名校验未通过：$APK" >&2
  exit 1
fi
# apksigner 输出标签随 build-tools 版本变化：
#   36.x: "Signer #1 certificate SHA-256 digest: <hex>"
#   37.x: "V2 Signer: certificate SHA-256 digest: <hex>"
# 用通用正则匹配，不绑死某一版本的标签（CI runner 用的是 37.0.0）。
CERT_SHA256="$(printf '%s\n' "$VERIFY" \
  | sed -n 's/^.*certificate SHA-256 digest: *//p' | head -n 1)"
CERT_DN="$(printf '%s\n' "$VERIFY" \
  | sed -n 's/^.*certificate DN: *//p' | head -n 1)"
if [ -z "$CERT_SHA256" ]; then
  echo "FAIL: APK 未签名（apksigner 未读到证书 SHA-256）。" >&2
  echo "      release 必须配置正式 keystore（SUYUE_ANDROID_KEYSTORE_* 环境变量）；" >&2
  echo "      debug 应被 Android 自动签名，未签名说明构建配置异常。" >&2
  printf '%s\n' "$VERIFY" >&2
  exit 1
fi
SIGNED_STATE="yes"

# release 若仍由 Android Debug 证书签名，视为“未正式签名”，直接失败，
# 避免把 debug 指纹的包当成可对接 Wear Engine 的正式包（P0-F）。
if [ "$MODE" = "release" ] && printf '%s' "$CERT_DN" | grep -qi 'Android Debug'; then
  echo "FAIL: release 包由 Android Debug 证书签名，不是正式签名。" >&2
  echo "      请设置 SUYUE_ANDROID_KEYSTORE_PATH/_PASSWORD/_KEY_ALIAS/_KEY_PASSWORD。" >&2
  exit 1
fi

# debug 包可用于 UI/导入自测，但不能作为 Wear Engine 授权凭据。
if [ "$MODE" = "debug" ]; then
  WEAR_AUTH="no(debug:UI/import-only-not-wear-engine-authorized)"
else
  WEAR_AUTH="pending-agc-fingerprint-registration"
fi

SHA="$(sha256sum "$APK" | awk '{print $1}')"
echo "APK_OK path=$REPO_ROOT/android/$APK size=$SIZE package=$PKG mode=$MODE signed=$SIGNED_STATE cert_dn='$CERT_DN' cert_sha256=$CERT_SHA256 sha256=$SHA wear_engine_authorized=$WEAR_AUTH note=apk-container-and-cert-check-not-device-install"

cat >&2 <<'MSG'

=======================================================================
注意：本脚本只做 APK 容器/清单/证书级检查。
  - 构建成功 **不等于** 可安装到 nova 7 Pro；
  - 更 **不等于** 能与 GT 4 通过 Wear Engine 配对传书（那还需要
    AGC 注册的正式签名指纹 + Huawei Health + 手表端应用运行）。
  - debug 包的签名指纹是本机 Android Debug 证书，**不是**手表端
    supportLists / Wear Engine 认可的正式手机指纹。
MSG
