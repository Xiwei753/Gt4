# 素阅手机端 · HarmonyOS NEXT

独立 ArkTS Stage 工程，优先面向 Pocket 2（HarmonyOS 7 / API 26）。

## 页面与书库

- 首页只有「书架」「传书」两个底部 Tab。
- `pages/Index.ets` 从 `BookRepository` 读取同一份书库。书架支持最近阅读、名称、导入时间和手动排序；手动顺序与排序方式持久化。
- 系统文档选择器导入 TXT/EPUB。书籍先保留供手表传输的规范化 UTF-8 文件；EPUB 另存原始文件供 Reader Kit 解析。旧书记录兼容：TXT 可直接用规范化文件，旧 EPUB 缺原文件时提示重新导入且保留现有数据。
- `pages/Reader.ets` 使用 `@kit.ReaderKit` 的 `bookParser`、`ReaderComponentController` 和 `ReadPageComponent`。初始化顺序为 controller → parser → register → page config → startPlay。阅读页支持目录、字号、行高、深浅主题、仿真/横向滑页，并按实际视口和显示缩放更新排版。
- `services/ReaderKitStateStore.ts` 保存 Kit 的 `resourceIndex + startDomPos` 和阅读设置；它与现有手表协议字节偏移分开。
- `services/ReaderDiagnostics.ts` 写入有界 JSONL 日志，只记录阶段、时间、错误码；书架可通过系统文档选择器导出。

## 手表传书与进度

- `services/BookTransferService.ts` 使用 Wear Engine 设备发现、目标选择、控制消息和文件通道。章节目录分片是可选元数据；`transferFile` 成功回调只报告文件已发送，手表校验与入库结果未知。
- 双向进度同步仍使用协议中的规范化 UTF-8 字节偏移。Reader Kit 返回的 `resourceIndex`/`startDomPos` 不是该偏移；在可靠映射完成前，开始使用 Reader Kit 的书籍会从位置同步中排除，旧字节位置和手表记录保留，其它可映射书籍仍可同步。页面明确提示此限制。
- Reader Kit 的使用范围按官方文档为 HarmonyOS NEXT 5.0.4 及以上 Phone/PC/2in1/Tablet，仅中国大陆可用，且不支持模拟器。API 声明可编译不代表目标设备的服务、解析、翻页或真机续读已通过。

## 构建

- `tools/build_phone_hap.sh debug` 需要 DevEco `hvigorw`、API 26 SDK、应用 Client ID、手机签名材料和 GT Lite 公钥身份。敏感材料放在被忽略的 `signing/` 目录中，构建脚本不会提交或输出密码。
- `.github/workflows/phone_hap.yml` 使用自托管 `hmos-deveco` runner。
- 源码编译、签名/摘要校验、HAP 安装、Reader Kit 初始化和 Pocket 2 阅读验收是不同层级；应分别记录实际结果。

更多信息：[构建与传书](../docs/BUILD_AND_TRANSFER.md)、[协议](../protocol/README.md)、[签名材料](../signing/README.md)。
