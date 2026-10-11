// SPDX-License-Identifier: GPL-3.0-only
// 测试辅助：递归加载手表 Lite JS 模块。
// 相对 import 改写为绝对路径；@system.file 改写为桩。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const WATCH_ROOT =
  'apps/watch/entry/src/main/js/MainAbility';

export function createWatchLoader(options) {
  const tmpDir = options.tmpDir;
  const stubPath = options.stubPath;
  const wearengineStubPath = options.wearengineStubPath;
  const routerStubPath = options.routerStubPath;
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

// @system.router 桩：记录 push/back，供书架页单元测试加载。
export function writeRouterStub(tmpDir,
  stubName = 'router_stub.mjs') {
  const stubPath = join(tmpDir, stubName);
  writeFileSync(stubPath, `
const calls = [];
const stub = {
  push(o) { calls.push(['push', o && o.uri, o && o.params]); },
  back() { calls.push(['back']); },
  replace(o) { calls.push(['replace', o && o.uri]); },
  clear() { calls.push(['clear']); },
  getParams() { return (stub.__params || {}); }
};
stub.__calls = calls;
export default stub;
`);
  return stubPath;
}
