import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { WorkService } from "../../src/tasks/work-service.js";
import { RegisteredWorkspaceRegistry } from "../../src/workspaces/registered-workspace-registry.js";
import { HostPolicy } from "../../src/host/host-policy.js";

// Include the standalone deployment suite in the existing npm test command and CI.
await import(pathToFileURL(resolve("tests/deployment/deploy-windows.test.mjs")).href);
const { acquireLock } = await import(pathToFileURL(resolve("scripts/deploy-windows.mjs")).href);

test("deployment registry lock prevents a real WorkService executor from starting", async t => {
  const parent = resolve("codex-generated", "deployment-tests");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "work-service-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = join(root, "works.json");
  const policy = await HostPolicy.create({ version: 1, codex_homes: [root] }, join(root, "policy.json"));
  let launched = false;
  const service = new WorkService(registry, new RegisteredWorkspaceRegistry([{ id: "project", root }]),
    () => { launched = true; throw new Error("Executor must not start"); }, policy);
  service.load();
  const before = readFileSync(registry, "utf8");
  const release = acquireLock(registry + ".lock", "deployment integration test");
  try {
    await assert.rejects(service.temp({ workspace_id: "project", instruction: "must wait" }), /Registry write is busy/u);
    assert.equal(launched, false);
    assert.equal(readFileSync(registry, "utf8"), before);
  } finally { release(); }
});
