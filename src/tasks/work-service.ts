import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicJson, processIsAlive, withFileStoreLock } from "../core/file-store.js";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { newId } from "../core/ids.js";
import { serializeError, CoreError, CODEX_RPC_METHODS, CODEX_RPC_ERROR_CATEGORIES } from "../core/errors.js";
import type { Executor, ExecutorActivity, SandboxMode } from "../executors/executor.js";
import type { TaskView, ExecutorFactory, ExecutorName } from "./execution-types.js";
import { RegisteredWorkspaceRegistry } from "../workspaces/registered-workspace-registry.js";
import { HostError, HostPolicy } from "../host/host-policy.js";
import { locateCodexSession } from "../host/codex-sessions.js";
import { queryCodexThread } from "../host/codex-thread-list.js";
import { DEFAULT_WAIT_TASK_TIMEOUT_SECONDS, waitTaskMaxTimeoutSeconds } from "../runtime-config.js";

const WorkSchema = z.object({
  work_id: z.string().uuid(), name: z.string(), cwd: z.string(), workspace_id: z.string().optional(),
  codex_home: z.string(), thread_id: z.string().uuid().optional(), archived: z.boolean().default(false),
  previous_threads: z.array(z.string()).default([]),
  status: z.enum(["active", "completed"]).default("active"),
  access: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("danger-full-access")
    .transform(value => value === "workspace-write" ? "danger-full-access" as const : value),
  created_at: z.string(), updated_at: z.string(), summary: z.string().default(""),
  references: z.array(z.string()).default([]), last_task_id: z.string().optional()
});
export type Work = z.infer<typeof WorkSchema>;
const RunSchema = z.object({
  task_id: z.string().uuid(), work_id: z.string().uuid().optional(), ephemeral: z.boolean(),
  executor: z.enum(["codex", "dsh"]), state: z.enum(["queued", "running", "completed", "failed"]),
  access: z.enum(["read-only", "workspace-write", "danger-full-access"]), created_at: z.string(), updated_at: z.string(),
  thread_id: z.string().optional(), error: z.object({
    code: z.string(), message: z.string(),
    rpc_method: z.enum(CODEX_RPC_METHODS).optional(),
    rpc_error_code: z.number().int().safe().optional(),
    rpc_error_category: z.enum(CODEX_RPC_ERROR_CATEGORIES).optional()
  }).optional(),
  owner_pid: z.number().int().positive().optional()
});
type Run = z.infer<typeof RunSchema>;
const RetentionSchema = z.object({
  max_results: z.number().int().min(1).max(1000).default(100),
  result_days: z.number().positive().nullable().default(null),
  archive_completed_days: z.number().positive().nullable().default(null),
  delete_archived_days: z.number().positive().nullable().default(null)
});
const StoreSchema = z.object({
  version: z.literal(1), works: z.array(WorkSchema), runs: z.array(RunSchema),
  retention: RetentionSchema.default({})
});
type NativeCall = (home: string, method: string, params: Record<string, unknown>) => Promise<unknown>;
type SessionLocator = typeof locateCodexSession;
type TurnOptions = { instruction: string; model?: string | undefined; reasoning_effort?: string | undefined; access?: Exclude<SandboxMode, "workspace-write"> | undefined };
const now = () => new Date().toISOString();
function problem(code: string, message: string): never { throw new HostError(code, message); }

/** Durable work metadata, bounded run results and one native UUID per ongoing work.
 * Model decisions (meaning, completion and retention choices) remain caller-owned.
 * Busy checks coordinate this Bridge instance only, not other Codex clients.
 */
export class WorkService {
  private works = new Map<string, Work>();
  private runs = new Map<string, Run>();
  private live = new Map<string, { executor: Executor; evidence?: TaskView["evidence"]; activity?: ExecutorActivity; startedAtMs: number }>();
  private preparing = new Set<string>();
  private retention = RetentionSchema.parse({});
  private savedWorks = new Map<string, string>();
  private savedRuns = new Map<string, string>();
  private savedRetention = JSON.stringify(this.retention);
  readonly resultDirectory: string;

  constructor(readonly path: string, private registry: RegisteredWorkspaceRegistry,
    private factory: ExecutorFactory, private policy: HostPolicy,
    private native: NativeCall = queryCodexThread, private locate: SessionLocator = locateCodexSession) {
    this.resultDirectory = path + ".results";
  }

  load() {
    this.refresh();
    this.pruneResults();
    this.save();
  }

  private refresh() {
    let data;
    try { data = StoreSchema.parse(JSON.parse(readFileSync(this.path, "utf8").replace(/^\uFEFF/u, ""))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    // Retain object identity used by active executor callbacks.
    const works = new Map<string, Work>();
    for (const work of data.works) {
      const current = this.works.get(work.work_id);
      if (current) for (const key of Object.keys(current)) {
        if (!(key in work)) delete (current as unknown as Record<string, unknown>)[key];
      }
      works.set(work.work_id, current ? Object.assign(current, work) : work);
    }
    this.works = works;
    for (const run of data.runs) {
      if (!this.live.has(run.task_id)) this.runs.set(run.task_id, run);
    }
    const ids = new Set(data.runs.map(run => run.task_id));
    for (const id of this.runs.keys()) if (!ids.has(id) && !this.live.has(id)) this.runs.delete(id);
    this.retention = data.retention;
    this.remember();
    for (const run of this.runs.values()) {
      if ((run.state === "queued" || run.state === "running") &&
          (run.owner_pid === undefined || !processIsAlive(run.owner_pid))) {
        run.state = "failed";
        run.error = { code: "TASK_INTERRUPTED", message: "Bridge restarted; prior execution is no longer monitored. Check files and other clients before continuing." };
        run.updated_at = now();
      }
    }
  }

  private remember() {
    this.savedWorks = new Map([...this.works].map(([id, work]) => [id, JSON.stringify(work)]));
    this.savedRuns = new Map([...this.runs].map(([id, run]) => [id, JSON.stringify(run)]));
    this.savedRetention = JSON.stringify(this.retention);
  }

  private save() {
    withFileStoreLock(this.path, () => {
      let disk = StoreSchema.parse({ version: 1, works: [], runs: [] });
      try { disk = StoreSchema.parse(JSON.parse(readFileSync(this.path, "utf8").replace(/^\uFEFF/u, ""))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const merge = <T>(items: T[], key: (item: T) => string, current: Map<string, T>, saved: Map<string, string>) => {
        const result = new Map(items.map(item => [key(item), item]));
        for (const [id, item] of current) if (JSON.stringify(item) !== saved.get(id)) result.set(id, item);
        for (const id of saved.keys()) if (!current.has(id)) result.delete(id);
        return [...result.values()];
      };
      atomicJson(this.path, { version: 1,
        works: merge(disk.works, work => work.work_id, this.works, this.savedWorks),
        runs: merge(disk.runs, run => run.task_id, this.runs, this.savedRuns),
        retention: JSON.stringify(this.retention) === this.savedRetention ? disk.retention : this.retention });
      this.remember();
    });
  }
  private require(id: string) {
    this.refresh();
    const work = this.works.get(id);
    if (!work) problem("WORK_NOT_FOUND", "The work ID does not exist.");
    return work;
  }
  private busy(id: string) {
    return this.preparing.has(id) || [...this.runs.values()].some(run =>
      run.work_id === id && (run.state === "running" || run.state === "queued"));
  }
  hasPendingTasks() {
    this.refresh();
    return this.preparing.size > 0 || [...this.runs.values()].some(run => run.state === "queued" || run.state === "running");
  }

  list(options: { query?: string | undefined; cwd?: string | undefined; workspace_id?: string | undefined;
    status?: Work["status"] | undefined; archived?: boolean | undefined; offset?: number | undefined; limit?: number | undefined } = {}) {
    this.refresh();
    const query = options.query?.toLowerCase();
    const matched = [...this.works.values()].filter(work =>
      (options.cwd === undefined || work.cwd === options.cwd) &&
      (options.workspace_id === undefined || work.workspace_id === options.workspace_id) &&
      (options.status === undefined || work.status === options.status) &&
      (options.archived === undefined || work.archived === options.archived) &&
      (!query || [work.name, work.cwd, work.work_id, work.summary].some(value => value.toLowerCase().includes(query))))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.work_id.localeCompare(b.work_id));
    const offset = options.offset ?? 0, limit = options.limit ?? 20;
    return { works: matched.slice(offset, offset + limit).map(work => this.view(work)), total: matched.length,
      next_offset: offset + limit < matched.length ? offset + limit : null, retention: this.retention };
  }
  private view(work: Work) {
    return { ...work, running: this.busy(work.work_id),
      last_run: work.last_task_id ? this.runs.get(work.last_task_id) ?? null : null,
      activity_in_other_clients: "unknown" };
  }

  async open(options: { work_id?: string | undefined; thread_id?: string | undefined; name?: string | undefined;
    workspace_id?: string | undefined; cwd?: string | undefined; access?: Exclude<SandboxMode, "workspace-write"> | undefined }) {
    this.refresh();
    let work = options.work_id ? this.require(options.work_id) : undefined;
    if (work && options.thread_id && work.thread_id !== options.thread_id) {
      problem("WORK_ID_CONFLICT", "work_id and thread_id identify different histories.");
    }
    if (!work && options.thread_id) work = [...this.works.values()].find(item => item.thread_id === options.thread_id);
    if (work) {
      if (this.busy(work.work_id)) problem("WORK_BUSY", "This Bridge is already running or updating the work.");
      this.preparing.add(work.work_id);
      try {
        if (work.archived && work.thread_id) await this.native(work.codex_home, "thread/unarchive", { threadId: work.thread_id });
        work.archived = false; work.status = "active";
        if (options.name !== undefined) work.name = options.name;
        if (options.access !== undefined) work.access = options.access;
        work.updated_at = now();
        this.save();
        return { ...this.view(work), running: false };
      } finally { this.preparing.delete(work.work_id); }
    }
    let cwd = options.cwd, home = this.policy.config.codex_homes[0] ?? process.env.CODEX_HOME ?? "";
    if (options.thread_id) {
      const session = await this.locate(this.policy, options.thread_id);
      // Recheck after asynchronous lookup so simultaneous adoption is idempotent.
      const adopted = [...this.works.values()].find(item => item.thread_id === options.thread_id);
      if (adopted) return this.view(adopted);
      cwd = session.cwd; home = session.codexHome;
      if (/[\\/]archived_sessions[\\/]/u.test(session.rolloutPath)) {
        await this.native(home, "thread/unarchive", { threadId: options.thread_id });
      }
      this.refresh();
      const existing = [...this.works.values()].find(item => item.thread_id === options.thread_id);
      if (existing) return this.view(existing);
    } else if (options.workspace_id) cwd = this.registry.resolve(options.workspace_id);
    if (!cwd) problem("WORK_PROJECT_REQUIRED", "Supply workspace_id or an absolute cwd when creating a work.");
    if (!options.thread_id && !options.workspace_id) cwd = await this.policy.check(cwd, "read");
    const created = now();
    work = { work_id: newId(), name: options.name ?? "Untitled work", cwd, codex_home: home,
      ...(options.workspace_id ? { workspace_id: options.workspace_id } : {}),
      ...(options.thread_id ? { thread_id: options.thread_id } : {}),
      access: options.access ?? "danger-full-access", archived: false, previous_threads: [],
      status: "active", summary: "", references: [], created_at: created, updated_at: created };
    this.works.set(work.work_id, work); this.save();
    return this.view(work);
  }

  async continue(id: string, options: TurnOptions) {
    const work = this.require(id);
    if (this.busy(id)) problem("WORK_BUSY", "This Bridge is already running or updating the work.");
    this.preparing.add(id);
    try {
      let path: string | undefined;
      if (work.thread_id) {
        if (work.archived) {
          await this.native(work.codex_home, "thread/unarchive", { threadId: work.thread_id });
          work.archived = false;
          work.updated_at = now();
          // Commit the completed native transition before another await allows refresh().
          this.save();
        }
        const session = await this.locate(this.policy, work.thread_id);
        path = session.rolloutPath;
      }
      const access = options.access ?? work.access;
      work.access = access; work.status = "active"; work.updated_at = now();
      const run = this.start(work.cwd, work.codex_home, options, access, "codex", false, work, path);
      return { task_id: run.task_id, work_id: id, thread_id: work.thread_id ?? null, access, ephemeral: false };
    } finally { this.preparing.delete(id); }
  }

  async temp(options: TurnOptions & { work_id?: string | undefined; workspace_id?: string | undefined;
    cwd?: string | undefined; executor?: ExecutorName | undefined }) {
    const work = options.work_id ? this.require(options.work_id) : undefined;
    const executor = options.executor ?? "codex";
    if (executor === "dsh" && (options.model || options.reasoning_effort)) throw new CoreError("UNSUPPORTED_ACTION");
    let cwd = work?.cwd;
    if (options.workspace_id) cwd = this.registry.resolve(options.workspace_id);
    else if (options.cwd) cwd = await this.policy.check(options.cwd, "read");
    if (!cwd) problem("WORK_PROJECT_REQUIRED", "Supply work_id, workspace_id or cwd for temporary execution.");
    const access = options.access ?? "danger-full-access";
    const run = this.start(cwd, work?.codex_home ?? this.policy.config.codex_homes[0] ?? process.env.CODEX_HOME ?? "",
      options, access, executor, true, work);
    return { task_id: run.task_id, work_id: work?.work_id ?? null, ephemeral: true, access,
      result_file: join(this.resultDirectory, run.task_id + ".json") };
  }

  private start(cwd: string, home: string, options: TurnOptions, access: Exclude<SandboxMode, "workspace-write">,
    executor: ExecutorName, ephemeral: boolean, work?: Work, rolloutPath?: string) {
    const timestamp = now();
    const run: Run = { task_id: newId(), ...(work ? { work_id: work.work_id } : {}),
      ephemeral, executor, access, state: "queued", created_at: timestamp, updated_at: timestamp, owner_pid: process.pid };
    this.runs.set(run.task_id, run);
    if (work) { work.last_task_id = run.task_id; work.updated_at = timestamp; }
    this.save();
    queueMicrotask(() => { void this.execute(run, cwd, home, options, work, rolloutPath).catch(error => {
      process.stderr.write("Work result persistence failed: " + String(error instanceof Error ? error.name : "Error") + "\n");
    }); });
    return run;
  }

  private async execute(run: Run, cwd: string, home: string, options: TurnOptions, work?: Work, rolloutPath?: string) {
    let view: TaskView;
    try {
      run.state = "running"; this.save();
      const executor = this.factory(run.executor, cwd, home || undefined);
      const live: { executor: Executor; evidence?: TaskView["evidence"]; activity?: ExecutorActivity; startedAtMs: number } = { executor, startedAtMs: Date.now() };
      this.live.set(run.task_id, live);
      const result = await executor.execute({ taskId: run.task_id as ReturnType<typeof newId>,
        instruction: options.instruction + (!run.ephemeral && work?.previous_threads.length && !work.thread_id
          ? "\nRetained work summary (earlier native history was deleted):\n" + work.summary +
            "\nReferences:\n" + work.references.join("\n") : ""),
        sandbox: run.access === "workspace-write" ? "danger-full-access" : run.access, ephemeral: run.ephemeral,
        ...(!run.ephemeral && work?.thread_id ? { threadId: work.thread_id } : {}),
        ...(!run.ephemeral && work ? { threadName: work.name } : {}),
        ...(rolloutPath ? { threadPath: rolloutPath, threadHome: home } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.reasoning_effort ? { reasoning_effort: options.reasoning_effort } : {}),
        onEvidence: evidence => { live.evidence = evidence; },
        onActivity: activity => { live.activity = activity; },
        onThreadId: threadId => {
          if (!run.ephemeral) {
            run.thread_id = threadId;
            if (work) work.thread_id = threadId;
            this.save();
          }
        }
      });
      run.state = result.kind === "completed" ? "completed" : "failed";
      if (result.kind === "failed") run.error = result.error;
      if (result.kind === "interrupted") run.error = serializeError(new CoreError("TASK_INTERRUPTED"));
      view = { taskId: run.task_id as ReturnType<typeof newId>, state: run.state, ready: true,
        access: run.access, executor: run.executor,
        ...(!run.ephemeral && run.thread_id ? { threadId: run.thread_id } : {}),
        ...(result.kind === "completed" ? { output: result.output } : { error: run.error as TaskView["error"] }),
        ...(result.kind === "interrupted" ? { partial_output: result.output } : {}),
        ...(result.evidence ? { evidence: result.evidence } : {}),
        ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}) };
    } catch (error) {
      run.state = "failed";
      run.error = error instanceof HostError ? { code: error.code, message: error.message } : serializeError(error);
      view = { taskId: run.task_id as ReturnType<typeof newId>, state: "failed", ready: true,
        error: run.error as TaskView["error"] };
    } finally { this.live.delete(run.task_id); }
    run.updated_at = now();
    if (work) work.updated_at = run.updated_at;
    // Store complete bounded executor results separately from the small registry.
    try {
      atomicJson(join(this.resultDirectory, run.task_id + ".json"), view);
    } catch (error) {
      // The executor has ended. Persist the failure in the registry so later
      // readers cannot mistake a missing result for an execution still running.
      run.state = "failed";
      run.error = serializeError(new CoreError("WORK_RESULT_WRITE_FAILED"));
      this.save();
      throw error;
    }
    this.pruneResults(); this.save();
  }

  taskView(taskId: unknown): TaskView | undefined {
    this.refresh();
    if (typeof taskId !== "string") return undefined;
    const run = this.runs.get(taskId);
    if (!run) return undefined;
    if ((run.state === "completed" || run.state === "failed") && run.error?.code !== "WORK_RESULT_WRITE_FAILED") {
      try { return JSON.parse(readFileSync(join(this.resultDirectory, taskId + ".json"), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const live = this.live.get(taskId);
    return { taskId: taskId as ReturnType<typeof newId>, state: run.state,
      executor: run.executor, access: run.access, ready: run.state === "completed" || run.state === "failed",
      ...(run.thread_id ? { threadId: run.thread_id } : {}),
      ...(run.error ? { error: run.error as TaskView["error"] } : {}),
      ...(live?.evidence ? { evidence: live.evidence } : {}),
      ...(live?.activity ? { last_activity_at: live.activity.at, ...(live.activity.active_item ? { active_item: live.activity.active_item } : {}) } : {}),
      ...(live ? { elapsed_seconds: Math.max(0, (Date.now() - live.startedAtMs) / 1000) } : {}) };
  }
  async waitTask(id: unknown, timeout = DEFAULT_WAIT_TASK_TIMEOUT_SECONDS, signal?: AbortSignal) {
    const end = performance.now() + Math.max(1, Math.min(waitTaskMaxTimeoutSeconds(), timeout)) * 1000;
    for (;;) {
      signal?.throwIfAborted();
      const view = this.taskView(id);
      if (!view || view.ready || performance.now() >= end) return view;
      await sleep(100, undefined, signal ? { signal } : {});
    }
  }
  async controlTask(id: unknown, action: "steer" | "interrupt", instruction?: string) {
    const live = typeof id === "string" ? this.live.get(id) : undefined;
    if (!live) problem("TASK_NOT_RUNNING", "The task is not currently executing.");
    if (action === "interrupt") {
      if (!live.executor.interrupt) throw new CoreError("UNSUPPORTED_ACTION");
      await live.executor.interrupt();
    } else {
      if (!instruction?.trim() || !live.executor.steer) throw new CoreError("UNSUPPORTED_ACTION");
      await live.executor.steer(instruction);
    }
    return this.taskView(id)!;
  }
  finish(id: string, summary: string, references?: string[]) {
    const work = this.require(id);
    if (this.busy(id)) problem("WORK_BUSY", "Wait for running executions before finishing the work.");
    work.status = "completed"; work.summary = summary;
    if (references !== undefined) work.references = references;
    work.updated_at = now(); this.save();
    return this.view(work);
  }

  async manage(id: string, action: "archive" | "unarchive" | "delete_history" | "forget") {
    const work = this.require(id);
    if (this.busy(id)) problem("WORK_BUSY", "Wait for running executions before managing this work.");
    this.preparing.add(id);
    try {
      if (action === "forget") {
        this.works.delete(id); this.save();
        return { work_id: id, forgotten: true, native_history_deleted: false };
      }
      if (work.thread_id) {
        await this.native(work.codex_home, "thread/" + (action === "delete_history" ? "delete" : action), { threadId: work.thread_id });
      }
      if (action === "delete_history" && work.thread_id) {
        work.previous_threads.push(work.thread_id);
        delete work.thread_id;
        work.archived = false;
      } else work.archived = action === "archive";
      work.updated_at = now(); this.save();
      return { ...this.view(work), running: false };
    } finally { this.preparing.delete(id); }
  }
  configureRetention(options: Partial<z.infer<typeof RetentionSchema>>) {
    this.refresh();
    this.retention = RetentionSchema.parse({ ...this.retention, ...options });
    this.pruneResults(); this.save();
    return this.retention;
  }
  private pruneResults() {
    const terminal = [...this.runs.values()].filter(run => run.state === "completed" || run.state === "failed")
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    terminal.forEach((run, index) => {
      if (index < this.retention.max_results &&
        (this.retention.result_days === null || Date.parse(run.updated_at) > Date.now() - this.retention.result_days * 86400000)) return;
      rmSync(join(this.resultDirectory, run.task_id + ".json"), { force: true });
      this.runs.delete(run.task_id);
    });
  }
  async sweep() {
    this.refresh();
    this.pruneResults(); this.save();
    const results: unknown[] = [];
    for (const work of this.works.values()) {
      if (this.busy(work.work_id)) continue;
      const age = (Date.now() - Date.parse(work.updated_at)) / 86400000;
      const action = work.archived && this.retention.delete_archived_days !== null && age >= this.retention.delete_archived_days
        ? "delete_history" : !work.archived && work.status === "completed" &&
          this.retention.archive_completed_days !== null && age >= this.retention.archive_completed_days ? "archive" : undefined;
      if (!action || !work.thread_id) continue;
      try { results.push(await this.manage(work.work_id, action)); }
      catch (error) { results.push({ work_id: work.work_id, error: error instanceof Error ? error.message : "Operation failed" }); }
    }
    return { results, retention: this.retention };
  }
}
