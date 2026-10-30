// SPDX-License-Identifier: GPL-3.0-only
import { Configuration, ConfigurationConstant, UIAbility } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { APP_SYSTEM_DARK_KEY, APP_THEME_MODE_KEY,
  AppThemeMode, isDarkTheme } from '../services/AppTheme';
import { AppThemeStore, applyNativeThemeMode }
  from '../services/AppThemeStore';
import { recordReaderDiagnostic } from '../services/ReaderDiagnostics';

interface AbilityErrorCode {
  code?: number;
}

export default class EntryAbility extends UIAbility {
  onWindowStageCreate(windowStage: window.WindowStage): void {
    const context = this.context;
    const initialSystemDark = context.config.colorMode ===
      ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
    AppStorage.SetOrCreate(APP_SYSTEM_DARK_KEY, initialSystemDark);
    new AppThemeStore(context).load().catch((): AppThemeMode => 'system')
      .then((mode) => {
        AppStorage.SetOrCreate(APP_THEME_MODE_KEY, mode);
        const dark = isDarkTheme(mode, initialSystemDark);
        windowStage.getMainWindow().then(async (mainWindow) => {
          try {
            await mainWindow.setWindowLayoutFullScreen(true);
            await mainWindow.setWindowSystemBarProperties({
              statusBarColor: '#00000000',
              navigationBarColor: '#00000000',
              isStatusBarLightIcon: dark,
              isNavigationBarLightIcon: dark,
              statusBarContentColor: dark ? '#FFFFFFFF' : '#FF000000',
              navigationBarContentColor: dark ? '#FFFFFFFF' : '#FF000000',
              enableStatusBarAnimation: false,
              enableNavigationBarAnimation: false
            });
          } catch (error) {
            const value = error as AbilityErrorCode;
            recordReaderDiagnostic(context, 'window', 'startup_apply_fail',
              typeof value.code === 'number' ? value.code : 0, {
                fullScreen: true,
                theme: mode,
                statusBarColor: '#00000000',
                navigationBarColor: '#00000000'
              });
          }
          windowStage.loadContent('pages/Index').then(() => {
            applyNativeThemeMode(context, mode);
          }).catch(() => {
            recordReaderDiagnostic(context, 'window', 'load_index_fail');
          });
        }).catch((error: Error) => {
          const value = error as AbilityErrorCode;
          recordReaderDiagnostic(context, 'window', 'main_window_fail',
            typeof value.code === 'number' ? value.code : 0);
          windowStage.loadContent('pages/Index');
        });
      });
  }

  onConfigurationUpdate(newConfig: Configuration): void {
    const mode = AppStorage.Get(APP_THEME_MODE_KEY) as string;
    if (mode !== 'system') return;
    const dark = newConfig.colorMode ===
      ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
    AppStorage.SetOrCreate(APP_SYSTEM_DARK_KEY, dark);
  }
}
