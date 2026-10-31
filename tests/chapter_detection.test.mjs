import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detectTxtChapters } from '../harmony/entry/src/main/ets/model/TxtChapterDetect.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pythonScript = join(root, 'tools', 'prepare_watch_books.py');

const fixtures = {
  simple: '第一章 开始\n正文一\n第二章 继续\n正文二\n',
  crlf: '第一章 开始\r\n正文\r\n第二章 继续\r\n正文\r\n',
  tight: '第123章出发\n正文\n第124章 到达\n正文\n',
  tightNoSpace: '第4章鱼与网\n前章正文\n第5章远行\n新章正文\n',
  fullwidth: '第１２３章　出发\n正文\n第１２４章 到达\n正文\n',
  chineseAndSection: '第一百二十三章 出发\n正文\n第一百二十四节 初遇\n正文\n',
  sectionOnly: '第一章 开始\n正文\n第十二节 初遇\n正文\n',
  decorated: '【第一章】开始\n正文\n☆ 第二章 继续 ☆\n正文\n',
  sitePrefix: 'www.example.com 第一章 开始\n正文\n小说书城：第二章 继续\n正文\n',
  tocThree: '目录\n第一章 开始\n第二章 继续\n第三章 结束\n\n第一章 开始\n正文一\n第二章 继续\n正文二\n第三章 结束\n正文三\n',
  tocMarkerTwo: '目录\n第一章 开始\n第二章 继续\n\n第一章 开始\n正文一\n第二章 继续\n正文二\n',
  bodyFalsePositive: '第一章 开始\n正文\n第123章的内容其实是正文，不是标题。\n还有一句。\n第124章 他走了，再也没有回来\n第二章 继续\n正文\n',
  sentenceEndingTitle: '第一章 开始\n正文\n第二章 结束。\n正文\n',
  volumeGapsReset: '第一卷 开始\n第一章 一\n正文\n第三章 三\n正文\n第二卷 继续\n第一章 四\n正文\n第二章 五\n正文\n',
  specials: '序章\n正文\n番外 一\n正文\n尾声\n正文\n',
  specialProse: '序章内容其实不是标题\n正文\n第一章 开始\n正文\n',
  english: 'Prologue\nbody\nChapter 1 Start\nbody\nChapter 2 End\nbody\n',
  emoji: '第一章 😀 开始\n正文😀\n第二章 继续\n正文\n',
  plain: '这是一段普通文本。\n没有任何章节标题。\n'
};

const jsResults = {};
for (const [name, text] of Object.entries(fixtures)) {
  jsResults[name] = detectTxtChapters(text, new TextEncoder().encode(text));
}

const pyCode = `
import json, sys, importlib.util
spec = importlib.util.spec_from_file_location('prepare_watch_books', ${JSON.stringify(pythonScript)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
fixtures = json.load(sys.stdin)
out = {}
for name, text in fixtures.items():
    out[name] = module.detect_chapters(text.encode('utf-8'))
json.dump(out, sys.stdout, ensure_ascii=False)
`;
const py = spawnSync('python3', ['-c', pyCode], {
  input: JSON.stringify(fixtures),
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024
});
assert.equal(py.status, 0, py.stderr);
const pyResults = JSON.parse(py.stdout);

for (const name of Object.keys(fixtures)) {
  assert.deepEqual(pyResults[name], jsResults[name], `JS/Python mismatch: ${name}`);
}

function titles(result) {
  return result.map((chapter) => chapter.title);
}

assert.deepEqual(titles(jsResults.simple), ['第一章 开始', '第二章 继续']);
assert.deepEqual(titles(jsResults.crlf), ['第一章 开始', '第二章 继续']);
assert.deepEqual(titles(jsResults.tight), ['第123章 出发', '第124章 到达']);
assert.deepEqual(titles(jsResults.tightNoSpace), ['第4章 鱼与网', '第5章 远行']);
assert.deepEqual(titles(jsResults.fullwidth), ['第１２３章 出发', '第１２４章 到达']);
assert.deepEqual(titles(jsResults.chineseAndSection), ['第一百二十三章 出发', '第一百二十四节 初遇']);
assert.deepEqual(titles(jsResults.sectionOnly), ['第一章 开始', '第十二节 初遇']);
assert.deepEqual(titles(jsResults.decorated), ['第一章 开始', '第二章 继续']);
assert.deepEqual(titles(jsResults.sitePrefix), ['第一章 开始', '第二章 继续']);
assert.deepEqual(titles(jsResults.tocThree), ['第一章 开始', '第二章 继续', '第三章 结束']);
assert.deepEqual(titles(jsResults.tocMarkerTwo), ['第一章 开始', '第二章 继续']);
assert.deepEqual(titles(jsResults.bodyFalsePositive), ['第一章 开始', '第二章 继续']);
assert.deepEqual(titles(jsResults.sentenceEndingTitle), ['第一章 开始']);
assert.deepEqual(titles(jsResults.volumeGapsReset), [
  '第一卷 开始', '第一章 一', '第三章 三', '第二卷 继续', '第一章 四', '第二章 五'
]);
assert.deepEqual(titles(jsResults.specials), ['序章', '番外 一', '尾声']);
assert.deepEqual(titles(jsResults.specialProse), ['第一章 开始']);
assert.deepEqual(titles(jsResults.english), ['Prologue', 'Chapter 1 Start', 'Chapter 2 End']);
assert.deepEqual(titles(jsResults.emoji), ['第一章 😀 开始', '第二章 继续']);
assert.deepEqual(titles(jsResults.plain), ['正文']);

// 每个 offset 都必须是规范化 UTF-8 字节偏移，且区间连续覆盖全文。
for (const [name, text] of Object.entries(fixtures)) {
  const bytes = new TextEncoder().encode(text);
  const result = jsResults[name];
  assert.ok(result[0].offset >= 0, `${name}: first offset`);
  for (let i = 0; i < result.length; i++) {
    const chapter = result[i];
    assert.ok(Number.isInteger(chapter.offset), `${name}: integer offset`);
    assert.ok(Number.isInteger(chapter.length), `${name}: integer length`);
    assert.ok(chapter.offset >= 0 && chapter.length >= 0, `${name}: range`);
    if (i + 1 < result.length) {
      assert.equal(chapter.offset + chapter.length, result[i + 1].offset,
        `${name}: contiguous chapters`);
    } else {
      assert.equal(chapter.offset + chapter.length, bytes.length,
        `${name}: covers end of file`);
    }
    assert.ok(chapter.offset <= bytes.length, `${name}: offset in range`);
  }
}

// 目录条目不应被重复计数；正文里的“第…章”不能变成标题。
assert.equal(jsResults.tocThree.length, 3);
assert.equal(jsResults.bodyFalsePositive.length, 2);

// 10k 章：保持线性/近线性，且所有 offset 仍为字节偏移。
const many = [];
for (let i = 1; i <= 10000; i++) many.push(`第${i}章 标题${i}\n正文${i}\n`);
const manyText = many.join('');
const manyBytes = new TextEncoder().encode(manyText);
const started = Date.now();
const manyResult = detectTxtChapters(manyText, manyBytes);
const elapsed = Date.now() - started;
assert.equal(manyResult.length, 10000);
assert.equal(manyResult[0].offset, 0);
assert.equal(manyResult[9999].title, '第10000章 标题10000');
assert.ok(elapsed < 5000, `10k chapter detection took ${elapsed}ms`);
assert.equal(manyResult[9999].offset + manyResult[9999].length, manyBytes.length);

// Kotlin 必须保留与 JS/Python 相同的入口和关键规则，避免只改一端。
const kotlin = readFileSync(join(root, 'android/app/src/main/java/com/xiwei/suyue/importer/TxtImportService.kt'), 'utf8');
assert.match(kotlin, /fun detectChapters\(/);
assert.match(kotlin, /rawTitle/);
assert.match(kotlin, /codePointLength\(title\) > 6/);

console.log(`chapter detection: ${Object.keys(fixtures).length} fixtures + 10k chapters passed`);
