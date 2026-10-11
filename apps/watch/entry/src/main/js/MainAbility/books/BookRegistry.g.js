// SPDX-License-Identifier: GPL-3.0-only
// 内置正文访问器：issue #10。
//
// 这是**提交在仓库里的默认空实现**（未指定 WATCH_BOOKS_DIR 时使用）。
// 构建带书时会被 tools/generate_watch_book_modules.py 覆盖为：
//   import { getChunk as c_<id> } from './BookText_<id>.g.js';
//   export function getChunk(bookId, index) { ...逐本转发... }
// 构建脚本用 trap 在结束时还原为下面这份空实现。
//
// 关键（issue #10）：只有**阅读页** import 本模块，书架页只 import
// BookCatalog.g.js，因此正文数据只进入阅读页 bundle；且每本书的块放在
// BookText_* 的函数体内，静态 import 只创建闭包，不 materialize 字符串。
import { BOOKS } from './BookCatalog.g.js';

export { BOOKS };

export var CHUNK_BYTES = 16384;

export function getChunk(bookId, index) {
  return null;
}
