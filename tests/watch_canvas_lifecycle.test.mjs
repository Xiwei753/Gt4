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
  const state={gets:0,draws:0,clears:0,metrics:0};
  return {width:420,height:420,state,
    getContext(){
      state.gets++;
      if(options.noContext)return null;
      const ctx={
        clearRect(){state.clears++},
        fillRect(){},
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
    assert.equal(ref.state.clears,1);
    assert.equal(ref.state.metrics,0,'no measureText and no pixel readback');
    assert.equal(ref.state.gets,1,'context only once for active page');
    pending(p,p.nextOffset);p.renderPending();
    assert.equal(ref.state.gets,1,'reuse context across page flips');
    assert.equal(ref.state.clears,2);
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
  // Failed fillText also fails clearly, never reads/prints fallback paragraphs.
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
