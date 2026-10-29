// SPDX-License-Identifier: GPL-3.0-only
// 阅读页沉浸式窗口外观：真实系统状态栏/手势指示条透明延伸，
// 仅通过避让区计算安全间距，不绘制假导航条，也不永久隐藏系统手势。
// 所有窗口调用串行执行，避免进入/退出/切换主题时旧异步结果后到。
import { common } from '@kit.AbilityKit';
import { display, window } from '@kit.ArkUI';

export interface ReaderWindowInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export type ReaderWindowInsetsListener = (insets: ReaderWindowInsets) => void;

const TRANSPARENT = '#00000000';
const DARK_CONTENT = '#FFFFFFFF';
const LIGHT_CONTENT = '#FF000000';
// 书架固定深色背景。退出阅读页时先把系统栏恢复成同一颜色，
// 再取消全屏布局，避免返回书架时闪出白色系统栏。
const SHELF_BAR_COLOR = '#FF101114';

class ReaderWindowAppearanceService {
  private mainWindow: window.Window | null = null;
  private abilityContext: common.UIAbilityContext | null = null;
  private insetsListener: ReaderWindowInsetsListener | null = null;
  private avoidAreaCallback: ((options: window.AvoidAreaOptions) => void) | null = null;
  private avoidAreaWindow: window.Window | null = null;
  private readerActive: boolean = false;
  private darkTheme: boolean = true;
  private operations: Promise<void> = Promise.resolve();

  enter(context: common.UIAbilityContext, dark: boolean,
    listener: ReaderWindowInsetsListener): void {
    this.abilityContext = context;
    this.darkTheme = dark;
    this.insetsListener = listener;
    this.readerActive = true;
    this.enqueue(async (): Promise<void> => {
      if (!this.readerActive) return;
      const win = await this.obtainWindow(context);
      if (win === null || !this.readerActive) return;
      // 全屏前先量一次，让阅读页在布局扩展到系统栏之前就拿到安全间距。
      this.publishInsets(win);
      await this.setFullScreen(win, true);
      if (!this.readerActive) return;
      await this.applySystemBars(win, this.readerBarProperties());
      this.attachAvoidAreaListener(win);
      this.publishInsets(win);
      // 全屏布局落定后再量一次，覆盖部分设备异步更新避让区的情况。
      setTimeout((): void => {
        if (this.readerActive && this.mainWindow === win) {
          this.publishInsets(win);
        }
      }, 120);
    });
  }

  setDarkTheme(dark: boolean): void {
    this.darkTheme = dark;
    if (!this.readerActive) return;
    this.enqueue(async (): Promise<void> => {
      if (!this.readerActive) return;
      const win = await this.obtainWindow(null);
      if (win === null || !this.readerActive) return;
      await this.applySystemBars(win, this.readerBarProperties());
    });
  }

  refreshInsets(): void {
    if (!this.readerActive || this.mainWindow === null) return;
    this.publishInsets(this.mainWindow);
  }

  exitReader(): Promise<void> {
    this.readerActive = false;
    this.insetsListener = null;
    this.detachAvoidAreaListener();
    return this.enqueue(async (): Promise<void> => {
      if (this.readerActive) return;
      const win = await this.obtainWindow(null);
      if (win === null) return;
      await this.restoreShelfAppearance(win);
    });
  }

  restoreShelf(context: common.UIAbilityContext): Promise<void> {
    this.readerActive = false;
    this.insetsListener = null;
    this.detachAvoidAreaListener();
    this.abilityContext = context;
    return this.enqueue(async (): Promise<void> => {
      if (this.readerActive) return;
      const win = await this.obtainWindow(context);
      if (win === null) return;
      await this.restoreShelfAppearance(win);
    });
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const next: Promise<void> = this.operations.then(action)
      .catch((error: Error): void => {
        console.error('ReaderWindowAppearance: ' + error.message);
      });
    this.operations = next;
    return next;
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
      console.error('ReaderWindowAppearance: getLastWindow failed');
      this.mainWindow = null;
    }
    return this.mainWindow;
  }

  private async setFullScreen(win: window.Window, enabled: boolean):
    Promise<void> {
    try {
      await win.setWindowLayoutFullScreen(enabled);
    } catch (error) {
      console.error('ReaderWindowAppearance: setWindowLayoutFullScreen failed');
    }
  }

  private async applySystemBars(win: window.Window,
    properties: window.SystemBarProperties): Promise<void> {
    try {
      await win.setWindowSystemBarProperties(properties);
    } catch (error) {
      console.error('ReaderWindowAppearance: setWindowSystemBarProperties failed');
    }
  }

  private readerBarProperties(): window.SystemBarProperties {
    // 深色阅读背景配浅色系统图标，浅色背景配深色图标；
    // 系统栏本身全透明，由阅读页同一背景延伸到状态栏和手势条后方。
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

  private shelfBarProperties(): window.SystemBarProperties {
    return {
      statusBarColor: SHELF_BAR_COLOR,
      navigationBarColor: SHELF_BAR_COLOR,
      isStatusBarLightIcon: true,
      isNavigationBarLightIcon: true,
      statusBarContentColor: DARK_CONTENT,
      navigationBarContentColor: DARK_CONTENT,
      enableStatusBarAnimation: false,
      enableNavigationBarAnimation: false
    };
  }

  private async restoreShelfAppearance(win: window.Window): Promise<void> {
    const properties = this.shelfBarProperties();
    // 先换成书架颜色，再撤掉全屏布局；最后再写一次，保证个别
    // 设备在退出全屏时重置系统栏属性也不会闪白。
    await this.applySystemBars(win, properties);
    await this.setFullScreen(win, false);
    await this.applySystemBars(win, properties);
  }

  private attachAvoidAreaListener(win: window.Window): void {
    if (this.avoidAreaWindow === win && this.avoidAreaCallback !== null) {
      return;
    }
    this.detachAvoidAreaListener();
    const callback = (options: window.AvoidAreaOptions): void => {
      if (!this.readerActive || this.mainWindow !== win) return;
      // 任一系统避让区变化都重新读取全部类型，折叠/旋转/三键导航
      // 切换时不会沿用旧的状态栏或手势条高度。
      this.publishInsets(win);
    };
    try {
      win.on('avoidAreaChange', callback);
      this.avoidAreaWindow = win;
      this.avoidAreaCallback = callback;
    } catch (error) {
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
      // 窗口已销毁时无需再解绑。
    }
  }

  private publishInsets(win: window.Window): void {
    const listener = this.insetsListener;
    if (listener === null) return;
    const insets = this.readInsets(win);
    listener(insets);
  }

  private readInsets(win: window.Window): ReaderWindowInsets {
    const system = this.safeAvoidArea(win, window.AvoidAreaType.TYPE_SYSTEM);
    const cutout = this.safeAvoidArea(win, window.AvoidAreaType.TYPE_CUTOUT);
    const indicator = this.safeAvoidArea(win, window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR);
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
    if (area === null) return 0;
    return area.topRect.height;
  }

  private bottomEdge(area: window.AvoidArea | null): number {
    if (area === null) return 0;
    return area.bottomRect.height;
  }

  private leftEdge(area: window.AvoidArea | null): number {
    if (area === null) return 0;
    return area.leftRect.width;
  }

  private rightEdge(area: window.AvoidArea | null): number {
    if (area === null) return 0;
    return area.rightRect.width;
  }

  private pxToVp(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0;
    try {
      const density = display.getDefaultDisplaySync().densityPixels;
      if (Number.isFinite(density) && density > 0) {
        return value / density;
      }
    } catch (error) {
      // 预览器等环境取不到屏幕密度时退回 px 数值。
    }
    return value;
  }
}

const readerWindowAppearance: ReaderWindowAppearanceService =
  new ReaderWindowAppearanceService();

export function enterReaderWindow(context: common.UIAbilityContext,
  dark: boolean, listener: ReaderWindowInsetsListener): void {
  readerWindowAppearance.enter(context, dark, listener);
}

export function setReaderWindowTheme(dark: boolean): void {
  readerWindowAppearance.setDarkTheme(dark);
}

export function refreshReaderWindowInsets(): void {
  readerWindowAppearance.refreshInsets();
}

export function exitReaderWindow(): Promise<void> {
  return readerWindowAppearance.exitReader();
}

export function restoreShelfWindow(context: common.UIAbilityContext):
  Promise<void> {
  return readerWindowAppearance.restoreShelf(context);
}
