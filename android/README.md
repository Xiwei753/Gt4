# 素阅 · Android 传书 App（`android`）

议题 #3 交付物：在 **nova 7 Pro 等 Android / HMS 手机**上运行的原生 APK，
角色与 `harmony`（HarmonyOS NEXT）相同——都是「手机」端：
选择 TXT/EPUB → 解析、规范化 UTF-8 → 经 **官方 Android Wear Engine SDK**
发给 **HUAWEI WATCH GT 4 46 mm**。发送完成表示 `transferFile` 回调成功，
不代表手表已校验或入库。

> 一部 nova 7 Pro 同时安装：**Huawei Health** + **应用调测助手（DevEco Assistant）** + **素阅 APK**，
> 即可在不借助 Pocket 2 的情况下完成「选书 → 传书 → GT 4 确认」。

## 诚实边界（先看这段）

- 本工程已在本机 **真实 Gradle 编译出 APK**（`BUILD SUCCESSFUL`）。
  **但编译成功 ≠ 可安装到 nova ≠ 能与 GT 4 配对传书。**
- **Wear Engine 真机配对尚未验证**：需要 AppGallery Connect 应用、申请
  「Wear Engine 服务」权限、HMS Core 与 Huawei Health、GT 4 已配对、
  手表端素阅已安装并运行，以及**注册过的正式签名指纹**。
- 本仓库默认只出 **debug APK**：它用本机 Android 调试证书签名，该指纹
  **不是**手表端 `supportLists` / Wear Engine 认可的正式手机指纹，
  因此 **不能** 用它宣称配对成功（这正是议题里 P0 的风险点）。
- 本 App 复用 `protocol` v0，**不引入第三套协议**；不改手表书库格式。

## 目录结构

```text
android/
  settings.gradle.kts / build.gradle.kts / gradle.properties
  gradle/wrapper/…                     独立 Gradle（8.11.1）+ AGP 8.9.2
  gradlew / gradlew.bat
  app/
    build.gradle.kts                   applicationId = com.xiwei.suyue.android
    proguard-rules.pro                 保留 com.huawei.wearengine.** / com.huawei.hmf.**
    src/main/AndroidManifest.xml       仅 INTERNET/ACCESS_NETWORK_STATE；<queries> 华为健康/HMS
    src/main/res/…                     「素阅」中文界面、颜色、图标
    src/main/java/com/xiwei/suyue/
      MainActivity.kt                  单 Activity 界面（对齐 harmony 的 Index.ets）
      ui/BookRow.kt
      model/BookModels.kt              BookMeta/BookChapter/BookStatus/newBookId
      model/TransferModels.kt          TransferProgress/TargetDevice/超时常量/错误码
      storage/BookRepository.kt        沙箱 library.json + books/<bookId>.txt（原子写）
      importer/TextDecodeService.kt    BOM/UTF-8/GBK 编码识别
      importer/TxtImportService.kt     TXT 规范化 + SHA-256
      importer/ZipReader.kt            java.util.zip 解包（路径穿越/解压炸弹防护）
      importer/EpubImportService.kt    no-DRM EPUB → 章节
      importer/BookImportService.kt    选择 URI → 沙箱读写复核 → 登记
      wear/PeerIdentity.kt             包名 + 指纹读取 + 本机签名指纹
      wear/PeerIdentityConfig.kt       指纹注入占位（构建期注入，构建后还原）
      wear/WearEngineGateway.kt        官方 SDK 封装（权限/设备/ping/收发/监听）
      wear/BookTransferService.kt      协议 v0 发送状态机 + 文件回调结果处理
```

## 构建

### 本机

```bash
# 需 ANDROID_HOME（或 ANDROID_SDK_ROOT，或 android/local.properties）
tools/build_android_apk.sh debug     # → app/build/outputs/apk/debug/app-debug.apk
tools/build_android_apk.sh release   # 需签名环境变量，见下
```

脚本会校验：APK 是 ZIP 且 CRC 通过、`applicationId=com.xiwei.suyue.android`、
非零字节、**`apksigner` 退出码为 0 且签名有效**，并打印签名指纹与 `APK_OK …` 结论行。
**release 无正式签名会直接失败**（不会出现「未签名也 OK」）；debug 包可安装做界面/导入测试，
但结论行会标注 `wear_engine_authorized=no(debug:UI/import-only)`。**缺工具链会大声失败，不伪造成功。**

### 单元测试

```bash
cd android && ./gradlew :app:testDebugUnitTest
```

Gradle 单元测试覆盖：可发送状态（`SendPolicy`）和严格编码解码
（`TextDecodeService`，UTF-8/GBK/BOM/非法字节）。协议脚本
`tests/android-protocol.test.mjs` 静态核对文件发送完成边界。

### CI

`.github/workflows/android_apk.yml`（普通 GitHub 托管 runner，不占 #2 的自托管队列）：
无签名 Secrets 时构建 **debug APK** 并上传产物；有 Secrets 时构建 release 包。

## 签名与身份（P0）

| 角色 | 包名 | 说明 |
| --- | --- | --- |
| 手机（本 App） | `com.xiwei.suyue.android` | AGC 上为本 APK 登记的包名（`applicationId`）；**与 HarmonyOS 手机 `com.xiwei.suyue` 区分** |
| 手表（对端） | `con.xiwei.suyue.gt4` | 注意是 **`con`** 不是 `com`；`WATCH_BUNDLE_NAME` |

- **同包名 ≠ 同签名**。手表只认可某个**具体证书指纹**；本 App 要能配对，
  其 APK 的签名证书指纹必须与手表 `supportLists` / Wear Engine 登记的
  **`com.xiwei.suyue.android` 手机指纹**一致，且该指纹需在 AGC 完成 Wear Engine 注册。
- **正式签名（release）** 通过环境变量配置，**私钥/口令/keystore 绝不入库**
  （本仓库 `.gitignore` 已挡 `*.jks/*.keystore/*.apk`）：

  ```bash
  SUYUE_ANDROID_KEYSTORE_PATH=…  SUYUE_ANDROID_KEYSTORE_PASSWORD=…
  SUYUE_ANDROID_KEY_ALIAS=…      SUYUE_ANDROID_KEY_PASSWORD=…
  tools/build_android_apk.sh release
  ```

- **手表指纹注入**：`PeerIdentityConfig.kt` 里钉死 `INJECTED_WATCH_FINGERPRINT = ""`
  占位。构建时用 `SUYUE_ANDROID_WATCH_FINGERPRINT=…` 注入，**构建后自动还原**
  （和手机 HAP 侧 `tools/inject_signing.py` 同一思路）。未注入时空串生效，
  `PeerIdentity.isConfigured()=false`，界面**发送保持禁用**。
- 界面在设备列表下方显示**本机签名指纹**，供与手表登记指纹逐字比对（验收第 2 步）。
- 本 App **不使用** HarmonyOS HAP 的 `.p7b` profile，独立签名。

## 安装（nova 7 Pro）

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

- 首次启动授予「附近设备/蓝牙」相关权限。
- **不要把 debug APK 的配对结果当作成功**：debug 指纹不是正式登记指纹。

## Wear Engine 前置条件与配对流程

1. Huawei Health 已与 GT 4 配对；GT 4 上**素阅手表端已安装并处于运行状态**。
2. 手机装 HMS Core + Huawei Health。
3. AGC 应用已申请「Wear Engine 服务」并登记本 App 的正式签名指纹。
4. App 内：请求授权 → 列出手表（不默认第一台，必须手动选择）→ 发送。
5. 发送序列：`HELLO → BOOK_META → 可选 CHAPTERS 目录 → 文件通道正文`；
   `transferFile` 回调成功后只报告“文件已发送，手表侧校验/入库未确认”。
6. 取消：向手表发 `ERROR/E_CANCELLED`（Android SDK 无 `cancelFileTransfer`，
   不能中断已发出的文件流）。

### 常见错误码（`WearEngineErrorCode`）

| 码 | 含义 | 处理 |
| --- | --- | --- |
| `ERROR_CODE_COMM_SUCCESS` | 成功 | — |
| `ERROR_CODE_P2P_WATCH_APP_NOT_EXIT` | 手表端未安装素阅 | `E_PEER_UNAVAILABLE` |
| `ERROR_CODE_P2P_WATCH_APP_NOT_RUNNING` | 已安装未运行 | 请在 GT 4 上打开素阅 |
| `ERROR_CODE_DEVICE_IS_NOT_CONNECTED` | 设备未连接 | 检查配对/蓝牙 |
| 其他 | 见 `getErrorMsgFromCode` | 记入日志与界面 |

## 诊断日志

```bash
adb logcat -s suyue/Main suyue/Transfer suyue/WearEngine
```

界面「发送到 GT 4」卡片同时显示最近一次失败原因与错误码、本机签名指纹。

## 相关文档

- 工程状态 / 决策 / 分阶段验收：[docs/ANDROID_APK.md](../docs/ANDROID_APK.md)
- 协议：[protocol/README.md](../protocol/README.md)
- 手表安装与 #2 的关系：[docs/WATCH_INSTALL.md](../docs/WATCH_INSTALL.md)

## 授权

GPL-3.0-only。
