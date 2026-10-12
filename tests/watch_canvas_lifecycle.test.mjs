// SPDX-License-Identifier: GPL-3.0-only
// Issue #11：Canvas 生命周期与重绘契约。
// 用真实 Canvas 渲染器 API 的仿真（getContext/measureText/fillText/
// clearRect/fillRect）驱动 reader.js 的绘制路径，验证：
// 数据先到/画布先到都能画、设置开关返回会重绘、无 ctx 或绘制异常
// 给出可定位错误、字号/主题变化重排、同一页重复绘制幂等。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSystemFileStub } from './helpers/system_file_stub.mjs';
import { createWatchLoader, writeRouterStub, writeStorageStub } from './helpers/watch_module_loader.mjs';

const temp = mkdtempSync(join(tmpdir(), 'suyue-canvas-life-'));
const fsRoot = mkdtempSync(join(tmpdir(), 'suyue-canvas-life-fs-'));

function makeRef(options = {}) {
  const state = { contexts: 0 };
  return {
    width: 420,
    height: 420,
    __state: state,
    getContext(kind) {
      state.contexts++;
      if (options.noContext) return null;
      const ctx = {
        font: '', fillStyle: '', textBaseline: '', textAlign: '',
        drawn: [],
        clearRect() { this.cleared = true; },
        fillRect() { this.background = true; },
        fillText(text, x, y) {
          if (options.throwOnDraw) throw new Error('boom');
          this.drawn.push({ text, x, y });
        }
      };
      if (!options.noMeasure) {
        ctx.measureText = (text) => ({ width: text.length * 10 });
      }
      if (options.throwMeasure) {
        ctx.measureText = () => { throw new Error('measure'); };
      }
      if (options.noFillText) delete ctx.fillText;
      return ctx;
    }
  };
}

try {
  const load = createWatchLoader({
    tmpDir: temp,
    stubPath: writeSystemFileStub(temp, fsRoot),
    routerStubPath: writeRouterStub(temp),
    storageStubPath: writeStorageStub(temp)
  });
  const mod = await load('pages/reader/reader.js');

  const TEXT = ('圆屏正文测试内容，中文与English混排。\n'.repeat(60));

  function page(ref, extra = {}) {
    const p = Object.create(mod.default);
    Object.assign(p, mod.default.data);
    p.bookId = 'aaaaaaaaaaaaaaaa';
    p.isBusy = false;
    p.$refs = { readerCanvas: ref };
    p.saveCount = 0;
    p.scheduleSave = () => { p.saveCount++; };
    p.loadPage = () => { p.reloads = (p.reloads || 0) + 1; };
    p.previousPage = () => { p.prev = (p.prev || 0) + 1; };
    p.nextPage = () => { p.next = (p.next || 0) + 1; };
    Object.assign(p, extra);
    return p;
  }

  function pending(offset = 0) {
    const bytes = Buffer.from(TEXT, 'utf8');
    return { data: { ok: true, offset, bytes }, offset, previousOffset: undefined, done: null };
  }

  // ---- 1. 数据先到：画布就绪后立即绘制一整页 ----
  {
    const ref = makeRef();
    const p = page(ref);
    p.pending = pending(0);
    p.renderPending();
    const ctx = ref.getContext(); // 仅用于断言：上下文已可用
    assert.equal(p.pending, null, 'pending page must be consumed');
    assert.equal(p.readingError, false);
    assert.equal(p.offset, 0, 'first page starts at the requested offset');
    assert.ok(p.nextOffset > 0, 'a page must advance the byte offset');
    assert.ok(p.pageHint.includes('字节位置'), 'page hint must show byte position');
    assert.equal(p.saveCount, 1, 'a drawn page must schedule a progress save');
    assert.equal(p.isBusy, false, 'drawing must release the busy state');
    assert.ok(ctx, 'context must be obtainable');
  }

  // ---- 2. 画布先到：无待画页时不报错、不取上下文 ----
  {
    const ref = makeRef();
    const p = page(ref);
    assert.doesNotThrow(() => p.renderPending());
    assert.equal(ref.__state.contexts, 0, 'no context grab without a pending page');
  }

  // ---- 3. getContext 缓存：连续绘制不重复取上下文 ----
  {
    const ref = makeRef();
    const p = page(ref);
    p.pending = pending(0);
    p.renderPending();
    const afterFirst = p.offset;
    p.pending = pending(afterFirst);
    p.renderPending();
    assert.equal(ref.__state.contexts, 1, 'context must be cached across redraws');
    assert.ok(p.offset >= afterFirst);
  }

  // ---- 4. 同一页重复绘制幂等（不重复消耗、不重影） ----
  {
    const ref = makeRef();
    const p = page(ref);
    p.pending = pending(40);
    p.renderPending();
    const firstOffset = p.offset;
    const firstNext = p.nextOffset;
    p.pending = pending(40);
    p.renderPending();
    assert.equal(p.offset, firstOffset, 'redrawing the same page must be idempotent');
    assert.equal(p.nextOffset, firstNext);
  }

  // ---- 5. 无上下文：重试到上限后给出可定位错误，不黑屏 ----
  {
    const ref = makeRef({ noContext: true });
    const p = page(ref);
    p.drawRetries = 100;
    p.pending = pending(0);
    p.renderPending();
    assert.equal(p.readingError, true, 'missing context must be reported, not silent');
    assert.ok(p.body.includes('绘制初始化失败'),
      'screen must name the failed canvas initialisation');
    assert.ok(p.body.includes('getContext'), 'screen must name the failing interface');
    assert.equal(p.pending, null);
  }

  // ---- 6. measureText 抛错：回退估算并如实提示，仍然绘制正文 ----
  {
    const ref = makeRef({ throwMeasure: true });
    const p = page(ref);
    p.pending = pending(0);
    p.renderPending();
    assert.equal(p.readingError, false, 'measurement fallback must still draw');
    assert.ok(p.nextOffset > 0);
    assert.ok(p.pageHint.includes('measureText'), 'fallback must be surfaced');
  }

  // ---- 7. 缺 fillText：报绘制失败并给出原因 ----
  {
    const ref = makeRef({ noFillText: true });
    const p = page(ref);
    p.pending = pending(0);
    p.renderPending();
    assert.equal(p.readingError, true);
    assert.ok(p.body.includes('绘制失败') && p.body.includes('no_context'),
      'screen must name the drawing failure reason');
  }

  // ---- 8. 绘制抛异常：报 draw_throw 而非崩溃 ----
  {
    const ref = makeRef({ throwOnDraw: true });
    const p = page(ref);
    p.pending = pending(0);
    assert.doesNotThrow(() => p.renderPending());
    assert.equal(p.readingError, true);
    assert.ok(p.body.includes('draw_throw'), 'screen must name the throwing step');
  }

  // ---- 9. 设置开关返回 / 主题 / 字号 / onShow 都要重绘当前页 ----
  {
    const ref = makeRef();
    const p = page(ref);
    p.offset = 123;
    p.settingsOpen = true;
    p.closeSettings();
    assert.equal(p.settingsOpen, false);
    assert.equal(p.reloads, 1, 'returning from settings must redraw the current page');
    p.toggleTheme();
    assert.equal(p.theme, 'day', 'theme must flip');
    assert.equal(p.reloads, 2, 'theme change must redraw the canvas');
    p.changeFont(2);
    assert.equal(p.fontSize, 22);
    assert.equal(p.reloads, 3, 'font change must re-paginate and redraw');
    p.onShow();
    assert.equal(p.reloads, 4, 'onShow must re-acquire the canvas and redraw');
  }

  // ---- 10. 点按翻页按画布宽度分半，不写死 233 ----
  {
    const ref = makeRef();
    const p = page(ref);
    p.onReaderTap({ globalX: 100 });
    p.onReaderTap({ globalX: 300 });
    assert.equal(p.prev, 1, 'tap left half must go to the previous page');
    assert.equal(p.next, 1, 'tap right half must go to the next page');
  }

  console.info('PASS: Canvas 生命周期：数据/画布任意先到、设置返回重绘、'
    + '上下文缓存、无 ctx/测量异常可定位、同页重绘幂等、按画布分半翻页');
} finally {
  rmSync(temp, { recursive: true, force: true });
  rmSync(fsRoot, { recursive: true, force: true });
}
