# GT 4 46mm 轻量级手表端

本目录是 HarmonyOS Lite Wearable 的 **JS FA** 工程，不能按 ArkTS Stage 或 Wear OS 编译。

## 当前已经接线的能力

- `storage/BookStorage.js`：应用私有目录多书管理（books/、temp/、progress/），`readBytes` 按字节窗口流式读取，`commitVerifiedBook` 把校验通过的暂存书转正。
- `storage/LibraryIndex.js`：`books.json` 多书索引；只列文件真实存在的书；重复发送同一书籍不覆盖阅读进度。
- `storage/ProgressStore.js`：用 Lite 原生 `@system.storage` 每书单键记录字节偏移和少量上页历史；字号、主题另由 `ReaderPreferences` 保存。没有进度 JSON 文件回退。
- `wear/TransferLogic.js` + `wear/IncomingBookReceiver.js`：按 `protocol` v0 接收 BOOK_META/CHUNK/FINISH，整本 SHA-256 校验通过才入书架；缺块 `E_MISSING_CHUNKS`、摘要不符 `E_DIGEST_MISMATCH`、取消 `E_CANCELLED` 均有处理；失败清理暂存。
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
- `pages/reader`：按路由 `bookId` 打开。**阅读态全屏只显示正文**，不显示标题、
  底栏、页码和按钮；**左滑进入整屏设置**（也可长按正文进入设置），
  **右滑留给 GT4 系统返回手势，不被应用抢占**。设置页点击“继续阅读”
  返回原位置；字号、行距、日夜模式和返回书架都在设置页。
  正文左侧点按回上一页，右侧点按翻下一页；表冠仍尝试翻页
  （目标真机事件待验证）。未知 bookId 不崩溃。
- `wear/WearReceiver.js`：Wear Engine 适配层，版本检查 + 手机 APP ID 门控，消息路由到 `IncomingBookReceiver`。
- `wear/PeerConfig.js` 和 `config.json` 的 `supportLists` 使用**手机 APP ID**（`bundle-info.app-identifier`，不是 OAuth Client ID 或证书 SHA-256）：`com.xiwei.suyue:<APP ID>`。构建脚本从真实手机 profile 注入两处并在结束后恢复；不能把占位文本当作生产值。

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
  > issue #17 复测（2026-10-27）：当前本机工具链的 **release** 构建再次出现
  > `index.bc`/`reader.bc` 快照转换失败（在 #16 基线上同样可复现，非本次代码引入）；
  > `tests/build_artifact_check.sh` 按设计硬失败。当前交付以 **debug 单 BIN 签名 HAP**
  > 为准；release 快照仍需工具链侧修复后重验。
- **包名**：手表 = **`con.xiwei.suyue.gt4`**（`con` 不是笔误：AGC 里
  实际注册的名字，已确认保留），手机 = `com.xiwei.suyue`。
  两者必须互不相同——双端靠包名区分自己与对端，撞名会让配对门控失效。
- 签名走的是**未签名构建 + `hap-sign-tool sign-app`**：hvigor 的
  `signingConfigs` 在这个 legacy Lite 工程上实测失败
  （`SignHap` → `00308018 ENOENT: stat '<dir>/material'`），
  与素笺 CI 采用同一条绕行路径。材料放在 gitignore 掉的
  `signing/` 目录，说明见 [signing/README.md](../../../signing/README.md)。
- **GT4/HDEA 走单 BIN 口径（Issue #4）**：HDEA 解包后只把内部 `entry.bin`
  发到手表，外层 ZIP 签名无效，因此脚本对 HAP 内那**唯一**一个 `*.bin`
  执行 `sign-app -inForm bin`，再原样封回单 BIN HAP。`verify-app -inForm bin`
  对本 0xBE 格式会走 ELF 校验路径、必然报 `verify: elf magic verify failed`，
  属**工具输入格式限制**：脚本把它降级为显式 WARNING
  （`VERIFY_UNSUPPORTED_FOR_LITE_BIN`），**不会**伪造 `Verify success`，
  也不放过签名失败/IO/身份错误；普通 HAP 验签仍严格。签名成功与验签成功
  是两件事，GT4 安装成功又是第三件事（见
  [docs/WATCH_INSTALL.md](../../../docs/WATCH_INSTALL.md)）。
- **从未在真机安装验证**：签名只证明包完整、证书链有效、包名与 profile 一致，
  不代表 GT 4 接受安装（profile 是 debug 类型、绑定 UDID，
  且设备端还会校验包名/UDID/有效期）。
- 图标必须小尺寸：`tools/gen_watch_icons.py` 曾生成 1024×1024 的
  `icon.png`，Lite 资源转换把它展成原始 RGBA（1024²×4+8 = 4,194,312
  字节）塞进 HAP，整包膨胀到 4.45 MB。改成与上游示例一致的
  104×104 / 92×92 后，`.bin` 降到 43,272 / 33,864 字节，HAP 只有
  190 KB 量级。
- CI：`.github/workflows/watch_lite_hap.yml`（自托管 `hmos-deveco` runner；签名材料经 `secrets.WATCH_SIGNING_MATERIAL` 注入；产物只上传本次新产出的 Debug 签名 HAP）。**注意该 job 目前在排队而非运行**：GitHub 托管机装不了 Lite SDK，必须先注册带工具链的自托管 runner。该 workflow 现已直接调用 `tools/build_watch_lite.sh debug`（与本机同源），并删除了对 Lite BIN 必然失败的裸 `verify-app -inForm bin` 步骤；**但自托管 Runner 仍未运行，暂不能称 CI 构建通过**。
- 安装步骤与待验证清单：[docs/WATCH_INSTALL.md](../../../docs/WATCH_INSTALL.md)。
- **尚未在任何真机上安装或运行；`6.1.1(24)` 版本号待 GT 4 真机核对。**

## 书架启动（issue #10，取代 #7/#8 的 books.json 初始化链）

真机反馈（#7 → #8 → #9）证明"先等 books.json 初始化"这条路在 GT 4 上不可靠：会依次卡在
「正在准备本地书库」「导入内置书籍超时」「读取 books.json（第 4 步）」。issue #10 **换掉这条启动架构**：

- **启动不等异步**：`pages/index/index.js` 的 `onInit()` 先用编译期书单
  `books/BookCatalog.g.js`（**只有元数据，没有正文**）**同步**渲染书架并置 `status`，
  随后才在后台 `loadExternal()`（`ensureDirs` → `listBooks`）合并手机传书的外部书。
- 首次安装没有 `books.json`（真实 301）→ **立刻显示空书架**，不再有"第 4 步超时"。
- 外部书加载失败、或文件接口完全不回调，**只**记 `console.error('[suyue] E_EXTERNAL_*')`，
  不阻塞、不覆盖内置书架；损坏的 `books.json` **不会被删除或清空**。
- 书架行标来源：`内置` / `手机`；内置书**不可删除**（提示「《X》是内置书籍，不可删除」），
  手机书仍需二次点击确认删除。
- 已移除：#9 的手动「文件自检」入口、`pages/probe/*`、`WatchFileProbe.js`、
  `BundledBookImporter.js`，以及启动前置链 `prepareLibrary/readIndex/migrateDemo/...` 与重复看门狗。
- Wear Engine 初始化与本地书库分开 try/catch，传书异常只体现在底部 `transferStatus`。

`storage/BookStorage.js` 仍保留 settle-once + `setOperationTimeout`（默认 8s）无回调兜底。

`storage/LibraryIndex.js` 仍是**外部书**目录管理器，保留 #8 的耐久修复：读 `books.json`
不再用单次 `readText({length: 65536})`（Lite 上限 4 KB，超限即 302），改为先 `access`/`get`
探测再分级读；`onDiag` 区分 **301（missing）** 与真实错误（error，附 api+code）；读失败
**绝不**用 `[]` 覆盖旧索引、不删书/进度；写索引用 tmp 回读校验后安全替换并保留 `.bak` 备份，
队列看门狗无回调时向调用方回报结构化超时而不伪造成功。

回归：`tests/watch_shelf_startup.test.mjs`（同步渲染书架、文件层全死也不卡启动、损坏索引不被删、
后台合并外部书、二次删除确认、传书状态隔离）；`tests/watch_index_read.test.mjs`、
`tests/watch_library_index.test.mjs`。

## 内置 TXT：rawfile 资源 + 仅元数据书单（issue #10 复核后）

**路线修正**：#10 最初把正文编译成 JS 数据模块（`BookText_*.g.js` + `BookRegistry.g.js`，
静态 import 全部正文）。实测：3 本书时 `pages/reader/reader.js` 达 **2.1 MB**，对应 HAP 装到
GT 4 报 **错误 34（内部错误）**；而旧 5 本 4.83 MB（正文在 rawfile、JS 很小）能装。
=> 巨型 `reader.js` 与安装失败高度相关（**未证明存在具体字节上限**，不写成"已证实 JS 大小限制"）。
因此改为：**正文放进 rawfile 资源，书单只留元数据，页面 JS 保持 ~60 KB**。

用法：

```bash
# 不带书：与原命令一致，使用仓库里的空书单（书架为空）
tools/build_watch_lite.sh debug

# 带书：把目录里顶层 *.txt 规范化后放进内置 rawfile 资源
WATCH_BOOKS_DIR=/绝对路径/我的书 tools/build_watch_lite.sh debug
```

构建期（`tools/generate_watch_book_modules.py`，复用 `prepare_watch_books.py` 的编码/去重规则）：

- 只认顶层 `*.txt`，稳定排序；UTF-8（含 BOM）/ UTF-16(BOM) / **确定性回退 GB18030**，都失败即非零退出；
  `bookId` = 规范化 UTF-8 的 SHA-256 前 16 位；同内容去重、同名加 ` (2)`；单本上限默认 8 MiB。**从不打印正文**。
- 正文写入临时资源 `entry/src/main/resources/rawfile/gt4books/<bookId>.txt`（真实规范化字节，
  hvigor 会真正打进内层 `entry.bin`）；`books/BookCatalog.g.js` = `export var BOOKS =
  [{bookId,title,bytes,file,sha256,chapters}]` —— **仅元数据，不含正文**；另有 `books_report.json`
  （含每本前 64 字节 base64 `probeB64`）供产物校验。
- 仓库里的 `books/` 与 `rawfile/` 都是临时区：构建前备份、`trap ... EXIT` 还原/清理，
  `.gitignore` 屏蔽之，**私人正文不进公开仓库也不进日志**。
- 产物校验：`tests/build_artifact_check.sh --expect-books-report <json>` 解出内部唯一 `*.bin`，
  逐本确认 `rawfile/gt4books`、`<file>`、`bookId`、`title` 与正文前 64 字节都在，
  打印 `BOOKS_IN_BIN_OK count=N`。
- 构建脚本会打印 `WATCH_PAGE_JS page=... size=...`，用于证明**没有巨型 reader.js**。

阅读（`storage/BundledBookSource.js` + `pages/reader/reader.js`），**按需、只读当前页窗口**：

- **内置书只读私有缓存这一个位置**：先查 `internal://app/gt4reader/cache/<bookId>.txt`。
  已有缓存直接窗口读取；新书没有缓存，就从 `internal://app/rawfile/gt4books/<file>`
  **复制这一本**并检查缓存，然后只读取当前页的窗口。免去原来首次打开前两次无效 rawfile API 探测。
  错误会直接出现在阅读页并指出阶段（缓存检查／首次复制／校验／读取），不再永久显示“正在读取本地文本”。
  仍不把整本书解码进 JS 内存。
- 每个文件调用都有 settle-once 有限超时（`setBundledTimeout`，默认 6s），阅读页不会永久卡住。
- **恢复阅读位置**：先通过 Lite `@system.storage` 读取该书的最新字节位置，再开始按该位置读取正文；**绝不先显示/写回第 0 页**。个人字号、主题设置独立异步加载，缺省的设置键**不再阻挡新书正文读取**；设置若晚到，则在当前位置重排而不重置进度。退出书架前仍等待最后一次保存。进度读取失败会明确报错。进度 KV 的 `setProgressTimeout` 默认 2.5s，正文文件接口单次上限 6s。
- 书架只 import `BookCatalog.g.js`；**阅读页也不再 import 任何正文 JS**。进度仍是 UTF-8 字节 offset，持久化只用 `suyue.pos.<bookId>` 的单一 KV 项（长度小于 128 字节），不再读取或生成 `progress/<bookId>.json`。

构建实测（本机 Hvigor，单 BIN 签名，bundle `con.xiwei.suyue.gt4`）：

| 构建 | 正文合计 | HAP 大小 | reader 页 JS |
| --- | --- | --- | --- |
| 不带书 | 0 | 352,463 B | 61,227 B |
| 3 本（本次交付） | 1,558,122 B | 1,915,308 B | **61,864 B** |

对照：#10 早期 JS 数据模块路线下，3 本的 reader 页 JS 为 **2,140,985 B**（HAP 2.44 MB，GT4 装报 34）。

**未验证**：GT 4 真机上 `internal://app/rawfile/...` 能否被 `@system.file` 读/复制，只能由目标固件判定；
若两步都失败，阅读页会显示真实错误码（不再"看起来成功"）。真机只要两本内置书能打开看到正文即通过。
**GT 4 真机闭环（打开内置书、翻页、字号、日夜、进度）仍待实测，本 issue 暂不可关闭。**

## 章节、冷启动续读与长翻页（issue #17）

- **章节索引在来源侧生成**：内置 TXT 由 `tools/prepare_watch_books.py` 识别行首的
  「第…章/回/卷」「序章/楔子/番外/尾声」「Chapter N」等标题；手机 TXT 导入在
  Harmony `BookImportService.ts` / Android `TxtImportService.kt` 做同一规则。每条只有
  标题和规范化 **UTF-8 字节**起点/长度，绝不用字符下标或页码；识别不到可靠标题时整本
  保持单章「正文」，不截断、不丢字。EPUB 仍沿用原有章节打包。
- **手表章节面板**：阅读设置里新增「章节 · 当前标题」；面板用 Lite 已验证的
  `<list>/<list-item>`（显式高度）只渲染 5 行窗口，另有「上一组/下一组」独立翻页和
  「上一章/下一章」直接跳转。翻组只移动窗口、不跳页；点击具体章节才复用原有
  `loadPage(byteOffset)`，渲染完成后按原进度规则保存。旧书/无索引书没有章节入口，
  但正文、字号、主题和翻页完全不变。
- **长章节目录不能撑爆 4096 字节消息**：Wear Engine P2P 单条 JSON 控制消息上限 4096 字节。
  `BOOK_META` 能装下完整 `chapters` 时保持旧格式；装不下时改为空 `chapters` +
  `chapterChunks`，随后逐条发送 `CHAPTERS`（每条按真实 UTF-8 字节分片，≤4096），再传正文。
  手机 Harmony/Android 两侧发送、手表按 index 幂等收集；目录缺片或校验失败时仅丢弃目录，
  正文仍单独校验大小和 SHA-256 后入库，缺失目录不会阻断阅读。完整目录才用于章节跳转；
  旧手机/旧手表只带完整目录时仍按原协议工作，不会截断正文或改走第二套正文通道。
- **冷启动续读**：`ProgressStore` 另存一个 16 字符 `suyue.last` 键；每本书的真实位置仍是
  `suyue.pos.<bookId>`，不复制进度。书架先同步渲染，再异步读取上次书籍：书还存在且可打开
  才自动进入阅读页；被删除、索引不可用或读取超时则留在书架。显式返回书架会带
  `resume=0`，不会马上又被自动打开；熄屏/`onShow` 不会重复路由。
- **长时间翻页**：外部文件 `openBook/readBytes` 现在也有 settle-once 超时；单次读取
  不回调时阅读页会显示错误并解锁，而不是永久停在 `isLoading`。迟到的底层回调被丢弃。
  压力回归 `tests/watch_reader_stress.test.mjs` 连续翻页 4000 次并穿插前后台切换，
  另有一组真实异步延迟文件回调的交错读取，验证 `pending/isLoading` 归零、历史仍限制在
  60 条、前后台切换不叠加第二次读取。**这只证明代码路径有界，真机长时间卡顿仍需实机复现与确认。**
- 回归：`tests/watch_chapters.test.mjs`、`tests/watch_reader_chapters.test.mjs`、
  `tests/watch_chapter_chunks.test.mjs`、`tests/transfer_logic.test.mjs`、
  `tests/watch_receive.test.mjs`、`tests/prepare_watch_books.test.mjs`、
  `tests/watch_book_modules.test.mjs`、`tests/watch_shelf_startup.test.mjs`、
  `tests/watch_reader_stress.test.mjs`。

## 未完成

- **内置书 rawfile 读取未真机验证**（issue #10）：`internal://app/rawfile/...` 能否被
  `@system.file` 直接读、或被 `file.copy` 复制到私有目录，只能由 GT4 目标固件判定；
  失败时阅读页显示真实接口名与错误码（不假装读到）。
- 手机发书 → 手表接收文件 → 校验 → 加入书架的完整闭环；Wear Engine 文件通道回调字段待真机确认。
- **真机安装与运行**：签名已跑通、包名与 profile 一致，但从未装到
  GT 4 上跑过，`crownStatus()` 仍是 `'unverified'`。
- 表冠翻页：机制已接入并通过纯逻辑单测，但 **GT4 是否真的下发旋转事件、
  每页阈值多少，必须真机实测**（见 `reader/CrownInput.js` 顶部说明）。
- 圆屏正文：Issue #11 使用常驻 `<canvas>` + 轻量字格计算，一页只绘制一次；
  GT4 固件能否实际显示中文仍须真机验证。
- 章节面板、冷启动续读与长时间翻页（issue #17）：Node 压力测试和 HAP 编译已通过，
  但尚未在 GT 4 上实测章节跳转、字号变化后位置、熄屏重开与连续久读。
- 在 GT 4 46mm 上安装、启动、翻页、恢复进度，并核对
  `targetSdkVersion`/`compatibleSdkVersion` 的 `6.1.1(24)`
  是否为 GT 4 开发安装实际可用的版本。**编译通过不等于真机适配通过。**
- 迁移收尾：演示书桥接已删除（`storage/BookFiles.js` 已移除；空书库不再自动重造测试书，只在旧 `demo.txt` 真实存在时迁移）。仍待真机验证迁移路径本身。

## 引用及许可证

代码基于三个 [Lite Wearable MIT 示例](../../../docs/REFERENCES.md) 所介绍的接口与处理方式改造；`WearReceiver.js` 保留了来源声明。完整 MIT 条款及原作者声明放在 [third_party/NOTICE.md](../../../third_party/NOTICE.md) 和相应许可文件中。华为 SDK wrapper 的第三方实现没有打包进来。

## 开发提示

使用支持 Lite Wearable 的 DevEco 打开本目录，配置本机签名以及匹配的 Lite Wearable SDK。`readArrayBuffer` 字节窗口、FA HML 的 `for` 循环与 `$idx` 事件参数、中文分页均需真机测试。不提交签名密钥。

## 圆屏正文：唯一 Canvas 渲染路线（Issue #11）

- **删除旧方案**：已去除圆形模拟的 `<list-item>` 正文、矩形 `compat-text`、
  `canvasVerified`、`getImageData` 像素回读、`measureText` 逐前缀测字、
  `drawSoon` 定时重试、旧矩形分页 `takePage`。**不保留双重渲染/自动回退。**
- **分页**：`reader/PageLayout.takeCanvasPage` 用圆弦安全区域计算每行左右边界；
  文字位置采用单次线性字格计算（中文约 1.14em、西文约 0.72em），在边缘留余量。
  字格是本渲染算法的一部分，而不是字体测量失败后才走的隐藏替代方案。
  UTF-8 按字节推进，换行/跨窗口多字节字符不丢失，`nextOffset` 与阅读存档一致。
- **绘制（GT4 实测错误纠偏）**：`reader/CanvasTextRenderer.drawPage`
  删除对 `clearRect` 的要求，使用**每页一次 `fillRect` 覆盖旧画面**
  再调用每行 `fillText`；字号设置采用原生项目的 `ctx.font='20px'`
  格式，不再使用未经证实的指定字体名。实际 GT4 Lite 开源游戏
  https://github.com/Explore-In-HMOS-Wearable/sportwatch-cacti-hop
  的 `game_screen.js` 同样只使用 `fillRect` 和 `fillText`。
  `getContext('2d')` 已能在设备上返回对象，先前报错
  `unsupported_canvas_api` 是素阅自己的过严方法检查产生的，
  但**无法仅凭旧错误判定具体缺的是哪一项**。新版将分别显示
  `missing_fillRect` 和 `missing_fillText`。不增加任何 HML 正文回退、
  定时重试、逐帧自检或备用渲染器。
- **生命周期**：`onInit` 接到文件数据仅保存 `pending`；
  `onShow` 获取一次 `getContext('2d')` 后绘制。
  如果先有画布、后有数据，则数据回调绘制。设置页打开时不额外绘图；
  返回正文时按最新字号、行距、主题重绘当前页一次。
- **失败行为**：Canvas 初始化或绘制报错，仅显示一次明确错误提示；
  **不试图自动改回矩形 HML 阅读、不死循环重试、不清除原书或进度**。
- **交互保留**：左滑设置、右滑留给系统、点按两侧翻页、表冠机制、
  `@system.storage` 的字号/行距/主题记忆均保留。
- **真机验收**：重点核对启动即有中文、圆周文字不裁切、字体 14/20/32px
  实际变化、设置退出/重开仍保持、连续翻页不死机。
  Node 假 Canvas 测试只覆盖逻辑，**不能代替 Lite Hvigor 和真实 GT4**。

参考旧版手表 JS Canvas 绘字案例：
https://www.cnblogs.com/HarmonyOS/p/14109033.html

### GT4 阅读位置存储约束（Issue #11）

- 读取失败与“从未读过”严格区分：键不存在时打开第一页；`storage.get` 系统错误或数据损坏时显示错误，**不覆盖旧记录**。
- 每次成功翻页保存本页起始字节位置（不是下一页），同时最多记录 8 个最近的上页位置，必要时裁剪最旧历史满足 Lite 小于 128 字节的限制。
- 与正文渲染路线无关：存档只使用 Lite `@system.storage`，不引入文件存档备份或第二种读取机制。字号和主题仍由独立 ReaderPreferences 键值保存。
- GT4 真机还需要验证杀进程后重进、从书架切换书目、软件覆盖升级后的保存效果；本机逻辑测试不替代真实持久化验证。


### 圆屏正文向四周拓宽及独立设置页面（Issue #11）

- 实机已确认 GT4 Lite Canvas 现在能正常绘制中文。原设置页仅 310×390 且背景透明，实际盖在正文上影响阅读；现在设置容器是 **452×452 的不透明深色整屏层**，同时把 `.screen` 在设置打开时切成深色，避免日间模式下出现浅色外圈。字号、行距、日夜、返回书架等控件仍在居中的 310px 安全列，底层 Canvas 保持挂载但不可见，退出设置才重绘。
- 正文 Canvas 从 **420×420 扩至 452×452**；分页 `EDGE_PADDING` 从 **12px 降到 10px**，文字可用安全半径从 **198px 增至 216px**，四周各增加 **18px**（对应约 1–2mm 量级，最终毫米值取决于实际屏幕可视直径，而非 46mm 表壳直径）。仍由圆弦排版，不改排版内核、逐字宽度、绘字 API。
- 只调整 HML/CSS/画布大小和测试，没有修改书库、书籍字节、`@system.storage` 进度及字体记忆，也没有加入另一套正文渲染或性能监控。真机要看设置文字是否完全遮住小说、圆边是否裁字及返回阅读时位置是否正常。
