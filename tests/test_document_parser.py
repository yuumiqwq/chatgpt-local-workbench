"""Regression tests for the dependency-free course document extractor."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest
import zipfile
import sys


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src" / "host"))
from document_parser import (extract, ExtractionError, extract_doc,
                                     extract_docx, extract_pptx, extract_xlsx, main)


def build_minimal_doc(text: str) -> bytes:
    """Build a small valid CFB Word binary with one UTF-16 piece for tests."""
    sector = 512
    word = bytearray(4608)
    table = bytearray(4608)
    utf16 = text.encode("utf-16le")
    char_count = len(utf16) // 2
    offset = 512
    word[offset:offset + len(utf16)] = utf16
    struct.pack_into("<H", word, 2, 0x00D9)
    struct.pack_into("<H", word, 10, 0)
    struct.pack_into("<H", word, 32, 0)
    struct.pack_into("<H", word, 34, 12)
    lw = [0] * 12
    lw[3] = char_count
    struct.pack_into("<12I", word, 36, *lw)
    struct.pack_into("<H", word, 84, 34)
    # fcClx and lcbClx in 34th FC/LCB pair (index 33)
    plc = struct.pack("<II", 0, char_count) + b"\0\0" + struct.pack("<I", offset) + b"\0\0"
    clx = b"\x02" + struct.pack("<I", len(plc)) + plc
    table[:len(clx)] = clx
    struct.pack_into("<II", word, 86 + 33 * 8, 0, len(clx))
    header = bytearray(512)
    header[:8] = bytes.fromhex("d0cf11e0a1b11ae1")
    struct.pack_into("<H", header, 24, 0x003E)
    struct.pack_into("<H", header, 26, 3)
    struct.pack_into("<H", header, 28, 0xFFFE)
    struct.pack_into("<H", header, 30, 9)
    struct.pack_into("<H", header, 32, 6)
    struct.pack_into("<I", header, 44, 1)
    struct.pack_into("<I", header, 48, 18)
    struct.pack_into("<I", header, 56, 4096)
    struct.pack_into("<I", header, 60, 0xFFFFFFFE)
    struct.pack_into("<I", header, 68, 0xFFFFFFFE)
    struct.pack_into("<109I", header, 76, 19, *([0xFFFFFFFF] * 108))

    def entry(name: str, kind: int, first: int, length: int) -> bytes:
        raw = bytearray(128)
        encoded = (name + "\0").encode("utf-16le")
        raw[:len(encoded)] = encoded
        struct.pack_into("<H", raw, 64, len(encoded))
        raw[66] = kind
        struct.pack_into("<III", raw, 68, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF)
        struct.pack_into("<I", raw, 116, first)
        struct.pack_into("<Q", raw, 120, length)
        return bytes(raw)

    directory = bytearray(512)
    directory[:128] = entry("Root Entry", 5, 0xFFFFFFFE, 0)
    directory[128:256] = entry("WordDocument", 2, 0, len(word))
    directory[256:384] = entry("0Table", 2, 9, len(table))
    fat = [0xFFFFFFFF] * 128
    for first in (0, 9):
        for i in range(first, first + 8):
            fat[i] = i + 1
        fat[first + 8] = 0xFFFFFFFE
    fat[18] = 0xFFFFFFFE
    fat[19] = 0xFFFFFFFD
    return bytes(header) + bytes(word) + bytes(table) + bytes(directory) + struct.pack("<128I", *fat)


class TestDocumentExtraction(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)

    def file(self, name, content):
        p = self.base / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(content)
        return p

    def zipfile(self, name, members):
        p = self.base / name
        with zipfile.ZipFile(p, "w") as z:
            for member, body in members.items():
                z.writestr(member, body)
        return p

    def test_legacy_doc_unicode_and_paragraphs(self):
        path = self.file("old.doc", build_minimal_doc("实验目标\r中文正文\r第二段"))
        text, meta = extract_doc(path)
        self.assertIn("实验目标\n中文正文\n第二段", text)
        self.assertEqual(meta["format"], "doc")

    def test_docx_tables_and_headers(self):
        path = self.zipfile("a.docx", {
            "word/document.xml": (
                '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                '<w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'
                '<w:r><w:t>实验报告</w:t></w:r></w:p>'
                '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:tc>'
                '<w:tc><w:p><w:r><w:t>乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
                '</w:body></w:document>'),
            "word/header1.xml": (
                '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                '<w:p><w:r><w:t>页眉文字</w:t></w:r></w:p></w:hdr>')
        })
        text, _ = extract_docx(path)
        self.assertIn("# 实验报告", text)
        self.assertIn("| 甲 | 乙 |", text)
        self.assertIn("页眉文字", text)

    def test_pptx_numeric_slide_sort(self):
        prefix = '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>{}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
        path = self.zipfile("a.pptx", {
            "ppt/slides/slide10.xml": prefix.format("第十页"),
            "ppt/slides/slide2.xml": prefix.format("第二页")
        })
        text, meta = extract_pptx(path)
        self.assertLess(text.index("第二页"), text.index("第十页"))
        self.assertEqual(meta["slides"], 2)

    def test_xlsx_formulas_and_shared_strings(self):
        path = self.zipfile("a.xlsx", {
            "xl/workbook.xml": (
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
                ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                '<sheets><sheet name="成绩" r:id="rId1"/></sheets></workbook>'),
            "xl/_rels/workbook.xml.rels": (
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
            "xl/sharedStrings.xml": (
                '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                '<si><t>姓名</t></si></sst>'),
            "xl/worksheets/sheet1.xml": (
                '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c>'
                '<c r="B1"><f>1+2</f><v>3</v></c></row></sheetData></worksheet>')
        })
        text, _ = extract_xlsx(path)
        self.assertIn("工作表：成绩", text)
        self.assertIn("A1=姓名", text)
        self.assertIn("B1==1+2 [缓存值：3]", text)

    def test_default_output_uses_codex_generated(self):
        p = self.file("notes.txt", "文字段落".encode("utf-8"))
        self.assertEqual(main([str(p)]), 0)
        out = self.base / "codex-generated" / "parsed" / "notes.txt.md"
        self.assertEqual(out.read_text(encoding="utf-8"), "文字段落\n")
        self.assertTrue(p.exists())

    def test_unknown_type(self):
        p = self.file("unsafe.xyz", b"unsupported")
        with self.assertRaises(ExtractionError):
            extract(p)

    def test_csv_and_gb18030(self):
        p = self.file("a.csv", "姓名,成绩\n小王,99".encode("gb18030"))
        result, _ = extract(p)
        self.assertIn("小王 | 99", result)


if __name__ == "__main__":
    unittest.main()
