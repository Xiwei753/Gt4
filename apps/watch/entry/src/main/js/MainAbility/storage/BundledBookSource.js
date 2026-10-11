// SPDX-License-Identifier: GPL-3.0-only
// 内置书正文数据源（issue #10）：从构建期生成的 JS 数据块按需取窗口，
// 供阅读页分页使用。**只有阅读页 import 本模块**（书架页只读
// BookCatalog.g.js 的元数据），因此正文数据不进书架 bundle。
//
// 与文件通路（BookStorage.readBytes）语义一致：给定字节偏移与长度，
// 返回该窗口的 Uint8Array；进度仍是**字节偏移**，可跨块拼接，
// 切块边界不会切断已拼出的窗口（总是解码整块再切片）。
import { BOOKS, CHUNK_BYTES, getChunk } from '../books/BookRegistry.g.js';
import { decodeBase64 } from '../util/Base64.js';

// 元数据表：bookId -> {bookId,title,bytes,chunks}
var META = {};
// 书架用的列表（含 origin 便于界面区分内置/外部）。
var LIST = [];
var i;
for (i = 0; i < BOOKS.length; i++) {
  var b = BOOKS[i];
  META[b.bookId] = b;
  LIST.push({
    bookId: b.bookId,
    title: b.title,
    bytes: b.bytes,
    origin: 'builtin'
  });
}

export var BUNDLED_BOOKS = LIST;

export function isBundled(bookId) {
  return Object.prototype.hasOwnProperty.call(META, bookId);
}

export function bundledEntry(bookId) {
  var b = META[bookId];
  if (!b) return null;
  return {
    bookId: b.bookId,
    title: b.title,
    bytes: b.bytes,
    origin: 'builtin'
  };
}

// 读取 [offset, offset+size) 的正文窗口，语义同 BookStorage.readBytes。
// cb({ok:true, offset, bytes:Uint8Array}) 或 cb({ok:false, reason, chunk?})。
export function readBundledWindow(bookId, offset, size, cb) {
  var meta = META[bookId];
  if (!meta) {
    cb({ ok: false, reason: 'not_bundled' });
    return;
  }
  var total = meta.bytes;
  var start = offset || 0;
  var want = size || 0;
  if (start >= total || want <= 0) {
    cb({ ok: true, offset: start, bytes: new Uint8Array(0) });
    return;
  }
  var end = Math.min(total, start + want);
  var first = Math.floor(start / CHUNK_BYTES);
  var last = Math.floor((end - 1) / CHUNK_BYTES);
  var parts = [];
  var collected = 0;
  var c;
  for (c = first; c <= last; c++) {
    var b64 = getChunk(bookId, c);
    if (b64 === null || b64 === undefined) {
      cb({ ok: false, reason: 'missing_chunk', chunk: c });
      return;
    }
    var bytes = decodeBase64(b64);
    parts.push(bytes);
    collected += bytes.length;
  }
  var all = new Uint8Array(collected);
  var pos = 0;
  for (c = 0; c < parts.length; c++) {
    all.set(parts[c], pos);
    pos += parts[c].length;
  }
  // 块起点相对窗口的偏移；总是解码整块再切片，边界安全。
  var base = first * CHUNK_BYTES;
  var sliceStart = start - base;
  var windowBytes = all.subarray(sliceStart, sliceStart + (end - start));
  cb({ ok: true, offset: start, bytes: windowBytes });
}
