# 素阅手机端 · HarmonyOS NEXT

独立 **ArkTS Stage** 工程，优先面向 Pocket 2（HarmonyOS 7 / API 26）。

## 已实现（源码级，未在 DevEco 编译/真机验证）

- `entry/src/main/ets/pages/Index.ets`：真实书库列表 + 文档选择器导入；
  选择文件 ≠ 导入成功，只有沙箱复制、解析、登记后才显示 `ready`。
- `services/BookImportService.ets`：读取授权 URI（分块）、SHA-256、
  规范化 UTF-8、写入应用私有 `files/books/<bookId>.txt`、登记书库。
- `services/TextDecodeService.ets`：UTF-8/UTF-16 BOM 与 UTF-8 校验，
  GBK/GB18030 尝试解码；解码不可用时明确报错，不静默乱码。
- `services/EpubImportService.ets`：无 DRM EPUB 解包（container.xml →
  OPF → spine 顺序）、XHTML 清洗为纯文本、保留章节标题。
- `services/ZipReader.ets`：纯 JS ZIP 中央目录 + inflate，含路径穿越、
  zip bomb、CRC-32 防护；由 `tests/zip_inflate.test.mjs` 在 Node 中验证。
- `services/BookRepository.ets`：`library.json` 索引，重启不丢书，
  重复导入幂等，删除同时清理索引与正文文件。
- `model/BookModels.ets`：BookMeta/Chapter/Status 统一模型。
- `services/WearDeviceService.ets`：Wear Engine 设备发现与 P2P。
  客户端惰性创建（失败保留 `stage/code/message`，构造器不抛）；
  传书只需「设备基础信息」服务审批，**不申请运行时权限**
  （`requiredPermissions()` 为空，授权查询/申请为无操作兼容接口）；
  发现用 `getConnectedDevices`，同一时间只允许 1 个在途查询并复用结果；
  `isRemoteAppInstalled` 核对、`registerMessageReceiver` 回执接收；
  设备由用户选择，不默认第一台。失败阶段与 `BusinessError.code`
  结构化返回，不再一律 `E_PEER_UNAVAILABLE`。
- `services/WearAuthPolicy.js`：纯逻辑（无 SDK 依赖，Node 可测）：
  错误码分类（1008500004 未申请服务 / 1008500005 未授权 /
  1008500006 未同意隐私 / 401 参数非法 / 201 与其它保留原始码）、
  设备发现的用户文案；确定性失败不自动重试，仅网络/断连错误按
  1s/2s/4s 上限退避；`runDeviceRefresh` 保证只有最新一轮结果落地，
  异常也会复位 busy；「空列表」≠「未配对/蓝牙没连」。
- `services/BookTransferService.ets`：按协议序列发送
  HELLO → BOOK_META → `transferFile` 文件通道 →
  等手表 RESULT；进度/取消/超时/重试（只重试可恢复
  错误）；**transferFile 回调成功不等于入库**，
  以手表 RESULT 为准。
- `model/TransferModels.ets`：传输进度/状态/错误码
  （与协议错误码对齐）。
- `pages/Index.ets`：书架列表 + 设备选择 + 发送，
  实时进度/失败提示；「发送到 GT 4」卡片先显示 Wear Engine
  **授权状态**并提供「授权手表访问」入口，未授权/被拒/未审批/
  空列表各自给出可区分文案；未选设备或未配置指纹时发送禁用。

## 未完成

- Wear Engine 真机互通（GT 4 + Pocket 2）：**用户授权拉起**
  （`requestAuthorization` 弹窗与结果）、设备发现、签名指纹核对、
  `transferFile` 与回执时序均**待验证**。授权入口在素阅应用内
  「发送到 GT 4」卡片，**不需要**（也找不到）走运动健康的
  「设备能力开放 / 应用授权」入口。
- 手机签名指纹读取（当前为空，发送保持禁用）。
- 在 Pocket 2 上编译、签名、安装与真机验证（当前没有编译产物）。
- GBK 解码在目标系统的实际可用性属于**待验证**项。

## 构建

- `tools/build_phone_hap.sh`（需要 DevEco `hvigorw` + API 26 SDK）。
- `.github/workflows/phone_hap.yml`：自托管 `hmos-deveco` runner，
  签名材料经 `secrets.PHONE_SIGNING_MATERIAL` 注入。

- UI：`entry/src/main/ets/pages/Index.ets`
- Ability：`entry/src/main/ets/entryability/EntryAbility.ets`
- 共享协议：`../../shared/protocol/README.md`
- 构建/安装准备：`../../docs/BUILD_AND_TRANSFER.md`
