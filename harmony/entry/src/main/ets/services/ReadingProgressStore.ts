// SPDX-License-Identifier: GPL-3.0-only
// 手机端阅读进度：Preferences 小键值，不引入 SQL/新数据库。
// 位置始终是规范化 UTF-8 正文文件内的字节偏移；字体、主题、窗口宽度
// 变化不会改变这个值。记录同时带正文 sha256，摘要不一致时不复用。
//
// 同步基线 syncedOffset 只由阅读同步服务维护：
//   - 用户本地阅读只更新 offset，保留旧基线；
//   - 采用远端进度时 offset 与基线一起更新；
//   - 判定“哪边改过”不能比较 offset 大小，只能比较各自与基线是否一致。
import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { BookMeta } from '../model/BookModels';
import { bumpWriteGeneration, captureWriteGeneration,
  enqueueBookWrite } from '../model/ProgressWriteQueue';

const PREF_NAME = 'suyue_reading_progress';
const KEY_PREFIX = 'p.';
const LAST_KEY = 'last';
const UNKNOWN_BASELINE = -1;
const MAX_PAGINATION_ANCHORS = 32;

export interface PaginationCheckpointState {
  layoutKey: string;
  anchors: number[];
}

export interface ReadingRecord {
  bookId: string;
  sha256: string;
  offset: number;
  updatedAt: number;
  syncedOffset: number;
  pendingOffset: number;
  paginationLayoutKey?: string;
  paginationAnchors?: number[];
}

export interface ReadingSummary {
  bookId: string;
  sha256: string;
  offset: number;
  updatedAt: number;
  syncedOffset: number;
  pendingOffset: number;
}

export interface ReadingLast {
  bookId: string;
  updatedAt: number;
}

interface StoredRecord {
  sha256: string;
  offset: number;
  updatedAt: number;
  syncedOffset?: number;
  pendingOffset?: number;
  paginationLayoutKey?: string;
  paginationAnchors?: number[];
}

interface StoredLast {
  bookId: string;
  updatedAt: number;
}

export class ReadingProgressStore {
  private context: common.UIAbilityContext;
  private store: preferences.Preferences | null = null;

  constructor(context: common.UIAbilityContext) {
    this.context = context;
  }

  private async getStore(): Promise<preferences.Preferences> {
    if (this.store === null) {
      this.store = await preferences.getPreferences(this.context, PREF_NAME);
    }
    return this.store;
  }

  private keyOf(bookId: string): string {
    return KEY_PREFIX + bookId;
  }

  private normalizePaginationState(state: PaginationCheckpointState | undefined):
    PaginationCheckpointState | null {
    if (state === undefined || !state ||
        typeof state.layoutKey !== 'string' || state.layoutKey.length === 0 ||
        state.layoutKey.length > 256 || !Array.isArray(state.anchors)) {
      return null;
    }
    const anchors: number[] = [];
    for (let i = 0; i < state.anchors.length; i++) {
      const anchor = state.anchors[i];
      if (Number.isInteger(anchor) && anchor >= 0 && !anchors.includes(anchor)) {
        anchors.push(anchor);
      }
    }
    anchors.sort((left: number, right: number): number => left - right);
    while (anchors.length > MAX_PAGINATION_ANCHORS) anchors.shift();
    return { layoutKey: state.layoutKey, anchors: anchors };
  }

  private parseRecord(text: string): StoredRecord | null {
    try {
      const value = JSON.parse(text) as StoredRecord;
      if (!value || typeof value.sha256 !== 'string' ||
          typeof value.offset !== 'number' ||
          !Number.isInteger(value.offset) || value.offset < 0) {
        return null;
      }
      const updatedAt = typeof value.updatedAt === 'number' ?
        value.updatedAt : 0;
      const syncedOffset = typeof value.syncedOffset === 'number' &&
        Number.isInteger(value.syncedOffset) && value.syncedOffset >= 0 ?
        value.syncedOffset : UNKNOWN_BASELINE;
      const pendingOffset = typeof value.pendingOffset === 'number' &&
        Number.isInteger(value.pendingOffset) && value.pendingOffset >= 0 ?
        value.pendingOffset : -1;
      const record: StoredRecord = {
        sha256: value.sha256,
        offset: value.offset,
        updatedAt: updatedAt,
        syncedOffset: syncedOffset,
        pendingOffset: pendingOffset
      };
      if (typeof value.paginationLayoutKey === 'string' &&
          value.paginationLayoutKey.length > 0 &&
          value.paginationLayoutKey.length <= 256 &&
          Array.isArray(value.paginationAnchors)) {
        const anchors: number[] = [];
        for (let i = 0; i < value.paginationAnchors.length; i++) {
          const anchor = value.paginationAnchors[i];
          if (typeof anchor === 'number' && Number.isInteger(anchor) &&
              anchor >= 0 && !anchors.includes(anchor)) {
            anchors.push(anchor);
          }
        }
        anchors.sort((left: number, right: number): number => left - right);
        while (anchors.length > MAX_PAGINATION_ANCHORS) anchors.shift();
        record.paginationLayoutKey = value.paginationLayoutKey;
        record.paginationAnchors = anchors;
      }
      return record;
    } catch (error) {
      return null;
    }
  }

  private async readRecord(bookId: string): Promise<StoredRecord | null> {
    try {
      const store = await this.getStore();
      const raw = await store.get(this.keyOf(bookId), '') as string;
      if (!raw) return null;
      return this.parseRecord(raw);
    } catch (error) {
      return null;
    }
  }

  private async writeRecord(bookId: string, record: StoredRecord): Promise<void> {
    const store = await this.getStore();
    await store.put(this.keyOf(bookId), JSON.stringify(record));
    await store.flush();
  }

  async load(bookId: string, sha256: string): Promise<ReadingRecord | null> {
    if (!bookId || !sha256) return null;
    const parsed = await this.readRecord(bookId);
    if (parsed === null || parsed.sha256 !== sha256) return null;
    return {
      bookId: bookId,
      sha256: parsed.sha256,
      offset: parsed.offset,
      updatedAt: parsed.updatedAt,
      syncedOffset: parsed.syncedOffset !== undefined ?
        parsed.syncedOffset : UNKNOWN_BASELINE,
      pendingOffset: parsed.pendingOffset !== undefined ?
        parsed.pendingOffset : -1,
      paginationLayoutKey: parsed.paginationLayoutKey,
      paginationAnchors: parsed.paginationAnchors
    };
  }

  // 本地阅读保存：默认保留上一次同步基线，不能把“本地新读”误当成
  // “已同步”。同步服务在确认采用某一边后可显式传入 baseline。
  async save(bookId: string, sha256: string, offset: number,
    baseline?: number, generation?: number,
    pagination?: PaginationCheckpointState): Promise<void> {
    if (!bookId || !sha256 || !Number.isInteger(offset) || offset < 0) {
      return;
    }
    const checkpoint = this.normalizePaginationState(pagination);
    const writeGeneration = generation !== undefined ?
      generation : captureWriteGeneration(bookId);
    await enqueueBookWrite(bookId, async () => {
      let syncedOffset = UNKNOWN_BASELINE;
      let pendingOffset = -1;
      const existing = await this.readRecord(bookId);
      if (existing !== null && existing.sha256 === sha256) {
        if (existing.syncedOffset !== undefined) {
          syncedOffset = existing.syncedOffset;
        }
        if (existing.pendingOffset !== undefined &&
            existing.pendingOffset >= 0) {
          // 本地又往前读了：旧的待确认位置已被新位置取代。
          pendingOffset = offset;
        }
      }
      if (typeof baseline === 'number' && Number.isInteger(baseline) &&
          baseline >= 0) {
        syncedOffset = baseline;
        pendingOffset = -1;
      }
      await this.writeRecord(bookId, {
        sha256: sha256,
        offset: offset,
        updatedAt: Date.now(),
        syncedOffset: syncedOffset,
        pendingOffset: pendingOffset,
        paginationLayoutKey: checkpoint !== null ? checkpoint.layoutKey :
          existing !== null && existing.sha256 === sha256 ?
            existing.paginationLayoutKey : undefined,
        paginationAnchors: checkpoint !== null ? checkpoint.anchors :
          existing !== null && existing.sha256 === sha256 ?
            existing.paginationAnchors : undefined
      });
    }, writeGeneration);
  }

  // Pagination checkpoints are local layout metadata. Updating them must not
  // change the synchronized reading offset or its conflict timestamp.
  async savePaginationCheckpoints(bookId: string, sha256: string,
    state: PaginationCheckpointState): Promise<void> {
    if (!bookId || !sha256) return;
    const checkpoint = this.normalizePaginationState(state);
    if (checkpoint === null) return;
    const writeGeneration = captureWriteGeneration(bookId);
    await enqueueBookWrite(bookId, async () => {
      const existing = await this.readRecord(bookId);
      if (existing === null || existing.sha256 !== sha256) return;
      existing.paginationLayoutKey = checkpoint.layoutKey;
      existing.paginationAnchors = checkpoint.anchors;
      await this.writeRecord(bookId, existing);
    }, writeGeneration);
  }

  // 采用远端进度：保留远端 updatedAt，基线直接设为该偏移。
  async applyRemote(bookId: string, sha256: string, offset: number,
    updatedAt: number): Promise<void> {
    if (!bookId || !sha256 || !Number.isInteger(offset) || offset < 0) {
      return;
    }
    const writeGeneration = bumpWriteGeneration(bookId);
    await enqueueBookWrite(bookId, async () => {
      const existing = await this.readRecord(bookId);
      await this.writeRecord(bookId, {
        sha256: sha256,
        offset: offset,
        updatedAt: typeof updatedAt === 'number' && updatedAt > 0 ?
          updatedAt : Date.now(),
        syncedOffset: offset,
        pendingOffset: -1,
        paginationLayoutKey: existing !== null && existing.sha256 === sha256 ?
          existing.paginationLayoutKey : undefined,
        paginationAnchors: existing !== null && existing.sha256 === sha256 ?
          existing.paginationAnchors : undefined
      });
    }, writeGeneration);
  }

  // 本地进度胜出：只把基线推进到当前本地 offset，不制造“新阅读”。
  async markSynced(bookId: string, sha256: string, offset: number): Promise<void> {
    if (!bookId || !sha256 || !Number.isInteger(offset) || offset < 0) return;
    // 只更新同步元数据，不采用远端位置；不能提升写入代次，
    // 否则会把尚未落盘的本地新阅读位置误判为过期。
    await enqueueBookWrite(bookId, async () => {
      const existing = await this.readRecord(bookId);
      if (existing === null || existing.sha256 !== sha256) return;
      await this.writeRecord(bookId, {
        sha256: existing.sha256,
        offset: existing.offset,
        updatedAt: existing.updatedAt,
        syncedOffset: offset,
        pendingOffset: -1,
        paginationLayoutKey: existing.paginationLayoutKey,
        paginationAnchors: existing.paginationAnchors
      });
    });
  }

  // 本地进度等待对端确认：只记录待确认位置，不推进同步基线。
  // 对端下次回报相同 offset 时才 markSynced；发送失败则保留 pending。
  async markPending(bookId: string, sha256: string,
    offset: number): Promise<void> {
    if (!bookId || !sha256 || !Number.isInteger(offset) || offset < 0) {
      return;
    }
    // 只记录待确认位置，不采用远端位置；保持本地新阅读位置有效。
    await enqueueBookWrite(bookId, async () => {
      const existing = await this.readRecord(bookId);
      if (existing === null || existing.sha256 !== sha256) return;
      await this.writeRecord(bookId, {
        sha256: existing.sha256,
        offset: existing.offset,
        updatedAt: existing.updatedAt,
        syncedOffset: existing.syncedOffset !== undefined ?
          existing.syncedOffset : UNKNOWN_BASELINE,
        pendingOffset: offset,
        paginationLayoutKey: existing.paginationLayoutKey,
        paginationAnchors: existing.paginationAnchors
      });
    });
  }

  async saveLastBook(bookId: string): Promise<void> {
    if (!bookId) return;
    await this.applyLastBook(bookId, Date.now());
  }

  async applyLastBook(bookId: string, updatedAt: number): Promise<void> {
    if (!bookId) return;
    const last: StoredLast = {
      bookId: bookId,
      updatedAt: typeof updatedAt === 'number' && updatedAt > 0 ?
        updatedAt : Date.now()
    };
    const store = await this.getStore();
    await store.put(LAST_KEY, JSON.stringify(last));
    await store.flush();
  }

  async loadLastBook(): Promise<string> {
    const last = await this.loadLastRecord();
    return last !== null ? last.bookId : '';
  }

  async loadLastRecord(): Promise<ReadingLast | null> {
    try {
      const store = await this.getStore();
      const raw = await store.get(LAST_KEY, '') as string;
      if (!raw) return null;
      const last = JSON.parse(raw) as StoredLast;
      if (!last || typeof last.bookId !== 'string' || !last.bookId) {
        return null;
      }
      return {
        bookId: last.bookId,
        updatedAt: typeof last.updatedAt === 'number' ? last.updatedAt : 0
      };
    } catch (error) {
      return null;
    }
  }

  // 同步首包用：只返回本机已有书籍、且摘要仍然匹配的进度摘要。
  async list(books: BookMeta[]): Promise<ReadingSummary[]> {
    const out: ReadingSummary[] = [];
    for (let i = 0; i < books.length; i++) {
      const book = books[i];
      const parsed = await this.readRecord(book.bookId);
      if (parsed === null || parsed.sha256 !== book.sha256) continue;
      out.push({
        bookId: book.bookId,
        sha256: book.sha256,
        offset: parsed.offset,
        updatedAt: parsed.updatedAt,
        syncedOffset: parsed.syncedOffset !== undefined ?
          parsed.syncedOffset : UNKNOWN_BASELINE,
        pendingOffset: parsed.pendingOffset !== undefined ?
          parsed.pendingOffset : -1
      });
    }
    return out;
  }

  async remove(bookId: string): Promise<void> {
    if (!bookId) return;
    await enqueueBookWrite(bookId, async (): Promise<void> => {
      try {
        const store = await this.getStore();
        store.deleteSync(this.keyOf(bookId));
        const raw = await store.get(LAST_KEY, '') as string;
        if (raw) {
          const last = JSON.parse(raw) as StoredLast;
          if (last && last.bookId === bookId) {
            store.deleteSync(LAST_KEY);
          }
        }
        await store.flush();
      } catch (error) {
        // 删除书籍本身不应因为进度清理失败而回滚。
      }
    });
  }
}
