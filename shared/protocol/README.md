# 双端传书协议 v0

**状态：字段规格已定稿为源码级约定，尚未在 GT 4 / 手机真机上跑通。**
手机（ArkTS Stage）与手表（Lite JS）各自实现同一序列化规则；
`tests/protocol.test.mjs` 在 Node 中独立验证字段、幂等、乱序、
断线恢复与摘要异常。

## 基本原则

- 手机负责解析 TXT/EPUB，统一输出 UTF-8；手表负责落盘与阅读。
- 每本书有稳定 `bookId`（内容 SHA-256 前 16 字符）；每次传输有唯一
  `transferId`（手机生成，UUID 或随机十六进制）。
- 大文本按 **UTF-8 字节**切分；块边界可以落在多字节字符中间，
  接收方按字节拼接后再整体解码，绝不在字符中间拆成两个字符串。
- 控制消息用 JSON 文本；`CHUNK` 的数据走**文件通道**（优先，
  见“通道选型”）或消息通道（base64）。
- 接收方对同 `transferId + index` 的重复 `CHUNK` 幂等确认
  （重复 ACK 同一 `index`，不重复落盘）。
- 收到全部块且整本 `sha256` 校验通过后，才把临时文件转为正式书籍。
- 成功以手表回 `RESULT ok=true` 为准；手机侧传输回调不是成功依据。

## 通道选型（先测量，再定默认）

优先测量 Wear Engine **文件通道**能否发送整个暂存文件；
只有受限时才启用**应用层分块**。因此：

- `HELLO.capabilities.fileChannel` 声明是否支持文件通道。
- `chunkBytes` 由双方在 `HELLO` 协商；**协议不预设 4KB**。
  文件读取 API 的默认 4096 字节与 Wear Engine 发送上限不是一回事。
- 未协商或协商失败时，发送方必须停止并报 `E_PROTOCOL`，
  不得擅自假定块大小。

### SDK 映射（以华为 Wear Engine 示例为准，待真机验证）

手机侧（ArkTS Stage，`@kit.WearEngine`）：

- 控制消息（HELLO/BOOK_META/ERROR 等 JSON）：
  `p2pClient.sendMessage(device.randomId, appParam,
  P2pMessage{content: Uint8Array})`
- 整本正文：`p2pClient.transferFile(device.randomId,
  appParam, P2pFile{file: fs.openSync(path)},
  (error, result) => …)`，回调 `result.progress`
  上报进度；**回调成功不等于入库成功**，必须等
  手表 `RESULT`。
- 回执接收：`p2pClient.registerMessageReceiver(
  device.randomId, appParam, callback)`，
  手表的 RESULT/ACK 经此回到手机。
- 取消：`p2pClient.cancelFileTransfer(
  device.randomId, appParam, P2pFile)` 返回
  `Promise<P2pResult>`（比较
  `P2pResultCode.COMMUNICATION_SUCCESS`）；
  取消后向手表发送 `ERROR code=E_CANCELLED`，
  半成品由手表清理。
- `appParam = { remoteApp: { bundleName, fingerprint } }`，
  手机 fingerprint 必须与手表 `supportLists`
  配置一致。

手表侧（Lite JS，`@system.wearengine`）：

- 消息订阅：`wearengine.subscribeMsg`，
  `data.message` 为 JSON 控制消息；
- 文件到达：`data.isFileType` 分支携带文件路径，
  候选字段 `file`/`name`/`uri`/`filePath`（上游示例用
  `data.file`，**以真机回调实测为准**）；收到后
  复制入沙箱、按片校验整本 SHA-256 再入库；
- 回执发送：`wearengine.sendMsg({deviceId, bundleName:
  <手机包名>, abilityName: '', message})`。**`deviceId: 'remote'
  是照上游 Lite 示例写的占位回退值，从未在真机确认过**：
  实现会先从订阅回调里探测真实 `deviceId`
  （候选字段 `deviceId`/`deviceID`/`srcDeviceId`/`srcDeviceID`），
  取到就用真值；取不到才回退并 `console.warn` 一次，
  日志里能看出这条回执走的是未验证路径。
- Manifest 授权：`config.json` 的
  `metaData.customizeData[supportLists]` 必须为
  `<手机包名>:<手机 APP ID>`（HarmonyOS 5.0+ 手机原生应用用
  `bundle-info.app-identifier`，不是证书 SHA-256）；构建期由
  `tools/inject_signing.py` 从真实手机 profile 注入，
  未注入时收不到消息。手机→手表的 `remoteApp` 则使用 GT4 Lite
  公钥身份 `<手表包名>_<Base64(原始 EC 公钥点)>`，两者方向不同。

## 消息 envelope

所有消息均为 JSON 对象，必含 `v`（协议版本，当前 `0`）与 `type`。
除 `HELLO` 外均含 `transferId`。字符串字段一律 UTF-8；
JSON 序列化负责书名等字段的转义，接收方不得对转义结果做二次解码。

### HELLO（双向）

`capabilities`：`formats`（如 `["utf8-text"]`）、`ack`（bool）、
`chunkBytes`（number 或 null）、`fileChannel`（bool）。

### BOOK_META（手机 → 表）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| bookId | string | 是 | 内容 SHA-256 前 16 字符 |
| title | string | 是 | 书名，JSON 转义由序列化保证 |
| encoding | string | 是 | 当前仅 `"utf-8"` |
| bytes | number | 是 | 规范化后 UTF-8 总字节数 |
| sha256 | string | 是 | 规范化后正文的 SHA-256（hex 小写，64 字符） |
| chunks | number | 是 | 块总数（≥1） |
| chunkBytes | number | 是 | 本传输使用的块字节大小 |
| chapters | array | 是 | `[{title, offset, length}]`，字节区间，按序 |

### CHUNK（手机 → 表）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| bookId / transferId | string | 是 | - |
| index | number | 是 | 0-based 块序号 |
| total | number | 是 | 块总数，须等于 BOOK_META.chunks |
| offset | number | 是 | 该块在整本文件中的 UTF-8 字节偏移 |
| length | number | 是 | 该块字节数（末块可以更小） |
| payloadB64 | string | 消息通道必填 | base64 编码的原始字节 |

文件通道：`CHUNK` 控制消息不含 `payloadB64`，数据字节由文件通道
按 `offset` 写入同名 `transferId` 的暂存文件。

### ACK（表 → 手机）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| bookId / transferId / index | string/number | 是 | 收到的块序号 |
| ok | boolean | 是 | 该块落盘成功 |

### FINISH（手机 → 表）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| bookId / transferId / chunks | - | 是 | 发送完毕，请求整体校验 |

### RESULT（表 → 手机）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| bookId / transferId / ok | - | 是 | 整本校验并落盘后才可为 true |
| reason | string | ok=false 必填 | 见错误码 |

### RESUME（双向）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| bookId / transferId / received | - | 是 | 接收方已确认落盘的 `index` 数组 |

断线后发送方发 `RESUME`，只重传缺失块；同一 `transferId` 的
已完成块不重发。

### ERROR（双向）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| code | string | 是 | 见错误码表 |
| message | string | 否 | 可读描述 |
| transferId / bookId | string | 可知时必填 | - |

取消传输用 `ERROR code=E_CANCELLED`。

## 错误码

| code | 含义 |
| --- | --- |
| E_UNSUPPORTED_FORMAT | 格式不在 `formats` 内 |
| E_DECODE | 解码/清洗失败（如 EPUB 有 DRM） |
| E_SPACE | 手表空间不足 |
| E_TIMEOUT | 块超时未达 |
| E_DIGEST_MISMATCH | 整本或块摘要不符 |
| E_MISSING_CHUNKS | FINISH 时仍有缺块 |
| E_DUPLICATE_TRANSFER | 同一 transferId 重复开始且状态不一致 |
| E_CANCELLED | 发送方取消 |
| E_PEER_UNAVAILABLE | 对端未配对/离线/不支持 |
| E_BUSY | 已有另一本在途：单本互斥（第二轮 P0-2） |
| E_PROTOCOL | 协议字段缺失或协商失败 |

## 单本在途（第二轮 P0-2）

手表同一时刻只允许一个 `transferId` 处于接收中：

- 第二个**不同** `transferId` 的 `BOOK_META`：回
  `RESULT ok=false reason=E_BUSY`，不改变当前状态；
- 相同 `transferId` 的重复 `BOOK_META`：视为重启，
  整份替换接收状态（幂等重发）；
- 文件通道到达的文件唯一对应当前在途 `transferId`；
  无在途传输时收到文件：丢弃并回 `E_PROTOCOL`，
  不落盘。

## 时序

```
手机 → 表  HELLO（capabilities，含 chunkBytes/fileChannel）
表 → 手机 HELLO（capabilities 回应）
手机 → 表  BOOK_META
手机 → 表  CHUNK × N        （每块到达后）
表 → 手机 ACK {index, ok}
手机 → 表  FINISH
表       校验 sha256 → 临时文件转正
表 → 手机 RESULT {ok, reason?}
```

## 接收方约束

- 校验失败的半本书**不得**出现在书架；清理暂存文件。
- 空间不足：`E_SPACE`，清理暂存，可恢复。
- 完成后写入书籍元信息及默认阅读进度；再次发送同一书籍
  （同 `bookId`）时不覆盖已有阅读进度。
- 块序号越界、`offset` 不连续、`length` 与 `payloadB64` 解码长度
  不符：`E_PROTOCOL`。

## 对接前要验证

- GT 4 Lite Wearable 的设备配对、Wear Engine 收/发能力、签名和权限；
- HarmonyOS NEXT 手机端是否能使用匹配的 Wear Engine 通信接口；
- 消息和文件通道在真实设备上的上限、行为及回调时序；
- 后台/锁屏状态下的发送和接收；
- Unicode、GBK 等由手机处理后，手表上的中文显示与换页行为。
