# 素阅 · suyue

面向 **HUAWEI WATCH GT 4 46 mm（466 × 466 圆屏）** 的个人离线小说阅读器，以及配套的鸿蒙手机传书应用。

> 当前状态：**手表 Lite 工程已按新包名 `con.xiwei.suyue.gt4` 真实编译并签名成功**，但 **HDEA 只认单 BIN HAP**（旧的多文件 Release 包会在手机侧报「HAP 解压失败」）。Issue #4 已改为对 HAP 内唯一的 `*.bin` 执行 `sign-app -inForm bin` 签**内部 BIN**，再封回单 BIN HAP 并经早已打通的 HDEA 通道实测；本地构建产出 `entry-default-debug-signed.hap`（`SIGNED_TOOL_OK` / `HAP_PACKAGED_OK`；Lite 单 BIN 的 `verify-app` 属工具不支持的已知项，记为 `VERIFY_UNSUPPORTED_FOR_LITE_BIN`，**不是**验签通过）。**签名成功 ≠ 验签成功 ≠ GT4 安装成功**：GT 4 目前仍返回 `errorCode 10`（内部错误），**从未安装成功**；手机端 HAP 与双端真机互通也未验证。详见 [docs/WATCH_INSTALL.md](docs/WATCH_INSTALL.md)。

## 三个不同的运行环境

- **手表（`apps/watch`）**：HarmonyOS Lite Wearable 的 JS FA（HML/CSS/JS）。不能直接运行 Rust writer_core、ArkTS Stage HAP 或 Wear OS APK。
- **手机（`apps/phone`）**：HarmonyOS NEXT / ArkTS Stage（优先 Pocket 2）。手机适合做 TXT/EPUB 转换与书籍管理。
- **安卓手机（`apps/android`）**：在 nova 7 Pro 等 Android/HMS 手机上运行的原生 Kotlin APK，角色与 `apps/phone` 相同（同为「手机」），复用同一套 `shared/protocol` v0，用官方 Android Wear Engine SDK 传书给 GT 4。见 [apps/android/README.md](apps/android/README.md)。
- **`shared/protocol`**：双端约定的协议文档，非直接共享可执行的二进制核心。

## 已写入的源码

- 手表本地生成一份长中文测试书、按字节读取与估算分页、前后翻页和进度 JSON；未实机验证。
- 手表端多书书架：书籍索引（原子写+串行化+失败回滚）、每书独立进度与设置、纯 JS 流式 SHA-256 接收校验、按 bookId 阅读、删除确认、日间/夜间主题、字号/行距重排；接收协议按 `shared/protocol` v0 落地。
- 手表端接收双通道：消息通道（CHUNK 拼接 → 摘要 → 入库）与文件通道（Wear Engine 送达 → 复制入沙箱 → 大小+流式摘要校验 → 原子入库）；失败一律清理暂存、绝不入书架；RESULT/ACK/RESUME 经 `wearengine.sendMsg` 唯一通道回手机；单本在途互斥（并发传书回 `E_BUSY`）。
- 手表端**构建期内置书籍**（issue #10 复核后）：`WATCH_BOOKS_DIR=/绝对路径/我的书 tools/build_watch_lite.sh debug` 把顶层 TXT（UTF-8/GB18030/UTF-16 自动转 UTF-8、同内容去重）规范化后放进**内置 rawfile 资源** `resources/rawfile/gt4books/<bookId>.txt`，书单 `books/BookCatalog.g.js` **只含元数据**。此前把正文编译成 JS 数据模块会让阅读页 JS 达 2.1 MB、对应 GT4 安装报 **错误 34**；现正文在 rawfile、页面 JS 保持约 60 KB（构建打印 `WATCH_PAGE_JS`）。设备侧 `storage/BundledBookSource.js` 按需窗口读 rawfile，读不到再 `file.copy` 到私有目录读，都失败则显示真实接口名/错误码。私人正文被 gitignore、构建 `EXIT` trap 还原清理；产物经 `BOOKS_IN_BIN_OK` 校验内部单 BIN 真的带正文字节。**未验证**：GT4 能否读/复制 rawfile 只能真机判定。详见 [apps/watch/README.md](apps/watch/README.md)。
- 手机端实现 TXT/EPUB 导入：文档选择器 → 授权 URI 分块读取（32 MiB 上限）→ 编码识别/EPUB 解包 → 规范化 UTF-8 写入沙箱（摘要对规范化字节计算并写后复核）→ 书库索引；**尚未在 DevEco 编译或真机验证**。
- 双端身份分离：`PHONE_SELF`（手机 APP ID，手表 `supportLists` / `setFingerprint` 登记用）与 `WATCH_PEER`（GT 4 Lite `bundleName_Base64(签名证书原始 EC 公钥点)`，手机 `remoteApp` 用）；构建期从真实 profile/证书注入，空值或格式错误明确禁用发送；构建后核对最终 HAP 产物并验签。
- 手机端 Wear Engine 发送：设备发现、显式选择目标、`transferFile` 文件通道（句柄终态关闭）、每轮重试重新注册 RESULT waiter（上传/回执超时分离）、取消接 `cancelFileTransfer` 并通知手表清理；等待手表 RESULT 回执才认定入库；**Wear Engine 真机互通待验证**。应用级 Client ID 元数据（`module.metadata.client_id`，issue #6）已写入并在最终签名 HAP 中构建期校验（`METADATA_OK`）；设备发现对确定性错误（`1008509999`）不自动重试，仅在途串行 + 短暂错误有限退避（见 [WEAR_ENGINE_CLIENT_ID](docs/WEAR_ENGINE_CLIENT_ID.md)）。
- Wear Engine 消息接收入口在手机指纹尚未注入时停用；未完成真实传书。
- 手表首页启动重构（issue #10）：`onInit()` 先**同步**用编译期书单 `books/BookCatalog.g.js`（仅元数据）渲染书架，随后后台合并手机传书的外部书；**没有 books.json 也立刻显示（空）书架**，不再有「第 4 步读取 books.json 超时」。外部书失败或文件接口不回调只记 `E_EXTERNAL_*`，不阻塞、不删损坏索引。内置书不可删、手机书二次确认删除。移除手动「文件自检」入口与旧 books.json 初始化链（`prepareLibrary/readIndex/migrateDemo`）。`LibraryIndex` 仍保留耐久修复（分块 `readArrayBuffer`、区分 301 与真实错误、tmp 校验后安全替换并保留 `.bak`、队列看门狗），`BookStorage` 保留操作超时兜底。阅读页**打开即出正文**，进度后台加载（用户翻页前才应用）与**后台串行**保存，文件接口不回调也不锁死翻页（`ProgressStore` 加超时兜底）。回归 `tests/watch_shelf_startup.test.mjs`、`tests/watch_bundled_source.test.mjs`（**真机最终验证待做，暂不可关闭**）。
- 第三方示例借鉴、原作者 MIT 声明：[来源说明](docs/REFERENCES.md)、[版权说明](third_party/NOTICE.md)。
- Node 回归测试（分页/ZIP/协议/SHA-256/工具/接收逻辑/接收闭环/静态契约）可运行；**CI 通过不等于 HAP 构建成功，也不等于真机互通**。

## 目标流程

手机选择 TXT/EPUB → 手机解析、转换为 UTF-8 章节 → Wear Engine 传给 GT 4 → 手表核对并保存 → 圆屏离线阅读。

## 开发与构建

- 手表 Lite Wearable 与手机 Stage 必须分开编译、分开签名，不要混用构建工具链。
- 手表打包：`tools/build_watch_lite.sh` + `.github/workflows/watch_lite_hap.yml`（自托管 DevEco runner）。**本机已真实编译并签名成功**（release，215,323 字节，`signed=yes`）；签名材料按用途分放在 gitignore 掉的 `signing/shared|phone|watch/`，来源、包名（含 `con` 的来历）与包名预检见 [signing/README.md](signing/README.md)。CI 的那个 job 因没有自托管 runner 仍只会排队，排队不是绿灯。安装与待验证清单见 [docs/WATCH_INSTALL.md](docs/WATCH_INSTALL.md)。
- 手表端有一条必须知道的运行时限制：Lite 的 JerryScript **没有 RegExp**，正则字面量会让页面 `.bc` 快照静默生成失败（构建仍报成功、手表上却打不开）。实测范围与两道守门见 [apps/watch/README.md](apps/watch/README.md#lite-运行时限制本机实测issue-2)。
- 手机打包：`tools/build_phone_hap.sh` + `.github/workflows/phone_hap.yml`（自托管 DevEco runner；签名材料经 Secrets 注入）。**本机已真实编译并签名成功**（release，153,467 字节，`signed=yes`），并已通过 hdc 无线调试**装进 Pocket 2（LEM-AL00）实机启动**，界面正常渲染。**但双端传书本身仍未验证**（见下）。
- 首先验证 GT 4 46mm 支持哪组 Lite SDK/IDE + 签名 + DevEco Assistant 安装流程，才配置真正能产生 signed HAP 的 CI。
- 手机端可借鉴已有鸿蒙 NEXT CLI 构建流程，**但需要独立应用证书和本项目构建配置**；素笺的打包脚本不能原封不动使用。
- 详细状态、环境差异和验收清单见 [开发与安装路线](docs/BUILD_AND_TRANSFER.md)。
- 当前已完成手表端的真实 DevEco 编译；手机端与两端设备验证仍未进行。

## 项目目录

```text
apps/watch/       Lite Wearable 手表应用
apps/phone/       ArkTS Stage 手机应用（HarmonyOS NEXT）
apps/android/     原生 Kotlin 安卓 APK（nova 7 Pro，同「手机」角色）
shared/protocol/  双端通信协议草案
docs/             架构、参考项目、构建说明
third_party/      MIT 原作者声明和许可证
tests/            与系统 SDK 无关的静态检查/分页测试
```

## 名称和包名

产品名称为「素阅」，仓库名为 `suyue`。

- 手表 HAP 包名 = **`con.xiwei.suyue.gt4`**，手机 HAP 包名 = **`com.xiwei.suyue`**，
  在华为侧是**两个独立应用**。注意手表那个是 **`con`** 而不是 `com`——
  AGC 里注册时打错、已确认保留（bundleName 注册后不能改，且必须与
  profile 逐字一致才能安装；"顺手修正"会导致签不过、也装不上）。
- 手表的独立调试 Profile 已签发（授权包名 `con.xiwei.suyue.gt4`、
  授权设备含 GT 4 的 UDID）。**私钥与证书可复用**（证书是账号级的：
  手机与手表两张 profile 内嵌的 `development-certificate` DER-SHA256
  实测相同 `fbdee2e1…`），**只有 profile 是按应用签发的**。
- 手机 HAP 包名已按 AGC 证书对齐为 **`com.xiwei.suyue`**（证书里写定的名字），
  同步改了 `AppScope/app.json5`、手机端 `PeerIdentity.ets` 的 `PHONE_SELF`、
  手表侧作为对端的 `PeerConfig.PHONE_BUNDLE_NAME` 与 `config.json` 的
  `supportLists`、构建脚本与 CI 的 `--bundle`。
- 两个包名由 `tests/source-contract.test.mjs` 断言「互相一致且不相同」。
- 应用内部文件路径（`internal://app/gt4reader/...`）保持不变：改它会让
  已装设备上的阅读进度全部失联，收益为零。

## 安卓传书 App（`apps/android`）

议题 #3 面向 nova 7 Pro（Android/HMS）的「手机」端：一部手机同时装 Huawei Health、应用调测助手（DevEco Assistant）与素阅 APK，选择 TXT/EPUB → 经 Wear Engine 传给 GT 4 → 以 GT 4 回 `RESULT ok=true` 为入库成功。它是独立 Gradle 工程（`applicationId = com.xiwei.suyue.android`，AGC 登记的 Android 包名）、独立 APK 签名，**不使用** HAP 的 `.p7b` profile。

- 取/装 APK：`tools/build_android_apk.sh debug`（本机 Gradle + Android SDK，产物 `apps/android/app/build/outputs/apk/debug/app-debug.apk`）；或从 CI `android-apk` workflow 下载。安装：`adb install -r app-debug.apk`。
- 诚实边界：**APK 构建成功 ≠ 可安装成功 ≠ 能与 GT 4 配对传书**。debug 包用本机调试证书签名，其指纹不是手表端 `supportLists` / Wear Engine 认可的正式手机指纹；真机配对需要 AGC 注册的 keystore 与注入的手表指纹（见 [apps/android/README.md](apps/android/README.md)）。
- 诊断日志：`adb logcat -s Suyue`（导入/发送关键路径），界面「发送到 GT 4」卡片也会显示最近一次失败原因与错误码。
- 详细状态、身份/签名约束与真机验收步骤见 [docs/ANDROID_APK.md](docs/ANDROID_APK.md)。

## 授权

原创代码按 [GPL-3.0-only](LICENSE) 发布。借鉴的 MIT 源码片段保留原许可证及版权声明，详见 [REFERENCES](docs/REFERENCES.md)。
