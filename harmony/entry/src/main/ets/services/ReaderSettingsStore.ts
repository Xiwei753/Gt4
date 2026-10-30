// SPDX-License-Identifier: GPL-3.0-only
// Reading settings retain the existing Preferences file/key so upgrading from
// Reader Kit keeps font, spacing, theme and volume-key choices intact.
import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { enqueueBookWrite } from '../model/ProgressWriteQueue';

const PREF_NAME = 'suyue_reader_kit';
const SETTINGS_KEY = 'settings';
const SETTINGS_WRITE_KEY = PREF_NAME + ':' + SETTINGS_KEY;

export interface ReaderSettings {
  fontSize: number;
  lineHeight: number;
  nightMode: boolean;
  flipMode: string;
  volumeKeyPaging: boolean;
}

const DEFAULT_SETTINGS: ReaderSettings = {
  fontSize: 20,
  lineHeight: 1.6,
  nightMode: true,
  flipMode: '1',
  volumeKeyPaging: true
};

export class ReaderSettingsStore {
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

  async load(): Promise<ReaderSettings> {
    return enqueueBookWrite(SETTINGS_WRITE_KEY,
      async (): Promise<ReaderSettings> => {
        try {
          const store = await this.getStore();
          const raw = await store.get(SETTINGS_KEY, '') as string;
          if (!raw) return Object.assign({}, DEFAULT_SETTINGS);
          const value = JSON.parse(raw) as ReaderSettings;
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

  async save(settings: ReaderSettings): Promise<void> {
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
      } as ReaderSettings));
      await store.flush();
    });
  }

  async removeLegacyLocation(bookId: string): Promise<void> {
    if (!bookId) return;
    const key = PREF_NAME + ':loc.' + bookId;
    await enqueueBookWrite(key, async (): Promise<void> => {
      const store = await this.getStore();
      store.deleteSync('loc.' + bookId);
      await store.flush();
    });
  }

  private clampNumber(value: number, min: number, max: number,
    fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  }
}
