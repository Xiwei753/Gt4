// SPDX-License-Identifier: GPL-3.0-only
// 圆屏正文绘制器（issue #11）：只负责把排版好的行画到 Canvas 上。
//
// 本模块**不做分页**（分页在 reader/PageLayout.takeCanvasPage），
// 只做：测量函数获取、清屏、按行 fillText。
// 所有 Canvas 调用都包在 try/catch 里：GT4 固件若缺 API 或参数不同，
// 返回结构化失败原因（屏幕上可见），绝不黑屏、不静默假装成功。
//
// 约定：坐标使用画布自身像素坐标（由调用方给出真实 viewport 宽高），
// 不依赖 DOM API / devicePixelRatio / window.innerWidth。

var FONT_FAMILY = 'sans-serif';

// 取真实测量函数：不能用时返回 null（调用方改用估算字宽并提示）。
export function measureWith(ctx) {
  if (!ctx || typeof ctx.measureText !== 'function') return null;
  return function (text) {
    var result;
    try {
      result = ctx.measureText(text);
    } catch (e) {
      return null;
    }
    if (!result || typeof result.width !== 'number' ||
        !isFinite(result.width)) {
      return null;
    }
    return result.width;
  };
}

// 日夜只换背景与字色。
export function pageColors(theme) {
  if (theme === 'day') {
    return { background: '#f5f4f0', color: '#1c1e22' };
  }
  return { background: '#101114', color: '#f3f3f3' };
}

export function fontString(fontSize) {
  return Math.max(1, Math.floor(fontSize)) + 'px ' + FONT_FAMILY;
}

// 只清屏（不画字）：用于画布重建/切主题。
export function clearPage(ctx, viewport, style) {
  if (!ctx || typeof ctx.fillRect !== 'function') {
    return { ok: false, reason: 'no_context' };
  }
  var colors = pageColors(style && style.theme);
  try {
    ctx.clearRect(0, 0, viewport.width, viewport.height);
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, viewport.width, viewport.height);
    return { ok: true, background: colors.background,
      color: colors.color };
  } catch (e) {
    return { ok: false, reason: 'clear_throw' };
  }
}

// 画一页：清屏 + 逐行 fillText（左对齐，从该行安全左边界起笔）。
export function drawPage(ctx, viewport, lines, style) {
  if (!ctx || typeof ctx.fillText !== 'function') {
    return { ok: false, reason: 'no_context' };
  }
  var cleared = clearPage(ctx, viewport, style);
  if (!cleared.ok) return cleared;
  var colors = cleared;
  var size = Math.max(1, Math.floor((style && style.fontSize) || 20));
  var drawn = 0;
  try {
    // 字体/基线/对齐：属性不被支持时同样会抛错→返回明确原因。
    ctx.font = fontString(size);
    ctx.fillStyle = colors.color;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line || !line.text) continue;
      ctx.fillText(line.text, line.x, line.baselineY);
      drawn++;
    }
    return { ok: true, drawn: drawn, background: colors.background,
      color: colors.color, fontSize: size };
  } catch (e) {
    return { ok: false, reason: 'draw_throw' };
  }
}
