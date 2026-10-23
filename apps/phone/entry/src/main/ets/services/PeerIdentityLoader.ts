// SPDX-License-Identifier: GPL-3.0-only
// 手机端双端身份装配（issue #13）。
// 从构建生成的 PeerIdentityConfig.g.ts 读取真实值；
// 本地未生成时保持空（发送/接收明确禁用，不以假值混过）。
import { PHONE_SELF, WATCH_PEER,
  injectFingerprint } from '../model/PeerIdentity';
import { INJECTED_PHONE_APP_ID,
  INJECTED_WATCH_LITE_FINGERPRINT } from './PeerIdentityConfig.g';

// 返回身份配置错误摘要；空字符串表示没有注入值或全部有效。
// 某个身份无效不会阻断另一个身份的装配，但错误必须交给页面展示，
// 且 isConfigured() 会继续拒绝发送。
export function loadPeerIdentities(): string {
  const errors: string[] = [];
  if (INJECTED_PHONE_APP_ID.length > 0) {
    try {
      injectFingerprint('phone', INJECTED_PHONE_APP_ID);
    } catch (error) {
      errors.push((error as Error).message);
    }
  }
  if (INJECTED_WATCH_LITE_FINGERPRINT.length > 0) {
    try {
      injectFingerprint('watch', INJECTED_WATCH_LITE_FINGERPRINT);
    } catch (error) {
      errors.push((error as Error).message);
    }
  }
  return errors.join('；');
}

export { PHONE_SELF, WATCH_PEER };
