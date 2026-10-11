// SPDX-License-Identifier: GPL-3.0-only
// 阅读设置：字号、行距、主题。
// 单一真相：分页只依赖（字节偏移、列数、行数）；
// 列数/行数由字号与行距推导，显示层不另算折行。
export var DEFAULT_SETTINGS = {
  fontSize: 20,
  lineHeightRatio: 1.55,
  theme: 'night'
};

export var MIN_FONT_SIZE = 14;
export var MAX_FONT_SIZE = 32;
export var MIN_LINE_RATIO = 1.3;
export var MAX_LINE_RATIO = 2.0;

// 圆屏 466×466：纯文本阅读态不再占用顶栏/底栏，
// 正文区宽 316px、高 330px（与 reader.css 一致）。
export var TEXT_WIDTH = 316;
export var TEXT_HEIGHT = 330;

export function normalizeSettings(raw) {
  var settings = {
    fontSize: DEFAULT_SETTINGS.fontSize,
    lineHeightRatio: DEFAULT_SETTINGS.lineHeightRatio,
    theme: DEFAULT_SETTINGS.theme
  };
  if (!raw || typeof raw !== 'object') return settings;
  var fontSize = Number(raw.fontSize);
  if (isFinite(fontSize)) {
    settings.fontSize = Math.max(MIN_FONT_SIZE,
      Math.min(MAX_FONT_SIZE, Math.floor(fontSize)));
  }
  var ratio = Number(raw.lineHeightRatio);
  if (isFinite(ratio)) {
    settings.lineHeightRatio = Math.max(MIN_LINE_RATIO,
      Math.min(MAX_LINE_RATIO, Math.round(ratio * 100) / 100));
  }
  if (raw.theme === 'day' || raw.theme === 'night') {
    settings.theme = raw.theme;
  }
  return settings;
}

// 列数：按正文字宽与字号估算（CJK 宽度 1.0、
// ASCII 约 0.55）。真实像素宽度待 GT4 真机校准。
export function columnsFor(settings) {
  var fontSize = settings.fontSize;
  return Math.max(8, Math.floor(
    (TEXT_WIDTH - 16) / (fontSize * 0.95)));
}

// 行数：按正文高度与（字号 × 行距）推导。
export function rowsFor(settings) {
  var lineHeight = settings.fontSize *
    settings.lineHeightRatio;
  return Math.max(4, Math.floor(
    (TEXT_HEIGHT - 16) / lineHeight));
}
