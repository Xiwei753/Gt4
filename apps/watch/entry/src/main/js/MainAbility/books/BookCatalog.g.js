// SPDX-License-Identifier: GPL-3.0-only
// 内置书单（仅元数据，**不含正文**）：issue #10。
//
// 这是**提交在仓库里的默认空实现**（未指定 WATCH_BOOKS_DIR 时使用）。
// 构建带书时，tools/generate_watch_book_modules.py 会把它覆盖成本次
// 选定的书籍元数据；构建脚本用 trap 在结束时还原为下面这份空默认值。
//
// 字段：bookId（sha256[:16]）、title、bytes（规范化 UTF-8 字节数）、
//       chunks（正文块数）。正文本身在 BookText_<bookId>.g.js 里。
export var BOOKS = [];
