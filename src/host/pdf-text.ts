import { readFile } from "node:fs/promises";
import { HostError } from "./host-policy.js";
import type { DocumentPage } from "./host-documents.js";

const MAX_PAGES = 1000;
const MAX_TEXT_CHARS = 5_000_000;
const MAX_PARSE_MS = 30_000;

export async function extractPdfTextPage(
  path: string, offset: number, maxChars: number, signal?: AbortSignal
): Promise<DocumentPage> {
  signal?.throwIfAborted();
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const bytes = await readFile(path);
  signal?.throwIfAborted();

  // Supplying bytes prevents external document fetches. Reading page text does not
  // execute PDF scripting or launch a browser.
  const task = getDocument({
    data: new Uint8Array(bytes),
    enableXfa: false, useSystemFonts: true, disableFontFace: true, verbosity: 0
  });
  const deadline = Date.now() + MAX_PARSE_MS;
  let pages = 0;
  let text = "";
  let extractedCharacters = 0;
  try {
    const pdf = await task.promise;
    pages = pdf.numPages;
    if (pages > MAX_PAGES) {
      throw new HostError("HOST_DOCUMENT_TOO_MANY_PAGES", "PDF exceeds the 1000-page extraction limit.");
    }
    for (let pageNum = 1; pageNum <= pages; pageNum++) {
      signal?.throwIfAborted();
      if (Date.now() > deadline) {
        throw new HostError("HOST_DOCUMENT_TIMEOUT", "PDF extraction exceeded 30 seconds.");
      }
      const page = await pdf.getPage(pageNum);
      const extracted = await page.getTextContent();
      let pageText = "";
      for (const item of extracted.items) {
        if (!("str" in item)) continue;
        pageText += item.str;
        pageText += item.hasEOL ? "\n" : " ";
      }
      // PDF text items often split Chinese words without a visible gap.
      pageText = pageText.replace(/([\p{Script=Han}]) +(?=[\p{Script=Han}])/gu, "$1");
      extractedCharacters += Array.from(pageText.replace(/\s+/gu, "")).length;
      text += `## PDF 第 ${pageNum} 页\n${pageText.trimEnd()}\n\n`;
      if (text.length > MAX_TEXT_CHARS) {
        throw new HostError("HOST_DOCUMENT_TEXT_TOO_LARGE", "PDF text exceeds the supported extraction size.");
      }
      page.cleanup();
    }
  } catch (error) {
    if (error instanceof HostError) throw error;
    if (signal?.aborted) throw new HostError("HOST_DOCUMENT_CANCELLED", "PDF extraction was cancelled.");
    throw new HostError("HOST_DOCUMENT_PARSE_FAILED", "Could not extract text from this PDF.");
  } finally {
    await task.destroy().catch(() => {});
  }
  const complete = text.trimEnd();
  const chars = Array.from(complete);
  const content = chars.slice(offset, offset + maxChars).join("");
  const next = offset + Array.from(content).length;
  const warnings = ["PDF 提取了文字内容；图形、图片、版式和复杂公式请对照原页面。"];
  if (extractedCharacters < pages * 60) {
    warnings.push("PDF 每页可提取文字较少，可能主要是图片或扫描内容，建议结合页面图像、OCR 或 MinerU 核对。");
  }
  return {
    path, format: "pdf", total_chars: chars.length, offset,
    content, next_offset: next < chars.length ? next : null,
    warnings
  };
}
