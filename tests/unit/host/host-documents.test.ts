import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readHostDocument } from "../../../src/host/host-documents.js";
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
