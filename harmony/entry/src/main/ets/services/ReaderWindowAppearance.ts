// SPDX-License-Identifier: GPL-3.0-only
// Keep the app window immersive across shelf/reader navigation. Every page
// paints behind real system bars and pads interactive content with live insets.
import { common } from '@kit.AbilityKit';
import { display, window } from '@kit.ArkUI';
import { AppThemeMode } from './AppTheme';
import { recordReaderDiagnostic } from './ReaderDiagnostics';

export interface ReaderWindowInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export type ReaderWindowInsetsListener = (insets: ReaderWindowInsets) => void;
type ActivePage = 'none' | 'shelf' | 'reader';

const TRANSPARENT = '#00000000';
const DARK_CONTENT = '#FFFFFFFF';
const LIGHT_CONTENT = '#FF000000';

class ReaderWindowAppearanceService {
  private mainWindow: window.Window | null = null;
  private abilityContext: common.UIAbilityContext | null = null;
  private insetsListener: ReaderWindowInsetsListener | null = null;
  private avoidAreaCallback: ((options: window.AvoidAreaOptions) => void) | null = null;
  private avoidAreaWindow: window.Window | null = null;
  private activePage: ActivePage = 'none';
  private themeMode: AppThemeMode = 'system';
  private darkTheme: boolean = false;
  private generation: number = 0;
  private lastInsetsKey: string = '';
  private operations: Promise<void> = Promise.resolve();

  showShelf(context: common.UIAbilityContext, mode: AppThemeMode,
    dark: boolean, listener: ReaderWindowInsetsListener): void {
    this.showPage(context, 'shelf', mode, dark, listener);
  }

  enterReader(context: common.UIAbilityContext, mode: AppThemeMode,
    dark: boolean, listener: ReaderWindowInsetsListener): void {
    this.showPage(context, 'reader', mode, dark, listener);
  }

  private showPage(context: common.UIAbilityContext, page: ActivePage,
    mode: AppThemeMode, dark: boolean,
    listener: ReaderWindowInsetsListener): void {
    this.abilityContext = context;
    this.activePage = page;
    this.themeMode = mode;
    this.darkTheme = dark;
    this.insetsListener = listener;
    const generation = ++this.generation;
    this.enqueue(async (): Promise<void> => {
      if (generation !== this.generation) return;
      const win = await this.obtainWindow(context);
      if (win === null || generation !== this.generation) return;
      await this.setFullScreen(win);
      if (generation !== this.generation) return;
      await this.setStatusBarVisible(win, page === 'shelf');
      if (generation !== this.generation) return;
      await this.applySystemBars(win);
      if (generation !== this.generation) return;
      this.attachAvoidAreaListener(win);
      this.publishInsets(win, true);
      this.logWindowState(page + '_shown', 0);
      setTimeout((): void => {
        if (generation !== this.generation || this.mainWindow !== win) return;
        // Reader Kit and page transition work may settle after onPageShow.
        // Reconcile only when the observed window state differs from target.
        this.enqueue(async (): Promise<void> => {
          if (generation !== this.generation || this.mainWindow !== win) return;
          await this.setFullScreen(win);
          await this.setStatusBarVisible(win, page === 'shelf');
          if (generation !== this.generation) return;
          await this.applySystemBars(win);
          this.publishInsets(win, false);
          this.logWindowState(page + '_transition_verified', 0);
        });
      }, 120);
    });
  }

  setTheme(mode: AppThemeMode, dark: boolean): void {
    this.themeMode = mode;
    this.darkTheme = dark;
    if (this.activePage === 'none') return;
    const generation = this.generation;
    this.enqueue(async (): Promise<void> => {
      if (generation !== this.generation) return;
      const win = await this.obtainWindow(null);
      if (win === null || generation !== this.generation) return;
      await this.setFullScreen(win);
      await this.applySystemBars(win);
      this.logWindowState('theme_applied', 0);
    });
  }

  refreshInsets(): void {
    if (this.activePage === 'none' || this.mainWindow === null) return;
    this.publishInsets(this.mainWindow, false);
  }

  exitReader(): void {
    if (this.activePage !== 'reader') return;
    this.activePage = 'none';
    this.insetsListener = null;
    const generation = ++this.generation;
    this.logWindowState('reader_exit', 0);
    this.enqueue(async (): Promise<void> => {
      if (generation !== this.generation) return;
      const win = await this.obtainWindow(null);
      if (win === null || generation !== this.generation) return;
      await this.setStatusBarVisible(win, true);
    });
  }

  private enqueue(action: () => Promise<void>): void {
    const next: Promise<void> = this.operations.then(action)
      .catch((error: Error): void => {
        console.error('ReaderWindowAppearance: ' + error.message);
      });
    this.operations = next;
  }

  private async obtainWindow(context: common.UIAbilityContext | null):
    Promise<window.Window | null> {
    if (this.mainWindow !== null) return this.mainWindow;
    const target = context !== null ? context : this.abilityContext;
    if (target === null) return null;
    this.abilityContext = target;
    try {
      this.mainWindow = await window.getLastWindow(target);
    } catch (error) {
      this.logWindowState('get_window_fail', this.errorCode(error));
      this.mainWindow = null;
    }
    return this.mainWindow;
  }

  private async setFullScreen(win: window.Window): Promise<void> {
    try {
      if (win.getWindowProperties().isLayoutFullScreen) return;
      await win.setWindowLayoutFullScreen(true);
    } catch (error) {
      this.logWindowState('full_screen_fail', this.errorCode(error));
      console.error('ReaderWindowAppearance: setWindowLayoutFullScreen failed');
    }
  }

  private async applySystemBars(win: window.Window): Promise<void> {
    try {
      const desired = this.systemBarProperties();
      const current = win.getWindowSystemBarProperties();
      if (this.sameSystemBarState(current, desired)) return;
      await win.setWindowSystemBarProperties(desired);
    } catch (error) {
      this.logWindowState('system_bars_fail', this.errorCode(error));
      console.error('ReaderWindowAppearance: setWindowSystemBarProperties failed');
    }
  }

  private async setStatusBarVisible(win: window.Window,
    visible: boolean): Promise<void> {
    try {
      await win.setSpecificSystemBarEnabled('status', visible, false);
    } catch (error) {
      this.logWindowState(visible ? 'status_bar_show_fail' :
        'status_bar_hide_fail', this.errorCode(error));
      console.error('ReaderWindowAppearance: status bar visibility change failed');
    }
  }

  private sameSystemBarState(current: window.SystemBarProperties,
    desired: window.SystemBarProperties): boolean {
    return current.statusBarColor?.toUpperCase() ===
        desired.statusBarColor?.toUpperCase() &&
      current.navigationBarColor?.toUpperCase() ===
        desired.navigationBarColor?.toUpperCase() &&
      current.isStatusBarLightIcon === desired.isStatusBarLightIcon &&
      current.isNavigationBarLightIcon === desired.isNavigationBarLightIcon &&
      current.statusBarContentColor?.toUpperCase() ===
        desired.statusBarContentColor?.toUpperCase() &&
      current.navigationBarContentColor?.toUpperCase() ===
        desired.navigationBarContentColor?.toUpperCase();
  }

  private systemBarProperties(): window.SystemBarProperties {
    const contentColor = this.darkTheme ? DARK_CONTENT : LIGHT_CONTENT;
    return {
      statusBarColor: TRANSPARENT,
      navigationBarColor: TRANSPARENT,
      isStatusBarLightIcon: this.darkTheme,
      isNavigationBarLightIcon: this.darkTheme,
      statusBarContentColor: contentColor,
      navigationBarContentColor: contentColor,
      enableStatusBarAnimation: false,
      enableNavigationBarAnimation: false
    };
  }

  private attachAvoidAreaListener(win: window.Window): void {
    if (this.avoidAreaWindow === win && this.avoidAreaCallback !== null) return;
    this.detachAvoidAreaListener();
    const callback = (options: window.AvoidAreaOptions): void => {
      if (this.activePage === 'none' || this.mainWindow !== win) return;
      this.publishInsets(win, false);
    };
    try {
      win.on('avoidAreaChange', callback);
      this.avoidAreaWindow = win;
      this.avoidAreaCallback = callback;
    } catch (error) {
      this.logWindowState('insets_listener_fail', this.errorCode(error));
      this.avoidAreaWindow = null;
      this.avoidAreaCallback = null;
    }
  }

  private detachAvoidAreaListener(): void {
    const win = this.avoidAreaWindow;
    const callback = this.avoidAreaCallback;
    this.avoidAreaWindow = null;
    this.avoidAreaCallback = null;
    if (win === null || callback === null) return;
    try {
      win.off('avoidAreaChange', callback);
    } catch (error) {
      // The window may already be destroyed.
    }
  }

  private publishInsets(win: window.Window, force: boolean): void {
    const listener = this.insetsListener;
    if (listener === null || this.activePage === 'none') return;
    const insets = this.readInsets(win);
    const key = [insets.top, insets.bottom, insets.left, insets.right].join(':');
    if (force || key !== this.lastInsetsKey) {
      this.lastInsetsKey = key;
      this.logWindowState('safe_area_changed', 0, insets);
    }
    listener(insets);
  }

  private logWindowState(stage: string, code: number,
    insets?: ReaderWindowInsets): void {
    const context = this.abilityContext;
    if (context === null) return;
    let fullScreen = false;
    let statusBarColor = TRANSPARENT;
    let navigationBarColor = TRANSPARENT;
    let statusBarLightIcon = this.darkTheme;
    let navigationBarLightIcon = this.darkTheme;
    try {
      const win = this.mainWindow;
      if (win !== null) {
        fullScreen = win.getWindowProperties().isLayoutFullScreen;
        const bars = win.getWindowSystemBarProperties();
        statusBarColor = bars.statusBarColor || '';
        navigationBarColor = bars.navigationBarColor || '';
        statusBarLightIcon = bars.isStatusBarLightIcon === true;
        navigationBarLightIcon = bars.isNavigationBarLightIcon === true;
      }
    } catch (error) {
      // Preserve the operation's original code; the failure stage remains
      // visible, while the observed state stays at its safe defaults.
    }
    const details = {
      fullScreen: fullScreen,
      theme: this.themeMode,
      statusBarColor: statusBarColor,
      navigationBarColor: navigationBarColor,
      statusBarLightIcon: statusBarLightIcon,
      navigationBarLightIcon: navigationBarLightIcon,
      topInsetVp: insets?.top,
      bottomInsetVp: insets?.bottom,
      leftInsetVp: insets?.left,
      rightInsetVp: insets?.right
    };
    recordReaderDiagnostic(context, 'window', stage, code, details);
  }

  private errorCode(error: Object): number {
    const value = error as { code?: number };
    return typeof value.code === 'number' && Number.isFinite(value.code) ?
      value.code : 0;
  }

  private readInsets(win: window.Window): ReaderWindowInsets {
    const system = this.safeAvoidArea(win, window.AvoidAreaType.TYPE_SYSTEM);
    const cutout = this.safeAvoidArea(win, window.AvoidAreaType.TYPE_CUTOUT);
    const indicator = this.safeAvoidArea(win,
      window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR);
    const topPx = Math.max(this.topEdge(system), this.topEdge(cutout));
    const bottomPx = Math.max(this.bottomEdge(system), this.bottomEdge(indicator));
    const leftPx = Math.max(this.leftEdge(system), this.leftEdge(cutout));
    const rightPx = Math.max(this.rightEdge(system), this.rightEdge(cutout));
    return {
      top: this.pxToVp(topPx),
      bottom: this.pxToVp(bottomPx),
      left: this.pxToVp(leftPx),
      right: this.pxToVp(rightPx)
    };
  }

  private safeAvoidArea(win: window.Window,
    type: window.AvoidAreaType): window.AvoidArea | null {
    try {
      return win.getWindowAvoidArea(type);
    } catch (error) {
      return null;
    }
  }

  private topEdge(area: window.AvoidArea | null): number {
    return area === null ? 0 : area.topRect.height;
  }

  private bottomEdge(area: window.AvoidArea | null): number {
    return area === null ? 0 : area.bottomRect.height;
  }

  private leftEdge(area: window.AvoidArea | null): number {
    return area === null ? 0 : area.leftRect.width;
  }

  private rightEdge(area: window.AvoidArea | null): number {
    return area === null ? 0 : area.rightRect.width;
  }

  private pxToVp(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0;
    try {
      const density = display.getDefaultDisplaySync().densityPixels;
      if (Number.isFinite(density) && density > 0) return value / density;
    } catch (error) {
      // Previewers may not report display density; use the current px value.
    }
    return value;
  }
}

const readerWindowAppearance: ReaderWindowAppearanceService =
  new ReaderWindowAppearanceService();

export function showShelfWindow(context: common.UIAbilityContext,
  mode: AppThemeMode, dark: boolean,
  listener: ReaderWindowInsetsListener): void {
  readerWindowAppearance.showShelf(context, mode, dark, listener);
}

export function enterReaderWindow(context: common.UIAbilityContext,
  mode: AppThemeMode, dark: boolean,
  listener: ReaderWindowInsetsListener): void {
  readerWindowAppearance.enterReader(context, mode, dark, listener);
}

export function setAppWindowTheme(mode: AppThemeMode, dark: boolean): void {
  readerWindowAppearance.setTheme(mode, dark);
}

export function refreshReaderWindowInsets(): void {
  readerWindowAppearance.refreshInsets();
}

export function exitReaderWindow(): void {
  readerWindowAppearance.exitReader();
}
