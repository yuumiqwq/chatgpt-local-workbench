import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { CoreError, CodexRpcError, serializeError } from "../../src/core/errors.js";
import { WorkService } from "../../src/tasks/work-service.js";
import { RegisteredWorkspaceRegistry } from "../../src/workspaces/registered-workspace-registry.js";
import { HostPolicy } from "../../src/host/host-policy.js";
import type { ExecutorFactory, ExecutorName } from "../../src/tasks/execution-types.js";
import type { ExecutorRequest, ExecutorResult } from "../../src/executors/executor.js";

async function fixture(t: { after(fn: () => void): void }, execute?: (r: ExecutorRequest) => Promise<ExecutorResult>) {
  const root = mkdtempSync(join(tmpdir(), "bridge-work-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const policy = await HostPolicy.create({ version: 1, enabled: true, read_roots: [root],
    write_roots: [root], codex_homes: [root] }, join(root, "policy.json"));
  const registry = new RegisteredWorkspaceRegistry([{ id: "project", root }]);
  const requests: ExecutorRequest[] = [];
  const executors: ExecutorName[] = [];
  const nativeCalls: string[] = [];
  const factory: ExecutorFactory = executor => ({ execute: async request => {
    executors.push(executor);
    requests.push(request);
    if (execute) return execute(request);
    const threadId = request.threadId ?? randomUUID();
    request.onThreadId?.(threadId);
    return { kind: "completed", output: "result:" + request.instruction, threadId };
  }});
  const path = join(root, "work.json");
  const create = () => new WorkService(path, registry, factory, policy, async (_home, method) => {
    nativeCalls.push(method); return {};
  }, async (_policy, threadId) => ({ threadId, cwd: root, codexHome: root, rolloutPath: join(root, threadId + ".jsonl") }));
  const service = create();
  return { root, path, requests, executors, nativeCalls, service, create };
}

test("lazy work creation, project lookup and paginated duplicate names", async t => {
  const f = await fixture(t);
  const a = await f.service.open({ workspace_id: "project", name: "same" });
  const b = await f.service.open({ workspace_id: "project", name: "same" });
  assert.notEqual(a.work_id, b.work_id);
  assert.equal(f.requests.length, 0);
  assert.equal(a.thread_id, undefined);
  const page = f.service.list({ workspace_id: "project", query: "SAME", limit: 1 });
  assert.equal(page.total, 2); assert.equal(page.next_offset, 1);
  assert.equal(f.service.list({ offset: 1, limit: 1 }).works.length, 1);
});

test("native UUID and write access survive restart; semantic completion is separate", async t => {
  const f = await fixture(t);
  const work = await f.service.open({ workspace_id: "project", name: "persist" });
  const first = await f.service.continue(work.work_id, { instruction: "one" });
  const a = await f.service.waitTask(first.task_id);
  assert.equal(a?.state, "completed");
  assert.equal(f.service.list().works[0]?.status, "active");
  f.service.finish(work.work_id, "done", ["commit:abc"]);
  const restored = f.create(); restored.load();
  assert.equal(restored.taskView(first.task_id)?.output, "result:one");
  await restored.open({ work_id: work.work_id });
  const second = await restored.continue(work.work_id, { instruction: "two" });
  const b = await restored.waitTask(second.task_id);
  assert.equal(b?.threadId, a?.threadId);
  assert.equal(f.requests[1]?.sandbox, "danger-full-access");
  assert.equal(f.requests[1]?.threadId, a?.threadId);
});

test("RPC metadata and legacy errors survive result reads, registry reload and missing result files", async t => {
  for (const error of [
    serializeError(new CodexRpcError("thread/resume", -32600, "thread_busy")),
    serializeError(new CodexRpcError("turn/start", -32603, "unknown")),
    serializeError(new CoreError("CODEX_EXECUTION_FAILED"))
  ]) {
    const f = await fixture(t, async () => ({ kind: "failed", error }));
    const work = await f.service.open({ thread_id: randomUUID(), access: "read-only" });
    const run = await f.service.continue(work.work_id, { instruction: "inspect" });
    const result = await f.service.waitTask(run.task_id);
    assert.equal(result?.state, "failed");
    assert.deepEqual(result?.error, error);
    assert.deepEqual(f.service.list().works[0]?.last_run?.error, error);

    const restored = f.create(); restored.load();
    assert.deepEqual(restored.taskView(run.task_id)?.error, error);
    assert.deepEqual(restored.list().works[0]?.last_run?.error, error);
    assert.equal(restored.list().works[0]?.thread_id, work.thread_id);
    assert.equal(restored.list().works[0]?.access, "read-only");
    rmSync(join(restored.resultDirectory, run.task_id + ".json"));
    assert.deepEqual(restored.taskView(run.task_id)?.error, error);
  }
});

test("adoption is idempotent and conflicting selectors fail", async t => {
  const f = await fixture(t); const thread = randomUUID();
  const [a,b] = await Promise.all([f.service.open({ thread_id: thread }), f.service.open({ thread_id: thread })]);
  assert.equal(a.work_id,b.work_id);
  assert.equal(f.service.list().total,1);
  await assert.rejects(f.service.open({work_id:a.work_id,thread_id:randomUUID()}),{code:"WORK_ID_CONFLICT"});
});

test("temporary execution persists only its result, never replaces parent history", async t => {
  const f = await fixture(t);
  const work = await f.service.open({thread_id:randomUUID()});
  const run = await f.service.temp({work_id:work.work_id,instruction:"draft patch"});
  await f.service.waitTask(run.task_id);
  assert.equal(f.requests[0]?.ephemeral,true);
  assert.equal(f.requests[0]?.threadId,undefined);
  assert.equal(f.service.taskView(run.task_id)?.threadId,undefined);
  assert.equal(f.service.list().works[0]?.thread_id,work.thread_id);
  assert.equal(JSON.parse(readFileSync(f.path,"utf8")).runs[0].thread_id,undefined);
});

for (const executor of ["codex", "dsh"] as const) {
  for (const access of [undefined, "read-only", "danger-full-access"] as const) {
    for (const selector of ["workspace_id", "cwd", "work_id"] as const) {
      test(`${executor} temporary ${access ?? "default"} access via ${selector} is executed and retained`, async t => {
        let complete!: (result: ExecutorResult) => void;
        const f = await fixture(t, () => new Promise(resolve => { complete = resolve; }));
        const expected = access ?? "danger-full-access";
        const parentAccess = expected === "read-only" ? "danger-full-access" : "read-only";
        const parent = selector === "work_id"
          ? await f.service.open({ thread_id: randomUUID(), access: parentAccess }) : undefined;
        const target = selector === "work_id" ? { work_id: parent!.work_id }
          : selector === "workspace_id" ? { workspace_id: "project" } : { cwd: f.root };
        const run = await f.service.temp({ ...target, executor, instruction: "inspect or edit", ...(access ? { access } : {}) });
        assert.equal(run.access, expected);
        assert.equal(f.service.taskView(run.task_id)?.access, expected);
        assert.equal(f.service.taskView(run.task_id)?.state, "running");
        assert.deepEqual(f.executors, [executor]);
        assert.equal(f.requests[0]?.sandbox, expected);
        assert.equal(f.requests[0]?.ephemeral, true);
        assert.equal(f.requests[0]?.threadId, undefined);
        complete({ kind: "completed", output: "finished" });
        const result = await f.service.waitTask(run.task_id);
        assert.equal(result?.state, "completed");
        assert.equal(result?.access, expected);
        assert.equal(result?.executor, executor);
        const stored = JSON.parse(readFileSync(run.result_file, "utf8"));
        assert.equal(stored.access, expected);
        assert.equal(stored.executor, executor);
        const restored = f.create(); restored.load();
        assert.equal(restored.taskView(run.task_id)?.access, expected);
        assert.equal(restored.taskView(run.task_id)?.threadId, undefined);
        assert.equal(JSON.parse(readFileSync(f.path, "utf8")).runs[0].access, expected);
        if (parent) {
          assert.equal(restored.list().works[0]?.access, parentAccess);
          assert.equal(restored.list().works[0]?.thread_id, parent.thread_id);
          assert.equal(restored.list().works[0]?.last_run?.access, expected);
        }
      });
    }
  }
}

test("durable Codex work inherits and updates access across restart", async t => {
  const f = await fixture(t);
  const work = await f.service.open({ workspace_id: "project", access: "read-only" });
  const first = await f.service.continue(work.work_id, { instruction: "inspect" });
  await f.service.waitTask(first.task_id);
  assert.equal(f.requests[0]?.sandbox, "read-only");
  const second = await f.service.continue(work.work_id, { instruction: "edit", access: "danger-full-access" });
  await f.service.waitTask(second.task_id);
  const restored = f.create(); restored.load();
  const third = await restored.continue(work.work_id, { instruction: "finish editing" });
  await restored.waitTask(third.task_id);
  assert.deepEqual(f.requests.map(request => request.sandbox), ["read-only", "danger-full-access", "danger-full-access"]);
  assert.deepEqual(f.executors, ["codex", "codex", "codex"]);
  assert.equal(restored.list().works[0]?.access, "danger-full-access");
});

test("own overlapping turns and finish while running are rejected; wait abort does not stop execution", async t => {
  let complete!: (r: ExecutorResult) => void;
  const f = await fixture(t, () => new Promise(resolve => { complete = resolve; }));
  const work = await f.service.open({ workspace_id:"project" });
  const run = await f.service.continue(work.work_id,{instruction:"wait"});
  await assert.rejects(f.service.continue(work.work_id,{instruction:"duplicate"}),{code:"WORK_BUSY"});
  assert.throws(()=>f.service.finish(work.work_id,"done"),{code:"WORK_BUSY"});
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.service.waitTask(run.task_id,1,controller.signal),{name:"AbortError"});
  assert.equal(f.service.hasPendingTasks(),true);
  complete({kind:"completed",output:"done"});
  assert.equal((await f.service.waitTask(run.task_id))?.state,"completed");
});

test("restart marks an unfinished execution interrupted without inventing recovery", async t => {
  const f = await fixture(t);
  const work = await f.service.open({workspace_id:"project"});
  const data=JSON.parse(readFileSync(f.path,"utf8"));
  const taskId=randomUUID();
  data.runs=[{task_id:taskId,work_id:work.work_id,ephemeral:false,executor:"codex",state:"running",
    access:"workspace-write",created_at:new Date().toISOString(),updated_at:new Date().toISOString()}];
  writeFileSync(f.path,JSON.stringify(data));
  const restored=f.create();restored.load();
  assert.equal(restored.hasPendingTasks(),false);
  assert.equal(restored.taskView(taskId)?.error?.code,"TASK_INTERRUPTED");
});

test("archive/reopen keeps UUID; deleting history keeps lineage and recreates with summary", async t => {
  const f=await fixture(t);
  const work=await f.service.open({thread_id:randomUUID(),name:"work"});
  f.service.finish(work.work_id,"Remember outcome",["proof.txt"]);
  await f.service.manage(work.work_id,"archive");
  await f.service.open({work_id:work.work_id});
  assert.deepEqual(f.nativeCalls,["thread/archive","thread/unarchive"]);
  await f.service.manage(work.work_id,"delete_history");
  const before=f.service.list().works[0]!;
  assert.equal(before.thread_id,undefined);assert.deepEqual(before.previous_threads,[work.thread_id]);
  const run=await f.service.continue(work.work_id,{instruction:"again"});
  await f.service.waitTask(run.task_id);
  assert.notEqual(f.service.taskView(run.task_id)?.threadId,work.thread_id);
  assert.match(f.requests[0]!.instruction,/Remember outcome/);
  assert.match(f.requests[0]!.instruction,/proof.txt/);
});

test("failed native management leaves registered history unchanged",async t=>{
  const f=await fixture(t);
  const work=await f.service.open({thread_id:randomUUID()});
  const policy=await HostPolicy.create({version:1},join(f.root,"other-policy"));
  const broken=new WorkService(f.path,new RegisteredWorkspaceRegistry([]),()=>{throw Error();},policy,async()=>{throw Error("rpc failed");});
  broken.load();
  await assert.rejects(broken.manage(work.work_id,"delete_history"));
  assert.equal(broken.list().works[0]?.thread_id,work.thread_id);
});

test("bounded result retention prunes results across restart but keeps work summaries",async t=>{
  const f=await fixture(t);
  const work=await f.service.open({workspace_id:"project"});
  f.service.configureRetention({max_results:1});
  const a=await f.service.temp({work_id:work.work_id,instruction:"a"});await f.service.waitTask(a.task_id);
  const b=await f.service.temp({work_id:work.work_id,instruction:"b"});await f.service.waitTask(b.task_id);
  f.service.finish(work.work_id,"long lived");
  const restored=f.create();restored.load();
  assert.equal(restored.taskView(a.task_id),undefined);
  assert.equal(restored.taskView(b.task_id)?.output,"result:b");
  assert.equal(readdirSync(restored.resultDirectory).length,1);
  assert.equal(restored.list().works[0]?.summary,"long lived");
});

test("result persistence failure leaves a terminal error instead of a permanently running task", async t => {
  let complete!: (result: ExecutorResult) => void;
  const f = await fixture(t, () => new Promise(resolve => { complete = resolve; }));
  const run = await f.service.temp({ workspace_id: "project", instruction: "work completed" });
  // An existing directory at the result filename forces an atomic rename failure.
  mkdirSync(run.result_file, { recursive: true });
  complete({ kind: "completed", output: "finished" });
  await new Promise<void>(resolve => setImmediate(resolve));
  const result = f.service.taskView(run.task_id);
  assert.equal(result?.ready, true);
  assert.equal(result?.state, "failed");
  assert.equal(result?.error?.code, "WORK_RESULT_WRITE_FAILED");
  assert.equal(f.service.hasPendingTasks(), false);
  assert.deepEqual(readdirSync(f.service.resultDirectory), [run.task_id + ".json"]);
  const restored = f.create(); restored.load();
  assert.equal(restored.taskView(run.task_id)?.error?.code, "WORK_RESULT_WRITE_FAILED");
});

test("retention defaults do not delete history and configured age rules apply without purpose categories",async t=>{
  const f=await fixture(t);
  const work=await f.service.open({thread_id:randomUUID()});
  f.service.finish(work.work_id,"done");
  const data=JSON.parse(readFileSync(f.path,"utf8"));data.works[0].updated_at="2000-01-01T00:00:00.000Z";
  writeFileSync(f.path,JSON.stringify(data));
  const restored=f.create();restored.load();await restored.sweep();
  assert.equal(f.nativeCalls.length,0);
  restored.configureRetention({archive_completed_days:1});await restored.sweep();
  assert.deepEqual(f.nativeCalls,["thread/archive"]);
  assert.equal(restored.list().works[0]?.archived,true);
});

test("forget preserves native history and rejects corrupted persistence",async t=>{
  const f=await fixture(t);
  const work=await f.service.open({thread_id:randomUUID()});
  await f.service.manage(work.work_id,"forget");
  assert.equal(f.nativeCalls.length,0);assert.equal(f.service.list().total,0);
  writeFileSync(f.path,"invalid");
  assert.throws(()=>f.create().load());
});

test("two Bridge instances preserve each other's work and observe deletion", async t => {
  const f = await fixture(t);
  const other = f.create(); other.load();
  const first = await f.service.open({ workspace_id: "project", name: "first" });
  const second = await other.open({ workspace_id: "project", name: "second" });
  assert.equal(f.service.list().total, 2);
  f.service.finish(first.work_id, "first done");
  other.finish(second.work_id, "second done");
  assert.equal(f.service.list().works.filter(w => w.status === "completed").length, 2);
  await other.manage(second.work_id, "forget");
  await f.service.sweep();
  assert.equal(f.service.list().total, 1);
});

test("another live Bridge owner is not reported interrupted on load", async t => {
  let finish!: (result: ExecutorResult) => void;
  const f = await fixture(t, () => new Promise(resolve => { finish = resolve; }));
  const work = await f.service.open({ workspace_id: "project" });
  const run = await f.service.continue(work.work_id, { instruction: "running" });
  const observer = f.create(); observer.load();
  assert.equal(observer.taskView(run.task_id)?.state, "running");
  finish({ kind: "completed", output: "shared result" });
  await f.service.waitTask(run.task_id);
  assert.equal(observer.taskView(run.task_id)?.output, "shared result");
  assert.equal(observer.hasPendingTasks(), false);
});

test("concurrent archived history adoption keeps one work record", async t => {
  const f = await fixture(t);
  const policy = await HostPolicy.create({ version: 1, codex_homes: [f.root] }, join(f.root, "archive-policy"));
  const service = new WorkService(f.path, new RegisteredWorkspaceRegistry([]),
    () => { throw Error("Adoption must not execute a model"); }, policy,
    async () => { await Promise.resolve(); return {}; },
    async (_policy, threadId) => ({ threadId, cwd: f.root, codexHome: f.root,
      rolloutPath: join(f.root, "archived_sessions", threadId + ".jsonl") }));
  const threadId = randomUUID();
  const [a, b] = await Promise.all([service.open({ thread_id: threadId }), service.open({ thread_id: threadId })]);
  assert.equal(a.work_id, b.work_id);
  assert.equal(service.list().total, 1);
});

for (const lookupFails of [false, true]) {
  test(`unarchive stays persisted when session lookup ${lookupFails ? "fails" : "overlaps status queries"}`, async t => {
    const f = await fixture(t);
    const work = await f.service.open({ thread_id: randomUUID() });
    await f.service.manage(work.work_id, "archive");
    const policy = await HostPolicy.create({ version: 1, codex_homes: [f.root] }, join(f.root, "archive-policy"));
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const located = new Promise<void>(resolve => { entered = resolve; });
    t.after(release);
    const calls: string[] = [];
    const service = new WorkService(f.path, new RegisteredWorkspaceRegistry([]),
      () => ({ execute: async () => ({ kind: "completed", output: "continued" }) }), policy,
      async (_home, method) => { calls.push(method); return {}; },
      async (_policy, threadId) => {
        entered(); await gate;
        if (lookupFails) throw new Error("Session lookup failed");
        return { threadId, cwd: f.root, codexHome: f.root, rolloutPath: join(f.root, threadId + ".jsonl") };
      });
    service.load();
    const continuing = service.continue(work.work_id, { instruction: "resume" });
    await located;
    // Readers in this instance and another process must see the native transition.
    service.list(); service.taskView(randomUUID());
    const during = f.create().list().works[0];
    release();
    if (lookupFails) await assert.rejects(continuing, /Session lookup failed/);
    else {
      const run = await continuing;
      assert.equal((await service.waitTask(run.task_id))?.state, "completed");
    }
    assert.deepEqual(calls, ["thread/unarchive"]);
    assert.equal(during?.archived, false);
    assert.equal(f.create().list().works[0]?.archived, false);
    assert.equal(service.hasPendingTasks(), false);
  });
}

test("legacy workspace-write setting resumes with full access while old runs remain historical", async t => {
  const f = await fixture(t);
  const work = await f.service.open({ workspace_id: "project" });
  const data = JSON.parse(readFileSync(f.path, "utf8"));
  data.works[0].access = "workspace-write";
  writeFileSync(f.path, JSON.stringify(data));
  const restored = f.create(); restored.load();
  assert.equal(restored.list().works[0]?.access, "danger-full-access");
  const run = await restored.continue(work.work_id, { instruction: "finish" });
  await restored.waitTask(run.task_id);
  assert.equal(f.requests[0]?.sandbox, "danger-full-access");
  assert.equal(JSON.parse(readFileSync(f.path, "utf8")).works[0].access, "danger-full-access");
});
