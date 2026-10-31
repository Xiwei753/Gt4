# Issue #26 翻页复现记录

- 时间：2026-10-31 18:35–18:38（Asia/Shanghai）
- 设备：HUAWEI Pocket 2，HarmonyOS 26
- 仓库版本：`167b561089d33bea17c27485f912c5749d54e854`
- HAP SHA-256：`e6dcc37975f307bf16a6761b83bc93610f139f35a1ef4b7ee1e1e71f1c679d2d`
- 应用诊断导出成功；JSONL 只保留本次复现的阅读输入、翻页、视口和进度事件。
- Hilog 只保留本次时段内 `suyue/ReaderInput` 的七种翻页来源，共 26 行。

## 操作

从已恢复的阅读位置开始，点“调试下一页”；关闭设置后依次进行右点、左点、左滑、右滑，再用 UI 自动化注入音量减/加键事件。最后返回书架并导出诊断 JSONL。

设置打开时的两次点按被记录为 `settings_open`，属于预期门禁。设置关闭后，左右点按、左右滑动和音量键回调都进入了翻页请求。音量键由 UI 自动化注入，不代表物理按键验收。

## 观测

本次 7 个 `page_load_ok` 请求均有 `pageRequestCurrent=true`、`readerReady=true`、`loading=false`，目标 UTF-8 字节偏移前进或回退；但每个请求都是 `pageTextChanged=false`。Hilog 对应记录为 `stage=page_load_ok reason=text_unchanged`。设置关闭后的右点前后，阅读区域截图裁剪 SHA-256 均为 `5f951a473774e3479d411755398b35da77f39dd68f01e7135a2c56065bdc1468`。

因此，输入事件已到达，页请求也报告完成，但正文内容没有变化。此次只采集和复现，没有修改代码。文件不含书中文字、书名或正文路径；截图未入库。
