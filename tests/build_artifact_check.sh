#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Verify a built HAP artifact (施工单 P1-8 / 第二轮 P1-6)：
#   - HAP 容器：必须是 ZIP（PK 魔数），
#     且包含模块清单（modules.json /
#     config.json）；
#   - 包名与期望 bundleId 一致；
#   - 目标设备类型一致（liteWearable /
#     phone）；
#   - buildMode 与文件名匹配：release
#     不得验到 debug 或旧产物；
#   - 可选：Manifest 中必须出现期望指纹，
#     且不得残留占位符；
#   - 可选：--expect-bin-sha256 时，ZIP 内提取的
#     BIN 必须与本次签名输出逐字节一致（是"归档
#     内容 == 签名产物"，不是"签名前后哈希相同"）；
#   - 非零字节，报告大小与 SHA-256。
#
# 注意：本脚本只做**容器/清单级**检查，
# 不做证书签名验证。签名验证必须由官方
# hap-sign-tool 在真实工具链上完成
# （workflow 中的 verify-signature 步骤）。
set -euo pipefail

HAP="${1:?usage: build_artifact_check.sh <path-to.hap> [--bundle ID] [--device TYPE] [--mode debug|release] [--expect-fingerprint VALUE]}"
shift || true

BUNDLE=""
DEVICE=""
MODE=""
EXPECT_FINGERPRINT=""
EXPECT_BIN_SHA256=""
SOURCE_MANIFEST=""
EXPECT_METADATA=()
SINGLE_BIN=0
MANIFEST_ORIGIN="embedded"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --bundle) BUNDLE="${2:?--bundle needs a value}"; shift 2 ;;
    --device) DEVICE="${2:?--device needs a value}"; shift 2 ;;
    --mode) MODE="${2:?--mode needs a value}"; shift 2 ;;
    --expect-fingerprint) EXPECT_FINGERPRINT="${2:?--expect-fingerprint needs a value}"; shift 2 ;;
    --expect-bin-sha256) EXPECT_BIN_SHA256="${2:?--expect-bin-sha256 needs a value}"; shift 2 ;;
    --expect-metadata) EXPECT_METADATA+=("${2:?--expect-metadata needs NAME=VALUE}"); shift 2 ;;
    --source-manifest) SOURCE_MANIFEST="${2:?--source-manifest needs a value}"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ ! -f "$HAP" ]; then
  echo "FAIL: HAP not found: $HAP" >&2
  exit 1
fi

SIZE="$(stat -c%s "$HAP" 2>/dev/null || stat -f%z "$HAP")"
if [ "$SIZE" -le 0 ]; then
  echo "FAIL: HAP is empty (0 bytes): $HAP" >&2
  exit 1
fi

# 1) 容器：HAP 是 ZIP。
MAGIC="$(head -c 4 "$HAP" | od -An -tx1 | tr -d ' \n')"
if [ "$MAGIC" != "504b0304" ]; then
  echo "FAIL: HAP is not a ZIP container (magic=$MAGIC): $HAP" >&2
  exit 1
fi

# HAP 安装器最终需要读取完整归档，不能仅靠 PK 魔数与
# 单个清单项就当整个 ZIP 无损。这里逐项解压并校验 CRC，
# 提前拦下传输截断、损坏或目录记录异常的产物。
if ! unzip -tqq "$HAP" >/dev/null 2>&1; then
  echo "FAIL: HAP ZIP full extraction/CRC test failed: $HAP" >&2
  exit 1
fi

# 2) Manifest: 现代 HAP 是顶层 config.json / module.json；
# legacy Lite Debug HAP 的 ZIP 可能只有 entry-default-unsigned.bin，
# 不能把这种合法的调测助手容器误判为"清单缺失"。
if [ "$DEVICE" = "liteWearable" ] && python3 - "$HAP" >/dev/null 2>&1 <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    files = [x.filename for x in z.infolist()]
    assert len(files) == 1 and files[0].endswith(".bin")
    assert "/" not in files[0] and "\\" not in files[0]
PY
then
  SINGLE_BIN=1
  if [ -z "$SOURCE_MANIFEST" ] || [ ! -f "$SOURCE_MANIFEST" ]; then
    echo "FAIL: Lite single-bin HAP requires a source config.json via --source-manifest." >&2
    exit 1
  fi
  MANIFEST="config.json"
  MANIFEST_ORIGIN="source-only"
  MANIFEST_TEXT="$(cat "$SOURCE_MANIFEST")"
else
  if unzip -l "$HAP" module.json >/dev/null 2>&1; then
    MANIFEST="module.json"
  elif unzip -l "$HAP" modules.json >/dev/null 2>&1; then
    MANIFEST="modules.json"
  elif unzip -l "$HAP" config.json >/dev/null 2>&1; then
    MANIFEST="config.json"
  else
    echo "FAIL: HAP has no supported manifest or Lite single-bin layout: $HAP" >&2
    exit 1
  fi
  MANIFEST_TEXT="$(unzip -p "$HAP" "$MANIFEST" 2>/dev/null)"
fi

# 3)+4) 包名 / 目标设备类型。
#     用 JSON 解析，而不是逐行 grep：manifest（尤其源码 config.json）
#     常是格式化多行 JSON，"deviceType"/"deviceTypes" 与其取值
#     （如 "liteWearable"）往往各自独占一行；grep 逐行匹配会漏判，
#     曾把合法的 Lite 单 bin HAP 误判成 deviceType 不匹配。
#     bundleName 位于 app.bundleName；设备类型位于
#     module.deviceTypes（Stage）或 module.deviceType（legacy/Lite）。
if ! IDENTITY="$(MANIFEST_JSON="$MANIFEST_TEXT" python3 - <<'PY'
import json, os, sys
try:
    data = json.loads(os.environ.get("MANIFEST_JSON", ""))
except Exception as exc:
    sys.stderr.write("manifest is not valid JSON: %s\n" % exc)
    sys.exit(3)

def collect(obj, key, out):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == key:
                out.append(v)
            collect(v, key, out)
    elif isinstance(obj, list):
        for item in obj:
            collect(item, key, out)

bundles, devices = [], []
collect(data, "bundleName", bundles)
collect(data, "deviceTypes", devices)
if not devices:
    collect(data, "deviceType", devices)
flat = []
for v in devices:
    if isinstance(v, list):
        flat.extend(v)
    else:
        flat.append(v)
print("BUNDLE\t" + "\t".join(str(x) for x in bundles))
print("DEVICES\t" + "\t".join(str(x) for x in flat))
PY
)"; then
  echo "FAIL: cannot parse HAP manifest as JSON ($MANIFEST): $HAP" >&2
  exit 1
fi

MANIFEST_BUNDLES="$(printf '%s\n' "$IDENTITY" | awk -F'\t' '$1 == "BUNDLE" { for (i = 2; i <= NF; i++) print $i }')"
MANIFEST_DEVICES="$(printf '%s\n' "$IDENTITY" | awk -F'\t' '$1 == "DEVICES" { for (i = 2; i <= NF; i++) print $i }')"

if [ -n "$BUNDLE" ]; then
  if ! printf '%s\n' "$MANIFEST_BUNDLES" | grep -qxF "$BUNDLE"; then
    echo "FAIL: HAP bundleName != $BUNDLE ($MANIFEST): $HAP" >&2
    exit 1
  fi
fi

if [ -n "$DEVICE" ]; then
  if ! printf '%s\n' "$MANIFEST_DEVICES" | grep -qxF "$DEVICE"; then
    echo "FAIL: HAP deviceType does not include $DEVICE ($MANIFEST): $HAP" >&2
    exit 1
  fi
fi

# 5) buildMode 与文件名匹配：release
#    不得验到 debug 产物，反之亦然。
#    例外：未配置 signingConfigs 时 hvigor 产出
#    entry-default-unsigned.hap，名字里没有 buildMode
#    段（本机实测）。这种产物**不可安装**，mode 无从
#    核对，因此这里跳过 mode 交叉检查，但把 signed=no
#    记进结论行，绝不当作签名成功。
SIGNED_STATE="unknown"
if [ -n "$MODE" ]; then
  BASENAME="$(basename "$HAP")"
  case "$BASENAME" in
    *-unsigned.hap)
      SIGNED_STATE="no"
      echo "WARN: HAP is unsigned (no signingConfigs): $BASENAME" >&2
      echo "      未签名产物不可安装到 GT 4；本轮不能据此宣称阶段验收通过。" >&2
      ;;
    *)
      case "$BASENAME" in
        *"-$MODE-"*) : ;;
        *) echo "FAIL: HAP filename does not match requested buildMode '$MODE': $BASENAME" >&2
           exit 1 ;;
      esac
      OTHER="debug"; [ "$MODE" = "debug" ] && OTHER="release"
      case "$BASENAME" in
        *"-$OTHER-"*) echo "FAIL: HAP filename matches the wrong buildMode ('$OTHER'): $BASENAME" >&2
           exit 1 ;;
      esac
      case "$BASENAME" in
        *-signed.hap) SIGNED_STATE="yes" ;;
      esac
      ;;
  esac
fi

# 6) Manifest 指纹注入校验（手表侧）：
#    期望指纹必须出现，占位符必须消失。
if [ -n "$EXPECT_FINGERPRINT" ]; then
  if printf '%s' "$MANIFEST_TEXT" | grep -q 'CONFIGURE_WITH_SIGNED_PHONE_FINGERPRINT'; then
    echo "FAIL: HAP manifest still contains the fingerprint placeholder: $HAP" >&2
    exit 1
  fi
  if ! printf '%s' "$MANIFEST_TEXT" | grep -qF "$EXPECT_FINGERPRINT"; then
    echo "FAIL: HAP manifest does not contain the injected fingerprint: $HAP" >&2
    exit 1
  fi
fi

# 6b) 应用元数据校验（issue #6）：Wear Engine 需要 module.metadata 里
#     名为 client_id 的应用级 Client ID；源码里有不等于打包后还在。
#     必须对**最终 HAP 的清单**核对，且不得是空/占位值。
if [ "${#EXPECT_METADATA[@]}" -gt 0 ]; then
  if ! METADATA_OUT="$(MANIFEST_JSON="$MANIFEST_TEXT" \
      EXPECT_METADATA="$(printf '%s\n' "${EXPECT_METADATA[@]}")" \
      python3 - <<'PY'
import json, os, sys

try:
    data = json.loads(os.environ.get("MANIFEST_JSON", ""))
except Exception as exc:
    sys.stderr.write("manifest is not valid JSON: %s\n" % exc)
    sys.exit(3)

metadata = []

def collect(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == "metadata" and isinstance(v, list):
                metadata.extend(v)
            collect(v)
    elif isinstance(obj, list):
        for item in obj:
            collect(item)

collect(data)
# 只在 module 级 metadata 里找（避免把其它无关 metadata 当命中）。
by_name = {}
for item in metadata:
    if isinstance(item, dict) and isinstance(item.get("name"), str):
        by_name[item["name"]] = item.get("value")

fail = False
for line in os.environ.get("EXPECT_METADATA", "").splitlines():
    if not line.strip():
        continue
    name, _, expected = line.partition("=")
    actual = by_name.get(name)
    if actual is None:
        sys.stderr.write("FAIL: HAP manifest has no metadata entry '%s'\n" % name)
        fail = True
        continue
    if not isinstance(actual, str) or not actual.strip():
        sys.stderr.write("FAIL: metadata '%s' is empty in HAP\n" % name)
        fail = True
        continue
    if actual != expected:
        sys.stderr.write(
            "FAIL: metadata '%s' mismatch: hap=%r expected=%r\n"
            % (name, actual, expected))
        fail = True

if fail:
    sys.exit(1)
print("METADATA_OK " + ",".join(
    "%s=%s" % (k, v) for k, v in sorted(by_name.items())))
PY
)"; then
    echo "FAIL: final HAP manifest metadata check failed: $HAP" >&2
    exit 1
  fi
  echo "$METADATA_OUT"
fi

# 7) Lite Wearable 快照完整性（issue #2 新增）。
#    ace-loader 的 lite-snapshot-plugin 逐个调用 jerry-snapshot，
#    把每个页面 JS 编译成 .bc 快照；**失败时只打印一行
#    "Failed to convert ... to a snapshot."，并不会让构建失败**。
#    结果是 BUILD SUCCESSFUL、HAP 也产出了，但缺少该页 .bc，
#    手表上打不开这个页面——绿色构建掩盖了坏应用。
#    实测触发原因：该 JerryScript 构建没有 RegExp，正则字面量在
#    解析期报 SyntaxError（详见 apps/watch/.../util/Validate.js）。
#    这里把"缺快照"变成硬失败，不再靠人眼翻构建日志。
if [ "$DEVICE" = "liteWearable" ] && [ "$SINGLE_BIN" = "0" ]; then
  ENTRIES="$(unzip -Z1 "$HAP" 2>/dev/null)" || ENTRIES=""
  if [ -z "$ENTRIES" ]; then
    echo "FAIL: cannot list HAP entries (unzip -Z1 unavailable): $HAP" >&2
    exit 1
  fi
  MISSING=""
  for entry in $ENTRIES; do
    case "$entry" in
      *.js)
        base="${entry%.js}"
        if ! printf '%s\n' "$ENTRIES" | grep -qxF "$base.bc"; then
          MISSING="$MISSING $base.bc"
        fi
        ;;
    esac
  done
  if [ -n "$MISSING" ]; then
    echo "FAIL: Lite HAP is missing JerryScript snapshots for:$MISSING" >&2
    echo "      hvigor 会报 BUILD SUCCESSFUL，但这些页面在设备上起不来。" >&2
    echo "      lite-snapshot-plugin 只打印错误，不会让构建失败；" >&2
    echo "      排查方向见 apps/watch/entry/src/main/js/MainAbility/util/Validate.js。" >&2
    exit 1
  fi
fi

if [ "$SINGLE_BIN" = "1" ]; then
  if [ -z "$BUNDLE" ]; then
    echo "FAIL: Lite single-bin header inspection needs --bundle" >&2
    exit 1
  fi
  # 直接读取安装时会传到手表的 bin 头部包名；不能仅看源码 config.json。
  if ! python3 "$(dirname "$0")/../tools/check_lite_bin.py" \
      --hap "$HAP" --bundle "$BUNDLE"; then
    echo "FAIL: Lite BIN 的真实包名或头部不正确。" >&2
    exit 1
  fi
  # 逐字节核对：ZIP 内提取的 BIN 必须与本次签名输出完全一致。
  # （这不是"签名前后 BIN 哈希相同"；只是"归档内容 == 签名产物"。）
  if [ -n "$EXPECT_BIN_SHA256" ]; then
    ACTUAL_BIN_SHA="$(python3 - "$HAP" <<'PY'
import hashlib, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    files = z.infolist()
    if len(files) != 1 or files[0].is_dir():
        raise SystemExit("not a single-entry archive: %s" % [f.filename for f in files])
    print(hashlib.sha256(z.read(files[0])).hexdigest())
PY
)"
    if [ "$ACTUAL_BIN_SHA" != "$EXPECT_BIN_SHA256" ]; then
      echo "FAIL: HAP 内的 BIN 与本次签名产物不一致" >&2
      echo "      extracted=$ACTUAL_BIN_SHA" >&2
      echo "      expected =$EXPECT_BIN_SHA256" >&2
      echo "      ($HAP)" >&2
      exit 1
    fi
    echo "BIN_SHA256_MATCH=$ACTUAL_BIN_SHA"
  fi
  echo "WARN: 单 .bin HAP 不含顶层 manifest/.bc；包名、指纹、设备类型仅根据本次源码 config.json 校验，不能冒充已验证 bin 内数据。" >&2
fi

SHA="$(sha256sum "$HAP" | awk '{print $1}')"
echo "HAP_OK path=$HAP manifest=$MANIFEST manifest_origin=$MANIFEST_ORIGIN single_bin=$SINGLE_BIN size=$SIZE mode=${MODE:-unknown} signed=$SIGNED_STATE sha256=$SHA note=archive-check-not-device-install"
