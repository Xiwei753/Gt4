// SPDX-License-Identifier: GPL-3.0-only
// 双端 Peer 身份配置（issue #13）。
//
// 两个身份的方向和格式完全不同，不能互相顶替：
//   PHONE_SELF：手机自己是谁。给手表登记“消息来自哪部手机”用，
//     按华为 FAQ，HarmonyOS 5.0+ 手机原生应用使用 **APP ID**
//     （AGC bundle-info.app-identifier）。
//   WATCH_PEER：对端 GT 4 Lite 应用是谁。手机发送/注册 remoteApp 用，
//     必须使用 **bundleName_Base64(签名证书原始 EC 公钥点)**。
//
// 不能把 OAuth Client ID、证书 SHA-256、APP ID、Lite 公钥指纹
// 混为一谈；空值/格式错误一律 fail closed，发送保持禁用。
//
// 注入路径：构建脚本从真实签名材料生成
// services/PeerIdentityConfig.g.ts（gitignore，不提交）。
// 手机发送只需要 WATCH_PEER；PHONE_SELF 由手表侧登记手机时使用。
import { PHONE_APP_ID_KIND, WATCH_LITE_KIND,
  validatePhoneAppId, validateWatchLiteFingerprint } from './PeerIdentityPolicy';

export type FingerprintKind = 'phone-app-id' | 'watch-lite-pubkey';

export interface PeerIdentity {
  bundleName: string;
  // 原样保留大小写与 + / =；空 = 未配置。
  fingerprint: string;
  fingerprintKind: FingerprintKind;
}

export const PHONE_SELF: PeerIdentity = {
  bundleName: 'com.xiwei.suyue',
  fingerprint: '',
  fingerprintKind: PHONE_APP_ID_KIND as FingerprintKind
};

export const WATCH_PEER: PeerIdentity = {
  bundleName: 'con.xiwei.suyue.gt4',
  fingerprint: '',
  fingerprintKind: WATCH_LITE_KIND as FingerprintKind
};

// 构建注入入口：只允许写入对应身份，并按该身份的官方格式校验。
// 不 lowercase、不去掉非十六进制字符，合法 Lite 指纹原样保留。
export function injectFingerprint(
  target: 'phone' | 'watch',
  fingerprint: string): void {
  if (target === 'phone') {
    const result = validatePhoneAppId(fingerprint);
    if (!result.ok) {
      throw new Error('PHONE_SELF（手机 APP ID）无效：' + result.message);
    }
    PHONE_SELF.fingerprint = result.value;
    return;
  }
  const result = validateWatchLiteFingerprint(
    fingerprint, WATCH_PEER.bundleName);
  if (!result.ok) {
    throw new Error('WATCH_PEER（GT 4 Lite 公钥指纹）无效：' +
      result.message);
  }
  WATCH_PEER.fingerprint = result.value;
}

export function isConfigured(identity: PeerIdentity): boolean {
  if (!identity || identity.fingerprint.length === 0) return false;
  if (identity.fingerprintKind === 'phone-app-id') {
    return validatePhoneAppId(identity.fingerprint).ok;
  }
  return validateWatchLiteFingerprint(
    identity.fingerprint, identity.bundleName).ok;
}
