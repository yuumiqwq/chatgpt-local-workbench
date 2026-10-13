import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import fs, { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join, parse, resolve, sep } from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { EXPORT_CHUNK_BYTES, EXPORT_MAX_ACTIVE, HostExports } from "../../../src/host/host-exports.js";
import { HostFiles } from "../../../src/host/host-files.js";
import { containsPath, HostError, HostPolicy } from "../../../src/host/host-policy.js";
import { EXPORT_WIDGET_MIME, EXPORT_WIDGET_URI } from "../../../src/host/export-widget.js";

const digest = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const code = (expected: string) => (error: unknown) => error instanceof HostError && error.code === expected;

async function fixture(t: TestContext, overrides: Record<string, unknown> = {}) {
  const parent = resolve("codex-generated", "host-export-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "case-"));
  const allowed = join(root, "allowed"), outside = join(root, "allowed-other");
  await Promise.all([mkdir(allowed), mkdir(outside)]);
  const policyPath = join(allowed, "policy.json");
  const config = { version: 1, enabled: true, read_roots: [root], write_roots: [root],
    export_roots: [allowed], protected_paths: [join(allowed, "protected")], ...overrides };
  const policy = await HostPolicy.create(config, policyPath);
  const exports = new HostExports(policy);
  t.after(async () => {
    exports.dispose();
    assert.ok(containsPath(parent, root) && parent !== root);
    await rm(root, { recursive: true, force: true });
  });
  return { root, allowed, outside, policyPath, config, policy, exports };
}

test("Unicode binary export is immutable, resumable and verified per chunk and as a whole", async t => {
  const f = await fixture(t);
  const path = join(f.allowed, "实验 图片与资料.zip");
  const bytes = randomBytes(EXPORT_CHUNK_BYTES * 2 + 321);
  await writeFile(path, bytes);
  const meta = await f.exports.create(path);
  assert.equal(meta.filename, "实验 图片与资料.zip");
  assert.equal(meta.mime_type, "application/zip");
  assert.equal(meta.size, bytes.length);
  assert.equal(meta.sha256, digest(bytes));
  assert.equal(meta.direct_download, false);
  assert.match(meta.resource_uri, /^bridge-export:\/\//u);
  const first = f.exports.read(meta.export_id, 0, 10001);
  assert.deepEqual(f.exports.read(meta.export_id, 0, 10001), first); // Lost response retry.
  await writeFile(path, "source changed after export");
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const page = f.exports.read(meta.export_id, offset, 10001);
    const part = Buffer.from(page.content, "base64");
    assert.equal(part.length, page.bytes_read);
    assert.equal(digest(part), page.chunk_sha256);
    assert.equal(page.sha256, meta.sha256);
    assert.equal(page.offset, offset);
    parts.push(part);
    offset = page.next_offset;
    if (page.eof) break;
  }
  assert.deepEqual(Buffer.concat(parts), bytes);
  assert.equal(digest(Buffer.concat(parts)), meta.sha256);
  assert.equal(offset, meta.size);
  assert.equal(f.exports.read(meta.export_id, offset).content, "");
  assert.deepEqual(Buffer.from(f.exports.resource(meta.export_id).blob, "base64"), bytes);
  assert.equal(f.exports.release(meta.export_id).released, true);
  assert.equal(f.exports.release(meta.export_id).released, false);
  assert.throws(() => f.exports.read(meta.export_id), code("HOST_EXPORT_NOT_FOUND"));
  assert.equal(await readFile(path, "utf8"), "source changed after export");
});

test("exports require separate specific roots even when ordinary reads or link following are allowed", async t => {
  const f = await fixture(t, { follow_links: true });
  const outside = join(f.outside, "notes.pdf");
  await writeFile(outside, "readable");
  assert.equal((await new HostFiles(f.policy).read(outside)).content, "readable");
  await assert.rejects(f.exports.create(outside), code("HOST_EXPORT_DENIED"));
  await assert.rejects(f.exports.create(`${f.allowed}${sep}..${sep}allowed-other${sep}notes.pdf`), code("HOST_PATH_DENIED"));
  await assert.rejects(f.exports.create("relative.pdf"), code("HOST_PATH_DENIED"));
  const disabled = new HostExports(await HostPolicy.create({ ...f.config, export_roots: [] }, f.policyPath));
  await assert.rejects(disabled.create(outside), code("HOST_EXPORT_DISABLED"));
  await assert.rejects(HostPolicy.create({ ...f.config, export_roots: [parse(f.root).root] }, f.policyPath));
  await assert.rejects(HostPolicy.create({ ...f.config, read_roots: [f.outside] }, f.policyPath));
  await assert.rejects(HostPolicy.create({ ...f.config, export_max_bytes: 129 * 1024 * 1024 }, f.policyPath));
  await assert.rejects(HostPolicy.create({ ...f.config, export_ttl_seconds: 0 }, f.policyPath));
});

test("credentials, protected paths, policy and audit files are excluded from exports", async t => {
  const f = await fixture(t);
  for (const leaf of [".env", ".env.production", "auth.json", "credentials.json", "private.key", "id_ed25519",
    ".npmrc", ".ssh/config", ".aws/config", ".codex/config.toml", ".git/config", "protected/notes.pdf",
    "policy.json", "policy.json.audit.jsonl"]) {
    const path = join(f.allowed, ...leaf.split("/"));
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "secret-marker");
    await assert.rejects(f.exports.create(path), error => error instanceof HostError &&
      ["HOST_PATH_DENIED", "HOST_EXPORT_DENIED"].includes(error.code), leaf);
  }
});

test("exports reject junctions, linked roots and hard links", async t => {
  const f = await fixture(t, { follow_links: true });
  const source = join(f.outside, "outside.txt");
  await writeFile(source, "outside");
  const directoryLink = join(f.allowed, "linked");
  await symlink(f.outside, directoryLink, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.exports.create(join(directoryLink, "outside.txt")), code("HOST_PATH_DENIED"));
  await assert.rejects(HostPolicy.create({ ...f.config, export_roots: [directoryLink] }, f.policyPath), code("HOST_PATH_DENIED"));
  const hardLink = join(f.allowed, "hard.txt");
  await link(source, hardLink);
  await assert.rejects(f.exports.create(hardLink), code("HOST_FILE_UNSUPPORTED"));
  await assert.rejects(f.exports.create(f.allowed), code("HOST_FILE_UNSUPPORTED"));
  if (process.platform !== "win32") {
    const fileLink = join(f.allowed, "symlink.txt");
    await symlink(source, fileLink);
    await assert.rejects(f.exports.create(fileLink), code("HOST_PATH_DENIED"));
  }
});

test("size, empty files, offsets, expiry, process isolation and explicit release", async t => {
  const f = await fixture(t, { export_max_bytes: 1024 });
  const path = join(f.allowed, "empty.png");
  await writeFile(path, Buffer.alloc(1025));
  await assert.rejects(f.exports.create(path), code("HOST_EXPORT_TOO_LARGE"));
  await writeFile(path, Buffer.alloc(0));
  let now = Date.now();
  const exports = new HostExports(f.policy, () => now);
  t.after(() => exports.dispose());
  const meta = await exports.create(path);
  assert.equal(exports.read(meta.export_id).eof, true);
  assert.equal(meta.sha256, digest(Buffer.alloc(0)));
  for (const [offset, count] of [[-1, 1], [1, 1], [0, 0], [0, EXPORT_CHUNK_BYTES + 1], [0.5, 1], [Infinity, 1]]) {
    assert.throws(() => exports.read(meta.export_id, offset, count), code("HOST_INVALID_ARGUMENT"));
  }
  assert.throws(() => f.exports.read(meta.export_id), code("HOST_EXPORT_NOT_FOUND"));
  now += f.policy.config.export_ttl_seconds * 1000;
  assert.throws(() => exports.read(meta.export_id), code("HOST_EXPORT_NOT_FOUND"));
  const ids = [];
  for (let i = 0; i < EXPORT_MAX_ACTIVE; i++) ids.push((await exports.create(path)).export_id);
  await assert.rejects(exports.create(path), code("HOST_EXPORT_CAPACITY"));
  exports.release(ids[0]!);
  await exports.create(path);
  exports.dispose();
  await assert.rejects(exports.create(path), code("HOST_EXPORT_CLOSED"));
});

test("aborted capture releases reservations and exposes no partial snapshot", async t => {
  const f = await fixture(t);
  const path = join(f.allowed, "cancel.zip");
  await writeFile(path, randomBytes(EXPORT_CHUNK_BYTES * 2));
  const controller = new AbortController();
  const originalOpen = fs.open;
  const mocked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    const originalRead = handle.read.bind(handle);
    t.mock.method(handle, "read", async (...readArgs: Parameters<typeof handle.read>) => {
      const result = await originalRead(...readArgs);
      controller.abort();
      return result;
    });
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(f.exports.create(path, controller.signal), { name: "AbortError" });
  await assert.rejects(f.exports.create(path, controller.signal), { name: "AbortError" });
  mocked.mock.restore();
  syncBuiltinESMExports();
  for (let i = 0; i < EXPORT_MAX_ACTIVE; i++) await f.exports.create(path);
});

test("replacement between path validation and open fails descriptor identity checks", async t => {
  const f = await fixture(t);
  const path = join(f.allowed, "race.txt");
  await writeFile(path, "authorized source");
  const originalOpen = fs.open;
  const mocked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    await rename(path, join(f.allowed, "original.txt"));
    await writeFile(path, "substituted source");
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(f.exports.create(path), code("HOST_FILE_CHANGED"));
});

test("real STDIO MCP exports and reconstructs bytes, reads resources and preserves old tools", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const configPath = join(f.root, "workspaces.json");
  await writeFile(configPath, "[]");
  await writeFile(configPath + ".host-policy.json", JSON.stringify(f.config));
  const bytes = randomBytes(EXPORT_CHUNK_BYTES * 5 + 37);
  const path = join(f.allowed, "手机下载测试.zip");
  await writeFile(path, bytes);
  const client = new Client({ name: "export-e2e", version: "1" });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [resolve("dist/src/mcp-stdio.js"), configPath], stderr: "pipe" }));
  const tools = (await client.listTools()).tools;
  for (const name of ["export_host_file", "read_export_chunk", "release_host_export", "read_host_file", "run_temp"]) {
    assert.ok(tools.some(tool => tool.name === name));
  }
  assert.equal((tools.find(tool => tool.name === "export_host_file")!._meta?.ui as { resourceUri: string }).resourceUri, EXPORT_WIDGET_URI);
  assert.equal(tools.find(tool => tool.name === "read_export_chunk")!._meta?.["openai/widgetAccessible"], true);
  const widget = (await client.readResource({ uri: EXPORT_WIDGET_URI })).contents[0]!;
  assert.equal(widget.mimeType, EXPORT_WIDGET_MIME);
  assert.ok("text" in widget);
  assert.match(widget.text as string, /api\.uploadFile\(file\)/u);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result;
  };
  const exported = await call("export_host_file", { path });
  const meta = exported.structuredContent as unknown as Awaited<ReturnType<HostExports["create"]>>;
  assert.equal(meta.sha256, digest(bytes));
  assert.equal(meta.filename, "手机下载测试.zip");
  assert.ok((exported.content as { type: string; uri?: string }[]).some(item => item.type === "resource_link" && item.uri === meta.resource_uri));
  assert.equal("file_id" in meta, false);
  assert.equal("download_url" in meta, false);
  assert.equal("content" in meta, false);
  assert.ok(JSON.stringify(exported).length < 3000);
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const args = { export_id: meta.export_id, offset };
    const result = (await call("read_export_chunk", args)).structuredContent as ReturnType<HostExports["read"]>;
    if (offset === 0) assert.deepEqual((await call("read_export_chunk", args)).structuredContent, result);
    const part = Buffer.from(result.content, "base64");
    assert.equal(digest(part), result.chunk_sha256);
    parts.push(part);
    offset = result.next_offset;
    if (result.eof) break;
  }
  const reconstructed = Buffer.concat(parts);
  assert.deepEqual(reconstructed, bytes);
  assert.equal(digest(reconstructed), meta.sha256);
  await assert.rejects(client.readResource({ uri: meta.resource_uri }), /HOST_EXPORT_USE_CHUNKS/u);
  const small = join(f.allowed, "笔记.pdf");
  await writeFile(small, "%PDF-1.4\nNon-sensitive export transport fixture\n%%EOF\n");
  const smallMeta = (await call("export_host_file", { path: small })).structuredContent as unknown as typeof meta;
  const resource = (await client.readResource({ uri: smallMeta.resource_uri })).contents[0]!;
  assert.ok("blob" in resource);
  assert.equal(digest(Buffer.from(resource.blob as string, "base64")), smallMeta.sha256);
  const legacy = await call("read_host_file", { path: small });
  assert.match(JSON.stringify(legacy), /PDF-1.4/u);
  assert.equal((await client.callTool({ name: "export_host_file", arguments: { path: configPath } })).isError, true);
  await call("release_host_export", { export_id: meta.export_id });
  assert.equal((await client.callTool({ name: "read_export_chunk", arguments: { export_id: meta.export_id } })).isError, true);
  const audit = await readFile(configPath + ".host-policy.json.audit.jsonl", "utf8");
  assert.equal(audit.includes(bytes.toString("base64")), false);
  assert.equal(audit.includes(meta.export_id), false);
  assert.equal(audit.includes(meta.sha256), false);
});
