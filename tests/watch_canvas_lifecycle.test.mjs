// SPDX-License-Identifier: GPL-3.0-only
// #11：唯一 Canvas 路线的生命周期。没有 HML 正文兜底、没有计时重试。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSystemFileStub } from './helpers/system_file_stub.mjs';
import { createWatchLoader, writeRouterStub, writeStorageStub }
  from './helpers/watch_module_loader.mjs';

const tmp=mkdtempSync(join(tmpdir(),'suyue-onlycanvas-'));
const disk=mkdtempSync(join(tmpdir(),'suyue-onlycanvas-fs-'));
function canvas(options={}) {
  const state={gets:0,draws:0,backgrounds:0,metrics:0};
  return {width:420,height:420,state,
    getContext(){
      state.gets++;
      if(options.noContext)return null;
      const ctx={
        fillRect(){state.backgrounds++},
        fillText(){state.draws++;if(options.throwDraw)throw Error('draw')}
      };
      if(options.missingFillText)delete ctx.fillText;
      // These should never be used even if a firmware implements them.
      ctx.measureText=()=>{state.metrics++;throw Error('expensive measure')};
      ctx.getImageData=()=>{throw Error('expensive pixel readback')};
      return ctx;
    }
  };
}
try {
  const load=createWatchLoader({tmpDir:tmp,stubPath:writeSystemFileStub(tmp,disk),
    routerStubPath:writeRouterStub(tmp),storageStubPath:writeStorageStub(tmp)});
  const mod=await load('pages/reader/reader.js');
  const book=Buffer.from('圆屏正文与正常的中文小说。'.repeat(120),'utf8');
  function page(ref){
    const p=Object.create(mod.default);
    Object.assign(p,mod.default.data);
    p.$refs={readerCanvas:ref};
    p.bookId='aaaaaaaaaaaaaaaa';
    p.history=[];p.offset=0;p.isBusy=true;p.settingsOpen=false;
    p.canvasReady=false;p.ctx=null;
    p.isLoading=true;
    p.saved=0;p.scheduleSave=()=>{p.saved++};
    p.savePreferences=()=>{};
    p.reloads=0;p.loadPage=()=>{p.reloads++};
    return p;
  }
  function pending(page,offset=0){
    page.pending={data:{bytes:book.subarray(offset,offset+2048),offset},
      previousOffset:undefined,done:(ok)=>{page.completed=ok}};
  }
  // Data arrives before onShow: no attempt to render until component is mounted.
  {
    const ref=canvas(),p=page(ref);
    pending(p);
    p.renderPending();
    assert.ok(p.pending,'retain data until onShow');
    assert.equal(ref.state.gets,0);
    p.onShow();
    assert.equal(p.pending,null);
    assert.equal(p.completed,true);
    assert.equal(p.readingError,false);
    assert.ok(p.nextOffset>p.offset);
    assert.ok(ref.state.draws>0);
    assert.equal(ref.state.backgrounds,1,
      'one background fill per page without clearRect');
    assert.equal(ref.state.metrics,0,'no measureText and no pixel readback');
    assert.equal(ref.state.gets,1,'context only once for active page');
    pending(p,p.nextOffset);p.renderPending();
    assert.equal(ref.state.gets,1,'reuse context across page flips');
    assert.equal(ref.state.backgrounds,2,
      'two page paints use two background fills');
    assert.equal(p.saved,2);
  }
  // Canvas before data: keep cached context; wait for actual file callback.
  {
    const ref=canvas(),p=page(ref);
    p.onShow();
    assert.equal(ref.state.gets,1);
    assert.equal(ref.state.draws,0);
    pending(p);
    p.renderPending();
    assert.ok(ref.state.draws>0);
  }
  // 全新书籍首个读取窗口全是空行：不把黑色背景误认成已绘制正文，
  // 不记录空白页进度，而是顺着唯一读取链继续到真实文字。
  {
    const ref=canvas(),p=page(ref);
    p.isLoading=false;
    p.readingError=true;
    p.body='正在读取本地文本……';
    const blanks=new Uint8Array(2048);
    blanks.fill(10);
    p.pending={data:{bytes:blanks,offset:0},
      done:(ok)=>{p.completed=ok}};
    p.loadPage=function(offset,previousOffset,done){
      this.skippedTo=offset;
      this.pending={data:{bytes:Buffer.from('第一章：真正的正文文字。','utf8'),
        offset:offset},previousOffset:previousOffset,done:done};
      this.renderPending();
    };
    p.onShow();
    assert.equal(p.skippedTo,2048,
      'continue after whole blank window in actual UTF-8 bytes');
    assert.equal(p.completed,true);
    assert.equal(p.readingError,false);
    assert.equal(ref.state.backgrounds,1,
      'only the visible page is painted, not the black blank page');
    assert.ok(ref.state.draws>0);
    assert.equal(p.saved,1,'do not save a blank first page');
  }
  // 真正空文件不能只显示黑色 Canvas。
  {
    const ref=canvas(),p=page(ref);
    p.pending={data:{bytes:new Uint8Array(0),offset:0},
      done:(ok)=>{p.completed=ok}};
    p.onShow();
    assert.equal(p.completed,false);
    assert.equal(p.readingError,true);
    assert.ok(p.body.includes('没有可显示的正文'));
    assert.equal(ref.state.backgrounds,0);
  }
    // Missing context is a single explicit failure. Never fall back or retry.
  {
    const ref=canvas({noContext:true}),p=page(ref);
    pending(p);p.onShow();
    assert.equal(p.completed,false);
    assert.equal(p.readingError,true);
    assert.ok(p.body.includes('getContext'));
    assert.equal(p.pending,null);
    assert.equal(ref.state.gets,1);
    assert.equal(p.saved,0);
  }
  // 真正缺少必需的 fillText 才失败；无 clearRect 的 context 正常阅读。
  for(const mode of [{missingFillText:true},{throwDraw:true}]) {
    const ref=canvas(mode),p=page(ref);
    pending(p);p.onShow();
    assert.equal(p.readingError,true);
    assert.equal(p.completed,false);
    assert.ok(p.body.includes('无法使用 Canvas'));
  }
  // Settings don't force four redundant draws; return redraws once with chosen size.
  {
    const ref=canvas(),p=page(ref);
    p.isBusy=false;p.isLoading=false;p.canvasReady=true;
    p.ctx=ref.getContext();
    p.openSettings();
    p.changeFont(1);p.changeSpacing(0.1);p.toggleTheme();
    assert.equal(p.fontSize,21);
    assert.equal(p.lineHeightRatio,1.65);
    assert.equal(p.theme,'day');
    assert.equal(p.reloads,0,'no hidden draw per settings tap');
    p.closeSettings();
    assert.equal(p.reloads,1,'redraw once after settings close');
  }
  console.info('PASS: Canvas only; no retries, no fallback; draw on demand; settings redraw once');
} finally {
  rmSync(tmp,{recursive:true,force:true});
  rmSync(disk,{recursive:true,force:true});
}
