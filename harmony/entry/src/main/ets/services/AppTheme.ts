// SPDX-License-Identifier: GPL-3.0-only
// Shared app appearance tokens for shelf, transfer, and Reader Kit pages.
export type AppThemeMode = 'system' | 'light' | 'dark';

export const APP_THEME_MODE_KEY = 'suyue.appThemeMode';
export const APP_SYSTEM_DARK_KEY = 'suyue.systemDark';

export interface AppThemePalette {
  page: string;
  readerPage: string;
  surface: string;
  surfaceRaised: string;
  surfaceSelected: string;
  text: string;
  secondaryText: string;
  mutedText: string;
  border: string;
  accent: string;
  accentText: string;
  warningSurface: string;
  warningText: string;
  overlay: string;
  cover: string;
  coverText: string;
  isDark: boolean;
}

export function isDarkTheme(mode: string, systemDark: boolean): boolean {
  if (mode === 'dark') return true;
  if (mode === 'light') return false;
  return systemDark;
}

export function normalizeThemeMode(value: string): AppThemeMode {
  if (value === 'light' || value === 'dark') return value;
  return 'system';
}

export function themePalette(mode: string,
  systemDark: boolean): AppThemePalette {
  const isDark = isDarkTheme(mode, systemDark);
  if (isDark) {
    return {
      page: '#101114',
      readerPage: '#08090D',
      surface: '#191B20',
      surfaceRaised: '#22252C',
      surfaceSelected: '#29384B',
      text: '#F4F4F5',
      secondaryText: '#B6BAC3',
      mutedText: '#888E99',
      border: '#30343D',
      accent: '#AFC8F5',
      accentText: '#182638',
      warningSurface: '#3C3422',
      warningText: '#F5D68A',
      overlay: '#CC101114',
      cover: '#35475C',
      coverText: '#F4F4F5',
      isDark: true
    };
  }
  return {
    page: '#F5F3EE',
    readerPage: '#F7F4EC',
    surface: '#FFFEFB',
    surfaceRaised: '#EEECE6',
    surfaceSelected: '#E3EAF2',
    text: '#282923',
    secondaryText: '#66685F',
    mutedText: '#85867E',
    border: '#DEDCD4',
    accent: '#456A95',
    accentText: '#FFFFFF',
    warningSurface: '#F8EECF',
    warningText: '#72561A',
    overlay: '#EFFFFFFF',
    cover: '#D9E2EB',
    coverText: '#263C55',
    isDark: false
  };
}
