// SPDX-License-Identifier: GPL-3.0-only
// #11：验证轻量线性圆屏排版和单次 Canvas 绘制。不调用像素回读或测字接口。
import assert from 'node:assert/strict';
import { takeCanvasPage } from '../apps/watch/entry/src/main/js/MainAbility/reader/PageLayout.js';
import {drawPage, pageColors, fontString} from '../apps/watch/entry/src/main/js/MainAbility/reader/CanvasTextRenderer.js';

const OLD_SIZE = 420;
const OLD_PADDING = 12;
const NEW_SIZE = 452;
const NEW_PADDING = 10;

const book=Buffer.from(('第一章 中文English😀，常规标点。\n').repeat(60),'utf8');
for(const fontSize of [14,20,32]){
  const p=takeCanvasPage(book.subarray(0,2048),0,{
    width:NEW_SIZE,height:NEW_SIZE,padding:NEW_PADDING,fontSize,lineHeightRatio:1.55
  });
  assert.ok(p.lines.length>4 && p.nextOffset>0);
  const previous=takeCanvasPage(book.subarray(0,2048),0,{
    width:OLD_SIZE,height:OLD_SIZE,padding:OLD_PADDING,fontSize,lineHeightRatio:1.55
  });
  assert.equal(p.radius-previous.radius,18,
    'safe reading radius increases by 18px, not the whole canvas only');
  assert.ok(p.nextOffset>=previous.nextOffset,
    'expanded circle must not reduce readable bytes in the same page');
  const a=p.lines[0],mid=p.lines[Math.floor(p.lines.length/2)];
  assert.ok(a.maxWidth<mid.maxWidth,'short top line, wide center line');
  for(const l of p.lines){
    const top=l.baselineY,bot=top+p.lineHeight;
    const dy=Math.max(Math.abs(top-p.centerY),Math.abs(bot-p.centerY));
    const half=Math.sqrt(Math.max(0,p.radius*p.radius-dy*dy));
    assert.ok(Math.abs(l.x-(p.centerX-half))<0.1,'line starts at circle chord');
    assert.ok(l.advance<=l.maxWidth+0.001,'glyph advance must not exceed circle boundary');
  }
}
// 回归：新书从 0 字节开始，可能有上百行空白封面/广告间隔。
// 前置空白行不能消耗整页 Canvas；正文的全角缩进仍要保留。
const front = Buffer.from('\n'.repeat(900) + '　　正文开始。', 'utf8');
const frontPage = takeCanvasPage(front, 0, {
  width: NEW_SIZE, height: NEW_SIZE, padding: NEW_PADDING,
  fontSize: 20, lineHeightRatio: 1.55
});
assert.ok(frontPage.text.includes('正文开始'),
  'skip leading empty lines so a never-opened novel shows real text');
assert.ok(frontPage.text.startsWith('　　'),
  'keep paragraph indentation on the first visible line');
assert.ok(frontPage.nextOffset > 900,
  'blank-line skipping advances real UTF-8 byte offsets');
const allBlank = takeCanvasPage(
  Buffer.from('\n'.repeat(3000)).subarray(0, 2048), 0, {
    width: NEW_SIZE, height: NEW_SIZE, padding: NEW_PADDING,
    fontSize: 20, lineHeightRatio: 1.55
  });
assert.equal(allBlank.text, '');
assert.equal(allBlank.nextOffset, 2048,
  'all-blank input must advance to next window, not loop at byte zero');

const calls=[];
const ctx={
  font:'', fillStyle:'', textBaseline:'', textAlign:'',
  fillRect(){calls.push('background');},
  fillText(text,x,y){calls.push(['line',text,x,y]);}
};
const p=takeCanvasPage(book,0,{
  width:NEW_SIZE,height:NEW_SIZE,padding:NEW_PADDING,fontSize:20,lineHeightRatio:1.55
});
const rendered=drawPage(ctx,{width:NEW_SIZE,height:NEW_SIZE},p.lines,{fontSize:20,theme:'night'});
assert.equal(rendered.ok,true);
assert.equal(calls.filter(x=>x==='clear').length,0,
  'GT4 Lite must not depend on clearRect');
assert.equal(calls.filter(x=>x==='background').length,1);
assert.equal(calls.filter(x=>Array.isArray(x)).length,rendered.drawn);
assert.ok(ctx.font.includes('20px'));
assert.equal(ctx.textBaseline,'top');
assert.equal(pageColors('day').background,'#f5f4f0');
assert.ok(fontString(32).includes('32px'));
assert.equal(drawPage(null,{width:420,height:420},[],{}).reason,'missing_2d_context');
const noClear={fillRect(){}, fillText(){}};
assert.equal(drawPage(noClear,{width:420,height:420},
  [{text:'中文',x:14,baselineY:40}],{fontSize:20}).ok,true,
  'real GT4 Lite style context works without clearRect');
assert.equal(drawPage({fillRect(){}},{width:420,height:420},[],{}).reason,
  'missing_fillText');
assert.equal(drawPage({fillText(){}},{width:420,height:420},[],{}).reason,
  'missing_fillRect');
const broken={fillRect(){},fillText(){throw Error('fail')}};
assert.equal(drawPage(broken,{width:420,height:420},[{text:'甲',x:12,baselineY:12}],{fontSize:20}).reason,'canvas_draw_failed');
assert.equal(typeof ctx.getImageData,'undefined','pixel readback is not needed');
assert.equal(typeof ctx.measureText,'undefined','measureText is not needed');
console.info('PASS: round chord positioning; one clear per page, one fillText per line');
