// SPDX-License-Identifier: GPL-3.0-only
// GT4 阅读设置：字号、行距、主题。唯一分页器是 Canvas takeCanvasPage。
export var DEFAULT_SETTINGS = {
  fontSize: 20,
  lineHeightRatio: 1.55,
  theme: 'night'
};

export var MIN_FONT_SIZE = 14;
export var MAX_FONT_SIZE = 32;
export var MIN_LINE_RATIO = 1.3;
export var MAX_LINE_RATIO = 2.0;

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
