import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { CoreError } from "../../../src/core/errors.js";
import { ManagedWorkspaceCatalog } from "../../../src/workspaces/managed-workspace-catalog.js";

function catalogPath(): string {
  return join(mkdtempSync(join(tmpdir(), "bridge-catalog-")), "managed-workspaces.json");
}

function expectCode(action: () => Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(action, (error: unknown) => error instanceof CoreError && error.code === code);
}

const canonical = (name: string): string => resolve("catalog-fixtures", name);

test("loads an absent catalog and round-trips identity records with schema version 2", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-catalog-"));
  const path = join(directory, "managed-workspaces.json");
  const catalog = new ManagedWorkspaceCatalog(path);
  await catalog.load();
  const firstRoot = canonical("a"), secondRoot = canonical("b");
  const first = await catalog.registerOnce(firstRoot);
  const second = await catalog.registerOnce(secondRoot);
  const reloaded = new ManagedWorkspaceCatalog(path);
  await reloaded.load();
  assert.deepEqual(reloaded.entries(), [
    { id: first.id, root: firstRoot },
    { id: second.id, root: secondRoot }
  ]);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    version: 2, workspaces: reloaded.entries()
  });
  assert.deepEqual(readdirSync(directory), ["managed-workspaces.json"]);
});

test("registerOnce returns the stable id for repeated and concurrent registration", async () => {
  const path = catalogPath();
  const catalog = new ManagedWorkspaceCatalog(path);
  await catalog.load();
  const [first, second] = await Promise.all([
    catalog.registerOnce(canonical("same")),
    catalog.registerOnce(canonical("same"))
  ]);
  const third = await catalog.registerOnce(canonical("same"));
  assert.equal(first.id, second.id);
  assert.equal(first.id, third.id);
  assert.notEqual(first.created, second.created);
  assert.equal(third.created, false);
  assert.deepEqual(catalog.entries(), [{ id: first.id, root: canonical("same") }]);
});

test("a persist failure rolls back the in-memory record and permits retry", async () => {
  const path = catalogPath();
  const catalog = new ManagedWorkspaceCatalog(path);
  await catalog.load();
  mkdirSync(path);
  await expectCode(() => catalog.registerOnce(canonical("x")), "INTERNAL_ERROR");
  assert.deepEqual(catalog.entries(), []);
  rmSync(path, { recursive: true, force: true });
  const retried = await catalog.registerOnce(canonical("x"));
  assert.deepEqual(catalog.entries(), [{ id: retried.id, root: canonical("x") }]);
});

test("migrates a version 1 catalog once while preserving every valid id and root", async () => {
  const path = catalogPath();
  const expected = [
    { id: "00000000-0000-4000-8000-000000000001", root: canonical("old") },
    { id: "00000000-0000-4000-8000-000000000002", root: canonical("authorized") }
  ];
  writeFileSync(path, `${JSON.stringify({
    version: 1,
    workspaces: [expected[0], { ...expected[1], allow_write: true }]
  }, null, 2)}\n`);
  const catalog = new ManagedWorkspaceCatalog(path);
  await catalog.load();
  assert.deepEqual(catalog.entries(), expected);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { version: 2, workspaces: expected });
  const reloaded = new ManagedWorkspaceCatalog(path);
  await reloaded.load();
  assert.deepEqual(reloaded.entries(), expected);
});

test("skips invalid records and rejects corrupt or unsupported whole files", async () => {
  const path = catalogPath();
  writeFileSync(path, `${JSON.stringify({
    version: 2,
    workspaces: [
      { id: "not-a-uuid", root: canonical("bad-id") },
      { id: "00000000-0000-4000-8000-000000000001", root: "relative/root" },
      { id: "00000000-0000-4000-8000-000000000002", root: canonical("ok") },
      { id: "00000000-0000-4000-8000-000000000002", root: canonical("dup-id") },
      { id: "00000000-0000-4000-8000-000000000003", root: canonical("ok") }
    ]
  }, null, 2)}\n`);
  const catalog = new ManagedWorkspaceCatalog(path);
  await catalog.load();
  assert.deepEqual(catalog.entries(), [
    { id: "00000000-0000-4000-8000-000000000002", root: canonical("ok") }
  ]);
  writeFileSync(path, "not json at all");
  await expectCode(() => new ManagedWorkspaceCatalog(path).load(), "INTERNAL_ERROR");
  writeFileSync(path, `${JSON.stringify({ version: 3, workspaces: [] })}\n`);
  await expectCode(() => new ManagedWorkspaceCatalog(path).load(), "INTERNAL_ERROR");
});

test("a catalog without a state path stays process-local", async () => {
  const catalog = new ManagedWorkspaceCatalog(undefined);
  await catalog.load();
  const { id } = await catalog.registerOnce(canonical("local"));
  assert.deepEqual(catalog.entries(), [{ id, root: canonical("local") }]);
});

test("independent loaded catalogs preserve registrations and reuse existing identities", async () => {
  const path = catalogPath();
  const a = new ManagedWorkspaceCatalog(path), b = new ManagedWorkspaceCatalog(path);
  await Promise.all([a.load(), b.load()]);
  const first = await a.registerOnce(canonical("a"));
  const second = await b.registerOnce(canonical("b"));
  const repeated = await b.registerOnce(canonical("a"));
  assert.deepEqual(repeated, { id: first.id, created: false });
  const reloaded = new ManagedWorkspaceCatalog(path);
  await reloaded.load();
  assert.deepEqual(reloaded.entries(), [
    { id: first.id, root: canonical("a") }, { id: second.id, root: canonical("b") }
  ]);
});

for (const sameRoot of [false, true]) {
  test(`separate processes migrate and register ${sameRoot ? "the same" : "different"} roots without lost records`, { timeout: 20_000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), "bridge-catalog-processes-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "catalog.json");
    const legacy = { id: "00000000-0000-4000-8000-000000000001", root: canonical("legacy") };
    writeFileSync(path, JSON.stringify({ version: 1, workspaces: [legacy] }));
    const source = `
      import { ManagedWorkspaceCatalog } from ${JSON.stringify(new URL("../../../src/workspaces/managed-workspace-catalog.js", import.meta.url).href)};
      const catalog = new ManagedWorkspaceCatalog(process.argv[1]);
      await catalog.load();
      process.on("message", async () => {
        process.send(await catalog.registerOnce(process.argv[2]));
        process.disconnect();
      });
      process.send("ready");
    `;
    const roots = [canonical("a"), canonical(sameRoot ? "a" : "b")];
    const children = roots.map(root => spawn(process.execPath, ["--input-type=module", "--eval", source, path, root], {
      stdio: ["ignore", "ignore", "inherit", "ipc"], windowsHide: true
    }));
    t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
    const exits = children.map(child => once(child, "exit"));
    await Promise.all(children.map(child => once(child, "message")));
    const replies = children.map(child => once(child, "message"));
    for (const child of children) child.send("register");
    const results = (await Promise.all(replies)).map(([result]) => result as { id: string; created: boolean });
    for (const [code] of await Promise.all(exits)) assert.equal(code, 0);
    const disk = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(disk.version, 2);
    assert.equal(disk.workspaces.length, sameRoot ? 2 : 3);
    assert.deepEqual(disk.workspaces.find((entry: { root: string }) => entry.root === legacy.root), legacy);
    roots.forEach((root, i) => assert.equal(disk.workspaces.find((entry: { root: string }) => entry.root === root)?.id, results[i]?.id));
    assert.equal(results.filter(result => result.created).length, sameRoot ? 1 : 2);
  });
}
