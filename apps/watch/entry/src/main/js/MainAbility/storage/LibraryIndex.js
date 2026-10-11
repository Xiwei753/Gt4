// SPDX-License-Identifier: GPL-3.0-only
// 多书索引：books.json。只有文件真实存在且校验通过的
// 书籍才对用户可见；索引与文件不一致时以文件为准清理。
//
// 可靠性（施工单 P1-12 / 第二轮 P0-4）：
//   - 原子写：books.json.tmp → move 覆盖正式文件；
//     move 对已存在目标的行为不假设可覆盖：
//     先尝试 move，失败则删除目标后再 move 一次；
//   - 写操作串行化：并发 addBook/removeBook 与
//     listBooks 的清理周期都经同一队列；
//   - 快照不可变：lastGood 保存深拷贝，写入
//     期间绝不原地修改快照（否则回滚会写回
//     刚失败的脏数据）；
//   - 回滚后回读磁盘校验，失败如实上报。
import file from '@system.file';
import { INDEX_FILE, bookPath, isSafeBookId,
  complete, deleteFile } from './BookStorage.js';
import { decodeUtf8Bytes } from '../util/Utf8.js';

var INDEX_TMP = INDEX_FILE + '.tmp';
var queue = [];
var running = false;
// 队列看门狗（issue #8）：底层文件操作既不回调 success
// 也不回调 fail 时，必须释放 running，避免后续所有
// listBooks 永久排队阻塞。释放不等于伪造成功：调用方
// 的回调不会在这里被触发。默认 9s，测试可缩短。
var QUEUE_TIMEOUT_MS = 9000;

export function setQueueTimeout(ms) {
  if (typeof ms === 'number' && ms > 0) QUEUE_TIMEOUT_MS = ms;
}
// 最近一次成功写入的索引内容（深拷贝快照，
// 任何写路径都不得修改其元素）。
var lastGood = [];

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

// 深拷贝：元素必须复制，不能与调用方
// 后续修改共享引用。
function snapshot(entries) {
  const out = [];
  for (var i = 0; i < entries.length; i++) {
    out.push(Object.assign({}, entries[i]));
  }
  return out;
}

var TEXT_CHUNK = 4096;
var MAX_INDEX_TEXT = 1024 * 1024;

// 把已累积的分块字节整体 UTF-8 解码后再尝试 JSON.parse。
// 返回 { text }（完整 JSON 数组）/ { bad:true }（能解析但不是数组）
// / null（还读全）。
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

// 索引读取（issue #8 真机修正）：Lite `@system.file.readText`
// 单次文本上限 4 KB（超过报 302），旧的固定 65536 长度在真机上
// 直接读取失败。这里改用受控长度分块 readArrayBuffer →
// 累积字节 → 一次性 UTF-8 解码 → JSON.parse：既绕开 4 KB 限制，
// 也避免多字节汉字被截断在分块边界。总内存上限 1 MiB。
// 回传 { ok:true, text } 或 { ok:false, reason, code }。
function readIndexText(cb) {
  var parts = [];
  var total = 0;
  function step(position) {
    try {
      file.readArrayBuffer({
        uri: INDEX_FILE,
        length: TEXT_CHUNK,
        position: position,
        success: (data) => {
          const bytes = (data && data.buffer) ?
            new Uint8Array(data.buffer) : null;
          if (!bytes || bytes.length === 0) {
            // 读到文件尾仍凑不成完整数组：空文件=空库，
            // 否则视为损坏/截断，绝不伪造成功。
            return complete(cb, (total === 0) ?
              { ok: false, reason: 'empty' } :
              { ok: false, reason: 'truncated' });
          }
          parts.push(bytes);
          total += bytes.length;
          const parsed = parseAccumulated(parts, total);
          if (parsed && parsed.text) {
            return complete(cb, { ok: true, text: parsed.text });
          }
          if (parsed && parsed.bad) {
            return complete(cb, { ok: false, reason: 'bad_shape' });
          }
          if (total >= MAX_INDEX_TEXT) {
            return complete(cb, { ok: false, reason: 'too_long' });
          }
          step(position + bytes.length);
        },
        fail: (data, code) => {
          complete(cb, { ok: false, reason: 'fail', code: code });
        }
      });
    } catch (error) {
      complete(cb, { ok: false, reason: 'throw' });
    }
  }
  step(0);
}

export function loadIndex(cb, onDiag) {
  const report = (state, code, api) => {
    if (typeof onDiag === 'function') {
      onDiag({ state: state, code: code, api: api });
    }
  };
  readIndexText((r) => {
    if (r.ok) {
      const entries = parseEntries(r.text);
      lastGood = snapshot(entries);
      report('ok', 0, 'readArrayBuffer');
      return complete(cb, snapshot(entries));
    }
    // 301 = 从未创建过 books.json（首次安装，正常空库）；
    // 空文件同样按空库处理。其它（300/202/302 等）是真正的
    // 文件系统异常，必须带真实 code + 出错接口上报启动页，
    // 不能混成"空书架"。
    if ((r.code === 301) || (r.reason === 'empty')) {
      report('missing', r.code || r.reason, 'readArrayBuffer');
      return complete(cb, []);
    }
    report('error', r.code || r.reason, 'readArrayBuffer');
    complete(cb, []);
  });
}

// 把 tmp 提交为正式索引：不假设 move 可以
// 覆盖已存在的目标文件。
function commitIndexTmp(cb) {
  file.move({
    srcUri: INDEX_TMP,
    dstUri: INDEX_FILE,
    success: () => complete(cb, { ok: true }),
    fail: () => {
      // 目标可能已存在且不可覆盖：删除后重试。
      deleteFile(INDEX_FILE, () => {
        file.move({
          srcUri: INDEX_TMP,
          dstUri: INDEX_FILE,
          success: () => complete(cb, { ok: true }),
          fail: (data, code) => complete(cb,
            { ok: false, reason: 'index_move',
              code: code })
        });
      });
    }
  });
}

function saveIndexAtomic(entries, cb) {
  file.writeText({
    uri: INDEX_TMP,
    text: JSON.stringify(entries),
    append: false,
    success: () => {
      commitIndexTmp((state) => {
        if (!state.ok) return complete(cb, state);
        lastGood = snapshot(entries);
        complete(cb, { ok: true });
      });
    },
    fail: (data, code) => complete(cb,
      { ok: false, reason: 'index_write', code: code })
  });
}

// 写操作串行化：同一时刻只有一个索引
// 读改写周期在进行。
function enqueue(task) {
  queue.push(task);
  if (!running) runNext();
}

function runNext() {
  if (queue.length === 0) {
    running = false;
    return;
  }
  running = true;
  const task = queue.shift();
  let settled = false;
  let timer = null;
  const done = () => {
    if (settled) return;
    settled = true;
    if (timer !== null && typeof clearTimeout === 'function') {
      clearTimeout(timer);
      timer = null;
    }
    runNext();
  };
  if (typeof setTimeout === 'function') {
    timer = setTimeout(() => {
      console.error('LibraryIndex: 文件操作超时，释放队列' +
        '（未伪造成功，调用方回调不会触发）');
      done();
    }, QUEUE_TIMEOUT_MS);
  }
  try {
    task(done);
  } catch (error) {
    // 同步 throw 也必须释放队列，不能让运行标志卡死。
    console.error('LibraryIndex: 任务同步异常 ' + error);
    done();
  }
}

// 写失败回滚：把最近一次成功的快照写回，
// 回读校验；新增失败时删除孤儿书籍文件。
// 回调结果表达**回滚本身**是否成功：
//   { restored: true } 或
//   { restored: false, reason: E_ROLLBACK_* }
function rollback(orphanEntry, cb) {
  const restore = snapshot(lastGood);
  saveIndexAtomic(restore, (state) => {
    if (!state.ok) {
      return complete(cb, { restored: false,
        reason: 'E_ROLLBACK_FAILED' });
    }
    // 回读校验：磁盘内容必须等于快照（同样分块读，见 issue #8）。
    readIndexText((r) => {
      if (!r.ok) {
        return complete(cb, { restored: false,
          reason: 'E_ROLLBACK_FAILED',
          code: r.code || r.reason });
      }
      const onDisk = parseEntries(r.text);
      if (JSON.stringify(onDisk) !==
          JSON.stringify(restore)) {
        return complete(cb, { restored: false,
          reason: 'E_ROLLBACK_MISMATCH' });
      }
      finishRollback(orphanEntry, cb);
    });
  });
}

function finishRollback(orphanEntry, cb) {
  if (orphanEntry && isSafeBookId(orphanEntry.bookId)) {
    deleteFile(bookPath(orphanEntry.bookId), () => {
      complete(cb, { restored: true });
    });
  } else {
    complete(cb, { restored: true });
  }
}

export function listBooks(cb, onDiag) {
  // 读-检-清理整周期入队，与写操作互斥，
  // 避免并发清理覆盖刚写入的条目（P0-4）。
  enqueue((done) => {
    loadIndex((entries) => {
      let pending = entries.length;
      // 文件访问是异步回调：不能按回调完成先后 alive.push，
      // 否则即使所有书都存在，刷新也会随机打乱书架顺序。
      const alive = new Array(entries.length);
      if (pending === 0) {
        done();
        return complete(cb, []);
      }
      const settleIfDone = () => {
        if (--pending > 0) return;
        const result = snapshot(alive.filter((entry) => !!entry));
        if (result.length === entries.length) {
          done();
          return complete(cb, result);
        }
        saveIndexAtomic(result, () => {
          done();
          complete(cb, result);
        });
      };
      entries.forEach((entry, index) => {
        file.access({
          uri: bookPath(entry.bookId),
          success: () => {
            alive[index] = entry;
            settleIfDone();
          },
          fail: () => settleIfDone()
        });
      });
    }, onDiag);
  });
}

export function getBook(bookId, cb) {
  if (!isSafeBookId(bookId)) return complete(cb, null);
  loadIndex((entries) => {
    const found = entries.filter((e) => e.bookId === bookId);
    if (found.length === 0) return complete(cb, null);
    file.access({
      uri: bookPath(bookId),
      success: () => complete(cb, found[0]),
      fail: () => complete(cb, null)
    });
  });
}

// 重复发送同一书籍（同 bookId）时不覆盖阅读进度：
// 只更新元信息，保留 addedAt。
// 注意：构造**新数组**，不原地修改读到的
// entries，更不触碰快照（P0-4）。
export function addBook(entry, cb) {
  enqueue((done) => {
    loadIndex((entries) => {
      const idx = entries.findIndex(
        (e) => e.bookId === entry.bookId);
      const isNew = idx < 0;
      const next = isNew ?
        entries.concat([Object.assign({}, entry,
          { addedAt: Date.now() })]) :
        entries.map((e, i) => i === idx ?
          Object.assign({}, entry,
            { addedAt: e.addedAt }) : e);
      saveIndexAtomic(next, (state) => {
        if (!state.ok) {
          rollback(isNew ? entry : null, (rolled) => {
            done();
            complete(cb, rolled.restored ? state :
              Object.assign({}, state,
                { rollback: rolled.reason }));
          });
          return;
        }
        done();
        complete(cb, { ok: true });
      });
    });
  });
}

export function removeBook(bookId, cb) {
  enqueue((done) => {
    loadIndex((entries) => {
      const kept = entries.filter((e) => e.bookId !== bookId);
      if (kept.length === entries.length) {
        done();
        return complete(cb, { ok: true });
      }
      saveIndexAtomic(kept, (state) => {
        if (!state.ok) {
          rollback(null, (rolled) => {
            done();
            complete(cb, rolled.restored ? state :
              Object.assign({}, state,
                { rollback: rolled.reason }));
          });
          return;
        }
        done();
        complete(cb, state);
      });
    });
  });
}
