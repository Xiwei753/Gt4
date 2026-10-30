// SPDX-License-Identifier: GPL-3.0-only
// 本机 Reader Kit 续读锚点与排版设置。它与手表 UTF-8 字节偏移分开保存。
import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { enqueueBookWrite } from '../model/ProgressWriteQueue';

const PREF_NAME = 'suyue_reader_kit';
const LOCATION_PREFIX = 'loc.';
const SETTINGS_KEY = 'settings';
const SETTINGS_WRITE_KEY = PREF_NAME + ':' + SETTINGS_KEY;

export interface ReaderKitLocation {
  readerSha256: string;
  resourceIndex: number;
  startDomPos: string;
  updatedAt: number;
}

export interface ReaderKitSettings {
  fontSize: number;
  lineHeight: number;
  nightMode: boolean;
  flipMode: string;
  volumeKeyPaging: boolean;
}

const DEFAULT_SETTINGS: ReaderKitSettings = {
  fontSize: 20,
  lineHeight: 1.6,
  nightMode: true,
  flipMode: '1',
  volumeKeyPaging: true
};

export class ReaderKitStateStore {
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

  async loadLocation(bookId: string,
    readerSha256: string): Promise<ReaderKitLocation | null> {
    if (!bookId || !readerSha256) return null;
    return enqueueBookWrite(bookId, async (): Promise<ReaderKitLocation | null> => {
      try {
        const store = await this.getStore();
        const raw = await store.get(LOCATION_PREFIX + bookId, '') as string;
        if (!raw) return null;
        const value = JSON.parse(raw) as ReaderKitLocation;
        if (!value || value.readerSha256 !== readerSha256 ||
            !Number.isInteger(value.resourceIndex) || value.resourceIndex < 0 ||
            typeof value.startDomPos !== 'string' ||
            value.startDomPos.length > 4096) return null;
        return value;
      } catch (error) {
        return null;
      }
    });
  }

  async saveLocation(bookId: string, readerSha256: string,
    resourceIndex: number, startDomPos: string): Promise<void> {
    if (!bookId || !readerSha256 || !Number.isInteger(resourceIndex) ||
        resourceIndex < 0 || typeof startDomPos !== 'string' ||
        startDomPos.length > 4096) return;
    await enqueueBookWrite(bookId, async (): Promise<void> => {
      const store = await this.getStore();
      await store.put(LOCATION_PREFIX + bookId, JSON.stringify({
        readerSha256: readerSha256,
        resourceIndex: resourceIndex,
        startDomPos: startDomPos,
        updatedAt: Date.now()
      } as ReaderKitLocation));
      await store.flush();
    });
  }

  async removeLocation(bookId: string): Promise<void> {
    if (!bookId) return;
    await enqueueBookWrite(bookId, async (): Promise<void> => {
      const store = await this.getStore();
      store.deleteSync(LOCATION_PREFIX + bookId);
      await store.flush();
    });
  }

  async loadSettings(): Promise<ReaderKitSettings> {
    return enqueueBookWrite(SETTINGS_WRITE_KEY,
      async (): Promise<ReaderKitSettings> => {
        try {
          const store = await this.getStore();
          const raw = await store.get(SETTINGS_KEY, '') as string;
          if (!raw) return Object.assign({}, DEFAULT_SETTINGS);
          const value = JSON.parse(raw) as ReaderKitSettings;
          return {
            fontSize: this.clampNumber(value.fontSize, 14, 34,
              DEFAULT_SETTINGS.fontSize),
            lineHeight: this.clampNumber(value.lineHeight, 1.1, 2.4,
              DEFAULT_SETTINGS.lineHeight),
            nightMode: typeof value.nightMode === 'boolean' ?
              value.nightMode : DEFAULT_SETTINGS.nightMode,
            flipMode: value.flipMode === '0' ? '0' : '1',
            volumeKeyPaging: typeof value.volumeKeyPaging === 'boolean' ?
              value.volumeKeyPaging : DEFAULT_SETTINGS.volumeKeyPaging
          };
        } catch (error) {
          return Object.assign({}, DEFAULT_SETTINGS);
        }
      });
  }

  async saveSettings(settings: ReaderKitSettings): Promise<void> {
    await enqueueBookWrite(SETTINGS_WRITE_KEY, async (): Promise<void> => {
      const store = await this.getStore();
      await store.put(SETTINGS_KEY, JSON.stringify({
        fontSize: this.clampNumber(settings.fontSize, 14, 34,
          DEFAULT_SETTINGS.fontSize),
        lineHeight: this.clampNumber(settings.lineHeight, 1.1, 2.4,
          DEFAULT_SETTINGS.lineHeight),
        nightMode: settings.nightMode,
        flipMode: settings.flipMode === '0' ? '0' : '1',
        volumeKeyPaging: settings.volumeKeyPaging
      } as ReaderKitSettings));
      await store.flush();
    });
  }

  private clampNumber(value: number, min: number, max: number,
    fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  }
}
