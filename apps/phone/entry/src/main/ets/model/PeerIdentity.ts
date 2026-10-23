// SPDX-License-Identifier: GPL-3.0-only
// 双端 Peer 身份配置。
//
// 两个身份的方向和格式不同，不能互相顶替：
//   PHONE_SELF：本应用（手机）身份，供手表验证“消息来自哪部手机”；
//   WATCH_PEER：对端 GT 4 Lite 身份，手机作为 remoteApp 发送与回执校验。
//
// 手机 → GT 4 的 WATCH_PEER 按华为 Lite Wearable 规则必须是：
//   con.xiwei.suyue.gt4_<Base64(签名证书原始未压缩 EC 公钥点)>
// 不是证书 SHA-256，也不是整张证书 / SPKI / 十六进制文本的 Base64。
// 合法值原样保留大小写与 + / =；空值、旧 hex64、错包名一律 fail closed。
//
// 注入路径：构建脚本生成 services/PeerIdentityConfig.g.ts（gitignore，
// 不提交），本地未生成时指纹为空 —— 空指纹明确禁用发送/接收。
export interface PeerIdentity {
  bundleName: string;
  // 原样保留大小写与 + / =；空 = 未配置。
  fingerprint: string;
}

export const PHONE_SELF: PeerIdentity = {
  bundleName: 'com.xiwei.suyue',
  fingerprint: ''
};

export const WATCH_PEER: PeerIdentity = {
  bundleName: 'con.xiwei.suyue.gt4',
  fingerprint: ''
};

// 未压缩 EC 公钥点：P-256 / P-384 / P-521。
const WATCH_POINT_LENGTHS: number[] = [65, 97, 133];

// Lite 指纹 = 真实手表包名 + '_' + 标准 Base64(未压缩 EC 公钥点)。
// 不缩写、不做通用“身份类型”抽象，只校验这一个方向需要的形状。
function isWatchLiteFingerprint(value: string, bundleName: string): boolean {
  const prefix = bundleName + '_';
  if (!value.startsWith(prefix)) return false;
  const payload = value.substring(prefix.length);
  if (payload.length === 0 || payload.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return false;
  let padding = 0;
  if (payload.endsWith('==')) {
    padding = 2;
  } else if (payload.endsWith('=')) {
    padding = 1;
  }
  // 由 Base64 长度反推原始字节数；只接受未压缩 EC 点。
  const pointLength = Math.floor((payload.length - padding) * 6 / 8);
  let knownLength = false;
  for (let i = 0; i < WATCH_POINT_LENGTHS.length; i++) {
    if (WATCH_POINT_LENGTHS[i] === pointLength) knownLength = true;
  }
  // 未压缩点首字节 0x04，Base64 首字符固定为 B。
  return knownLength && payload.charAt(0) === 'B';
}

// 注入入口：只允许写入对应身份，并按该方向的格式校验。
export function injectFingerprint(
  target: 'phone' | 'watch',
  fingerprint: string): void {
  const value = String(fingerprint || '').trim();
  if (target === 'phone') {
    // PHONE_SELF 方向仍按原有 64 位 hex 证书摘要规则，不与 Lite 指纹混用。
    const normalized = value.toLowerCase().replace(/[^0-9a-f]/g, '');
    if (normalized.length === 0) {
      throw new Error('PHONE_SELF fingerprint is empty');
    }
    if (normalized.length !== 64) {
      throw new Error('PHONE_SELF fingerprint must be 64 hex chars, got ' +
        normalized.length);
    }
    PHONE_SELF.fingerprint = normalized;
    return;
  }
  if (!isWatchLiteFingerprint(value, WATCH_PEER.bundleName)) {
    throw new Error('WATCH_PEER must be ' + WATCH_PEER.bundleName +
      '_<Base64(raw uncompressed EC point)>; ' +
      'a 64-hex certificate SHA-256 is not a Lite fingerprint');
  }
  // 不 lowerCase、不剔除非 hex 字符：Base64 的大小写与 + / = 必须完整保留。
  WATCH_PEER.fingerprint = value;
}

export function isConfigured(identity: PeerIdentity): boolean {
  if (!identity || identity.fingerprint.length === 0) return false;
  if (identity.bundleName === WATCH_PEER.bundleName) {
    return isWatchLiteFingerprint(
      identity.fingerprint, identity.bundleName);
  }
  return /^[0-9a-f]{64}$/.test(identity.fingerprint);
}
