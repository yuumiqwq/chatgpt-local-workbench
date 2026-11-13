import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";

export const PROCESS_OUTPUT_BYTES = 65_536;
export const MAX_HOST_PROCESSES = 8;
export const MAX_PROCESS_TIMEOUT_SECONDS = 604_800;

export interface ProcessRequest {
  executable: string;
  args: readonly string[];
  cwd: string;
  timeout_seconds?: number;
}

/** Process-only data: never fabricate an agent executor, sandbox or thread. */
export interface ProcessView {
  executable: string;
  cwd: string;
  pid?: number;
  started_at: string;
  ended_at?: string;
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timed_out: boolean;
  cancelled: boolean;
  stop_reason?: "interrupt" | "timeout" | "shutdown";
  spawn_failed?: boolean;
  termination_error?: boolean;
  outcome_unknown?: boolean;
}

/** One native child, bounded capture, asynchronous tree termination and observed exit. */
export function launchProcess(request: ProcessRequest, changed: (view: ProcessView) => void = () => {}) {
  const state: ProcessView = {
    executable: request.executable, cwd: request.cwd, started_at: new Date().toISOString(),
    exit_code: null, signal: null, stdout: "", stderr: "", truncated: false,
    timed_out: false, cancelled: false
  };
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(request.executable, [...request.args], {
      cwd: request.cwd, shell: false, windowsHide: true,
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"]
    });
  } catch {
    state.spawn_failed = true; state.ended_at = new Date().toISOString();
    return { done: Promise.resolve(state), snapshot: () => ({ ...state }),
      stop: (_reason: NonNullable<ProcessView["stop_reason"]>) => {} };
  }
  child.stdin.on("error", () => {});
  child.stdin.end();
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
  let finished = false, exited = false, killing = false;
  let deadline: NodeJS.Timeout | undefined, retry: NodeJS.Timeout | undefined;
  let drain: NodeJS.Timeout | undefined;
  let resolveDone!: (view: ProcessView) => void;
  const done = new Promise<ProcessView>(resolve => { resolveDone = resolve; });
  // Streaming decode omits an incomplete final code point at a capture boundary.
  const snapshot = (): ProcessView => ({ ...state,
    stdout: new TextDecoder().decode(stdout, { stream: true }),
    stderr: new TextDecoder().decode(stderr, { stream: true }) });
  const append = (target: Buffer, chunk: Buffer) => {
    const remaining = PROCESS_OUTPUT_BYTES - stdout.length - stderr.length;
    if (chunk.length > remaining) state.truncated = true;
    return remaining > 0 ? Buffer.concat([target, chunk.subarray(0, remaining)]) : target;
  };
  child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline); clearInterval(retry); clearTimeout(drain);
    child.stdout.destroy(); child.stderr.destroy();
    state.ended_at = new Date().toISOString();
    resolveDone(snapshot());
  };
  const killTree = async () => {
    if (finished || exited || killing || !child.pid) return;
    killing = true;
    let killed = false;
    if (process.platform === "win32") {
      // Resolve the OS tool explicitly; never search the caller's cwd/PATH.
      killed = await new Promise<boolean>(resolve => {
        execFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"],
          { shell: false, windowsHide: true, timeout: 2000, maxBuffer: 4096 }, error => resolve(!error));
      });
    } else {
      try { process.kill(-child.pid, "SIGKILL"); killed = true; } catch { /* try direct child */ }
    }
    // Do not target a PID again after its exit notification (PID reuse).
    if (!killed && !exited && !finished) {
      try { killed = child.kill("SIGKILL"); } catch { /* report and keep monitoring */ }
    }
    if (!killed && !exited && !finished) { state.termination_error = true; changed(snapshot()); }
    killing = false;
  };
  const stop = (reason: NonNullable<ProcessView["stop_reason"]>) => {
    if (finished || exited || state.stop_reason) return;
    state.stop_reason = reason;
    state.timed_out = reason === "timeout";
    state.cancelled = reason !== "timeout";
    changed(snapshot());
    void killTree();
    // A failed kill is never reported as a completed process.
    retry = setInterval(() => { void killTree(); }, 1000);
  };
  child.once("spawn", () => {
    state.pid = child.pid!;
    changed(snapshot());
    if (state.stop_reason) void killTree();
    else if (request.timeout_seconds !== undefined) {
      deadline = setTimeout(() => stop("timeout"), request.timeout_seconds * 1000);
    }
  });
  child.once("error", () => {
    if (state.pid === undefined) { state.spawn_failed = true; finish(); }
    else { state.termination_error = true; changed(snapshot()); }
  });
  child.once("exit", (code, signal) => {
    exited = true;
    state.exit_code = code; state.signal = signal;
    clearTimeout(deadline); clearInterval(retry);
    // Ordinary descendants in the POSIX process group must not outlive the task.
    if (process.platform !== "win32" && child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* group already exited */ }
    }
    // Descendants can retain inherited pipes. Record the real direct exit, then
    // bound draining rather than waiting indefinitely for an unrelated pipe.
    drain = setTimeout(() => { state.truncated = true; finish(); }, 250);
  });
  child.once("close", finish);
  return { done, snapshot, stop };
}
