// SPDX-License-Identifier: GPL-3.0-only
// 章节索引分片：Wear Engine P2P 单条消息上限 4096 字节。
// 完整目录能放进 BOOK_META 时保持旧协议；放不下时先发空 chapters +
// chapterChunks，再逐条发送 CHAPTERS。这里只做纯分片计算，JSON 由调用方
// 构造，便于 Node 回归测试真实消息字节数。

export var MAX_MESSAGE_BYTES = 4096;
// 留出余量，避免不同 JSON 序列化器对字段顺序/转义的处理造成越界。
export var TARGET_CHAPTER_BYTES = 3600;
export var CHAPTER_TOO_LARGE = 'E_CHAPTER_TOO_LARGE';

// measure(chunk, index, totalHint) 必须返回该 CHAPTERS 消息的 UTF-8 字节数。
// totalHint 使用 999999：实际分片数不会更多，测出的长度只会偏大。
export function splitChapterChunks(chapters, measure) {
  if (!Array.isArray(chapters) || chapters.length === 0 ||
      typeof measure !== 'function') return [];
  var groups = [];
  var current = [];
  for (var i = 0; i < chapters.length; i++) {
    current.push(chapters[i]);
    var size = measure(current, groups.length, 999999);
    if (size > TARGET_CHAPTER_BYTES && current.length > 1) {
      var last = current.pop();
      groups.push(current);
      current = [last];
    }
  }
  if (current.length > 0) groups.push(current);
  // 单章标题可能来自 EPUB 导航且没有 80 字上限。若它单独一条仍超过
  // 真实消息上限，不能截断标题或发送超限消息，必须让调用方终止传书。
  for (var g = 0; g < groups.length; g++) {
    if (measure(groups[g], g, groups.length) > MAX_MESSAGE_BYTES) {
      throw new Error(CHAPTER_TOO_LARGE);
    }
  }
  return groups;
}
