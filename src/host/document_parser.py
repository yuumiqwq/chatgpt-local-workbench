#!/usr/bin/env python3
"""Extract readable text from common course documents without an agent.

Python 3.10+, standard library for text, Office Open XML, and legacy Word .doc.
PDF uses an installed PyMuPDF or pypdf package; image-only PDFs need OCR.
Results are plain Markdown for reading/search, not a faithful layout conversion.
"""
from __future__ import annotations

import argparse
import csv
import html
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import struct
import sys
from xml.etree import ElementTree as ET
import zipfile

MAX_INPUT_BYTES = 128 * 1024 * 1024
MAX_XML_BYTES = 64 * 1024 * 1024
OLE_MAGIC = bytes.fromhex("d0cf11e0a1b11ae1")
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PK = "{http://schemas.openxmlformats.org/package/2006/relationships}"


class ExtractionError(ValueError):
    """Cannot accurately extract this source with available tools."""


def u16(buf: bytes, pos: int) -> int:
    return struct.unpack_from("<H", buf, pos)[0]


def u32(buf: bytes, pos: int) -> int:
    return struct.unpack_from("<I", buf, pos)[0]


def clean(text: str) -> str:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", normalized).strip()


def read_text_file(path: Path) -> str:
    data = path.read_bytes()
    for enc in ("utf-8-sig", "utf-16", "gb18030"):
        try:
            s = data.decode(enc)
            if s.startswith("\ufeff"):
                s = s[1:]
            return s
        except UnicodeError:
            pass
    return data.decode("utf-8", "replace")


def xml_member(archive: zipfile.ZipFile, name: str) -> ET.Element:
    try:
        info = archive.getinfo(name)
    except KeyError as error:
        raise ExtractionError("ZIP 文档缺少必要内容：" + name) from error
    if info.file_size > MAX_XML_BYTES:
        raise ExtractionError("XML 部件体积过大：" + name)
    return ET.fromstring(archive.read(info))


def xml_optional(archive: zipfile.ZipFile, name: str) -> ET.Element | None:
    if name not in archive.namelist():
        return None
    return xml_member(archive, name)


def rich_text(element: ET.Element, namespace: str = A) -> str:
    parts: list[str] = []
    for item in element.iter():
        if item.tag in (namespace + "t", W + "t"):
            parts.append(item.text or "")
        elif item.tag in (namespace + "tab", W + "tab"):
            parts.append("\t")
        elif item.tag in (namespace + "br", W + "br"):
            parts.append("\n")
        elif item.tag in (W + "drawing", W + "pict", P + "pic"):
            parts.append(" [图片] ")
    return "".join(parts).strip()


def word_paragraph(p: ET.Element) -> str:
    t = rich_text(p, W)
    if not t:
        return ""
    props = p.find(W + "pPr")
    style = props.find(W + "pStyle") if props is not None else None
    level = 0
    if style is not None:
        name = style.get(W + "val", "")
        match = re.search(r"(?:Heading|heading|标题)([1-6])$", name)
        if match:
            level = int(match.group(1))
    return ("#" * level + " " if level else "") + t


def word_table(tbl: ET.Element) -> list[str]:
    lines = []
    for row in tbl.findall(W + "tr"):
        cells = []
        for cell in row.findall(W + "tc"):
            contents: list[str] = []
            for child in cell:
                if child.tag == W + "p":
                    value = word_paragraph(child)
                    if value:
                        contents.append(value.replace("\n", " "))
                elif child.tag == W + "tbl":
                    contents.extend(word_table(child))
            cells.append(" / ".join(contents).replace("|", r"\|"))
        if cells:
            lines.append("| " + " | ".join(cells) + " |")
    return lines


def extract_docx(path: Path) -> tuple[str, dict]:
    with zipfile.ZipFile(path) as z:
        root = xml_member(z, "word/document.xml")
        body = root.find(W + "body")
        if body is None:
            raise ExtractionError("DOCX 缺少正文")
        lines = []
        for el in body:
            if el.tag == W + "p":
                text = word_paragraph(el)
                if text:
                    lines.append(text)
            elif el.tag == W + "tbl":
                lines.extend(word_table(el))
                lines.append("")
        for name in sorted(z.namelist()):
            if re.fullmatch(r"word/(?:header\d+|footer\d+|footnotes|endnotes)\.xml", name):
                part = xml_member(z, name)
                extra = [word_paragraph(p) for p in part.iter(W + "p")]
                extra = [p for p in extra if p]
                if extra:
                    lines.extend(["", "## 附属内容：" + name, *extra])
        return clean("\n".join(lines)), {"format": "docx", "warnings": ["图片仅标示位置，复杂绘图与版面未还原"]}


class CompoundFile:
    """Read unencrypted OLE compound streams, including the mini stream."""

    END = 0xFFFFFFFA

    def __init__(self, data: bytes):
        if data[:8] != OLE_MAGIC:
            raise ExtractionError("不是有效的旧版 Office 复合文件")
        self.data = data
        self.sector_size = 1 << u16(data, 30)
        self.mini_size = 1 << u16(data, 32)
        if self.sector_size not in (512, 4096) or self.mini_size != 64:
            raise ExtractionError("不支持的 OLE 扇区规格")
        ids = list(struct.unpack_from("<109I", data, 76))
        current = u32(data, 68)
        seen = set()
        for _ in range(u32(data, 72)):
            if current >= self.END or current in seen:
                raise ExtractionError("OLE DIFAT 链损坏")
            seen.add(current)
            numbers = struct.unpack("<" + "I" * (self.sector_size // 4), self.sector(current))
            ids.extend(numbers[:-1])
            current = numbers[-1]
        self.fat = []
        for sid in ids:
            if sid < self.END:
                self.fat.extend(struct.unpack("<" + "I" * (self.sector_size // 4), self.sector(sid)))
        directory = self.chain(u32(data, 48))
        self.entries = {}
        root = None
        for offset in range(0, len(directory), 128):
            entry = directory[offset:offset + 128]
            if len(entry) < 128:
                continue
            name_length = u16(entry, 64)
            if name_length < 2 or name_length > 64:
                continue
            name = entry[:name_length - 2].decode("utf-16le", "replace")
            info = (u32(entry, 116), struct.unpack_from("<Q", entry, 120)[0])
            if entry[66] == 5:
                root = info
            elif entry[66] == 2:
                self.entries[name] = info
        if root is None:
            raise ExtractionError("OLE 缺少根目录")
        self.mini = self.chain(root[0])[:root[1]]
        mcount = u32(data, 64)
        minifat = self.chain(u32(data, 60)) if mcount else b""
        self.mfat = list(struct.unpack("<" + "I" * (len(minifat) // 4), minifat))

    def sector(self, index: int) -> bytes:
        offset = (index + 1) * self.sector_size
        result = self.data[offset:offset + self.sector_size]
        if index >= self.END or len(result) != self.sector_size:
            raise ExtractionError("OLE 扇区索引越界")
        return result

    def chain(self, first: int, mini: bool = False) -> bytes:
        fat = self.mfat if mini else self.fat
        buf = []
        seen = set()
        current = first
        total = 0
        while current < self.END:
            if current in seen or current >= len(fat):
                raise ExtractionError("OLE FAT 链损坏")
            seen.add(current)
            chunk = (self.mini[current * self.mini_size:(current + 1) * self.mini_size]
                     if mini else self.sector(current))
            buf.append(chunk)
            total += len(chunk)
            current = fat[current]
            if total > MAX_INPUT_BYTES * 2:
                raise ExtractionError("OLE 流超出安全读取范围")
        return b"".join(buf)

    def stream(self, name: str) -> bytes:
        try:
            start, length = self.entries[name]
        except KeyError as error:
            raise ExtractionError("OLE 缺少数据流：" + name) from error
        return self.chain(start, length < 4096)[:length]


def extract_doc(path: Path) -> tuple[str, dict]:
    ole = CompoundFile(path.read_bytes())
    word = ole.stream("WordDocument")
    flags = u16(word, 10)
    if flags & 0x0100:
        raise ExtractionError("加密的 Word 文档需要先解密")
    table = ole.stream("1Table" if flags & 0x0200 else "0Table")
    pos = 34 + 2 * u16(word, 32)
    count = u16(word, pos)
    pos += 2
    words = struct.unpack_from("<" + "I" * count, word, pos)
    pos += count * 4
    pair_count = u16(word, pos)
    pos += 2
    if pair_count <= 33:
        raise ExtractionError("Word 文件缺少 CLX 片段表")
    clx_pos, clx_len = struct.unpack_from("<II", word, pos + 33 * 8)
    clx = table[clx_pos:clx_pos + clx_len]
    p = 0
    while p < len(clx) and clx[p] == 1:
        p += 3 + u16(clx, p + 1)
    if p >= len(clx) or clx[p] != 2:
        raise ExtractionError("无法解析 Word 文本片段表")
    plc_len = u32(clx, p + 1)
    plc = clx[p + 5:p + 5 + plc_len]
    if (len(plc) - 4) % 12:
        raise ExtractionError("Word 文本片段表长度异常")
    n = (len(plc) - 4) // 12
    cps = struct.unpack_from("<" + "I" * (n + 1), plc)
    pieces = []
    for i in range(n):
        raw = u32(plc, 4 * (n + 1) + 8 * i + 2)
        count = cps[i + 1] - cps[i]
        if count < 0:
            raise ExtractionError("Word 文本片段索引错误")
        if raw & 0x40000000:
            offset = (raw & 0x3FFFFFFF) // 2
            part = word[offset:offset + count].decode("cp1252", "replace")
        else:
            offset = raw & 0x3FFFFFFF
            part = word[offset:offset + 2 * count].decode("utf-16le", "replace")
        pieces.append(part)
    text = "".join(pieces)
    # FIB rgLw: main story + footnotes, headers, comments etc. Preserve order.
    section_names = ("正文", "脚注", "页眉页脚", "宏", "批注", "尾注", "文本框", "页眉文本框")
    lengths = list(words[3:11])
    sections = []
    start = 0
    for name, count in zip(section_names, lengths):
        part = text[start:start + count]
        start += count
        if not part.strip():
            continue
        for src, dst in (("\x07", " | "), ("\x01", " [图片] "),
                         ("\x08", " [图形] "), ("\x0b", "\n"),
                         ("\x0c", "\n\n[分页]\n\n"),
                         ("\x13", ""), ("\x14", ""), ("\x15", "")):
            part = part.replace(src, dst)
        para = [x.strip() for x in part.split("\r") if x.strip()]
        if para:
            if name != "正文":
                sections.append("## " + name)
            sections.extend(para)
    return clean("\n".join(sections)), {
        "format": "doc",
        "warnings": ["旧版 Word 仅提取文字，图片位置以标记提示；复杂表格、公式和布局需核对原件"]
    }


def slide_order(z: zipfile.ZipFile) -> list[str]:
    root = xml_optional(z, "ppt/presentation.xml")
    rels = xml_optional(z, "ppt/_rels/presentation.xml.rels")
    if root is not None and rels is not None:
        mapping = {r.get("Id"): r.get("Target", "") for r in rels}
        order = []
        for el in root.iter(P + "sldId"):
            target = mapping.get(el.get(R + "id"))
            if target:
                name = "ppt/" + target.lstrip("/").removeprefix("ppt/")
                if name in z.namelist():
                    order.append(name)
        if order:
            return order
    slides = [x for x in z.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", x)]
    return sorted(slides, key=lambda p: int(re.search(r"slide(\d+)", p).group(1)))


def extract_pptx(path: Path) -> tuple[str, dict]:
    lines = []
    with zipfile.ZipFile(path) as z:
        slides = slide_order(z)
        for i, name in enumerate(slides, 1):
            root = xml_member(z, name)
            lines.append("## 幻灯片 " + str(i))
            for p in root.iter(A + "p"):
                txt = rich_text(p, A)
                if txt:
                    lines.append(txt)
            # Speaker notes are stored separately and do not represent on-slide text.
            note = name.replace("slides/slide", "notesSlides/notesSlide")
            if note in z.namelist():
                note_text = [rich_text(p, A) for p in xml_member(z, note).iter(A + "p")]
                if any(note_text):
                    lines.append("讲者备注：" + " ".join(x for x in note_text if x))
            lines.append("")
    return clean("\n".join(lines)), {"format": "pptx", "slides": len(slides),
                                      "warnings": ["图表、图片、动画和公式需核对原幻灯片"]}


def extract_xlsx(path: Path) -> tuple[str, dict]:
    with zipfile.ZipFile(path) as z:
        workbook = xml_member(z, "xl/workbook.xml")
        rels = xml_member(z, "xl/_rels/workbook.xml.rels")
        targets = {r.get("Id"): r.get("Target", "") for r in rels}
        shared = []
        strings = xml_optional(z, "xl/sharedStrings.xml")
        if strings is not None:
            for item in strings.findall(S + "si"):
                shared.append("".join((x.text or "") for x in item.iter(S + "t")))
        sheets = []
        for sh in workbook.iter(S + "sheet"):
            target = targets.get(sh.get(R + "id"), "")
            if not target:
                continue
            name = ("xl/" + target.lstrip("/").removeprefix("xl/")).replace("\\", "/")
            if name not in z.namelist():
                continue
            root = xml_member(z, name)
            lines = ["## 工作表：" + sh.get("name", "未命名")]
            for row in root.iter(S + "row"):
                cells = []
                for cell in row.findall(S + "c"):
                    formula = cell.find(S + "f")
                    value = cell.find(S + "v")
                    raw = value.text if value is not None and value.text is not None else ""
                    kind = cell.get("t")
                    if kind == "s" and raw:
                        raw = shared[int(raw)]
                    elif kind == "inlineStr":
                        raw = "".join(x.text or "" for x in cell.iter(S + "t"))
                    elif kind == "b":
                        raw = "TRUE" if raw == "1" else "FALSE"
                    if formula is not None and formula.text:
                        raw = "=" + formula.text + (" [缓存值：" + raw + "]" if raw else "")
                    if raw:
                        cells.append(cell.get("r", "?") + "=" + str(raw).replace("\n", " "))
                if cells:
                    lines.append(" | ".join(cells))
            sheets.extend(lines + [""])
    return clean("\n".join(sheets)), {"format": "xlsx",
                                    "warnings": ["公式保留表达式及已有缓存值；日期序列号、图表和样式未还原"]}


def extract_pdf(path: Path) -> tuple[str, dict]:
    pages = []
    backend = None
    try:
        import pymupdf
        backend = "PyMuPDF"
        with pymupdf.open(path) as pdf:
            for i, page in enumerate(pdf, 1):
                pages.append("## PDF 第 " + str(i) + " 页\n" + page.get_text(sort=True))
    except ImportError:
        try:
            from pypdf import PdfReader
            backend = "pypdf"
            reader = PdfReader(str(path))
            for i, page in enumerate(reader.pages, 1):
                pages.append("## PDF 第 " + str(i) + " 页\n" + (page.extract_text() or ""))
        except ImportError as error:
            raise ExtractionError("PDF 文本提取需要安装 PyMuPDF 或 pypdf；扫描件建议使用现有 MinerU 流程") from error
    result = clean("\n\n".join(pages))
    extracted = len(re.sub(r"## PDF 第 \d+ 页", "", result).strip())
    warnings = ["仅提取 PDF 文字；图片、图形及公式应回查原页"]
    if extracted < len(pages) * 10:
        warnings.append("可提取文字很少，可能是扫描件，建议使用 MinerU/OCR")
    return result, {"format": "pdf", "pages": len(pages), "backend": backend, "warnings": warnings}


class HTMLText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.output = []
        self.hidden = 0

    def handle_starttag(self, tag: str, attrs: list):
        if tag in ("script", "style"):
            self.hidden += 1
        if tag in ("p", "div", "br", "li", "tr", "h1", "h2", "h3"):
            self.output.append("\n")

    def handle_endtag(self, tag: str):
        if tag in ("script", "style"):
            self.hidden = max(0, self.hidden - 1)
        if tag in ("p", "div", "li", "tr"):
            self.output.append("\n")

    def handle_data(self, data: str):
        if not self.hidden:
            self.output.append(data)


def extract(path: Path) -> tuple[str, dict]:
    ext = path.suffix.lower()
    if ext == ".doc":
        return extract_doc(path)
    if ext == ".docx":
        return extract_docx(path)
    if ext == ".pptx":
        return extract_pptx(path)
    if ext in (".xlsx", ".xlsm"):
        return extract_xlsx(path)
    if ext == ".pdf":
        return extract_pdf(path)
    if ext in (".txt", ".md", ".json", ".xml", ".yaml", ".yml", ".tex", ".log", ".py", ".csv", ".tsv"):
        data = read_text_file(path)
        if ext in (".csv", ".tsv"):
            delim = "\t" if ext == ".tsv" else ","
            lines = [" | ".join(row) for row in csv.reader(data.splitlines(), delimiter=delim)]
            data = "\n".join(lines)
        return clean(data), {"format": ext.lstrip("."), "warnings": []}
    if ext in (".html", ".htm"):
        parser = HTMLText()
        parser.feed(read_text_file(path))
        data = "\n".join(x.strip() for x in "".join(parser.output).splitlines() if x.strip())
        return clean(html.unescape(data)), {"format": "html", "warnings": []}
    if ext in (".ppt", ".xls"):
        raise ExtractionError("旧版 " + ext + " 需要专用格式转换器；建议先转换为 PPTX/XLSX 并保留原件")
    raise ExtractionError("暂不支持的文件格式：" + ext)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path, help="原始文档路径")
    parser.add_argument("--output", type=Path, help="输出 Markdown 路径；默认放在源文件旁的 codex-generated/parsed/")
    parser.add_argument("--stdout", action="store_true", help="只输出提取文字，不写入文件")
    parser.add_argument("--json", action="store_true", help="以 JSON 返回分页文字和元数据，不写入文件")
    parser.add_argument("--offset", type=int, default=0, help="JSON 模式中跳过的 Unicode 字符数")
    parser.add_argument("--max-chars", type=int, default=12000, help="JSON 模式中单页 Unicode 字符数")
    parser.add_argument("--preview", type=int, default=0, help="额外在命令输出中展示前 N 个文字")
    args = parser.parse_args(argv)
    path = args.file.expanduser().resolve()
    try:
        if not path.is_file():
            raise ExtractionError("源文件不存在：" + str(path))
        if path.stat().st_size > MAX_INPUT_BYTES:
            raise ExtractionError("源文件超出解析上限 128 MiB，建议分割处理")
        body, meta = extract(path)
        if not body:
            meta.setdefault("warnings", []).append("未提取到可阅读文本，请核对原件是否主要由图片构成")
        if args.json:
            if args.offset < 0 or not 1 <= args.max_chars <= 40000:
                raise ExtractionError("offset 需要非负且 max-chars 应在 1 到 40000 之间")
            page = body[args.offset:args.offset + args.max_chars]
            next_offset = args.offset + len(page)
            print(json.dumps({
                "path": str(path), "format": meta["format"], "total_chars": len(body),
                "offset": args.offset, "content": page,
                "next_offset": next_offset if next_offset < len(body) else None,
                "warnings": meta.get("warnings", [])
            }, ensure_ascii=True))
            return 0
        if args.stdout:
            print(body)
            return 0
        output = args.output or path.parent / "codex-generated" / "parsed" / (path.name + ".md")
        output = output.resolve()
        if output == path:
            raise ExtractionError("输出文件不能覆盖原始文档")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(body + "\n", encoding="utf-8")
        print(json.dumps({"source": str(path), "output": str(output),
                          "characters": len(body), **meta}, ensure_ascii=True))
        if args.preview > 0:
            print("\n" + body[:args.preview])
        return 0
    except (ExtractionError, OSError, ET.ParseError, zipfile.BadZipFile,
            struct.error, UnicodeError, IndexError, KeyError) as error:
        print("文档解析失败：" + str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
