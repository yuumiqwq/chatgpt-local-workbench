import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HostPolicy } from "../../../src/host/host-policy.js";
import { registerHostTools } from "../../../src/host/host-tools.js";
import { launchProcess, MAX_HOST_PROCESSES, PROCESS_OUTPUT_BYTES } from "../../../src/host/process-runtime.js";
import { WorkService } from "../../../src/tasks/work-service.js";
import { RegisteredWorkspaceRegistry } from "../../../src/workspaces/registered-workspace-registry.js";
import { registerTaskControlTool, registerTaskResultTools } from "../../../src/task-result-tools.js";
import { processIsAlive } from "../../../src/core/file-store.js";

async function fixture(t: TestContext, config: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "bridge-process-"));
  const cwd = join(root, "allowed space"); mkdirSync(cwd);
  const policy = await HostPolicy.create({ version: 1, enabled: true, commands_enabled: true,
    command_roots: [cwd], read_roots: [cwd], ...config }, join(root, "policy.json"));
  let agents = 0;
  const create = () => new WorkService(join(root, "work.json"), new RegisteredWorkspaceRegistry([{ id: "project", root: cwd }]),
    () => ({ execute: async () => { agents++; return { kind: "completed", output: "agent" }; } }), policy);
  const service = create(); service.load();
  t.after(async () => { await service.shutdownHostProcesses(); rmSync(root, { recursive: true, force: true }); });
  const start = (source: string, timeout_seconds?: number) => service.startHostProcess({ executable: process.execPath,
    args: ["-e", source], cwd, ...(timeout_seconds === undefined ? {} : { timeout_seconds }) });
  return { root, cwd, policy, service, create, start, agents: () => agents };
}

async function until(predicate: () => boolean, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (!predicate()) { assert.ok(Date.now() < end, "condition timed out"); await sleep(25); }
}

test("native success preserves argv/cwd, stdout/stderr and reloadable result without invoking an agent", async t => {
  const f = await fixture(t);
  const argument = "spaces 中文 ; & $(not-a-shell)";
  const receipt = await f.service.startHostProcess({ executable: process.execPath, cwd: f.cwd,
    args: ["-e", "console.log(JSON.stringify([process.cwd(), process.argv[1]])); console.error('diagnostic');", argument] });
  const view = await f.service.waitTask(receipt.task_id, 10);
  assert.equal(view?.kind, "process"); assert.equal(view?.state, "completed");
  assert.equal(view?.process?.exit_code, 0);
  assert.deepEqual(JSON.parse(view!.process!.stdout), [f.cwd, argument]);
  assert.equal(view?.process?.stderr.trim(), "diagnostic");
  assert.equal(view?.executor, undefined); assert.equal(view?.threadId, undefined); assert.equal(view?.access, undefined);
  assert.equal(f.agents(), 0); assert.equal(f.service.list().total, 0);
  assert.deepEqual(f.create().taskView(receipt.task_id)?.process, view?.process);
  const run = JSON.parse(readFileSync(f.service.path, "utf8")).runs[0];
  for (const key of ["access", "executor", "work_id", "thread_id", "ephemeral"]) assert.equal(key in run, false);
});

test("nonzero exit, signal exit and spawn failure produce observed terminal outcomes", async t => {
  const f = await fixture(t);
  const failed = await f.start("console.error('failed');process.exitCode=7");
  const result = await f.service.waitTask(failed.task_id, 10);
  assert.equal(result?.state, "failed"); assert.equal(result?.process?.exit_code, 7);
  assert.equal(result?.error?.code, "HOST_PROCESS_FAILED");
  const signal = await f.start("process.kill(process.pid, 'SIGTERM')");
  assert.equal((await f.service.waitTask(signal.task_id, 10))?.state, "failed");
  const executable = join(f.cwd, process.platform === "win32" ? "invalid.exe" : "invalid");
  writeFileSync(executable, "not an executable", { mode: 0o600 });
  const invalid = await f.service.startHostProcess({ executable, args: [], cwd: f.cwd });
  const invalidResult = await f.service.waitTask(invalid.task_id, 10);
  assert.equal(invalidResult?.error?.code, "HOST_PROCESS_START_FAILED");
  assert.equal(invalidResult?.process?.spawn_failed, true);
  assert.equal(invalidResult?.process?.exit_code, null);
});

test("capture is bounded across both streams and drains excessive output without blocking", async t => {
  const f = await fixture(t);
  const task = await f.start("process.stdout.write('x'.repeat(2000000));process.stderr.write('y'.repeat(2000000));");
  const result = (await f.service.waitTask(task.task_id, 10))!.process!;
  assert.equal(result.exit_code, 0); assert.equal(result.truncated, true);
  assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), PROCESS_OUTPUT_BYTES);
});

test("wait timeout and cancellation preserve the process, progress is readable from another service", async t => {
  const f = await fixture(t);
  const task = await f.start("console.log('started');setInterval(()=>{},1000)");
  const waiting = await f.service.waitTask(task.task_id, 1);
  assert.equal(waiting?.ready, false); assert.equal(waiting?.state, "running");
  await until(() => f.create().taskView(task.task_id)?.process?.stdout.includes("started") ?? false);
  const abort = new AbortController();
  const pending = f.service.waitTask(task.task_id, 10, abort.signal);
  abort.abort(); await assert.rejects(pending, { name: "AbortError" });
  assert.equal(f.service.taskView(task.task_id)?.ready, false);
  await assert.rejects(f.create().controlTask(task.task_id, "interrupt"), { code: "TASK_NOT_RUNNING" });
  await assert.rejects(f.service.controlTask(task.task_id, "steer", "input"), { code: "UNSUPPORTED_ACTION" });
  await f.service.controlTask(task.task_id, "interrupt");
  await f.service.controlTask(task.task_id, "interrupt");
  const result = await f.service.waitTask(task.task_id, 10);
  assert.equal(result?.error?.code, "TASK_INTERRUPTED");
  assert.equal(result?.process?.cancelled, true); assert.ok(result?.process?.ended_at);
  assert.equal(processIsAlive(result!.process!.pid!), false);
});

test("deadline kills a real process; immediate interrupt and shutdown also cover queued startup", async t => {
  const f = await fixture(t);
  const task = await f.start("setInterval(()=>{},1000)", 1);
  const result = await f.service.waitTask(task.task_id, 10);
  assert.equal(result?.error?.code, "EXECUTION_DEADLINE_EXCEEDED");
  assert.equal(result?.process?.timed_out, true);
  assert.equal(processIsAlive(result!.process!.pid!), false);
  const queued = await f.start("setInterval(()=>{},1000)");
  await f.service.controlTask(queued.task_id, "interrupt");
  assert.equal((await f.service.waitTask(queued.task_id, 10))?.process?.cancelled, true);
  const shutdown = await f.start("setInterval(()=>{},1000)");
  await f.service.shutdownHostProcesses();
  assert.equal(f.service.taskView(shutdown.task_id)?.process?.stop_reason, "shutdown");
  await assert.rejects(f.start("0"), { code: "HOST_PROCESS_CLOSING" });
});

test("interrupt terminates an ordinary child tree, including children with inherited pipes", async t => {
  const f = await fixture(t);
  const task = await f.start("const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit',windowsHide:true});console.log(child.pid);setInterval(()=>{},1000)");
  await until(() => !!f.service.taskView(task.task_id)?.process?.stdout.trim());
  const childPid = Number(f.service.taskView(task.task_id)!.process!.stdout.trim());
  assert.equal(processIsAlive(childPid), true);
  t.after(() => { try { process.kill(childPid, "SIGKILL"); } catch { /* already stopped */ } });
  await f.service.controlTask(task.task_id, "interrupt");
  const result = await f.service.waitTask(task.task_id, 10);
  assert.equal(result?.ready, true);
  await until(() => !processIsAlive(childPid));
});

test("policy, executable, cwd and timeout validation reject before creating a run", async t => {
  for (const [config, code] of [[{ enabled: false }, "HOST_DISABLED"], [{ commands_enabled: false }, "HOST_COMMAND_DISABLED"]] as const) {
    const f = await fixture(t, config); await assert.rejects(f.start("0"), { code });
    assert.equal(JSON.parse(readFileSync(f.service.path, "utf8")).runs.length, 0);
  }
  const f = await fixture(t);
  const base = { executable: process.execPath, args: [], cwd: f.cwd };
  for (const change of [{ cwd: f.root }, { cwd: "relative" }, { cwd: join(f.cwd, "absent") },
    { executable: "node" }, { args: ["bad\0argument"] }, { timeout_seconds: 0 }, { timeout_seconds: Infinity },
    { timeout_seconds: 604801 }]) await assert.rejects(f.service.startHostProcess({ ...base, ...change }));
  const file = join(f.cwd, "file"); writeFileSync(file, "x");
  await assert.rejects(f.service.startHostProcess({ ...base, cwd: file }), { code: "HOST_INVALID_CWD" });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.service.startHostProcess(base, undefined, abort.signal), { name: "AbortError" });
  assert.equal(JSON.parse(readFileSync(f.service.path, "utf8")).runs.length, 0);
});

test("concurrent starts reserve capacity before asynchronous validation and release it after exit", async t => {
  const f = await fixture(t);
  const starts = await Promise.allSettled(Array.from({ length: MAX_HOST_PROCESSES + 2 }, () => f.start("setInterval(()=>{},1000)")));
  const accepted = starts.filter(item => item.status === "fulfilled");
  assert.equal(accepted.length, MAX_HOST_PROCESSES);
  for (const item of starts) if (item.status === "rejected") assert.equal(item.reason.code, "HOST_PROCESS_LIMIT");
  assert.equal(f.service.hasPendingTasks(), true);
  for (const item of accepted) await f.service.controlTask(item.value.task_id, "interrupt");
  await Promise.all(accepted.map(item => f.service.waitTask(item.value.task_id, 10)));
  const next = await f.start("0"); assert.equal((await f.service.waitTask(next.task_id, 10))?.state, "completed");
  assert.equal(f.service.hasPendingTasks(), false);
});

test("maintenance guard covers full lifetime and rejected guard does not launch", async t => {
  const f = await fixture(t); let held = false;
  const args = { executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: f.cwd };
  const receipt = await f.service.startHostProcess(args, async operation => {
    held = true; try { return await operation(); } finally { held = false; }
  });
  assert.equal(held, true);
  await f.service.controlTask(receipt.task_id, "interrupt");
  await f.service.waitTask(receipt.task_id, 10); assert.equal(held, false);
  await assert.rejects(f.service.startHostProcess(args, async () => { throw new Error("blocked"); }), /blocked/);
  assert.equal(f.service.hasPendingTasks(), false);
});

test("legacy agent records remain readable alongside process results and share retention", async t => {
  const f = await fixture(t);
  const agent = await f.service.temp({ workspace_id: "project", instruction: "old client" });
  await f.service.waitTask(agent.task_id, 10);
  const disk = JSON.parse(readFileSync(f.service.path, "utf8"));
  delete disk.runs[0].kind; writeFileSync(f.service.path, JSON.stringify(disk));
  const restored = f.create(); restored.load();
  assert.equal(restored.taskView(agent.task_id)?.output, "agent");
  const native = await f.start("0"); await f.service.waitTask(native.task_id, 10);
  f.service.configureRetention({ max_results: 1 });
  assert.equal(f.service.taskView(agent.task_id), undefined);
  assert.equal(f.service.taskView(native.task_id)?.state, "completed");
});

test("dead owner recovery retains partial output but never invents an exit code or resumes", async t => {
  const f = await fixture(t);
  const task = await f.start("console.log('saved')"); await f.service.waitTask(task.task_id, 10);
  const disk = JSON.parse(readFileSync(f.service.path, "utf8"));
  disk.runs[0].state = "running"; delete disk.runs[0].owner_pid;
  writeFileSync(f.service.path, JSON.stringify(disk));
  const snapshot = JSON.parse(readFileSync(task.result_file, "utf8"));
  delete snapshot.process.ended_at; snapshot.process.exit_code = null;
  writeFileSync(task.result_file, JSON.stringify(snapshot));
  const restored = f.create(); restored.load();
  const result = restored.taskView(task.task_id);
  assert.equal(result?.state, "failed"); assert.equal(result?.process?.outcome_unknown, true);
  assert.equal(result?.process?.exit_code, null); assert.equal(result?.process?.stdout.trim(), "saved");
  assert.equal(restored.hasPendingTasks(), false);
});

test("supervisor cleans the process after abrupt owner death", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const module = new URL("../../../src/host/host-process.js", import.meta.url).href;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", `
    import { superviseProcess } from ${JSON.stringify(module)};
    superviseProcess(${JSON.stringify({ executable: process.execPath, cwd: f.cwd, args: ["-e", "setInterval(()=>{},1000)"] })},
      view => { if (view.pid) process.stdout.write(String(view.pid) + '\\n'); });
  `], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = ""; owner.stdout.on("data", chunk => { output += String(chunk); });
  t.after(() => { owner.kill("SIGKILL"); });
  await until(() => /^\d+/u.test(output));
  const pid = Number(output.trim().split("\n")[0]);
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ } });
  const exited = once(owner, "exit"); owner.kill("SIGKILL"); await exited;
  await until(() => !processIsAlive(pid));
});

test("native runtime reports a late interrupt as a request only while still executing", async () => {
  const execution = launchProcess({ executable: process.execPath, args: ["-e", "0"], cwd: process.cwd() });
  const result = await execution.done;
  execution.stop("interrupt");
  assert.equal(result.exit_code, 0); assert.equal(execution.snapshot().cancelled, false);
});

test("output storage failure stops the process and reports persistence failure, never success", async t => {
  const f = await fixture(t);
  writeFileSync(f.service.resultDirectory, "block result directory creation");
  const task = await f.start("setInterval(()=>{},1000)");
  await until(() => JSON.parse(readFileSync(f.service.path, "utf8")).runs[0]?.state === "failed");
  assert.equal(f.service.taskView(task.task_id)?.error?.code, "WORK_RESULT_WRITE_FAILED");
  assert.equal(f.service.hasPendingTasks(), false);
});

test("an observed final result wins over stale running registry metadata after restart", async t => {
  const f = await fixture(t);
  const task = await f.start("console.log('final')"); await f.service.waitTask(task.task_id, 10);
  const disk = JSON.parse(readFileSync(f.service.path, "utf8"));
  disk.runs[0].state = "running"; delete disk.runs[0].owner_pid;
  writeFileSync(f.service.path, JSON.stringify(disk));
  const restored = f.create(); restored.load();
  assert.equal(restored.taskView(task.task_id)?.state, "completed");
  assert.equal(restored.taskView(task.task_id)?.process?.exit_code, 0);
  assert.equal(restored.hasPendingTasks(), false);
  const snapshot = JSON.parse(readFileSync(task.result_file, "utf8"));
  delete snapshot.process.ended_at; snapshot.process.exit_code = null;
  snapshot.process.outcome_unknown = true; snapshot.state = "failed";
  snapshot.error = { code: "HOST_PROCESS_OUTCOME_UNKNOWN", message: "Supervisor exited without an outcome." };
  writeFileSync(task.result_file, JSON.stringify(snapshot));
  writeFileSync(f.service.path, JSON.stringify(disk));
  const unknown = f.create(); unknown.load();
  assert.equal(unknown.taskView(task.task_id)?.error?.code, "HOST_PROCESS_OUTCOME_UNKNOWN");
  assert.equal(unknown.hasPendingTasks(), false);
});

test("independent service writers merge simultaneous native and agent task results", async t => {
  const f = await fixture(t); const second = f.create(); second.load();
  t.after(() => second.shutdownHostProcesses());
  const receipts = await Promise.all([
    ...Array.from({ length: 3 }, (_, index) => f.start(`console.log(${index})`)),
    ...Array.from({ length: 3 }, () => second.startHostProcess({ executable: process.execPath, args: ["-e", "0"], cwd: f.cwd })),
    f.service.temp({ workspace_id: "project", instruction: "one" }),
    second.temp({ workspace_id: "project", instruction: "two" })
  ]);
  await Promise.all(receipts.map(receipt => f.service.waitTask(receipt.task_id, 10)));
  for (const receipt of receipts) assert.equal(f.create().taskView(receipt.task_id)?.state, "completed");
  assert.equal(JSON.parse(readFileSync(f.service.path, "utf8")).runs.length, 8);
});

test("STDIO bridge close cleans its own native child and preserves a terminal record", async t => {
  const f = await fixture(t);
  const config = join(f.root, "stdio.json"); writeFileSync(config, "[]");
  writeFileSync(config + ".host-policy.json", JSON.stringify({ version: 1, enabled: true,
    commands_enabled: true, command_roots: [f.cwd] }));
  const client = new Client({ name: "stdio-native", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../../../src/mcp-stdio.js", import.meta.url)), config], stderr: "pipe" });
  t.after(() => client.close());
  await client.connect(transport);
  const started = await client.callTool({ name: "start_host_process", arguments: {
    executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: f.cwd } });
  const receipt = JSON.parse((started.content as { text: string }[])[0]!.text);
  let pid: number | undefined;
  for (let i = 0; i < 100 && !pid; i++) {
    const result = await client.callTool({ name: "task_result", arguments: { task_id: receipt.task_id } });
    pid = JSON.parse((result.content as { text: string }[])[0]!.text).process?.pid;
    if (!pid) await sleep(25);
  }
  assert.ok(pid);
  t.after(() => { try { process.kill(pid!, "SIGKILL"); } catch { /* already stopped */ } });
  await client.close();
  await until(() => !processIsAlive(pid!));
  const registry = JSON.parse(readFileSync(config + ".work-items.json", "utf8"));
  assert.equal(registry.runs[0].state, "failed");
});

test("native task outlives the synchronous 45 second cap without a model", { timeout: 70_000 }, async t => {
  const f = await fixture(t);
  const startedAt = performance.now();
  const task = await f.start("setTimeout(()=>console.log('past sync limit'),46000)");
  assert.ok(performance.now() - startedAt < 5000, "start must not wait for program completion");
  assert.equal((await f.service.waitTask(task.task_id, 1))?.ready, false);
  const result = await f.service.waitTask(task.task_id, 55);
  assert.equal(result?.state, "completed"); assert.ok(result!.elapsed_seconds! >= 45);
  assert.equal(result?.process?.stdout.trim(), "past sync limit"); assert.equal(f.agents(), 0);
});

test("MCP start/result/wait/control share task_id and enforce schemas and host policy", async t => {
  const f = await fixture(t);
  const server = new McpServer({ name: "process-test", version: "1" });
  registerHostTools(server, f.policy, { processTasks: f.service });
  registerTaskResultTools(server, f.service); registerTaskControlTool(server, f.service);
  const client = new Client({ name: "process-client", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(st); await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[])[0]!.text;
    return { error: result.isError, body: text.startsWith("{") ? JSON.parse(text) : { text } };
  };
  const names = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of ["start_host_process", "run_host_command", "task_result", "wait_task", "control_task"]) assert.ok(names.includes(name));
  assert.ok(!names.includes("get_task"));
  const base = { executable: process.execPath, args: ["-e", "console.log('progress');setInterval(()=>{},1000)"], cwd: f.cwd };
  assert.equal((await call("start_host_process", { ...base, cwd: f.root })).error, true);
  assert.equal((await call("start_host_process", { ...base, timeout_seconds: 0 })).error, true);
  const started = await call("start_host_process", base);
  const task_id = started.body.task_id; assert.equal(started.body.kind, "process");
  const waiting = await call("wait_task", { task_id, timeout_seconds: 1 });
  assert.equal(waiting.body.ready, false); assert.equal(waiting.body.kind, "process");
  assert.equal((await call("task_result", { task_id })).body.process.cwd, f.cwd);
  assert.equal((await call("control_task", { task_id, action: "steer", instruction: "x" })).body.error.code, "UNSUPPORTED_ACTION");
  await call("control_task", { task_id, action: "interrupt" });
  const finished = await call("wait_task", { task_id, timeout_seconds: 10 });
  assert.equal(finished.body.ready, true); assert.equal(finished.body.process.cancelled, true);
  assert.equal((await call("task_result", { task_id: "missing" })).error, true);
  const audit = readFileSync(f.policy.policyPath + ".audit.jsonl", "utf8");
  assert.ok(audit.includes("start_host_process")); assert.ok(!audit.includes("setInterval"));
});
