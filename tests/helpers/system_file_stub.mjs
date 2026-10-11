// SPDX-License-Identifier: GPL-3.0-only
// 测试辅助：@system.file 的 Node 桩（真实文件系统后端）。
// internal://app/<path> → <sandboxRoot>/<path>。
// 支持失败注入（供 P0-4 回归测试）：
//   .fail_move_count  文件含 N → 接下来 N 次 move 失败（递减）
//   .no_overwrite     存在时：目标已存在则 move 失败
import { writeFileSync } from 'node:fs';

export function writeSystemFileStub(tmpDir, sandboxRoot,
  stubName = 'system_file_stub.mjs') {
  const stubPath = tmpDir + '/' + stubName;
  writeFileSync(stubPath, `
import { mkdirSync, readFileSync, writeFileSync,
  copyFileSync, renameSync, rmSync, statSync,
  accessSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
const ROOT = ${JSON.stringify(sandboxRoot)};
const resolve = (uri) => {
  if (typeof uri !== 'string' ||
      !uri.startsWith('internal://app/')) {
    throw new Error('unexpected uri: ' + uri);
  }
  return ROOT + '/' + uri.slice('internal://app/'.length);
};
const ok = (cb) => cb && cb();
const fail = (cb, code) => cb && cb({}, code || 301);
export default {
  access(o) {
    try { accessSync(resolve(o.uri)); ok(o.success); }
    catch (e) { fail(o.fail); }
  },
  mkdir(o) {
    try { mkdirSync(resolve(o.uri),
      { recursive: !!o.recursive }); ok(o.success); }
    catch (e) { fail(o.fail, -1); }
  },
  readText(o) {
    try {
      // 真实 Lite 限制：readText 单次上限 4 KB，超过返回 302。
      // 注入：.readtext_max 文件覆盖上限；.readtext_302 存在时恒失败 302。
      if (existsSync(ROOT + '/.readtext_302')) {
        return fail(o.fail, 302);
      }
      const maxFile = ROOT + '/.readtext_max';
      const max = existsSync(maxFile) ?
        Number(readFileSync(maxFile, 'utf8')) : 4096;
      if (typeof o.length === 'number' && o.length > max) {
        return fail(o.fail, 302);
      }
      const buf = readFileSync(resolve(o.uri));
      const start = o.position || 0;
      const len = Math.min(o.length || 4096,
        buf.length - start);
      const text = buf.toString('utf8',
        start, start + len);
      o.success && o.success({ text });
    } catch (e) { fail(o.fail); }
  },
  writeText(o) {
    try {
      const p = resolve(o.uri);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, o.text, o.append ? 'utf8' : undefined);
      ok(o.success);
    } catch (e) { fail(o.fail, -1); }
  },
  readArrayBuffer(o) {
    try {
      const buf = readFileSync(resolve(o.uri));
      const start = o.position || 0;
      const len = Math.min(o.length || (buf.length - start),
        buf.length - start);
      const slice = buf.subarray(start, start + len);
      const ab = new ArrayBuffer(slice.length);
      new Uint8Array(ab).set(slice);
      o.success && o.success({ buffer: ab });
    } catch (e) { fail(o.fail); }
  },
  writeArrayBuffer(o) {
    try {
      const p = resolve(o.uri);
      mkdirSync(dirname(p), { recursive: true });
      const bytes = Buffer.from(o.buffer);
      if (o.append) {
        const existing = existsSync(p) ?
          readFileSync(p) : Buffer.alloc(0);
        writeFileSync(p, Buffer.concat([existing, bytes]));
      } else {
        writeFileSync(p, bytes);
      }
      ok(o.success);
    } catch (e) { fail(o.fail, -1); }
  },
  copy(o) {
    try {
      const dst = resolve(o.dstUri);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(resolve(o.srcUri), dst);
      ok(o.success);
    } catch (e) { fail(o.fail, -1); }
  },
  move(o) {
    try {
      // 失败注入（P0-4 回归）。
      const countFile = ROOT + '/.fail_move_count';
      const noOverwrite = ROOT + '/.no_overwrite';
      if (existsSync(countFile)) {
        const n = Number(readFileSync(countFile, 'utf8'));
        if (n > 0) {
          writeFileSync(countFile, String(n - 1));
          throw new Error('injected move failure');
        }
      }
      const dst = resolve(o.dstUri);
      if (existsSync(noOverwrite) && existsSync(dst)) {
        throw new Error('target exists (no overwrite)');
      }
      mkdirSync(dirname(dst), { recursive: true });
      renameSync(resolve(o.srcUri), dst);
      ok(o.success);
    } catch (e) { fail(o.fail, -1); }
  },
  delete(o) {
    try { rmSync(resolve(o.uri)); ok(o.success); }
    catch (e) { fail(o.fail, -1); }
  },
  get(o) {
    try {
      const st = statSync(resolve(o.uri));
      o.success && o.success({ uri: o.uri,
        length: st.size,
        lastModifiedTime: st.mtimeMs,
        type: st.isDirectory() ? 'directory' : 'file' });
    } catch (e) { fail(o.fail); }
  }
};
`);
  return stubPath;
}
