// SPDX-License-Identifier: GPL-3.0-only
// Wear Engine peer 身份格式的**纯逻辑**（issue #13）。
//
// 本模块不 import 任何 SDK，Node 可直接测试：
//   node tests/peer_identity_policy.test.mjs
//
// 官方 FAQ（2026-09-20）按“被识别端”平台区分：
//   - HarmonyOS 5.0+ 手机原生应用：APP ID
//     （AGC 的 bundle-info.app-identifier，不是 OAuth Client ID，
//      也不是证书 SHA-256）；
//   - Lite Wearable 应用：
//     bundleName_base64(签名证书里的原始 EC 公钥点)。
// 因此手机→手表 remoteApp 的 fingerprint 必须是 Lite 公钥指纹；
// 手表登记“手机是谁”时必须用手机 APP ID。两者不能互相顶替。
//
// 本模块只校验、不规范化：合法值按原样保留大小写与 + / =。
// 任何空值、错误 bundle、64 位十六进制证书摘要、整张证书 DER/SPKI
// 的 Base64 都必须 fail closed。

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// 未压缩 EC 公钥点：P-256 / P-384 / P-521。
export const EC_POINT_LENGTHS = [65, 97, 133];

export const WATCH_LITE_KIND = 'watch-lite-pubkey';
export const PHONE_APP_ID_KIND = 'phone-app-id';

function base64Encode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const b1 = has1 ? bytes[i + 1] : 0;
    const b2 = has2 ? bytes[i + 2] : 0;
    out += BASE64_ALPHABET.charAt(b0 >> 2);
    out += BASE64_ALPHABET.charAt(((b0 & 3) << 4) | (b1 >> 4));
    out += has1 ? BASE64_ALPHABET.charAt(((b1 & 15) << 2) | (b2 >> 6)) : '=';
    out += has2 ? BASE64_ALPHABET.charAt(b2 & 63) : '=';
  }
  return out;
}

// 严格标准 Base64：长度 4 的倍数、只允许标准字母表、
// 填充合法，且重新编码必须与原串完全一致（拒绝非规范 padding 位）。
function base64Decode(text) {
  if (typeof text !== 'string' || text.length === 0 ||
      text.length % 4 !== 0) {
    return null;
  }
  let pad = 0;
  if (text.charAt(text.length - 1) === '=') pad++;
  if (text.charAt(text.length - 2) === '=') pad++;
  const dataLength = text.length - pad;
  for (let i = 0; i < dataLength; i++) {
    if (BASE64_ALPHABET.indexOf(text.charAt(i)) === -1) return null;
  }
  for (let i = dataLength; i < text.length; i++) {
    if (text.charAt(i) !== '=') return null;
  }
  const outLength = (text.length / 4) * 3 - pad;
  const out = new Uint8Array(outLength);
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (let i = 0; i < dataLength; i++) {
    const value = BASE64_ALPHABET.indexOf(text.charAt(i));
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index] = (buffer >> bits) & 255;
      index++;
      buffer &= (1 << bits) - 1;
    }
  }
  if (index !== outLength) return null;
  if (base64Encode(out) !== text) return null;
  return out;
}

function looksLikeCertSha256(value) {
  return /^[0-9a-fA-F]{64}$/.test(value);
}

function looksLikePhoneAppId(value) {
  return /^[0-9]{10,32}$/.test(value);
}

export function validateWatchLiteFingerprint(value, bundleName) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0) {
    return { ok: false, code: 'empty', kind: WATCH_LITE_KIND,
      message: 'WATCH_PEER 未配置：GT 4 Lite 需要 ' + bundleName +
        '_Base64(签名证书中的原始 EC 公钥点)' };
  }
  const prefix = bundleName + '_';
  if (raw.indexOf(prefix) !== 0) {
    let hint = '必须以 ' + prefix + ' 开头';
    if (looksLikeCertSha256(raw)) {
      hint = '检测到 64 位证书 SHA-256；GT 4 Lite 需要 ' + prefix +
        'Base64(原始 EC 公钥点)，不能使用证书摘要';
    } else if (looksLikePhoneAppId(raw)) {
      hint = '检测到 APP ID；手机→手表的 remoteApp 必须使用 Lite 公钥指纹';
    }
    return { ok: false, code: 'lite-prefix', kind: WATCH_LITE_KIND,
      message: 'WATCH_PEER 格式错误：' + hint };
  }
  const suffix = raw.substring(prefix.length);
  const point = base64Decode(suffix);
  if (point === null) {
    return { ok: false, code: 'lite-base64', kind: WATCH_LITE_KIND,
      message: 'WATCH_PEER 格式错误：' + prefix +
        ' 后必须是标准 Base64；不能把公钥十六进制文本或整张证书 DER/SPKI ' +
        '直接 Base64' };
  }
  if (EC_POINT_LENGTHS.indexOf(point.length) === -1) {
    return { ok: false, code: 'lite-point-length', kind: WATCH_LITE_KIND,
      message: 'WATCH_PEER 格式错误：Base64 解码后是 ' + point.length +
        ' 字节，不是未压缩 EC 公钥点（应为 65/97/133 字节）' };
  }
  if (point[0] !== 4) {
    return { ok: false, code: 'lite-point-prefix', kind: WATCH_LITE_KIND,
      message: 'WATCH_PEER 格式错误：EC 公钥点首字节必须是 0x04（未压缩点），' +
        '实际是 0x' + point[0].toString(16) };
  }
  return { ok: true, code: 'ok', kind: WATCH_LITE_KIND,
    value: raw, pointLength: point.length };
}

export function validatePhoneAppId(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0) {
    return { ok: false, code: 'empty', kind: PHONE_APP_ID_KIND,
      message: 'PHONE_SELF 未配置：手表登记手机身份需要 AGC 手机 APP ID' };
  }
  if (!/^[0-9]{10,32}$/.test(raw)) {
    let hint = '应为 bundle-info.app-identifier（10–32 位数字）';
    if (looksLikeCertSha256(raw)) {
      hint = '检测到证书 SHA-256；HarmonyOS 5.0+ 手机原生应用应使用 APP ID';
    } else if (raw.indexOf('_') !== -1) {
      hint = '检测到 Lite 公钥指纹；APP ID 与 Lite 指纹方向不同，不能混用';
    }
    return { ok: false, code: 'appid-format', kind: PHONE_APP_ID_KIND,
      message: 'PHONE_SELF 格式错误：' + hint };
  }
  return { ok: true, code: 'ok', kind: PHONE_APP_ID_KIND, value: raw };
}

export function identityConfigured(value, kind) {
  if (kind === PHONE_APP_ID_KIND) {
    return validatePhoneAppId(value).ok;
  }
  if (kind === WATCH_LITE_KIND) {
    return validateWatchLiteFingerprint(value, 'con.xiwei.suyue.gt4').ok;
  }
  return false;
}

// 日志/UI 只展示可识别摘要，不改变原值。
export function describeIdentity(value, kind) {
  if (kind === WATCH_LITE_KIND) {
    if (!value) return '手表 Lite 公钥指纹未配置';
    const cut = value.indexOf('_');
    const prefix = cut >= 0 ? value.substring(0, cut + 1) : '';
    const suffix = cut >= 0 ? value.substring(cut + 1) : value;
    return prefix + suffix.substring(0, 12) + '…（' + suffix.length +
      ' 字符 Base64）';
  }
  if (!value) return '手机 APP ID 未配置';
  return 'APP ID ' + value.substring(0, 4) + '…' +
    value.substring(value.length - 4);
}
