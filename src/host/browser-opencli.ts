import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { absolutePath, checkAncestors } from "./host-policy.js";
import type { BrowserPolicy } from "./browser-policy.js";
import type { BrowserBackend } from "./browser-tools.js";

export class BrowserCliError extends Error {
  constructor(readonly code: string, message: string, readonly uncertain = false) { super(message); }
}
export interface BrowserCommandOptions { entry: string; cwd: string; timeoutMs: number; mutation: boolean }
export type BrowserCommand = (args: string[], signal: AbortSignal, options: BrowserCommandOptions) => Promise<string>;

export function opencliEnvironment(directory: string, timeoutMs: number): NodeJS.ProcessEnv {
  const allowed = new Set(["systemroot", "windir", "comspec", "path", "pathext", "userprofile", "home", "appdata", "localappdata", "lang", "lc_all"]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (allowed.has(key.toLowerCase())) env[key] = value;
  return { ...env, TEMP: directory, TMP: directory, TMPDIR: directory,
    OPENCLI_CACHE_DIR: join(directory, "cache"), OPENCLI_WINDOW: "background", OPENCLI_VERBOSE: "false",
    OPENCLI_BROWSER_CONNECT_TIMEOUT: "3", OPENCLI_BROWSER_COMMAND_TIMEOUT: String(Math.max(1, Math.floor(timeoutMs / 1000))) };
}

// No shell and no wrapper-level retries. Abort only stops the CLI wait; an already
// dispatched browser action can still finish, so its delivery becomes unknown.
export const executeBrowserCommand: BrowserCommand = (args, signal, options) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new BrowserCliError("BROWSER_CANCELLED", "Cancelled before CLI dispatch.")); return; }
  const child = spawn(process.execPath, [options.entry, ...args], { cwd: options.cwd,
    env: opencliEnvironment(options.cwd, options.timeoutMs), shell: false, windowsHide: true, stdio: "pipe" });
  child.stdin.end();
  const chunks: Buffer[] = []; let size = 0, done = false;
  const finish = (error?: BrowserCliError, value?: string) => {
    if (done) return; done = true;
    clearTimeout(timer); signal.removeEventListener("abort", cancel);
    if (error) { child.kill(); child.stdout.destroy(); child.stderr.destroy(); reject(error); }
    else resolve(value!);
  };
  const cancel = () => finish(new BrowserCliError("BROWSER_CANCELLED", "CLI cancelled; observe before repeating a dispatched action.", options.mutation));
  const timer = setTimeout(() => finish(new BrowserCliError("BROWSER_TIMEOUT", "CLI deadline exceeded; no automatic retry.", options.mutation)), options.timeoutMs);
  signal.addEventListener("abort", cancel, { once: true });
  const consume = (chunk: Buffer, stdout: boolean) => {
    if (done) return;
    size += chunk.length;
    if (size > 1_048_576) { finish(new BrowserCliError("BROWSER_OUTPUT_LIMIT", "CLI output exceeded 1 MiB; narrow the observation.", options.mutation)); return; }
    if (stdout) chunks.push(chunk); // stderr is counted, never logged or returned.
  };
  child.stdout.on("data", chunk => consume(Buffer.from(chunk), true));
  child.stderr.on("data", chunk => consume(Buffer.from(chunk), false));
  child.once("error", () => finish(new BrowserCliError("BROWSER_CLI_START_FAILED", "Could not start the configured OpenCLI entry.")));
  child.once("close", code => {
    if (code !== 0) { finish(new BrowserCliError("BROWSER_CLI_FAILED", "OpenCLI failed; inspect the owned tab before retrying.", options.mutation)); return; }
    finish(undefined, Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/u, "").trim());
  });
  if (signal.aborted) cancel();
});

const response = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });
const parse = (text: string): unknown => {
  try { return JSON.parse(text); }
  catch { throw new BrowserCliError("BROWSER_INVALID_RESPONSE", "OpenCLI returned an invalid structured response.", true); }
};
interface OwnedTab { session: string; page?: string }
interface ListedTab { page: string; url: string; title: string }

export async function createOpenCliBackend(config: BrowserPolicy, signal: AbortSignal,
  execute: BrowserCommand = executeBrowserCommand): Promise<BrowserBackend> {
  if (!config.opencli_entry || !config.opencli_context || config.profile_name) {
    throw new BrowserCliError("BROWSER_SETUP_REQUIRED", "Configure opencli_entry and the explicit Edge opencli_context from opencli profile list. Remove obsolete profile_name; browser login is shared through the existing OpenCLI extension.");
  }
  const entry = absolutePath(config.opencli_entry);
  await checkAncestors(entry);
  if (!/\.m?js$/iu.test(entry) || !(await stat(entry)).isFile()) throw new BrowserCliError("BROWSER_CLI_ENTRY_INVALID", "opencli_entry must name the installed OpenCLI JavaScript entry, not a shell shim.");
  const root = absolutePath(config.state_directory!); await checkAncestors(root); await mkdir(root, { recursive: true, mode: 0o700 });
  const owned = await mkdtemp(join(root, "browser-"));
  const prefix = `wb-${process.pid}-${randomUUID()}`;
  const tabs: OwnedTab[] = []; let selected = 0, serial = 0, daemonPid = "", refSerial = 0;
  const refs = new Map<string, string>(); let stopped = false, closing: Promise<void> | undefined;
  const run = (args: string[], callSignal: AbortSignal, mutation = false) => execute(args, callSignal,
    { entry, cwd: owned, timeoutMs: config.timeout_ms, mutation });
  const command = (tab: OwnedTab, args: string[], callSignal: AbortSignal, mutation = false) =>
    run(["--profile", config.opencli_context!, "browser", tab.session, "--window", "background", ...args], callSignal, mutation);
  const journal = () => writeFile(join(owned, "lease.json"), JSON.stringify({ owner_pid: process.pid,
    context: config.opencli_context, tabs }), { mode: 0o600 });
  const health = async (callSignal: AbortSignal) => {
    const output = await run(["--profile", config.opencli_context!, "daemon", "status"], callSignal);
    const pid = /^Daemon: running \(PID (\d+)\)$/mu.exec(output)?.[1];
    const profiles = /^Profiles: (.+)$/mu.exec(output)?.[1]?.split(/,\s*/u) ?? [];
    if (!pid || !profiles.includes(`${config.opencli_context} v1.0.27`) ||
      !output.includes(`Version: v${config.opencli_version}`)) {
      throw new BrowserCliError("BROWSER_BRIDGE_UNAVAILABLE", "The configured OpenCLI daemon/profile must already be connected, with the configured CLI version and tested extension 1.0.27. No daemon restart or browser launch was attempted.");
    }
    if (daemonPid && pid !== daemonPid) throw new BrowserCliError("BROWSER_LEASE_LOST", "OpenCLI daemon changed; existing tab ownership cannot be recovered. Close this connection and explicitly create a new session.");
    daemonPid = pid;
  };
  const inventory = async (tab: OwnedTab, callSignal: AbortSignal): Promise<ListedTab> => {
    const value = parse(await command(tab, ["tab", "list"], callSignal));
    if (!Array.isArray(value) || value.length !== 1) throw new BrowserCliError("BROWSER_LEASE_LOST", "The owned session no longer has exactly its original tab.");
    const item = value[0] as ListedTab;
    if (!item || typeof item.page !== "string" || item.page !== tab.page || typeof item.url !== "string" || typeof item.title !== "string") {
      throw new BrowserCliError("BROWSER_LEASE_LOST", "The original owned page identity is unavailable; no fallback tab is selected.");
    }
    return item;
  };
  const newTab = async (callSignal: AbortSignal) => {
    if (tabs.length >= 32) throw new BrowserCliError("BROWSER_TAB_LIMIT", "At most 32 owned tabs are allowed.");
    const tab: OwnedTab = { session: `${prefix}-${++serial}` }; tabs.push(tab); await journal();
    const output = await command(tab, ["tab", "new"], callSignal, true);
    const created = parse(output);
    const page = created && typeof created === "object" && !Array.isArray(created) ? (created as { page?: unknown }).page : undefined;
    if (typeof page !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(page)) throw new BrowserCliError("BROWSER_INVALID_RESPONSE", "New tab identity was not returned; delivery is unknown.", true);
    tab.page = page; await journal();
    try { await inventory(tab, callSignal); }
    catch { throw new BrowserCliError("BROWSER_LEASE_UNVERIFIED", "New tab creation could not be verified; no retry was attempted.", true); }
    selected = tabs.length - 1; refs.clear();
  };
  const close = () => closing ??= (async () => {
    stopped = true; refs.clear();
    const cleanup = AbortSignal.timeout(5000);
    let complete = true;
    try {
      if (tabs.length) await health(cleanup);
      for (const tab of [...tabs]) {
        // Only unique session IDs created by this backend are ever released.
        await command(tab, ["close"], cleanup, true);
        tabs.splice(tabs.indexOf(tab), 1); await journal();
      }
    } catch { complete = false; }
    if (complete) await rm(owned, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    else throw new BrowserCliError("BROWSER_CLEANUP_INCOMPLETE", "Owned session cleanup is unconfirmed; its private lease.json is retained for local recovery. No close was retried.", true);
  })();
  const list = async (callSignal: AbortSignal) => {
    const lines: string[] = [];
    for (const [index, tab] of tabs.entries()) {
      const item = await inventory(tab, callSignal);
      lines.push(`- ${index}:${selected === index ? " (current)" : ""} ${JSON.stringify({ title: item.title, url: item.url })}`);
    }
    return response(lines.join("\n") || "No open tabs.");
  };
  try {
    const version = await run(["--version"], signal);
    if (version.replace(/^v/u, "") !== config.opencli_version) throw new BrowserCliError("BROWSER_CLI_VERSION", "Installed OpenCLI does not match the administrator-configured version.");
    await health(signal); await newTab(signal);
    return { close, call: async (name, args, callSignal) => {
      if (stopped) throw new BrowserCliError("BROWSER_CLOSED", "This owned browser session is closed.");
      await health(callSignal);
      if (name === "browser_tabs") {
        if (args.action === "new") await newTab(callSignal);
        else if (args.action === "select" || args.action === "close") {
          const index = Number(args.index), tab = tabs[index];
          if (!Number.isInteger(index) || !tab) throw new BrowserCliError("BROWSER_TAB_NOT_OWNED", "Choose an index from this connection's tab list.");
          await inventory(tab, callSignal); refs.clear();
          if (args.action === "select") selected = index; // Logical selection only: never activate a browser tab.
          else { await command(tab, ["close"], callSignal, true); tabs.splice(index, 1); selected = Math.max(0, Math.min(selected, tabs.length - 1)); await journal(); }
        } else if (args.action !== "list") throw new BrowserCliError("BROWSER_UNSUPPORTED", "Unsupported tab operation.");
        try { return await list(callSignal); }
        catch (error) {
          if (args.action === "new" || args.action === "close") throw new BrowserCliError("BROWSER_ACTION_UNVERIFIED", "Tab mutation completed but its final inventory is unconfirmed; do not replay.", true);
          throw error;
        }
      }
      const tab = tabs[selected];
      if (!tab) throw new BrowserCliError("BROWSER_TAB_REQUIRED", "Create an owned tab first.");
      await inventory(tab, callSignal);
      const pageArgs = ["--tab", tab.page!];
      if (name === "browser_navigate") {
        refs.clear(); await command(tab, ["open", ...pageArgs, "--", String(args.url)], callSignal, true);
        try { await inventory(tab, callSignal); }
        catch { throw new BrowserCliError("BROWSER_ACTION_UNVERIFIED", "Navigation was dispatched but page ownership is now unconfirmed.", true); }
        return response("Navigation delivered; take a fresh snapshot to verify.");
      }
      if (name === "browser_snapshot") {
        if (args.target || args.depth !== undefined && args.depth !== 12) throw new BrowserCliError("BROWSER_UNSUPPORTED", "OpenCLI state supports a full bounded snapshot; target scoping and custom depth are not supported.");
        refs.clear(); const output = await command(tab, ["state", ...pageArgs], callSignal);
        // Only DOM node prefixes carry native refs. Bracketed page text and
        // compound metadata must never manufacture an actionable reference.
        return response(output.replace(/^([ \t]*\*?)(?:\[(\d+)\]|\|scroll\[(\d+)\]\|)(?=<[a-z])/gmu, (_match, indent: string, native: string | undefined, scroll: string | undefined) => {
          const ref = `e${++refSerial}`; refs.set(ref, (native ?? scroll)!); return `${indent}[ref=${ref}]${scroll ? "|scroll|" : ""}`;
        }));
      }
      if (name === "browser_wait_for") {
        if (args.textGone) throw new BrowserCliError("BROWSER_UNSUPPORTED", "OpenCLI wait supports visible text; hidden-text predicates are not supported.");
        await command(tab, ["wait", ...pageArgs, "--timeout", String(Math.floor(Number(args.time) * 1000)), "--", "text", String(args.text)], callSignal);
        return response("Text wait completed; inspect the page to verify.");
      }
      if (name === "browser_click" || name === "browser_type") {
        const native = refs.get(String(args.target));
        if (!native) throw new BrowserCliError("BROWSER_REF_NOT_OBSERVED", "Observe a fresh reference in the selected owned tab.");
        refs.clear();
        const action = name === "browser_click" ? "click" : args.slowly ? "type" : "fill";
        const value = parse(await command(tab, [action, ...pageArgs, "--", native, ...(action === "click" ? [] : [String(args.text)])], callSignal, true)) as Record<string, unknown>;
        const key = action === "click" ? "clicked" : action === "fill" ? "filled" : "typed";
        if (!value || value[key] !== true || value.matches_n !== 1 || !["exact", "stable"].includes(String(value.match_level)) || action === "fill" && value.verified !== true) {
          throw new BrowserCliError("BROWSER_ACTION_UNVERIFIED", "OpenCLI did not verify the exact action target/result. Observe before another mutation.", true);
        }
        try { await inventory(tab, callSignal); }
        catch { throw new BrowserCliError("BROWSER_ACTION_UNVERIFIED", "Action was dispatched but page ownership is now unconfirmed.", true); }
        return response(JSON.stringify({ [key]: true, match_level: value.match_level, requires_fresh_snapshot: true }));
      }
      throw new BrowserCliError("BROWSER_UNSUPPORTED", "The requested browser operation is not allowed.");
    } };
  } catch (error) { await close().catch(() => {}); throw error; }
}
