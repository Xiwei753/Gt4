// SPDX-License-Identifier: GPL-3.0-only
// 手机端阅读进度应用事件：同步服务写入 Preferences 后，
// 已打开的阅读页可据此重绘到新字节位置。纯进程内事件，不持久化。
export type ReadingApplyListener = (bookId: string, offset: number) => void;

const listeners: ReadingApplyListener[] = [];

export function addReadingApplyListener(
  listener: ReadingApplyListener): void {
  if (listeners.indexOf(listener) < 0) {
    listeners.push(listener);
  }
}

export function removeReadingApplyListener(
  listener: ReadingApplyListener): void {
  const index = listeners.indexOf(listener);
  if (index >= 0) listeners.splice(index, 1);
}

export function emitReadingApply(bookId: string, offset: number): void {
  for (let i = 0; i < listeners.length; i++) {
    try {
      listeners[i](bookId, offset);
    } catch (error) {
      // 页面已销毁时忽略。
    }
  }
}
