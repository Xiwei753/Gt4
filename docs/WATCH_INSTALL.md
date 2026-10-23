# GT 4 46mm 安装与构建说明（Lite 单 BIN 签名 / Issue #4）

> **2026-10-10，Issue #4：Lite 单 BIN 签名口径已落地，真机安装待验证（暂不可关闭）。**
>
> **安装链路事实（20:57 手机日志）**：HDEA（应用调测助手）对单 BIN HAP 的
> ZIP 检查通过（`renameResult:true`），`entry.bin` 上传到 GT4 完成
> （progress 100 / `resultCode:207`），安装指令下发成功，但
> **手表 AppManager 返回 `errorCode 10`（内部错误）**。手机 HAP 格式与蓝牙
> 传输都不是失败环节——失败发生在**手表侧安装**。
>
> **旧写法的错误**：对单 bin 的 HAP 直接 `sign-app`（默认 `-inForm zip`）
> 只给**外层 ZIP** 签名；HDEA 解包后只把内部 `entry.bin` 发给 GT4，
> 手表拿不到外层签名。旧脚本还错误地强制"签名前后 BIN SHA-256 必须相同"，
> 反而掩盖了签名问题。
>
> **Issue #4 的修正（已实现，本地构建通过）**：
> - 从 HAP 解出原始 BIN，解析 0xBE 包头与真实 bundleName，必须等于
>   `con.xiwei.suyue.gt4`；**不再对整包做文本扫描**——hvigor 会往 Lite 模块
>   注入模板 `module.package=com.example.myapplication`，而 OpenHarmony
>   `GtBundleParser` 只读 `app.bundleName`/包头/profile，根本不读
>   `module.package`，整包扫描纯属误报（Issue #4 明确要求删除该规则）。
> - 用 `sign-app -inForm bin` 签**内部 BIN**，日志给出工具 SHA-256、参数、
>   退出码；签的是手表真正收到的那个文件。
> - 再 `verify-app -inForm bin` 验**手表收到的 BIN**：本机实测该工具对本
>   0xBE 格式走 ELF 校验路径（`verify: elf magic verify failed`），
>   **无法独立验签**；对严格识别出的 Lite 0xBE BIN，把**这个已知不兼容错误
>   降级为显式 WARNING**（`VERIFY_UNSUPPORTED_FOR_LITE_BIN`），
>   **绝不打印 `Verify success`**，也**不吞**签名失败 / IO 失败 / 身份错误 /
>   其它未知错误。普通 HAP / Stage / ELF 验签仍然**严格**，不做全局关闭。
> - 把已签名 BIN 原样封装为**只有这一个 BIN** 的 HAP（不回退外层 ZIP 签名），
>   并校验包内 BIN 与本次签名产物**逐字节一致**。
> - 手机普通 Stage HAP 仍是 `-inForm zip`，手机端流程不变。
>
> **三种状态必须分开记录**：`SIGNED_TOOL_OK`（sign-app 成功）/
> `VERIFY_UNSUPPORTED_FOR_LITE_BIN`（本机无法独立验签）/
> `HAP_PACKAGED_OK`（结构合规）；只有真机装成并启动才算
> `DEVICE_INSTALL_OK`。**签名成功 ≠ 验签成功 ≠ GT4 安装成功**，
> 三者不能合并成"已解决"。
>
> 官方签名参数：
> https://github.com/openharmony/docs/blob/master/en/application-dev/security/hapsigntool-guidelines.md
> Lite GT 安装器：
> https://github.com/openharmony/bundlemanager_bundle_framework_lite/blob/master/services/bundlemgr_lite/src/gt_bundle_installer.cpp
> 错误 10 仍是通用内部错误，不能只凭此认定签名一定是唯一原因。

## 当前调测步骤

请在本机保持原有证书、手表 Profile 和密钥不变，运行：

```bash
tools/build_watch_lite.sh debug
```

只有日志**同时**包含 `LITE_BIN_IDENTITY_OK`、`SIGNED_TOOL_OK`、
`LITE_BIN_SIGNED_OK`、`HAP_OK`、`BIN_SHA256_MATCH`，并出现
`VERIFY_UNSUPPORTED_FOR_LITE_BIN`（注意：**不是** `verify: Verify success`）
才考虑安装 `apps/watch/entry/build/default/outputs/default/entry-default-debug-signed.hap`。

`verify-app -inForm bin` 对本 0xBE Lite BIN 必然报
`verify: elf magic verify failed`，这是**签名工具的输入格式限制**
（其非 ZIP 校验路径按 ELF 解析），**不是签名无效的证明**；脚本因此把
该已知不兼容错误降级为显式 WARNING，绝不会伪造 `Verify success`。
若签名工具报的是**其它**错误（签名失败、IO 错误、身份不符、包名不一致
等），脚本仍然硬失败退出，**不回退**到外层 ZIP 签名。

**GitHub 源码测试全绿 ≠ BIN 真签名成功 ≠ GT4 安装成功。**
旧 Release 产物和上一轮仅签外层 ZIP 的 Debug 产物均不可复用。

## 前置条件

1. HUAWEI WATCH GT 4 46mm（466×466 圆屏），确认系统版本。
2. 已注册的华为开发者账号；设备已登记为调试设备。
3. **已验证可用**的 Lite Wearable 工具链：HarmonyOS Command Line
   Tools 26.0.0.821（Linux x64）。关键路径：
   - `$HOME/.harmony-cli/bin/hvigorw`（包装脚本，自动设置
     `DEVECO_NODE_HOME` 与 `DEVECO_SDK_HOME`）
   - `$HOME/.harmony-cli/sdk/default/openharmony/js` —— Lite JS SDK，
     含 `@system.file` / `@system.device` / `@system.router` /
     `@system.storage` / `@system.prompt`
   - `$HOME/.harmony-cli/sdk/default/openharmony/js/build-tools/ace-loader/bin/jerry-snapshot`
   - `$HOME/.harmony-cli/sdk/default/openharmony/toolchains/lib/hap-sign-tool.jar`
   - `$HOME/.harmony-cli/tool/node`（hvigor 自带的 Node）
4. 签名材料放在仓库内 **gitignore 掉的** `signing/` 目录（或用
   `WATCH_SIGN_*` 环境变量指向别处）。按用途分目录，详细说明见
   [signing/README.md](../signing/README.md)：

   ```text
   signing/shared/  两端共用：私钥 shared-signing-key.p12、
                    账号级调试证书链 debug.cer、口令 credentials.env
   signing/watch/   手表 (con.xiwei.suyue.gt4) 的 debug.p7b
   signing/phone/   手机 (com.xiwei.suyue) 的 debug.p7b
   ```

   - 私钥可复用：与素笺**共用同一对密钥**（公钥指纹 `3df9743c…` 实测一致）；
   - 证书**也可以复用**：它是**账号级**的——把两张 profile 内嵌的
     `development-certificate` 取出来算 DER-SHA256，结果完全相同
     （`fbdee2e1…`）。真正不同的是 `app-identifier`。
   - Profile `.p7b` **按应用签发**，不能跨应用顶替。手机那个
     （`bundle-name: com.xiwei.suyue`、2 个 UDID）不能签手表。
   - 手表的 profile 已就位：`bundle-name: con.xiwei.suyue.gt4`、
     `app-identifier: 6917618615525663621`、授权设备 1 个（GT 4 的 UDID）、
     有效期到 2027-10-09。**注意 `con` 不是笔误**，见
     [signing/README.md](../signing/README.md)。

## 本地构建（已验证）

```bash
tools/build_watch_lite.sh debug      # 当前 GT4 真机调试首选
```

脚本要求 `hvigorw` 存在于 PATH；缺失时明确报错退出，不会把 Node
静态检查伪装成构建成功。构建成功后输出 HAP 路径、大小与 SHA-256。

**旧 Release 多文件包的历史验签结果（已证实 HDEA 不识别；不得当作当前可安装包）**：

```text
Signing entry-default-unsigned.hap -> entry-default-release-signed.hap
sign-app success
Verifying signature of entry-default-release-signed.hap
Digest verify result: true, DigestAlgorithm: SHA-256
verify: Verify success
HAP_OK path=.../entry-default-release-signed.hap manifest=config.json
       size=215323 mode=release signed=yes
```

签名 HAP 内嵌的 profile（`verify-app -outProfile` 取出后解析）：

```text
bundle-name : con.xiwei.suyue.gt4
app-id      : 6917618615525663621
type        : debug
授权设备    : 90D08F2ED3A4387E0F0561C82A39B87B28E0F32BAE51F0CC634FBC1B7124A459
```

> 更能说明问题的是：拿**另一个应用**的 profile 去签，`hap-sign-tool`
> 照样报 `Sign Hap success!`、`verify-app` 也报 `Verify success`，
> 但设备按包名校验会拒绝安装。所以脚本现在会在签名前比对包名，
> 不匹配直接拒绝签名——`signed=yes` 必须同时意味着包名一致。

- 包内快照齐全：`app.bc` (806 B)、`pages/index/index.bc` (29,938 B)、
  `pages/reader/reader.bc` (21,802 B)。
- 资源：`icon.png.bin` 43,272 B、`icon_small.png.bin` 33,864 B。
- **包名预检是刻意的**：拿手机的 profile 签手表 HAP，`hap-sign-tool`
  照样报 `Sign Hap success!`、`verify-app` 也报 `Verify success`，
  但设备按包名校验会拒绝安装——那种"签名成功"是假绿灯，所以脚本
  在不匹配时直接不签。本次能签成，正因为包名与 profile 逐字一致。
- **不要用 hvigor 的 `signingConfigs`**：本机实测在该 legacy Lite 工程上
  `SignHap` 直接失败——
  `Error Code: 00308018 ENOENT: no such file or directory, stat '<dir>/material'`。
  素笺 CI 用的是同一条绕行路径（未签名构建 + `hap-sign-tool sign-app`）。
- **`verify-app` 的输出文件必须用 `.cer` 后缀**：写成 `.crt` 会报
  `Error Message: Not support file`（实测）。
- **产物不可复现**：同一源码重编，SHA-256 必然不同（打包写入时间戳，
  加上 ECDSA 签名随机性），字节数也可能有细微差异。验收请比对
  `.bc` 条目、单 BIN 结构与体积，而不是摘要。

## CI

- `.github/workflows/watch_lite_hap.yml` 运行在自托管 runner（label：`hmos-deveco`）。
- 本地与 CI 共用同一套签名/验签规则（都走 `tools/build_watch_lite.sh debug`）；
  已删除对 Lite BIN 必然失败的裸 `verify-app -inForm bin` 重复步骤。
- 签名材料从 `secrets.WATCH_SIGNING_MATERIAL` 注入，临时落盘、构建后删除、日志不回显。
- 缺少签名材料时构建失败并明确报出“签名不可用”，不会报告“签名成功”。
- Artifact 仅上传本次新产出的 Debug 签名 HAP（`entry-default-debug-signed.hap`），
  不含证书、不含工具链目录、不含整个构建目录。
- `runs-on: [self-hosted, hmos-deveco]` 需要真实注册一台装了 Lite SDK 的
  runner。**没有 runner 时 job 只会长期排队：既不是“构建通过”，也不是
  “构建失败”，而是“从未运行”**——不能把排队当作绿灯。GitHub 托管机
  装不了 Lite SDK（Huawei 的 command-line-tools 需先接受其许可），所以
  在 runner 注册之前，构建证据只能来自本机 `tools/build_watch_lite.sh`。
- 源码级检查（`.github/workflows/pagination-test.yml`）跑在 ubuntu-latest，
  用 glob 执行 `tests/*.test.mjs` 全量用例，其中
  `tests/source-contract.test.mjs` 会拦下"正则字面量"这类会让快照静默失败的写法。

## 安装到 GT 4（HDEA 单 BIN 流程 + 失败取日志）

**为什么必须是单 BIN HAP**：HDEA 只接受"解压后恰好一个 `*.bin`"的 HAP；
多文件 Release 包会在手机侧直接报「HAP 解压失败」（历史日志
`AppListAdapter: ...not one standard hap`）。所以只能用
`tools/build_watch_lite.sh debug` 产出的**单 BIN** Debug 签名 HAP。

```bash
# 1) 构建（产出单 BIN 的 Debug 签名 HAP）
#    不带书（与原命令一致，书架为空）：
tools/build_watch_lite.sh debug
#    带内置书（把目录里顶层 *.txt 规范化后放进内置 rawfile 资源，见 issue #10 复核后）：
WATCH_BOOKS_DIR=/绝对路径/我的书 tools/build_watch_lite.sh debug

# 2) 推到已授权、且已配对手表的中间手机（示例：nova 7 Pro）
adb -s TNL0220908013936 push \
  apps/watch/entry/build/default/outputs/default/entry-default-debug-signed.hap \
  /sdcard/haps/suyue-issue10b-rawfile-3books.hap
```

**带内置书要点（issue #10 复核后）**：正文以**规范化 UTF-8 真实字节**放进
`entry/src/main/resources/rawfile/gt4books/<bookId>.txt`，书单
`books/BookCatalog.g.js` **只含元数据**——页面 JS 保持 ~60 KB（构建脚本打印
`WATCH_PAGE_JS` 佐证，**不再产生 2 MB 巨型 reader.js**，那对应 GT4 安装错误 34）；
`BOOKS_IN_BIN_OK count=N` 证明正文真的进了内部单 BIN；`WATCH_BOOKS_BAKED=N` 为内置本数。
设备侧按需窗口读 rawfile，读不到再 `file.copy` 到私有目录读，都失败就显示真实错误码。
**私人正文不进 git/CI/日志。**

3) 打开手机「应用调测助手」→ 该文件 → 选择配对的 HUAWEI WATCH GT 4 →
   解包 → 蓝牙传输 → 手表安装。`/sdcard/haps/` 里**只保留这一个**签名包，
   旧的 Release/未签名包会被误点并报「HAP 解压失败」。

**失败时如何取日志**（错误码由助手转发，手表侧细节要另取）：
- 手机侧：`adb logcat -c` → 重新安装复现 →
  `adb logcat -d -v threadtime > gt4-install.log`。关键行：
  `DevecoAssistant|AppListAdapter`（点击/解包/传输进度）、
  `AppManagerReceiver errorCode :N`。助手只**转发**手表返回的码
  （如 10=内部错误、27=与旧版本签名信息不匹配、28–35=签名验证失败）。
- 手表侧：需用 DevEco / hdc 取 GT4 的 hilog，才能看到真正的安装失败原因；
  手机日志只有那个转发码，不构成根因结论。

候选路径（按优先级）：
1. DevEco Assistant / HDEA 经配对手机中转安装到 GT 4（本仓库当前主路径）。
2. 若 Pocket 2（HarmonyOS 7）无法运行对应安装助手，寻找实际兼容的安卓/鸿蒙旧手机做中转。

安装后验证清单（issue #10 一次性真机验收）：
- [ ] 应用出现在手表桌面，名称为「素阅」
- [ ] **启动立即出现书架**，不再停在「正在准备本地书库 / 导入内置书籍 / 读取 books.json 第 4 步」
- [ ] 内置书（标题旁标「内置」）出现在书架，点开显示**真实正文**；内置书不能删除（提示不可删除）
- [ ] 若内置书点开显示空白或报错，请记下屏幕上的**接口名 + 错误码**（`internal://app/rawfile/...` 能否被读/复制只能由 GT4 固件判定，失败会如实显示而不是卡住）
- [ ] 触屏前后翻页正确，无吞字/重字/中文乱码；字号 14–32 能连续调整且重排正确
- [ ] 日/夜切换正常；退出重进、切换书目后**各自进度独立恢复**（字号/主题/位置）
- [ ] 覆盖安装（不卸载）后已有书与进度仍在；不内置任何书时不破坏手机传书路径
- [ ] 圆屏 466×466 安全区域内文字不被裁切（issue #11：正文由 `<canvas>` 逐行绘制，
      应看到**上下短、中间宽**、真正贴合圆盘，无矩形裁切、无出圈字、无多余框/标签/按钮）
- [ ] 阅读页只有正文：左滑进设置、右滑交给系统返回、点右半下页/点左半上页；
      字号 14/20/32 与行距调整后**立即重排**；从设置返回、日夜切换后**有正文**（不空白）
- [ ] 若出现 `无法使用 Canvas 阅读`，
      记下屏幕原文 —— 说明目标固件的 Canvas API 与预期不同（见 issue #11）
- [ ] 表冠旋转是否真的下发到 `onCrownChange`（未送达则维持触屏翻页）
- [ ] `font-size` 是否真能取 14–32px 的连续值（SDK 对 `font-size` 的说明不明确，需真机核对）

## 已知未决

- `targetSdkVersion` = `5.1.0(18)`、`compatibleSdkVersion` = `4.0.0(10)`
  已参照 Lite 示例调整，但**尚未经 GT4 真机确认适配**。
- Wear Engine 接收需要手机 APP ID（`bundle-info.app-identifier`）和
  手表 `supportLists` 授权；构建脚本已支持从真实手机 profile 注入，
  但仍需重打并安装 GT4 HAP 后真机确认（见 `wear/PeerConfig.js`）。
- **真机安装与运行尚未做**：签名通过只证明 HAP 完整、证书链有效、
  包名与 profile 一致。设备端还会校验该 UDID 是否在授权列表、有效期与
  设备调试状态。这些都没在 GT 4 上验证过，因此第 1 阶段"可安装"验收
  **尚未达成**，不能关闭议题 #2。
- **回执通道的 `deviceId` 是占位值**：`wear/WearReceiver.js` 里
  `deviceId: 'remote'` 取自上游 Lite 示例、**从未真机确认**。现已改为
  优先采用从订阅回调探测到的真实 `deviceId`，探测不到才回退并告警一次；
  这条回执路径仍未验证。
- **CI 签名代码已与本机同源**：`watch_lite_hap.yml` 直接调用
  `tools/build_watch_lite.sh debug`（复用同一套 sign/verify 规则），并
  **删除了**对 Lite BIN 必然失败的裸 `verify-app -inForm bin` 步骤；
  自托管 Runner 仍排队，尚无新包名构建证据。
- 手机包名已改为 `com.xiwei.suyue`（对应现有 AGC 应用与证书），
  但**手机 HAP 仍未构建**；手表包名已改为 `con.xiwei.suyue.gt4`，
  需要在 AGC 注册相同包名并签发包含 GT4 UDID 的独立调试 Profile。


### #11 安装停在手表阶段的检查要求（2026-10-12）

- 最新源码已将 `config.json` 版本由 `1000001 / 0.1.1` 升到 `1000002 / 0.1.2`，打包脚本明确打印 `WATCH_BUILD_SOURCE_SHA` 和 `WATCH_BUILD_SOURCE_VERSION`。之前大量修复一直使用相同的版本号，是确实存在的升级标识问题；**尚无手表侧证据证明它就是这次卡安装的根因**。
- 不能把 GitHub `Source-only checks` 成功说成 HAP 构建通过。真正的 `watch_lite_hap.yml` 需要注册了 `self-hosted,hmos-deveco` 的 runner，否则任务一直 `queued`、根本没有生成这次提交的 HAP。手工本地构建时必须保存 `SIGNED_LITE_HAP_PATH`、`WATCH_HAP_SIZE`、`WATCH_BUILD_SOURCE_SHA`、`WATCH_BUILD_SOURCE_VERSION` 和最终 HAP SHA256。
- 提交给 DevEco Assistant 的必须是同一轮构建生成的 `entry-default-debug-signed.hap`；不要拿 unsigned 包、旧版同名缓存、Release 包或只通过 Node 测试的源码测试产物。签名 profile 必须是 GT4 的 debug profile，bundleName 仍为 `con.xiwei.suyue.gt4`。
- 手机日志或 Wear Engine 返回“发送成功”**不能证明手表侧已经校验/安装完成**。下一次卡住请固定手表屏幕提示、失败代码和安装时间，并记录该 HAP 的 SHA256；不需要反复抓整份无关手机日志。
- 当前不要随便卸载旧版或清除手表数据：卸载可能丢失应用私有阅读位置和字号。若后续设备明确返回版本/签名冲突，再根据具体错误码评估是否需要卸载。
