// SPDX-License-Identifier: GPL-3.0-only
// 静态结构检查，不调用 SDK、不能取代两端 HAP 编译。
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const read = (path) => readFileSync(path, 'utf8');
const watchConfig = JSON.parse(read('apps/watch/entry/src/main/config.json'));
const phoneManifest = read('apps/phone/entry/src/main/module.json5');
const phoneIndex = read('apps/phone/entry/src/main/ets/pages/Index.ets');
const phoneAppJson = JSON.parse(read('apps/phone/AppScope/app.json5'));
const watchPages = watchConfig.module.js[0].pages;
assert.equal(watchConfig.module.deviceType[0], 'liteWearable');
assert.deepEqual(watchPages, ['pages/index/index', 'pages/reader/reader']);
for (const page of watchPages) {
  for (const ext of ['js', 'hml', 'css']) {
    assert.ok(existsSync('apps/watch/entry/src/main/js/MainAbility/' + page + '.' + ext));
  }
}
assert.equal(watchConfig.module.abilities[0].icon, '$media:icon');
assert.ok(existsSync('apps/watch/entry/src/main/resources/base/media/icon.png'));
assert.ok(existsSync('apps/watch/entry/src/main/resources/base/media/icon_small.png'));
assert.ok(phoneManifest.includes('stageMode') === false, 'module is a Stage manifest, not a lite JS manifest');
// issue #6 P0-A：Wear Engine 读取设备前先从 module.metadata 取应用级
// client_id；缺失会在设备发现时报 1008509999（应用身份未配置）。
// 真实 Client ID 是该应用的唯一身份、随 HAP 分发，不入库：仓库里只保留
// 占位符，构建期由 tools/build_phone_hap.sh / tools/inject_client_id.py
// 从被 gitignore 的 signing/phone/client_id.env 注入，构建结束还原。
const CLIENT_ID_PLACEHOLDER = 'CONFIGURE_WITH_AGC_CLIENT_ID';
const clientIdMatch = phoneManifest.match(
  /"name"\s*:\s*"client_id"\s*,\s*"value"\s*:\s*"([^"]*)"/);
assert.ok(clientIdMatch, 'phone module.json5 must declare client_id metadata');
assert.equal(clientIdMatch[1], CLIENT_ID_PLACEHOLDER,
  'repo must keep the client_id placeholder (real value injected at build time)');
assert.ok(!/"value"\s*:\s*"[0-9]{10,}"/.test(phoneManifest),
  'phone module.json5 must not contain a committed numeric Client ID value');
const phoneClientIdInjector = read('tools/inject_client_id.py');
assert.ok(phoneClientIdInjector.includes(CLIENT_ID_PLACEHOLDER),
  'client id injector must guard the placeholder');
assert.ok(phoneClientIdInjector.includes('--client-id'),
  'client id injector must take the real value as an argument, not embed it');
assert.ok(read('tools/build_phone_hap.sh').includes('signing/phone/client_id.env'),
  'phone build must load the real Client ID from the gitignored local file');
assert.ok(phoneIndex.includes('DocumentViewPicker'), 'phone must expose a real document picker');
assert.ok(phoneIndex.includes('importBook'), 'phone index must run a real import flow');
assert.ok(phoneIndex.includes('BookRepository'), 'phone index must list a real library');
assert.ok(phoneIndex.includes('素阅'), 'displayed app name');
assert.equal(JSON.parse(read('apps/watch/entry/src/main/resources/base/element/string.json')).string[0].value, '素阅');
assert.ok(phoneAppJson.app.icon === '$media:app_icon', 'phone app icon must exist');
assert.ok(existsSync('apps/phone/AppScope/resources/base/media/app_icon.png'));
for (const svc of ['BookImportService', 'TextDecodeService',
  'EpubImportService', 'BookRepository', 'ZipReader',
  'WearDeviceService', 'BookTransferService']) {
  assert.ok(existsSync('apps/phone/entry/src/main/ets/services/' + svc + '.ts'),
    'phone service missing (pure logic layer lives in .ts): ' + svc);
}
assert.ok(existsSync('apps/phone/entry/src/main/ets/model/BookModels.ts'));
assert.ok(existsSync('apps/phone/entry/src/main/ets/model/TransferModels.ts'));
const phoneIndexFull = read('apps/phone/entry/src/main/ets/pages/Index.ets');
assert.ok(phoneIndexFull.includes('listDevices'),
  'phone index must discover devices');
assert.ok(phoneIndexFull.includes('registerMessageReceiver'),
  'phone index must register for watch RESULT');
assert.ok(phoneIndexFull.includes('RESULT'),
  'phone must wait for watch RESULT receipt');
assert.ok(phoneIndexFull.includes('transferService'),
  'phone index must use BookTransferService');
// issue #6 P0-B：设备发现必须用有上限的退避重试策略，且确定性失败不自动重试。
const phoneDeviceService = read('apps/phone/entry/src/main/ets/services/WearDeviceService.ts');
const phonePolicy = read('apps/phone/entry/src/main/ets/services/WearAuthPolicy.js');
assert.ok(phonePolicy.includes('app_client_id_not_configured'),
  'policy must classify 1008509999 as app identity misconfiguration');
assert.ok(phonePolicy.includes('planRetry') && phonePolicy.includes('isRetryable'),
  'policy must expose a bounded retry state machine');
assert.ok(phoneIndexFull.includes('planRetry'),
  'phone index must gate auto-retry through planRetry');
assert.ok(phoneIndexFull.includes('clearRetryTimer'),
  'phone index must clean up retry timers on hide');
assert.ok(phoneDeviceService.includes('deviceQueryInFlight'),
  'device service must serialize device discovery (single in-flight query)');
assert.ok(read('README.md').startsWith('# 素阅 · suyue'));
assert.ok(read('docs/BUILD_AND_TRANSFER.md').includes('尚未产出任何 HAP'));
const protocolReadme = read('shared/protocol/README.md');
for (const t of ['BOOK_META', 'CHUNK', 'ACK', 'FINISH', 'RESULT',
  'RESUME', 'ERROR', 'E_MISSING_CHUNKS', 'E_DIGEST_MISMATCH']) {
  assert.ok(protocolReadme.includes(t),
    'protocol spec must define ' + t);
}
for (const ex of ['hello', 'book-meta', 'chunk', 'ack', 'result',
  'resume', 'error']) {
  assert.ok(existsSync('shared/protocol/examples/' + ex + '.json'),
    'protocol example missing: ' + ex);
}
// 手表端：新书库/接收器/工具模块必须存在，且页面
// 不再引用 getDemoBook 作为阅读入口。
const watchFiles = [
  'storage/BookStorage.js',
  'storage/LibraryIndex.js',
  'storage/ProgressStore.js',
  'storage/BundledBookImporter.js',
  'wear/IncomingBookReceiver.js',
  'wear/TransferLogic.js',
  'wear/WearReceiver.js',
  'util/Sha256.js',
  'util/Utf8.js',
  'util/Base64.js',
  'reader/PageLayout.js',
  'reader/ReaderSettings.js',
  'reader/CrownInput.js'
];
for (const rel of watchFiles) {
  assert.ok(existsSync('apps/watch/entry/src/main/js/MainAbility/' + rel),
    'watch module missing: ' + rel);
}
const watchReader = read('apps/watch/entry/src/main/js/MainAbility/pages/reader/reader.js');
assert.ok(!watchReader.includes('getDemoBook'),
  'reader must open by bookId, not the demo getter');
assert.ok(watchReader.includes('router.getParams'),
  'reader must read bookId from router params');
assert.ok(watchReader.includes('normalizeSettings'),
  'reader must use ReaderSettings as single truth');
assert.ok(watchReader.includes('createCrownTracker'),
  'reader must route crown rotation through CrownInput tracker');
const toggleThemeBody = watchReader.slice(
  watchReader.indexOf('  toggleTheme() {'),
  watchReader.indexOf('  // 展开/收起设置行'));
assert.ok(toggleThemeBody.includes('saveProgress(') &&
  toggleThemeBody.includes('this.currentSettings()'),
  'theme switch must persist settings without waiting for another page turn');
assert.ok(watchReader.includes('crownProxy'),
  'reader must own the hidden slider ref used as crown proxy');
const crownInput = read('apps/watch/entry/src/main/js/MainAbility/reader/CrownInput.js');
assert.ok(crownInput.includes("'unverified'"),
  'crown input must not claim verified support without a device run');
const watchIndex = read('apps/watch/entry/src/main/js/MainAbility/pages/index/index.js');
assert.ok(watchIndex.includes('listBooks'),
  'index page must list the real library');
assert.ok(watchIndex.includes('askDelete'),
  'index page must support delete');
// 书架行不能同时绑定「打开」和子元素「删除」：
// Lite >= API6 点击会冒泡，删书会顺手打开阅读页。
const shelfHml = read('apps/watch/entry/src/main/js/MainAbility/pages/index/index.hml');
assert.ok(!/<div class="book-row"[^>]*onclick=/.test(shelfHml),
  'book row must not open when the child delete button is clicked');
assert.ok(shelfHml.includes('class="book-info" onclick="openBook($idx)"'),
  'book info must remain separately clickable');
assert.ok(shelfHml.includes('class="book-delete" onclick="askDelete($idx)"'),
  'delete must have its own click target');
assert.ok(watchIndex.includes("event.type === 'RESULT'") &&
  watchIndex.includes('this.refresh();'),
  'watch shelf must refresh after a successful receive');
// issue #8：启动初始化必须有可见阶段、超时兜底、错误码和重试入口，
// 不能再永久停在"正在准备本地书库"。
assert.ok(watchIndex.includes('E_INIT_TIMEOUT') &&
  watchIndex.includes('setTimeout'),
  'shelf init must have a timeout fallback');
assert.ok(watchIndex.includes('E_DIRS_') &&
  watchIndex.includes('E_INDEX_READ'),
  'shelf init must surface stage error codes on screen');
assert.ok(watchIndex.includes('retryInit') &&
  shelfHml.includes('onclick="retryInit"'),
  'a failed shelf init must offer an on-screen retry');
const watchStorage = read('apps/watch/entry/src/main/js/MainAbility/storage/BookStorage.js');
assert.ok(watchStorage.includes('setOperationTimeout'),
  'storage file ops must have a no-callback timeout guard');
const watchIndexStore = read('apps/watch/entry/src/main/js/MainAbility/storage/LibraryIndex.js');
assert.ok(watchIndexStore.includes('setQueueTimeout') &&
  watchIndexStore.includes("'missing'"),
  'index queue must expose a watchdog and distinguish missing vs error');

// ---- Lite 运行时能力守门 ----
// 依据（本机 HarmonyOS Command Line Tools 26.0.0 / API 26 实测）：
// ace-loader 用 jerry-snapshot 把每个页面 JS 转成 .bc；该 JerryScript
// 构建**没有 RegExp**——正则字面量在解析期报 SyntaxError，快照生成
// 失败；而 lite-snapshot-plugin 只打印一行错误、**不会让构建失败**，
// 于是 HAP 里缺少该页 .bc，构建显示 BUILD SUCCESSFUL，页面在手表上
// 却起不来。曾在 reader.js/TransferLogic.js/BookStorage.js 命中此坑。
// 这里扫描手表源码，禁止再次引入正则与实测缺失的 API。
const WATCH_JS_ROOT = 'apps/watch/entry/src/main/js/MainAbility';
const watchJsFiles = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (name.endsWith('.js')) watchJsFiles.push(full);
  }
})(WATCH_JS_ROOT);

// 把注释与字符串内容抹成空格（保留换行以便报行号），
// 两道检查都基于这份代码骨架——注释里提到 RegExp 不算违规。
function stripToCode(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length &&
             !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      out += c;
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') { i += 2; continue; }
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// 判断 `/` 是否落在正则位置：它前面最近的有意义字符
// 只能是表达式起始符，否则是除号。
function findRegexLiterals(code) {
  const regexPrefix = '(,=:[!&|?{};+-*%~^<>';
  const hits = [];
  let prev = '';
  let line = 1;
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === '/') {
      if (prev === '' || regexPrefix.indexOf(prev) !== -1) {
        hits.push(line);
      }
      prev = '/';
      i++;
      continue;
    }
    if (c !== ' ' && c !== '\t' && c !== '\r') prev = c;
    i++;
  }
  return hits;
}

// 实测不可用的 API（Node/ArkTS 有、Lite 的 JerryScript 没有）。
const MISSING_APIS = [
  ['new RegExp', 'RegExp 构造函数在 Lite 运行时不存在'],
  ['padStart', 'String.prototype.padStart 缺失'],
  ['padEnd', 'String.prototype.padEnd 缺失'],
  ['DataView', 'DataView 缺失'],
  ['replace(', 'String.replace 仍依赖正则实现，Lite 下抛 TypeError'],
  ['match(', 'String.match 依赖正则，Lite 下不可用'],
  ['search(', 'String.search 依赖正则，Lite 下不可用']
];

for (const file of watchJsFiles) {
  const code = stripToCode(read(file));
  const lines = findRegexLiterals(code);
  assert.equal(lines.length, 0,
    `${file} 含正则字面量（第 ${lines.join(', ')} 行）：` +
    'Lite 的 JerryScript 没有 RegExp，会导致页面 .bc 快照生成失败，' +
    '构建仍报成功但手表上打不开该页。请改用字符比较（见 util/Validate.js）。');
  for (const [api, why] of MISSING_APIS) {
    assert.ok(!code.includes(api), `${file} 使用了不可用 API「${api}」：${why}`);
  }
}

// ---- 施工单复核（issue #1 第二轮）静态检查 ----
// P0-1/P0-2：双端身份分离，手机不得把
// 自己的包名当 remoteApp。
const peerIdentity = read(
  'apps/phone/entry/src/main/ets/model/PeerIdentity.ts');
assert.ok(peerIdentity.includes('PHONE_SELF'),
  'PeerIdentity must define PHONE_SELF');
assert.ok(peerIdentity.includes('WATCH_PEER'),
  'PeerIdentity must define WATCH_PEER');
// issue #2：手机与手表是华为侧**两个独立应用**：
//   手机 com.xiwei.suyue      （AGC 证书里写定的名字）
//   手表 con.xiwei.suyue.gt4  （注意是 con 不是 com —— AGC 里当初打错，
//                              已确认保留；bundleName 注册后改不了，
//                              且必须与 profile 逐字一致才能安装）
const WATCH_BUNDLE = 'con.xiwei.suyue.gt4';
const PHONE_BUNDLE = 'com.xiwei.suyue';
assert.ok(
  peerIdentity.includes("'" + PHONE_BUNDLE + "'") &&
  peerIdentity.includes("'" + WATCH_BUNDLE + "'"),
  'both peer bundle names must be defined');
assert.equal(watchConfig.app.bundleName, WATCH_BUNDLE,
  'watch Manifest bundleName must equal what the watch peer config declares');
assert.ok(
  read('apps/watch/entry/src/main/js/MainAbility/wear/PeerConfig.js')
    .includes("'" + WATCH_BUNDLE + "'"),
  'watch PeerConfig must self-report the same bundle name as its Manifest');
// 两个包名不能撞在一起：手机与手表是各自独立的 HAP。
assert.notEqual(PHONE_BUNDLE, WATCH_BUNDLE,
  'phone and watch bundle names must differ');
assert.equal(phoneAppJson.app.bundleName, PHONE_BUNDLE,
  'phone AppScope bundle must match PHONE_SELF');
const watchBuildScript = read('tools/build_watch_lite.sh');
assert.ok(watchBuildScript.includes("--bundle '" + WATCH_BUNDLE + "'"),
  'watch build script must verify the configured GT4 bundle');
const watchWorkflow = read('.github/workflows/watch_lite_hap.yml');
assert.ok(watchWorkflow.includes('--bundle ' + WATCH_BUNDLE),
  'watch workflow must verify the configured GT4 bundle');
assert.ok(!phoneIndexFull.includes('phoneFingerprint'),
  'phone index must not carry a loose phoneFingerprint');
assert.ok(phoneIndexFull.includes('WATCH_PEER'),
  'phone index must use the watch peer identity');
assert.ok(phoneIndexFull.includes('isConfigured'),
  'phone index must gate sending on identity config');
const transferService = read(
  'apps/phone/entry/src/main/ets/services/BookTransferService.ts');
assert.ok(transferService.includes('peer: { bundleName'),
  'sendBook must take the peer identity object');
// remoteApp 只能由对端身份构造。
assert.ok(!transferService.includes(
  "registerMessageReceiver(device, BUNDLE_NAME"),
  'phone must not pass its own bundle as remoteApp');

// P0-3：BookMeta 携带消息通道分块描述。
const bookModels = read(
  'apps/phone/entry/src/main/ets/model/BookModels.ts');
assert.ok(bookModels.includes('chunks: number'),
  'BookMeta must declare chunks');
assert.ok(bookModels.includes('chunkBytes: number'),
  'BookMeta must declare chunkBytes');
const importService = read(
  'apps/phone/entry/src/main/ets/services/BookImportService.ts');
assert.ok(importService.includes('chunks,'),
  'import must populate chunks in the meta');
assert.ok(importService.includes('chunkBytes:'),
  'import must populate chunkBytes in the meta');

// P0-4：摘要必须对 normalized 字节计算，
// 且写后复核。
assert.ok(importService.includes(
  'sha256Hex(normalized)'),
  'digest must be computed over normalized bytes');
assert.ok(importService.includes('readFileBytes'),
  'import must verify the written file (post-write check)');
assert.ok(!importService.includes(
  'const digest = await sha256Hex(raw)'),
  'digest must not be computed over the raw file');

// P0-5：文件通道必须复制落盘后校验，不能
// 直接 commit 外部 tempUri。
const watchReceiver = read(
  'apps/watch/entry/src/main/js/MainAbility/wear/WearReceiver.js');
assert.ok(watchReceiver.includes('isFileType'),
  'watch receiver must handle the file channel branch');
assert.ok(watchReceiver.includes('receiveFile('),
  'watch receiver must route files to the receiver');
const incomingReceiver = read(
  'apps/watch/entry/src/main/js/MainAbility/wear/IncomingBookReceiver.js');
assert.ok(incomingReceiver.includes('copyFile('),
  'file channel must copy the received file into the sandbox');
assert.ok(incomingReceiver.includes('verifyFile('),
  'file channel must verify size and digest');
assert.ok(incomingReceiver.includes('deleteFile('),
  'file channel must clean up on failure');

// P0-6：RESULT 必须经 wearengine.sendMsg 回手机。
assert.ok(watchReceiver.includes('wearengine.sendMsg'),
  'watch must send RESULT via wearengine.sendMsg');
assert.ok(incomingReceiver.includes('sendToPhone'),
  'receiver must have a phone response channel');
assert.ok(!incomingReceiver.includes('reply('),
  'receiver must not use a second response channel');

// P1-7：签名材料跨 step 持久，结束步骤
// if: always() 清理。
const watchWf = read('.github/workflows/watch_lite_hap.yml');
const phoneWf = read('.github/workflows/phone_hap.yml');
for (const wf of [watchWf, phoneWf]) {
  assert.ok(!wf.includes("trap 'rm"),
    'workflow must not delete signing material mid-step');
  assert.ok(wf.includes('if: always()'),
    'workflow must clean up signing material unconditionally');
  assert.ok(wf.includes('inject_signing.py'),
    'workflow must stage real signingConfigs');
  assert.ok(wf.includes('$RUNNER_TEMP/suyue-signing'),
    'signing material must persist across steps');
}
assert.ok(existsSync('tools/inject_signing.py'),
  'signing injection helper must exist');
// 手机端和手表端属于同一 Issue 分支开发，不能让 phone CI
// 只监听已结束的 auto-issue-1，否则 auto-issue-2 的变更永远不打包。
assert.ok(phoneWf.includes("branches: [main, 'auto-issue-*']"),
  'phone Stage CI must run on current issue branches');
assert.ok(phoneWf.includes('.harmony-cli/sdk/default/openharmony/toolchains/lib/hap-sign-tool.jar'),
  'phone signing verification must find the actual HarmonyOS CLI toolchain');

// P1-8：HAP 检查必须验证容器/包名/设备/模式。
const artifactCheck = read('tests/build_artifact_check.sh');
assert.ok(artifactCheck.includes('504b0304'),
  'artifact check must verify the ZIP magic');
assert.ok(artifactCheck.includes('bundleName'),
  'artifact check must verify the bundle name');
assert.ok(artifactCheck.includes('deviceTypes'),
  'artifact check must verify the device type');
assert.ok(artifactCheck.includes('buildMode'),
  'artifact check must verify the build mode');
const transferCode = read('apps/phone/entry/src/main/ets/services/BookTransferService.ts');
assert.ok(transferCode.includes('await this.p2pClient.sendMessage('),
  'phone must await asynchronous Wear Engine message delivery');
assert.ok(transferCode.includes('wearEngine.P2pResultCode.COMMUNICATION_SUCCESS') &&
  !transferCode.includes('result.code === 0'),
  'file transfer completion must use Huawei success enum, not numeric zero');
const wearDeviceCode = read('apps/phone/entry/src/main/ets/services/WearDeviceService.ts');
assert.ok(wearDeviceCode.includes('registered.appParam, registered.callback'),
  'unsubscribe must reuse the registered appParam and callback');
const phoneShelf = read('apps/phone/entry/src/main/ets/pages/Index.ets');
assert.ok(phoneShelf.includes('this.receiverReady'),
  'sending must be disabled if RESULT receiver registration failed');
assert.ok(phoneShelf.includes('private canTransferBook(') &&
  phoneShelf.includes('BookStatus.SENT') &&
  phoneShelf.includes('BookStatus.TRANSFER_FAILED') &&
  phoneShelf.includes('this.canTransferBook(book)'),
  'phone must allow manual resend after successful or failed transfer');
const watchBuild = read('tools/build_watch_lite.sh');
const phoneBuild = read('tools/build_phone_hap.sh');
for (const script of [watchBuild, phoneBuild]) {
  assert.ok(script.includes('rm -rf entry/build'),
    'build must clean its own output first');
  assert.ok(script.includes('entry-default-$MODE-'),
    'build must pick the HAP matching the requested mode');
}

// P1-9：transferFile 句柄只在终态关闭。
assert.ok(transferService.includes('let settled = false'),
  'transferFile must settle once');
assert.ok(transferService.includes('fs.closeSync(p2pFile.file)'),
  'transferFile must close the handle');
assert.ok(!transferService.includes(
  '} finally {\n              try {\n                fs.closeSync'),
  'transferFile must not close on every progress callback');

// P1-10 / 第二轮 P0-3：RESULT waiter 在每个重试轮次
// 重新注册，且注册先于任何发送。
const sendBookBody = transferService.slice(
  transferService.indexOf('async sendBook'));
assert.ok(sendBookBody.indexOf('waiters.beginAttempt') <
  sendBookBody.indexOf('sendMessage'),
  'waiter must be registered before any send');
assert.ok(sendBookBody.indexOf('markUploaded') >
  sendBookBody.indexOf('transferFile'),
  'result timeout must start only after upload completes');

// P1-11：流式 SHA-256 与导入上限。
const sha256Module = read(
  'apps/watch/entry/src/main/js/MainAbility/util/Sha256.js');
assert.ok(sha256Module.includes('createSha256'),
  'Sha256 must expose a streaming hasher');
assert.ok(transferLogicSrc().includes('createDigestVerifier'),
  'TransferLogic must expose a streaming digest verifier');
assert.ok(importService.includes('MAX_BOOK_BYTES'),
  'import must enforce a book size cap');

// P1-12：索引原子写 + 串行化 + 回滚。
const libraryIndex = read(
  'apps/watch/entry/src/main/js/MainAbility/storage/LibraryIndex.js');
assert.ok(libraryIndex.includes('INDEX_TMP'),
  'index must write to a temp file first');
assert.ok(libraryIndex.includes('enqueue'),
  'index writes must be serialized');
assert.ok(libraryIndex.includes('rollback'),
  'index must roll back on write failure');

// P2-13：阅读器设置收进二级交互。
const readerJs = read(
  'apps/watch/entry/src/main/js/MainAbility/pages/reader/reader.js');
const readerHml = read(
  'apps/watch/entry/src/main/js/MainAbility/pages/reader/reader.hml');
assert.ok(readerJs.includes('settingsOpen'),
  'reader must gate settings behind a toggle');
const mainControls = readerHml.slice(
  readerHml.indexOf('主操作'),
  readerHml.indexOf('二级交互'));
assert.ok(mainControls.includes('上页') &&
  mainControls.includes('下页'),
  'reader main row must keep prev/next');
assert.ok(!mainControls.includes('A+'),
  'reader main row must not hold font controls');

// P2-14：demo 迁移必须条件化，不得回造假元数据。
assert.ok(watchIndex.includes('migrateDemo'),
  'index must migrate the demo conditionally');
assert.ok(watchIndex.includes('file.access'),
  'migration must check the legacy file exists');
assert.ok(!watchIndex.includes('fail: () => this.registerDemo()'),
  'migration must not register on failure');
assert.ok(!watchIndex.includes('bytes: 0'),
  'migration must not fabricate metadata');

// P2-15（issue #2 更新）：表冠不再是"永远返回 false"的占位。
// 已按上游 slider/rotation 机制接入（见上方 crownProxy 检查），
// 但仍不得宣称已验证：状态必须是 'unverified'，真机结论只写文档。
assert.ok(crownInput.includes("'unverified'"),
  'crown must stay unverified until a GT4 device run proves it');
assert.ok(!crownInput.includes("return 'supported'"),
  'crown must not claim supported status without a device run');

// TransferLogic 源码（静态检查用）。
function transferLogicSrc() {
  return read(
    'apps/watch/entry/src/main/js/MainAbility/wear/TransferLogic.js');
}

// ---- 第二轮复核（第三轮修复）静态检查 ----

// P0-1：Manifest supportLists 必须由构建期注入，
// 仓库里保持占位符；workflow 必须传 --manifest，
// 且清理步骤还原 config.json。
const watchConfigSrc = read(
  'apps/watch/entry/src/main/config.json');
assert.ok(watchConfigSrc.includes(
  'com.xiwei.suyue:CONFIGURE_WITH_SIGNED_PHONE_FINGERPRINT'),
  'repo keeps the supportLists placeholder for build-time injection');
assert.ok(watchWf.includes('--manifest '),
  'watch workflow must inject the manifest fingerprint');
assert.ok(watchWf.includes('--manifest-peer-bundle'),
  'watch workflow must name the peer bundle');
assert.ok(watchWf.includes('apps/watch/entry/src/main/config.json'),
  'watch workflow must point at the watch manifest');
assert.ok(watchWf.includes('git checkout --') &&
  watchWf.includes('config.json'),
  'cleanup must restore the injected manifest');
assert.ok(watchWf.includes('--expect-fingerprint'),
  'built HAP manifest must be re-verified');
assert.ok(read('tools/inject_signing.py').includes(
  'CONFIGURE_WITH_SIGNED_PHONE_FINGERPRINT'),
  'injector must guard the supportLists placeholder');

// P0-2：文件通道必须按字段探测并记录来源，且
// 单本互斥（E_BUSY）。
assert.ok(watchReceiver.includes('extractFileRef'),
  'file callback fields must be probed explicitly');
assert.ok(!/receiveFile\(data\.file\)/.test(watchReceiver),
  'watch must not pass an unverified data.file straight through');
assert.ok(watchReceiver.includes('FILE_REF_FIELDS'),
  'candidate callback fields must be enumerated');
assert.ok(incomingReceiver.includes('activeTransferId'),
  'receiver must track the single in-flight transfer');
assert.ok(transferLogicSrc().includes("'E_BUSY'"),
  'TransferLogic must define E_BUSY');
assert.ok(read('shared/protocol/README.md').includes('E_BUSY'),
  'protocol spec must document E_BUSY');

// P0-3：waiter 纯逻辑模块 + 取消接真实 SDK。
assert.ok(existsSync(
  'apps/phone/entry/src/main/ets/services/TransferWaiters.js'),
  'waiter registry module must exist');
assert.ok(transferService.includes('createWaiterRegistry'),
  'send service must use the waiter registry');
assert.ok(transferService.includes('UPLOAD_TIMEOUT_MS'),
  'upload timeout must be separate from the result timeout');
assert.ok(transferService.includes('cancelFileTransfer'),
  'cancel must call the real SDK cancelFileTransfer');
assert.ok(transferService.includes("code: 'E_CANCELLED'"),
  'cancel must notify the watch with ERROR/E_CANCELLED');
assert.ok(phoneIndexFull.includes('cancelSend'),
  'phone UI must expose the cancel action');

// P0-4：索引快照不可变 + 提交不假设覆盖。
assert.ok(libraryIndex.includes('function snapshot('),
  'index must keep an immutable snapshot');
assert.ok(!/entries\.push\(/.test(libraryIndex),
  'index writes must not mutate the read array in place');
assert.ok(libraryIndex.includes('commitIndexTmp'),
  'index commit must handle non-overwriting move');
assert.ok(libraryIndex.includes('E_ROLLBACK_MISMATCH'),
  'rollback must verify the restored content on disk');

// P1-5：演示书生成器必须移除，迁移只看真实文件。
assert.ok(!existsSync(
  'apps/watch/entry/src/main/js/MainAbility/storage/BookFiles.js'),
  'demo generator must be deleted');
assert.ok(!watchIndex.includes('initializeLibrary'),
  'index page must not call any demo generator');
assert.ok(watchIndex.includes("if (!digest)"),
  'migration must abort instead of writing an empty digest');

// P1-6：容器检查不得宣称验签；workflow 必须有
// 官方 hap-sign-tool 验签步骤。
assert.ok(artifactCheck.includes('不做证书签名验证'),
  'artifact check must state it is not a signature check');
assert.ok(watchWf.includes('hap-sign-tool') &&
  phoneWf.includes('hap-sign-tool'),
  'both workflows must verify signatures with hap-sign-tool');
assert.ok(artifactCheck.includes('note=archive-check-not-device-install'),
  'artifact check output must be explicit about its scope');

console.log('PASS: repo structure, watch JS routes, phone ' +
  'import stack and branding (static only)');
