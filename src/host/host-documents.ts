import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { HostError, HostPolicy } from "./host-policy.js";
import { fileDigest, HostFiles } from "./host-files.js";
import { extractPdfTextPage } from "./pdf-text.js";

const execFileAsync = promisify(execFile);
const DOCUMENT_BYTES_LIMIT = 128 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const PARSER_TIMEOUT_MS = 30_000;

// This shipped parser is fixed by the Workbench installation. The caller
// supplies only a validated, read-authorized document path and page offsets.
const parser = fileURLToPath(new URL("./document_parser.py", import.meta.url));

export interface DocumentPage {
  path: string;
  format: string;
  total_chars: number;
  offset: number;
  content: string;
  next_offset: number | null;
  warnings: string[];
}

export async function readHostDocument(
  policy: HostPolicy,
  pathValue: string,
  offset = 0,
  maxChars = 12_000,
  signal?: AbortSignal
): Promise<DocumentPage> {
  if (!Number.isInteger(offset) || offset < 0 ||
      !Number.isInteger(maxChars) || maxChars < 1 || maxChars > 40_000) {
    throw new HostError("HOST_INVALID_ARGUMENT", "Use a nonnegative character offset and max_chars from 1 to 40000.");
  }
  const path = await policy.check(pathValue, "read");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) {
    throw new HostError("HOST_FILE_UNSUPPORTED", "A regular file without additional hard links is required.");
  }
  if (info.size > DOCUMENT_BYTES_LIMIT) {
    throw new HostError("HOST_FILE_TOO_LARGE", "The document exceeds the 128 MiB extraction limit.");
  }
  signal?.throwIfAborted();
  if (extname(path).toLowerCase() === ".pdf") {
    return extractPdfTextPage(path, offset, maxChars, signal);
  }

  const interpreter = process.platform === "win32" ? "py" : "python3";
  const arguments_ = [
    ...(process.platform === "win32" ? ["-3"] : []),
    "-B", "-X", "utf8", parser, path, "--json",
    "--offset", String(offset), "--max-chars", String(maxChars)
  ];
  let stdout: string;
  try {
    const result = await execFileAsync(interpreter, arguments_, {
      encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES,
      timeout: PARSER_TIMEOUT_MS, windowsHide: true, signal
    });
    stdout = result.stdout;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new HostError("HOST_DOCUMENT_RUNTIME_UNAVAILABLE",
        "Python 3.10+ is required for document extraction on this Workbench host.");
    }
    if (code === "ETIMEDOUT") {
      throw new HostError("HOST_DOCUMENT_TIMEOUT", "Document extraction exceeded 30 seconds.");
    }
    if (signal?.aborted) throw new HostError("HOST_DOCUMENT_CANCELLED", "Document extraction was cancelled.");
    throw new HostError("HOST_DOCUMENT_PARSE_FAILED",
      "Document extraction failed. Check that this file is a supported, readable document.");
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new HostError("HOST_DOCUMENT_PARSE_FAILED", "The document parser did not return valid JSON.");
  }
  if (!value || typeof value !== "object") {
    throw new HostError("HOST_DOCUMENT_PARSE_FAILED", "Invalid parser result.");
  }
  const page = value as Partial<DocumentPage>;
  if (page.path !== path || typeof page.format !== "string" ||
      !Number.isInteger(page.total_chars) || page.offset !== offset ||
      typeof page.content !== "string" || Array.from(page.content).length > maxChars ||
      !(page.next_offset === null || typeof page.next_offset === "number") ||
      !Array.isArray(page.warnings) || !page.warnings.every(x => typeof x === "string")) {
    throw new HostError("HOST_DOCUMENT_PARSE_FAILED", "Invalid document page metadata.");
  }
  return page as DocumentPage;
}

const AUTO_DOCUMENT_EXTENSIONS = new Set([
  ".doc", ".docx", ".pdf", ".ppt", ".pptx", ".xls", ".xlsx", ".xlsm", ".html", ".htm"
]);

export type ReadHostFileMode = "auto" | "raw";

/**
 * One public read path: normal UTF-8 files keep byte-based streaming while
 * documents are extracted into paginated character-based text. Explicit raw
 * mode or base64 retains the original byte-level behavior.
 */
export async function readHostFileSmart(
  files: HostFiles,
  policy: HostPolicy,
  options: {
    path: string;
    offset?: number;
    max_bytes?: number;
    max_chars?: number;
    encoding?: "utf8" | "base64";
    include_sha256?: boolean;
    mode?: ReadHostFileMode;
  },
  signal?: AbortSignal
) {
  const { path, offset = 0, max_bytes = 65_536, max_chars = 12_000,
    encoding = "utf8", include_sha256 = false, mode = "auto" } = options;
  if (mode === "raw" || encoding === "base64" ||
      !AUTO_DOCUMENT_EXTENSIONS.has(extname(path).toLowerCase())) {
    return files.read(path, offset, max_bytes, encoding, include_sha256);
  }
  // Parsed pages use Unicode character offsets. Raw UTF-8 pages use byte
  // offsets; these are explicitly differentiated by the response metadata.
  const page = await readHostDocument(policy, path, offset, max_chars, signal);
  const size = (await lstat(page.path)).size;
  const sha256 = include_sha256 ? await fileDigest(page.path) : undefined;
  return {
    ...page, size,
    encoding: "utf8" as const,
    offset_unit: "characters" as const,
    ...(sha256 === undefined ? {} : { sha256 }),
    truncated: page.next_offset !== null,
    next_offset: page.next_offset ?? page.total_chars,
    characters_read: Array.from(page.content).length
  };
}
