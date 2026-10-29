# 素阅：GT 4 / 鸿蒙手机开发、打包与安装路线

> 本文是开发路线，不是已执行的构建日志。当前没有签名 HAP，不能称为“可安装”或“实机验证通过”。

## 两个工程不能直接套一个流水线

| | 手表 GT 4 46mm | 手机 Pocket 2 |
| --- | --- | --- |
| 运行时 | Lite Wearable / JS FA，HML + CSS | HarmonyOS NEXT / ArkTS Stage |
| 项目入口 | `watch/huawei/watch-lite/entry/src/main/config.json` | `harmony/entry/src/main/module.json5` |
| 构建 | 需要匹配 Lite Wearable 的旧式/兼容 SDK、Hvigor Legacy 或对应 DevEco 环境 | 适配 Stage 的 Hvigor + 鸿蒙 CLI |
| 安装 | 需先验证开发者注册、签名和 DevEco Assistant/HDEA 手机中转安装路径 | HAP 可通过 hdc 安装到手机 |
| CI 状态 | 已建立 Lite HAP 打包 workflow（自托管 DevEco runner，未实际运行）；尚未产出任何 HAP | 手机 Stage HAP 已本机真实编译/签名/安装（issue #12）；自托管 CI 未实际运行 |

## 为什么不直接搬其他端内核

华为轻智能手表的 JS 运行环境与手机的 ArkTS/Native Rust 不同。素笺已有 Rust `writer_core` 偏向写作、章节和工程管理，用来做 GT 4 TXT 阅读既不能原样加载，也会带来不必要的代码和构建体积。

合理复用：TXT/EPUB 结构解析思路、书籍 ID/目录、分页/进度算法、手机传输层的错误处理策略。手表端只留轻量 JS 的文件读写、UTF-8 解码、文本排版和交互。

## GT 4 Lite HAP：应先解决的事情

工程结构已按 Lite Wearable 参考示例补齐（`signingConfig`、`strictMode`、`hvigor/hvigor-config.json5`、`entry/hvigorfile.ts`、`media/icon{,_small}.png`、`config.json` 的 `"$media:icon"`）。打包流程为 `tools/build_watch_lite.sh` + `.github/workflows/watch_lite_hap.yml`（自托管 `hmos-deveco` runner，签名材料经 Secrets 注入）。**目前尚未在任何环境实际运行该流程，未产出 HAP。**

1. 根据真实 GT 4 系统、开发者注册情况确定 Lite Wearable 对应 SDK 和 DevEco 环境，核对 `targetSdkVersion` / `compatibleSdkVersion` 是否适用于开发安装渠道。
2. 与 [Lite Wearable 大文本读取示例](https://github.com/Explore-In-HMOS-Wearable/sportwatch-how-to-read-large-text-files) 对齐工程格式，不混入 ArkTS Stage 插件。
3. 通过该环境在本机或可复现构建机生成 **Lite Wearable HAP**，确认真实文件名与哈希，再添加仅上传所需 HAP 的 CI artifact。
4. 核对开发者证书、设备与应用注册。社区 2026 年 [Lite Wearable 安装指南](https://github.com/justvladcreate/Guide-to-develop-Litewearables-2026) 在 GT3/API6 设备上使用 DevEco 3.1.1、较旧 SDK 和 HDEA；此指南明确未覆盖全部新表，**不能擅自当作 GT 4 的最终确定配置**。
5. HAP 经手机中转安装到 GT 4 前，应先确认 Pocket 2 上能否运行相应安装助手；不行时寻找实际兼容的安卓/鸿蒙旧手机做中转。
6. 实机验证中文、`readArrayBuffer` 的位置语义、本地进度恢复、圆屏 466×466 安全区域和表冠事件。

## 手机端实现顺序

1. `DocumentViewPicker` 获取 TXT/EPUB 的文件 URI（已实现选择）。
2. TXT：`TextDecodeService` 识别编码（BOM/UTF-8 校验/GBK 候选），
   `BookImportService` 复制进沙箱并规范化 UTF-8；GBK 解码可用性**待真机验证**。
   TXT 的正文章节标题（第…章/序章/番外/Chapter…）在规范化 UTF-8 字节上生成
   `chapters: [{title, offset, length}]`，与 EPUB 章节使用同一传输元数据；识别不到时
   整本作为单章「正文」（issue #17）。
3. EPUB：`ZipReader`（纯 JS inflate，含穿越/bomb/CRC 防护）+
   `EpubImportService` 按 OPF/spine 顺序清洗章节；仅无 DRM。
4. `BookRepository` 维护 `library.json` 索引，重启不丢书。
5. 用 [Wear Engine Kit 手机侧 ArkTS API](https://developer.huawei.com/consumer/cn/doc/doccenter-references/api/wearengine_api) 做设备发现与授权：`getAuthClient` → `getAuthorization` 查询、`requestAuthorization` 由用户显式授权（最小权限 `Permission.DEVICE_IDENTIFIER`），再 `getConnectedDevices` 发现设备；授权与发现各自失败阶段/错误码结构化上报（阶段 5，源码完成，真机待验证）。授权入口在素阅应用内，**不依赖**运动健康的授权入口。
6. 将书籍规范化、写入临时文件，调用手机侧 `P2pClient.transferFile`；也可使用 `sendMessage` 发送控制/ACK 消息。BOOK_META 的章节目录超过 Wear Engine 单条 JSON 消息 4096 字节时，Harmony/Android 两侧都会改发 `chapterChunks` + 多条 `CHAPTERS`，手表组装完整后再接收正文；正文通道不变。API 支持并不保证当前 GT 4 配对与签名权限已经打通。
7. 手表注册接收、校验大小/摘要，安全落盘并更新书架，成功后由手表回执，不能只凭手机侧回调就认定入库成功。

手机端打包：`tools/build_phone_hap.sh` + `.github/workflows/phone_hap.yml`
（自托管 `hmos-deveco` runner，签名材料经 Secrets 注入）。

本机实测（Local，非 CI）：Stage 工程此前**从未编译通过**（177 个 ArkTS
错误），现已修复并产出签名 HAP；并用 hdc 无线调试装进真机：

```text
hdc tconn <phone>:46857          -> Connect OK
hdc install -r <signed.hap>      -> install bundle successfully
设备：LEM-AL00（Pocket 2），API 26，7.0.0.109(SP6C00E105R6P2)
启动：aa start -a EntryAbility -b com.xiwei.suyue -> start ability successfully
```

启动后界面正常渲染（「素阅 / 手机书库 · 配套 GT 4 46mm」、
「导入书籍」「书架（0 本）」「发送到 GT 4」三张卡片）。
「发送到 GT 4」曾显示 `设备发现失败：Wear Engine 不可用`——这是 issue #5 之前的旧文案
（把「空列表 / 异常」一律当成「Wear Engine 不可用」）。现已改为：先显示 Wear Engine
**授权状态**并提供「授权手表访问」入口，未授权 / 被拒 / 未审批 / 空列表分别给出可区分
文案与错误码（`WearAuthPolicy.js` 分类）。

2026-10-23（issue #12）本地构建已从真实手表签名材料解析并注入指纹。
首次注入构建（已用 hdc 覆盖安装并启动）：

```text
source=signing/watch/debug.p7b (bundle-name=con.xiwei.suyue.gt4)
certificate DER-SHA256=fbdee2e1…a2701c1（完整值由本地证书计算）
WATCH_FINGERPRINT_INJECTED=yes
METADATA_OK client_id=<本地注入值>
COMPILED_STRING_OK entry=ets/modules.abc count=1
HAP=entry-default-debug-signed.hap size=317941 signed=yes
sha256=98775693a84d940474ac20c4a7fb7dc04b942e24ab41332d970a8e7b361dd34c
```

最终代码复核构建（仅本地；此后未再操作手机）：

```text
WATCH_FINGERPRINT_INJECTED=yes bundle=con.xiwei.suyue.gt4
METADATA_OK client_id=6917618613178762508
COMPILED_STRING_OK entry=ets/modules.abc count=1
HAP_OK ... size=317945 mode=debug signed=yes
sha256=09b3bd8a82f44d0ab3930a5b68536c3670025422d1964c7871fc297469c7abc6
```

两次构建走同一条“解析证书 → 注入 → 编译 → 签名 → 最终 HAP 校验”路径；
最终复核 HAP 未再次安装。截屏时手机正被用户使用，没有取得素阅界面
证据，因此**不能确认**「手表签名指纹未配置」提示已消失、回执监听已
继续；真机传书也没有拿到 GT 4 的 `RESULT ok=true`。
**双端互通仍未验证，issue #12 暂不可关闭。**

## 实施状态（auto-issue-1 分支）

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 1 | GT4 Lite 工程 + HAP 打包/CI | 本机已真实编译并签名（215,318 字节 `signed=yes`）；CI runner 仍缺；GT4 实机未装 |
| 2 | 手机 TXT/EPUB 导入沙箱 | 本机已真实编译并签名（153,467 字节 `signed=yes`），已装进 Pocket 2 实机启动；导入流程本身未在真机点过 |
| 3 | 传输协议 v0 + 示例 + 测试 | 完成；tests/protocol.test.mjs 通过 |
| 4 | 手表多书书架 + 接收校验 | 源码完成；SHA-256/接收逻辑 Node 互验；真机待验证 |
| 5 | 手机 Wear Engine 发送 | 授权(`getAuthClient`/`requestAuthorization`)+发现+结构化错误码已实现（issue #5）；真机互通待验证 |
| 6 | 圆屏阅读体验 | 源码完成；分页回归扩展通过；表冠明确不支持（待 SDK 核对） |
| 复核轮 | issue #1 第二轮施工单修复 | 源码完成；新增 tests/watch_receive.test.mjs 端到端互验；真机/HAP 仍待验证 |
| 复核轮 2 | issue #1 第三轮施工单修复 | 源码完成；新增 waiter/索引/注入三类失败回归；HAP 与真机仍阻断 |
| issue #5 | 手机 Wear Engine 授权 / 结构化错误码 | 源码完成；真机互通待验证 |
| issue #6 | Client ID 元数据 + 设备发现重试治理 | 源码完成；本机签名 HAP 校验 `METADATA_OK`；Pocket 2 复测待完成 |
| issue #12 | 本地 HAP 自动注入 GT4 证书指纹 | 构建/签名/安装完成，`COMPILED_STRING_OK`；该格式已被 issue #13 纠正，不能据此宣称互通 |
| issue #13 | 双端身份格式纠正（Lite 公钥 / 手机 APP ID） | 工具、构建、CI、测试完成；手机/手表签名 HAP 已产出，待真机重装验证 HELLO 206 |

### 第三轮修复明细（第二轮复核施工单）

**P0**
1. **Manifest 授权指纹**：`watch/huawei/watch-lite/entry/src/main/config.json`
   的 `supportLists` 构建期由 `tools/inject_signing.py`
   注入真实手机身份（issue #13 起为 APP ID；旧版为证书指纹，
   占位符缺失即 fail）；workflow
   构建后从 HAP 内清单再验证一次（`--expect-fingerprint`），
   清理步骤 `git checkout` 还原 config.json。只改 JS 不算
   系统级授权。
2. **文件与 BOOK_META 关联**：`WearReceiver.js` 的
   `extractFileRef` 逐字段探测（`file`/`name`/`uri`/
   `filePath`）并记录命中字段，缺字段不落盘；手表侧
   单本互斥（第二个不同 transferId 回 `E_BUSY`，同 id
   重发视为重启）；手机侧 `sendBook` 同样拒绝并发。
3. **RESULT waiter 生命周期**：新增纯逻辑
   `services/TransferWaiters.js`（Node 可测），每轮重试
   重新注册 waiter，上传超时与回执超时分离
   （`UPLOAD_TIMEOUT_MS` / `RESULT_TIMEOUT_MS`），所有
   异常/取消/超时统一清理计时器；迟到回执入缓存。
4. **索引回滚别名 Bug**：`LibraryIndex.js` 的快照改为
   深拷贝，写入构造新数组不原地修改；提交不假设
   `move` 可覆盖（失败则删除目标重试）；回滚后回读
   磁盘校验，失败上报 `E_ROLLBACK_*`。

**P1**
5. 演示书生成器（`storage/BookFiles.js`）已删除；空书库
   不再自动重造，只在旧 `demo.txt` 真实存在时迁移；迁移
   摘要读取失败时不写空摘要、不登记。
6. `tests/build_artifact_check.sh` 明确标注只做容器/清单
   检查、**不做证书签名验证**；手机 workflow 新增
   `hap-sign-tool verify-app` 验签步骤（工具缺失即失败）；
   手表 workflow 改为直接调用 `tools/build_watch_lite.sh debug`
   （见 `docs/WATCH_INSTALL.md`：Lite 单 BIN 的 `verify-app` 是
   工具不支持的已知项，降级为显式 WARNING，**不算验签通过**）。
7. 取消接通真实 SDK：`cancelFileTransfer(deviceRandomId,
   appParam, P2pFile)`（以华为指南为准，待真机验证）+
   向手表发 `ERROR code=E_CANCELLED`；手机界面新增
   「取消发送」按钮，取消后不得入库。
8. 大文件内存：保留 32 MiB 导入上限、文件通道流式
   校验；**SDK 回调签名与真机行为仍待实测**。
9. 双端身份格式按方向严格校验（issue #13）：手机→手表用
   Lite 公钥身份 `bundleName_Base64(raw EC point)`，手表→手机用
   手机 APP ID；不再使用“任意非空”或 64 位证书 SHA-256 兜底。

**仍阻断真机验收的环境**：自托管 `hmos-deveco` runner、
`WATCH_SIGNING_MATERIAL`/`PHONE_SIGNING_MATERIAL`
Secrets（含双端证书指纹与 `hap-sign-tool` 路径）、
GT 4 46mm 与 Pocket 2 真机、Wear Engine 文件通道回调
字段名（`data.file` vs `data.name`）与指纹格式真机核对。

### 第二轮修复明细（issue #1 复核施工单）

**P0（传书闭环）**
1. 双端身份分离：`harmony/.../model/PeerIdentity.ets`
   定义 `PHONE_SELF` 与 `WATCH_PEER`；指纹经 CI 生成
   `PeerIdentityConfig.g.ts` / 手表侧 `PhonePeerConfig.g.js`
   注入，空指纹明确禁用发送，不接受假值。
2. 手机 `remoteApp` 一律使用手表身份
   （现为 `con.xiwei.suyue.gt4`），而不是手机自己的包名
   `com.xiwei.suyue`。手表 Manifest、AGC App ID、手表 Profile 和手机的 WATCH_PEER 必须保持一致。
3. `BookMeta` 补 `chunks`/`chunkBytes`，导入时按
   64 KiB 消息通道分块描述填齐。
4. 摘要与 `bookId` 对**规范化后的正文字节**计算
   （原来误用原始 TXT/EPUB 字节），写入后回读复核
   字节数与摘要。
5. 手表文件通道真正落地：Wear Engine 送达文件 →
   `file.copy` 拷入本应用 `temp/<transferId>` →
   大小校验 → 流式 SHA-256（64 KiB 窗口）→ 原子入库
   → 失败删除暂存且不入书架。
6. 手表 RESULT/ACK/RESUME 全部经唯一响应通道
   `wearengine.sendMsg` 回手机；文件通道完成同样回
   RESULT；`tests/watch_receive.test.mjs` 验证
   BOOK_META → 落盘 → SHA256 → 书架登记 → RESULT
   全链路（Node 层面）。

**P1（传输/构建/数据可靠性）**
7. 两个 workflow：签名材料写入 `$RUNNER_TEMP` 跨
   step 持久（旧实现 `trap` 在本 step 末尾即删除，
   构建 step 读不到）；`tools/inject_signing.py` 生成
   真实 `signingConfigs` 并注入对端指纹；结束步骤
   `if: always()` 清理并 `git checkout` 还原。
8. `tests/build_artifact_check.sh` 升级为容器级检查：
   ZIP 魔数、`modules.json`/`config.json` 包名、
   设备类型、buildMode 与文件名匹配；构建脚本先
   `rm -rf entry/build`，按模式挑 HAP。
9. `transferFile` 句柄只在终态（错误/完成）关闭，
   进度回调不再关闭句柄。
10. RESULT waiter 在任何发送之前注册，迟到回执入
    有限缓存，`RESULT` 先于 `transferFile` 终态回调
    也不丢失。
11. 手机导入设 32 MiB 上限；手表侧摘要校验改为
    流式（`createSha256`/`createDigestVerifier`），
    峰值内存只有一个 64 KiB 窗口。
12. `LibraryIndex` 原子写（`books.json.tmp` → move）、
    写操作串行化、写失败回滚上一份索引并删除孤儿
    书籍文件。

**P2（阅读器与界面）**
13. 阅读器主操作行只保留「上页/设置/下页」，字号与
    主题收进二级展开行，不再互相挤占。
14. 旧演示书迁移条件化：仅当 `demo.txt` 确实存在且
    移动成功才登记，元数据为真实字节数与摘要；用户
    清空书库后绝不自动重造。
15. 表冠保持诚实的不支持声明，待 SDK 核对后做真机
    绑定。

**仍阻断真机验收的环境**：自托管 `hmos-deveco` runner、
`WATCH_SIGNING_MATERIAL`/`PHONE_SIGNING_MATERIAL`
Secrets、GT 4 46mm 与 Pocket 2 真机、Wear Engine
文件通道回调字段名（`data.file`）真机核对。手机侧证书
指纹的本地注入与 CI hex64 校验已实现（issue #12），但
自托管 runner 尚未实跑，真机 UI 与 `RESULT ok=true` 仍缺。

### issue #6 修复明细：Wear Engine Client ID 元数据 + 设备发现重试治理

**P0-A：应用身份元数据与打包校验**

1. `harmony/entry/src/main/module.json5` 的 `module.metadata` 新增
   `client_id`（应用级 Client ID），这是 Wear Engine 读取设备前必须的
   应用身份；缺失即报 `1008509999`。取值来源、与 APP ID / 项目级
   Client ID 的区别见 [WEAR_ENGINE_CLIENT_ID](WEAR_ENGINE_CLIENT_ID.md)。
   **真实值不入库**：源码只保留占位符 `CONFIGURE_WITH_AGC_CLIENT_ID`，
   构建期由 `tools/inject_client_id.py` 从被 gitignore 的
   `signing/phone/client_id.env`（或 `SUYUE_CLIENT_ID`）注入，构建/校验
   结束后自动还原，避免该身份值进入 git 历史。
2. 构建期硬校验：`tools/build_phone_hap.sh` 构建后从**最终（含签名）
   HAP** 的清单里核对 `module.metadata.client_id`（实现对
   `tests/build_artifact_check.sh --expect-metadata client_id=<值>`），
   缺项/空值/不一致一律失败；`tests/source-contract.test.mjs` 断言源码
   保留占位符、且注入脚本确实守护该占位符。

**P0-B：停止高频无限重试与并发请求**

3. `services/WearAuthPolicy.js` 把 `1008509999` 专列为
   `app_client_id_not_configured`（应用身份配置错误），文案明确指向
   「更新素阅安装包」，不再提示用户重开蓝牙/权限。
4. 新增纯逻辑重试状态机 `isRetryable` / `planRetry` / `RETRY_BACKOFF_MS`：
   只有 `network_error` / `device_disconnected` 允许自动重试，最多 3 次，
   退避 ≥1s（1/2/4s）；身份/服务/授权/参数等确定性失败**不自动重试**。
5. `services/WearDeviceService.ts`：设备发现加在途串行化
   （`deviceQueryInFlight`），同一时间最多 1 个 `getConnectedDevices`。
6. `pages/Index.ets`：`refreshDevices` 在途去重、重复点击不叠加；
   `try/finally` 复位 `deviceBusy`；`onPageHide`/`onDisappear`
   清理自动重试定时器并作废旧结果序号。

**P0-C：测试**

7. `tests/wear_auth_policy.test.mjs` 扩展：`1008509999` 分类、
   确定性失败不重试、短暂错误计数上限与退避单调性。

本机已实测：`tools/build_phone_hap.sh debug` 编译+签名成功
（`SIGNED_TOOL_OK` / `VERIFY_APP_OK`，313,463 字节），最终签名 HAP 的
清单校验输出 `METADATA_OK client_id=<本地注入值>`（真实值来自 gitignore 的
`signing/phone/client_id.env`，不写入本文件）。
**真机复测（Pocket 2 上 `getConnectedDevices` 不再报 `1008509999`）
仍待完成**，查到设备列表前不宣称已发现 GT 4。

### issue #13 修复明细：双端身份格式纠正（Lite 公钥 / 手机 APP ID）

**根因判断**：issue #12 把手表证书的 DER-SHA256 同时注入
`WATCH_PEER` 和手表 `supportLists`。华为 2026-09-20 FAQ 明确按
“被识别端”平台区分：

- HarmonyOS 5.0+ 手机原生应用 → **APP ID**
  （profile 的 `bundle-info.app-identifier`）；
- Lite Wearable 应用 → **`bundleName_Base64(原始 EC 公钥点)`**；
- Android / HarmonyOS 5.0 以前手机 → 证书 SHA-256。

因此 `206 COMMUNICATION_FAILURE` 不能只归因于指纹；但旧格式确实
不符合官方 Lite/手机原生身份规则，必须先纠正。

**修复**：

1. `PeerIdentityPolicy.js` 严格区分两种格式，不做 lowercase/
   去字符等破坏性规范化：Lite 值必须是
   `con.xiwei.suyue.gt4_<标准 Base64>`，解码后为 65/97/133 字节、
   首字节 `0x04` 的未压缩 EC 点；手机 APP ID 必须是 10–32 位数字。
   64 位证书 SHA-256、错误 bundle、APP ID 与 Lite 反用均 fail closed。
2. `tools/extract_watch_fingerprint.py --format lite` 从真实
   profile/证书提取公钥点并生成 Lite 身份；`--format sha256` 只保留
   为诊断。新增 `tools/extract_phone_app_id.py` 从手机 profile 读
   `app-identifier`。`tools/peer_identity_formats.py` 共用严格编解码。
3. `tools/build_phone_hap.sh` 注入
   `INJECTED_WATCH_LITE_FINGERPRINT`；`tools/build_watch_lite.sh`
   从手机 profile 注入 `PhonePeerConfig.g.js` 和
   `supportLists=com.xiwei.suyue:<APP ID>`，两处都在构建后恢复。
   `inject_signing.py` 支持 `lite|appid`、material-only 与
   `--allow-replace`。
4. 手机 `PeerIdentity.ts` / loader / Index 显示明确格式错误；
   手表 `WearReceiver.js` 改用手机 APP ID，并记录
   `setPackageName`/`setFingerprint`/`subscribeMsg` 注册结果、消息
   到达类型和原始失败码。协议、reader、书库、分页均未改。
5. CI `phone_hap.yml` 校验完整 Lite 值；`watch_lite_hap.yml` 从
   `PHONE_SIGNING_MATERIAL` 取 APP ID，并在最终 HAP 内层 BIN 复核
   `supportLists`。测试覆盖官方 Lite 示例、真实 P-256 leaf、P-384
   证书链、APP ID、错误方向和最终产物。

**本地验证**：真实材料得到 Lite 身份
`con.xiwei.suyue.gt4_BEWzvDkxDn4ueCkVNgwzqmrFXjhblq+CrbN+HUw4tLR5tMCz5ovAToeq9JX2WFzIO7SoU4YKrDY85m5QgsLEWok=`
（P-256 leaf；证书链中的 CA 证书为 P-384，不能误取 CA 公钥），
手机 APP ID `6917618613178762508`；证书 SHA-256
`fbdee2e…2701c1` 仅作诊断。修正日志后的本地签名 HAP：

```text
phone: entry-default-debug-signed.hap size=332399
       sha256=3385005048c014a4a154f2a39049125f5d98178854b55f0bf125fdbe8741662f
watch: entry-default-debug-signed.hap size=419960
       sha256=0a2083d32ea9b4796e9e32596bc37ebf5a30547930053ac21512eb7dbfb7f3ad
       inner BIN sha256=5f9336f47ecdbdafab7a93c417ea67f4994b25cb1b7faff5aad3467ed3e6de6b
       version=1000003/0.1.3
       supportLists=com.xiwei.suyue:6917618613178762508
```

**真机边界**：必须重新安装纠正后的手机 HAP 和手表 HAP；
当前没有 Pocket 2 → GT 4 的 `transferFile`/`RESULT ok=true` 证据，
也不知道纠正格式后 HELLO 是否仍为 206。若仍 206，按接收注册、
手表前台状态、蓝牙/权限逐项取证，不做盲重试。**issue #13 暂不可关闭。**

### issue #12 修复明细：本地 HAP 自动注入 GT 4 证书指纹（已被 issue #13 取代，保留历史记录）

**根因**：`PeerIdentityConfig.g.ts` 的
`INJECTED_WATCH_FINGERPRINT` 是仓库空占位；本地
`tools/build_phone_hap.sh` 只注入 Client ID，不解析手表证书，
所以构建出的 HAP 必然让 `isConfigured(WATCH_PEER)` 为 false，
界面显示「手表签名指纹未配置」并禁用发送。

**修复**：

1. 新增 `tools/extract_watch_fingerprint.py`：
   - 优先读 `signing/watch/*.p7b` 的
     `bundle-info.development-certificate`，并核对
     `bundle-name == con.xiwei.suyue.gt4`；
   - 也支持 PEM/DER 证书或证书链，取唯一终端证书
     （`CA:FALSE`）；有 profile 时要求链中唯一匹配。
     多候选无法确定直接失败，**不静默取第一张**；
   - 支持 `SUYUE_WATCH_FINGERPRINT` 显式值，并与材料交叉核对；
   - 只接受/输出小写、无冒号的 64 位 hex DER-SHA256；
     不取 HAP 文件哈希、公钥哈希、profile 文件哈希或随机值。
2. `tools/build_phone_hap.sh` 在 `assembleHap` **之前**解析并
   调用 `tools/inject_signing.py --fingerprint-value ... --fingerprint-format hex64`
   注入 `INJECTED_WATCH_FINGERPRINT`；与 Client ID 共用
   `restore_sources` EXIT trap，构建成功或失败都恢复源码占位。
   缺手表证书/profile、指纹非法、注入失败时在产出可安装 HAP 前失败。
3. `tests/build_artifact_check.sh` 新增
   `--expect-compiled-string`：只扫描最终 HAP 的
   `ets/modules.abc`（不扫可能回显源码的 `sourceMaps.map`），
   确认指纹真的进入 ArkTS 编译产物；同时保留
   `--expect-metadata client_id=...`。
4. CI `phone_hap.yml` 以 `--fingerprint-format hex64` 校验
   `fingerprints.watch`，并导出给构建脚本交叉核对；注释明确
   它必须是当前 GT4 HAP 的签名证书 DER-SHA256，不是手机 APK。
   两端复用同一张账号级证书时摘要相同是允许的，身份按
   `bundleName + fingerprint` 区分。
5. 回归测试：`tests/watch_fingerprint.test.mjs`
   （PEM/DER/证书链/ p7b/歧义/bundle/显式值）、
   `tests/phone-artifact-check.test.mjs`（ABC 正例、source map
   假阳性、缺 ABC、client_id）、`tests/inject_signing.test.mjs`
   （本地直注与互斥）、`tests/source-contract.test.mjs`
   （构建契约、trap、门禁）。

**边界**：issue #12 只解决了“手机 HAP 里没有手表证书指纹”的本地
构建阻断；其 SHA-256 格式已被 issue #13 纠正。当前手机
`WATCH_PEER` 使用 GT4 Lite 公钥身份，手表 `supportLists` /
`PhonePeerConfig.g.js` 使用手机 APP ID。Wear Engine 授权、发现、
重试和传输协议仍未改变；真机 UI 与传书结果仍未确认，不能把
“构建/安装成功”当成“传书打通”。

### issue #18 本机编译证据（阅读器 + 进度同步，未真机验收）

- 手机 debug HAP：`harmony/entry/build/default/outputs/default/entry-default-debug-signed.hap`，601,702 字节，`COMPILED_STRING_OK entry=ets/modules.abc count=1`、`HAP_OK ... single_bin=0 signed=yes`，SHA-256 `2fd771d6641703ecbeb714163430c78e2dc2e552e48169c53e00eab279fc9ac1`。新增 `pages/Reader`、`ReadingProgressStore`、`ReadingSyncService`、`ReaderSegments` 均进入 ArkTS 编译。
- 手表 Lite debug 单 BIN HAP：`watch/huawei/watch-lite/entry/build/default/outputs/default/entry-default-debug-signed.hap`，573,853 字节，SHA-256 `98acac51e4b17fa13b39befdda0071a65213b8e6e63c3c7e4a9c64a15f9bd370`；`LITE_BIN_SIGNED_OK`、`BIN_SHA256_MATCH`（内部 BIN 573,703 字节，SHA-256 `9520e8023fff52018384588e1867c0c4f55f940fe23c7d0da48646f383e33cd7`）、`WATCH_PAGE_JS page=index/index size=116777` / `reader/reader size=117091` 均生成；`ProgressSync.js` 出现在阅读页 source map 的 sources 列表中。Lite `verify-app` 仍为 `VERIFY_UNSUPPORTED_FOR_LITE_BIN`（0xBE 单 BIN 工具限制），**不是验签通过**。
- 章节识别：`node tests/chapter_detection.test.mjs`（18 组夹具 + 10k 章）、`node tests/prepare_watch_books.test.mjs`、`./gradlew :app:compileDebugKotlin --offline --no-daemon` 通过；跨端夹具覆盖紧排/全角/中文数字/装饰/站点前缀/前导目录/正文误判/CRLF/emoji/空文本。
- 同步与阅读器：`tests/watch_progress_sync.test.mjs`、`tests/reading_sync_policy.test.mjs`、`tests/phone_reader_sync.test.mjs`、`tests/text_window.test.mjs`、`tests/reader_segments.test.mjs` 通过；全部 `tests/*.test.mjs` **38/38** 通过。
- 评审修正：阅读位置改为约 256 字节可见段落粒度并保存/恢复段首字节；64 KiB 读取窗口按 UTF-8 边界截断，窗口切换不产生替换字符；待确认 APPLY 只在手表侧确认后推进基线，断连不会回滚手机新进度；延迟 APPLY 会先重读手机本地进度并做三方判定，不静默覆盖新进度；返回书架时同一设备触发一次节流同步；刷新设备列表保留用户选择；手表 APPLY 允许合法回退；冲突键在提示结束后 `finally` 释放；last-read 时间戳独立存 `suyue.last.at`。未改协议、章节引擎或数据库。剩余风险是设备端列表滚动/重排时序，真机验收仍未完成。
- **未做**：Pocket 2 真机阅读、GT 4 真机安装/阅读、双端 Wear Engine 进度同步、锁屏/后台/断连场景。**不得据此标记 issue #18 完成。**

## 现有源码不能直接认定兼容的地方

- `watch/huawei/watch-lite/build-profile.json5` 暂时采用轻智能手表示例的 `6.1.1(24)` 模板数值，但**没有确认为 GT 4 开发安装实际可用的版本**。
- HML 页面的几何大小和字号尚未经真机校准；UTF-8 分页是估算字宽，不是字体像素测量。
- `wear/WearReceiver.js` 的手机指纹经 CI 注入（`PhonePeerConfig.g.js`），未注入时停用消息接收；**系统级授权还需要 `config.json` 的 `supportLists` 同步注入**（workflow 已做，构建后从 HAP 内清单复验）。`wearengine.sendMsg` 的参数形状以华为 Lite 示例为准，**待真机验证**：其中
`deviceId` 的占位回退值 `'remote'` 已确认未经真机验证，实现会优先采用从
订阅回调里探测到的真实 `deviceId`，探测不到时回退并告警一次，
不静默把占位值当真值用。
- 手表文件通道依赖 Wear Engine 回调给出的文件路径字段：实现按 `file`/`name`/`uri`/`filePath` 逐字段探测并记录来源，**字段名待真机核对**。
- 手表单本在途互斥（`E_BUSY`）：并发传书会被拒绝，手机侧同样限制并发发送。
- 手机 `WATCH_PEER` 固定为 GT4 Lite 公钥身份（`bundleName_Base64(raw EC point)`，issue #13）；手表 `supportLists` / `PhonePeerConfig.g.js` 固定为手机 APP ID，二者方向不同，不能互相顶替。证书 SHA-256 只保留为诊断字段，不再进入 Wear Engine 身份。
- `tests/build_artifact_check.sh` 只做容器/清单级检查，**不构成证书签名验证**；手机包验签由 workflow 的 `hap-sign-tool verify-app` 步骤负责（需要真实工具链）。手表 Lite 单 BIN 的 `verify-app` 在本机对 0xBE 格式走 ELF 路径、必然失败，故由 `tools/sign_hap.sh` 记为显式 WARNING（`VERIFY_UNSUPPORTED_FOR_LITE_BIN`），**不当作验签通过**；详见 `docs/WATCH_INSTALL.md`。
- 目前只有 Node 测试（`tests/`）。Node 通过不代表 Lite JS 编译器/ArkTS 编译器通过，也不代表 Wear Engine 真机互通。
- 两套应用包名保留历史命名，以避免与签名注册和传输配置脱节。

## 可关闭条件（项目总体）

- [ ] GT 4 签名 Lite HAP 能由 CI 可重复构建并下载，且安装成功
- [ ] HarmonyOS 7 手机签名 HAP 能由 CI 可重复构建并安装
- [ ] 手机 TXT/EPUB 导入、格式转换和进度数据结构成功
- [ ] 选定 GT 4，手机→表发送、表侧校验落盘、ACK 全链路通过
- [ ] 圆屏不裁字、长篇不卡顿、退出后恢复进度
- [ ] 文档记录实际真机与构建版本，不以 Node 结果代替真机测试
