// SPDX-License-Identifier: GPL-3.0-only
// 手机 ↔ 手表阅读进度同步（独立于传书协议）。
//
// 约束：
//   - 只复用 WearDeviceService 已初始化的 P2pClient，不第二次
//     初始化或注册消息接收；
//   - 消息只含 bookId/sha256/offset/updatedAt 等摘要，不含正文、
//     目录或书架；每条 JSON < 4096 字节；
//   - 只在本地已有同 sha256 书籍时应用；绝不因远端有书就创建空书；
//   - 不按“offset 更大”覆盖。两边都改过时由手机弹窗选择；
//   - 同步失败只报告状态，不阻断阅读/传书。
import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { promptAction } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BookMeta } from '../model/BookModels';
import { TargetDevice } from '../model/TransferModels';
import { BookRepository } from './BookRepository';
import { ReadingProgressStore, ReadingSummary }
  from './ReadingProgressStore';
import { WearDeviceService } from './WearDeviceService';
import { emitReadingApply, emitReadingPrepare } from './ReadingSyncEvents';
import { buildSummaryBatches, decidePendingAction,
  decideSyncAction, isValidSummary } from '../model/ReadingSyncPolicy';

const TAG = 'suyue/ReadingSyncService';
const MAX_MESSAGE_BYTES = 4096;

interface SyncPeer {
  bundleName: string;
  fingerprint: string;
}

interface SyncBook {
  bookId: string;
  sha256: string;
  offset: number;
  updatedAt: number;
  syncedOffset?: number;
}

interface StateMessage {
  v: number;
  type: string;
  source?: string;
  requestId?: string;
  books?: SyncBook[];
  lastBookId?: string;
  lastUpdatedAt?: number;
  lastSha256?: string;
  batch?: number;
  batches?: number;
  bookId?: string;
  sha256?: string;
  offset?: number;
  updatedAt?: number;
}

interface BatchPayload {
  payload: object;
  batch: number;
  batches: number;
}

interface PendingState {
  books: SyncBook[];
  lastBookId: string;
  lastUpdatedAt: number;
  batches: number;
  received: number;
  seen: number[];
}

export type SyncStatusListener = (text: string, ok: boolean) => void;

export class ReadingSyncService {
  private context: common.UIAbilityContext;
  private deviceService: WearDeviceService;
  private progressStore: ReadingProgressStore;
  private repository: BookRepository;
  private device: TargetDevice | null = null;
  private peer: SyncPeer | null = null;
  private requestSeq: number = 0;
  private syncing: boolean = false;
  private pending: Map<string, PendingState> = new Map<string, PendingState>();
  private conflictKeys: Set<string> = new Set<string>();
  private activeBookId: string = '';
  private statusListener: SyncStatusListener | null = null;

  constructor(context: common.UIAbilityContext,
    deviceService: WearDeviceService,
    progressStore: ReadingProgressStore,
    repository: BookRepository) {
    this.context = context;
    this.deviceService = deviceService;
    this.progressStore = progressStore;
    this.repository = repository;
  }

  setStatusListener(listener: SyncStatusListener | null): void {
    this.statusListener = listener;
  }

  // 阅读页打开/关闭时设置；有活动阅读时绝不自动切换“上次阅读”。
  setActiveBook(bookId: string): void {
    this.activeBookId = bookId;
  }

  private status(text: string, ok: boolean): void {
    if (this.statusListener !== null) {
      this.statusListener(text, ok);
    }
  }

  // 返回 true 表示这是本服务处理的阅读进度消息；传书完成以文件通道回调为准。
  onMessageFromWatch(content: Uint8Array): boolean {
    let text = '';
    try {
      text = new util.TextDecoder().decodeToString(content);
    } catch (error) {
      return false;
    }
    let message: StateMessage;
    try {
      message = JSON.parse(text) as StateMessage;
    } catch (error) {
      return false;
    }
    if (!message || message.v !== 0 ||
        typeof message.type !== 'string' ||
        message.type.indexOf('READ_PROGRESS_') !== 0) {
      return false;
    }
    if (message.type === 'READ_PROGRESS_GET') {
      this.sendState(message.requestId).catch((error: Error) => {
        this.status('进度同步：回复手表失败 ' + error.message, false);
      });
      return true;
    }
    if (message.type === 'READ_PROGRESS_STATE') {
      this.acceptState(message).catch((error: Error) => {
        this.status('进度同步：处理手表进度失败 ' + error.message, false);
      });
      return true;
    }
    if (message.type === 'READ_PROGRESS_APPLY') {
      this.acceptApply(message).catch((error: Error) => {
        this.status('进度同步：应用手表进度失败 ' + error.message, false);
      });
      return true;
    }
    return true;
  }

  // 重连/打开阅读页/手动同步：请求手表摘要，同时发送本机摘要。
  async syncAll(device: TargetDevice, peer: SyncPeer): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    this.device = device;
    this.peer = peer;
    const requestId = 'p' + Date.now() + '-' + (++this.requestSeq);
    try {
      this.status('进度同步：正在交换摘要', true);
      await this.send({
        v: 0, type: 'READ_PROGRESS_GET', source: 'phone',
        requestId: requestId, ts: Date.now()
      });
      await this.sendState(requestId);
    } catch (error) {
      const e = error as Error;
      hilog.warn(0x0000, TAG, 'sync failed: ' + e.message);
      this.status('进度同步失败（不影响阅读）：' + e.message, false);
    } finally {
      this.syncing = false;
    }
  }

  private async send(payload: object): Promise<void> {
    if (this.device === null || this.peer === null) {
      throw new Error('未选择设备');
    }
    await this.deviceService.sendP2pMessage(
      this.device, this.peer, payload);
  }

  private async sendState(requestId?: string): Promise<void> {
    // Older records may contain an unverified pre-pager location. Keep those
    // books out of sync until the native pager validates a UTF-8 byte offset.
    const books = this.repository.list().filter((book) =>
      book.progressMapping !== 'readerkit_unmapped');
    const summaries = await this.progressStore.list(books);
    const last = await this.progressStore.loadLastRecord();
    const lastBook = last !== null ?
      this.findBook(books, last.bookId) : null;
    const base = {
      v: 0,
      type: 'READ_PROGRESS_STATE',
      source: 'phone',
      requestId: requestId !== undefined ? requestId : '',
      lastBookId: lastBook !== null ? lastBook.bookId : '',
      lastUpdatedAt: last !== null ? last.updatedAt : 0,
      lastSha256: lastBook !== null ? lastBook.sha256 : ''
    };
    if (summaries.length === 0) {
      await this.send(Object.assign({}, base, { books: [] }));
      return;
    }
    const wire: SyncBook[] = [];
    for (let i = 0; i < summaries.length; i++) {
      wire.push({
        bookId: summaries[i].bookId,
        sha256: summaries[i].sha256,
        offset: summaries[i].offset,
        updatedAt: summaries[i].updatedAt
      });
    }
    const batches = buildSummaryBatches(wire, base,
      MAX_MESSAGE_BYTES) as BatchPayload[];
    if (batches.length === 0) {
      throw new Error('单条进度摘要超过消息上限');
    }
    for (let i = 0; i < batches.length; i++) {
      await this.send(batches[i].payload);
    }
  }

  private async acceptState(message: StateMessage): Promise<void> {
    const batches = typeof message.batches === 'number' &&
      message.batches > 1 ? message.batches : 1;
    if (batches === 1) {
      await this.mergeRemote(
        Array.isArray(message.books) ? message.books : [],
        message.lastBookId, message.lastUpdatedAt,
        message.lastSha256);
      return;
    }
    const key = typeof message.requestId === 'string' &&
      message.requestId.length > 0 ? message.requestId : 'default';
    let pending = this.pending.get(key);
    if (pending === undefined) {
      pending = {
        books: [], lastBookId: '', lastUpdatedAt: 0,
        batches: batches, received: 0, seen: []
      };
      this.pending.set(key, pending);
    }
    const index = typeof message.batch === 'number' ? message.batch : -1;
    if (index >= 0 && pending.seen.indexOf(index) < 0) {
      pending.seen.push(index);
      pending.received += 1;
    }
    if (Array.isArray(message.books)) {
      for (let i = 0; i < message.books.length; i++) {
        if (isValidSummary(message.books[i])) {
          pending.books.push(message.books[i]);
        }
      }
    }
    if (typeof message.lastBookId === 'string' && message.lastBookId) {
      pending.lastBookId = message.lastBookId;
      pending.lastUpdatedAt = typeof message.lastUpdatedAt === 'number' ?
        message.lastUpdatedAt : 0;
    }
    if (pending.received >= pending.batches) {
      this.pending.delete(key);
      await this.mergeRemote(pending.books, pending.lastBookId,
        pending.lastUpdatedAt, message.lastSha256);
    }
  }

  private findBook(books: BookMeta[], bookId: string): BookMeta | null {
    for (let i = 0; i < books.length; i++) {
      if (books[i].bookId === bookId) return books[i];
    }
    return null;
  }

  // 远端 offset 必须落在 UTF-8 字符边界；0 和文件末尾合法。
  private isUtf8Boundary(book: BookMeta, offset: number): boolean {
    if (offset < 0 || offset > book.bytes) return false;
    if (offset === 0 || offset === book.bytes) return true;
    let fd = -1;
    try {
      fd = fileIo.openSync(book.filePath, fileIo.OpenMode.READ_ONLY).fd;
      const buffer = new Uint8Array(1);
      const read = fileIo.readSync(fd, buffer.buffer,
        { offset: offset, length: 1 });
      return read === 1 && (buffer[0] & 0xC0) !== 0x80;
    } catch (error) {
      return false;
    } finally {
      if (fd >= 0) {
        try {
          fileIo.closeSync(fd);
        } catch (error) {
          // 已关闭。
        }
      }
    }
  }

  private findSummary(summaries: ReadingSummary[],
    bookId: string): ReadingSummary | null {
    for (let i = 0; i < summaries.length; i++) {
      if (summaries[i].bookId === bookId) return summaries[i];
    }
    return null;
  }

  private async mergeRemote(remoteBooks: SyncBook[],
    lastBookId?: string, lastUpdatedAt?: number,
    lastSha256?: string): Promise<void> {
    const books = this.repository.list();
    const localSummaries = await this.progressStore.list(books);
    let applied = 0;
    for (let i = 0; i < remoteBooks.length; i++) {
      const remote = remoteBooks[i];
      if (!isValidSummary(remote)) continue;
      const book = this.findBook(books, remote.bookId);
      if (book === null || book.sha256 !== remote.sha256) {
        // 手机上没这本书，或同名不同内容：忽略，绝不创建空书。
        continue;
      }
      if (book.progressMapping === 'readerkit_unmapped') continue;
      if (remote.offset > book.bytes) continue;
      if (!this.isUtf8Boundary(book, remote.offset)) continue;
      const local = this.findSummary(localSummaries, remote.bookId);
      if (local !== null && local.pendingOffset >= 0) {
        const pending = decidePendingAction(local.offset, local.syncedOffset,
          local.pendingOffset, remote.offset);
        if (pending === 'confirmed') {
          // 对端已经持久化到本地新位置，才可推进同步基线。
          await this.progressStore.markSynced(local.bookId,
            local.sha256, local.offset);
          continue;
        }
        if (pending === 'resend') {
          // 先记录待确认状态，再重发；发送失败时基线仍停在旧值，
          // 下次交换不会把本地新进度误判为已同步。
          await this.progressStore.markPending(local.bookId,
            local.sha256, local.offset);
          await this.sendApply(local.bookId, local.sha256,
            local.offset, local.updatedAt);
          continue;
        }
        if (pending === 'conflict') {
          await this.resolveConflict(book, local, remote);
          continue;
        }
      }
      const action = decideSyncAction(local, remote,
        local !== null ? local.syncedOffset : -1);
      if (action === 'apply_remote') {
        emitReadingPrepare(remote.bookId);
        await this.progressStore.applyRemote(remote.bookId,
          remote.sha256, remote.offset, remote.updatedAt);
        this.notifyApply(remote.bookId, remote.offset);
        applied += 1;
      } else if (action === 'apply_local') {
        if (local !== null) {
          await this.progressStore.markPending(remote.bookId,
            remote.sha256, local.offset);
          await this.sendApply(local.bookId, local.sha256,
            local.offset, local.updatedAt);
        }
      } else if (action === 'none' && local !== null) {
        await this.progressStore.markSynced(remote.bookId,
          remote.sha256, local.offset);
      } else if (action === 'conflict' && local !== null) {
        await this.resolveConflict(book, local, remote);
      }
    }
    // 上次阅读只更新“续读入口”，不强制跳书；活动阅读中不处理。
    if (lastBookId && this.activeBookId.length === 0) {
      const lastBook = this.findBook(books, lastBookId);
      const digestOk = lastBook !== null &&
        (typeof lastSha256 !== 'string' || lastSha256.length === 0 ||
         lastBook.sha256 === lastSha256);
      if (digestOk) {
        const lastLocal = await this.progressStore.loadLastRecord();
        if (lastLocal === null ||
            (typeof lastUpdatedAt === 'number' &&
             lastUpdatedAt > lastLocal.updatedAt)) {
          await this.progressStore.applyLastBook(lastBookId,
            typeof lastUpdatedAt === 'number' ? lastUpdatedAt : 0);
        }
      }
    }
    const unmappedCount = this.repository.list().filter((book) =>
      book.progressMapping === 'readerkit_unmapped').length;
    const skipped = unmappedCount > 0 ?
      '；跳过尚未验证的位置 ' +
        unmappedCount + ' 本' : '';
    this.status((applied > 0 ?
      '进度同步：已采用手表进度 ' + applied + ' 本' :
      '进度同步：已交换可映射书籍摘要') + skipped, true);
  }

  private async resolveConflict(book: BookMeta,
    local: ReadingSummary, remote: SyncBook): Promise<void> {
    const key = book.bookId + ':' + local.offset + ':' + remote.offset;
    if (this.conflictKeys.has(key)) return;
    this.conflictKeys.add(key);
    try {
      let choice = 0;
      try {
        const result = await promptAction.showDialog({
          title: '阅读进度冲突',
          message: '《' + book.title + '》在手机和手表上都有新进度。\n' +
            '手机：字节 ' + local.offset + '\n' +
            '手表：字节 ' + remote.offset + '\n请选择保留哪一边。',
          buttons: [
            { text: '保留手机', color: '#60a5fa' },
            { text: '采用手表', color: '#fbbf24' }
          ]
        });
        choice = result.index;
      } catch (error) {
        this.status('进度冲突：无法弹出选择，暂保留手机进度', false);
        return;
      }
      if (choice === 1) {
        emitReadingPrepare(remote.bookId);
        await this.progressStore.applyRemote(remote.bookId,
          remote.sha256, remote.offset, remote.updatedAt);
        this.notifyApply(remote.bookId, remote.offset);
        await this.sendApply(remote.bookId, remote.sha256,
          remote.offset, remote.updatedAt);
        this.status('进度同步：已采用手表进度', true);
      } else {
        await this.progressStore.markPending(remote.bookId,
          remote.sha256, local.offset);
        await this.sendApply(local.bookId, local.sha256,
          local.offset, local.updatedAt);
        this.status('进度同步：已保留手机进度', true);
      }
    } finally {
      // 只防止同一冲突弹窗并发；发送失败/取消后必须允许再次处理。
      this.conflictKeys.delete(key);
    }
  }

  private async acceptApply(message: StateMessage): Promise<void> {
    const bookId = message.bookId;
    const sha256 = message.sha256;
    const offset = message.offset;
    if (!bookId || !sha256 || typeof offset !== 'number') return;
    const books = this.repository.list();
    const book = this.findBook(books, bookId);
    if (book === null || book.progressMapping === 'readerkit_unmapped' ||
        book.sha256 !== sha256 ||
        offset > book.bytes) {
      return;
    }
    if (!this.isUtf8Boundary(book, offset)) return;
    // 手表也会主动上报自己的新进度，APPLY 不一定代表手机用户
    // 刚在冲突弹窗里做了选择。先读当前手机状态重新做三方判断，
    // 避免延迟消息把手机刚读到的新位置静默回滚。
    const local = await this.progressStore.load(book.bookId, book.sha256);
    if (local === null) {
      emitReadingPrepare(book.bookId);
      await this.progressStore.applyRemote(book.bookId, book.sha256,
        offset, typeof message.updatedAt === 'number' ?
          message.updatedAt : 0);
      this.notifyApply(book.bookId, offset);
      return;
    }
    if (local.offset === offset) {
      await this.progressStore.markSynced(book.bookId, book.sha256, offset);
      return;
    }
    const remote: SyncBook = {
      bookId: book.bookId,
      sha256: book.sha256,
      offset: offset,
      updatedAt: typeof message.updatedAt === 'number' ?
        message.updatedAt : 0
    };
    if (local.pendingOffset >= 0) {
      const pending = decidePendingAction(local.offset, local.syncedOffset,
        local.pendingOffset, offset);
      if (pending === 'confirmed') {
        await this.progressStore.markSynced(book.bookId,
          book.sha256, local.offset);
        return;
      }
      if (pending === 'resend') {
        await this.progressStore.markPending(book.bookId,
          book.sha256, local.offset);
        await this.sendApply(local.bookId, local.sha256,
          local.offset, local.updatedAt);
        return;
      }
      if (pending === 'conflict') {
        await this.resolveConflict(book, local, remote);
        return;
      }
    }
    const action = decideSyncAction(local, remote, local.syncedOffset);
    if (action === 'apply_remote') {
      emitReadingPrepare(book.bookId);
      await this.progressStore.applyRemote(book.bookId, book.sha256,
        offset, remote.updatedAt);
      this.notifyApply(book.bookId, offset);
    } else if (action === 'apply_local') {
      await this.progressStore.markPending(book.bookId,
        book.sha256, local.offset);
      await this.sendApply(local.bookId, local.sha256,
        local.offset, local.updatedAt);
    } else if (action === 'none') {
      await this.progressStore.markSynced(book.bookId,
        book.sha256, local.offset);
    } else if (action === 'conflict') {
      await this.resolveConflict(book, local, remote);
    }
  }

  private async sendApply(bookId: string, sha256: string,
    offset: number, updatedAt: number): Promise<void> {
    await this.send({
      v: 0,
      type: 'READ_PROGRESS_APPLY',
      source: 'phone',
      bookId: bookId,
      sha256: sha256,
      offset: offset,
      updatedAt: updatedAt
    });
  }

  private notifyApply(bookId: string, offset: number): void {
    emitReadingApply(bookId, offset);
  }
}
