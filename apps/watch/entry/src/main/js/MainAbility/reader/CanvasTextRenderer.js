// SPDX-License-Identifier: GPL-3.0-only
// GT4 Lite JS FA：唯一 Canvas 绘字器。
// 对照实际支持 GT4 的开源 sportwatch-cacti-hop：fillRect 覆盖旧帧，
// 然后设置 ctx.font 并 fillText；不能将未验证的 clearRect 设为必需。
// 不执行 getImageData、measureText 或定时重试。
export function pageColors(theme) {
  return theme === 'day'
    ? { background: '#f5f4f0', color: '#1c1e22' }
    : { background: '#101114', color: '#f3f3f3' };
}

export function fontString(fontSize) {
  return Math.floor(fontSize) + 'px';
}

// 每页只用 fillRect 覆盖上一页，再以 fillText 绘制各行。
export function drawPage(ctx, viewport, lines, style) {
  if (!ctx) return { ok: false, reason: 'missing_2d_context' };
  // 开源 GT4 Lite 游戏实际只用 fillRect/fillText，不强制 clearRect。
  if (typeof ctx.fillRect !== 'function') {
    return { ok: false, reason: 'missing_fillRect' };
  }
  if (typeof ctx.fillText !== 'function') {
    return { ok: false, reason: 'missing_fillText' };
  }
  const colors = pageColors(style && style.theme);
  const size = (style && style.fontSize) || 20;
  try {
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
