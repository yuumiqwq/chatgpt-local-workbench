import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { realpathSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join, relative, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { locateCodexSession } from "../../../src/host/codex-sessions.js";
import { listCodexProjects, listCodexThreads } from "../../../src/host/codex-thread-list.js";
import { runHostCommand } from "../../../src/host/host-command.js";
import { HostFiles } from "../../../src/host/host-files.js";
import { containsPath, HostError, HostPolicy } from "../../../src/host/host-policy.js";
import { registerHostTools } from "../../../src/host/host-tools.js";

const THREAD_ID = "550e8400-e29b-41d4-a716-446655440000";
const ARCHIVED_THREAD_ID = "650e8400-e29b-41d4-a716-446655440001";
const digest = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
const hostCode = (code: string) => (error: unknown) => error instanceof HostError && error.code === code;

async function fixture(t: TestContext, commands = false) {
  const root = await mkdtemp(join(tmpdir(), "bridge-host-"));
  t.after(async () => {
    assert.ok(containsPath(resolve(tmpdir()), resolve(root)));
    assert.ok(relative(resolve(tmpdir()), resolve(root)).startsWith("bridge-host-"));
    await rm(root, { recursive: true, force: true });
  });
  const allowed = join(root, "allowed");
  const readOnly = join(root, "read-only");
  const outside = join(root, "outside");
  const codexHome = join(root, "codex");
  await Promise.all([allowed, readOnly, outside, codexHome].map(path => mkdir(path)));
  const policyPath = join(allowed, "host-policy.json");
  const config = { version: 1, enabled: true, read_roots: [allowed, readOnly, codexHome],
    write_roots: [allowed], command_roots: [allowed], commands_enabled: commands,
    codex_homes: [codexHome], protected_paths: [join(allowed, "protected")] };
  await writeFile(policyPath, JSON.stringify(config));
  const policy = await HostPolicy.load(policyPath);
  return { root, allowed, readOnly, outside, codexHome, policyPath, config, policy, files: new HostFiles(policy) };
}

test("missing policy disables all host operations", async t => {
  const f = await fixture(t);
  const policy = await HostPolicy.load(join(f.root, "missing.json"));
  assert.equal(policy.config.enabled, false);
  await assert.rejects(policy.check(f.allowed, "read"), hostCode("HOST_DISABLED"));
});

test("file tools create and replace Unicode text only against the reviewed hash", async t => {
  const { allowed, files } = await fixture(t);
  const path = join(allowed, "含 空格", "笔记.md");
  const created = await files.write(path, "原始笔记", undefined, true);
  const read = await files.read(path, 0, 65_536, "utf8", true);
  assert.equal(read.content, "原始笔记");
  assert.equal(read.sha256, created.sha256);
  await assert.rejects(files.write(path, "overwrite"), hostCode("HOST_DESTINATION_EXISTS"));
  const replaced = await files.write(path, "updated", read.sha256);
  assert.equal(replaced.sha256, digest("updated"));
  await assert.rejects(files.write(path, "lost update", read.sha256), hostCode("HOST_FILE_CHANGED"));
  assert.equal(await readFile(path, "utf8"), "updated");
});

test("concurrent replacements do not overwrite a newer reviewed version", async t => {
  const { allowed, files } = await fixture(t);
  const path = join(allowed, "counter.txt");
  await files.write(path, "before");
  const results = await Promise.allSettled([
    files.write(path, "first", digest("before")),
    files.write(path, "second", digest("before"))
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(await readFile(path, "utf8"), "first");
});

test("path traversal, neighboring prefixes and configured protected files are rejected", async t => {
  const f = await fixture(t);
  await assert.rejects(f.files.write(join(f.outside, "file"), "x"), hostCode("HOST_PATH_DENIED"));
  await assert.rejects(f.files.write(f.allowed + "-other/file", "x"), hostCode("HOST_PATH_DENIED"));
  await assert.rejects(f.files.write(f.allowed + "/../outside/file", "x"), hostCode("HOST_PATH_DENIED"));
  await assert.rejects(f.files.write(join(f.allowed, "protected", "file"), "x", undefined, true), hostCode("HOST_PATH_DENIED"));
  await assert.rejects(f.files.write(f.policyPath, "{}", digest(JSON.stringify(f.config))), hostCode("HOST_PATH_DENIED"));
  await assert.rejects(f.files.write(f.policyPath + ".audit.jsonl", "x"), hostCode("HOST_PATH_DENIED"));
  await writeFile(join(f.codexHome, "auth.json"), "credential-marker");
  await assert.rejects(f.files.read(join(f.codexHome, "auth.json")), hostCode("HOST_PATH_DENIED"));
  await writeFile(join(f.allowed, ".env"), "credential-marker");
  await assert.rejects(f.files.read(join(f.allowed, ".env")), hostCode("HOST_PATH_DENIED"));
  if (process.platform === "win32") {
    for (const path of [join(f.allowed, "file.txt:stream"), join(f.allowed, "file. "),
      join(f.allowed, "CON.txt"), "\\\\?\\C:\\Windows\\file"]) {
      await assert.rejects(f.files.write(path, "x"), hostCode("HOST_PATH_DENIED"));
    }
  }
});

test("junction ancestors and hard-linked files do not escape file policy", async t => {
  const f = await fixture(t);
  const linkPath = join(f.allowed, "linked");
  await symlink(f.outside, linkPath, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.files.write(join(linkPath, "escape.txt"), "x"), hostCode("HOST_PATH_DENIED"));
  const externalFile = join(f.outside, "original.txt");
  const hardLink = join(f.allowed, "hard.txt");
  await writeFile(externalFile, "original");
  await link(externalFile, hardLink);
  await assert.rejects(f.files.read(hardLink), hostCode("HOST_FILE_UNSUPPORTED"));
  await assert.rejects(f.files.write(hardLink, "changed", digest("original")), hostCode("HOST_FILE_UNSUPPORTED"));
  assert.equal(await readFile(externalFile, "utf8"), "original");
});

test("binary copies and moves preserve bytes without overwriting destinations", async t => {
  const f = await fixture(t);
  const bytes = Buffer.from([0, 255, 128, 2, 10, 13, 4]);
  const source = join(f.readOnly, "image.png");
  const copied = join(f.allowed, "assets", "image.png");
  await writeFile(source, bytes);
  const result = await f.files.copy(source, copied, true);
  assert.equal(result.sha256, digest(bytes));
  assert.deepEqual(await readFile(copied), bytes);
  await assert.rejects(f.files.read(copied), hostCode("HOST_BINARY_FILE"));
  assert.equal((await f.files.read(copied, 0, 10, "base64")).content, bytes.toString("base64"));
  await assert.rejects(f.files.copy(source, copied), hostCode("HOST_DESTINATION_EXISTS"));
  const moved = join(f.allowed, "moved.png");
  await f.files.move(copied, moved, result.sha256);
  await assert.rejects(readFile(copied), { code: "ENOENT" });
  assert.deepEqual(await readFile(moved), bytes);
  await assert.rejects(f.files.move(source, join(f.allowed, "forbidden.png"), result.sha256), hostCode("HOST_PATH_DENIED"));
});

test("deletion requires the current digest and never removes a nonempty directory or configured root", async t => {
  const { allowed, files } = await fixture(t);
  const folder = join(allowed, "folder");
  const path = join(folder, "note.txt");
  await files.write(path, "keep", undefined, true);
  await assert.rejects(files.remove(path), hostCode("HOST_EXPECTED_HASH_REQUIRED"));
  await assert.rejects(files.remove(path, digest("old")), hostCode("HOST_FILE_CHANGED"));
  await assert.rejects(files.remove(folder));
  await assert.rejects(files.remove(allowed), hostCode("HOST_PATH_DENIED"));
  assert.equal(await readFile(path, "utf8"), "keep");
  await files.remove(path, digest("keep"));
  await files.remove(folder);
});

test("bounded reads and paginated directory listings preserve access to later content", async t => {
  const { allowed, files } = await fixture(t);
  const path = join(allowed, "large.txt");
  await files.write(path, "0123456789");
  const first = await files.read(path, 0, 3);
  assert.equal(first.content, "012");
  assert.equal(first.next_offset, 3);
  assert.equal(first.truncated, true);
  assert.equal((await files.read(path, 8, 3)).content, "89");
  assert.equal((await files.read(path, 20, 3)).content, "");
  const page = await files.list(allowed, 0, 1);
  assert.equal(page.entries.length, 1);
  assert.equal(page.truncated, true);
  assert.equal((await files.list(allowed, page.next_offset, 1)).entries.length, 1);
});

test("ordinary pages avoid full-file streams and hashes are explicitly requested", async t => {
  const { allowed, files } = await fixture(t);
  const path = join(allowed, "pages.txt");
  await writeFile(path, "0123456789");
  const streams = t.mock.method(fs, "createReadStream");
  syncBuiltinESMExports();
  t.after(() => { streams.mock.restore(); syncBuiltinESMExports(); });

  const first = await files.read(path, 0, 3);
  const second = await files.read(path, first.next_offset, 3);
  assert.equal(first.content + second.content, "012345");
  assert.equal("sha256" in first, false);
  assert.equal("sha256" in second, false);
  assert.equal(streams.mock.callCount(), 0);
  const reviewed = await files.read(path, 0, 3, "utf8", true);
  assert.equal(reviewed.sha256, digest("0123456789"));
  assert.equal(streams.mock.callCount(), 1);
});

test("UTF-8 pagination preserves Chinese, emoji and BOM at small and default boundaries", async t => {
  const { allowed, files } = await fixture(t);
  const path = join(allowed, "unicode.txt");
  for (const original of ["中文ABC", "\uFEFFa中文😺e\u0301\nend", "a".repeat(65_535) + "中😺end"]) {
    await writeFile(path, original);
    const sizes = original.length > 100 ? [65_536] : [4, 5, 6, 7];
    for (const size of sizes) {
      let offset = 0;
      let restored = "";
      for (;;) {
        const page = await files.read(path, offset, size);
        assert.ok(page.bytes_read <= size);
        assert.equal(page.bytes_read, Buffer.byteLength(page.content, "utf8"));
        assert.equal(page.next_offset, offset + page.bytes_read);
        restored += page.content;
        if (!page.truncated) break;
        assert.ok(page.next_offset > offset);
        offset = page.next_offset;
      }
      assert.equal(restored, original);
    }
  }
});

test("invalid UTF-8 offsets and pages too small for a character fail without corrupting data", async t => {
  const { allowed, files } = await fixture(t);
  const path = join(allowed, "character.txt");
  await writeFile(path, "中a");
  await assert.rejects(files.read(path, 0, 1), hostCode("HOST_INVALID_ARGUMENT"));
  await assert.rejects(files.read(path, 1, 4), hostCode("HOST_INVALID_UTF8"));
  assert.equal((await files.read(path, 3, 1)).content, "a");
  const binary = await files.read(path, 0, 1, "base64");
  assert.deepEqual(Buffer.from(binary.content, "base64"), Buffer.from("中a").subarray(0, 1));
  assert.equal(binary.next_offset, 1);
  await writeFile(path, Buffer.from([0xe4, 0xb8]));
  await assert.rejects(files.read(path), hostCode("HOST_INVALID_UTF8"));
});

test("host commands need a separate opt-in and preserve literal argv", async t => {
  const f = await fixture(t);
  await assert.rejects(runHostCommand(f.policy, process.execPath, ["-e", "0"], f.allowed), hostCode("HOST_COMMAND_DISABLED"));
  const enabled = await HostPolicy.create({ ...f.config, commands_enabled: true }, f.policyPath);
  const literal = "spaces ; $(do-not-run) " + String.fromCharCode(96);
  const result = await runHostCommand(enabled, process.execPath,
    ["-e", "process.stdout.write(process.argv[1]); process.stderr.write('err');", literal], f.allowed);
  assert.equal(result.stdout, literal);
  assert.equal(result.stderr, "err");
  assert.equal(result.exit_code, 0);
  assert.equal(result.timed_out, false);
});

test("host command output is bounded and timeout stops a live process", { timeout: 10_000 }, async t => {
  const f = await fixture(t, true);
  const output = await runHostCommand(f.policy, process.execPath,
    ["-e", "process.stdout.write('x'.repeat(100000));"], f.allowed);
  assert.equal(Buffer.byteLength(output.stdout), 65_536);
  assert.equal(output.truncated, true);
  const timeout = await runHostCommand(f.policy, process.execPath,
    ["-e", "setInterval(()=>{},1000)"], f.allowed, 1);
  assert.equal(timeout.timed_out, true);
});

test("host command cancellation kills the command while pre-abort starts no process", { timeout: 10_000 }, async t => {
  const f = await fixture(t, true);
  const controller = new AbortController();
  const waiting = runHostCommand(f.policy, process.execPath,
    ["-e", "setInterval(()=>{},1000)"], f.allowed, 10, controller.signal);
  const timer = setTimeout(() => controller.abort(), 100);
  t.after(() => clearTimeout(timer));
  assert.equal((await waiting).cancelled, true);
  await assert.rejects(runHostCommand(f.policy, process.execPath,
    ["-e", "0"], f.allowed, 10, controller.signal), { name: "AbortError" });
});

test("native session lookup verifies the header UUID and original allowed cwd", async t => {
  const f = await fixture(t);
  const sessions = join(f.codexHome, "sessions", "2026", "09", "08");
  await mkdir(sessions, { recursive: true });
  const path = join(sessions, "rollout-" + THREAD_ID + ".jsonl");
  await writeFile(path, JSON.stringify({ type: "session_meta", payload: {
    id: THREAD_ID, cwd: f.allowed
  } }) + "\n");
  assert.deepEqual(await locateCodexSession(f.policy, THREAD_ID), {
    threadId: THREAD_ID, cwd: realpathSync.native(f.allowed), codexHome: f.codexHome, rolloutPath: path
  });
  await writeFile(path, JSON.stringify({ type: "session_meta", payload: {
    id: THREAD_ID, cwd: f.outside
  } }) + "\n");
  await assert.rejects(locateCodexSession(f.policy, THREAD_ID), hostCode("HOST_PATH_DENIED"));
  await assert.rejects(locateCodexSession(f.policy, "invalid"), hostCode("CODEX_THREAD_NOT_FOUND"));
});

test("native session lookup accepts top-level Codex history junctions without relaxing host file policy", async t => {
  const f = await fixture(t);
  const storage = join(f.outside, "native-sessions"), archivedStorage = join(f.outside, "native-archived-sessions");
  const dated = join(storage, "2026", "09", "12"), archivedDated = join(archivedStorage, "2026", "09", "11");
  await Promise.all([mkdir(dated, { recursive: true }), mkdir(archivedDated, { recursive: true })]);
  const linkedRoot = join(f.codexHome, "sessions");
  const archivedLinkedRoot = join(f.codexHome, "archived_sessions");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await Promise.all([symlink(storage, linkedRoot, linkType), symlink(archivedStorage, archivedLinkedRoot, linkType)]);
  const path = join(dated, "rollout-" + THREAD_ID + ".jsonl");
  const archivedPath = join(archivedDated, "rollout-" + ARCHIVED_THREAD_ID + ".jsonl");
  await Promise.all([
    writeFile(path, JSON.stringify({ type: "session_meta", payload: { id: THREAD_ID, cwd: f.allowed } }) + "\n"),
    writeFile(archivedPath, JSON.stringify({ type: "session_meta", payload: {
      id: ARCHIVED_THREAD_ID, cwd: f.allowed
    } }) + "\n")
  ]);

  assert.deepEqual(await locateCodexSession(f.policy, THREAD_ID), {
    threadId: THREAD_ID, cwd: realpathSync.native(f.allowed), codexHome: f.codexHome,
    rolloutPath: realpathSync.native(path)
  });
  assert.deepEqual(await locateCodexSession(f.policy, ARCHIVED_THREAD_ID), {
    threadId: ARCHIVED_THREAD_ID, cwd: realpathSync.native(f.allowed), codexHome: f.codexHome,
    rolloutPath: realpathSync.native(archivedPath)
  });
  await assert.rejects(f.files.read(join(linkedRoot, "2026", "09", "12", "rollout-" + THREAD_ID + ".jsonl")),
    hostCode("HOST_PATH_DENIED"));
});



test("MCP advertises enabled tools, validates deletion content hashes and audits no content", async t => {
  const f = await fixture(t);
  const server = new McpServer({ name: "host-test", version: "1" });
  registerHostTools(server, f.policy);
  const client = new Client({ name: "client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(!names.includes("resume_codex_thread"));
  assert.ok(names.includes("list_codex_threads"));
  assert.ok(names.includes("list_codex_projects"));
  assert.ok(names.includes("run_host_command"));
  const path = join(f.allowed, "note.txt");
  const content = "private-content-marker";
  assert.notEqual((await client.callTool({ name: "write_host_text_file", arguments: { path, content } })).isError, true);
  const readPage = await client.callTool({ name: "read_host_file", arguments: { path, max_bytes: 4 } });
  const pageBody = JSON.parse((readPage.content as Array<{ text: string }>)[0]!.text);
  assert.equal(pageBody.content, content.slice(0, 4));
  assert.equal("sha256" in pageBody, false);
  const readHash = await client.callTool({ name: "read_host_file", arguments: { path, include_sha256: true } });
  const hashBody = JSON.parse((readHash.content as Array<{ text: string }>)[0]!.text);
  assert.equal(hashBody.sha256, digest(content));
  assert.equal((await client.callTool({ name: "delete_file", arguments: {
    path, expected_sha256: digest("stale")
  } })).isError, true);
  assert.equal(await readFile(path, "utf8"), content);
  const audit = await readFile(f.policyPath + ".audit.jsonl", "utf8");
  assert.equal(audit.includes(content), false);
  assert.equal(audit.includes('"state":"completed"'), true);
});

test("native catalog forwards bounded search and pagination and omits disallowed conversation metadata", async t => {
  const f = await fixture(t);
  const entry = { id: THREAD_ID, cwd: f.allowed, name: "课程笔记", preview: "内容".repeat(900),
    createdAt: 1, updatedAt: 2, turns: [{ secret: "not-returned" }] };
  const result = await listCodexThreads(f.policy, { query: "课程", cursor: "page-2", limit: 3, archived: true },
    undefined, async (home, params) => {
      assert.equal(home, f.codexHome);
      assert.equal(params.searchTerm, "课程");
      assert.equal(params.cursor, "page-2");
      assert.equal(params.archived, true);
      assert.deepEqual(params.modelProviders, []);
      return { data: [entry, { ...entry, cwd: f.readOnly, name: "readable" },
        { ...entry, cwd: f.outside, name: "outside-title" }], nextCursor: "page-3" };
    });
  assert.equal(result.threads.length, 2);
  assert.equal(result.omitted_count, 1);
  assert.equal(result.next_cursor, "page-3");
  assert.equal(result.threads[0]!.title, "课程笔记");
  assert.equal(result.threads[0]!.preview.length, 1000);
  assert.equal(result.threads[0]!.preview_truncated, true);
  assert.equal(result.threads[0]!.can_resume_with_write, true);
  assert.equal(result.threads[1]!.can_resume_with_write, false);
  assert.equal(result.threads[0]!.activity_elsewhere, "unknown");
  assert.equal(JSON.stringify(result).includes("not-returned"), false);
  assert.equal(JSON.stringify(result).includes("outside-title"), false);
});

test("native catalog rejects unconfigured homes, bad limits and invalid protocol data", async t => {
  const f = await fixture(t);
  let calls = 0;
  const query = async () => { calls++; return { data: [], nextCursor: null }; };
  await assert.rejects(listCodexThreads(f.policy, { codex_home: f.outside }, undefined, query), hostCode("CODEX_HOME_DENIED"));
  await assert.rejects(listCodexThreads(f.policy, { limit: 51 }, undefined, query), hostCode("CODEX_CATALOG_LIMIT"));
  assert.equal(calls, 0);
  await assert.rejects(listCodexThreads(f.policy, {}, undefined, async () => ({ data: [{ id: "invented" }] })),
    hostCode("CODEX_CATALOG_FAILED"));
  assert.equal((await listCodexThreads(f.policy, {}, undefined, query)).next_cursor, null);
});

test("project browsing groups conversations by cwd and supplies an exact scoped follow-up", async t => {
  const f = await fixture(t);
  const base = { id: THREAD_ID, cwd: f.allowed, name: "Old title", preview: "", createdAt: 1, updatedAt: 2 };
  const result = await listCodexProjects(f.policy, { archived: true }, undefined, async (_home, params) => {
    assert.equal(params.limit, 50);
    assert.equal(params.archived, true);
    return { data: [base, { ...base, updatedAt: 10, name: "Newest title" },
      { ...base, cwd: f.readOnly, updatedAt: 5 }], nextCursor: "next-project-page" };
  });
  assert.equal(result.projects.length, 2);
  assert.equal(result.projects[0]!.cwd, realpathSync.native(f.allowed));
  assert.equal(result.projects[0]!.thread_count_in_page, 2);
  assert.equal(result.projects[0]!.latest_title, "Newest title");
  assert.equal(result.projects[0]!.last_updated_at, 10);
  assert.deepEqual(result.projects[0]!.thread_list_arguments,
    { cwd: realpathSync.native(f.allowed), codex_home: f.codexHome, archived: true });
  assert.equal(result.next_cursor, "next-project-page");
  assert.match(result.counts_scope, /current page only/u);
});

test("project-name search retains same-name directories and a cursor after an empty filtered page", async t => {
  const f = await fixture(t);
  const first = join(f.allowed, "shared-project");
  const second = join(f.readOnly, "shared-project");
  await mkdir(first);
  await mkdir(second);
  const query = async (_home: string, params: Record<string, unknown>) => {
    assert.equal(params.searchTerm, undefined);
    assert.equal(params.cursor, "page-one");
    const base = { id: THREAD_ID, cwd: first, name: "Unrelated conversation title", preview: "", createdAt: 1, updatedAt: 2 };
    return { data: [base, { ...base, cwd: second }, { ...base, cwd: f.outside }], nextCursor: "page-two" };
  };
  const options = { query: "SHARED-project", cursor: "page-one" };
  const result = await listCodexProjects(f.policy, options, undefined, query);
  assert.equal(result.projects.length, 2);
  assert.ok(result.projects.every(item => item.name === "shared-project"));
  assert.notEqual(result.projects[0]!.cwd, result.projects[1]!.cwd);
  assert.equal(result.scanned_threads, 3);
  assert.equal(result.omitted_count, 1);
  const empty = await listCodexProjects(f.policy, { ...options, query: "not-on-this-page" }, undefined, query);
  assert.equal(empty.projects.length, 0);
  assert.equal(empty.next_cursor, "page-two");
});
