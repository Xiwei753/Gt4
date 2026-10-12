// SPDX-License-Identifier: GPL-3.0-only
// GT4 Lite JS FA：唯一 Canvas 绘字器。参考旧版手表 Canvas 游戏的
// onShow -> getContext('2d') -> ctx.font -> fillText 固定坐标路径。
// 不执行 getImageData、measureText 或逐帧监控。
export function pageColors(theme) {
  return theme === 'day'
    ? { background: '#f5f4f0', color: '#1c1e22' }
    : { background: '#101114', color: '#f3f3f3' };
}

export function fontString(fontSize) {
  return Math.floor(fontSize) + 'px HYQiHei-65S';
}

// 每次翻页恰好一次清屏、一次背景填充，每个非空行一次 fillText。
export function drawPage(ctx, viewport, lines, style) {
  if (!ctx || typeof ctx.clearRect !== 'function' ||
      typeof ctx.fillRect !== 'function' ||
      typeof ctx.fillText !== 'function') {
    return { ok: false, reason: 'unsupported_canvas_api' };
  }
  const colors = pageColors(style && style.theme);
  const size = (style && style.fontSize) || 20;
  try {
    ctx.clearRect(0, 0, viewport.width, viewport.height);
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, viewport.width, viewport.height);
    ctx.font = fontString(size);
    ctx.fillStyle = colors.color;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    let drawn = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || !line.text) continue;
      ctx.fillText(line.text, line.x, line.baselineY);
      drawn++;
    }
    return { ok: true, drawn: drawn };
  } catch (e) {
    return { ok: false, reason: 'canvas_draw_failed' };
  }
}
