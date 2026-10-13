// SPDX-License-Identifier: GPL-3.0-only
// #11 GT4 进度持久化：每次翻页写原生 KV，下次打开按保存字节位置开始。
// 不读写 progress/*.json；KV 失败不允许悄悄把当前书重置为首页。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSystemFileStub } from './helpers/system_file_stub.mjs';
import { createWatchLoader, writeRouterStub, writeStorageStub }
  from './helpers/watch_module_loader.mjs';

const temp=mkdtempSync(join(tmpdir(),'suyue-progress-'));
const disk=mkdtempSync(join(tmpdir(),'suyue-progress-disk-'));
const id='aaaaaaaaaaaaaaaa';
try {
  const stub=writeStorageStub(temp);
  const routerStub=writeRouterStub(temp);
  const fileStub=writeSystemFileStub(temp,disk);
  const load=createWatchLoader({tmpDir:temp,stubPath:fileStub,
    routerStubPath:routerStub,storageStubPath:stub});
  const progress=await load('storage/ProgressStore.js');
  const prefs=await load('storage/ReaderPreferences.js');
  const reader=await load('pages/reader/reader.js');
  const storage=(await import(stub)).default;
  const router=(await import(routerStub)).default;
  const fs=(await import(fileStub)).default;
  const get=(bookId)=>new Promise(done=>progress.loadProgress(bookId,done));
  const save=(bookId,offset,history)=>new Promise(done=>
    progress.saveProgress(bookId,offset,history,null,done));

  // 新书是真的无记录；旧书状态坏掉则是错误，不能默认为 0。
  const newBook=await get(id);
  assert.equal(newBook.ok,true);
  assert.equal(newBook.offset,0);
  assert.equal(newBook.empty,true);
  assert.equal((await save(id,1900,[0,400,800,1200])).ok,true);
  let restored=await get(id);
  assert.equal(restored.offset,1900);
  assert.deepEqual(restored.history,[0,400,800,1200]);
  assert.ok(storage.__values['suyue.pos.'+id].length<128);

  // 回归：真正的新书没有任何 per-book 设置键。即使设置读取尚未
  // 回调，也必须立即开始按已确定的进度 0 读取正文，而不是卡“正在读取”。
  {
    const newId='cccccccccccccccc';
    const originalGet=storage.get;
    let delayedSetting=null;
    storage.get=(o)=>{
      if(o.key==='suyue.reader.'+newId){
        delayedSetting=o;
        return;
      }
      originalGet(o);
    };
    try{
      const first=Object.create(reader.default);
      Object.assign(first,reader.default.data);
      first.bookId=newId;
      first.history=[];
      first.settingsTouched=false;
      first.progressReady=false;
      first.renderedOnce=false;
      const pages=[];
      first.loadPage=function(offset){pages.push(offset)};
      first.startReading();
      assert.deepEqual(pages,[0],
        'absent settings must never gate the first text read');
      assert.equal(first.progressReady,true);
      assert.equal(typeof delayedSetting.success,'function');
      assert.ok(first.body.includes('读取正文'));
      delayedSetting.success('');
    }finally{storage.get=originalGet;}
  }

  // 错误路由不能保留“正在读取”伪装成永无结束的加载。
  {
    const invalid=Object.create(reader.default);
    Object.assign(invalid,reader.default.data);
    invalid.bookId='invalid';
    invalid.onInit();
    assert.equal(invalid.isBusy,false);
    assert.ok(invalid.body.includes('打开失败'));
  }

  // 文件读写发生系统错误也不能影响读写进度——它们不再被使用。
  fs.readText=()=>{throw Error('file progress is forbidden')};
  fs.writeText=()=>{throw Error('file progress is forbidden')};
  assert.equal((await save(id,2600,[0,1900])).ok,true);
  assert.equal((await get(id)).offset,2600);

  // 每本书有独立进度，历史过长时保留最近几个而不超出 128B。
  const other='bbbbbbbbbbbbbbbb';
  assert.equal((await get(other)).offset,0);
  const huge=[];
  for(let i=0;i<60;i++)huge.push(10000000+i*2000);
  assert.equal((await save(id,100200000,huge)).ok,true);
  assert.ok(storage.__values['suyue.pos.'+id].length<128);
  assert.ok((await get(id)).history.length<=8);
  assert.equal((await get(id)).offset,100200000);

  // 确保坏存档不会被默默覆盖成首页。
  storage.__values['suyue.pos.'+id]='{broken';
  const corrupt=await get(id);
  assert.equal(corrupt.ok,false);
  assert.equal(corrupt.code,'invalid_json');
  const badPage=Object.create(reader.default);
  Object.assign(badPage,reader.default.data);
  badPage.bookId=id;
  badPage.loadPage=()=>{throw Error('must never load page zero after corrupt KV')};
  badPage.startReading();
  assert.equal(badPage.readingError,true);
  assert.ok(badPage.body.includes('阅读位置读取失败'));
  assert.equal(storage.__values['suyue.pos.'+id],'{broken');

  // 错误码必须原样回传；绝不启动第二种文件进度方案。
  const originalGet=storage.get;
  storage.get=(o)=>o.fail&&o.fail('System error',200);
  try{
    assert.equal((await get(id)).code,200);
  }finally{storage.get=originalGet;}
  storage.__values['suyue.pos.'+id]='';
  assert.equal((await save(id,4096,[1900,2600])).ok,true);

  // onShow 先于存档读取也不能渲染首页，必须等待持久位置载入。
  {
    const mount=Object.create(reader.default);
    Object.assign(mount,reader.default.data);
    mount.bookId=id;mount.progressReady=false;mount.isLoading=false;
    mount.settingsOpen=false;
    mount.$refs={readerCanvas:{getContext:()=>({
      fillText(){},clearRect(){},fillRect(){}
    })}};
    mount.focusCrown=()=>{};
    let premature=0;
    mount.loadPage=()=>{premature++};
    mount.onShow();
    assert.equal(premature,0,
      'onShow must wait for KV location, not draw at byte zero');
  }

  // 模拟再次进入本书：首次渲染的偏移必须是 4096 而不是 0。
  const p=Object.create(reader.default);
  Object.assign(p,reader.default.data);
  p.bookId=id;p.history=[];p.offset=0;p.progressReady=false;
  p.settingsTouched=false;p.userMoved=false;p.saving=false;p.saveWanted=false;
  p.progressError='';p.returnToShelf=false;p.isBusy=true;
  const rendered=[];
  p.loadPage=function(offset,prev,done) {
    rendered.push(offset);
    this.offset=offset;
    if(done)done(true);
  };
  p.startReading();
  assert.deepEqual(rendered,[4096],
    'reopen must start at saved position, never silently show first page');
  assert.equal(p.progressReady,true);
  assert.deepEqual(p.history,[1900,2600]);
  p.offset=5200;p.history.push(4096);
  p.scheduleSave();
  assert.equal((await get(id)).offset,5200);

  // 退出书架之前等待保存完成，避免 router.replace 抢先销毁页面。
  router.__calls.length=0;
  const originalSet=storage.set;
  let finishWrite=null;
  storage.set=(o)=>{storage.__values[o.key]=o.value;finishWrite=o.success};
  try {
    p.offset=6100;
    p.backToLibrary();
    assert.equal(router.__calls.length,0);
    assert.equal(typeof finishWrite,'function');
    finishWrite();
    assert.equal(router.__calls.length,1);
    assert.equal(router.__calls[0][1],'pages/index/index');
  }finally{storage.set=originalSet;}
  assert.equal((await get(id)).offset,6100);

  console.info('PASS: Lite KV saves/readback, reopen offset, corruption/no-reset,'
    +' bounded history, no file API, exit waits for save');
}finally{
  rmSync(temp,{recursive:true,force:true});
  rmSync(disk,{recursive:true,force:true});
}
