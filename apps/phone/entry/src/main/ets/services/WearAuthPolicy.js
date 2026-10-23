// SPDX-License-Identifier: GPL-3.0-only
// Wear Engine 授权与设备发现的**纯逻辑**（issue #5 P0-A / P0-B）。
//
// 本模块不 import 任何 SDK，只根据 (stage, code, message) 与授权/发现
// 结果给出结构化分类和中文提示，因此 Node 可直接测试
//   node tests/wear_auth_policy.test.mjs
// 真实错误码由 WearDeviceService.ts 采集，UI 交互在 Index.ets。
//
// 原则：
//   - 只有官方文档 / SDK d.ts 里能确证的错误码才给专门解释；
//   - 其余一律保留原始 code，归入 api_error，绝不臆造原因；
//   - 不再把任何失败都压成 “Wear Engine 不可用 / E_PEER_UNAVAILABLE”；
//   - 「空列表」≠「未配对/蓝牙没连」，「运动健康在线」≠「Wear Engine 会返回」。

export const STAGE_TEXT = {
  auth_client: 'Wear Engine 客户端创建',
  auth_query: '授权状态查询',
  auth_request: '授权申请',
  device_client: 'Wear Engine 设备客户端创建',
  p2p_client: 'Wear Engine P2P 客户端创建',
  device_query: '设备发现'
};

export function stageText(stage) {
  return STAGE_TEXT[stage] || 'Wear Engine 调用';
}

// 原始 message 只截断、不改写，避免把长随机串/隐私整段带进 UI 与日志。
export function shorten(message) {
  if (typeof message !== 'string') return '';
  const t = message.trim();
  return t.length > 120 ? t.substring(0, 120) + '…' : t;
}

// 官方依据：本机 SDK d.ts @hms.health.wearEngine.d.ts 的 BusinessError 列表
//   1008500001  网络不可用
//   1008500002  未绑定设备
//   1008500003  设备已断开
//   1008500004  未申请 Wear Engine 服务（AGC 申请 + 审批）
//   1008500005  HUAWEI ID 未授权（所需权限未由用户授予）
//   1008500006  未同意隐私声明
//   1008500007  设备不支持该能力
//   1008500008  未登录 HUAWEI ID
//   1008500009  获取账号信息失败
//   1008509999  Internal error.（SDK 侧通用兜底码）
//   401         请求参数非法
// 关于 201：华为 request_user_authorization 文档示例里出现过 201，但本机 SDK
// d.ts 中 201 属于 P2pResultCode（REMOTE_APP_NOT_RUNNING，手表端应用未运行），
// 两者冲突、无法确证；因此不为 201 编造「未授权」结论，交由下方 api_error
// 原样保留 code（不丢失 (201) 信息）。
//
// 关于 1008509999（issue #6）：SDK d.ts 只把它写为 Internal error.，但实机
// hilog 已确证在设备发现路径上它由「应用元数据缺少 client ID」触发：
//   com.huawei.hmos.health.core/WearEngineImpl: registerCallback err:
//     {"code":1008509999,"message":"The client ID is not configured in the
//      metadata of the application."}
// SDK 会把这条底层 message 折叠掉，只回 Internal error.；因此必须结合
// 实机日志证据，把它专门解释为**应用身份配置错误**，而不是「设备未找到」
// 或「用户没开蓝牙/权限」。这是确定性配置错误，用户重开权限、解除配对都
// 无用，只能由开发者修包（补 client_id 元数据后重装）。
export function describeWearError(stage, code, message) {
  const n = typeof code === 'number' ? code : 0;
  // 1008509999 在设备发现/授权查询路径上已由实机日志确证是 client ID
  // 缺失；但客户端**创建**阶段（getXxxClient 同步抛错）只是 SDK 的通用
  // Internal error，不能武断归因，必须保留阶段文案（issue #5 P0-2a/P0-2d）。
  if (n === 1008509999 && stage !== 'device_client' &&
      stage !== 'p2p_client' && stage !== 'auth_client') {
    return { stage: stage, code: n, kind: 'app_client_id_not_configured',
      text: '应用身份配置错误（Wear Engine 1008509999）：' +
        '安装包缺少应用级 Client ID 元数据，请更新素阅安装包；' +
        '重开蓝牙/权限、重新配对均无效' };
  }
  if (n === 1008500001) {
    return { stage: stage, code: n, kind: 'network_error',
      text: '网络不可用（1008500001），请检查网络后重试' };
  }
  if (n === 1008500002) {
    return { stage: stage, code: n, kind: 'no_device_bound',
      text: '未绑定设备（1008500002），请先在运动健康里完成 GT 4 配对' };
  }
  if (n === 1008500003) {
    return { stage: stage, code: n, kind: 'device_disconnected',
      text: '设备已断开（1008500003），请确认手表与手机蓝牙已连接' };
  }
  if (n === 1008500004) {
    return { stage: stage, code: n, kind: 'service_not_applied',
      text: 'Wear Engine 服务未开通或未审批（1008500004），' +
        '请先在华为侧申请/审批后再试' };
  }
  if (n === 1008500005) {
    return { stage: stage, code: n, kind: 'not_authorized',
      text: '华为账号未授权该数据权限（1008500005）；本应用传书无需该权限，' +
        '如出现请检查华为侧授权' };
  }
  if (n === 1008500006) {
    return { stage: stage, code: n, kind: 'privacy_not_agreed',
      text: '未同意隐私声明（1008500006），请在授权页同意后重试' };
  }
  if (n === 1008500007) {
    return { stage: stage, code: n, kind: 'device_unsupported',
      text: '设备不支持该能力（1008500007）' };
  }
  if (n === 1008500008) {
    return { stage: stage, code: n, kind: 'account_not_logged_in',
      text: '未登录 HUAWEI ID（1008500008），请先在手机登录华为账号' };
  }
  if (n === 1008500009) {
    return { stage: stage, code: n, kind: 'account_error',
      text: '获取账号信息失败（1008500009），请稍后重试' };
  }
  if (n === 401) {
    return { stage: stage, code: n, kind: 'param_invalid',
      text: '请求参数非法（401）' };
  }
  const tail = shorten(message);
  return { stage: stage, code: n, kind: 'api_error',
    text: stageText(stage) + '失败（' + n + '）' + (tail ? '：' + tail : '') };
}

// 授权状态提示。auth: { ok, granted, stage, code, message }。
export function authNotice(auth) {
  if (!auth) {
    return { kind: 'unknown', code: 0,
      text: '尚未检查 Wear Engine 授权状态' };
  }
  if (auth.ok === true && auth.granted === true) {
    return { kind: 'ok', code: 0, text: 'Wear Engine 已授权' };
  }
  if (auth.ok === true && auth.granted !== true) {
    return { kind: 'not_authorized', code: 0,
      text: '尚未授权手表数据权限（本应用传书无需，如出现请检查华为侧授权）' };
  }
  return describeWearError(auth.stage, auth.code, auth.message);
}

// 设备发现提示。result: { ok, devices, stage, code, message }。
export function deviceNotice(result) {
  if (!result) {
    return { kind: 'unknown', code: 0, text: '尚未发现设备' };
  }
  if (result.ok === true && result.devices && result.devices.length > 0) {
    return { kind: 'ok', code: 0,
      text: '发现 ' + result.devices.length + ' 台已连接设备，请选择目标' };
  }
  if (result.ok === true) {
    return { kind: 'empty', code: 0,
      text: 'Wear Engine 未返回可用设备（请确认手表已配对、蓝牙在线，' +
        '且运动健康已连接；空列表不等于未配对）' };
  }
  return describeWearError(result.stage, result.code, result.message);
}

// ---- 设备发现的自动重试策略（issue #6 P0-B）----
//
// 目标：确定性失败（应用身份未配置、服务未审批、用户拒绝授权、设备不支持、
// 参数非法、未绑定设备等）**立即停止自动重试**，只由用户手动刷新；
// 只有可恢复的短暂断连/网络错误才允许少量、有上限、带退避的重试，
// 绝不做亚秒级连续轰炸。
export const MAX_AUTO_RETRIES = 3;

// 可恢复、允许有限自动重试的错误类别。
export const RETRYABLE_KINDS = ['network_error', 'device_disconnected'];

// 退避间隔（毫秒）：第 1/2/3 次重试前分别等待。全部 >= 1s，
// 不允许亚秒级连发。
export const RETRY_BACKOFF_MS = [1000, 2000, 4000];

// 某错误类别是否允许自动重试。
export function isRetryable(kind) {
  return RETRYABLE_KINDS.indexOf(kind) !== -1;
}

// 根据「已自动重试次数 attempt」与本次失败类别，给出下一次动作。
// 返回 { retry, delayMs, attempt, reason }：
//   - retry=false 表示必须由用户手动刷新；
//   - probe 为 { ok:true } 或发现成功/空列表时不重试（交回 UI）。
export function planRetry(attempt, notice) {
  const used = typeof attempt === 'number' && attempt > 0 ? attempt : 0;
  if (!notice || notice.ok === true) {
    return { retry: false, delayMs: 0, attempt: used,
      reason: 'nothing_to_retry' };
  }
  if (!isRetryable(notice.kind)) {
    return { retry: false, delayMs: 0, attempt: used,
      reason: 'non_retryable:' + (notice.kind || 'unknown') };
  }
  if (used >= MAX_AUTO_RETRIES) {
    return { retry: false, delayMs: 0, attempt: used,
      reason: 'max_attempts' };
  }
  return { retry: true, delayMs: RETRY_BACKOFF_MS[used], attempt: used + 1,
    reason: 'transient' };
}

// ---- 一轮设备刷新的纯异步流程（issue #5 第二轮 P0-2b / P0-3）----
// 页面通过 deps 注入：start()（开启一轮并返回序号，同时置“进行中”）、
// isCurrent(seq)（该轮是否仍是最新）、listDevices()（可能 throw）、
// apply(result)（落地结果）、end()（复位“进行中”）。
// 保证：无论成功、异常还是被更新的一轮取代，只要该轮仍是当前轮次，
// “进行中”标志都一定会被复位（配合页面的 try/finally 语义）。
export async function runDeviceRefresh(deps) {
  const seq = deps.start();
  try {
    const result = await deps.listDevices();
    if (!deps.isCurrent(seq)) return { superseded: true };
    deps.apply(result);
    return { superseded: false, result: result };
  } finally {
    if (deps.isCurrent(seq)) deps.end();
  }
}
