// SPDX-License-Identifier: GPL-3.0-only
// 无 DRM EPUB 导入：ZIP → container.xml → OPF → spine 顺序章节。
// 清理 XHTML 为纯文本；保留章节标题。
// 明确拒绝：加密/DRM EPUB、ZIP 路径穿越、超过上限的大包。
// 逻辑与 harmony/.../EpubImportService.ets 对齐。
package com.xiwei.suyue.importer

object EpubImportService {

    data class EpubChapter(val title: String, val text: String)

    data class EpubResult(val title: String, val chapters: List<EpubChapter>)

    private const val MAX_EPUB_BYTES = 128L * 1024 * 1024
    private const val MAX_ZIP_OUTPUT = 64L * 1024 * 1024

    private val TITLE_RE = Regex("""<dc:title[^>]*>([\s\S]*?)</dc:title>""", RegexOption.IGNORE_CASE)
    private val ITEM_RE = Regex("""<item\s[^>]*>""", RegexOption.IGNORE_CASE)
    private val ITEMREF_RE = Regex("""<itemref[^>]*>""", RegexOption.IGNORE_CASE)
    private val ROOTFILE_DQ = Regex("<rootfile[^>]+full-path\\s*=\\s*\"([^\"]+)\"", RegexOption.IGNORE_CASE)
    private val ROOTFILE_SQ = Regex("<rootfile[^>]+full-path\\s*=\\s*'([^']+)'", RegexOption.IGNORE_CASE)
    private val CONTENT_SRC_DQ = Regex("<content[^>]+src\\s*=\\s*\"([^\"]+)\"", RegexOption.IGNORE_CASE)
    private val CONTENT_SRC_SQ = Regex("<content[^>]+src\\s*=\\s*'([^']+)'", RegexOption.IGNORE_CASE)
    private val NAVPOINT_RE = Regex("""<navPoint[\s\S]*?</navPoint>""", RegexOption.IGNORE_CASE)
    private val NAVTEXT_RE = Regex("""<text>([\s\S]*?)</text>""", RegexOption.IGNORE_CASE)

    fun importEpub(bytes: ByteArray): EpubResult {
        if (bytes.size > MAX_EPUB_BYTES) {
            throw IllegalStateException("EPUB 超过大小上限（$MAX_EPUB_BYTES 字节）")
        }
        val zip = ZipReader(bytes, MAX_ZIP_OUTPUT)
        if (hasDrm(zip)) {
            throw IllegalStateException("EPUB 带加密/DRM，素阅只支持无 DRM 书籍")
        }
        val opfPath = findContainerRoot(zip)
        val opf = zip.readText(opfPath)

        val titleMatch = TITLE_RE.find(opf)
        val title = titleMatch?.groupValues?.get(1)
            ?.let { unescapeEntities(it).trim() }
            ?.takeIf { it.isNotEmpty() } ?: "未命名书籍"

        // manifest: id → href；spine: itemref order → id
        val manifest = LinkedHashMap<String, String>()
        for (m in ITEM_RE.findAll(opf)) {
            val tag = m.value
            val id = attrValue(tag, "id")
            val href = attrValue(tag, "href")
            val media = attrValue(tag, "media-type")
            if (id.isNotEmpty() && href.isNotEmpty() &&
                (media.contains("xhtml") || media.contains("html") ||
                    media == "text/xml" || media == "application/xml")
            ) {
                manifest[id] = hrefJoin(opfPath, decodeUriComponent(href))
            }
        }
        val spineIds = ArrayList<String>()
        for (m in ITEMREF_RE.findAll(opf)) {
            val idref = attrValue(m.value, "idref")
            if (idref.isNotEmpty()) spineIds.add(idref)
        }
        if (spineIds.isEmpty()) throw IllegalStateException("EPUB: OPF spine 为空")

        // 章节标题：优先 NCX toc，缺省用文件名。
        val titles = chapterTitlesFromNav(zip, opfPath)

        val chapters = ArrayList<EpubChapter>()
        for (id in spineIds) {
            val path = manifest[id] ?: continue
            if (!zip.has(path)) continue
            val text = xhtmlToText(zip.readText(path))
            if (text.isEmpty()) continue
            chapters.add(EpubChapter(titles[path] ?: basename(path), text))
        }
        if (chapters.isEmpty()) throw IllegalStateException("EPUB: 未解析到任何章节正文")
        return EpubResult(title, chapters)
    }

    private fun attrValue(tag: String, name: String): String {
        val re = Regex(name + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)')", RegexOption.IGNORE_CASE)
        val m = re.find(tag) ?: return ""
        return if (m.groupValues[2].isNotEmpty()) m.groupValues[2] else m.groupValues[3]
    }

    private fun unescapeEntities(text: String): String {
        var t = Regex("""&#x([0-9a-fA-F]+);""").replace(text) { m ->
            safeCodePoint(m.groupValues[1].toInt(16), m.value)
        }
        t = Regex("""&#(\d+);""").replace(t) { m ->
            safeCodePoint(m.groupValues[1].toIntOrNull() ?: -1, m.value)
        }
        t = t.replace("&lt;", "<").replace("&gt;", ">")
            .replace("&quot;", "\"").replace("&apos;", "'")
            .replace("&amp;", "&")
        return t
    }

    private fun safeCodePoint(code: Int, original: String): String {
        return if (code in 0..0x10FFFF && !(code in 0xD800..0xDFFF)) {
            String(Character.toChars(code))
        } else {
            original
        }
    }

    // XHTML → 阅读文本：去 style/script，块级标签转换行，去内联标签。
    fun xhtmlToText(xhtml: String): String {
        var t = xhtml
        t = Regex("""<style[\s\S]*?</style>""", RegexOption.IGNORE_CASE).replace(t, " ")
        t = Regex("""<script[\s\S]*?</script>""", RegexOption.IGNORE_CASE).replace(t, " ")
        t = Regex("""<br\s*/?>""", RegexOption.IGNORE_CASE).replace(t, "\n")
        t = Regex("""</(p|div|h[1-6]|li|tr|section|chapter)>""", RegexOption.IGNORE_CASE).replace(t, "\n")
        t = Regex("""<[^>]+>""").replace(t, "")
        t = unescapeEntities(t)
        t = Regex("""[ \t]+""").replace(t, " ")
        t = Regex("""\n[ \t]*""").replace(t, "\n")
        t = Regex("""\n{3,}""").replace(t, "\n\n")
        return t.trim()
    }

    private fun hrefJoin(base: String, href: String): String {
        if (href.startsWith("/")) return href.substring(1)
        val parts = ArrayList(base.split("/"))
        if (parts.isNotEmpty()) parts.removeAt(parts.size - 1)
        for (seg in href.split("/")) {
            when (seg) {
                ".", "" -> { /* 跳过 */ }
                ".." -> if (parts.isNotEmpty()) parts.removeAt(parts.size - 1)
                else -> parts.add(seg)
            }
        }
        return parts.joinToString("/")
    }

    private fun findContainerRoot(zip: ZipReader): String {
        val xml = zip.readText("META-INF/container.xml")
        val m = ROOTFILE_DQ.find(xml) ?: ROOTFILE_SQ.find(xml)
        if (m == null) throw IllegalStateException("EPUB: container.xml 缺少 rootfile")
        return m.groupValues[1]
    }

    private fun hasDrm(zip: ZipReader): Boolean {
        for (name in zip.names()) {
            val lower = name.lowercase()
            if (lower.contains("encryption") || lower.contains("rights") ||
                lower.contains(".adept") || lower.contains("license")
            ) {
                // 仅 META-INF 下的加密描述视为 DRM 迹象。
                if (lower.startsWith("meta-inf/")) return true
            }
        }
        return false
    }

    private fun basename(path: String): String {
        val parts = path.split("/")
        return parts.lastOrNull() ?: path
    }

    // 从 NCX（EPUB2）提取章节标题（尽力而为，缺省用文件名）。
    private fun chapterTitlesFromNav(zip: ZipReader, opfPath: String): Map<String, String> {
        val titles = HashMap<String, String>()
        val opf = zip.readText(opfPath)
        var ncxPath = ""
        for (m in ITEM_RE.findAll(opf)) {
            if (attrValue(m.value, "media-type").contains("dtbncx")) {
                ncxPath = hrefJoin(opfPath, decodeUriComponent(attrValue(m.value, "href")))
            }
        }
        if (ncxPath.isEmpty() || !zip.has(ncxPath)) return titles
        val navText = zip.readText(ncxPath)
        for (pm in NAVPOINT_RE.findAll(navText)) {
            val block = pm.value
            val label = NAVTEXT_RE.find(block) ?: continue
            val src = CONTENT_SRC_DQ.find(block) ?: CONTENT_SRC_SQ.find(block) ?: continue
            titles[hrefJoin(ncxPath, decodeUriComponent(src.groupValues[1]))] =
                unescapeEntities(label.groupValues[1]).trim()
        }
        return titles
    }

    // 仅解码百分号转义，不把 '+' 当作空格。
    private fun decodeUriComponent(s: String): String {
        return try {
            java.net.URLDecoder.decode(s.replace("+", "%2B"), "UTF-8")
        } catch (e: Exception) {
            s
        }
    }
}
