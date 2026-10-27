# GT4 Reader 架构与验收

## 目标硬件与运行时

- 华为 WATCH GT 4 **46mm**：466 × 466 圆形屏幕，Lite Wearable / JS FA；不是 Wear OS 或 ArkTS Stage。
- 鸿蒙手机端优先 Pocket 2：HarmonyOS 7 / API 26，ArkTS Stage。
- 双端分别编译、签名，只共享传书协议。
- 手表 APK/手表 HAP、签名证书、SDK 不能凭手机构建流程代替。

## 技术落地

| 子系统 | 实际文件 | 当前状态 |
| --- | --- | --- |
| 手表书架入口 | `watch/huawei/watch-lite/entry/src/main/js/MainAbility/pages/index` | 本地测试书可点击打开（未真机验证） |
| 本地文件 | `storage/BookStorage.js` | 目录、原子提交、窗口读取、进度 JSON；演示书生成器已移除（空库不再重造测试书） |
| 页码 | `reader/PageLayout.js` | UTF-8 解码与**估算字宽**分页，未做字体实测 |
| 手表阅读页 | `pages/reader` | 上/下页、读取最近进度 |
| Wear Engine | `wear/WearReceiver.js` | 消息注册入口；无手机指纹时停用；文件通道复制入沙箱并校验后入库 |
| 手机 | `harmony` | 静态首页，没有选文件或发送能力 |
| 协议 | `protocol` | 草案，未绑定具体 Wear Engine 包 |

## 已知风险

1. 手表 `@system.file.readArrayBuffer` 行为、`position` 是否按字节计算必须实机验证。测试内容明确跨越默认的 4096 字节读入长度。
2. 圆形可视区初步用 316px 内接文本盒，具体文字是否溢出仍须实机校准。
3. 当前分页根据字符宽度估计，**不是精确字体测量**；中英文混排、超长行和不同字体待优化。
4. Wear Engine 示例涉及不同服务版本，现实现首先使用较新服务接口；GT 4 真机可能需要兼容旧版 SDK 包装层。
5. `config.json` 的 `supportLists` 与 `PeerConfig.js` 指纹由构建期注入（`tools/inject_signing.py`），仓库内保持占位/空值；签名确认前不得打开真正传书。
6. 现在仅测试书；要支持 TXT/EPUB 仍需手机端导入、传输完整性校验、书籍索引和临时文件处理。

## 下一轮验收

- [ ] 在 Linux 或 CI 使用匹配的 Lite Wearable 构建工具生成签名 HAP。
- [ ] 在 GT 4 46mm 实机安装、打开，并验证圆形安全区域。
- [ ] 从本地测试书正常翻过 4096 字节以上的字节位置，确认无乱码。
- [ ] 退出并重新打开能恢复进度；快速翻页时不丢失已显示正文。
- [ ] 验证手表 Wear Engine 消息回调、版本与签名匹配关系。
- [ ] 手机导入 TXT 和 EPUB，完成首个小文件收发及回执。
- [ ] 大书分块、校验、重试、断点恢复。

不要把代码结构完整误写成「能直接在 GT 4 使用」。
