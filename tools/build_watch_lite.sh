#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Local/reproducible Lite Wearable HAP build for suyue watch (GT 4 46mm).
# Requires a DevEnvStudio/DevEco environment that provides `hvigorw` and the
# Lite Wearable SDK. This script does NOT fabricate success: any missing
# toolchain or signing material fails the build loudly.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/apps/watch"

MODE="${1:-debug}"   # debug | release
PRODUCT="${PRODUCT:-default}"

if [ "$MODE" != "debug" ] && [ "$MODE" != "release" ]; then
  echo "usage: $0 [debug|release]" >&2
  echo "       (optional) WATCH_BOOKS_DIR=/path/to/txt-dir $0 debug" >&2
  echo "       把选定 TXT 编译成内置 JS 数据模块，见 issue #10。" >&2
  exit 2
fi

if ! command -v hvigorw >/dev/null 2>&1 && [ ! -x "./hvigorw" ]; then
  echo "ERROR: hvigorw not found. Build with the Lite Wearable DevEco toolchain" >&2
  echo "       (see docs/WATCH_INSTALL.md). Node-only checks cannot produce a HAP." >&2
  exit 1
fi

HVIGORW="$(command -v hvigorw || echo ./hvigorw)"

# 清理本次输出：不能从历史产物中
# 捡到旧 HAP（施工单 P1-8）。
OUT_DIR="entry/build/default/outputs/default"
rm -rf entry/build
mkdir -p "$OUT_DIR"

# ---- 内置书籍（issue #10）---------------------------------------------
# 可选入口（向后兼容，不带变量＝与以前完全一致）：
#   WATCH_BOOKS_DIR=/绝对路径/我的书 tools/build_watch_lite.sh debug
# 构建期把选定 TXT 生成为 **JS 数据模块**写入
#   apps/watch/entry/src/main/js/MainAbility/books/
#   （BookCatalog.g.js 仅元数据 / BookText_<id>.g.js 分块正文 /
#     BookRegistry.g.js 访问器），由 webpack 真正打包进 entry.bin。
# 为什么不用 rawfile：官方 Lite 示例只用 internal://app/... 私有目录，
# JS 没有读 internal://app/rawfile/... 的通路（issue #10 实测结论）。
# 仓库里的 books/ 是空默认值：带书构建前先备份、构建后由 trap 还原，
# 私人正文既不进仓库、也不进日志（只打印书名与字节数）。
BOOKS_JS_DIR="$REPO_ROOT/apps/watch/entry/src/main/js/MainAbility/books"
BOOKS_REPORT=""
BOOKS_BACKUP=""

cleanup_books() {
  if [ -n "$BOOKS_BACKUP" ] && [ -d "$BOOKS_BACKUP" ]; then
    rm -rf "$BOOKS_JS_DIR"
    mv "$BOOKS_BACKUP/books" "$BOOKS_JS_DIR"
    rm -rf "$BOOKS_BACKUP"
    BOOKS_BACKUP=""
  fi
}
trap cleanup_books EXIT

if [ -n "${WATCH_BOOKS_DIR:-}" ]; then
  # 先备份提交的默认空实现：generator 会清空并重建该目录，
  # 中途失败也要由 trap 还原。
  BOOKS_BACKUP="$(mktemp -d)"
  cp -a "$BOOKS_JS_DIR" "$BOOKS_BACKUP/books"
  python3 "$REPO_ROOT/tools/generate_watch_book_modules.py" \
    --books-dir "$WATCH_BOOKS_DIR" \
    --out-dir "$BOOKS_JS_DIR"
  BOOKS_REPORT="$BOOKS_JS_DIR/books_report.json"
  echo "WATCH_BOOKS_STAGED=1"
fi

"$HVIGORW" --mode module -p product="$PRODUCT" -p buildMode="$MODE" assembleHap --no-daemon

# 按请求的 buildMode 挑选：release
# 构建不得验到 debug 产物。
# 未配置 signingConfigs 时 hvigor 只产出
# entry-default-unsigned.hap（名字里没有 buildMode 段，本机实测），
# 这与"根本没有产物"是两件事：前者要明确报"未签名、不可安装"，
# 后者才是构建失败。
HAP="$(find "$OUT_DIR" -name "entry-default-$MODE-*.hap" -type f 2>/dev/null | head -n 1)"
UNSIGNED=0
if [ -z "$HAP" ]; then
  HAP="$(find "$OUT_DIR" -name 'entry-default-unsigned.hap' -type f 2>/dev/null | head -n 1)"
  UNSIGNED=1
fi
if [ -z "$HAP" ]; then
  echo "ERROR: hvigor reported success but no $MODE HAP was produced under" >&2
  echo "       $OUT_DIR/" >&2
  exit 1
fi

echo "BUILT_UNSIGNED_HAP_PATH=$REPO_ROOT/apps/watch/$HAP"

# ---- 签名（issue #2 实测路径）----------------------------------------
# 为什么不用 hvigor 的 signingConfigs：在 Lite（legacyAppTasks/
# legacyHapTasks）工程上实测失败——
#   ERROR: Failed :entry:default@SignHap
#   Error Code: 00308018  ENOENT: stat '<dir>/material'
# 即使 build-profile.json5 里的 signingConfigs 形状与该 SDK 的 Stage
# 工程完全一致，legacy Lite 的 SignHap 仍去找一个不存在的 material
# 目录。素笺的 CI 早就改成同一套绕行方案：**先出未签名包，再用
# hap-sign-tool sign-app 直接签名**。这里采用同一条已验证路径。
#
# 材料来源（按优先级）：
#   1. 环境变量 WATCH_SIGN_P12 / WATCH_SIGN_CER / WATCH_SIGN_PROFILE
#      + WATCH_SIGN_KEY_ALIAS / WATCH_SIGN_KEY_PASSWORD /
#        WATCH_SIGN_STORE_PASSWORD（CI 用，来自 Secrets）
#   2. $SIGNING_DIR（默认 $REPO_ROOT/signing/，内容已被 .gitignore 挡住）
#
# 本地目录按用途分开，**不能只是"取第一个匹配文件"**：手机和手表在华为侧
# 是两个独立应用（com.xiwei.suyue / con.xiwei.suyue.gt4），各自的 profile
# 放在同一层会互相顶替。所以：
#   shared/  两端共用：私钥、账号级调试证书链、口令
#   watch/   手表自己的 profile
#   phone/   手机自己的 profile
# 两者都缺就保持未签名，并明确报"不可安装"，绝不假装签名成功。
SIGNING_DIR="${WATCH_SIGNING_DIR:-$REPO_ROOT/signing}"
SIGN_P12="${WATCH_SIGN_P12:-}"
SIGN_CER="${WATCH_SIGN_CER:-}"
SIGN_PROFILE="${WATCH_SIGN_PROFILE:-}"
SIGN_ALIAS="${WATCH_SIGN_KEY_ALIAS:-}"
SIGN_KEY_PWD="${WATCH_SIGN_KEY_PASSWORD:-}"
SIGN_STORE_PWD="${WATCH_SIGN_STORE_PASSWORD:-}"

first_in() { find "$1" -maxdepth 1 -name "$2" -type f 2>/dev/null | head -n 1; }

if [ -d "$SIGNING_DIR" ]; then
  for f in "$SIGNING_DIR/shared/credentials.env" "$SIGNING_DIR/credentials.env"; do
    if [ -f "$f" ]; then
      set -a; . "$f"; set +a
      break
    fi
  done
  SIGN_ALIAS="${WATCH_SIGN_KEY_ALIAS:-${KEY_ALIAS:-$SIGN_ALIAS}}"
  SIGN_KEY_PWD="${WATCH_SIGN_KEY_PASSWORD:-${KEY_PASSWORD:-$SIGN_KEY_PWD}}"
  SIGN_STORE_PWD="${WATCH_SIGN_STORE_PASSWORD:-${STORE_PASSWORD:-$SIGN_STORE_PWD}}"

  if [ -z "$SIGN_P12" ]; then
    for d in "$SIGNING_DIR/shared" "$SIGNING_DIR"; do
      c="$(first_in "$d" '*.p12')"
      [ -n "$c" ] && { SIGN_P12="$c"; break; }
    done
  fi
  # 证书是账号级的（两张 profile 内嵌同一张，DER-SHA256 实测相同），
  # 所以默认从 shared/ 取。
  if [ -z "$SIGN_CER" ]; then
    for d in "$SIGNING_DIR/shared" "$SIGNING_DIR/watch" "$SIGNING_DIR"; do
      c="$(first_in "$d" '*.cer')"
      [ -n "$c" ] && { SIGN_CER="$c"; break; }
    done
  fi
  # profile 是**按应用**的：手表只认手表自己的，绝不回退到 phone/
  if [ -z "$SIGN_PROFILE" ]; then
    for d in "$SIGNING_DIR/watch" "$SIGNING_DIR"; do
      c="$(first_in "$d" '*.p7b')"
      [ -n "$c" ] && { SIGN_PROFILE="$c"; break; }
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

SIGNED_HAP=""
SIGNED_BIN_SHA256=""
VERIFY_STATE=""
SIGN_STATUS=""
if [ -n "$SIGN_P12" ] || [ -n "$SIGN_CER" ] || [ -n "$SIGN_PROFILE" ]; then
  missing=""
  [ -f "$SIGN_P12" ] || missing="$missing WATCH_SIGN_P12"
  [ -f "$SIGN_CER" ] || missing="$missing WATCH_SIGN_CER"
  [ -f "$SIGN_PROFILE" ] || missing="$missing WATCH_SIGN_PROFILE"
  [ -n "$SIGN_ALIAS" ] || missing="$missing WATCH_SIGN_KEY_ALIAS"
  [ -n "$SIGN_KEY_PWD" ] || missing="$missing WATCH_SIGN_KEY_PASSWORD"
  [ -n "$SIGN_STORE_PWD" ] || missing="$missing WATCH_SIGN_STORE_PASSWORD"
  if [ -n "$missing" ]; then
    echo "ERROR: 签名材料不完整，缺少：$missing" >&2
    echo "       拒绝用残缺材料签名（半套材料签出来的包不能装，却看着像成功）。" >&2
    exit 1
  fi
  if [ -z "$HAP_SIGN_TOOL" ]; then
    echo "ERROR: 找不到 hap-sign-tool.jar（可用 HAP_SIGN_TOOL_JAR 指定）。" >&2
    exit 1
  fi

  # 签名与"包名预检"的实现见 tools/sign_hap.sh —— 手机端共用同一份，
  # 避免两处规则各自漂移。这条预检不是洁癖：拿**手机**的 profile
  # （com.xiwei.suyue）去签**手表** HAP（con.xiwei.suyue.gt4），
  # hap-sign-tool 照样报 "Sign Hap success!"、verify-app 也报
  # Verify success，但设备按包名校验会拒绝安装——"签名成功"没有意义。
  SIGNED_HAP="$OUT_DIR/entry-default-$MODE-signed.hap"
  SIGN_HAP_LOG="$OUT_DIR/.sign_hap.log"
  set +e
  "$REPO_ROOT/tools/sign_hap.sh" \
    --in "$HAP" \
    --out "$SIGNED_HAP" \
    --bundle 'con.xiwei.suyue.gt4' \
    --source-manifest "$REPO_ROOT/apps/watch/entry/src/main/config.json" \
    --p12 "$SIGN_P12" \
    --cer "$SIGN_CER" \
    --profile "$SIGN_PROFILE" \
    --alias "$SIGN_ALIAS" \
    --key-pwd "$SIGN_KEY_PWD" \
    --store-pwd "$SIGN_STORE_PWD" \
    --tool "$HAP_SIGN_TOOL" 2>&1 | tee "$SIGN_HAP_LOG"
  SIGN_STATUS=${PIPESTATUS[0]}
  set -e
  if [ "$SIGN_STATUS" = "0" ]; then
    HAP="$SIGNED_HAP"
    UNSIGNED=0
    # 本次签名的内部 BIN 摘要，稍后逐字节核对最终 ZIP 里的 BIN。
    SIGNED_BIN_SHA256="$(sed -n 's/^SIGNED_BIN_SHA256=//p' "$SIGN_HAP_LOG" | tail -n 1)"
    if grep -q '^VERIFY_UNSUPPORTED_FOR_LITE_BIN:' "$SIGN_HAP_LOG"; then
      VERIFY_STATE="VERIFY_UNSUPPORTED_FOR_LITE_BIN"
    elif grep -q '^VERIFY_APP_OK:' "$SIGN_HAP_LOG"; then
      VERIFY_STATE="VERIFY_APP_OK"
    else
      VERIFY_STATE="unknown"
    fi
    echo "SIGNED_LITE_HAP_PATH=$REPO_ROOT/apps/watch/$HAP"
  elif [ "$SIGN_STATUS" = "3" ]; then
    cat >&2 <<'MSG'

========================================================================
拒绝签名：签名 profile 授权的包名与本 HAP 不一致。
签出来的包证书链有效，但设备按包名校验会拒绝安装——"签名成功"
在这里没有意义。本次退回**未签名产物**。
正确做法：把手表的证书/profile 放进 signing/watch/（或设 WATCH_SIGN_*），
不要用别的应用的 profile 顶替。
========================================================================
MSG
    exit 3
  else
    exit "$SIGN_STATUS"
  fi
fi

ARTIFACT_CHECK_ARGS=(
  "$REPO_ROOT/apps/watch/$HAP"
  --bundle 'con.xiwei.suyue.gt4'
  --source-manifest "$REPO_ROOT/apps/watch/entry/src/main/config.json"
  --device liteWearable
  --mode "$MODE"
)
# 逐字节核对：最终 ZIP 里的 BIN 必须就是本次签名产出的那个 BIN（issue #4）。
# 这不是"签名前后哈希相同"，而是"归档内容 == 签名输出"。
if [ -n "$SIGNED_BIN_SHA256" ]; then
  ARTIFACT_CHECK_ARGS+=(--expect-bin-sha256 "$SIGNED_BIN_SHA256")
fi
# 内置书籍（issue #10）：核对**内层 entry.bin** 真的带了每本内置书的
# bookId / 书名 / 正文块（只看源码目录或外层 ZIP 都不算数）。
if [ -n "$BOOKS_REPORT" ]; then
  ARTIFACT_CHECK_ARGS+=(--expect-books-report "$BOOKS_REPORT")
fi
"$REPO_ROOT/tests/build_artifact_check.sh" "${ARTIFACT_CHECK_ARGS[@]}"

if [ -n "$BOOKS_REPORT" ]; then
  BOOKS_COUNT="$(python3 -c \
    'import json,sys; print(len(json.load(open(sys.argv[1])).get("books", [])))' \
    "$BOOKS_REPORT" 2>/dev/null || echo unknown)"
  echo "WATCH_BOOKS_BAKED=${BOOKS_COUNT:-unknown}"
fi

if [ "$UNSIGNED" = "0" ]; then
  BIN_BUNDLE="$(python3 "$REPO_ROOT/tools/check_lite_bin.py" \
      --hap "$REPO_ROOT/apps/watch/$HAP" --bundle 'con.xiwei.suyue.gt4' 2>/dev/null \
      | sed -n 's/.*header bundleName=\([^ ]*\).*/\1/p')"
  echo "WATCH_HAP_PATH=$REPO_ROOT/apps/watch/$HAP"
  echo "WATCH_HAP_SIZE=$(stat -c%s "$REPO_ROOT/apps/watch/$HAP" 2>/dev/null || stat -f%z "$REPO_ROOT/apps/watch/$HAP")"
  echo "WATCH_HAP_SHA256=$(sha256sum "$REPO_ROOT/apps/watch/$HAP" | awk '{print $1}')"
  echo "WATCH_HAP_BIN_BUNDLE=${BIN_BUNDLE:-unknown}"
  echo "WATCH_SIGN_STATUS=SIGNED_TOOL_OK"
  echo "WATCH_VERIFY_STATUS=${VERIFY_STATE:-unknown}"
  rm -f "$SIGN_HAP_LOG"
fi

if [ "$UNSIGNED" = "1" ]; then
  cat >&2 <<'MSG'

========================================================================
注意：本次产物是 **未签名 HAP**，不可安装到 GT 4。

两种原因之一（上面的日志会指明是哪种）：
  1. 没有找到签名材料：WATCH_SIGN_* 未设置，且
     $REPO_ROOT/signing/ 下没有 .p12/.cer/.p7b；
  2. 找到了 profile，但它授权的包名与本 HAP 不一致，已拒绝签名。

材料就位后本脚本会自动走已验证的路径：未签名构建 →
hap-sign-tool sign-app -inForm bin → verify-app -inForm bin → 单 bin ZIP 封装，产物名为
entry-default-<mode>-signed.hap。

签名材料说明与包名注意事项见 signing/README.md。
本轮构建成功 ≠ 第 1 阶段验收通过。
========================================================================
MSG
  exit 1
fi
