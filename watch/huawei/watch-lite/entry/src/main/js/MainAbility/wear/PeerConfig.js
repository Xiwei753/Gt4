// SPDX-License-Identifier: GPL-3.0-only
// 手表侧双端身份配置（issue #13）。
//
// 手表需要知道的是「手机身份」（PHONE_*）：
//   - 手机是 HarmonyOS 5.0+ 原生应用，Wear Engine 用 **APP ID**
//     识别它（AGC bundle-info.app-identifier），不是证书 SHA-256；
//   - 用于 setPackageName/setFingerprint 门控消息来源；
//   - 用于 sendMsg 回执的目标包名。
// 手表自身是 Lite Wearable，手机侧用
// con.xiwei.suyue.gt4_Base64(原始 EC 公钥点) 识别，
// 这里只作自述引用。
//
// 手机 APP ID 由构建脚本从真实手机签名 profile 注入
// （PhonePeerConfig.g.js 构建前覆盖写入，构建后还原）；
// 未注入时为空，通信明确禁用。
import { INJECTED_PHONE_APP_ID }
  from './PhonePeerConfig.g.js';

export const PHONE_BUNDLE_NAME =
  'com.xiwei.suyue';
export const PHONE_APP_ID =
  INJECTED_PHONE_APP_ID;
// 注意：这里是 **con**.xiwei.suyue.gt4，不是 com。
// 这是 AGC 里手表应用**实际注册**的包名（当初录入时打错，已确认保留）：
// 华为的 bundleName 注册后不能改，而 HAP 的包名必须与 profile 授权的
// 包名逐字相同才能安装。别"顺手修正"成 com —— 一改就签不过、
// 也装不上（构建脚本的包名预检会直接拒绝签名）。
//
// 手表与手机是华为侧两个独立应用，Wear Engine 靠
// (包名, 对端 APP ID) 识别手机；手表对手机则用
// (con.xiwei.suyue.gt4, Lite 公钥指纹)。两者不能混用。
export const WATCH_BUNDLE_NAME =
  'con.xiwei.suyue.gt4';
