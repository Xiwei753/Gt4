// SPDX-License-Identifier: GPL-3.0-only
// Persist the user's system/light/dark choice separately from book data.
import { common, ConfigurationConstant } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { APP_SYSTEM_DARK_KEY, AppThemeMode, normalizeThemeMode } from './AppTheme';

const PREFERENCES_NAME = 'suyue_app_appearance';
const THEME_KEY = 'themeMode';
const LEGACY_READER_PREFERENCES = 'suyue_reader_kit';
const LEGACY_READER_SETTINGS_KEY = 'settings';

export class AppThemeStore {
  private context: common.UIAbilityContext;
  private store: preferences.Preferences | null = null;

  constructor(context: common.UIAbilityContext) {
    this.context = context;
  }

  private async getStore(): Promise<preferences.Preferences> {
    if (this.store === null) {
      this.store = await preferences.getPreferences(this.context,
        PREFERENCES_NAME);
    }
    return this.store;
  }

  async load(): Promise<AppThemeMode> {
    try {
      const store = await this.getStore();
      const value = await store.get(THEME_KEY, '') as string;
      if (value === 'system' || value === 'light' || value === 'dark') {
        return value;
      }
    } catch (error) {
      return 'system';
    }
    return this.loadLegacyReaderTheme();
  }

  async save(mode: AppThemeMode): Promise<void> {
    const store = await this.getStore();
    await store.put(THEME_KEY, normalizeThemeMode(mode));
    await store.flush();
  }

  private async loadLegacyReaderTheme(): Promise<AppThemeMode> {
    try {
      const store = await preferences.getPreferences(this.context,
        LEGACY_READER_PREFERENCES);
      const raw = await store.get(LEGACY_READER_SETTINGS_KEY, '') as string;
      if (!raw) return 'system';
      const settings = JSON.parse(raw) as { nightMode?: boolean };
      if (typeof settings.nightMode === 'boolean') {
        return settings.nightMode ? 'dark' : 'light';
      }
    } catch (error) {
      return 'system';
    }
    return 'system';
  }
}

export function applyNativeThemeMode(context: common.UIAbilityContext,
  mode: AppThemeMode): void {
  const colorMode = mode === 'dark' ?
    ConfigurationConstant.ColorMode.COLOR_MODE_DARK :
    mode === 'light' ? ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT :
      ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET;
  try {
    context.setColorMode(colorMode);
  } catch (error) {
    // The app uses explicit color tokens, so theme selection still works if
    // the platform cannot update its resource color mode.
  }
  if (mode === 'dark') AppStorage.SetOrCreate(APP_SYSTEM_DARK_KEY, true);
  else if (mode === 'light') AppStorage.SetOrCreate(APP_SYSTEM_DARK_KEY, false);
  else {
    AppStorage.SetOrCreate(APP_SYSTEM_DARK_KEY,
      context.config.colorMode ===
        ConfigurationConstant.ColorMode.COLOR_MODE_DARK);
  }
}
