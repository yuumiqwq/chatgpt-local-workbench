import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readHostDocument, readHostFileSmart } from "../../../src/host/host-documents.js";
import { HostFiles } from "../../../src/host/host-files.js";
import { HostError, HostPolicy } from "../../../src/host/host-policy.js";

const hasPython = (() => {
  try {
    execFileSync(process.platform === "win32" ? "py" : "python3",
      process.platform === "win32" ? ["-3", "--version"] : ["--version"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
})();

test("Workbench document extraction is read-only, paginated and path constrained", { skip: !hasPython }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "workbench-document-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const allowed = join(dir, "allowed"), outside = join(dir, "outside");
  await Promise.all([mkdir(allowed), mkdir(outside)]);
  const policyPath = join(dir, "host-policy.json");
  await writeFile(policyPath, JSON.stringify({
    version: 1, enabled: true, read_roots: [allowed], write_roots: [],
    command_roots: [], commands_enabled: false, codex_homes: []
  }));
  const policy = await HostPolicy.load(policyPath);
  const filename = join(allowed, "课程 笔记.txt");
  const text = "第一章：云计算技术的使用。\n第二章：实践操作。";
  await writeFile(filename, text, "utf8");
  const first = await readHostDocument(policy, filename, 0, 10);
  assert.equal(first.path, filename);
  assert.equal(first.content, text.slice(0, 10));
  assert.equal(first.next_offset, 10);
  assert.equal(first.total_chars, text.length);
  const second = await readHostDocument(policy, filename, first.next_offset!, 40000);
  assert.equal(first.content + second.content, text);
  assert.equal(second.next_offset, null);
  assert.deepEqual((await readdir(allowed)), ["课程 笔记.txt"]);
  const deniedFile = join(outside, "blocked.txt");
  await writeFile(deniedFile, "secret");
  await assert.rejects(() => readHostDocument(policy, deniedFile),
    (e: unknown) => e instanceof HostError && e.code === "HOST_PATH_DENIED");
  await assert.rejects(() => readHostDocument(policy, filename, -1),
    (e: unknown) => e instanceof HostError && e.code === "HOST_INVALID_ARGUMENT");
});

test("Workbench parser supports common Office documents without enabling host commands", { skip: !hasPython }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "workbench-document-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "settings.json");
  await writeFile(path, JSON.stringify({
    version: 1, enabled: true, read_roots: [dir], write_roots: [],
    command_roots: [], commands_enabled: false, codex_homes: []
  }));
  const policy = await HostPolicy.load(path);
  const csv = join(dir, "数据.csv");
  await writeFile(csv, "姓名,分数\n小明,100", "utf8");
  const page = await readHostDocument(policy, csv);
  assert.equal(page.format, "csv");
  assert.match(page.content, /小明 \| 100/u);
});

function minimalPdf(label: string): Buffer {
  const payload = `BT\n/F1 16 Tf\n60 200 Td\n(${label}) Tj\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(payload)} >>\nstream\n${payload}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(output));
    output += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const pos of offsets.slice(1)) {
    output += String(pos).padStart(10, "0") + " 00000 n \n";
  }
  output += `trailer\n<< /Root 1 0 R /Size ${offsets.length} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, "ascii");
}

test("PDF text is extracted directly without Python and preserves page pagination", async t => {
  const dir = await mkdtemp(join(tmpdir(), "workbench-pdf-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const policyFile = join(dir, "policy.json");
  await writeFile(policyFile, JSON.stringify({
    version: 1, enabled: true, read_roots: [dir], write_roots: [],
    command_roots: [], commands_enabled: false, codex_homes: []
  }));
  const path = join(dir, "test.pdf");
  await writeFile(path, minimalPdf("Workbench PDF text"));
  const policy = await HostPolicy.load(policyFile);
  const first = await readHostDocument(policy, path, 0, 17);
  assert.ok("format" in first);
  assert.equal(first.format, "pdf");
  assert.equal(first.offset, 0);
  assert.equal(first.content.length, 17);
  assert.equal(first.next_offset, 17);
  const second = await readHostDocument(policy, path, first.next_offset!, 40000);
  assert.match(first.content + second.content, /Workbench PDF text/u);
  assert.match(first.content + second.content, /PDF 第 1 页/u);
  assert.equal(second.next_offset, null);
  assert.deepEqual((await readdir(dir)).sort(), ["policy.json", "test.pdf"]);
});

test("PDF parser signals image-only pages without making up text", async t => {
  const dir = await mkdtemp(join(tmpdir(), "workbench-pdf-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "policy.json"), JSON.stringify({
    version: 1, enabled: true, read_roots: [dir], write_roots: [],
    command_roots: [], commands_enabled: false, codex_homes: []
  }));
  const path = join(dir, "blank.pdf");
  await writeFile(path, minimalPdf(""));
  const page = await readHostDocument(await HostPolicy.load(join(dir, "policy.json")), path);
  assert.equal(page.format, "pdf");
  assert.ok(page.warnings.some(message => message.includes("OCR")));
});

test("one file reader defaults to raw text and parsed PDF, with raw binary opt-in", async t => {
  const dir = await mkdtemp(join(tmpdir(), "workbench-unified-read-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const policyFile = join(dir, "policy.json");
  await writeFile(policyFile, JSON.stringify({
    version: 1, enabled: true, read_roots: [dir], write_roots: [],
    command_roots: [], commands_enabled: false, codex_homes: []
  }));
  const policy = await HostPolicy.load(policyFile);
  const files = new HostFiles(policy);

  const md = join(dir, "学习记录.md");
  const text = "# 第一章\n普通 Markdown 文本";
  await writeFile(md, text);
  const plain = await readHostFileSmart(files, policy, { path: md, max_bytes: 15 });
  assert.equal(plain.encoding, "utf8");
  assert.equal(plain.content, "# 第一章\n普");
  assert.equal(plain.next_offset, Buffer.byteLength(plain.content, "utf8"));
  assert.equal(plain.truncated, true);
  assert.equal("offset_unit" in plain, false);
  const remainder = await readHostFileSmart(files, policy,
    { path: md, offset: plain.next_offset, max_bytes: 80 });
  assert.equal(plain.content + remainder.content, text);

  const pdfPath = join(dir, "课堂.pdf");
  const pdf = minimalPdf("Cloud PDF readable");
  await writeFile(pdfPath, pdf);
  const first = await readHostFileSmart(files, policy,
    { path: pdfPath, max_chars: 14, include_sha256: true });
  assert.ok("format" in first);
  assert.equal(first.format, "pdf");
  assert.ok("offset_unit" in first);
  assert.equal(first.offset_unit, "characters");
  assert.ok("characters_read" in first);
  assert.equal(first.truncated, true);
  assert.equal(first.characters_read, 14);
  assert.equal(typeof first.sha256, "string");
  const following = await readHostFileSmart(files, policy,
    { path: pdfPath, offset: first.next_offset, max_chars: 40000 });
  assert.match(first.content + following.content, /Cloud PDF readable/u);
  assert.equal(following.truncated, false);
  assert.ok("total_chars" in following);
  assert.equal(following.next_offset, following.total_chars);

  const raw = await readHostFileSmart(files, policy, {
    path: pdfPath, mode: "raw", encoding: "base64", max_bytes: 80
  });
  assert.equal(raw.encoding, "base64");
  assert.deepEqual(Buffer.from(raw.content, "base64"), pdf.subarray(0, 80));
  assert.equal("format" in raw, false);
  const rawShorthand = await readHostFileSmart(files, policy, {
    path: pdfPath, encoding: "base64", max_bytes: 80
  });
  assert.equal(rawShorthand.content, raw.content);
  assert.deepEqual((await readdir(dir)).sort(), ["policy.json", "学习记录.md", "课堂.pdf"].sort());
});
