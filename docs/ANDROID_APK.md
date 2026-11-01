# Android APK 工程状态与验收（议题 #3）

本文件记录 `android` 的工程决策、诚实边界与分阶段验收清单。
面向用户的构建/安装说明见 [android/README.md](../android/README.md)。

## 1. 与议题 #2 / 分支的关系

- 本工程在**唯一工作分支 `auto-issue-3`** 上提交。真实远端对照（`git fetch --all` 后）：
  - `origin/main` = `27c0ea6`（**不含** #2 的手表/手机改名）
  - `origin/auto-issue-2` = `cc704dc`（#2 的最新手表侧修复）
  - 本分支 = 将 `origin/auto-issue-2` 合并进旧的 `origin/auto-issue-3`（`c42a709`）后的合并提交，
    即本分支**已包含 #2 手表侧的改名与修复**（手表 `con.xiwei.suyue.gt4`、HarmonyOS 手机 `com.xiwei.suyue`）。
- 因此本 App 的「手机」身份与手表端登记的手机身份处在同一基线上；但 **Android APK 的包名与
  证书指纹和 HarmonyOS 手机并不相同**（见第 2 节），必须在 AGC 单独登记。
- 按议题约束：**不与 #2 并行修改** `watch/huawei/watch-lite`、`harmony`、`tools/build_watch_lite.sh`、
  `signing/`、CI 的手表/手机 workflow。本工程只新增 `android/**`、`tools/build_android_apk.sh`、
  `.github/workflows/android_apk.yml`、Android 相关测试/示例/文档，并对 `README.md` 做少量追加说明。

## 2. 身份与签名（P0）

| 项 | 值 | 来源 |
| --- | --- | --- |
| Android `applicationId` | `com.xiwei.suyue.android` | `app/build.gradle.kts` |
| Android Kotlin `namespace` | `com.xiwei.suyue`（仅代码包名） | `app/build.gradle.kts` |
| 手表对端 bundle | `con.xiwei.suyue.gt4` | `wear/PeerIdentity.kt` |
| 手表指纹注入占位 | `""`（构建期注入，构建后还原） | `wear/PeerIdentityConfig.kt` |

> 包名采用 `com.xiwei.suyue.android`（而非 HarmonyOS 手机的 `com.xiwei.suyue`）：它是
> **AGC 上为本 Android APK 登记的应用包名**，用来与「同包名、不同签名」的 HarmonyOS 手机
> 明确区分。手表侧 `supportLists` / Wear Engine 需登记的是
> **`com.xiwei.suyue.android` : 本 APK 证书指纹**。若 AGC 侧最终确定的包名与此不同，
> 改这一处（及 `PeerIdentity.PHONE_BUNDLE_NAME`、构建脚本 `EXPECT_PKG`、测试与文档）即可。

- **同包名 ≠ 同签名**：合法的 Android 签名证书可以有多个，但手表端
  `supportLists` / Wear Engine 只认**登记的指纹**。因此：
  - 若复用现有证书：需先在设备上验证其指纹是否被手表接受；
  - 否则：另配 Android keystore，并在 AGC 完成 Wear Engine 登记，注入对应指纹。
- 本工程 **不修改** 手表侧 `PeerConfig.js` / `config.json`（那是 #2 的范围）；
  也 **不要求** 用户重签手表证书或改手表 App ID。
- HAP 的 `.p7b` profile **不用于** APK；APK 独立签名。私钥/口令/keystore 绝不入库。

## 3. 已实现（源码级）

- 导入：TXT（BOM/UTF-8/GBK 识别）与 no-DRM EPUB（ZIP 解包、容器/OPF/spine/NCX），
  规范化 UTF-8 写入沙箱并**写后复核大小+SHA-256**；选择 URI ≠ 成功。
- 书库：`library.json` 原子写、按 `bookId` 去重、删除、状态标记；重启不丢。
- 发送：官方 Android Wear Engine（权限、设备发现、手动选择、ping 区分
  未安装/未运行、**发送前显式配置对端身份**、消息+文件通道、发送 `Task` 失败与超时都有处理）。
- 发送：`transferFile` 成功回调只表示文件已发送；手表侧大小、SHA-256 校验和入库状态未知。
- 章节目录：目录是可选元数据；分片发送未完整时正文仍可传输，手表不保存半份目录。
- 取消：**当前可用的 SDK（`5.0.0.300` / `5.0.0.301`）没有任何 `cancelFileTransfer` 接口**，
  因此取消只向手表发 `ERROR/E_CANCELLED`，**不能中断已发出的文件流**；
  半成品由手表侧失败清理路径删除。文档不把「取消请求」写成「文件传输已停止」。
- 重发：已发送 / 发送失败的书（`READY`/`SENT`/`TRANSFER_FAILED`）可由用户再次发起；不自动重试。未完成导入的不可发送。
- 书库索引：`library.json` 用 `AtomicFile` 原子写，写入失败会抛出并反馈界面，不静默丢索引。
- 编码：GBK/GB18030 走**严格解码**（`CodingErrorAction.REPORT`），非法字节返回 `null`，不做静默替换。
- 协议：`protocol` v0，字段与 HarmonyOS 侧一致（Android 额外带 `encoding`）。
- 构建/测试：独立 Gradle 工程，本机 `BUILD SUCCESSFUL`；另有 JVM 单元测试
  （`./gradlew :app:testDebugUnitTest`，覆盖可发送状态 / 编码严格解码）。

## 4. 分阶段验收状态

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 1 | Android APK 最小闭环（真实编译 + 产物信息 + 导入/持久化） | ✅ 编译验证；⚠️ nova 真机安装待验证 |
| 2 | Wear Engine 连接（授权/设备列表/错误区分/指纹比对） | ⚠️ 代码就绪，真机待验证（阻塞于 AGC 注册与正式指纹） |
| 3 | 同机调测与真实传书 | ⛔ 未验证；依赖 #2 的手表端 HAP 与真机 |
| 4 | 功能对齐（EPUB、编码恢复、删除/重发、上限、标题一致） | ⚠️ 代码就绪，真机待验证 |
| 5 | 文档（三端 + 获取/安装 APK + 日志路径） | ✅ |

**当前结论：暂不可关闭。** 编译/静态检查通过，但真机配对与端到端传书未验证。

## 5. 阻塞项

- AGC「Wear Engine 服务」权限 + 正式签名指纹登记（否则无法真机测试 SDK）。
- GT 4 上可运行的手表端素阅（来自 #2；若 #2 HAP 仍「解压失败」，需分别报告
  「Android 侧可接受」与「被 #2 阻塞」，**不得伪造成端到端成功**）。
- nova 7 Pro 实机：安装、授权、配对、传书均待验证。

## 6. 诊断

```bash
adb logcat -s suyue/Main suyue/Transfer suyue/WearEngine
```
