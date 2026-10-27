// SPDX-License-Identifier: GPL-3.0-only
// 测试辅助：递归加载手表 Lite JS 模块。
// 相对 import 改写为绝对路径；@system.file 改写为桩。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const WATCH_ROOT =
  'watch/huawei/watch-lite/entry/src/main/js/MainAbility';

export function createWatchLoader(options) {
  const tmpDir = options.tmpDir;
  const stubPath = options.stubPath;
  const wearengineStubPath = options.wearengineStubPath;
  const routerStubPath = options.routerStubPath;
  const storageStubPath = options.storageStubPath;
  const loaded = new Map();
  const load = async (rel) => {
    if (loaded.has(rel)) return loaded.get(rel);
    const srcPath = join(WATCH_ROOT, rel);
    let src = readFileSync(srcPath, 'utf8');
    const importRe = /from\s+'([^']+)'/g;
    let m;
    const deps = [];
    while ((m = importRe.exec(src)) !== null) {
      const spec = m[1];
      if (spec.startsWith('.')) {
        // 兼容无扩展名的相对 import（Lite 工程里
        // 同时存在 './PeerConfig' 与 './X.js'）。
        const withExt = /\.[a-z]+$/.test(spec) ?
          spec : spec + '.js';
        const depPath = join(rel, '..', withExt);
        await load(depPath);
        const depTmp = join(tmpDir,
          depPath.replaceAll('/', '_') + '.mjs');
        deps.push({ spec, depTmp });
      } else if (spec === '@system.file') {
        deps.push({ spec, depTmp: stubPath });
      } else if (spec === '@system.wearengine' &&
          wearengineStubPath) {
        deps.push({ spec, depTmp: wearengineStubPath });
      } else if (spec === '@system.router' && routerStubPath) {
        deps.push({ spec, depTmp: routerStubPath });
      } else if (spec === '@system.storage' && storageStubPath) {
        deps.push({ spec, depTmp: storageStubPath });
      }
    }
    const modPath = join(tmpDir,
      rel.replaceAll('/', '_') + '.mjs');
    for (const dep of deps) {
      src = src.replace("from '" + dep.spec + "'",
        "from '" + dep.depTmp + "'");
    }
    writeFileSync(modPath, src);
    const mod = await import(modPath);
    loaded.set(rel, mod);
    return mod;
  };
  return load;
}

// @system.wearengine 桩：仅记录调用，不做真实通信。
export function writeWearEngineStub(tmpDir,
  stubName = 'wearengine_stub.mjs') {
  const stubPath = join(tmpDir, stubName);
  writeFileSync(stubPath, `
const calls = [];
const stub = {
  getWearEngineVersion(o) {
    calls.push(['getWearEngineVersion']);
    o && o.complete && o.complete('5.0.2.401');
  },
  setPackageName(o) {
    calls.push(['setPackageName', o && o.appName]);
    o && o.complete && o.complete();
  },
  setFingerprint(o) {
    calls.push(['setFingerprint', o && o.appName]);
    o && o.complete && o.complete();
  },
  subscribeMsg(o) {
    calls.push(['subscribeMsg']);
    o && o.success && o.success({ isRegister: true });
  },
  unsubscribeMsg() { calls.push(['unsubscribeMsg']); },
  sendMsg(o) {
    calls.push(['sendMsg', o && o.message]);
    o && o.success && o.success();
  }
};
stub.__calls = calls;
export default stub;
`);
  return stubPath;
}

export const wait = (fn) =>
  new Promise((resolve) => fn(resolve));

// @system.router 桩：Lite Wearable 只支持 replace 切页；
// push/back/getParams 在真机上不可用，桩里也不提供，防止代码误用。
export function writeRouterStub(tmpDir,
  stubName = 'router_stub.mjs') {
  const stubPath = join(tmpDir, stubName);
  writeFileSync(stubPath, `
const calls = [];
const stub = {
  replace(o) { calls.push(['replace', o && o.uri, o && o.params]); }
};
stub.__calls = calls;
export default stub;
`);
  return stubPath;
}

export function writeStorageStub(tmpDir,
  stubName = 'storage_stub.mjs') {
  const path = join(tmpDir, stubName);
  writeFileSync(path, `
const values = {};
const stub = {
  get(o) {
    if (Object.prototype.hasOwnProperty.call(values, o.key)) {
      o.success && o.success(values[o.key]);
    } else if (typeof o.default === 'string') {
      o.success && o.success(o.default);
    } else {
      o.fail && o.fail('not found', 301);
    }
  },
  set(o) {
    values[o.key] = o.value;
    o.success && o.success();
  },
  __values: values
};
export default stub;
`);
  return path;
}
