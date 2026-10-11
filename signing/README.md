# 签名材料目录（内容不入库）

**本目录下的密钥、证书、profile、口令一律不提交。**
`.gitignore` 用两条独立规则兜底：`/signing/*`（本目录只放行本 README）
以及按扩展名的 `*.p12` / `*.cer` / `*.p7b` / `*.csr`。
新增文件后请用 `git check-ignore -v <文件>` 复核，别只看 `git status`
（被忽略的文件在 `git status` 里本来就不显示，容易误判为"已提交"）。

## 布局

按用途分目录。**不要把它们平铺在一起**：手机和手表是华为侧两个独立
应用，各自的 profile 放在同一层会互相顶替（脚本按名字取第一个匹配文件）。

```text
signing/
├── README.md
├── shared/                      两端共用
│   ├── shared-signing-key.p12   ECDSA P-256 私钥（别名 sujian_signing_20261007）
│   ├── debug.cer                账号级调试证书链（3 张：叶+中间+根）
│   └── credentials.env          p12 口令（KEY_ALIAS/STORE_PASSWORD/KEY_PASSWORD）
├── phone/
│   └── debug.p7b                手机（com.xiwei.suyue）的调试 profile
└── watch/
    └── debug.p7b                手表（con.xiwei.suyue.gt4）的调试 profile
```

## 什么能复用，什么不能

此前文档写成了"素笺的证书不能复用"，容易被读成整套材料都不能用，
**不准确**。实测结论如下。

**私钥可以复用。** 素笺、手机素阅、手表素阅用的是同一对密钥，公钥指纹一致：

```text
素笺 p12 内的证书公钥   : 3df9743c1798f495ca22e2960affe26289d9a1fdf229abc16c9b67f460a61360
素阅 profile 内开发证书 : 3df9743c1798f495ca22e2960affe26289d9a1fdf229abc16c9b67f460a61360
```

**证书也可以复用**——它是**账号级**的，不是按应用签发的。把两个 profile
内嵌的 `development-certificate` 取出来算 DER-SHA256，结果完全相同：

```text
手机 profile (com.xiwei.suyue)      证书 DER-SHA256 = fbdee2e124a2232509b1c614d452bded…
手表 profile (con.xiwei.suyue.gt4)  证书 DER-SHA256 = fbdee2e124a2232509b1c614d452bded…
```

两者真正不同的是 `app-identifier`（手机与手表各一个）。
**手机的这个值同时就是它要写进 `module.metadata` 的**
**应用级 Client ID，属于应用唯一身份，本文件不再记录具体数字**；
需要时从 AGC 或本地 profile 读取，真实值放
`signing/phone/client_id.env`（已 gitignore）。

**只有 profile 是按应用的**，它把包名、设备 UDID、有效期绑在一起：

| | 手机 | 手表 |
|---|---|---|
| `bundle-name` | `com.xiwei.suyue` | `con.xiwei.suyue.gt4` |
| `app-identifier` | （见 AGC/本地 profile，不落库） | （见 AGC/本地 profile，不落库） |
| `type` | `debug` | `debug` |
| `device-id-type` | `udid` | `udid` |
| 授权设备 | 2 个 UDID | 1 个 UDID（GT 4） |
| 有效期 | 2026-10-09 → 2027-10-09 | 同 |
| `developer-id` / `issuer` | `70086000204331993` / `app_gallery` | 同 |

## ⚠️ 手表包名是 `con.xiwei.suyue.gt4`，`con` 不是笔误

AGC 里建手表应用时把 `com` 打成了 `con`，**已确认保留**。原因很实在：

- 华为的 `bundleName` 注册后**不能改**；
- HAP 的包名必须与 profile 授权的包名**逐字相同**才能安装。

所以别"顺手修正"成 `com.xiwei.suyue.gt4`——一改就签不过、也装不上。
`tools/build_watch_lite.sh` 的包名预检会直接拒绝签名，
`tests/source-contract.test.mjs` 也钉住了这个名字。

## 包名预检（很值得留着的一道闸）

`tools/build_watch_lite.sh` 在签名前会比对 profile 的
`bundle-info.bundle-name` 与 HAP 的 `app.bundleName`，不一致就**拒绝签名**、
退回未签名产物。这个坑非常隐蔽：

```text
拿手机 profile（com.xiwei.suyue）去签手表 HAP：
  hap-sign-tool  -> Sign Hap success!
  verify-app     -> Digest verify result: true / Verify success
但设备按包名校验会拒绝安装——"签名成功"完全没有意义。
```

## 用法

- **手表（本地已跑通，产出已签名 HAP）**：`tools/build_watch_lite.sh release`。
  脚本按 `WATCH_SIGN_*` 环境变量 → `signing/shared` + `signing/watch` 的
  顺序找材料，找到且**包名匹配**时自动走：未签名构建 →
  `hap-sign-tool sign-app` → `verify-app`，产物
  `entry-default-<mode>-signed.hap`。实测结果（含包内嵌 profile 的
  解析）见 [../docs/WATCH_INSTALL.md](../docs/WATCH_INSTALL.md)。
- **不要用 hvigor 的 `signingConfigs`**：本机实测在该 legacy Lite 工程上
  `SignHap` 直接失败（`00308018 ENOENT: stat '<dir>/material'`），
  即使配置形状与 Stage 工程一致。素笺 CI 用的也是绕行路径。
- **CI（源码已修，仍待 runner 执行）**：`watch_lite_hap.yml` 改用
  `inject_signing.py --external-signing` 只注入身份/Manifest，并将签名凭据
  放在临时目录；`build_watch_lite.sh` 负责 `sign-app` + `verify-app`。
  自托管 runner 尚未执行，不能视为 CI 成功。
- 注意 `verify-app` 的 `-outCertChain` 必须用 `.cer` 后缀；
  用 `.crt` 会报 `Error Message: Not support file`（实测）。
