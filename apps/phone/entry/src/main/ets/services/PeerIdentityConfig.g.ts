// SPDX-License-Identifier: GPL-3.0-only
// 构建注入占位：提交的是空值安全默认（issue #13）。
// 构建脚本从真实签名材料覆盖写入，构建结束后还原。
//   INJECTED_PHONE_APP_ID：手机 APP ID（AGC bundle-info.app-identifier）
//   INJECTED_WATCH_LITE_FINGERPRINT：
//     con.xiwei.suyue.gt4_Base64(手表签名证书原始 EC 公钥点)
// 不提交任何真实身份，也不提交“看起来像”的假值。
export const INJECTED_PHONE_APP_ID = '';
export const INJECTED_WATCH_LITE_FINGERPRINT = '';
