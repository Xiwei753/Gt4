// SPDX-License-Identifier: GPL-3.0-only
// 手机侧书库索引：library.json + books/<bookId>.txt。
// 只有文件真实存在且登记成功的书才对 UI 可见。
import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { BookMeta, BookStatus } from '../model/BookModels';

const LIBRARY_FILE = 'library.json';

export class BookRepository {
  private context: common.UIAbilityContext;

  constructor(context: common.UIAbilityContext) {
    this.context = context;
  }

  private libraryPath(): string {
    return this.context.filesDir + '/' + LIBRARY_FILE;
  }

  private booksDir(): string {
    return this.context.filesDir + '/books';
  }

  private readIndex(): BookMeta[] {
    try {
      const file = fileIo.openSync(this.libraryPath(),
        fileIo.OpenMode.READ_ONLY);
      let text = '';
      try {
        const stat = fileIo.statSync(this.libraryPath());
        const buf = new ArrayBuffer(Math.max(stat.size, 0));
        fileIo.readSync(file.fd, buf);
        text = bufferToString(buf);
      } finally {
        fileIo.closeSync(file.fd);
      }
      const parsed = JSON.parse(text) as BookMeta[];
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((b) => b && typeof b.bookId === 'string');
    } catch (e) {
      return [];
    }
  }

  private writeIndex(books: BookMeta[]): void {
    const text = JSON.stringify(books);
    const file = fileIo.openSync(this.libraryPath(),
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE |
      fileIo.OpenMode.TRUNC);
    try {
      fileIo.writeSync(file.fd, new Uint8Array(
        new TextEncoderLite().encode(text)).buffer);
    } finally {
      fileIo.closeSync(file.fd);
    }
  }

  list(): BookMeta[] {
    const books = this.readIndex();
    // 只列出正文文件真实存在的书。
    return books.filter((b) => this.fileExists(b.filePath));
  }

  get(bookId: string): BookMeta | null {
    const found = this.readIndex().filter(
      (b) => b.bookId === bookId && this.fileExists(b.filePath));
    return found.length > 0 ? found[0] : null;
  }

  // 重复导入（同 bookId）且摘要一致时幂等返回；
  // 摘要不同视为新版本并覆盖，同时更新时间戳。
  register(meta: BookMeta): void {
    const books = this.readIndex();
    const idx = books.findIndex((b) => b.bookId === meta.bookId);
    if (idx >= 0 && books[idx].sha256 === meta.sha256) {
      books[idx].updatedAt = meta.updatedAt;
      this.writeIndex(books);
      return;
    }
    if (idx >= 0) {
      books[idx] = meta;
    } else {
      books.push(meta);
    }
    this.writeIndex(books);
  }

  remove(bookId: string): boolean {
    const books = this.readIndex();
    const idx = books.findIndex((b) => b.bookId === bookId);
    if (idx < 0) return false;
    const target = books[idx];
    try {
      fileIo.unlinkSync(target.filePath);
    } catch (e) {
      // 文件可能已不存在；索引清理仍然继续。
    }
    books.splice(idx, 1);
    this.writeIndex(books);
    return true;
  }

  markStatus(bookId: string, status: BookStatus,
    lastError?: string): void {
    const books = this.readIndex();
    const target = books.filter((b) => b.bookId === bookId);
    if (target.length === 0) return;
    target[0].status = status;
    if (lastError !== undefined) target[0].lastError = lastError;
    this.writeIndex(books);
  }

  private fileExists(path: string): boolean {
    try {
      fileIo.statSync(path);
      return true;
    } catch (e) {
      return false;
    }
  }
}

function bufferToString(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    if (b0 < 0x80) { s += String.fromCharCode(b0); i += 1; continue; }
    let width = b0 >= 0xf0 ? 4 : b0 >= 0xe0 ? 3 : 2;
    if (i + width > bytes.length) { s += '�'; break; }
    const b1 = bytes[i + 1], b2 = bytes[i + 2], b3 = bytes[i + 3];
    const code = width === 2 ? ((b0 & 31) << 6) | (b1 & 63) :
      width === 3 ? ((b0 & 15) << 12) | ((b1 & 63) << 6) | (b2 & 63) :
      ((b0 & 7) << 18) | ((b1 & 63) << 12) | ((b2 & 63) << 6) |
      (b3 & 63);
    if (code <= 0xffff) s += String.fromCharCode(code);
    else {
      const pair = code - 0x10000;
      s += String.fromCharCode(0xd800 + (pair >> 10),
        0xdc00 + (pair & 1023));
    }
    i += width;
  }
  return s;
}

// 极简 TextEncoder，避免在仓库层依赖 util 的命名差异。
class TextEncoderLite {
  encode(text: string): Uint8Array {
    const out: number[] = [];
    for (let i = 0; i < text.length; i++) {
      let code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff &&
          i + 1 < text.length) {
        const low = text.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) +
            (low - 0xdc00);
          i += 1;
        }
      }
      if (code < 0x80) {
        out.push(code);
      } else if (code < 0x800) {
        out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
      } else if (code < 0x10000) {
        out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63),
          0x80 | (code & 63));
      } else {
        out.push(0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 63),
          0x80 | ((code >> 6) & 63),
          0x80 | (code & 63));
      }
    }
    return new Uint8Array(out);
  }
}
