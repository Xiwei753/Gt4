# Wear Engine 应用级 Client ID 配置（issue #6）

> 本文说明素阅鸿蒙手机端为什么必须配置应用级 Client ID、值从哪里取、
> 放在哪里，以及构建期如何校验。**不涉及用户手机权限设置**。

## 现象与根因

Pocket 2（HarmonyOS 7）实机 hilog 已确证：

```text
com.xiwei.suyue/DeviceClientImpl: Start to getConnectedDevices.
com.huawei.hmos.health.core/WearEngineImpl:
  registerCallback err: {"code":1008509999,
    "message":"The client ID is not configured in the metadata of the application."},
  service:DeviceManager,method:getConnectedDevices
com.xiwei.suyue/suyue/WearDeviceService:
  getConnectedDevices failed: code=1008509999 message=Internal error.
```

Wear Engine 服务连接成功，但华为侧在读取设备列表**之前**发现应用元数据里
没有应用级 Client ID，于是以 `1008509999` 拒绝；SDK 只把底层 message 折叠成
`Internal error.` 回给应用。

**这不是蓝牙/位置权限问题，也不是 GT 4 未配对。** 它只能由开发者修包
（补元数据后重新安装），用户重开权限、解除配对都无效。

## Client ID 从哪里取（当前 AGC）

1. 登录 [AppGallery Connect](https://developer.huawei.com/consumer/cn/service/josp/agc/index.html)。
2. 在「开发与服务」里选择**鸿蒙手机应用** `com.xiwei.suyue`。
3. 打开「**项目设置 > 常规 > 应用**」，取其中的 **Client ID**。

要区分三个容易混淆的值：

| 名称 | 是什么 | 用途 |
| --- | --- | --- |
| **应用级 Client ID** | AGC「项目设置 > 常规 > 应用」里的字符串 | ✅ 唯一要写进 `client_id` 元数据的值 |
| APP ID | AGC 应用标识 | ❌ 不是 Client ID |
| 项目级 Client ID | 项目设置里的项目标识 | ❌ 不是应用级 |

也不要填手表 UUID、随机构造串或示例值。**手表与手机在华为侧是两个独立应用**：
这里填的是鸿蒙手机 APP `com.xiwei.suyue` 的身份，与手表
`con.xiwei.suyue.gt4` 无关，禁止因此擅改手表包名。

> issue #13 补充：Wear Engine 手机原生身份使用 **APP ID**
> （profile 的 `bundle-info.app-identifier`），语义上仍不等于 Client ID。
> 本项目本地 profile 中两者数值恰好相同，但构建脚本必须从 profile 的
> `app-identifier` 取值，不能拿 Client ID、证书 SHA-256 或包名顶替。

官方依据：
[Health Service Kit 配置 Client ID](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-configuration-client-id)。

## 放在哪里

`apps/phone/entry/src/main/module.json5` 的 `module.metadata` 数组：

```json
"metadata": [
  {
    "name": "client_id",
    "value": "CONFIGURE_WITH_AGC_CLIENT_ID"
  }
]
```

- 名称必须是**小写** `client_id`，大小写不符无效。
- 必须位于 `module` 级（不是 `app` 级、也不是 ability 级）。
- `module.json5` 里是**占位符**，不是真实值；真实值在构建期注入（见下节）。

## 真实值放在哪（不入库）

真实 Client ID 是该应用的唯一身份、会随 HAP 分发，**不进入 git 历史**。
把它写在一个被 `.gitignore` 忽略的本地文件里：

```text
signing/phone/client_id.env
    CLIENT_ID=<应用级 Client ID>
```

`tools/build_phone_hap.sh` 在打包前读取该文件（或环境变量
`SUYUE_CLIENT_ID`），调用 `tools/inject_client_id.py` 把源码里的占位符
`CONFIGURE_WITH_AGC_CLIENT_ID` 临时替换成真实值，构建与清单校验结束后
（`EXIT` trap）自动还原 `module.json5`。因此：

- 仓库里永远只有占位符，`git status` 保持干净；
- 没有该文件/环境变量时，构建**直接失败并提示**，不会静默打出占位符包。

## 构建期校验（源码有 ≠ 打包后有）

`tools/build_phone_hap.sh` 在产出最终 HAP 后，把注入后的 `client_id`
与**最终（含签名）HAP** 清单里的 `module.metadata` 逐值核对：

- 缺失条目、空值、仍是占位符、或与注入值不一致 → 构建**失败**
  （`METADATA_OK` 未出现）。
- 校验实现：`tests/build_artifact_check.sh --expect-metadata client_id=<值>`。
- 静态结构校验：`tests/source-contract.test.mjs` 断言源码保留占位符，
  并断言注入脚本守护该占位符。

这样不会打出「能安装、但一发现手表必报 1008509999」的包。

## 维护

- Client ID 属于**应用身份标识**；虽然会随 HAP 分发，但不应进入仓库与
  git 历史——请只放在被 gitignore 的 `signing/phone/client_id.env`。
- 换 AGC 应用/证书后，需重新确认应用级 Client ID 并更新
  `signing/phone/client_id.env`，再走一遍 `tools/build_phone_hap.sh` 的
  `METADATA_OK` 校验。
