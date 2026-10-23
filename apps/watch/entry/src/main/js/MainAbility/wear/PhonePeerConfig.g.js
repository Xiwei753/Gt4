// SPDX-License-Identifier: GPL-3.0-only
// 构建注入占位：提交的是空值安全默认（issue #13）。
// 构建脚本从真实手机签名 profile 的
// bundle-info.app-identifier 覆盖写入 APP ID，
// 构建结束后还原。不得填写证书 SHA-256、
// OAuth Client ID 或 Lite 公钥指纹。
export const INJECTED_PHONE_APP_ID = '';
