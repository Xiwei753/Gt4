// SPDX-License-Identifier: GPL-3.0-only
// Wear Engine 适配层：版本检查、手机 APP ID 门控、
// 消息订阅；协议消息与文件通道路由到
// IncomingBookReceiver；旧式消息通道回执经
// wearengine.sendMsg 发回手机。
// Based on Wear Engine receiver call patterns from
// Explore in HMOS Wearable (MIT).
// Does not vendor the upstream Huawei SDK wrapper (Apache-2.0).
import wearengine from '@system.wearengine';
import { PHONE_BUNDLE_NAME, PHONE_APP_ID } from './PeerConfig';
import { IncomingBookReceiver } from './IncomingBookReceiver';
import { handleMessage as handleProgressMessage } from './ProgressSync';

let subscribed = false;
let receiver = null;
// 手表 → 手机的唯一回执通道（wearengine.sendMsg）。
var sendToPhoneImpl = null;
// 对端 deviceId。无回调字段时按 Lite Wear Engine 示例使用 'remote'；
// subscribeMsg 回调若提供 deviceId，则优先沿用该值。
var peerDeviceId = '';
var loggedRemoteDeviceDefault = false;

// 回调里可能携带 deviceId 的候选字段名（与文件引用一样逐一探测，
// 不合成、不猜测具体值）。真机抓到后应把命中的字段名固化下来。
var DEVICE_ID_FIELDS = ['deviceId', 'deviceID', 'srcDeviceId', 'srcDeviceID'];

export function capturePeerDevice(data) {
  if (!data) return '';
  for (var i = 0; i < DEVICE_ID_FIELDS.length; i++) {
    var value = data[DEVICE_ID_FIELDS[i]];
    if (typeof value === 'string' && value.length > 0) {
      peerDeviceId = value;
      return DEVICE_ID_FIELDS[i];
    }
  }
  return '';
}

export function beginReceive(onStatus) {
  const notify = (message) => {
    if (typeof onStatus === 'function') onStatus(message);
  };
  if (!PHONE_APP_ID) {
    notify('未配置手机 APP ID，传书接收暂未开启');
    return;
  }
  // 手表 → 手机：唯一回执通道。
  // 形状以华为 Lite 示例为准（待真机验证）：
  //   wearengine.sendMsg({deviceId, bundleName,
  //     abilityName, message, success, fail})
  const sendToPhone = (text) => {
    var deviceId = peerDeviceId;
    if (!deviceId) {
      // 记录回调没有提供 deviceId；按 Lite 示例使用 remote。
      if (!loggedRemoteDeviceDefault) {
        loggedRemoteDeviceDefault = true;
        console.info('subscribeMsg 未提供 deviceId，sendMsg 使用 Lite 示例值 remote');
      }
      deviceId = 'remote';
    }
    try {
      wearengine.sendMsg({
        deviceId: deviceId,
        bundleName: PHONE_BUNDLE_NAME,
        abilityName: '',
        message: text,
        success: () => {},
        fail: (data, code) => {
          console.error('sendMsg failed: ' + code);
        }
      });
    } catch (error) {
      console.error('sendMsg error: ' + error);
    }
  };
  sendToPhoneImpl = sendToPhone;
  try {
    wearengine.getWearEngineVersion({
      sdkVersion: '3',
      complete: (versionString) => {
        const raw = String(versionString || '').split('.');
        const version = Number(raw[raw.length - 1]) || 0;
        if (version < 401) {
          notify('Wear Engine 版本待适配：' + version);
          return;
        }
        wearengine.setPackageName({
          appName: PHONE_BUNDLE_NAME,
          complete: () => {
            console.info('setPackageName ok: ' + PHONE_BUNDLE_NAME);
            wearengine.setFingerprint({
              appName: PHONE_BUNDLE_NAME,
              appCert: PHONE_APP_ID,
              complete: () => {
                console.info('setFingerprint ok: peer=' +
                  PHONE_BUNDLE_NAME + ' appIdPrefix=' +
                  PHONE_APP_ID.substring(0, 4) + '…');
                receiver = new IncomingBookReceiver(
                  notify, sendToPhone);
                wearengine.subscribeMsg({
                  success: (data) => {
                    // 先尽力取真实 deviceId，供回执使用；
                    // 取到就记下命中的字段名，便于真机核对。
                    const idField = capturePeerDevice(data);
                    if (idField) {
                      console.info('peer deviceId via data.' + idField);
                    }
                    if (data && data.isRegister) {
                      subscribed = true;
                      console.info('subscribeMsg register ok: peer=' +
                        PHONE_BUNDLE_NAME);
                      notify('传书接收已开启');
                    } else if (data && data.isFileType) {
                      // 文件通道到达（P0-2）：字段名
                      // 以 GT4 Lite SDK 实测为准。候选
                      // 字段逐一取值，取到后记录来源；
                      // 全部缺失则不落盘、只报状态。
                      const ref = extractFileRef(data);
                      if (!ref) {
                        notify('文件通道回调缺少文件路径字段');
                      } else {
                        receiveFile(ref.uri, ref.field);
                      }
                    } else if (data && typeof data.message === 'string') {
                      routeMessage(data.message);
                    }
                  },
                  fail: (reason, code) => {
                    console.error('subscribeMsg failed code=' + code);
                    notify('接收注册失败：' + code);
                  }
                });
              },
              fail: (reason, code) => {
                console.error('setFingerprint failed code=' + code +
                  ' peer=' + PHONE_BUNDLE_NAME);
                notify('手机 APP ID 配置失败：' + code);
              }
            });
          },
          fail: (reason, code) => {
            console.error('setPackageName failed code=' + code +
              ' peer=' + PHONE_BUNDLE_NAME);
            notify('手机包名配置失败：' + code);
          }
        });
      }
    });
  } catch (error) {
    notify('Wear Engine 不可用：' + (error && error.message || 'unknown'));
  }
}

function routeMessage(messageText) {
  // 记录对端消息是否真正到达手表；类型解析失败也不阻断协议。
  var type = 'unknown';
  try {
    type = JSON.parse(messageText).type || 'unknown';
  } catch (e) {}
  console.info('Wear message received type=' + type);
  // 阅读进度是独立小消息，不进入传书状态机；仍复用同一次
  // subscribeMsg 和同一个 sendToPhone 通道。
  if (handleProgressMessage(messageText, sendToPhoneImpl)) return;
  if (!receiver) return;
  // 旧式消息通道 ACK/RESUME/RESULT 由接收器内部
  // 经统一响应通道（sendToPhone）回发；文件通道不等 RESULT。
  receiver.onMessage(messageText);
}

// 文件通道回调字段提取（P0-2）：
// 上游 Lite 示例在 isFileType 分支使用 data.file；
// 部分 SDK 版本可能使用 name/uri/filePath。
// 逐一探测，返回命中的字段名以便日志核对；
// 不猜测、不合成路径。
var FILE_REF_FIELDS = ['file', 'name', 'uri', 'filePath'];
export function extractFileRef(data) {
  if (!data) return null;
  for (var i = 0; i < FILE_REF_FIELDS.length; i++) {
    var field = FILE_REF_FIELDS[i];
    var value = data[field];
    if (typeof value === 'string' && value.length > 0) {
      return { uri: value, field: field };
    }
  }
  return null;
}

  // 文件通道：把 Wear Engine 送达的文件交给
  // IncomingBookReceiver 复制 → 校验 → 入库；
  // 手机不等待手表应用层 RESULT。
function receiveFile(filePath, field) {
  if (!receiver || !filePath) {
    return;
  }
  console.info('file channel ref via data.' + field);
  receiver.receiveFileChannel(filePath, null, (outcome) => {
    if (!outcome.ok) {
      console.error('file channel failed: ' +
        outcome.reason);
    }
  });
}

export function stopReceive() {
  receiver = null;
  sendToPhoneImpl = null;
  if (!subscribed) return;
  try {
    wearengine.unsubscribeMsg();
  } catch (error) {
    console.error('unsubscribeMsg failed: ' + error);
  }
  subscribed = false;
}
