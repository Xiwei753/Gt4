# GT 4 46mm 轻量级手表端

本目录是 HarmonyOS Lite Wearable 的 **JS FA** 工程，不能按 ArkTS Stage 或 Wear OS 编译。

## 当前已经接线的能力

- `storage/BookStorage.js`：应用私有目录多书管理（books/、temp/、progress/），`readBytes` 按字节窗口流式读取，`commitVerifiedBook` 把校验通过的暂存书转正。
- `storage/LibraryIndex.js`：`books.json` 多书索引；只列文件真实存在的书；重复发送同一书籍不覆盖阅读进度。
- `storage/ProgressStore.js`：每本书独立进度（字节偏移/历史/字号），重启恢复且互不串书。
- `wear/TransferLogic.js` + `wear/IncomingBookReceiver.js`：按 `shared/protocol` v0 接收 BOOK_META/CHUNK/FINISH，整本 SHA-256 校验通过才入书架；缺块 `E_MISSING_CHUNKS`、摘要不符 `E_DIGEST_MISMATCH`、取消 `E_CANCELLED` 均有处理；失败清理暂存。
- `util/Sha256.js`：纯 JS SHA-256（Lite JS 无加密 API，ES5 兼容），Node 互验通过。
- `util/Utf8.js`、`util/Base64.js`：纯 JS UTF-8 解码与 base64 解码（运行时无 atob），Node 互验通过。
- `reader/PageLayout.js`：唯一分页器（编码边界/换行/上下页偏移）。
- `reader/ReaderSettings.js`：字号/行距/主题的单一真相；列数/行数由
  其推导，改变设置按当前字节位置重排，不丢字、不重复、不跳页。
- `reader/CrownInput.js`：表冠输入。已按上游 MIT 示例
  `sportwatch-how-to-use-crown` 的机制接入——`reader.hml` 里放一个
  1×1 透明 `<slider ref="crownProxy">`，`onShow` 调
  `rotation({focus:true})` 抢占表冠焦点，旋转经 `onchange` 进入
  `createCrownTracker()` 换算成前后翻页（绝对档位→相对步进，
  超程跳变丢弃，不足一页的余量保留）。**GT4 真机是否真的送达旋转
  事件、每页需要转几格，都还没验证**，因此 `crownStatus()` 返回
  `'unverified'`，阅读页保留触屏上页/下页，不伪造“已支持”。
- `pages/index`：真实书架（列书名、打开、二次确认删除、空书架提示）；
  首次启动把旧演示书迁入新书库（迁移桥接，设备验证后删除）。
- `pages/reader`：按路由 `bookId` 打开；字号 A-/A+、日间/夜间主题、
  行距随设置重排；未知 bookId 不崩溃。
- `wear/WearReceiver.js`：Wear Engine 适配层，版本检查 + 手机指纹门控，消息路由到 `IncomingBookReceiver`。
- `wear/PeerConfig.js` 和 `config.json` 的 `supportLists` 里有待填写的手机端证书指纹位置。**两处值必须按真实应用签名配置一致**，不能把占位文本当作生产值。

## Lite 运行时限制（本机实测，issue #2）

工具链：HarmonyOS Command Line Tools 26.0.0.821（Linux x64），
Lite JS SDK 在 `$HOME/.harmony-cli/sdk/default/openharmony/js`。
用包里的 `bin/jerry-snapshot`、`bin/jerry` 直接实测得到：

- **没有 RegExp**：正则字面量 `/abc/` 在解析期就 `SyntaxError`；
  `new RegExp('a')` 运行期 `ReferenceError`；`'x'.replace('a','b')`
  抛 `TypeError`（replace 仍依赖正则实现）。手表端所有格式校验因此
  走 `util/Validate.js` 的字符比较。
- 其它实测缺失项：`padStart` / `padEnd` / `DataView`。
- 可正常使用：JSON、数组 `forEach/map/filter/indexOf/slice`、
  `String.split/trim/indexOf/slice/repeat/startsWith`、`Object.keys/assign`、
  `Uint8Array`（含 `set`/`subarray`）、`ArrayBuffer`、闭包、原型继承、
  `Object.defineProperty`、位运算。

**为什么这条限制很危险**：`ace-loader` 的 `lite-snapshot-plugin` 把每个
页面 JS 用 `jerry-snapshot` 编成 `.bc` 快照，但转换失败时**只打印一行
`Failed to convert ... to a snapshot.`，并不会让构建失败**。结果是
`BUILD SUCCESSFUL`、HAP 也产出了，但缺少该页 `.bc`，手表上根本打不开。
本项目就踩过：`reader.js`、`TransferLogic.js`、`BookStorage.js` 里的
5 处正则曾让 `index.bc`/`reader.bc` 双双缺失。

两道守门防止复发：
`tests/source-contract.test.mjs` 扫描手表源码禁止正则与上述缺失 API；
`tests/build_artifact_check.sh` 在 Lite 产物上校验每个页面 JS 都有配对
`.bc`，把"绿色构建掩盖坏应用"变成硬失败。

## 构建与安装

- 工程结构已对齐 Lite Wearable 参考示例（`build-profile.json5` 含 `signingConfig`/`strictMode`、`hvigor/hvigor-config.json5`、`entry/hvigorfile.ts`、`resources/base/media/icon{,_small}.png`、`config.json` 的 `"$media:icon"`）。
- 本地构建：`tools/build_watch_lite.sh debug|release`；需要 DevEco `hvigorw` 与 Lite Wearable SDK，缺失时明确报错，不用 Node 检查冒充构建。
- **本机已真实编译并签名成功**（release，新包名）：产物
  `entry-default-release-signed.hap`，215,323 字节。
  `build_artifact_check.sh` 报 `signed=yes`，`hap-sign-tool verify-app` 报
  `Digest verify result: true` / `verify: Verify success`；
  包内嵌的正是**手表自己的** profile（uuid `a97e7d89…`、
  `bundle-name: con.xiwei.suyue.gt4`、`app-identifier: 6917618615525663621`、
  授权设备就是 GT 4 那个 UDID）。
  这个坑很隐蔽：拿手机 profile 签手表 HAP，`hap-sign-tool` 照样报
  `Sign Hap success!`，但设备按包名校验会拒绝安装——"签名成功"没有意义。
  构建脚本因此会在签名前比对 profile 的 `bundle-name` 与 HAP 的
  `app.bundleName`，不一致就拒绝签名。
  包内快照齐全：`app.bc` (806 B)、`pages/index/index.bc` (29,938 B)、
  `pages/reader/reader.bc` (21,802 B)。
- **包名**：手表 = **`con.xiwei.suyue.gt4`**（`con` 不是笔误：AGC 里
  实际注册的名字，已确认保留），手机 = `com.xiwei.suyue`。
  两者必须互不相同——双端靠包名区分自己与对端，撞名会让配对门控失效。
- 签名走的是**未签名构建 + `hap-sign-tool sign-app`**：hvigor 的
  `signingConfigs` 在这个 legacy Lite 工程上实测失败
  （`SignHap` → `00308018 ENOENT: stat '<dir>/material'`），
  与素笺 CI 采用同一条绕行路径。材料放在 gitignore 掉的
  `signing/` 目录，说明见 [signing/README.md](../../signing/README.md)。
- **GT4/HDEA 走单 BIN 口径（Issue #4）**：HDEA 解包后只把内部 `entry.bin`
  发到手表，外层 ZIP 签名无效，因此脚本对 HAP 内那**唯一**一个 `*.bin`
  执行 `sign-app -inForm bin`，再原样封回单 BIN HAP。`verify-app -inForm bin`
  对本 0xBE 格式会走 ELF 校验路径、必然报 `verify: elf magic verify failed`，
  属**工具输入格式限制**：脚本把它降级为显式 WARNING
  （`VERIFY_UNSUPPORTED_FOR_LITE_BIN`），**不会**伪造 `Verify success`，
  也不放过签名失败/IO/身份错误；普通 HAP 验签仍严格。签名成功与验签成功
  是两件事，GT4 安装成功又是第三件事（见
  [../../docs/WATCH_INSTALL.md](../../docs/WATCH_INSTALL.md)）。
- **从未在真机安装验证**：签名只证明包完整、证书链有效、包名与 profile 一致，
  不代表 GT 4 接受安装（profile 是 debug 类型、绑定 UDID，
  且设备端还会校验包名/UDID/有效期）。
- 图标必须小尺寸：`tools/gen_watch_icons.py` 曾生成 1024×1024 的
  `icon.png`，Lite 资源转换把它展成原始 RGBA（1024²×4+8 = 4,194,312
  字节）塞进 HAP，整包膨胀到 4.45 MB。改成与上游示例一致的
  104×104 / 92×92 后，`.bin` 降到 43,272 / 33,864 字节，HAP 只有
  190 KB 量级。
- CI：`.github/workflows/watch_lite_hap.yml`（自托管 `hmos-deveco` runner；签名材料经 `secrets.WATCH_SIGNING_MATERIAL` 注入；产物只上传本次新产出的 Debug 签名 HAP）。**注意该 job 目前在排队而非运行**：GitHub 托管机装不了 Lite SDK，必须先注册带工具链的自托管 runner。该 workflow 现已直接调用 `tools/build_watch_lite.sh debug`（与本机同源），并删除了对 Lite BIN 必然失败的裸 `verify-app -inForm bin` 步骤；**但自托管 Runner 仍未运行，暂不能称 CI 构建通过**。
- 安装步骤与待验证清单：[../../docs/WATCH_INSTALL.md](../../docs/WATCH_INSTALL.md)。
- **尚未在任何真机上安装或运行；`6.1.1(24)` 版本号待 GT 4 真机核对。**

## 启动初始化诊断（issue #8）

真机反馈首页曾长期停在"正在准备本地书库"。原因是任一异步步骤不回调
（或同步抛异常）时，UI 永远维持初始文案，而用户看不到手表日志。现在
`pages/index/index.js` 把初始化改成显式状态机，**无日志也能从屏幕定位**：

- 阶段文案：`初始化 1/5：进入首页` → `2/5 目录 books/temp/progress`
  → `3/5 导入内置书籍`（issue #7 的导入桥，读不到资源时安全 no-op）
  → `4/5 读取 books.json` → `5/5 检查旧 demo` → 完成
  （`本地书库就绪（N 本）` 或 `书库为空，等待手机传书`）。
- 超时兜底：10 秒（测试可注入更短值）未完成则显示
  `书库初始化超时：阶段=<卡住的阶段>`。超时**不会**清空目录、重启循环
  或伪造成功。
- 错误码直接上屏（`status(...)` 括号内）：
  `E_PREPARE_THROW` / `E_DIRS_books|temp|progress` / `E_INDEX_READ`
  / `E_INIT_TIMEOUT` / `E_DEMO_MOVE_<code>` / `E_DEMO_STAT` / `E_DEMO_DIGEST`。
  同步异常由 try/catch 兜底，异步结果带 token 校验，过时回调不会覆盖
  新状态；`onDestroy` 清理定时器。
- 失败时屏幕出现"重试"文本按钮（`retryInit`），不必卸载应用。
- Wear Engine 初始化与本地书库**分开** try/catch：传书/授权异常只在
  底部 `transferStatus` 显示，绝不阻塞离线书架启动。

`storage/BookStorage.js` 的每个 `access`/`mkdir` 都只结算一次回调，带
`setOperationTimeout`（默认 8s）无回调兜底，并保留真实错误 code；目录创建
失败会带上阶段名。`storage/LibraryIndex.js` 用 `onDiag` 区分**首次安装的
301（missing）**与真正的 **I/O/参数错误（error）**，不再把两者都当成空书架；
队列加 `setQueueTimeout`（默认 9s）看门狗，单个操作不回调只释放队列、
不伪造成功，后续 `listBooks` 不会被永久卡住。

回归：`tests/watch_init_diagnostics.test.mjs`（空书架、已有书、301→mkdir、
mkdir 202、readText 300、无回调超时、重试、Wear Engine 隔离、队列看门狗）。
**这些均以 Node 文件桩验证；GT 4 真机最终验证仍待完成，故本 issue 暂不可关闭。**

## 构建期内置书籍（issue #7）

可选的构建期入口，把本机挑选的 TXT 直接打进 GT4 的 HAP，安装后出现在**现有书架**、用**现有阅读器**打开——不新增第二套书库，也不替代手机传书。

用法：

```bash
# 不带书：与原命令完全一致，不产生任何内置书籍
tools/build_watch_lite.sh debug

# 带书：把一个目录里的顶层 *.txt 全部内置（不递归、不看子目录）
WATCH_BOOKS_DIR=/绝对路径/我的书 tools/build_watch_lite.sh debug
```

处理规则（`tools/prepare_watch_books.py`，构建机执行）：

- 只认顶层 `*.txt`（不支持 EPUB，不做递归扫描）；按 `(文件名小写, 原名)` 稳定排序。
- 编码：UTF-8（含 BOM 自动去除）；带 BOM 的 UTF-16LE/BE 自动转 UTF-8；其它/无法判定编码**直接报错**，不在手表上猜编码。
- `bookId` = 规范化 UTF-8 内容 SHA-256 前 16 位十六进制，与现有书库口径一致；同时写入 `bytes`、全量 `sha256`、`encoding:'utf-8'`、`chapters:[]`。
- 书名取文件名（去扩展名）。
- 行为明确：**同内容重复**只保留排序最靠前的一本并打印 `跳过重复内容`；**同名不同内容**另一本自动加 ` (2)`、` (3)`。
- 单本上限默认 8 MiB（`--max-bytes` 可调）；超限、路径不存在、目录里没有可用 TXT、编码失败、空书名都会**非零退出**，绝不产出一个“看起来成功但少了书”的包。
- 构建后打印 `WATCH_BOOKS_ADDED title=.. bytes=.. id=..`、`WATCH_BOOKS_BAKED=<n>`，**从不打印书本正文**。

放置与清理：脚本把书放进临时资源目录 `entry/src/main/resources/rawfile/gt4books/`（Hvigor 会真实处理并嵌入内部 `entry.bin`），并注册 `EXIT` trap **无条件清理**，因此某次带书的构建不会污染下一次不带书的构建；该目录与常见个人书库已在 `.gitignore` 中屏蔽，**私人小说正文不会进入公开仓库**。

产物校验：`tests/build_artifact_check.sh --expect-books-manifest <manifest.json>` 会解出 HAP 内那唯一的 `*.bin`，确认其中真的带了 `rawfile/gt4books` 目录、每本书的 `<bookId>.txt` 文件名、每本书的**真实内容字节**与 `manifest.json` 字节，而不仅是源码目录或外层 ZIP；通过时打印 `BOOKS_IN_BIN_OK count=N`。

### 运行时导入桥接与设备侧诚实边界

`storage/BundledBookImporter.js` 在 `pages/index/index.js` 的 `prepareLibrary()` 里**只调用一次**，把内置书按块复制进现有可写书库（`internal://app/gt4reader/books/`）、校验长度与摘要后再经 `LibraryIndex.addBook` 登记。它是**幂等**的：`internal://app/gt4reader/bundled.json` 记录了“已处理过的 bookId”，已存在的书和已删除的书都**不会**被覆盖或自动复活，也绝不重建 `books.json`、不动阅读进度；任何失败只清理半成品暂存、不入书架，并打印可诊断日志，绝不卡住书架。

诚实说明（与源码一致，非“已支持”）：本机 Lite JS FA 运行时里，打进 HAP 的 `rawfile` **没有 JS 可读接口**——`@system.file` 的 `IsValidPath()` 只接受 `internal://app…` 前缀、且禁止 path traversal，实际只能落到**应用私有目录**；Lite 也没有 `$rawfile`/resourceManager。因此导入器会**依次探测**若干候选重定位路径（`internal://app/rawfile/gt4books/`、`internal://app/assets/entry/resources/rawfile/gt4books/`、`internal://app/entry/resources/rawfile/gt4books/`），若都读不到就打印 `BUNDLED_IMPORT_UNAVAILABLE` 并**安全 no-op**，如实记录为“无法在此 Lite 运行时读成可写书库”。此外 GT4 真机安装本身仍被 issue #4 的 `errorCode 10` 阻断，**内置书是否真的能在真机首启出现在书架、能否阅读，尚未在真机验证**；构建/产物/导入逻辑已验证，真实机行为待验证。

## 未完成

- 手机发书 → 手表接收文件 → 校验 → 加入书架的完整闭环；Wear Engine 文件通道回调字段待真机确认。
- **真机安装与运行**：签名已跑通、包名与 profile 一致，但从未装到
  GT 4 上跑过，`crownStatus()` 仍是 `'unverified'`。
- 表冠翻页：机制已接入并通过纯逻辑单测，但 **GT4 是否真的下发旋转事件、
  每页阈值多少，必须真机实测**（见 `reader/CrownInput.js` 顶部说明）。
- 圆屏真实像素分页（当前为估算字宽，待 GT4 46mm 真机校准）。
- 在 GT 4 46mm 上安装、启动、翻页、恢复进度，并核对
  `targetSdkVersion`/`compatibleSdkVersion` 的 `6.1.1(24)`
  是否为 GT 4 开发安装实际可用的版本。**编译通过不等于真机适配通过。**
- 迁移收尾：演示书桥接已删除（`storage/BookFiles.js` 已移除；空书库不再自动重造测试书，只在旧 `demo.txt` 真实存在时迁移）。仍待真机验证迁移路径本身。

## 引用及许可证

代码基于三个 [Lite Wearable MIT 示例](../../docs/REFERENCES.md) 所介绍的接口与处理方式改造；`WearReceiver.js` 保留了来源声明。完整 MIT 条款及原作者声明放在 [third_party/NOTICE.md](../../third_party/NOTICE.md) 和相应许可文件中。华为 SDK wrapper 的第三方实现没有打包进来。

## 开发提示

使用支持 Lite Wearable 的 DevEco 打开本目录，配置本机签名以及匹配的 Lite Wearable SDK。`readArrayBuffer` 字节窗口、FA HML 的 `for` 循环与 `$idx` 事件参数、中文分页均需真机测试。不提交签名密钥。
