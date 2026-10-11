// SPDX-License-Identifier: GPL-3.0-only
// 文件接口自检（issue #9 A6）：没有 HiLog 时，把每个
// `@system.file` 操作独立发起、各自带有限超时，并把
// 「成功 / 失败 code / 无回调超时」变成屏幕可见结果。
//
// 只在独立的测试目录 `internal://app/gt4probe/` 下操作，
// 绝不触碰书籍、进度或索引文件。
//
// 每个操作各自发起（不并发、不并行），因为 Lite 上
// 未回调的调用会永久占住；前一步成功与否都继续下一步，
// 保证整份报告一定能在有限时间内完成。
import file from '@system.file';

var PROBE_DIR = 'internal://app/gt4probe';
var PROBE_TXT = PROBE_DIR + '/probe.txt';
var PROBE_TXT2 = PROBE_DIR + '/probe2.txt';
var PROBE_BIN = PROBE_DIR + '/probe.bin';
var OP_TIMEOUT_MS = 4000;

var PROBE_TEXT = '素阅测试'; // 4 个汉字：写-读-比内容

export function setProbeTimeout(ms) {
  if (typeof ms === 'number' && ms > 0) OP_TIMEOUT_MS = ms;
}

// 结算一次 + 有限超时：无论基底 API 回调与否，一定回报一次。
function probeOnce(api, timeoutMs, cb, start) {
  var called = false;
  var timer = null;
  var finish = function (ok, code, note) {
    if (called) return;
    called = true;
    if (timer !== null && typeof clearTimeout === 'function') {
      clearTimeout(timer);
      timer = null;
    }
    cb({ api: api, ok: !!ok,
      code: (code === undefined || code === null) ? 0 : code,
      note: note || '' });
  };
  if (typeof setTimeout === 'function') {
    timer = setTimeout(function () {
      finish(false, 'timeout', '无回调超时');
    }, timeoutMs);
  }
  try {
    start(finish);
  } catch (error) {
    finish(false, 'throw', '同步异常：' + error);
  }
}

// 自检顺序（每项独立；失败也继续下一项）。
// 用到真实私有目录，绝不用应用资源目录。
export function runFileProbe(cb) {
  var report = [];
  var done = false;
  var finish = function () {
    if (done) return;
    done = true;
    cb(report);
  };
  var items = [];
  var index = 0;

  // 1) mkdir 测试目录
  items.push(function (next) {
    probeOnce('mkdir', OP_TIMEOUT_MS, function (r) {
      // 已存在也可能返回失败；视为可继续
      report.push({ name: 'mkdir 测试目录', ok: r.ok ||
        r.code === 300, code: r.code, note: r.note });
      next();
    }, function (finishOne) {
      file.mkdir({ uri: PROBE_DIR, recursive: false,
        success: function () { finishOne(true, 0, ''); },
        fail: function (data, code) {
          finishOne(false, code, '');
        } });
    });
  });

  // 2) writeText 写 2~4 个字符
  items.push(function (next) {
    probeOnce('writeText', OP_TIMEOUT_MS, function (r) {
      report.push({ name: 'writeText 写短文本', ok: r.ok,
        code: r.code, note: r.note });
      next();
    }, function (finishOne) {
      file.writeText({ uri: PROBE_TXT, text: PROBE_TEXT,
        append: false,
        success: function () { finishOne(true, 0, ''); },
        fail: function (data, code) { finishOne(false, code, ''); } });
    });
  });

  // 3) access 探测
  items.push(function (next) {
    probeOnce('access', OP_TIMEOUT_MS, function (r) {
      report.push({ name: 'access 探测存在', ok: r.ok,
        code: r.code, note: r.note });
      next();
    }, function (finishOne) {
      file.access({ uri: PROBE_TXT,
        success: function () { finishOne(true, 0, ''); },
        fail: function (data, code) { finishOne(false, code, ''); } });
    });
  });

  // 4) get 取大小
  items.push(function (next) {
    probeOnce('get', OP_TIMEOUT_MS, function (r) {
      report.push({ name: 'get 取大小', ok: r.ok,
        code: r.code, note: r.note });
      next();
    }, function (finishOne) {
      file.get({ uri: PROBE_TXT,
        success: function (info) {
          finishOne(true, (info && info.length) || 0, '');
        },
        fail: function (data, code) { finishOne(false, code, ''); } });
    });
  });

  // 5) readText 读回并比对
  items.push(function (next) {
    probeOnce('readText', OP_TIMEOUT_MS, function (r) {
      report.push({ name: 'readText 读短文本', ok: r.ok,
        code: r.code, note: r.note });
      next();
    }, function (finishOne) {
      file.readText({ uri: PROBE_TXT,
        success: function (data) {
          var text = (data && data.text) || '';
          finishOne(text === PROBE_TEXT, 0,
            text === PROBE_TEXT ? '' : '内容不一致:[' + text + ']');
        },
        fail: function (data, code) { finishOne(false, code, ''); } });
    });
  });

  // 6) readText 分块（position/length）
  items.push(function (next) {
    probeOnce('readText(位置/长度)', OP_TIMEOUT_MS,
      function (r) {
        report.push({ name: 'readText 分块读取', ok: r.ok,
          code: r.code, note: r.note });
        next();
      }, function (finishOne) {
        file.readText({ uri: PROBE_TXT, position: 0, length: 2,
          success: function (data) {
            finishOne(!!(data && typeof data.text === 'string'),
              0, '');
          },
          fail: function (data, code) {
            finishOne(false, code, '');
          } });
      });
  });

  // 7) writeArrayBuffer + readArrayBuffer 字节往返
  items.push(function (next) {
    probeOnce('writeArrayBuffer', OP_TIMEOUT_MS,
      function (r1) {
        if (!r1.ok) {
          report.push({ name: 'writeArrayBuffer 写字节',
            ok: false, code: r1.code, note: r1.note });
          report.push({ name: 'readArrayBuffer 读字节',
            ok: false, code: '-', note: '因写失败跳过' });
          return next();
        }
        report.push({ name: 'writeArrayBuffer 写字节', ok: true,
          code: 0, note: '' });
        probeOnce('readArrayBuffer', OP_TIMEOUT_MS,
          function (r2) {
            var len = (r2.code && typeof r2.code === 'number') ?
              r2.code : 0;
            report.push({ name: 'readArrayBuffer 读字节',
              ok: r2.ok && len >= 1, code: r2.ok ? len : r2.code,
              note: r2.note });
            next();
          }, function (finishTwo) {
            file.readArrayBuffer({ uri: PROBE_BIN, position: 0,
              length: 8,
              success: function (data) {
                var bytes = (data && data.buffer) ?
                  new Uint8Array(data.buffer) : null;
                finishTwo(!!bytes && bytes.length > 0,
                  bytes ? bytes.length : 0, '');
              },
              fail: function (data, code) {
                finishTwo(false, code, '');
              } });
          });
      }, function (finishOne) {
        var payload = new Uint8Array(4);
        payload[0] = 0x41; payload[1] = 0x42;
        payload[2] = 0x43; payload[3] = 0x44;
        file.writeArrayBuffer({ uri: PROBE_BIN, buffer: payload,
          append: false,
          success: function () { finishOne(true, 0, ''); },
          fail: function (data, code) {
            finishOne(false, code, '');
          } });
      });
  });

  // 8) copy 到测试目录内第二个文件
  items.push(function (next) {
    probeOnce('copy', OP_TIMEOUT_MS, function (r) {
      report.push({ name: 'copy 复制文件', ok: r.ok,
        code: r.code, note: r.note });
      next();
    }, function (finishOne) {
      file.copy({ srcUri: PROBE_TXT, dstUri: PROBE_TXT2,
        success: function () { finishOne(true, 0, ''); },
        fail: function (data, code) { finishOne(false, code, ''); } });
    });
  });

  // 9) move 到测试目录内第三个文件（rename）
  items.push(function (next) {
    probeOnce('move', OP_TIMEOUT_MS, function (r) {
      report.push({ name: 'move 移动文件', ok: r.ok,
        code: r.code, note: r.note });
      next();
    }, function (finishOne) {
      file.move({ srcUri: PROBE_TXT2, dstUri: PROBE_TXT2 + '.moved',
        success: function () { finishOne(true, 0, ''); },
        fail: function (data, code) { finishOne(false, code, ''); } });
    });
  });

  // 10) delete 清理测试文件
  items.push(function (next) {
    probeOnce('delete', OP_TIMEOUT_MS, function (r) {
      report.push({ name: 'delete 删除文件', ok: r.ok,
        code: r.code, note: r.note });
      next();
    }, function (finishOne) {
      file.delete({ uri: PROBE_TXT,
        success: function () { finishOne(true, 0, ''); },
        fail: function (data, code) { finishOne(false, code, ''); } });
    });
  });

  // 11) 探测内置 rawfile 是否可读（issue #9 B2）：
  // 只报告，不据此写业务数据。
  items.push(function (next) {
    probeOnce('rawfile', OP_TIMEOUT_MS, function (r) {
      report.push({ name: 'rawfile 内置资源可读性', ok: r.ok,
        code: r.code, note: r.note });
      next();
    }, function (finishOne) {
      file.access({ uri: 'internal://app/rawfile/gt4books',
        success: function () {
          finishOne(true, 0, 'internal://app/rawfile 可访问');
        },
        fail: function (data, code) {
          finishOne(false, code,
            'internal://app/rawfile 不可访问');
        } });
    });
  });

  function step() {
    if (index >= items.length) return finish();
    var item = items[index];
    index++;
    try {
      item(step);
    } catch (error) {
      report.push({ name: '步骤异常', ok: false, code: 'throw',
        note: String(error) });
      step();
    }
  }
  step();
}

// 汇总成一行屏幕文案（每项独立，无日志也能读）。
export function formatProbe(report) {
  if (!report || !report.length) return '自检无结果';
  var okCount = 0;
  for (var i = 0; i < report.length; i++) {
    if (report[i].ok) okCount++;
  }
  return '自检 ' + okCount + '/' + report.length + ' 项通过';
}
