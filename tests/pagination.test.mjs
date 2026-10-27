// SPDX-License-Identifier: GPL-3.0-only
// #11：唯一圆屏 Canvas 分页路线。确保按行排字、UTF-8 偏移、字号变化。
import assert from 'node:assert/strict';
import { TextEncoder } from 'node:util';
import { decodeAt, takeCanvasPage } from '../watch/huawei/watch-lite/entry/src/main/js/MainAbility/reader/PageLayout.js';
const encode = new TextEncoder();
const SIZE = {width:420,height:420,padding:16,lineHeightRatio:1.55};

function allPages(text, fontSize) {
  const bytes=encode.encode(text);
  let pos=0, rebuilt='', pages=0;
  const positions=[0];
  while(pos<bytes.length) {
    const win=bytes.subarray(pos,pos+2048);
    const p=takeCanvasPage(win,0,{...SIZE,fontSize});
    assert.ok(p.nextOffset>0,'no progress at byte '+pos);
    assert.ok(p.lines.length <= 32, 'bound layout work to <=32 rows');
    rebuilt+=p.text; pos+=p.nextOffset; positions.push(pos);
    assert.ok(++pages<5000,'loop guard');
  }
  assert.equal(rebuilt,text.replace(/\r/g,''),'no missing/duplicated characters');
  return {positions,pages};
}
const text=('甲乙中文English 123 😀!\n\n首行缩进　　后续内容。\n').repeat(100);
for(const font of [14,20,32]){
  const p=allPages(text,font);
  assert.ok(p.pages>2);
  const bytes=encode.encode(text);
  for(const off of p.positions.slice(0,8)){
    const a=takeCanvasPage(bytes.subarray(off,off+2048),0,{...SIZE,fontSize:font});
    const b=takeCanvasPage(bytes.subarray(off,off+2048),0,{...SIZE,fontSize:font});
    assert.deepEqual(a.lines,b.lines,'same settings yield stable layout');
  }
}
assert.equal(decodeAt(encode.encode('你'),0).size,3);
assert.equal(decodeAt(encode.encode('😀'),0).size,4);
assert.equal(decodeAt(new Uint8Array([0xe4,0xbd]),0),null);
const boundary=('a'.repeat(2047)+'汉字😀').repeat(2);
allPages(boundary,20);
allPages('甲'.repeat(1000),32);
allPages('行一\r\n\r\n行二\r\n',14);
const s=takeCanvasPage(encode.encode('测试测试'),0,{...SIZE,fontSize:20});
assert.ok(s.lines.some(l=>l.text),'at least one line of text');
assert.ok(s.lines.every(l=>l.advance<=l.maxWidth+0.001));
console.info('PASS: Canvas only: UTF-8/CRLF/emoji/window/font/bytes/page offset');
