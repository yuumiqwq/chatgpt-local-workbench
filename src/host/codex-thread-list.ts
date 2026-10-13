import { lstat } from "node:fs/promises";
import { basename, relative } from "node:path";
import { z } from "zod";
import { startCodexAppServer, type ProcessStarter } from "../executors/codex-process.js";
import { signalExecution } from "../executors/executor.js";
import { VERSION } from "../version.js";
import { normalizeCodexPath } from "./codex-sessions.js";
import { checkAncestors, HostError, HostPolicy } from "./host-policy.js";

export type ThreadListQuery = (home: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

// Metadata only: no thread is resumed and no model turn starts.
export function queryCodexThreadList(home: string, params: Record<string, unknown>, signal?: AbortSignal,
  start?: ProcessStarter, timeoutMs = 30_000, host: Readonly<NodeJS.ProcessEnv> = process.env): Promise<unknown> {
  return queryCodexThread(home, "thread/list", params, signal, start, timeoutMs, host);
}

export function queryCodexThread(home: string, method: string, params: Record<string, unknown>, signal?: AbortSignal,
  start?: ProcessStarter, timeoutMs = 30_000, host: Readonly<NodeJS.ProcessEnv> = process.env): Promise<unknown> {
  signal?.throwIfAborted();
  const child = startCodexAppServer(home, { ...host, CODEX_HOME: home,
    ENGINEERING_BRIDGE_CODEX_DISABLE_MCP: "1" }, process.platform, start);
  return new Promise((resolve, reject) => {
    let settled = false;
    let stage = 1;
    let buffer: Buffer = Buffer.alloc(0);
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      signalExecution(child, process.platform, "SIGKILL");
      if (error) reject(error); else resolve(result);
    };
    const fail = () => finish(new HostError("CODEX_CATALOG_FAILED", "Codex could not complete the local request."));
    const abort = () => finish(new HostError("CODEX_CATALOG_CANCELLED", "The local Codex request was cancelled."));
    const timer = setTimeout(() => finish(new HostError("CODEX_CATALOG_TIMEOUT", "The local Codex request timed out.")), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", fail);
    child.on("close", fail);
    child.stdin.on("error", fail);
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      let end: number;
      while ((end = buffer.indexOf(10)) >= 0) {
        if (end > 1_048_576) { fail(); return; }
        const line = buffer.subarray(0, end);
        buffer = buffer.subarray(end + 1);
        let message;
        try { message = JSON.parse(line.toString("utf8")); } catch { fail(); return; }
        if (!message || typeof message !== "object") { fail(); return; }
        if (message.id !== stage) continue;
        if (message.error || !("result" in message)) { fail(); return; }
        if (stage === 1) {
          stage = 2;
          child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
          child.stdin.write(JSON.stringify({ id: 2, method, params }) + "\n");
        } else { finish(undefined, message.result); return; }
      }
      if (buffer.length > 1_048_576) fail();
    });
    child.stdin.write(JSON.stringify({ id: 1, method: "initialize",
      params: { clientInfo: { name: "engineering_bridge_catalog", version: VERSION } } }) + "\n");
    if (signal?.aborted) abort();
  });
}

const ResultSchema = z.object({
  data: z.array(z.object({
    id: z.string().uuid(), cwd: z.string().max(4096), name: z.string().nullable().optional(),
    preview: z.string(), createdAt: z.number(), updatedAt: z.number(), ephemeral: z.boolean().optional()
  })).max(50),
  nextCursor: z.string().max(4096).nullable().optional()
});

export async function listCodexThreads(policy: HostPolicy, options: {
  query?: string; cwd?: string; codex_home?: string; cursor?: string; limit?: number; archived?: boolean;
}, signal?: AbortSignal, query: ThreadListQuery = queryCodexThreadList) {
  if (!policy.config.enabled) throw new HostError("HOST_DISABLED", "Host operations are not enabled.");
  const wantedHome = options.codex_home ?? policy.config.codex_homes[0];
  const home = wantedHome && policy.config.codex_homes.find(candidate => relative(candidate, wantedHome) === "");
  if (!home) throw new HostError("CODEX_HOME_DENIED", "Select one of the configured Codex homes.");
  if (!policy.config.follow_links) await checkAncestors(home);
  const cwd = options.cwd === undefined ? undefined : await policy.check(normalizeCodexPath(options.cwd), "read");
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new HostError("CODEX_CATALOG_LIMIT", "The page limit must be between 1 and 50.");
  const parsed = ResultSchema.safeParse(await query(home, {
    limit, sortKey: "updated_at", sortDirection: "desc", modelProviders: [],
    sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"], archived: options.archived ?? false,
    ...(options.query === undefined ? {} : { searchTerm: options.query }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor })
  }, signal));
  if (!parsed.success || parsed.data.data.length > limit) {
    throw new HostError("CODEX_CATALOG_FAILED", "Codex returned an invalid local thread list.");
  }
  const threads = [];
  for (const thread of parsed.data.data) {
    signal?.throwIfAborted();
    if (thread.ephemeral) continue;
    let checkedCwd: string;
    try {
      checkedCwd = await policy.check(normalizeCodexPath(thread.cwd), "read");
      if (!(await lstat(checkedCwd)).isDirectory()) continue;
    } catch { continue; }
    let canWrite = false;
    try { await policy.check(checkedCwd, "write"); canWrite = true; } catch { /* read-only candidate */ }
    threads.push({ thread_id: thread.id, title: (thread.name || thread.preview).slice(0, 512),
      preview: thread.preview.slice(0, 1000), preview_truncated: thread.preview.length > 1000,
      cwd: checkedCwd, created_at: thread.createdAt, updated_at: thread.updatedAt,
      can_resume_with_write: canWrite, activity_elsewhere: "unknown" });
  }
  return { threads, codex_home: home, available_codex_homes: policy.config.codex_homes,
    next_cursor: parsed.data.nextCursor ?? null, archived: options.archived ?? false,
    omitted_count: parsed.data.data.length - threads.length,
    content: "Titles and short previews only; listing does not resume or modify conversations." };
}

export async function listCodexProjects(policy: HostPolicy, options: {
  query?: string; codex_home?: string; cursor?: string; scan_limit?: number; archived?: boolean;
}, signal?: AbortSignal, query: ThreadListQuery = queryCodexThreadList) {
  // Project names filter directory groups, never the thread title search.
  const page = await listCodexThreads(policy, {
    limit: options.scan_limit ?? 50,
    ...(options.codex_home === undefined ? {} : { codex_home: options.codex_home }),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    ...(options.archived === undefined ? {} : { archived: options.archived })
  }, signal, query);
  type Project = {
    name: string; cwd: string; thread_count_in_page: number; last_updated_at: number;
    latest_thread_id: string; latest_title: string; can_resume_with_write: boolean;
    thread_list_arguments: { cwd: string; codex_home: string; archived: boolean };
  };
  const projects: Project[] = [];
  for (const thread of page.threads) {
    let project = projects.find(item => relative(item.cwd, thread.cwd) === "");
    if (!project) {
      project = { name: basename(thread.cwd) || thread.cwd, cwd: thread.cwd, thread_count_in_page: 0,
        last_updated_at: thread.updated_at, latest_thread_id: thread.thread_id, latest_title: thread.title,
        can_resume_with_write: thread.can_resume_with_write,
        thread_list_arguments: { cwd: thread.cwd, codex_home: page.codex_home, archived: page.archived } };
      projects.push(project);
    }
    project.thread_count_in_page++;
    if (thread.updated_at > project.last_updated_at) {
      project.last_updated_at = thread.updated_at;
      project.latest_thread_id = thread.thread_id;
      project.latest_title = thread.title;
    }
  }
  const term = options.query?.trim().toLowerCase();
  return {
    projects: projects.filter(item => !term || item.name.toLowerCase().includes(term) || item.cwd.toLowerCase().includes(term))
      .sort((a, b) => b.last_updated_at - a.last_updated_at || a.cwd.localeCompare(b.cwd)),
    codex_home: page.codex_home, available_codex_homes: page.available_codex_homes,
    next_cursor: page.next_cursor, archived: page.archived, scanned_threads: page.threads.length + page.omitted_count,
    omitted_count: page.omitted_count, grouping: "original working directory",
    counts_scope: "current page only; a project may appear again on later pages",
    next_step: "Call list_codex_threads with the selected project's thread_list_arguments. An empty project search with next_cursor is not an exhaustive miss."
  };
}
