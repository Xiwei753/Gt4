// SPDX-License-Identifier: GPL-3.0-only
// Wear Engine 设备发现 / 选择（issue #5 第二轮修复）。
//
// 关键事实（以本机 SDK d.ts @hms.health.wearEngine.d.ts 与华为
// 「Wear Engine 开放能力」文档为准）：
//   - 获取已配对设备列表（getConnectedDevices）与 P2P 消息/文件通道
//     属于「设备基础信息」服务能力，只需在华为侧**申请并审批该服务**，
//     不需要用户在运行时授予任何数据权限；getConnectedDevices 抛出的
//     错误只有 1008500001/1008500004/1008500006/1008500008/1008500009/1008509999。
//   - 设备标识符（SN）数据权限只用于获取手表序列号
//     （getSerialNumber，受限能力，普通开发者不应为此申请），
//     与本应用传书无关，**不得**作为设备发现/传书的前置条件。
//     因此本服务不再申请任何用户权限（requiredPermissions() 返回空）。
//   - SDK 客户端在构造期可能同步抛错（getDeviceClient/getP2pClient），
//     构造器不得抛异常；客户端惰性创建并保留真实初始化错误。
//
// 规则：
//   - 不默认选择第一台设备，必须由用户确认目标；
//   - 设备身份只用 Wear Engine 返回的 randomId；
//   - 一律保留真实调用阶段与 BusinessError.code/message；
//   - 分类/文案逻辑见 WearAuthPolicy.js（纯逻辑，Node 可测）。
import { wearEngine } from '@kit.WearEngine';
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BusinessError, Callback } from '@kit.BasicServicesKit';
import { TargetDevice } from '../model/TransferModels';

const TAG = 'suyue/WearDeviceService';

// 授权查询/申请结果：ok=false 时携带真实 stage/code/message。
// 注意：传书本身不需要运行时权限，本接口保留供未来真正需要手表数据
// 权限（如读取序列号）时使用，当前不会成为设备发现/传书的前置条件。
export interface WearAuthResult {
  ok: boolean;
  granted: boolean;
  permissions: wearEngine.Permission[];
  stage: string;
  code: number;
  message: string;
}

// 设备发现结果：ok=false 时携带真实 stage/code/message；
// ok=true 且 devices 为空 = Wear Engine 未返回可用设备。
export interface WearDeviceListResult {
  ok: boolean;
  devices: TargetDevice[];
  stage: string;
  code: number;
  message: string;
}

// 客户端初始化失败：保留阶段与真实 code/message。
interface WearInitError {
  stage: string;
  code: number;
  message: string;
}

// 注销必须提供与注册时相同的 appParam 和 callback，不能只传设备 ID。
interface MessageRegistration {
  appParam: wearEngine.P2pAppParam;
  callback: Callback<wearEngine.P2pMessage>;
}

function codeOf(error: BusinessError): number {
  return error && typeof error.code === 'number' ? error.code : 0;
}

function messageOf(error: BusinessError): string {
  return error && typeof error.message === 'string' ? error.message : '';
}

// 统一日志：BusinessError 直接 JSON.stringify 常打印成 {}，
// 这里显式输出 code/message，保证阶段与真实错误可见（P0-2d）。
function logError(stage: string, error: BusinessError): void {
  hilog.error(0x0000, TAG, stage + ' failed: code=' + codeOf(error) +
    ' message=' + messageOf(error));
}

export class WearDeviceService {
  private context: Context;
  private deviceClient: wearEngine.DeviceClient | null = null;
  private p2pClient: wearEngine.P2pClient | null = null;
  private deviceClientError: WearInitError | null = null;
  private p2pClientError: WearInitError | null = null;
  private authClient: wearEngine.AuthClient | null = null;
  private authClientError: string = '';
  private authClientErrorCode: number = 0;
  private messageRegistrations: Map<string, MessageRegistration> =
    new Map<string, MessageRegistration>();
  // issue #6 P0-B：同一时间只允许 1 个设备发现在途。
  // 并发/重复调用复用同一个 Promise，避免并发请求叠加。
  private deviceQueryInFlight: Promise<WearDeviceListResult> | null = null;

  // 构造器只保存 context，不做任何可能同步抛出 SDK 调用（P0-2a）。
  constructor(context: common.UIAbilityContext) {
    this.context = context;
  }

  // 惰性创建设备客户端；失败保留真实 stage/code/message，且只尝试一次。
  private ensureDeviceClient(): wearEngine.DeviceClient | null {
    if (this.deviceClient !== null) return this.deviceClient;
    if (this.deviceClientError !== null) return null;
    try {
      this.deviceClient = wearEngine.getDeviceClient(this.context);
      return this.deviceClient;
    } catch (error) {
      const e = error as BusinessError;
      this.deviceClientError = {
        stage: 'device_client', code: codeOf(e), message: messageOf(e)
      };
      logError('getDeviceClient', e);
      return null;
    }
  }

  private ensureP2pClient(): wearEngine.P2pClient | null {
    if (this.p2pClient !== null) return this.p2pClient;
    if (this.p2pClientError !== null) return null;
    try {
      this.p2pClient = wearEngine.getP2pClient(this.context);
      return this.p2pClient;
    } catch (error) {
      const e = error as BusinessError;
      this.p2pClientError = {
        stage: 'p2p_client', code: codeOf(e), message: messageOf(e)
      };
      logError('getP2pClient', e);
      return null;
    }
  }

  private ensureAuthClient(): wearEngine.AuthClient | null {
    if (this.authClient !== null) return this.authClient;
    try {
      this.authClient = wearEngine.getAuthClient(this.context);
      return this.authClient;
    } catch (error) {
      const e = error as BusinessError;
      this.authClientError = messageOf(e);
      this.authClientErrorCode = codeOf(e);
      logError('getAuthClient', e);
      return null;
    }
  }

  // 传书（设备列表 + P2P）只需「设备基础信息」服务审批，无需运行时权限。
  // 未来若确实需要手表数据权限，在此显式列出并说明依据，
  // 不要为了“能编译”而随意申请敏感/受限的数据权限。
  requiredPermissions(): wearEngine.Permission[] {
    return [];
  }

  private grantedAll(permissions: wearEngine.Permission[]): boolean {
    const required = this.requiredPermissions();
    for (const p of required) {
      if (permissions.indexOf(p) === -1) return false;
    }
    return true;
  }

  // 查询授权状态（不触发弹窗）。
  async queryAuthorization(): Promise<WearAuthResult> {
    if (this.requiredPermissions().length === 0) {
      // 无运行时权限要求：视为已满足，不打扰用户。
      return { ok: true, granted: true, permissions: [],
        stage: 'auth_query', code: 0, message: '' };
    }
    const client = this.ensureAuthClient();
    if (client === null) {
      return { ok: false, granted: false, permissions: [],
        stage: 'auth_client', code: this.authClientErrorCode,
        message: this.authClientError };
    }
    try {
      const resp = await client.getAuthorization();
      const granted = this.grantedAll(resp.permissions);
      hilog.info(0x0000, TAG, 'authorization granted=' + granted +
        ' grantedCount=' + resp.permissions.length);
      return { ok: true, granted: granted,
        permissions: resp.permissions, stage: 'auth_query',
        code: 0, message: '' };
    } catch (error) {
      const e = error as BusinessError;
      logError('getAuthorization', e);
      return { ok: false, granted: false, permissions: [],
        stage: 'auth_query', code: codeOf(e), message: messageOf(e) };
    }
  }

  // 用户主动触发：请求最小权限集合。当前 requiredPermissions() 为空，
  // 不会调用 SDK，也不会弹窗（传书不需要运行时权限）。
  async requestAuthorization(): Promise<WearAuthResult> {
    const required = this.requiredPermissions();
    if (required.length === 0) {
      return { ok: true, granted: true, permissions: [],
        stage: 'auth_request', code: 0, message: '' };
    }
    const client = this.ensureAuthClient();
    if (client === null) {
      return { ok: false, granted: false, permissions: [],
        stage: 'auth_client', code: this.authClientErrorCode,
        message: this.authClientError };
    }
    try {
      const request: wearEngine.AuthorizationRequest = {
        permissions: required
      };
      const resp = await client.requestAuthorization(request);
      const granted = this.grantedAll(resp.permissions);
      hilog.info(0x0000, TAG, 'requestAuthorization granted=' + granted);
      return { ok: true, granted: granted,
        permissions: resp.permissions, stage: 'auth_request',
        code: 0, message: '' };
    } catch (error) {
      const e = error as BusinessError;
      logError('requestAuthorization', e);
      return { ok: false, granted: false, permissions: [],
        stage: 'auth_request', code: codeOf(e), message: messageOf(e) };
    }
  }

  // 已连接设备列表。ok=false 携带真实 stage/code/message；
  // ok=true 且 devices 为空表示 Wear Engine 未返回可用设备
  // （不等于“未配对/蓝牙没连”）。
  // issue #6 P0-B：同一时间只允许 1 个在途查询；已有查询时复用其结果，
  // 不再并发调用 getConnectedDevices（并发会放大错误风暴）。
  async listDevices(): Promise<WearDeviceListResult> {
    if (this.deviceQueryInFlight !== null) {
      return this.deviceQueryInFlight;
    }
    this.deviceQueryInFlight = this.queryDevices();
    try {
      return await this.deviceQueryInFlight;
    } finally {
      this.deviceQueryInFlight = null;
    }
  }

  private async queryDevices(): Promise<WearDeviceListResult> {
    const client = this.ensureDeviceClient();
    if (client === null) {
      const info = this.deviceClientError;
      return {
        ok: false, devices: [],
        stage: info !== null ? info.stage : 'device_client',
        code: info !== null ? info.code : 0,
        message: info !== null ? info.message : ''
      };
    }
    try {
      const devices = await client.getConnectedDevices();
      const out: TargetDevice[] = [];
      for (const d of devices) {
        out.push({
          randomId: d.randomId,
          name: d.name !== undefined ? d.name :
            'GT 4（' + d.randomId.substring(0, 6) + '…）'
        });
      }
      hilog.info(0x0000, TAG, 'connected devices: ' + out.length);
      return { ok: true, devices: out, stage: 'device_query',
        code: 0, message: '' };
    } catch (error) {
      const e = error as BusinessError;
      logError('getConnectedDevices', e);
      return { ok: false, devices: [], stage: 'device_query',
        code: codeOf(e), message: messageOf(e) };
    }
  }

  // 目标手表上本应用是否已安装（发送前提）。
  async isRemoteAppInstalled(device: TargetDevice,
    bundleName: string): Promise<boolean> {
    const client = this.ensureP2pClient();
    if (client === null) return false;
    try {
      return await client.isRemoteAppInstalled(
        device.randomId, bundleName);
    } catch (error) {
      logError('isRemoteAppInstalled', error as BusinessError);
      return false;
    }
  }

  // 注册手表 → 手机的消息接收（用于 RESULT 回执、
  // ACK、RESUME）。appParam 中的指纹必须与手表
  // supportLists 配置一致。
  async registerMessageReceiver(
    device: TargetDevice,
    bundleName: string,
    fingerprint: string,
    callback: Callback<wearEngine.P2pMessage>):
  Promise<void> {
    const client = this.ensureP2pClient();
    if (client === null) {
      const info = this.p2pClientError;
      throw new Error('P2P 客户端初始化失败' +
        (info !== null ? '（' + info.stage + ' code=' +
          info.code + '）' : ''));
    }
    const appInfo: wearEngine.AppInfo = {
      bundleName: bundleName,
      fingerprint: fingerprint
    };
    const appParam: wearEngine.P2pAppParam = {
      remoteApp: appInfo
    };
    // 切换到同一设备的新回调之前，先注销旧订阅，避免重复接收回执。
    await this.unregisterMessageReceiver(device);
    await client.registerMessageReceiver(
      device.randomId, appParam, callback);
    this.messageRegistrations.set(device.randomId,
      { appParam: appParam, callback: callback });
  }

  async unregisterMessageReceiver(
    device: TargetDevice): Promise<void> {
    const registered = this.messageRegistrations.get(device.randomId);
    if (!registered) return;
    const client = this.ensureP2pClient();
    if (client === null) return;
    try {
      await client.unregisterMessageReceiver(
        device.randomId, registered.appParam, registered.callback);
      this.messageRegistrations.delete(device.randomId);
    } catch (error) {
      hilog.warn(0x0000, TAG, 'unregister failed: code=' +
        codeOf(error as BusinessError));
    }
  }
}
