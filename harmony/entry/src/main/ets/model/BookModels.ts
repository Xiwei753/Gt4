// SPDX-License-Identifier: GPL-3.0-only
// 手机与手表共用的书籍数据模型（ArkTS 侧）。
// 手表侧 Lite JS 使用同名字段的 JSON，二者只通过 protocol 约定交互。

export enum BookKind {
  TXT = 'txt',
  EPUB = 'epub'
}

export enum BookStatus {
  IMPORTING = 'importing',
  READY = 'ready',
  FAILED = 'failed',
  SENDING = 'sending',
  SENT = 'sent',
  TRANSFER_FAILED = 'transfer_failed'
}

export interface BookChapter {
  title: string;
  // 规范化 UTF-8 正文文件内的字节偏移与长度。
  offset: number;
  length: number;
}

export interface BookMeta {
  bookId: string;
  title: string;
  // Optional EPUB package metadata used by the phone bookshelf.
  author?: string;
  coverFilePath?: string;
  kind: BookKind;
  // 规范化后的 UTF-8 正文（沙箱私有目录内）文件路径。
  filePath: string;
  // EPUB 导入时保留的原始包路径，供书库保留来源和删除清理；阅读正文
  // 始终使用规范化 UTF-8 的 filePath。
  readerFilePath?: string;
  // 仅为旧 library.json 兼容保留。新阅读器验证正文位置后写 utf8_byte；
  // 尚未验证的旧位置继续跳过同步，避免伪造字节偏移。
  progressMapping?: 'utf8_byte' | 'readerkit_unmapped';
  // 规范化后正文字节数（UTF-8 字节，非字符数）。
  bytes: number;
  // 规范化后正文的 SHA-256（十六进制小写），用于传输校验与重复导入识别。
  // 注意：必须对实际发送的 normalized 字节计算，
  // 不能对原始 TXT/EPUB 文件计算（施工单 P0-4）。
  sha256: string;
  chapters: BookChapter[];
  // 消息通道分块模式参数（文件通道优先，
  // 此为后备分块描述，施工单 P0-3）。
  chunks: number;
  chunkBytes: number;
  importedAt: number;
  updatedAt: number;
  status: BookStatus;
  lastError?: string;
}

export interface ImportResult {
  ok: boolean;
  book?: BookMeta;
  reason?: string;
}

export function newBookId(sha256: string, title: string): string {
  // 稳定 ID：同一内容（摘要）始终映射到同一本书；标题仅用于可读性。
  return sha256.substring(0, 16);
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength);
}
