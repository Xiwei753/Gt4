# 借鉴项目与许可证

> 这里只记录真正用到的**参考源码或设计**，不列依赖或 SDK 安装清单。

## 已对照代码并改造

1. [Explore-In-HMOS-Wearable/sportwatch-how-to-read-large-text-files](https://github.com/Explore-In-HMOS-Wearable/sportwatch-how-to-read-large-text-files)：参考 `FileService.js` 的 `@system.file` 分块读取；改造成 `storage/BookStorage.js` 的 UTF-8 字节窗口和 `storage/ProgressStore.js` 的进度保存（原 `BookFiles.js` 生成器已在第二轮评审后移除）。
2. [Explore-In-HMOS-Wearable/sportwatch-how-to-do-file-operations](https://github.com/Explore-In-HMOS-Wearable/sportwatch-how-to-do-file-operations)：参考 Lite Wearable 文件创建、读写、文件存在性检查、读取缓冲区的调用方式。
3. [Explore-In-HMOS-Wearable/sportwatch-how-to-use-crown](https://github.com/Explore-In-HMOS-Wearable/sportwatch-how-to-use-crown)：参考 `pages/index/index.hml` 的 1×1 透明 `<slider ref="crownProxy">` 与 `index.js` 的 `this.$refs.crownProxy.rotation({focus:true})` + `onchange`，改造成 `reader/CrownInput.js` 的表冠翻页换算器。**GT4 真机是否送达旋转事件尚未验证**，故 `crownStatus()` 返回 `'unverified'`，触屏翻页保留。
4. [Explore-In-HMOS-Wearable/sportwatch-wear-engine-lite-wearable-to-mobile](https://github.com/Explore-In-HMOS-Wearable/sportwatch-wear-engine-lite-wearable-to-mobile)：参考 Wear Engine 的手机包名、签名指纹与消息接收流程；因手机端未接好且真实签名尚未生成，接收默认禁用。

以上四项作者版权均为 Copyright (c) 2025 Explore in HMOS Wearable，MIT 授权；来源快照与完整 MIT 条款见 [third_party/NOTICE.md](../third_party/NOTICE.md)。**不能把示例中附带的华为 Apache-2.0 SDK 包装代码视作 MIT 代码**；本项目未复制它。

## 仅作体验参考

- [yingwang/WatchReader](https://github.com/yingwang/WatchReader)，MIT，Copyright (c) 2026 Ying Wang。参考圆形屏幕的安全正文区域、分页/进度、手机解析 TXT/EPUB 的思路；**其 Wear OS/Kotlin 代码不能直接装 GT4**，此处未复制。

## 仅研究、未复制代码

- [zengchen666/qingdu-reader](https://github.com/zengchen666/qingdu-reader)（Apache-2.0）：研究其 `ChapterTitleMatcher` / `TxtChapterSplitter` 的三阶段章节识别、密集目录去重和章节号 LIS 对齐思路；本项目用独立实现重写为 Harmony/Android/Python 三端同规则，**未复制其源码**。
- 华为 [Reader Kit](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/reader-introduction)：手机端现已通过 `@kit.ReaderKit` 使用官方 `bookParser` 与 `ReadPageComponent`。Kit 只处理当前应用沙箱内的本地文件；官方文档标注 HarmonyOS NEXT 5.0.4 及以上 Phone/PC/2in1/Tablet、仅中国大陆服务且不支持模拟器。Reader Kit 的 `resourceIndex`/`startDomPos` 不等于素阅协议的 UTF-8 字节偏移，未验证可靠映射前只作本机续读锚点，不作为手表同步位置。

## 许可证处理

本仓库原创代码采用 GPL-3.0-only。以上 MIT 项目的原版权声明和许可证全文分别保存在 `third_party/NOTICE.md` 和 `third_party/licenses/Explore-In-HMOS-Wearable-MIT.txt`。后续若复制其他第三方具体文件，需按对应文件许可证单独处理，不默认所有文件都采用 MIT。
