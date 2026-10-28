// SPDX-License-Identifier: GPL-3.0-only
// 手表侧书籍接收入口：按 protocol v0 处理
// BOOK_META / CHAPTERS / CHUNK / FINISH / RESUME / ERROR，
// 以及 Wear Engine 文件通道（receiveFileChannel）。
// 纯逻辑在 ./TransferLogic.js（Node 可测）；本文件
// 只做 Lite JS I/O 包装。
//
// 响应通道唯一（P0-6）：ACK/RESULT/ERROR 全部
// 经 sendToPhone（即 Wear Engine sendMsg）回手机；
// onStatus 只用于本机状态显示。
import { decodeUtf8Bytes } from '../util/Utf8.js';
import { decodeBase64 } from '../util/Base64.js';
import { ensureDirs, saveTempBook,
  commitVerifiedBook, copyFile, deleteFile,
  fileSize, readWindow, tempPath } from '../storage/BookStorage.js';
import { addBook } from '../storage/LibraryIndex.js';
import { beginTransfer, applyChunk, applyChapterChunk,
  assembleChapters, assembleBytes, verifyDigest,
  createDigestVerifier } from './TransferLogic.js';

// 文件通道流式校验窗口（字节）。
var VERIFY_WINDOW = 64 * 1024;

export function IncomingBookReceiver(onStatus, sendToPhone) {
  const notify = (message) => {
    if (typeof onStatus === 'function') onStatus(message);
  };
  // 统一响应通道：手机必须能收到 RESULT，
  // 不能只在本机 notify（P0-6）。
  const respond = (text) => {
    notify(text);
    if (typeof sendToPhone === 'function') {
      sendToPhone(text);
    }
  };
  const transfers = {};   // transferId → state

  // 当前在途 transferId（单本互斥，P0-2）。
  function activeTransferId() {
    for (const id in transfers) {
      if (transfers[id]) return id;
    }
    return '';
  }

  function result(transferId, bookId, ok, reason) {
    const message = {
      v: 0, type: 'RESULT', transferId: transferId,
      bookId: bookId, ok: ok
    };
    if (!ok) message.reason = reason;
    respond(JSON.stringify(message));
    return message;
  }

  function cleanup(transferId) {
    delete transfers[transferId];
  }

  // 消息通道入口。ACK/RESULT/RESUME 全部
  // 经统一响应通道（respond → sendToPhone）
  // 回手机，不再有第二条通道。
  this.onMessage = function (messageText) {
    let message;
    try {
      message = JSON.parse(messageText);
    } catch (e) {
      return notify('收到非协议消息');
    }
    if (message.v !== 0) return notify('协议版本不支持');
    switch (message.type) {
      case 'BOOK_META': {
        // 单本互斥：第二个不同 transferId 的
        // META 返回 E_BUSY，不得按错误元信息
        // 校验/登记（P0-2）。相同 id 视为重启，
        // 状态整份替换。
        const started = beginTransfer(message,
          activeTransferId());
        if (!started.ok) {
          if (started.reason !== 'E_BUSY') {
            cleanup(message.transferId);
          }
          return result(message.transferId, message.bookId,
            false, started.reason);
        }
        transfers[message.transferId] = started.state;
        notify('接收《' + message.title + '》');
        break;
      }
      case 'CHAPTERS': {
        const state = transfers[message.transferId];
        if (!state) {
          return result(message.transferId, message.bookId,
            false, 'E_PROTOCOL');
        }
        const applied = applyChapterChunk(state, message);
        if (!applied.ok) {
          cleanup(message.transferId);
          return result(message.transferId, message.bookId,
            false, applied.reason);
        }
        break;
      }
      case 'CHUNK': {
        const state = transfers[message.transferId];
        if (!state) {
          return result(message.transferId, message.bookId,
            false, 'E_PROTOCOL');
        }
        const payload = decodeBase64(message.payloadB64 || '');
        const applied = applyChunk(state, message, payload);
        if (!applied.ok) {
          cleanup(message.transferId);
          return result(message.transferId, message.bookId,
            false, applied.reason);
        }
        // ACK 经统一响应通道回发（唯一通道）。
        respond(JSON.stringify({
          v: 0, type: 'ACK', transferId: message.transferId,
          bookId: message.bookId, index: message.index,
          ok: true
        }));
        break;
      }
      case 'FINISH': {
        const state = transfers[message.transferId];
        if (!state) {
          return result(message.transferId, message.bookId,
            false, 'E_PROTOCOL');
        }
        const chapters = assembleChapters(state);
        if (!chapters.ok) {
          cleanup(message.transferId);
          return result(message.transferId, state.meta.bookId,
            false, chapters.reason);
        }
        const assembled = assembleBytes(state);
        if (!assembled.ok) {
          cleanup(message.transferId);
          return result(message.transferId, state.meta.bookId,
            false, assembled.reason);
        }
        if (!verifyDigest(assembled.bytes, state.meta.sha256)) {
          cleanup(message.transferId);
          return result(message.transferId, state.meta.bookId,
            false, 'E_DIGEST_MISMATCH');
        }
        const text = decodeUtf8Bytes(assembled.bytes);
        persistTransfer(state, text, (saved) => {
          cleanup(message.transferId);
          return result(message.transferId, state.meta.bookId,
            saved.ok, saved.reason);
        });
        break;
      }
      case 'RESUME': {
        const state = transfers[message.transferId];
        if (!state) {
          notify('未知传输：' + message.transferId);
          break;
        }
        // 消息通道按序到达：RESUME 回报当前已收字节数，
        // 发送方从该偏移继续。
        // RESUME 经统一响应通道回发（唯一通道）。
        respond(JSON.stringify({
          v: 0, type: 'RESUME',
          transferId: message.transferId,
          bookId: state.meta.bookId,
          received: [state.receivedCount]
        }));
        break;
      }
      case 'ERROR': {
        if (message.code === 'E_CANCELLED' &&
            message.transferId) {
          cleanup(message.transferId);
          notify('传输已取消');
        } else {
          notify('对端错误：' + (message.code || 'unknown'));
        }
        break;
      }
      default:
        notify('未知协议消息：' + message.type);
    }
  };

  function persistTransfer(state, text, cb) {
    ensureDirs((dirs) => {
      if (!dirs.ok) {
        return cb({ ok: false, reason: 'E_SPACE' });
      }
      saveTempBook(state.meta.transferId, text, (saved) => {
        if (!saved.ok) {
          return cb({ ok: false, reason: 'E_SPACE' });
        }
        commitVerifiedBook(state.meta.transferId,
          state.meta.bookId, (committed) => {
            if (!committed.ok) {
              return cb({ ok: false,
                reason: 'E_SPACE' });
            }
            addBook({
              bookId: state.meta.bookId,
              title: state.meta.title,
              encoding: state.meta.encoding,
              bytes: state.meta.bytes,
              sha256: state.meta.sha256,
              chunks: state.meta.chunks,
              chunkBytes: state.meta.chunkBytes,
              chapters: state.meta.chapters
            }, (added) => {
              cb(added.ok ? { ok: true } :
                { ok: false, reason: 'E_SPACE' });
            });
          });
      });
    });
  }

  // 文件通道（P0-5）：Wear Engine 把手机发来的
  // 文件送达 srcUri（回调给出路径）。这里把它
  // 拷入本应用沙箱 temp/<transferId> → 校验
  // 大小 + 流式 SHA-256 → 原子入库 → RESULT。
  // 任一步失败：清理暂存、绝不入书架。
  this.receiveFileChannel = function (srcUri, fileApi, cb) {
    const state = oldestPendingTransfer();
    if (!state) {
      const outcome = { ok: false,
        reason: 'E_PROTOCOL' };
      // 无在途传输：也把 RESULT 回手机。
      notify(JSON.stringify({
        v: 0, type: 'RESULT', transferId: '',
        bookId: '', ok: false,
        reason: outcome.reason }));
      return cb(outcome);
    }
    const meta = state.meta;
    const dst = tempPath(meta.transferId);
    const finish = (ok, reason) => {
      // 统一响应通道：文件通道的结果
      // 同样必须以 RESULT 回手机（P0-6）。
      result(meta.transferId, meta.bookId,
        ok, reason);
      cb(ok ? { ok: true } :
        { ok: false, reason: reason });
    };
    const chapters = assembleChapters(state);
    if (!chapters.ok) {
      cleanup(meta.transferId);
      return finish(false, chapters.reason);
    }
    ensureDirs((dirs) => {
      if (!dirs.ok) {
        cleanup(meta.transferId);
        return finish(false, 'E_SPACE');
      }
      copyFile(srcUri, dst, (copied) => {
        if (!copied.ok) {
          cleanup(meta.transferId);
          return finish(false, copied.reason);
        }
        verifyFile(dst, meta, (verified) => {
          if (!verified.ok) {
            // 校验失败：删除暂存，不入书架。
            deleteFile(dst, () => {});
            cleanup(meta.transferId);
            return finish(false, verified.reason);
          }
          commitVerifiedBook(meta.transferId,
            meta.bookId, (committed) => {
              if (!committed.ok) {
                deleteFile(dst, () => {});
                cleanup(meta.transferId);
                return finish(false, 'E_SPACE');
              }
              addBook({
                bookId: meta.bookId,
                title: meta.title,
                encoding: meta.encoding,
                bytes: meta.bytes,
                sha256: meta.sha256,
                chunks: meta.chunks,
                chunkBytes: meta.chunkBytes,
                chapters: meta.chapters
              }, (added) => {
                cleanup(meta.transferId);
                finish(added.ok,
                  added.ok ? undefined : 'E_SPACE');
              });
            });
        });
      });
    });
  };

  // 最早一个尚未完成的传输（BOOK_META 已建
  // 状态、文件通道尚未到达）。单本在途约束。
  function oldestPendingTransfer() {
    let oldest = null;
    for (const id in transfers) {
      if (transfers[id] && !oldest) {
        oldest = transfers[id];
      }
    }
    return oldest;
  }

  // 大小 + 流式 SHA-256 校验：固定窗口读取，
  // 峰值内存只有一个窗口（P1-11）。
  function verifyFile(uri, meta, cb) {
    fileSize(uri, (stat) => {
      if (!stat.ok) {
        return cb({ ok: false, reason: stat.reason });
      }
      if (stat.size !== meta.bytes) {
        return cb({ ok: false,
          reason: 'E_SIZE_MISMATCH' });
      }
      const verifier = createDigestVerifier(meta.sha256);
      readNext(uri, 0, verifier, meta, cb);
    });
  }

  function readNext(uri, offset, verifier, meta, cb) {
    if (offset >= meta.bytes) {
      return cb(verifier.finish(meta.bytes));
    }
    const size = Math.min(VERIFY_WINDOW,
      meta.bytes - offset);
    readWindow(uri, offset, size, (r) => {
      if (!r.ok) {
        return cb({ ok: false, reason: r.reason });
      }
      verifier.update(r.bytes);
      readNext(uri, offset + size, verifier, meta, cb);
    });
  }
}
