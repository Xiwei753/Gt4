// SPDX-License-Identifier: GPL-3.0-only
// 无 DRM EPUB 导入：ZIP → container.xml → OPF → spine 顺序章节。
// 清理 XHTML 为纯文本；保留章节标题。
// 明确拒绝：加密/DRM EPUB、ZIP 路径穿越、超过上限的大包。
import { ZipReader } from './ZipReader';

// ZipReader 以构造函数 + prototype 实现（保持纯 JS，便于测试直接跑），
// 所以它本身是值而非类型；这里声明实例的形状供本文件标注。
interface ZipReaderInstance {
  parseCentralDirectory(): void;
  has(name: string): boolean;
  names(): string[];
  read(name: string): Uint8Array;
  readText(name: string): string;
}

export interface EpubChapter {
  title: string;
  text: string;
}

export interface EpubResult {
  title: string;
  chapters: EpubChapter[];
}

const MAX_EPUB_BYTES = 128 * 1024 * 1024;
const MAX_ZIP_OUTPUT = 64 * 1024 * 1024;

function matchAll(text: string, regex: RegExp): RegExpMatchArray[] {
  const out: RegExpMatchArray[] = [];
  let m = regex.exec(text);
  while (m !== null) {
    out.push(m);
    m = regex.exec(text);
  }
  return out;
}

function attrValue(tag: string, name: string): string {
  const re = new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i');
  const m = re.exec(tag);
  if (!m) return '';
  return m[2] !== undefined ? m[2] : m[3];
}

function unescapeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) =>
      String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// XHTML → 阅读文本：去 style/script，块级标签转换行，去内联标签。
export function xhtmlToText(xhtml: string): string {
  let t = xhtml;
  t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<\/(p|div|h[1-6]|li|tr|section|chapter)>/gi, '\n');
  t = t.replace(/<[^>]+>/g, '');
  t = unescapeEntities(t);
  t = t.replace(/[ \t]+/g, ' ');
  t = t.replace(/\n[ \t]*/g, '\n');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

function hrefJoin(base: string, href: string): string {
  if (href.startsWith('/')) return href.substring(1);
  const parts = base.split('/');
  parts.pop();
  const segs = href.split('/');
  for (const seg of segs) {
    if (seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

function findContainerRoot(zip: ZipReaderInstance): string {
  const xml = zip.readText('META-INF/container.xml');
  const m = /<rootfile[^>]+full-path\s*=\s*"([^"]+)"/i.exec(xml) ||
    /<rootfile[^>]+full-path\s*=\s*'([^']+)'/i.exec(xml);
  if (!m) throw new Error('EPUB: container.xml 缺少 rootfile');
  return m[1];
}

function hasDrm(zip: ZipReaderInstance): boolean {
  for (const name of zip.names()) {
    const lower = name.toLowerCase();
    if (lower.includes('encryption') || lower.includes('rights') ||
        lower.includes('.adept') || lower.includes('license')) {
      // 仅 META-INF 下的加密描述视为 DRM 迹象。
      if (lower.startsWith('meta-inf/')) return true;
    }
  }
  return false;
}

export function importEpub(bytes: Uint8Array): EpubResult {
  if (bytes.length > MAX_EPUB_BYTES) {
    throw new Error('EPUB 超过大小上限（' + MAX_EPUB_BYTES + ' 字节）');
  }
  const zip = new ZipReader(bytes, MAX_ZIP_OUTPUT);
  if (hasDrm(zip)) {
    throw new Error('EPUB 带加密/DRM，素阅只支持无 DRM 书籍');
  }
  const opfPath = findContainerRoot(zip);
  const opf = zip.readText(opfPath);

  const titleMatch = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf);
  const title = titleMatch ? unescapeEntities(titleMatch[1]).trim() :
    '未命名书籍';

  // manifest: id → href；spine: itemref order → id
  const manifest = new Map<string, string>();
  for (const m of matchAll(opf, /<item\s[^>]*>/gi)) {
    const tag = m[0];
    const id = attrValue(tag, 'id');
    const href = attrValue(tag, 'href');
    const media = attrValue(tag, 'media-type');
    if (id && href &&
        (media.includes('xhtml') || media.includes('html') ||
         media === 'text/xml' || media === 'application/xml')) {
      manifest.set(id, hrefJoin(opfPath, decodeURIComponent(href)));
    }
  }
  const spineIds: string[] = [];
  for (const m of matchAll(opf, /<itemref[^>]*>/gi)) {
    const idref = attrValue(m[0], 'idref');
    if (idref) spineIds.push(idref);
  }
  if (spineIds.length === 0) {
    throw new Error('EPUB: OPF spine 为空');
  }

  // 章节标题：优先 nav/NCX toc，缺省用文件名。
  const titles = chapterTitlesFromNav(zip, opfPath, manifest);

  const chapters: EpubChapter[] = [];
  for (const id of spineIds) {
    const path = manifest.get(id);
    if (!path || !zip.has(path)) continue;
    const raw = zip.readText(path);
    const text = xhtmlToText(raw);
    if (text.length === 0) continue;
    chapters.push({ title: titles.get(path) || basename(path), text });
  }
  if (chapters.length === 0) {
    throw new Error('EPUB: 未解析到任何章节正文');
  }
  return { title, chapters };
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1];
}

// 从 NCX（EPUB2）提取章节标题（尽力而为，缺省用文件名）。
function chapterTitlesFromNav(zip: ZipReaderInstance, opfPath: string,
  _manifest: Map<string, string>): Map<string, string> {
  const titles = new Map<string, string>();
  const opf = zip.readText(opfPath);
  // EPUB2: NCX 在 manifest 中 media-type 为 application/x-dtbncx+xml
  let ncxPath = '';
  for (const m of matchAll(opf, /<item\s[^>]*>/gi)) {
    const tag = m[0];
    if (attrValue(tag, 'media-type').includes('dtbncx')) {
      ncxPath = hrefJoin(opfPath,
        decodeURIComponent(attrValue(tag, 'href')));
    }
  }
  if (!ncxPath || !zip.has(ncxPath)) return titles;
  const navText = zip.readText(ncxPath);
  // navPoint: navLabel > text + content src
  const points = /<navPoint[\s\S]*?<\/navPoint>/gi;
  let pm = points.exec(navText);
  while (pm !== null) {
    const block = pm[0];
    const label = /<text>([\s\S]*?)<\/text>/i.exec(block);
    const src = /<content[^>]+src\s*=\s*"([^"]+)"/i.exec(block);
    if (label && src) {
      titles.set(
        hrefJoin(ncxPath, decodeURIComponent(src[1])),
        unescapeEntities(label[1]).trim());
    }
    pm = points.exec(navText);
  }
  return titles;
}
