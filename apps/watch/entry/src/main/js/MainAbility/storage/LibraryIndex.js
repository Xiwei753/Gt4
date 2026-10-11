// SPDX-License-Identifier: GPL-3.0-only
// 多书索引：books.json。只有文件真实存在且校验通过的
// 书籍才对用户可见；索引与文件不一致时以文件为准清理。
//
// 可靠性（施工单 P1-12 / issue #9 A2-A5）：
//   - 先探测（access/get）再读：不存在索引（真实 301）
//     立即视为正常空书架，不阻塞、不重造；
//   - 小索引用简单 readText({uri})（上游 Lite 示例用法），
//     不固定 65536、也不一上来 readArrayBuffer；只有明确
//     超过 4 KB 上限才走分块字节读；
//   - 每次读/写恰好一次结构化回调（含 api/stage/code 或
//     timeout），settled 守卫防止超时后的迟到回调复写；
//   - 安全替换：tmp 写→回读校验→备份现有→move（不删目标），
//     move 失败改为覆盖写；另存 books.json.bak 供回退，
//     绝不出现「move 失败→删除原索引→再 move」的数据丢失；
//   - 写操作串行化：并发 addBook/removeBook 与 listBooks
//     的清理周期都经同一队列。
import file from '@system.file';
import { INDEX_FILE, bookPath, isSafeBookId,
  complete, deleteFile } from './BookStorage.js';
import { decodeUtf8Bytes } from '../util/Utf8.js';

var INDEX_TMP = INDEX_FILE + '.tmp';
var INDEX_BAK = INDEX_FILE + '.bak';
var TEXT_CHUNK = 4096;
var MAX_INDEX_TEXT = 1024 * 1024;
// 单次文件操作超时（issue #9 A3）：底层 API 不回调时以
// 结构化错误回报，绝不无限等待。
var OP_TIMEOUT_MS = 8000;
// 队列看门狗：极端情况下释放队列，并让调用方拿到结构化
// 超时错误。默认 12s（大于单次操作超时）。
var QUEUE_TIMEOUT_MS = 12000;
var queue = [];
var running = false;
// 最近一次成功写入的索引内容（深拷贝快照）。
var lastGood = [];

export function setQueueTimeout(ms) {
  if (typeof ms === 'number' && ms > 0) QUEUE_TIMEOUT_MS = ms;
}
export function setIndexTimeout(ms) {
  if (typeof ms === 'number' && ms > 0) OP_TIMEOUT_MS = ms;
}

function parseEntries(text) {
  try {
    const parsed = JSON.parse(text || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) => e && isSafeBookId(e.bookId) &&
      typeof e.title === 'string');
  } catch (e) {
    return [];
  }
}

// 深拷贝：元素必须复制。
function snapshot(entries) {
  const out = [];
  for (var i = 0; i < entries.length; i++) {
    out.push(Object.assign({}, entries[i]));
  }
  return out;
}

// 结算一次：超时后的迟到回调不得复写结果。
function once(cb) {
  var called = false;
  return function (value) {
    if (called) return;
    called = true;
    cb(value);
  };
}

// 单次、带超时的文件操作：无论底层是否回调，
// 一定回报一次 { ok:true,... } 或
// { ok:false, api, stage, reason, code }。
function timed(api, stage, timeoutMs, cb, start) {
  var timer = null;
  var finish = once(function (r) {
    if (timer !== null && typeof clearTimeout === 'function') {
      clearTimeout(timer);
      timer = null;
    }
    var out = r || {};
    if (!out.api) out.api = api;
    if (!out.stage) out.stage = stage;
    cb(out);
  });
  if (typeof setTimeout === 'function') {
    timer = setTimeout(function () {
      finish({ ok: false, reason: 'timeout', code: 'timeout' });
    }, timeoutMs);
  }
  try {
    start(finish);
  } catch (error) {
    finish({ ok: false, reason: 'throw', code: 'throw',
      error: String(error) });
  }
}

// 探测索引：先 access 判断存在，再 get 取大小（get 失败不致命）。
function probeIndex(uri, cb) {
  timed('access', '探测索引', OP_TIMEOUT_MS, cb, function (done) {
    file.access({
      uri: uri,
      success: function () {
        timed('get', '探测索引大小', OP_TIMEOUT_MS,
          function (g) {
            done({ ok: true, exists: true,
              size: g.ok ? g.size : -1,
              sizeApi: g.ok ? 'get' : 'access' });
          }, function (gdone) {
            file.get({
              uri: uri,
              success: function (info) {
                var size = (info &&
                  typeof info.length === 'number') ?
                  info.length : -1;
                gdone({ ok: true, size: size });
              },
              fail: function (data, code) {
                gdone({ ok: false, code: code });
              }
            });
          });
      },
      fail: function (data, code) {
        if (code === 301) {
          return done({ ok: true, exists: false, size: 0 });
        }
        done({ ok: false, reason: 'fail', code: code });
      }
    });
  });
}

// 小索引：上游 Lite 示例的简单读法（不传 length）。
function readTextWhole(uri, cb) {
  timed('readText', '读取索引', OP_TIMEOUT_MS, cb,
    function (done) {
      file.readText({
        uri: uri,
        success: function (data) {
          done({ ok: true, text: (data && data.text) || '' });
        },
        fail: function (data, code) {
          done({ ok: false, reason: 'fail', code: code });
        }
      });
    });
}

// 大索引：分块字节读（先在真机自检确认可用；见 WatchFileProbe）。
function readBytesChunked(uri, cb) {
  var parts = [];
  var total = 0;
  function step(position) {
    timed('readArrayBuffer', '分块读取索引', OP_TIMEOUT_MS,
      function (r) {
        if (!r.ok) return complete(cb, r);
        if (r.empty) {
          return complete(cb, (total === 0) ?
            { ok: false, reason: 'empty' } :
            { ok: false, reason: 'truncated' });
        }
        parts.push(r.bytes);
        total += r.bytes.length;
        const parsed = parseAccumulated(parts, total);
        if (parsed && parsed.text) {
          return complete(cb, { ok: true, text: parsed.text,
            api: 'readArrayBuffer' });
        }
        if (parsed && parsed.bad) {
          return complete(cb, { ok: false, reason: 'bad_shape' });
        }
        if (total >= MAX_INDEX_TEXT) {
          return complete(cb, { ok: false, reason: 'too_long' });
        }
        step(position + r.bytes.length);
      }, function (done) {
        file.readArrayBuffer({
          uri: uri, length: TEXT_CHUNK, position: position,
          success: function (data) {
            var bytes = (data && data.buffer) ?
              new Uint8Array(data.buffer) : null;
            if (!bytes || bytes.length === 0) {
              return done({ ok: true, empty: true });
            }
            done({ ok: true, bytes: bytes });
          },
          fail: function (data, code) {
            done({ ok: false, reason: 'fail', code: code });
          }
        });
      });
  }
  step(0);
}

// 把已累积的分块字节整体 UTF-8 解码后再尝试 JSON.parse。
function parseAccumulated(parts, total) {
  const all = new Uint8Array(total);
  var offset = 0;
  for (var i = 0; i < parts.length; i++) {
    all.set(parts[i], offset);
    offset += parts[i].length;
  }
  const text = decodeUtf8Bytes(all);
  try {
    const value = JSON.parse(text);
    if (Array.isArray(value)) return { text: text };
    return { bad: true };
  } catch (e) {
    return null;
  }
}

// 读取任意索引文件（正式或备份或 tmp）：
// 探测 → 小文件 readText → 大文件分块。
// 回传 { ok:true, text, api } 或
// { ok:false, missing:true } 或
// { ok:false, reason, code, api, stage }。
function readIndexFrom(uri, cb) {
  probeIndex(uri, function (p) {
    if (!p.ok) return complete(cb, p);
    if (!p.exists) {
      return complete(cb, { ok: false, missing: true,
        reason: 'missing', code: 301, api: 'access',
        stage: '探测索引' });
    }
    if (p.size >= 0 && p.size <= TEXT_CHUNK) {
      return readTextWhole(uri, function (r) {
        if (r.ok) {
          if (r.text.length === 0) {
            return complete(cb, { ok: false, reason: 'empty' });
          }
          return complete(cb, { ok: true, text: r.text,
            api: 'readText' });
        }
        // readText 超上限(302)：改走分块；其它错误按原样回报。
        if (r.code === 302) return readBytesChunked(uri, cb);
        complete(cb, r);
      });
    }
    readBytesChunked(uri, cb);
  });
}

// 保持既有契约名：读正式索引文件。
function readIndexText(cb) {
  readIndexFrom(INDEX_FILE, cb);
}

// 索引缺失/损坏时回退备份；都没有则按正常空库/错误处理。
function tryBackup(kind, primary, finishOk, report, cb) {
  readIndexFrom(INDEX_BAK, function (b) {
    if (b.ok) {
      report('recovered', 0, b.api || 'readText', '读取备份索引');
      return finishOk(b.text, b.api || 'readText');
    }
    if (kind === 'missing') {
      report('missing', primary.code || 'missing',
        primary.api || 'access', primary.stage || '探测索引');
      return complete(cb, []);
    }
    report('error', primary.code || primary.reason,
      primary.api || 'readText', primary.stage || '读取索引');
    complete(cb, []);
  });
}

export function loadIndex(cb, onDiag) {
  const report = function (state, code, api, stage) {
    if (typeof onDiag === 'function') {
      onDiag({ state: state, code: code, api: api,
        stage: stage });
    }
  };
  const finishOk = function (text, api) {
    const entries = parseEntries(text);
    lastGood = snapshot(entries);
    report('ok', 0, api || 'readText', '读取索引');
    complete(cb, snapshot(entries));
  };
  readIndexText(function (r) {
    if (r.ok) return finishOk(r.text, r.api);
    // 301（无索引）与空文件都先看备份，再当正常空库；
    // 损坏/错误也尝试备份，避免误报而丢书。
    if (r.missing || r.reason === 'empty') {
      return tryBackup('missing', r, finishOk, report, cb);
    }
    tryBackup('error', r, finishOk, report, cb);
  });
}

// 校验 tmp：回读并解析成数组。
function verifyTmp(cb) {
  readIndexFrom(INDEX_TMP, function (r) {
    if (!r.ok) {
      return complete(cb, { ok: false,
        code: r.code || r.reason });
    }
    var ok = false;
    try { ok = Array.isArray(JSON.parse(r.text)); } catch (e) {
      ok = false;
    }
    complete(cb, ok ? { ok: true } : { ok: false, code: 'parse' });
  });
}

// 备份现有正式索引到 .bak（尽力而为，失败不阻断写入）。
function backupCurrent(cb) {
  readIndexFrom(INDEX_FILE, function (r) {
    if (!r.ok || !r.text) return cb();
    timed('writeText', '写索引备份', OP_TIMEOUT_MS,
      function () { cb(); }, function (done) {
        file.writeText({
          uri: INDEX_BAK, text: r.text, append: false,
          success: function () { done({ ok: true }); },
          fail: function () { done({ ok: false }); }
        });
      });
  });
}

// 把 tmp 提交为正式索引：不删除原文件；move 失败改为覆盖写。
function commitIndexTmp(text, cb) {
  timed('move', '提交索引', OP_TIMEOUT_MS, cb, function (done) {
    file.move({
      srcUri: INDEX_TMP, dstUri: INDEX_FILE,
      success: function () { done({ ok: true }); },
      fail: function () {
        // 目标可能存在且不可覆盖：不做删除，直接覆盖写入。
        timed('writeText', '覆盖索引', OP_TIMEOUT_MS,
          function (w) {
            done(w.ok ? { ok: true } :
              { ok: false, reason: 'index_commit', code: w.code });
          }, function (wdone) {
            file.writeText({
              uri: INDEX_FILE, text: text, append: false,
              success: function () { wdone({ ok: true }); },
              fail: function (d, c) {
                wdone({ ok: false, reason: 'fail', code: c });
              }
            });
          });
      }
    });
  });
}

function saveIndexAtomic(entries, cb) {
  const text = JSON.stringify(entries);
  timed('writeText', '写临时索引', OP_TIMEOUT_MS,
    function (w) {
      if (!w.ok) {
        return complete(cb, { ok: false,
          reason: 'index_write', code: w.code });
      }
      verifyTmp(function (v) {
        if (!v.ok) {
          return complete(cb, { ok: false,
            reason: 'index_verify', code: v.code });
        }
        backupCurrent(function () {
          commitIndexTmp(text, function (c) {
            if (!c.ok) return complete(cb, c);
            lastGood = snapshot(entries);
            complete(cb, { ok: true });
          });
        });
      });
    }, function (done) {
      file.writeText({
        uri: INDEX_TMP, text: text, append: false,
        success: function () { done({ ok: true }); },
        fail: function (d, c) {
          done({ ok: false, reason: 'fail', code: c });
        }
      });
    });
}

// 写操作串行化：entry = { run:fn(done), abort:fn() }。
function enqueue(entry) {
  queue.push(entry);
  if (!running) runNext();
}

function runNext() {
  if (queue.length === 0) {
    running = false;
    return;
  }
  running = true;
  const entry = queue.shift();
  var settled = false;
  var timer = null;
  const done = function () {
    if (settled) return;
    settled = true;
    if (timer !== null && typeof clearTimeout === 'function') {
      clearTimeout(timer);
      timer = null;
    }
    runNext();
  };
  if (typeof setTimeout === 'function') {
    timer = setTimeout(function () {
      console.error('LibraryIndex: 队列看门狗超时，' +
        '向调用方回报结构化错误');
      try {
        if (typeof entry.abort === 'function') entry.abort();
      } catch (e) { /* 兜底 */ }
      done();
    }, QUEUE_TIMEOUT_MS);
  }
  try {
    entry.run(done);
  } catch (error) {
    console.error('LibraryIndex: 任务同步异常 ' + error);
    try {
      if (typeof entry.abort === 'function') entry.abort();
    } catch (e) { /* 兜底 */ }
    done();
  }
}

// 写失败回滚：把最近一次成功的快照写回并回读校验。
function rollback(orphanEntry, cb) {
  const restore = snapshot(lastGood);
  saveIndexAtomic(restore, function (state) {
    if (!state.ok) {
      return complete(cb, { restored: false,
        reason: 'E_ROLLBACK_FAILED' });
    }
    readIndexText(function (r) {
      if (!r.ok) {
        return complete(cb, { restored: false,
          reason: 'E_ROLLBACK_FAILED',
          code: r.code || r.reason });
      }
      const onDisk = parseEntries(r.text);
      if (JSON.stringify(onDisk) !== JSON.stringify(restore)) {
        return complete(cb, { restored: false,
          reason: 'E_ROLLBACK_MISMATCH' });
      }
      finishRollback(orphanEntry, cb);
    });
  });
}

function finishRollback(orphanEntry, cb) {
  if (orphanEntry && isSafeBookId(orphanEntry.bookId)) {
    deleteFile(bookPath(orphanEntry.bookId), function () {
      complete(cb, { restored: true });
    });
  } else {
    complete(cb, { restored: true });
  }
}

export function listBooks(cb, onDiag) {
  const finish = once(cb);
  enqueue({
    run: function (done) {
      loadIndex(function (entries) {
        let pending = entries.length;
        const alive = new Array(entries.length);
        if (pending === 0) {
          done();
          return finish([]);
        }
        const settleIfDone = function () {
          if (--pending > 0) return;
          const result = snapshot(alive.filter((e) => !!e));
          if (result.length === entries.length) {
            done();
            return finish(result);
          }
          saveIndexAtomic(result, function () {
            done();
            finish(result);
          });
        };
        entries.forEach(function (entry, index) {
          timed('access', '检查书籍文件', OP_TIMEOUT_MS,
            function (r) {
              // 超时视为「仍在」：宁可保留也不误删用户的书。
              alive[index] = (r.ok || r.reason === 'timeout') ?
                entry : null;
              settleIfDone();
            }, function (adone) {
              file.access({
                uri: bookPath(entry.bookId),
                success: function () { adone({ ok: true }); },
                fail: function () { adone({ ok: false }); }
              });
            });
        });
      }, onDiag);
    },
    abort: function () {
      if (typeof onDiag === 'function') {
        try {
          onDiag({ state: 'error', code: 'timeout', api: 'queue',
            stage: '读取索引' });
        } catch (e) { /* 兜底 */ }
      }
      finish([]);
    }
  });
}

export function getBook(bookId, cb) {
  if (!isSafeBookId(bookId)) return complete(cb, null);
  loadIndex(function (entries) {
    const found = entries.filter((e) => e.bookId === bookId);
    if (found.length === 0) return complete(cb, null);
    timed('access', '检查书籍文件', OP_TIMEOUT_MS,
      function (r) {
        complete(cb, r.ok ? found[0] : null);
      }, function (done) {
        file.access({
          uri: bookPath(bookId),
          success: function () { done({ ok: true }); },
          fail: function () { done({ ok: false }); }
        });
      });
  });
}

// 重复发送同一书籍时不覆盖阅读进度，只更新元信息。
export function addBook(entry, cb) {
  const finish = once(cb);
  enqueue({
    run: function (done) {
      loadIndex(function (entries) {
        const idx = entries.findIndex(
          (e) => e.bookId === entry.bookId);
        const isNew = idx < 0;
        const next = isNew ?
          entries.concat([Object.assign({}, entry,
            { addedAt: Date.now() })]) :
          entries.map((e, i) => i === idx ?
            Object.assign({}, entry,
              { addedAt: e.addedAt }) : e);
        saveIndexAtomic(next, function (state) {
          if (!state.ok) {
            rollback(isNew ? entry : null, function (rolled) {
              done();
              finish(rolled.restored ? state :
                Object.assign({}, state,
                  { rollback: rolled.reason }));
            });
            return;
          }
          done();
          finish({ ok: true });
        });
      });
    },
    abort: function () {
      finish({ ok: false, reason: 'timeout',
        code: 'timeout' });
    }
  });
}

export function removeBook(bookId, cb) {
  const finish = once(cb);
  enqueue({
    run: function (done) {
      loadIndex(function (entries) {
        const kept = entries.filter(
          (e) => e.bookId !== bookId);
        if (kept.length === entries.length) {
          done();
          return finish({ ok: true });
        }
        saveIndexAtomic(kept, function (state) {
          if (!state.ok) {
            rollback(null, function (rolled) {
              done();
              finish(rolled.restored ? state :
                Object.assign({}, state,
                  { rollback: rolled.reason }));
            });
            return;
          }
          done();
          finish(state);
        });
      });
    },
    abort: function () {
      finish({ ok: false, reason: 'timeout',
        code: 'timeout' });
    }
  });
}
