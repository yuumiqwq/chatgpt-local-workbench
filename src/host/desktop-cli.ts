import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { signalExecution } from "../executors/executor.js";
import { buildDesktopCommand, desktopRequestWithinLimit, type DesktopTool } from "./desktop-commands.js";
import { desktopEnabled } from "./desktop-policy.js";
import { absolutePath, checkAncestors, type HostPolicy } from "./host-policy.js";

export type DesktopEnvelope = Record<string, unknown> & { ok: boolean };
export type DesktopSpawn = (file: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

export function desktopFailure(code: string, message: string, uncertain = false): DesktopEnvelope {
  return { ok: false, error: { code, message, disposition: {
    delivery: uncertain ? "unknown" : "not_delivered", retry: uncertain ? "unsafe" : "safe"
  } } };
}

export function desktopEnvironment(stateDirectory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allowed = new Set(["systemroot", "windir", "comspec", "path", "pathext", "userprofile", "home",
    "appdata", "localappdata", "temp", "tmp", "lang", "lc_all", "display", "wayland_display",
    "xdg_runtime_dir", "dbus_session_bus_address", "xauthority"]);
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.has(key.toLowerCase()) && value !== undefined) env[key] = value;
  }
  env.AGENT_DESKTOP_HOME = stateDirectory;
  return env;
}

// No retries: an interrupted or malformed mutation result has unknown delivery.
export function executeDesktopCli(file: string, args: string[], options: {
  stateDirectory: string; timeoutMs: number; maxBytes: number; mutation: boolean; signal?: AbortSignal;
}, spawnProcess: DesktopSpawn = spawn, stopProcess = (child: ChildProcessWithoutNullStreams) =>
  signalExecution(child, process.platform, "SIGKILL")): Promise<DesktopEnvelope> {
  if (options.signal?.aborted) return Promise.resolve(desktopFailure("DESKTOP_CANCELLED", "Cancelled before dispatch."));
  return new Promise(resolve => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnProcess(file, args, { cwd: dirname(file), shell: false, windowsHide: true,
        detached: process.platform !== "win32", stdio: "pipe", env: desktopEnvironment(options.stateDirectory) });
    } catch { resolve(desktopFailure("DESKTOP_START_FAILED", "The configured CLI could not be started.")); return; }
    child.stdin.end();
    let finished = false;
    let stopped: DesktopEnvelope | undefined;
    let size = 0;
    const chunks: Buffer[] = [];
    let grace: NodeJS.Timeout | undefined;
    const finish = (value: DesktopEnvelope) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(grace);
      options.signal?.removeEventListener("abort", abort);
      child.stdout.destroy(); child.stderr.destroy();
      resolve(value);
    };
    const stop = (code: string, message: string) => {
      if (finished || stopped) return;
      stopped = desktopFailure(code, message, options.mutation);
      grace = setTimeout(() => finish(stopped!), 1000);
      stopProcess(child);
    };
    const abort = () => stop("DESKTOP_CANCELLED", "CLI cancelled; observe before repeating a dispatched action.");
    const timer = setTimeout(() => stop("DESKTOP_TIMEOUT", "CLI deadline exceeded; observe before repeating a dispatched action."), options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    const consume = (chunk: Buffer | string, stdout: boolean) => {
      if (finished || stopped) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > options.maxBytes) { stop("DESKTOP_OUTPUT_LIMIT", "CLI JSON/output exceeded the configured limit; narrow the observation."); return; }
      if (stdout) chunks.push(bytes);
      // stderr can contain private desktop data: count it, never return or log it.
    };
    child.stdout.on("data", chunk => consume(chunk, true));
    child.stderr.on("data", chunk => consume(chunk, false));
    child.once("error", () => finish(stopped ?? desktopFailure("DESKTOP_START_FAILED", "The configured CLI could not be started.")));
    child.once("close", (code, signal) => {
      if (stopped) { finish(stopped); return; }
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/u, ""));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        const envelope = value as DesktopEnvelope;
        if (typeof envelope.ok !== "boolean" || (envelope.ok ? !("data" in envelope) || "error" in envelope :
          !envelope.error || typeof envelope.error !== "object" || Array.isArray(envelope.error) || "data" in envelope)) throw new Error();
        if (!envelope.ok) {
          const error = envelope.error as Record<string, unknown>;
          if (typeof error.code !== "string" || typeof error.message !== "string") throw new Error();
        }
        // Exit 1/2 still carry authoritative structured errors. Never strip
        // recovery, disposition, partial trees, or future contract fields.
        if (signal || code === null || envelope.ok && code !== 0) throw new Error();
        finish(envelope);
      } catch {
        finish(desktopFailure("DESKTOP_INVALID_RESPONSE", "CLI returned no valid envelope; observe before repeating a dispatched action.", options.mutation));
      }
    });
    if (options.signal?.aborted) abort();
  });
}

export class DesktopCli {
  private busy = false;
  constructor(private readonly policy: HostPolicy, private readonly spawnProcess: DesktopSpawn = spawn) {}

  async run(tool: DesktopTool, input: unknown, signal?: AbortSignal): Promise<DesktopEnvelope> {
    const policy = this.policy.config.desktop;
    if (!desktopEnabled(this.policy.config.enabled, policy)) return desktopFailure("DESKTOP_DISABLED", "Desktop access is not enabled for this host by local policy.");
    let command;
    try {
      if (!desktopRequestWithinLimit(input)) throw new Error();
      command = buildDesktopCommand(tool, input);
    } catch { return desktopFailure("DESKTOP_INVALID_ARGUMENT", "Arguments must match the documented command schema, scope and 16 KiB request limit."); }
    if (command.mutation && !policy.allow_mutations || command.headed && !policy.allow_headed ||
        (command.physical || command.headed && tool === "desktop_act") && (!policy.allow_physical_input || !command.headed) ||
        ["focus", "focus-window", "open-system-surface"].includes(command.command) && !command.headed ||
        tool === "desktop_screenshot" && !policy.allow_screenshot ||
        tool === "desktop_clipboard" && (policy.clipboard === "disabled" || command.mutation && policy.clipboard !== "read-write")) {
      return desktopFailure("DESKTOP_POLICY_DENIED", "This operation requires its explicit desktop policy permission and, for physical input or focus, headed=true.");
    }
    if (command.launchKey) {
      const executable = Object.hasOwn(policy.launch_apps, command.launchKey) ? policy.launch_apps[command.launchKey] : undefined;
      if (!executable) return desktopFailure("DESKTOP_POLICY_DENIED", "Launch is restricted to administrator-configured app keys; no caller arguments or environment are accepted.");
      // Windows launch accepts a real absolute executable or a bare system binary.
      if (process.platform === "win32" && !(isAbsolute(executable) && /\.exe$/iu.test(executable) || /^[a-zA-Z0-9_-]+(?:\.exe)?$/u.test(executable))) {
        return desktopFailure("DESKTOP_POLICY_DENIED", "Windows launch requires an executable path or bare system binary, not a display name.");
      }
      command.args.push("--", executable);
    }
    if (this.busy) return desktopFailure("DESKTOP_BUSY", "Another desktop call is in progress; this call was not dispatched.");
    this.busy = true;
    try {
      const executable = absolutePath(policy.executable!);
      const stateDirectory = absolutePath(policy.state_directory!);
      await checkAncestors(executable); await checkAncestors(stateDirectory);
      const stat = await lstat(executable);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 134_217_728 ||
          process.platform === "win32" && !/\.exe$/iu.test(executable) ||
          createHash("sha256").update(await readFile(executable)).digest("hex") !== policy.executable_sha256) {
        return desktopFailure("DESKTOP_BINARY_MISMATCH", "Configured native CLI failed file/hash verification; review the installation locally.");
      }
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      const args = ["--session", command.namespace ?? "wb-system",
        ...(command.headed ? ["--headed"] : []), command.command, ...command.args];
      return await executeDesktopCli(executable, args, { stateDirectory, timeoutMs: command.timeoutMs,
        maxBytes: policy.max_output_bytes, mutation: command.mutation, ...(signal ? { signal } : {}) }, this.spawnProcess);
    } catch { return desktopFailure("DESKTOP_INSTALLATION_INVALID", "Check the configured executable and private state directory locally."); }
    finally { this.busy = false; }
  }
}
