// SPDX-License-Identifier: GPL-3.0-only
// TXT/EPUB 导入：读取系统文件选择器授权的 URI → 规范化 UTF-8 →
// 写入应用私有目录 → 登记书库。任何一步失败都不登记为成功。
import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { util } from '@kit.ArkTS';
import { BookMeta, BookKind, BookStatus, ImportResult,
  newBookId, toArrayBuffer } from '../model/BookModels';
import { decodeToText } from './TextDecodeService';
import { importEpub, EpubChapter } from './EpubImportService';
import { BookRepository } from './BookRepository';

const READ_CHUNK = 1024 * 1024;
// 导入上限：保护手表端内存与传输时长。
// 超过一律明确拒绝，不进入书库。
const MAX_BOOK_BYTES = 32 * 1024 * 1024;
// 消息通道后备分块大小（文件通道优先发送，
// 此值只用于 BOOK_META 的分块描述）。
const MESSAGE_CHUNK_BYTES = 64 * 1024;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // SDK 里没有 createHash：摘要要用 createMd（见 @ohos.security.cryptoFramework）。
  // update 的 Promise 形态必须 await，否则会与 digest 竞态。
  // DataBlob.data 在这个 SDK 版本要 Uint8Array，不接受 ArrayBuffer。
  const hash = cryptoFramework.createMd('SHA256');
  await hash.update({ data: bytes });
  const digest = await hash.digest();
  const view = new Uint8Array(digest.data);
  let hex = '';
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, '0');
  }
  return hex;
}

// 分块读取授权 URI 的全部字节；超过上限立即拒绝。
// 待验证：DocumentViewPicker 返回的 URI 在重启后是否仍可打开；
// 导入流程内立即读取，避免依赖持久化授权。
export function readUriBytes(uri: string): Uint8Array {
  const file = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const buf = new Uint8Array(READ_CHUNK);
      const read = fileIo.readSync(file.fd, buf.buffer,
        { offset: total, length: READ_CHUNK });
      if (read <= 0) break;
      total += read;
      if (total > MAX_BOOK_BYTES) {
        throw new Error('文件超过导入上限（' +
          MAX_BOOK_BYTES + ' 字节）');
      }
      chunks.push(buf.subarray(0, read));
    }
  } finally {
    fileIo.closeSync(file.fd);
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

function extensionOf(uri: string): string {
  const path = decodeURIComponent(uri.split('?')[0]);
  const lower = path.toLowerCase();
  if (lower.endsWith('.txt')) return 'txt';
  if (lower.endsWith('.epub')) return 'epub';
  return '';
}

// 防 ../ 、重复名、奇怪 URI：只取最后一段作为展示名。
export function displayFilename(uri: string): string {
  const path = decodeURIComponent(uri.split('?')[0]);
  const parts = path.split('/');
  const name = parts[parts.length - 1] || '未命名书籍';
  if (name.includes('..') || name.length === 0) {
    throw new Error('非法文件名：' + name);
  }
  return name;
}

function writeNormalizedFile(path: string, bytes: Uint8Array): void {
  const file = fileIo.openSync(path,
    fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE |
    fileIo.OpenMode.TRUNC);
  try {
    fileIo.writeSync(file.fd, toArrayBuffer(bytes));
  } finally {
    fileIo.closeSync(file.fd);
  }
}

// 回读沙箱内已写入的文件（用于导入复核）。
function readFileBytes(path: string): Uint8Array {
  const file = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const stat = fileIo.statSync(path);
    const size = stat.size;
    let pos = 0;
    while (pos < size) {
      const len = Math.min(READ_CHUNK, size - pos);
      const buf = new Uint8Array(len);
      const read = fileIo.readSync(file.fd, buf.buffer,
        { offset: pos, length: len });
      if (read <= 0) break;
      chunks.push(buf.subarray(0, read));
      total += read;
      pos += read;
    }
  } finally {
    fileIo.closeSync(file.fd);
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

function utf8Bytes(text: string): Uint8Array {
  return new util.TextEncoder().encode(text);
}

const MAX_CHAPTER_TITLE_CHARS = 80;
const CHAPTER_HEADING_PATTERNS: RegExp[] = [
  /^第[0-9０-９零〇一二三四五六七八九十百千万两]+[章节回卷部篇](?=\s|$|[：:、.．\-—])/,
  /^(?:序章|序言|楔子|引子|前言|尾声|后记|番外(?:篇)?|终章|大结局)(?=\s|$|[：:、.．\-—])/,
  /^Chapter\s+(?:\d+|[IVXLCDM]+)\b/i,
  /^(?:Prologue|Epilogue)\b/i
];

function isChapterHeading(line: string): boolean {
  const title = line.trim();
  if (title.length === 0 || title.length > MAX_CHAPTER_TITLE_CHARS) return false;
  for (const pattern of CHAPTER_HEADING_PATTERNS) {
    if (pattern.test(title)) return true;
  }
  return false;
}

// 在规范化 UTF-8 字节上找章节标题行首；不能把 JS 字符下标当字节偏移。
export function detectTxtChapters(text: string, bytes: Uint8Array):
  Array<{ title: string; offset: number; length: number }> {
  const starts: Array<{ title: string; offset: number }> = [];
  let byteOffset = 0;
  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && text.charCodeAt(i) !== 10) continue;
    const line = text.slice(lineStart, i + 1);
    if (isChapterHeading(line)) {
      starts.push({ title: line.trim(), offset: byteOffset });
    }
    byteOffset += utf8Bytes(line).length;
    lineStart = i + 1;
  }
  if (starts.length === 0) {
    return [{ title: '正文', offset: 0, length: bytes.length }];
  }
  const chapters: Array<{ title: string; offset: number; length: number }> = [];
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1].offset : bytes.length;
    if (end > starts[i].offset) {
      chapters.push({ title: starts[i].title, offset: starts[i].offset,
        length: end - starts[i].offset });
    }
  }
  return chapters.length > 0 ? chapters :
    [{ title: '正文', offset: 0, length: bytes.length }];
}

// 把 EPUB 章节合并为单一规范化 UTF-8 文件，并返回章节字节区间。
function packChapters(chapters: EpubChapter[]):
  { bytes: Uint8Array; offsets: Array<{ title: string; offset: number; length: number }> } {
  const encoded = chapters.map((c) => ({
    title: c.title,
    bytes: utf8Bytes(c.text)
  }));
  let total = 0;
  for (const e of encoded) total += e.bytes.length;
  const out = new Uint8Array(total);
  const offsets: Array<{ title: string; offset: number; length: number }> = [];
  let pos = 0;
  for (const e of encoded) {
    out.set(e.bytes, pos);
    offsets.push({ title: e.title, offset: pos, length: e.bytes.length });
    pos += e.bytes.length;
  }
  return { bytes: out, offsets };
}

export async function importBook(context: common.UIAbilityContext,
  uri: string): Promise<ImportResult> {
  const ext = extensionOf(uri);
  if (!ext) {
    return { ok: false, reason: '仅接受 TXT / EPUB 文件' };
  }
  let raw: Uint8Array;
  try {
    raw = readUriBytes(uri);
  } catch (e) {
    return { ok: false, reason: '读取文件失败：' + String(e) };
  }
  if (raw.length === 0) {
    return { ok: false, reason: '文件为空' };
  }

  try {
    let title: string;
    let chapters: Array<{ title: string; offset: number; length: number }>;
    let normalized: Uint8Array;

    if (ext === 'txt') {
      const decoded = decodeToText(raw);
      if (!decoded) {
        return { ok: false,
          reason: '编码识别失败（GBK/GB18030 解码在当前系统不可用），未导入' };
      }
      normalized = utf8Bytes(decoded.text);
      chapters = detectTxtChapters(decoded.text, normalized);
      title = displayFilename(uri).replace(/\.[^.]+$/, '');
    } else {
      const epub = importEpub(raw);
      const packed = packChapters(epub.chapters);
      normalized = packed.bytes;
      chapters = packed.offsets;
      title = epub.title;
    }

    // P0-4：摘要与 bookId 必须基于实际发送/落盘的
    // normalized 字节，而不是原始 TXT/EPUB 文件。
    const digest = await sha256Hex(normalized);
    const bookId = newBookId(digest, title);

    const repository = new BookRepository(context);
    const booksDir = context.filesDir + '/books';
    // mkdirSync(path, true) 在目录已经存在时仍可能抛
    // 13900015 File exists（本机实测）。旧版本/上一本书已经创建过
    // books 目录时，不能把“目录已存在”误报成导入失败。
    try {
      fileIo.mkdirSync(booksDir, true);
    } catch (e) {
      if (!fileIo.accessSync(booksDir)) {
        throw e;
      }
    }
    const filePath = booksDir + '/' + bookId + '.txt';
    writeNormalizedFile(filePath, normalized);

    // 写后复核：回读文件，确认字节数与摘要一致。
    const onDisk = readFileBytes(filePath);
    if (onDisk.length !== normalized.length) {
      return { ok: false,
        reason: '导入复核失败：磁盘字节数与正文不符' };
    }
    const diskDigest = await sha256Hex(onDisk);
    if (diskDigest !== digest) {
      return { ok: false,
        reason: '导入复核失败：磁盘摘要与正文不符' };
    }

    const now = Date.now();
    const chunks = Math.max(1, Math.ceil(
      normalized.length / MESSAGE_CHUNK_BYTES));
    const meta: BookMeta = {
      bookId,
      title,
      kind: ext === 'txt' ? BookKind.TXT : BookKind.EPUB,
      filePath,
      bytes: normalized.length,
      sha256: digest,
      chapters,
      chunks,
      chunkBytes: MESSAGE_CHUNK_BYTES,
      importedAt: now,
      updatedAt: now,
      status: BookStatus.READY
    };
    repository.register(meta);
    return { ok: true, book: meta };
  } catch (e) {
    return { ok: false, reason: '导入失败：' + String(e) };
  }
}
