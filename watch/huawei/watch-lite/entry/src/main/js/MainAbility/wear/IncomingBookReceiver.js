// SPDX-License-Identifier: GPL-3.0-only
// 手表侧书籍接收入口：按 protocol v0 处理
// BOOK_META / CHAPTERS / CHUNK / FINISH / RESUME / ERROR，
// 以及 Wear Engine 文件通道（receiveFileChannel）。
// 纯逻辑在 ./TransferLogic.js（Node 可测）；本文件
// 只做 Lite JS I/O 包装。
//
// 消息通道 ACK/RESULT/ERROR 与阅读进度消息经
// sendToPhone（Wear Engine sendMsg）回手机；文件通道
// 不依赖应用层回执。
import { decodeUtf8Bytes } from '../util/Utf8.js';
import { decodeBase64 } from '../util/Base64.js';
import { ensureDirs, saveTempBook,
  commitVerifiedBook, copyFile, deleteFile,
  fileSize, readWindow, tempPath } from '../storage/BookStorage.js';
import { addBook } from '../storage/LibraryIndex.js';
import { beginTransfer, applyChunk, applyChapterChunk,
  assembleChapters, missingChapterIndices, assembleBytes, verifyDigest,
  createDigestVerifier } from './TransferLogic.js';

// 文件通道流式校验窗口（字节）。
var VERIFY_WINDOW = 64 * 1024;

export function IncomingBookReceiver(onStatus, sendToPhone, options) {
  const config = options || {};
  // Bound abandoned phone metadata so a later user send is not left busy.
  const staleTimeoutMs = typeof config.staleTimeoutMs === 'number' &&
    isFinite(config.staleTimeoutMs) && config.staleTimeoutMs > 0 ?
    config.staleTimeoutMs : 7 * 60 * 1000;
  const now = typeof config.now === 'function' ?
    config.now : () => Date.now();
  const setTimer = typeof config.setTimeout === 'function' ?
    config.setTimeout : setTimeout;
  const clearTimer = typeof config.clearTimeout === 'function' ?
    config.clearTimeout : clearTimeout;
  const notify = (message) => {
    if (typeof onStatus === 'function') onStatus(message);
  };
  // 消息通道协议结果和进度消息共用响应通道；文件通道
  // 的完成由手机侧 Wear Engine transferFile 回调报告。
  const respond = (text) => {
    notify(text);
    if (typeof sendToPhone === 'function') {
      sendToPhone(text);
    }
  };
  const transfers = {};   // transferId → state
  const staleTimers = {}; // transferId → bounded cleanup timer
  const expiresAt = {};

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
    if (staleTimers[transferId] !== undefined) {
      clearTimer(staleTimers[transferId]);
      delete staleTimers[transferId];
    }
    delete expiresAt[transferId];
    delete transfers[transferId];
  }

  function expireIfStale(transferId, expectedState) {
    if (transfers[transferId] !== expectedState) return;
    delete staleTimers[transferId];
    const remaining = expiresAt[transferId] - now();
    if (remaining > 0) {
      staleTimers[transferId] = setTimer(() =>
        expireIfStale(transferId, expectedState), remaining);
      return;
    }
    cleanup(transferId);
    console.warn('transfer expired reason=E_TIMEOUT');
    notify('传书状态超时，已清理');
  }

  function armStaleCleanup(transferId, state) {
    if (staleTimers[transferId] !== undefined) {
      clearTimer(staleTimers[transferId]);
    }
    expiresAt[transferId] = now() + staleTimeoutMs;
    staleTimers[transferId] = setTimer(() =>
      expireIfStale(transferId, state), staleTimeoutMs);
  }

  function expireStaleTransfers() {
    const currentTime = now();
    for (const transferId in transfers) {
      if (expiresAt[transferId] !== undefined &&
          expiresAt[transferId] <= currentTime) {
        expireIfStale(transferId, transfers[transferId]);
      }
    }
  }

  // 消息通道入口。旧式 CHUNK/FINISH 的 ACK/RESULT 与
  // 阅读进度消息仍经统一响应通道；文件通道不等待应用层回执。
  this.onMessage = function (messageText) {
    let message;
    try {
      message = JSON.parse(messageText);
    } catch (e) {
      return notify('收到非协议消息');
    }
    if (message.v !== 0) return notify('协议版本不支持');
    // A fresh user-initiated BOOK_META must not remain blocked by an old
    // transfer if a best-effort E_CANCELLED could not reach the watch.
    expireStaleTransfers();
    switch (message.type) {
      case 'BOOK_META': {
        const existing = transfers[message.transferId];
        if (existing && existing.fileReceiving) {
          return result(message.transferId, message.bookId,
            false, 'E_BUSY');
        }
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
        armStaleCleanup(message.transferId, started.state);
        if (started.state.expectedChapterChunks > 0) {
          console.info('chapter chunks expected=' +
            started.state.expectedChapterChunks);
        }
        notify('接收《' + message.title + '》');
        break;
      }
      case 'CHAPTERS': {
        const state = transfers[message.transferId];
        if (!state) {
          console.warn('chapter chunk rejected reason=E_PROTOCOL');
          break;
        }
        const applied = applyChapterChunk(state, message);
        if (!applied.ok) {
          state.chapterCatalogInvalid = true;
          state.chapterChunks = {};
          state.chapterChunksReceived = 0;
          state.meta.chapters = [];
          console.warn('chapter chunk rejected reason=' + applied.reason);
          break;
        }
        console.info('chapter chunk index=' +
          (message.index + 1) + '/' + state.expectedChapterChunks +
          ' received=' + state.chapterChunksReceived);
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
        const assembledChapters = assembleChapters(state);
        const chapters = assembledChapters.ok ?
          assembledChapters.chapters : [];
        if (!assembledChapters.ok) {
          console.warn('message channel book has no complete chapter catalog: ' +
            assembledChapters.reason);
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
        persistTransfer(state, text, chapters, (saved) => {
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

  function persistTransfer(state, text, chapters, cb) {
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
              chapters: chapters
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
  // 大小 + 流式 SHA-256 → 原子入库。
  // 任一步失败：清理暂存、绝不入书架。
  this.receiveFileChannel = function (srcUri, fileApi, cb) {
    const state = oldestPendingTransfer();
    if (!state) {
      const outcome = { ok: false,
        reason: 'E_PROTOCOL' };
      return cb(outcome);
    }
    const meta = state.meta;
    if (state.fileReceiving) {
      return cb({ ok: false, reason: 'E_BUSY' });
    }
    // Prevent a second file callback from being associated with the same
    // oldest pending BOOK_META while its first body is being verified.
    state.fileReceiving = true;
    const dst = tempPath(meta.transferId);
    const finish = (ok, reason) => {
      cb(ok ? { ok: true } :
        { ok: false, reason: reason });
    };
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
          // Chapter messages can still be queued while the copied body is
          // being checked. Snapshot only after size/SHA succeeds so a late
          // complete catalog remains available for chapter jumps. The body
          // never waits for a catalog or an app-level acknowledgment.
          const assembledChapters = assembleChapters(state);
          const chapters = assembledChapters.ok ?
            assembledChapters.chapters : [];
          if (!assembledChapters.ok) {
            const missing = missingChapterIndices(state);
            console.warn('file channel proceeding without complete chapter catalog ' +
              'received=' + state.chapterChunksReceived + '/' +
              state.expectedChapterChunks + ' missing=' + missing.join(','));
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
                chapters: chapters
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
