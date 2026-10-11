// SPDX-License-Identifier: GPL-3.0-only
// Wear Engine 设备发现 / 授权 / 选择（issue #5）。
// 规则：
//   - 先查授权状态；未授权时由**用户主动**授权（不自动弹窗、
//     拒绝后不循环弹窗，只允许用户手动重试）；
//   - 不默认选择第一台设备，必须由用户确认目标；
//   - 设备身份只用 Wear Engine 返回的 randomId，不从 MAC/文件名拼出；
//   - 保留原始 BusinessError.code/message 与调用阶段，不再把一切
//     归为 E_PEER_UNAVAILABLE；分类/文案逻辑见 WearAuthPolicy.js
//     （纯逻辑，Node 可测）。
// API 形状以本机 SDK d.ts（@hms.health.wearEngine.d.ts）为准。
import { wearEngine } from '@kit.WearEngine';
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BusinessError, Callback } from '@kit.BasicServicesKit';
import { TargetDevice } from '../model/TransferModels';

const TAG = 'suyue/WearDeviceService';

// 授权查询/申请结果：ok=false 时携带真实 stage/code/message。
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

export class WearDeviceService {
  private deviceClient: wearEngine.DeviceClient;
  private p2pClient: wearEngine.P2pClient;
  private authClient: wearEngine.AuthClient | null = null;
  private authClientError: string = '';
  private context: Context;
  private messageRegistrations: Map<string, MessageRegistration> =
    new Map<string, MessageRegistration>();
  // issue #6 P0-B：同一时间只允许 1 个设备发现在途。
  // 并发/重复调用复用同一个 Promise，避免并发请求叠加。
  private deviceQueryInFlight: Promise<WearDeviceListResult> | null = null;

  constructor(context: common.UIAbilityContext) {
    this.context = context;
    this.deviceClient = wearEngine.getDeviceClient(context);
    this.p2pClient = wearEngine.getP2pClient(context);
  }

  // GT 4 场景所需的最小权限集合：设备标识（DEVICE_IDENTIFIER）。
  // 不申请心率/运动健康等无关权限；P2P 消息/文件通道本身
  // 不需要用户授予权限，只需服务已开通。
  requiredPermissions(): wearEngine.Permission[] {
    return [wearEngine.Permission.DEVICE_IDENTIFIER];
  }

  private ensureAuthClient(): wearEngine.AuthClient | null {
    if (this.authClient !== null) return this.authClient;
    try {
      this.authClient = wearEngine.getAuthClient(this.context);
      return this.authClient;
    } catch (error) {
      this.authClientError = messageOf(error as BusinessError);
      hilog.error(0x0000, TAG, 'getAuthClient failed: ' +
        JSON.stringify(error));
      return null;
    }
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
    const client = this.ensureAuthClient();
    if (client === null) {
      return { ok: false, granted: false, permissions: [],
        stage: 'auth_client', code: 0, message: this.authClientError };
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
      hilog.error(0x0000, TAG, 'getAuthorization failed: ' +
        JSON.stringify(error));
      return { ok: false, granted: false, permissions: [],
        stage: 'auth_query', code: codeOf(e), message: messageOf(e) };
    }
  }

  // 用户主动触发：请求最小权限集合。
  async requestAuthorization(): Promise<WearAuthResult> {
    const client = this.ensureAuthClient();
    if (client === null) {
      return { ok: false, granted: false, permissions: [],
        stage: 'auth_client', code: 0, message: this.authClientError };
    }
    try {
      const request: wearEngine.AuthorizationRequest = {
        permissions: this.requiredPermissions()
      };
      const resp = await client.requestAuthorization(request);
      const granted = this.grantedAll(resp.permissions);
      hilog.info(0x0000, TAG, 'requestAuthorization granted=' + granted);
      return { ok: true, granted: granted,
        permissions: resp.permissions, stage: 'auth_request',
        code: 0, message: '' };
    } catch (error) {
      const e = error as BusinessError;
      hilog.error(0x0000, TAG, 'requestAuthorization failed: ' +
        JSON.stringify(error));
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
    try {
      const devices = await this.deviceClient.getConnectedDevices();
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
      hilog.error(0x0000, TAG, 'listDevices failed: ' +
        JSON.stringify(error));
      return { ok: false, devices: [], stage: 'device_query',
        code: codeOf(e), message: messageOf(e) };
    }
  }

  // 目标手表上本应用是否已安装（发送前提）。
  async isRemoteAppInstalled(device: TargetDevice,
    bundleName: string): Promise<boolean> {
    try {
      return await this.p2pClient.isRemoteAppInstalled(
        device.randomId, bundleName);
    } catch (error) {
      hilog.error(0x0000, TAG, 'isRemoteAppInstalled failed: ' +
        JSON.stringify(error));
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
    const appInfo: wearEngine.AppInfo = {
      bundleName: bundleName,
      fingerprint: fingerprint
    };
    const appParam: wearEngine.P2pAppParam = {
      remoteApp: appInfo
    };
    // 切换到同一设备的新回调之前，先注销旧订阅，避免重复接收回执。
    await this.unregisterMessageReceiver(device);
    await this.p2pClient.registerMessageReceiver(
      device.randomId, appParam, callback);
    this.messageRegistrations.set(device.randomId,
      { appParam: appParam, callback: callback });
  }

  async unregisterMessageReceiver(
    device: TargetDevice): Promise<void> {
    const registered = this.messageRegistrations.get(device.randomId);
    if (!registered) return;
    try {
      await this.p2pClient.unregisterMessageReceiver(
        device.randomId, registered.appParam, registered.callback);
      this.messageRegistrations.delete(device.randomId);
    } catch (error) {
      hilog.warn(0x0000, TAG, 'unregister failed');
    }
  }
}
