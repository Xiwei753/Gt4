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
  statusBarHeight: number;
  windowWidth: number;
  windowHeight: number;
  navigationIndicator: ReaderWindowCutout;
  cutoutGeometryAvailable: boolean;
  cutouts: ReaderWindowCutout[];
}

export interface ReaderWindowCutout {
  left: number;
  top: number;
  right: number;
  bottom: number;
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
  private displayChangeCallback: ((displayId: number) => void) | null = null;
  private displayChangeRegistered: boolean = false;
  private windowDisplayChangeCallback: ((displayId: number) => void) | null = null;
  private windowDisplayChangeWindow: window.Window | null = null;
  private activePage: ActivePage = 'none';
  private activePageToken: number = 0;
  private themeMode: AppThemeMode = 'system';
  private darkTheme: boolean = false;
  private generation: number = 0;
  private insetsReadGeneration: number = 0;
  private lastInsetsKey: string = '';
  private cutoutFailureLogged: boolean = false;
  private operations: Promise<void> = Promise.resolve();

  showShelf(context: common.UIAbilityContext, mode: AppThemeMode,
    dark: boolean, listener: ReaderWindowInsetsListener): void {
    this.showPage(context, 'shelf', mode, dark, listener);
  }

  enterReader(context: common.UIAbilityContext, mode: AppThemeMode,
    dark: boolean, listener: ReaderWindowInsetsListener): number {
    return this.showPage(context, 'reader', mode, dark, listener);
  }

  private showPage(context: common.UIAbilityContext, page: ActivePage,
    mode: AppThemeMode, dark: boolean,
    listener: ReaderWindowInsetsListener): number {
    this.abilityContext = context;
    this.activePage = page;
    this.themeMode = mode;
    this.darkTheme = dark;
    this.insetsListener = listener;
    this.insetsReadGeneration++;
    const generation = ++this.generation;
    this.activePageToken = generation;
    this.enqueue(async (): Promise<void> => {
      if (generation !== this.generation) return;
      const win = await this.obtainWindow(context);
      if (win === null || generation !== this.generation) return;
      await this.setFullScreen(win);
      if (generation !== this.generation) return;
      await this.applySystemBars(win);
      if (generation !== this.generation) return;
      await this.setStatusBarVisible(win, page === 'shelf');
      if (generation !== this.generation) return;
      this.attachAvoidAreaListener(win);
      this.attachDisplayChangeListeners(win);
      this.publishInsets(win, true);
      this.logWindowState(page + '_shown', 0);
      setTimeout((): void => {
        if (generation !== this.generation || this.mainWindow !== win) return;
        // Page transition work may settle after onPageShow.
        // Reconcile only when the observed window state differs from target.
        this.enqueue(async (): Promise<void> => {
          if (generation !== this.generation || this.mainWindow !== win) return;
          await this.setFullScreen(win);
          await this.applySystemBars(win);
          if (generation !== this.generation) return;
          await this.setStatusBarVisible(win, page === 'shelf');
          if (generation !== this.generation) return;
          this.publishInsets(win, false);
          this.logWindowState(page + '_transition_verified', 0);
        });
      }, 120);
    });
    return generation;
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
      if (generation !== this.generation) return;
      await this.setStatusBarVisible(win, this.activePage === 'shelf');
      this.logWindowState('theme_applied', 0);
    });
  }

  refreshInsets(): void {
    if (this.activePage === 'none' || this.mainWindow === null) return;
    this.publishInsets(this.mainWindow, false);
  }

  exitReader(pageToken: number): void {
    if (this.activePage !== 'reader' ||
        pageToken !== this.activePageToken) return;
    this.activePage = 'none';
    this.activePageToken = 0;
    this.insetsListener = null;
    this.insetsReadGeneration++;
    this.detachAvoidAreaListener();
    this.detachDisplayChangeListeners();
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
    let code = 0;
    try {
      await win.setSpecificSystemBarEnabled('status', visible, false);
    } catch (error) {
      code = this.errorCode(error);
      console.error('ReaderWindowAppearance: status bar visibility change failed');
    }
    const stage = code === 0 ? 'status_bar_visibility_applied' :
      visible ? 'status_bar_show_fail' : 'status_bar_hide_fail';
    this.logWindowState(stage, code, undefined, visible);
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

  private attachDisplayChangeListeners(win: window.Window): void {
    if (this.windowDisplayChangeWindow !== win) {
      this.detachWindowDisplayChangeListener();
      const callback = (displayId: number): void => {
        if (this.activePage === 'none' || this.mainWindow !== win) return;
        this.publishInsets(win, true);
      };
      try {
        win.on('displayIdChange', callback);
        this.windowDisplayChangeWindow = win;
        this.windowDisplayChangeCallback = callback;
      } catch (error) {
        this.logWindowState('display_id_listener_fail',
          this.errorCode(error));
      }
    }
    if (this.displayChangeRegistered) return;
    const callback = (displayId: number): void => {
      if (this.activePage === 'none' || this.mainWindow !== win) return;
      try {
        const windowDisplayId = win.getWindowProperties().displayId;
        if (windowDisplayId !== undefined &&
            windowDisplayId !== displayId) return;
      } catch (error) {
        // Refresh conservatively if the current display cannot be read.
      }
      this.publishInsets(win, false);
    };
    try {
      display.on('change', callback);
      this.displayChangeCallback = callback;
      this.displayChangeRegistered = true;
    } catch (error) {
      this.logWindowState('display_change_listener_fail',
        this.errorCode(error));
    }
  }

  private detachWindowDisplayChangeListener(): void {
    const win = this.windowDisplayChangeWindow;
    const callback = this.windowDisplayChangeCallback;
    this.windowDisplayChangeWindow = null;
    this.windowDisplayChangeCallback = null;
    if (win === null || callback === null) return;
    try {
      win.off('displayIdChange', callback);
    } catch (error) {
      // The window may already be destroyed.
    }
  }

  private detachDisplayChangeListeners(): void {
    this.detachWindowDisplayChangeListener();
    const callback = this.displayChangeCallback;
    this.displayChangeCallback = null;
    if (!this.displayChangeRegistered || callback === null) return;
    this.displayChangeRegistered = false;
    try {
      display.off('change', callback);
    } catch (error) {
      // Display listeners may already have been released by the framework.
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
    const request = ++this.insetsReadGeneration;
    this.readInsets(win).then((insets: ReaderWindowInsets): void => {
      if (request !== this.insetsReadGeneration ||
          this.activePage === 'none' || this.mainWindow !== win ||
          this.insetsListener !== listener) return;
      const key = [insets.top, insets.bottom, insets.left, insets.right,
        insets.statusBarHeight, insets.windowWidth, insets.windowHeight,
        insets.navigationIndicator.left, insets.navigationIndicator.top,
        insets.navigationIndicator.right, insets.navigationIndicator.bottom,
        insets.cutouts.map((rect: ReaderWindowCutout) =>
          [rect.left, rect.top, rect.right, rect.bottom].join(',')).join(';')]
        .join(':');
      if (force || key !== this.lastInsetsKey) {
        this.lastInsetsKey = key;
        this.logWindowState('safe_area_changed', 0, insets);
      }
      listener(insets);
    }).catch((error: Error): void => {
      this.logWindowState('insets_read_fail', this.errorCode(error));
    });
  }

  private logWindowState(stage: string, code: number,
    insets?: ReaderWindowInsets,
    statusBarTargetVisible?: boolean): void {
    const context = this.abilityContext;
    if (context === null) return;
    let fullScreen = false;
    let statusBarColor = TRANSPARENT;
    let navigationBarColor = TRANSPARENT;
    let statusBarLightIcon = this.darkTheme;
    let navigationBarLightIcon = this.darkTheme;
    let statusBarVisible = false;
    let statusBarVisibilityKnown = false;
    let systemAvoidAreaVisible = false;
    let statusBarTopRectHeightPx = 0;
    try {
      const win = this.mainWindow;
      if (win !== null) {
        fullScreen = win.getWindowProperties().isLayoutFullScreen;
        const bars = win.getWindowSystemBarProperties();
        statusBarColor = bars.statusBarColor || '';
        navigationBarColor = bars.navigationBarColor || '';
        statusBarLightIcon = bars.isStatusBarLightIcon === true;
        navigationBarLightIcon = bars.isNavigationBarLightIcon === true;
        const systemArea = this.safeAvoidArea(win,
          window.AvoidAreaType.TYPE_SYSTEM);
        if (systemArea !== null) {
          statusBarVisibilityKnown = true;
          systemAvoidAreaVisible = systemArea.visible;
          statusBarTopRectHeightPx = systemArea.topRect.height;
          statusBarVisible = systemArea.visible &&
            systemArea.topRect.height > 0;
        }
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
      statusBarTargetVisible: statusBarTargetVisible,
      statusBarVisible: statusBarVisible,
      statusBarVisibilityKnown: statusBarVisibilityKnown,
      systemAvoidAreaVisible: systemAvoidAreaVisible,
      statusBarTopRectHeightPx: statusBarTopRectHeightPx,
      topInsetVp: insets?.top,
      bottomInsetVp: insets?.bottom,
      leftInsetVp: insets?.left,
      rightInsetVp: insets?.right,
      windowWidthVp: insets?.windowWidth,
      windowHeightVp: insets?.windowHeight,
      statusBarHeightVp: insets?.statusBarHeight,
      cutoutCount: insets?.cutouts.length,
      cutoutGeometryAvailable: insets?.cutoutGeometryAvailable,
      navigationIndicatorRectVp: insets?.navigationIndicator,
      cutoutRectsVp: insets?.cutouts
    };
    recordReaderDiagnostic(context, 'window', stage, code, details);
  }

  private errorCode(error: Object): number {
    const value = error as { code?: number };
    return typeof value.code === 'number' && Number.isFinite(value.code) ?
      value.code : 0;
  }

  private async readInsets(win: window.Window): Promise<ReaderWindowInsets> {
    const system = this.safeAvoidArea(win, window.AvoidAreaType.TYPE_SYSTEM);
    const systemIgnoringVisibility = this.safeAvoidAreaIgnoringVisibility(win,
      window.AvoidAreaType.TYPE_SYSTEM);
    const cutout = this.safeAvoidArea(win, window.AvoidAreaType.TYPE_CUTOUT);
    const indicator = this.safeAvoidArea(win,
      window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR);
    const statusBarPx = Math.max(this.topEdge(system),
      this.topEdge(systemIgnoringVisibility));
    const cutoutTopPx = this.topEdge(cutout);
    const topPx = Math.max(statusBarPx, cutoutTopPx);
    const bottomPx = Math.max(this.bottomEdge(system), this.bottomEdge(indicator));
    const leftPx = Math.max(this.leftEdge(system), this.leftEdge(cutout));
    const rightPx = Math.max(this.rightEdge(system), this.rightEdge(cutout));
    let windowWidthPx = 0;
    let windowHeightPx = 0;
    let windowLeftPx = 0;
    let windowTopPx = 0;
    let densityPixels = 1;
    let displayObject: display.Display | null = null;
    try {
      const properties = win.getWindowProperties();
      windowWidthPx = properties.windowRect.width;
      windowHeightPx = properties.windowRect.height;
      windowLeftPx = properties.windowRect.left;
      windowTopPx = properties.windowRect.top;
      displayObject = properties.displayId !== undefined ?
        display.getDisplayByIdSync(properties.displayId) :
        display.getDefaultDisplaySync();
    } catch (error) {
      try {
        displayObject = display.getDefaultDisplaySync();
        windowWidthPx = displayObject.width;
        windowHeightPx = displayObject.height;
      } catch (displayError) {
        windowWidthPx = leftPx + rightPx;
      }
    }
    if (displayObject !== null && Number.isFinite(displayObject.densityPixels) &&
        displayObject.densityPixels > 0) {
      densityPixels = displayObject.densityPixels;
    }
    let cutoutGeometryAvailable = false;
    const cutouts: ReaderWindowCutout[] = [];
    if (displayObject !== null) {
      try {
        const cutoutInfo = await displayObject.getCutoutInfo();
        cutoutGeometryAvailable = true;
        for (let i = 0; i < cutoutInfo.boundingRects.length; i++) {
          const rect = cutoutInfo.boundingRects[i];
          const localLeftPx = Math.max(0, rect.left - windowLeftPx);
          const localTopPx = Math.max(0, rect.top - windowTopPx);
          const localRightPx = Math.min(windowWidthPx,
            rect.left + rect.width - windowLeftPx);
          const localBottomPx = Math.min(windowHeightPx,
            rect.top + rect.height - windowTopPx);
          if (localRightPx <= localLeftPx || localBottomPx <= localTopPx) {
            continue;
          }
          cutouts.push({
            left: this.pxToVp(localLeftPx, densityPixels),
            top: this.pxToVp(localTopPx, densityPixels),
            right: this.pxToVp(localRightPx, densityPixels),
            bottom: this.pxToVp(localBottomPx, densityPixels)
          });
        }
      } catch (error) {
        if (!this.cutoutFailureLogged) {
          this.cutoutFailureLogged = true;
          this.logWindowState('cutout_geometry_unavailable',
            this.errorCode(error));
        }
      }
    }
    if (!cutoutGeometryAvailable && cutout !== null && cutout.visible &&
        cutout.topRect.width > 0 && cutout.topRect.height > 0) {
      // The avoid-area topRect is only a conservative fallback. It is not a
      // replacement for the full display CutoutInfo boundingRects list.
      const rect = cutout.topRect;
      cutouts.push({
        left: this.pxToVp(Math.max(0, rect.left), densityPixels),
        top: this.pxToVp(Math.max(0, rect.top), densityPixels),
        right: this.pxToVp(Math.max(0, rect.left + rect.width), densityPixels),
        bottom: this.pxToVp(Math.max(0, rect.top + rect.height), densityPixels)
      });
    }
    const statusBarHeightVp = this.pxToVp(statusBarPx, densityPixels);
    let contentTopInsetVp = this.pxToVp(topPx, densityPixels);
    for (let i = 0; i < cutouts.length; i++) {
      const rect = cutouts[i];
      if (rect.top <= statusBarHeightVp && rect.bottom > 0) {
        contentTopInsetVp = Math.max(contentTopInsetVp, rect.bottom);
      }
    }
    const navigationIndicator = indicator !== null && indicator.visible ?
      this.localRect(indicator.bottomRect, windowLeftPx, windowTopPx,
        windowWidthPx, windowHeightPx, densityPixels) :
      { left: 0, top: 0, right: 0, bottom: 0 };
    return {
      top: contentTopInsetVp,
      bottom: this.pxToVp(bottomPx, densityPixels),
      left: this.pxToVp(leftPx, densityPixels),
      right: this.pxToVp(rightPx, densityPixels),
      statusBarHeight: statusBarHeightVp,
      windowWidth: this.pxToVp(windowWidthPx, densityPixels),
      windowHeight: this.pxToVp(windowHeightPx, densityPixels),
      navigationIndicator: navigationIndicator,
      cutoutGeometryAvailable: cutoutGeometryAvailable,
      cutouts: cutouts
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

  private safeAvoidAreaIgnoringVisibility(win: window.Window,
    type: window.AvoidAreaType): window.AvoidArea | null {
    try {
      return win.getWindowAvoidAreaIgnoringVisibility(type);
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

  private localRect(rect: { left: number; top: number; width: number;
    height: number }, windowLeftPx: number, windowTopPx: number,
    windowWidthPx: number, windowHeightPx: number,
    densityPixels: number): ReaderWindowCutout {
    const leftPx = Math.max(0, rect.left - windowLeftPx);
    const topPx = Math.max(0, rect.top - windowTopPx);
    const rightPx = Math.min(windowWidthPx,
      rect.left + rect.width - windowLeftPx);
    const bottomPx = Math.min(windowHeightPx,
      rect.top + rect.height - windowTopPx);
    if (rightPx <= leftPx || bottomPx <= topPx) {
      return { left: 0, top: 0, right: 0, bottom: 0 };
    }
    return {
      left: this.pxToVp(leftPx, densityPixels),
      top: this.pxToVp(topPx, densityPixels),
      right: this.pxToVp(rightPx, densityPixels),
      bottom: this.pxToVp(bottomPx, densityPixels)
    };
  }

  private pxToVp(value: number, densityPixels: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return densityPixels > 0 ? value / densityPixels : value;
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
  listener: ReaderWindowInsetsListener): number {
  return readerWindowAppearance.enterReader(context, mode, dark, listener);
}

export function setAppWindowTheme(mode: AppThemeMode, dark: boolean): void {
  readerWindowAppearance.setTheme(mode, dark);
}

export function refreshReaderWindowInsets(): void {
  readerWindowAppearance.refreshInsets();
}

export function exitReaderWindow(pageToken: number): void {
  readerWindowAppearance.exitReader(pageToken);
}
