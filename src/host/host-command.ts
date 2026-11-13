import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { signalExecution } from "../executors/executor.js";
import { absolutePath, HostError, HostPolicy } from "./host-policy.js";

export async function validateHostCommand(policy: HostPolicy, executableValue: string,
  args: readonly string[], cwdValue: string) {
  const cwd = await policy.check(cwdValue, "command");
  if (!isAbsolute(executableValue) || args.length > 256 ||
      args.some(arg => arg.includes("\0") || arg.length > 32_767)) {
    throw new HostError("HOST_INVALID_ARGUMENT", "Use an absolute executable and a bounded argument array without NUL characters.");
  }
  const executable = absolutePath(executableValue);
  if (!(await lstat(cwd)).isDirectory()) {
    throw new HostError("HOST_INVALID_CWD", "The starting directory must be an existing directory.");
  }
  if (!(await lstat(executable)).isFile() ||
      process.platform === "win32" && !/\.(exe|com)$/iu.test(executable)) {
    throw new HostError("HOST_EXECUTABLE_REQUIRED", "Use a real executable; shell scripts require an explicit interpreter.");
  }
  return { executable, args: [...args], cwd };
}

// This is explicitly NOT a filesystem sandbox. Enabling host commands grants
// the caller the current OS account's process capabilities, including network.
export async function runHostCommand(
  policy: HostPolicy,
  executableValue: string,
  args: readonly string[],
  cwdValue: string,
  timeoutSeconds = 25,
  signal?: AbortSignal
) {
  const { executable, cwd } = await validateHostCommand(policy, executableValue, args, cwdValue);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 45) {
    throw new HostError("HOST_INVALID_ARGUMENT", "Use an absolute executable, an argument array and a timeout from 1 to 45 seconds.");
  }
  signal?.throwIfAborted();
  return new Promise<{
    exit_code: number | null; stdout: string; stderr: string;
    truncated: boolean; timed_out: boolean; cancelled: boolean;
  }>((resolveResult, reject) => {
    const child = spawn(executable, [...args], {
      cwd, shell: false, windowsHide: true, detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdin.end();
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let finished = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const append = (target: Buffer, chunk: Buffer) => {
      const remaining = Math.max(0, 65_536 - stdout.length - stderr.length);
      if (chunk.length > remaining) truncated = true;
      return Buffer.concat([target, chunk.subarray(0, remaining)]);
    };
    const cleanup = () => {
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      signal?.removeEventListener("abort", abort);
    };
    const finish = (exitCode: number | null) => {
      if (finished) return;
      finished = true;
      cleanup();
      child.stdout.destroy();
      child.stderr.destroy();
      resolveResult({ exit_code: exitCode, stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"), truncated, timed_out: timedOut, cancelled });
    };
    const stop = () => {
      signalExecution(child, process.platform, "SIGKILL");
      graceTimer = setTimeout(() => finish(null), 2000);
    };
    const abort = () => { if (!finished) { cancelled = true; stop(); } };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutSeconds * 1000);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once("error", () => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new HostError("HOST_COMMAND_FAILED", "The host command could not be started."));
    });
    child.once("close", code => finish(code));
  });
}
