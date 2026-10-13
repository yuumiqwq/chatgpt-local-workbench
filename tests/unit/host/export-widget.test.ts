import assert from "node:assert/strict";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { EXPORT_WIDGET_HTML } from "../../../src/host/export-widget.js";
import { ExportSha256 } from "../../../src/host/export-sha256.js";

const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
interface Element {
  textContent: string; hidden: boolean; disabled: boolean; href?: string;
  download?: string; value: number; max: number;
  onclick?: () => Promise<void> | void;
  removeAttribute(name: string): void;
}

function widget(bytes: Buffer, overrides: Record<string, unknown> = {}, runtime: Record<string, unknown> = {}) {
  const elements: Record<string, Element> = {};
  for (const id of ["prepare", "pause", "download", "progress", "filename"]) {
    elements[id] = { textContent: "", hidden: false, disabled: true, value: 0, max: 1,
      removeAttribute() { delete this.href; } };
  }
  const meta = { export_id: "c51e18b3-fedd-41e6-9bfc-41d0a98b4272", filename: "中文 实验资料.docx",
    size: bytes.length, sha256: digest(bytes), mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    chunk_bytes: 65536 };
  const offsets: number[] = [], uploads: File[] = [], localFiles: Blob[] = [];
  let state: unknown;
  const api = {
    toolOutput: meta,
    async callTool(name: string, args: { export_id: string; offset: number; max_bytes: number }) {
      assert.equal(name, "read_export_chunk");
      assert.equal(args.export_id, meta.export_id);
      offsets.push(args.offset);
      const data = bytes.subarray(args.offset, args.offset + args.max_bytes);
      return { structuredContent: { export_id: meta.export_id, size: bytes.length, sha256: meta.sha256,
        offset: args.offset, encoding: "base64", content: data.toString("base64"), chunk_sha256: digest(data),
        bytes_read: data.length, next_offset: args.offset + data.length, eof: args.offset + data.length === bytes.length } };
    },
    async uploadFile(file: File) { uploads.push(file); return { fileId: "authorized-test-file" }; },
    async getFileDownloadUrl(args: { fileId: string }) {
      assert.equal(args.fileId, "authorized-test-file");
      return { downloadUrl: "https://download.example.test/authorized-file" };
    },
    setWidgetState(value: unknown) { state = value; }, ...overrides
  };
  class WidgetURL extends URL {
    static override createObjectURL(blob: Blob) { localFiles.push(blob); return "blob:local-test"; }
    static override revokeObjectURL() {}
  }
  const script = EXPORT_WIDGET_HTML.match(/<script>([\s\S]*)<\/script>/u)![1]!;
  runInNewContext(script, { window: { openai: api, addEventListener() {} },
    document: { getElementById: (id: string) => elements[id] },
    crypto: webcrypto, Blob, File, URL: WidgetURL, Uint8Array, atob, setTimeout, clearTimeout, AbortController, ...runtime });
  return { elements, meta, api, offsets, uploads, localFiles, state: () => state };
}

test("widget waits for a gesture, verifies binary DOCX bytes and uses real host-provided file IDs", async () => {
  const bytes = randomBytes(65536 * 2 + 17);
  const f = widget(bytes);
  assert.equal(f.offsets.length, 0);
  assert.equal(f.uploads.length, 0);
  assert.equal(f.elements.filename!.textContent, f.meta.filename);
  await f.elements.prepare!.onclick!();
  assert.deepEqual(f.offsets, [0, 65536, 131072]);
  assert.equal(f.uploads.length, 1);
  assert.equal(f.uploads[0]!.name, f.meta.filename);
  assert.equal(f.uploads[0]!.type, f.meta.mime_type);
  assert.deepEqual(Buffer.from(await f.uploads[0]!.arrayBuffer()), bytes);
  assert.equal(f.elements.download!.href, "https://download.example.test/authorized-file");
  assert.equal(f.elements.download!.hidden, false);
  assert.equal(f.localFiles.length, 0);
  assert.match(JSON.stringify(f.state()), /authorized-test-file/u);
});

test("incremental widget SHA-256 matches native hashing across padding and chunk boundaries", () => {
  for (const length of [0, 1, 55, 56, 63, 64, 65, 127, 128, 129, 524289]) {
    const bytes = randomBytes(length);
    for (const chunk of [1, 17, 64, 65537]) {
      const hash = new ExportSha256();
      for (let offset = 0; offset < length; offset += chunk) hash.update(bytes.subarray(offset, offset + chunk));
      assert.equal(hash.digest(), digest(bytes), `${length}/${chunk}`);
      assert.equal(hash.digest(), digest(bytes));
    }
  }
});

test("widget receives above 128 MiB in 512 KiB chunks without hashing a whole-file ArrayBuffer", { timeout: 120_000 }, async () => {
  const bytes = Buffer.alloc(128 * 1024 * 1024 + 17, 0x5a);
  const f = widget(bytes, {}, { crypto: { subtle: {
    digest: (algorithm: string, data: Uint8Array) => {
      assert.ok(data.byteLength <= 524288);
      return webcrypto.subtle.digest(algorithm, data);
    }
  } } });
  f.meta.chunk_bytes = 524288;
  await f.elements.prepare!.onclick!();
  assert.equal(f.uploads.length, 1);
  assert.equal(f.uploads[0]!.size, bytes.length);
  const hash = createHash("sha256");
  for await (const part of f.uploads[0]!.stream()) hash.update(part);
  assert.equal(hash.digest("hex"), digest(bytes));
  assert.equal(f.offsets.length, Math.ceil(bytes.length / 524288));
});

test("widget accepts 512000000-byte metadata, rejects one more byte and pauses a pending upload", async () => {
  const metadata = { export_id: "large", filename: "large.zip", size: 512_000_000, sha256: digest(Buffer.alloc(0)), chunk_bytes: 524288 };
  const accepted = widget(Buffer.alloc(0), { toolOutput: metadata });
  assert.equal(accepted.elements.prepare!.disabled, false);
  const rejected = widget(Buffer.alloc(0), { toolOutput: { ...metadata, size: 512_000_001 } });
  assert.equal(rejected.elements.prepare!.disabled, true);
  const f = widget(Buffer.alloc(0), { uploadFile: () => new Promise(() => {}) });
  const waiting = f.elements.prepare!.onclick!();
  await new Promise(resolve => setTimeout(resolve, 0));
  await f.elements.pause!.onclick!();
  await waiting;
  assert.equal(f.elements.prepare!.textContent, "继续下载");
  assert.equal(f.elements.prepare!.disabled, false);
});

test("widget resumes at the unacknowledged offset after a lost chunk response", async () => {
  const bytes = randomBytes(65537);
  const f = widget(bytes);
  const original = f.api.callTool;
  let failed = false;
  f.api.callTool = async (name, args) => {
    const result = await original(name, args);
    if (args.offset > 0 && !failed) { failed = true; throw new Error("interrupted"); }
    return result;
  };
  await f.elements.prepare!.onclick!();
  assert.equal(f.uploads.length, 0);
  assert.equal(f.elements.prepare!.textContent, "重试下载");
  await f.elements.prepare!.onclick!();
  assert.deepEqual(f.offsets, [0, 65536, 65536]);
  assert.deepEqual(Buffer.from(await f.uploads[0]!.arrayBuffer()), bytes);
});

test("widget rejects corrupted chunks and a mismatched whole-file digest before upload", async () => {
  for (const validChunkHash of [false, true]) {
    const f = widget(Buffer.from("original"));
    const original = f.api.callTool;
    f.api.callTool = async (name, args) => {
      const result = await original(name, args);
      result.structuredContent.content = Buffer.from("modified").toString("base64");
      if (validChunkHash) result.structuredContent.chunk_sha256 = digest(Buffer.from("modified"));
      return result;
    };
    await f.elements.prepare!.onclick!();
    assert.equal(f.uploads.length, 0);
    assert.equal(f.localFiles.length, 0);
    assert.equal(f.elements.download!.hidden, true);
    assert.equal(f.elements.prepare!.textContent, "重试下载");
  }
});

test("widget falls back to a verified Blob when host uploads are unavailable or rejected", async () => {
  for (const override of [{ uploadFile: undefined }, { uploadFile: async () => { throw new Error("not supported"); } },
    { getFileDownloadUrl: async () => ({ downloadUrl: "http://localhost/private" }) }]) {
    const bytes = randomBytes(71);
    const f = widget(bytes, override);
    await f.elements.prepare!.onclick!();
    assert.equal(f.elements.download!.href, "blob:local-test");
    assert.equal(f.elements.download!.textContent, "保存到设备");
    assert.deepEqual(Buffer.from(await f.localFiles[0]!.arrayBuffer()), bytes);
  }
});

test("pausing an in-flight widget transfer does not upload and resumes with the same chunk", async () => {
  const f = widget(randomBytes(13));
  const original = f.api.callTool;
  let first = true;
  f.api.callTool = async (name, args) => {
    const result = await original(name, args);
    if (first) { first = false; await f.elements.pause!.onclick!(); }
    return result;
  };
  await f.elements.prepare!.onclick!();
  assert.equal(f.uploads.length, 0);
  assert.equal(f.elements.prepare!.textContent, "继续下载");
  await f.elements.prepare!.onclick!();
  assert.deepEqual(f.offsets, [0, 0]);
  assert.equal(f.uploads.length, 1);
});

test("empty files are verified and uploaded without issuing an empty chunk loop", async () => {
  const f = widget(Buffer.alloc(0));
  await f.elements.prepare!.onclick!();
  assert.equal(f.offsets.length, 0);
  assert.equal(f.uploads[0]!.size, 0);
});
