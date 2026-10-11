// SPDX-License-Identifier: GPL-3.0-only
// 通用书籍文件存储：应用私有目录内的多书管理。
// 目录结构：
//   internal://app/gt4reader/books/<bookId>.txt   正式书籍
//   internal://app/gt4reader/temp/<transferId>    传输暂存
//   internal://app/gt4reader/progress/<bookId>.json
//   internal://app/gt4reader/books.json           书库索引
import file from '@system.file';
import { isLowerHex, isSafeToken } from '../util/Validate.js';

export var ROOT = 'internal://app/gt4reader';
export var BOOKS_DIR = ROOT + '/books';
export var TEMP_DIR = ROOT + '/temp';
export var PROGRESS_DIR = ROOT + '/progress';
export var INDEX_FILE = ROOT + '/books.json';

// bookId 只允许小写十六进制（内容 SHA-256 前 16 字符），
// 直接映射为文件名，杜绝路径穿越。
// 不用正则：Lite 的 JerryScript 没有 RegExp（见 util/Validate.js）。
export function isSafeBookId(bookId) {
  return isLowerHex(bookId, 16);
}

export function bookPath(bookId) {
  if (!isSafeBookId(bookId)) {
    throw new Error('unsafe bookId: ' + bookId);
  }
  return BOOKS_DIR + '/' + bookId + '.txt';
}

export function tempPath(transferId) {
  if (!isSafeToken(transferId, 128)) {
    throw new Error('unsafe transferId');
  }
  return TEMP_DIR + '/' + transferId;
}

export function progressPath(bookId) {
  return PROGRESS_DIR + '/' + bookId + '.json';
}

export function complete(cb, value) {
  if (typeof cb === 'function') cb(value);
}

// 目录操作后备超时（issue #8）：某个 access/mkdir 既不回调
// success 也不回调 fail 时，必须给出后备返回，不能再无限等待。
// 默认 8s；测试可用 setOperationTimeout 缩短。
export var OPERATION_TIMEOUT_MS = 8000;

export function setOperationTimeout(ms) {
  if (typeof ms === 'number' && ms > 0) OPERATION_TIMEOUT_MS = ms;
}

function ensureDir(uri, cb) {
  let settled = false;
  const done = (value) => {
    if (settled) return;
    settled = true;
    complete(cb, value);
  };
  if (typeof setTimeout === 'function') {
    setTimeout(() => done({ ok: false, reason: 'timeout' }),
      OPERATION_TIMEOUT_MS);
  }
  try {
    file.access({
      uri: uri,
      success: () => done({ ok: true, existed: true }),
      fail: (data, code) => {
        // 301（不存在）是正常首装；其它错误码也照常尝试创建，
        // 但把 access 的真实 code 带上，绝不把它当成"缺权限"。
        try {
          file.mkdir({
            uri: uri,
            recursive: true,
            success: () => done({ ok: true, created: true }),
            fail: (md, mcode) => done({ ok: false,
              reason: 'mkdir', code: mcode, accessCode: code })
          });
        } catch (error) {
          done({ ok: false, reason: 'mkdir_throw',
            accessCode: code, error: String(error) });
        }
      }
    });
  } catch (error) {
    done({ ok: false, reason: 'access_throw',
      error: String(error) });
  }
}

export function ensureDirs(cb, onStage) {
  const report = (stage) => {
    if (typeof onStage === 'function') onStage(stage);
  };
  report('books');
  ensureDir(BOOKS_DIR, (books) => {
    if (!books.ok) {
      return complete(cb, Object.assign({ stage: 'books' }, books));
    }
    report('temp');
    ensureDir(TEMP_DIR, (temp) => {
      if (!temp.ok) {
        return complete(cb, Object.assign({ stage: 'temp' }, temp));
      }
      report('progress');
      ensureDir(PROGRESS_DIR, (progress) => {
        if (!progress.ok) {
          return complete(cb,
            Object.assign({ stage: 'progress' }, progress));
        }
        complete(cb, progress);
      });
    });
  });
}

// 把整本已解码文本写入暂存文件（消息通道传输完成后调用）。
export function saveTempBook(transferId, text, cb) {
  file.writeText({
    uri: tempPath(transferId),
    text: text,
    append: false,
    success: () => complete(cb, { ok: true }),
    fail: (data, code) => complete(cb,
      { ok: false, reason: 'write_temp', code: code })
  });
}

// 分块二进制写：把窗口字节写入目标文件。
// append=true 追加到末尾；append=false 从头创建/覆盖。
// 用于把内置书籍资源流式拷进沙箱（issue #7），
// 峰值内存只有一个窗口。
export function writeBytes(uri, bytes, append, cb) {
  file.writeArrayBuffer({
    uri: uri,
    buffer: bytes,
    append: !!append,
    success: () => complete(cb, { ok: true }),
    fail: (data, code) => complete(cb,
      { ok: false, reason: 'write_failed', code: code })
  });
}

// 校验通过后：暂存文件改名为正式书籍文件。
export function commitVerifiedBook(transferId, bookId, cb) {
  if (!isSafeBookId(bookId)) {
    return complete(cb, { ok: false, reason: 'unsafe_book_id' });
  }
  file.move({
    srcUri: tempPath(transferId),
    dstUri: bookPath(bookId),
    success: () => complete(cb, { ok: true }),
    fail: (data, code) => complete(cb,
      { ok: false, reason: 'move_to_books', code: code })
  });
}

export function openBook(bookId, cb) {
  file.access({
    uri: bookPath(bookId),
    success: () => complete(cb, { ok: true }),
    fail: (data, code) => complete(cb,
      { ok: false, reason: 'not_found', code: code })
  });
}

// 二进制窗口读取：position 是字节偏移，避免在中文 UTF-8 中间截取。
export function readBytes(bookId, offset, size, cb) {
  const off = typeof offset === 'number' && isFinite(offset) &&
    offset > 0 ? Math.floor(offset) : 0;
  file.readArrayBuffer({
    uri: bookPath(bookId),
    position: off,
    length: size,
    success: (data) => {
      if (!data || !data.buffer ||
          typeof data.buffer.byteLength !== 'number') {
        return complete(cb, { ok: false, reason: 'invalid_buffer' });
      }
      complete(cb, {
        ok: true, offset: off,
        bytes: new Uint8Array(data.buffer)
      });
    },
    fail: (data, code) => complete(cb,
      { ok: false, reason: 'read_failed', code: code })
  });
}

export function deleteBook(bookId, cb) {
  file.delete({
    uri: bookPath(bookId),
    success: () => file.delete({
      uri: progressPath(bookId),
      success: () => complete(cb, { ok: true }),
      fail: () => complete(cb, { ok: true })
    }),
    fail: (data, code) => complete(cb,
      { ok: false, reason: 'delete_failed', code: code })
  });
}

// 复制文件（文件通道接收时把 Wear Engine
// 送达的文件拷入本应用沙箱临时目录）。
export function copyFile(srcUri, dstUri, cb) {
  file.copy({
    srcUri: srcUri,
    dstUri: dstUri,
    success: () => complete(cb, { ok: true }),
    fail: (data, code) => complete(cb,
      { ok: false, reason: 'copy_failed', code: code })
  });
}

export function deleteFile(uri, cb) {
  file.delete({
    uri: uri,
    success: () => complete(cb, { ok: true }),
    fail: (data, code) => complete(cb,
      { ok: false, reason: 'delete_failed', code: code })
  });
}

// 目标文件字节数（file.get 返回 length）。
export function fileSize(uri, cb) {
  file.get({
    uri: uri,
    success: (info) => {
      if (info && typeof info.length === 'number') {
        return complete(cb, { ok: true,
          size: info.length });
      }
      complete(cb, { ok: false, reason: 'no_size' });
    },
    fail: (data, code) => complete(cb,
      { ok: false, reason: 'stat_failed', code: code })
  });
}

// 任意 URI 的二进制窗口读取（文件通道
// 流式校验用）。
export function readWindow(uri, offset, size, cb) {
  const off = typeof offset === 'number' && isFinite(offset) &&
    offset > 0 ? Math.floor(offset) : 0;
  file.readArrayBuffer({
    uri: uri,
    position: off,
    length: size,
    success: (data) => {
      if (!data || !data.buffer ||
          typeof data.buffer.byteLength !== 'number') {
        return complete(cb, { ok: false, reason: 'invalid_buffer' });
      }
      complete(cb, {
        ok: true, offset: off,
        bytes: new Uint8Array(data.buffer)
      });
    },
    fail: (data, code) => complete(cb,
      { ok: false, reason: 'read_failed', code: code })
  });
}
