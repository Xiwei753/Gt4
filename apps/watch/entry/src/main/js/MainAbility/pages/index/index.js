// SPDX-License-Identifier: GPL-3.0-only
// 书架页：读取真实书库索引，列书名；打开/删除。
//
// 迁移（施工单 P2-14 / 第二轮 P1-5）：直接检查旧
// 演示文件是否存在，存在才移动并登记，绝不在
// 空书库时自动重造测试书（旧实现在此调用生成
// 函数，用户删光后重开页面会再次生出演示书）。
import router from '@system.router';
import file from '@system.file';
import { ensureDirs, bookPath,
  deleteBook, fileSize, readWindow }
  from '../../storage/BookStorage';
import { listBooks, addBook,
  removeBook } from '../../storage/LibraryIndex';
import { importBundledBooks, cancelBundledImport }
  from '../../storage/BundledBookImporter';
import { beginReceive, stopReceive } from '../../wear/WearReceiver';
import { createSha256 } from '../../util/Sha256';

const DEMO_BOOK_ID = 'aaaa000000000001';
const DEMO_PATH = 'internal://app/gt4reader/demo.txt';
var MIGRATE_WINDOW = 64 * 1024;
// 启动看门狗（issue #8）：本地书库初始化必须在有限时间内
// 得出明确结论（就绪 / 空库 / 错误），否则在圆屏上显示
// 卡住的阶段，绝不无限停留在"正在准备本地书库"。
var INIT_TIMEOUT_MS = 10000;

export default {
  data: {
    title: '素阅',
    books: [],
    status: '正在准备本地书库',
    transferStatus: '传书未配置',
    confirmId: '',
    bundledStatus: '',
    initFailed: false
  },
  onInit() {
    // 页面级状态机：onInit 第一句就置醒目标记，用来区分
    // "onInit 根本没执行"与"执行后卡住"。
    this.libraryReady = false;
    this.initDone = false;
    this.initFailed = false;
    this.initToken = 0;
    this.initTimer = null;
    this.initStage = '进入首页';
    this.indexError = 0;
    this.bundledStatus = '';
    this.status = '初始化 1/5：进入首页';
    try {
      this.prepareLibrary();
    } catch (error) {
      this.failInit('E_PREPARE_THROW', '初始化同步异常：' + error);
    }
    // Wear Engine 与本地书库彼此独立：接收初始化异常
    // 绝不能阻断离线书架（issue #8）。
    try {
      beginReceive((message) => {
        this.handleReceiveStatus(message);
      });
    } catch (error) {
      this.transferStatus = '传书初始化异常';
      console.error('[suyue] E_WEAR_INIT ' + error);
    }
  },
  // 从阅读页返回书架时重新取索引，不依赖 onInit 再次执行。
  onShow() {
    if (this.libraryReady) this.refresh();
  },
  handleReceiveStatus(message) {
    if (typeof message !== 'string') return;
    try {
      const event = JSON.parse(message);
      if (event && event.type === 'RESULT') {
        if (event.ok) {
          this.transferStatus = '接收成功，已加入书架';
          this.refresh();
        } else {
          this.transferStatus = '传书失败：' +
            (event.reason || '未知错误');
        }
        return;
      }
      // ACK 等协议消息不覆盖界面提示。
      return;
    } catch (error) {
      this.transferStatus = message;
    }
  },
  onDestroy() {
    this.clearInitTimer();
    cancelBundledImport();
    stopReceive();
  },
  clearInitTimer() {
    if (this.initTimer !== null && this.initTimer !== undefined &&
        typeof clearTimeout === 'function') {
      clearTimeout(this.initTimer);
    }
    this.initTimer = null;
  },
  // 明确成功：停看门狗，落定最终文案。
  finishInit(text) {
    this.clearInitTimer();
    this.initDone = true;
    this.initFailed = false;
    this.status = text;
  },
  // 明确失败：屏幕显示阶段 + 错误码，开放重试。
  // 自增 token 使在途回调失效，过时结果不能覆盖错误态。
  failInit(code, text) {
    this.initToken++;
    this.clearInitTimer();
    this.initDone = true;
    this.initFailed = true;
    this.status = text + '（' + code + '）';
    console.error('[suyue] ' + code + ' ' + text);
  },
  // 点击重试：不卸载应用也能重新初始化。
  retryInit() {
    cancelBundledImport();
    this.libraryReady = false;
    this.initFailed = false;
    this.initStage = '进入首页';
    this.indexError = 0;
    this.bundledStatus = '';
    try {
      this.prepareLibrary();
    } catch (error) {
      this.failInit('E_PREPARE_THROW', '初始化同步异常：' + error);
    }
  },
  prepareLibrary() {
    const token = ++this.initToken;
    this.initDone = false;
    this.initFailed = false;
    this.indexError = 0;
    this.initStage = '进入首页';
    this.status = '初始化 1/5：进入首页';
    this.clearInitTimer();
    if (typeof setTimeout === 'function') {
      this.initTimer = setTimeout(() => {
        if (token !== this.initToken || this.initDone) return;
        // 超时不清空目录、不伪造成功：只报出卡住的阶段。
        this.failInit('E_INIT_TIMEOUT',
          '书库初始化超时：阶段=' + this.initStage);
      }, this.initTimeoutMs || INIT_TIMEOUT_MS);
    }
    try {
      ensureDirs((dirs) => {
        if (token !== this.initToken) return;
        if (!dirs.ok) {
          return this.failInit(
            'E_DIRS_' + (dirs.stage || 'unknown'),
            '书库目录创建失败：' + (dirs.stage || '') +
            ' code=' + (dirs.code || dirs.reason || '?'));
        }
        // 构建期内置书籍（issue #7）：后台导入，绝不阻塞书架。
        // 无论成功/失败/超时/无资源，readIndex 都立刻继续，
        // 正常显示已有书架或空书架（issue #7 评论）。
        this.initStage = '导入内置书籍';
        this.status = '初始化 3/5：导入内置书籍';
        this.startBundledImport(token);
        this.readIndex(token);
      }, (stage) => {
        if (token !== this.initToken) return;
        this.initStage = '目录 ' + stage;
        this.status = '初始化 2/5：目录 ' + stage;
      });
    } catch (error) {
      this.failInit('E_PREPARE_THROW', '初始化同步异常：' + error);
    }
  },
  // 后台内置书籍导入（issue #7）：只更新独立提示 bundledStatus，
  // 绝不覆盖书架就绪文案，也绝不阻塞 readIndex。失败/超时会让
  // 本回调收到 ok=false + 步骤 + 错误码，屏幕可见（issue #7 评论）。
  startBundledImport(token) {
    this.bundledStatus = '内置书籍：检查中…';
    try {
      importBundledBooks((res) => {
        if (token !== this.initToken) return;
        if (res && res.ok) {
          if (res.imported > 0) {
            this.bundledStatus = '内置书籍已导入 ' +
              res.imported + ' 本' +
              (res.failed ? '，失败 ' + res.failed + ' 本' : '');
            this.refresh();
          } else if (res.reason === 'resource_unavailable') {
            this.bundledStatus = '未检测到内置书籍';
          } else if (res.failed > 0) {
            this.bundledStatus = '内置书籍导入失败 ' +
              res.failed + ' 本' + this.bundledDetail(res.first);
          } else {
            this.bundledStatus = '';
          }
        } else {
          this.bundledStatus = '内置书籍导入失败：' +
            this.bundledDetail(res);
          console.error('[suyue] E_BUNDLED_IMPORT ' +
            (res && res.step) + ' ' + (res && res.reason) +
            ' code=' + (res && res.code));
        }
      }, (stage, code) => {
        if (token !== this.initToken) return;
        this.bundledStatus = '内置书籍：' + stage +
          (code ? '（code=' + code + '）' : '');
      });
    } catch (error) {
      // 同步异常也不能拖死书架：只记录独立提示。
      this.bundledStatus = '内置书籍导入异常';
      console.error('[suyue] E_BUNDLED_THROW ' + error);
    }
  },
  bundledDetail(info) {
    if (!info) return '';
    var text = (info.step ? info.step : '') +
      (info.reason ? ' ' + info.reason : '');
    if (info.code) text += '（code=' + info.code + '）';
    return text;
  },
  // 读取真实索引：有书即就绪；索引读错则上屏；否则查旧 demo。
  readIndex(token) {
    this.initStage = '读取 books.json';
    this.status = '初始化 4/5：读取 books.json';
    listBooks((books) => {
      if (token !== this.initToken) return;
      this.libraryReady = true;
      if (books.length > 0) {
        this.books = books;
        return this.finishInit(
          '本地书库就绪（' + books.length + ' 本）');
      }
      if (this.indexError) {
        return this.failInit('E_INDEX_READ',
          '书库索引读取失败 code=' + this.indexError);
      }
      this.migrateDemo(token);
    }, (diag) => {
      if (token !== this.initToken) return;
      this.indexError = (diag && diag.state === 'error') ?
        (diag.code || 'error') : 0;
    });
  },
  // 一次性迁移：先直接检查旧文件，存在且移动
  // 成功才登记；不调用任何生成函数。
  migrateDemo(token) {
    this.initStage = '检查旧 demo';
    this.status = '初始化 5/5：检查旧 demo';
    try {
      file.access({
        uri: DEMO_PATH,
        success: () => {
          if (token !== this.initToken) return;
          try {
            file.move({
              srcUri: DEMO_PATH,
              dstUri: bookPath(DEMO_BOOK_ID),
              success: () => {
                if (token !== this.initToken) return;
                this.describeMovedDemo(token);
              },
              fail: (data, code) => {
                if (token !== this.initToken) return;
                this.failInit('E_DEMO_MOVE_' + code,
                  '旧演示书迁移失败 code=' + code);
              }
            });
          } catch (error) {
            this.failInit('E_DEMO_MOVE_THROW',
              '旧演示书迁移异常：' + error);
          }
        },
        fail: (data, code) => {
          if (token !== this.initToken) return;
          // 没有旧 demo（含 301 不存在）是正常空书架：
          // 不重造、不阻塞、不长时间等待。
          this.books = [];
          if (code && code !== 301) {
            console.error('[suyue] E_DEMO_ACCESS code=' + code);
          }
          this.finishInit('书库为空，等待手机传书');
        }
      });
    } catch (error) {
      this.failInit('E_DEMO_ACCESS_THROW',
        '检查旧演示书异常：' + error);
    }
  },
  // 移动成功后统计真实字节数与摘要，再登记索引
  // （拒绝假元数据）。
  describeMovedDemo(token) {
    const dst = bookPath(DEMO_BOOK_ID);
    fileSize(dst, (stat) => {
      if (token !== this.initToken) return;
      if (!stat.ok) {
        return this.failInit('E_DEMO_STAT',
          '迁移后校验失败：无法取得大小');
      }
      const hasher = createSha256();
      this.hashAll(dst, 0, stat.size, hasher,
        (digest) => {
          if (token !== this.initToken) return;
          if (!digest) {
            // 读取失败：不写空摘要，不登记。
            return this.failInit('E_DEMO_DIGEST',
              '迁移后校验失败：摘要读取不完整');
          }
          addBook({
            bookId: DEMO_BOOK_ID,
            title: '中文阅读测试',
            encoding: 'utf-8',
            bytes: stat.size,
            sha256: digest,
            chunks: 0,
            chunkBytes: 0,
            chapters: []
          }, () => {
            if (token !== this.initToken) return;
            this.refresh();
            this.finishInit('本地书库就绪（1 本）');
          });
        });
    });
  },
  hashAll(uri, offset, total, hasher, cb) {
    if (offset >= total) {
      return cb(hasher.digest());
    }
    const size = Math.min(MIGRATE_WINDOW,
      total - offset);
    readWindow(uri, offset, size, (r) => {
      if (!r.ok) {
        // 明确失败：返回空值，调用方不得写索引。
        return cb('');
      }
      hasher.update(r.bytes);
      this.hashAll(uri, offset + size, total,
        hasher, cb);
    });
  },
  refresh() {
    listBooks((books) => {
      this.books = books;
      this.status = books.length > 0 ?
        '本地书库就绪（' + books.length + ' 本）' :
        '书库为空，等待手机传书';
    });
  },
  // FA HML 的 for 循环里可用 $idx 传下标（真机待验证）。
  openBook(e) {
    const book = this.books[e];
    if (!book) return;
    router.push({
      uri: 'pages/reader/reader',
      params: { bookId: book.bookId }
    });
  },
  // 二次确认删除：第一次点击标记，第二次点击执行。
  askDelete(e) {
    const book = this.books[e];
    if (!book) return;
    if (this.confirmId !== book.bookId) {
      this.confirmId = book.bookId;
      this.status = '再次点击「删除」确认移除《' +
        book.title + '》';
      return;
    }
    this.confirmId = '';
    deleteBook(book.bookId, (state) => {
      if (state.ok) {
        removeBook(book.bookId, () => {
          this.status = '已删除《' + book.title + '》';
          this.refresh();
        });
      } else {
        this.status = '删除失败：' + state.reason;
      }
    });
  }
};
