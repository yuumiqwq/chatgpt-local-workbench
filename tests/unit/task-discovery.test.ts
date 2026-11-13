import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WorkService } from "../../src/tasks/work-service.js";
import { HostPolicy } from "../../src/host/host-policy.js";
import { registerHostTools } from "../../src/host/host-tools.js";
import { RegisteredWorkspaceRegistry } from "../../src/workspaces/registered-workspace-registry.js";

const body = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0]!.text);
async function scratch() {
  const base = resolve("codex-generated/api-recovery-tests"); await mkdir(base, { recursive: true });
  return mkdtemp(join(base, "case-"));
}

test("lost native start receipt is recoverable through public task discovery across instances", async () => {
  const root = await scratch(), config = join(root, "workspaces.json"), allowed = join(root, "allowed");
  await mkdir(allowed); await writeFile(config, "[]");
  await writeFile(config + ".host-policy.json", JSON.stringify({ version: 1, enabled: true,
    commands_enabled: true, command_roots: [allowed], read_roots: [allowed] }));
  const owner = new Client({ name: "owner", version: "1" }), observer = new Client({ name: "observer", version: "1" });
  const connect = (client: Client) => client.connect(new StdioClientTransport({ command: process.execPath,
    args: [resolve("dist/src/mcp-stdio.js"), config], stderr: "pipe" }));
  try {
    await connect(owner); await connect(observer);
    const created_after = new Date().toISOString();
    // Deliberately discard the receipt: only list_tasks may recover its ID.
    assert.notEqual((await owner.callTool({ name: "start_host_process", arguments: { executable: process.execPath,
      cwd: allowed, args: ["-e", "console.log('OUTPUT_SECRET');setInterval(()=>{},1000)", "ARGV_SECRET"] } })).isError, true);
    const found = body(await observer.callTool({ name: "list_tasks", arguments: { kind: "process", created_after } }));
    assert.equal(found.total, 1); assert.equal(found.tasks[0].control_available, false);
    assert.doesNotMatch(JSON.stringify(found), /ARGV_SECRET|OUTPUT_SECRET|args|stdout|stderr|owner_pid/);
    assert.equal(body(await owner.callTool({ name: "list_work", arguments: {} })).total, 0);
    const task_id = found.tasks[0].task_id;
    assert.equal(body(await owner.callTool({ name: "list_tasks", arguments: { kind: "process" } })).tasks[0].control_available, true);
    assert.match(JSON.stringify(await observer.callTool({ name: "control_task", arguments: { task_id, action: "interrupt" } })), /TASK_NOT_RUNNING/);
    assert.equal(body(await observer.callTool({ name: "wait_task", arguments: { task_id, timeout_seconds: 1 } })).ready, false);
    assert.notEqual((await owner.callTool({ name: "control_task", arguments: { task_id, action: "interrupt" } })).isError, true);
    assert.equal(body(await owner.callTool({ name: "wait_task", arguments: { task_id, timeout_seconds: 10 } })).ready, true);
    const terminal = body(await observer.callTool({ name: "list_tasks", arguments: { state: "failed" } }));
    assert.equal(terminal.tasks[0].task_id, task_id); assert.equal(terminal.tasks[0].control_available, false);
    for (const args of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { state: "cancelled" }, { kind: "work" }, { created_after: "yesterday" }]) {
      assert.equal((await owner.callTool({ name: "list_tasks", arguments: args })).isError, true);
    }
    const before = await readFile(config + ".work-items.json", "utf8");
    await observer.callTool({ name: "list_tasks", arguments: {} });
    assert.equal(await readFile(config + ".work-items.json", "utf8"), before, "discovery does not save/rewrite registry");
  } finally { await owner.close(); await observer.close(); await rm(root, { recursive: true, force: true }); }
});

test("task metadata pagination covers legacy agents and processes without reading result payloads", async () => {
  const root = await scratch();
  try {
    const path = join(root, "store.json"), created = "2026-01-01T00:00:00.000Z";
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    await writeFile(path, JSON.stringify({ version: 1, works: [], runs: [
      { task_id: id(1), ephemeral: true, executor: "codex", state: "completed", access: "read-only", created_at: created, updated_at: created },
      { task_id: id(2), kind: "process", executable: process.execPath, cwd: root, state: "failed", created_at: created, updated_at: created },
      { task_id: id(3), kind: "agent", ephemeral: false, work_id: id(4), executor: "codex", state: "completed", access: "danger-full-access", created_at: "2026-02-01T00:00:00.000Z", updated_at: created }
    ] }));
    const policy = await HostPolicy.create({ version: 1 }, join(root, "policy"));
    const service = new WorkService(path, new RegisteredWorkspaceRegistry([]), () => { throw new Error("no execution"); }, policy);
    // No result files: discovery depends on metadata, not task_result sidecars.
    assert.deepEqual(service.listTasks({ limit: 1 }).tasks.map(task => task.task_id), [id(3)]);
    assert.equal(service.listTasks({ limit: 1 }).next_offset, 1);
    assert.deepEqual(service.listTasks({ offset: 1, limit: 2 }).tasks.map(task => task.task_id), [id(1), id(2)]);
    assert.equal(service.listTasks({ offset: 3 }).next_offset, null);
    assert.equal(service.listTasks({ kind: "agent" }).total, 2);
    assert.equal(service.listTasks({ state: "failed" }).total, 1);
    assert.equal(service.listTasks({ created_after: created }).total, 3);
    assert.equal(service.listTasks({ created_after: "2026-03-01T00:00:00.000Z" }).total, 0);
    assert.equal(service.listTasks().tasks.every(task => task.control_available === false), true);
    assert.equal(service.listTasks().tasks.find(task => task.task_id === id(1))!.kind, "agent");
    const disk = JSON.parse(await readFile(path, "utf8")); disk.runs = disk.runs.slice(1);
    await writeFile(path, JSON.stringify(disk));
    assert.equal(service.listTasks().total, 2, "refresh reflects pruning by another writer");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("post-operation audit failure preserves async receipt fields without replay", async () => {
  const root = await scratch(), policyPath = join(root, "policy"), auditPath = policyPath + ".audit.jsonl";
  const policy = await HostPolicy.create({ version: 1, enabled: true }, policyPath);
  const server = new McpServer({ name: "audit-fault", version: "1" });
  const receipt = { task_id: "00000000-0000-4000-8000-000000000001", kind: "process" as const, result_file: join(root, "result.json") };
  let dispatched = 0;
  registerHostTools(server, policy, { processTasks: { startHostProcess: async () => {
    dispatched++; await unlink(auditPath); await mkdir(auditPath);
    return receipt;
  } } });
  const client = new Client({ name: "audit-client", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b); await client.connect(a);
    const result = await client.callTool({ name: "start_host_process", arguments: { executable: process.execPath, cwd: root } });
    assert.deepEqual(body(result), receipt); assert.equal(dispatched, 1);
    assert.notEqual(result.isError, true); assert.match(JSON.stringify(result._meta), /audit_warning/);
  } finally { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});
