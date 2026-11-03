import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { DesktopCli, desktopEnvironment, executeDesktopCli, type DesktopSpawn } from "../../../src/host/desktop-cli.js";
import { buildDesktopCommand, desktopRequestWithinLimit, desktopSchemas, type DesktopTool } from "../../../src/host/desktop-commands.js";
import { desktopEnabled, DesktopPolicySchema } from "../../../src/host/desktop-policy.js";
import { desktopCapabilities, registerDesktopTools } from "../../../src/host/desktop-tools.js";
import { HostPolicy } from "../../../src/host/host-policy.js";
import { HostFiles } from "../../../src/host/host-files.js";

const ref = "@s8f3k2p9:e8";
const target = { namespace: "task-1", ref };
const delivered = { version: "2.5", ok: true, command: "click", data: {
  disposition: { delivery: "delivered_unverified", retry: "unsafe" }, details: { verification_scope: "unavailable" }
} };

function fakeProcess(body: string | undefined, exitCode = 0) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => { queueMicrotask(() => child.emit("close", null, "SIGKILL")); return true; } });
  const calls: { file: string; args: string[]; options: SpawnOptionsWithoutStdio }[] = [];
  const spawn: DesktopSpawn = (file, args, options) => {
    calls.push({ file, args, options });
    if (body !== undefined) queueMicrotask(() => { (child.stdout as PassThrough).write(body); child.emit("close", exitCode, null); });
    return child;
  };
  return { child, calls, spawn };
}

async function fixture(t: TestContext, overrides: Record<string, unknown> = {}) {
  const scratch = resolve("codex-generated/desktop-tests");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "case-"));
  t.after(async () => { assert.ok(root.startsWith(scratch)); await rm(root, { recursive: true, force: true }); });
  const bin = join(root, "bin"); await mkdir(bin);
  const executable = join(bin, "agent-desktop.exe");
  await writeFile(executable, "mock-binary-not-executable");
  const desktop = { enabled: true, allowed_hosts: [hostname()], executable,
    executable_sha256: createHash("sha256").update(await readFile(executable)).digest("hex"),
    state_directory: join(root, "state"), ...overrides };
  const source = { version: 1, enabled: true, read_roots: [root], write_roots: [root], desktop };
  const policy = await HostPolicy.create(source, join(root, "policy.json"));
  return { root, source, policy, executable };
}

test("desktop policy is disabled by default and bound to explicit hostnames", async t => {
  assert.equal(DesktopPolicySchema.parse({}).enabled, false);
  assert.throws(() => DesktopPolicySchema.parse({ enabled: true }));
  assert.throws(() => DesktopPolicySchema.parse({ allow_physical_input: true }));
  const { policy } = await fixture(t);
  assert.equal(desktopEnabled(true, policy.config.desktop), true);
  assert.equal(desktopEnabled(false, policy.config.desktop), false);
  assert.equal(desktopEnabled(true, policy.config.desktop, "some-other-legion-host"), false);
  assert.equal(desktopCapabilities(policy).automatic_retries, false);
});

test("desktop argv preserves literal values and rejects flags, bare refs and unbounded requests", () => {
  const text = '--headed; $(private) "quote"\n中文';
  const command = buildDesktopCommand("desktop_act", { command: "set-value", ...target, text });
  assert.deepEqual(command.args, ["--timeout-ms=10000", "--", ref, text]);
  assert.equal(command.namespace, "wb-task-1");
  assert.equal(command.headed, false);
  assert.equal(command.mutation, true);
  for (const bad of ["@e8", "@s:e8", "--headed", "@s123:e1\n", "@s123:e1 --headed"]) {
    assert.throws(() => buildDesktopCommand("desktop_act", { command: "click", ...target, ref: bad }));
  }
  for (const command of ["key-down", "mouse-up", "batch", "session", "trace", "help", "anything"]) {
    assert.throws(() => buildDesktopCommand("desktop_act", { command, ...target }));
  }
  assert.throws(() => buildDesktopCommand("desktop_act", { command: "click", ...target, args: ["--headed"] }));
  assert.throws(() => buildDesktopCommand("desktop_act", { command: "type", ...target, text: "\0" }));
  assert.throws(() => buildDesktopCommand("desktop_snapshot", { namespace: "task" }));
  assert.throws(() => buildDesktopCommand("desktop_snapshot", { namespace: "task", app: "test", surface: "menu", skeleton: true }));
  assert.throws(() => buildDesktopCommand("desktop_find", { namespace: "task", app: "test" }));
  assert.throws(() => buildDesktopCommand("desktop_list", { command: "list-displays", app: "test" }));
  assert.throws(() => buildDesktopCommand("desktop_window", { command: "launch", app_key: "test", args: ["/c"] }));
  assert.throws(() => buildDesktopCommand("desktop_clipboard", { command: "clipboard-get", format: "image", out: "private" }));
});

test("grouped commands map documented options and independent deadlines", () => {
  const cases: [DesktopTool, unknown, string, string[]][] = [
    ["desktop_status", { command: "permissions" }, "permissions", []],
    ["desktop_list", { command: "list-windows", app: "--headed" }, "list-windows", ["--app=--headed"]],
    ["desktop_read", { command: "is", ...target, property: "checked" }, "is", ["--property=checked", "--", ref]],
    ["desktop_act", { command: "scroll", ...target, direction: "left", amount: 2 }, "scroll", ["--timeout-ms=10000", "--direction=left", "--amount=2", "--", ref]],
    ["desktop_window", { command: "move-window", window_id: "w-1", x: -20, y: 5 }, "move-window", ["--window-id=w-1", "--x=-20", "--y=5"]],
    ["desktop_clipboard", { command: "clipboard-set", text: "--headed" }, "clipboard-set", ["--", "--headed"]],
    ["desktop_screenshot", { window_id: "w-1" }, "screenshot", ["--window-id=w-1"]],
    ["desktop_wait", { condition: "element", ...target, predicate: "value", value: "done", timeout_ms: 500 }, "wait", ["--timeout=500", `--element=${ref}`, "--predicate=value", "--value=done"]],
    ["desktop_input", { command: "mouse-click", x: -5, y: 3, headed: true }, "mouse-click", ["--xy=-5,3", "--button=left", "--count=1"]]
  ];
  for (const [tool, request, name, args] of cases) {
    const command = buildDesktopCommand(tool, request);
    assert.equal(command.command, name); assert.deepEqual(command.args, args);
  }
  assert.equal(buildDesktopCommand("desktop_wait", cases[7]![1]).timeoutMs, 3500);
  assert.throws(() => buildDesktopCommand("desktop_wait", { condition: "element", ...target, predicate: "value" }));
  assert.throws(() => buildDesktopCommand("desktop_snapshot", { namespace: "task", app: "test", timeout_ms: 45000 }));
});

test("runner retains partial snapshots, delivery reports and JSON errors on exit 1/2", async () => {
  const partial = { version: "2.6", ok: true, command: "snapshot", data: {
    complete: false, truncated: true, snapshot_id: "s123", identity_unproven: true,
    tree: { subtree_truncated: true }, nodes_observed: 12
  } };
  const error = { version: "2.5", ok: false, error: { code: "STALE_REF", message: "Refresh the snapshot.",
    disposition: { delivery: "not_delivered", retry: "safe" }, recovery: { requires_fresh_snapshot: true } } };
  for (const [body, code] of [[partial, 0], [delivered, 0], [error, 1], [error, 2]] as const) {
    const fake = fakeProcess(JSON.stringify(body), code);
    const result = await executeDesktopCli(resolve("mock.exe"), ["click"], {
      stateDirectory: resolve("state"), timeoutMs: 500, maxBytes: 4096, mutation: true
    }, fake.spawn);
    assert.deepEqual(result, body); assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0]!.options.shell, false);
    assert.equal(fake.calls[0]!.options.windowsHide, true);
    assert.equal(fake.child.stdin.writableEnded, true);
  }
});

test("runner filters credentials and inherited desktop options", () => {
  process.env.DESKTOP_TEST_SECRET = "not-forwarded";
  process.env.AGENT_DESKTOP_SESSION = "unexpected";
  process.env.AGENT_DESKTOP_TRACE = "private";
  try {
    const env = desktopEnvironment(resolve("private-state"));
    assert.equal(env.DESKTOP_TEST_SECRET, undefined);
    assert.equal(env.AGENT_DESKTOP_SESSION, undefined);
    assert.equal(env.AGENT_DESKTOP_TRACE, undefined);
    assert.equal(env.AGENT_DESKTOP_HOME, resolve("private-state"));
  } finally { delete process.env.DESKTOP_TEST_SECRET; delete process.env.AGENT_DESKTOP_SESSION; delete process.env.AGENT_DESKTOP_TRACE; }
});

test("runner bounds output, timeout and cancellation without retry or private error output", async t => {
  for (const mode of ["malformed", "exit", "overflow", "stderr", "timeout", "abort", "pre-abort", "spawn-error"] as const) await t.test(mode, async () => {
    const fake = fakeProcess(mode === "malformed" ? "private-ui-content" : mode === "exit" ? JSON.stringify(delivered) : undefined, 1);
    const controller = new AbortController();
    if (mode === "pre-abort") controller.abort();
    const running = executeDesktopCli(resolve("mock.exe"), [], {
      stateDirectory: resolve("state"), timeoutMs: 25, maxBytes: ["overflow", "stderr"].includes(mode) ? 64 : 4096, mutation: true, signal: controller.signal
    }, fake.spawn, child => child.kill());
    if (mode === "overflow") (fake.child.stdout as PassThrough).write("private".repeat(100));
    if (mode === "stderr") (fake.child.stderr as PassThrough).write("private".repeat(100));
    if (mode === "abort") controller.abort();
    if (mode === "spawn-error") fake.child.emit("error", new Error("private-path"));
    const result = await running;
    assert.equal(result.ok, false); assert.doesNotMatch(JSON.stringify(result), /private/);
    assert.equal((result.error as { disposition: { retry: string } }).disposition.retry,
      ["pre-abort", "spawn-error"].includes(mode) ? "safe" : "unsafe");
    assert.equal(fake.calls.length, mode === "pre-abort" ? 0 : 1);
  });
});

test("service enforces every mutation gate before process creation and protects binary/state", async t => {
  const { policy, root, executable } = await fixture(t);
  const fake = fakeProcess(JSON.stringify(delivered));
  const cli = new DesktopCli(policy, fake.spawn);
  for (const [tool, request] of [
    ["desktop_act", { command: "click", ...target }],
    ["desktop_input", { command: "press", window_id: "w-1", combo: "ctrl+c", headed: true }],
    ["desktop_window", { command: "launch", app_key: "test" }],
    ["desktop_clipboard", { command: "clipboard-get" }],
    ["desktop_screenshot", { window_id: "w-1" }]
  ] as [DesktopTool, unknown][]) assert.equal((await cli.run(tool, request)).ok, false);
  assert.equal(fake.calls.length, 0);
  const files = new HostFiles(policy);
  await assert.rejects(files.write(executable, "replacement"));
  await mkdir(join(root, "state")); await writeFile(join(root, "state", "refmap.json"), "private");
  await assert.rejects(files.read(join(root, "state", "refmap.json")));
  await assert.rejects(files.write(join(root, "state", "new.json"), "private"));
});

test("service runs the pinned binary with namespaces, blocks tampering and unknown launches", async t => {
  const { policy, executable } = await fixture(t, { allow_mutations: true, launch_apps: { editor: "notepad.exe" } });
  const fake = fakeProcess(JSON.stringify(delivered));
  const cli = new DesktopCli(policy, fake.spawn);
  assert.equal((await cli.run("desktop_act", { command: "click", ...target })).ok, true);
  assert.deepEqual(fake.calls[0]!.args, ["--session", "wb-task-1", "click", "--timeout-ms=10000", "--", ref]);
  assert.equal(fake.calls[0]!.file, executable);
  assert.equal((await cli.run("desktop_window", { command: "launch", app_key: "powershell" })).ok, false);
  for (const app_key of ["constructor", "toString", "__proto__"]) {
    assert.equal((await cli.run("desktop_window", { command: "launch", app_key })).ok, false);
  }
  assert.equal((await cli.run("desktop_act", { command: "click", ...target, headed: true })).ok, false);
  await writeFile(executable, "tampered");
  const result = await cli.run("desktop_status", { command: "version" });
  assert.equal((result.error as { code: string }).code, "DESKTOP_BINARY_MISMATCH");
  assert.equal(fake.calls.length, 1);
});

test("service rejects concurrent calls without queuing mutations", async t => {
  const { policy } = await fixture(t);
  const fake = fakeProcess(undefined);
  const cli = new DesktopCli(policy, fake.spawn);
  const controller = new AbortController();
  const first = cli.run("desktop_status", {}, controller.signal);
  assert.equal(((await cli.run("desktop_status", {})).error as { code: string }).code, "DESKTOP_BUSY");
  controller.abort();
  await first;
});

test("physical opt-ins, clipboard read-only policy and launch argv are enforced independently", async t => {
  const f = await fixture(t, { allow_mutations: true, allow_headed: true, clipboard: "read",
    launch_apps: { editor: "notepad.exe" } });
  const denied = fakeProcess(undefined);
  const cli = new DesktopCli(f.policy, denied.spawn);
  assert.equal((await cli.run("desktop_act", { command: "click", ...target, headed: true })).ok, false);
  assert.equal((await cli.run("desktop_clipboard", { command: "clipboard-set", text: "private" })).ok, false);
  assert.equal((await cli.run("desktop_window", { command: "focus-window", window_id: "w-1" })).ok, false);
  assert.equal(denied.calls.length, 0);
  const launch = fakeProcess(JSON.stringify(delivered));
  assert.equal((await new DesktopCli(f.policy, launch.spawn).run("desktop_window", { command: "launch", app_key: "editor" })).ok, true);
  assert.deepEqual(launch.calls[0]!.args, ["--session", "wb-system", "launch", "--timeout=10000", "--", "notepad.exe"]);
  const allowed = await HostPolicy.create({ ...f.source, desktop: { ...f.source.desktop, allow_physical_input: true } }, join(f.root, "allowed-policy.json"));
  const mouse = fakeProcess(JSON.stringify(delivered));
  assert.equal((await new DesktopCli(allowed, mouse.spawn).run("desktop_input", { command: "mouse-move", x: 1, y: 2, headed: true })).ok, true);
  assert.deepEqual(mouse.calls[0]!.args, ["--session", "wb-system", "--headed", "mouse-move", "--xy=1,2"]);
});

test("UTF-8 request limit and disabled-host calls are refused before process creation", async t => {
  const f = await fixture(t, { allow_mutations: true });
  const fake = fakeProcess(undefined);
  const cli = new DesktopCli(f.policy, fake.spawn);
  const result = await cli.run("desktop_act", { command: "set-value", ...target, text: "中".repeat(8000) });
  assert.equal((result.error as { code: string }).code, "DESKTOP_INVALID_ARGUMENT");
  const disabled = await HostPolicy.create({ ...f.source, desktop: { ...f.source.desktop, allowed_hosts: ["other-host"] } }, join(f.root, "other-policy.json"));
  assert.equal((await new DesktopCli(disabled, fake.spawn).run("desktop_status", {})).ok, false);
  assert.equal(fake.calls.length, 0);
  assert.equal(desktopRequestWithinLimit({ state: Array(1000).fill("enabled") }), false);
  assert.equal(desktopRequestWithinLimit({ text: { nested: "unexpected" } }), false);
  assert.equal(desktopRequestWithinLimit({ text: "中".repeat(8000) }), false);
  assert.equal(desktopRequestWithinLimit({ text: "valid", namespace: "test" }), true);
});

test("audit failure before dispatch stops execution; failure after preserves delivery evidence", async t => {
  const { policy } = await fixture(t, { allow_mutations: true });
  for (const failAt of [1, 2]) {
    const fake = fakeProcess(JSON.stringify(delivered));
    const server = new McpServer({ name: "audit-test", version: "1" });
    let count = 0;
    registerDesktopTools(server, policy, async () => { if (++count === failAt) throw new Error("private-audit-path"); }, new DesktopCli(policy, fake.spawn));
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a); await client.connect(b);
      const result = CallToolResultSchema.parse(await client.callTool({ name: "desktop_act", arguments: { request: { command: "click", ...target } } }));
      assert.equal(fake.calls.length, failAt === 1 ? 0 : 1);
      if (failAt === 2) { assert.deepEqual(result.structuredContent, delivered); assert.ok(result._meta?.audit_warning); }
      else assert.equal(result.isError, true);
      assert.doesNotMatch(JSON.stringify(result), /private-audit-path/);
    } finally { await client.close(); await server.close(); }
  }
});

test("MCP registration preserves original envelope and audits names only", async t => {
  const { policy } = await fixture(t, { allow_mutations: true });
  const fake = fakeProcess(JSON.stringify(delivered));
  const audit: Record<string, unknown>[] = [];
  const server = new McpServer({ name: "desktop-test", version: "1" });
  registerDesktopTools(server, policy, async entry => { audit.push(entry); }, new DesktopCli(policy, fake.spawn));
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const listed = (await client.listTools()).tools;
  const names = listed.map(tool => tool.name);
  const actionSchema = JSON.stringify(listed.find(tool => tool.name === "desktop_act")!.inputSchema);
  assert.match(actionSchema, /set-value/); assert.match(actionSchema, /namespace/); assert.match(actionSchema, /timeout_ms/);
  assert.ok(names.includes("desktop_act")); assert.ok(!names.includes("desktop_input"));
  assert.ok(!names.includes("desktop_screenshot")); assert.ok(!names.includes("desktop_clipboard"));
  const invalid = CallToolResultSchema.parse(await client.callTool({ name: "desktop_find",
    arguments: { request: { namespace: "task", app: "test", state: Array(1000).fill("enabled") } } }));
  assert.equal(invalid.isError, true); assert.equal(fake.calls.length, 0); assert.equal(audit.length, 0);
  const result = CallToolResultSchema.parse(await client.callTool({ name: "desktop_act",
    arguments: { request: { command: "set-value", ...target, text: "private-data" } } }));
  assert.deepEqual(result.structuredContent, delivered);
  assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), delivered);
  assert.deepEqual(audit, [{ operation: "desktop_act", state: "started" }, { operation: "desktop_act", state: "completed" }]);
  assert.doesNotMatch(JSON.stringify(audit), /private-data|@s/);
});

test("STDIO exposes desktop instructions only for the configured host, no real CLI or UI runs", async t => {
  const f = await fixture(t, { allow_mutations: true, allow_headed: true, allow_physical_input: true,
    allow_screenshot: true, clipboard: "read-write" });
  for (const enabled of [true, false]) {
    const path = join(f.root, enabled ? "enabled.json" : "disabled.json");
    await writeFile(path, "[]");
    await writeFile(path + ".host-policy.json", JSON.stringify({ ...f.source,
      desktop: { ...f.source.desktop, allowed_hosts: enabled ? [hostname()] : ["another-host"] } }));
    const client = new Client({ name: "desktop-stdio-test", version: "1" });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath,
        args: [resolve("dist/src/mcp-stdio.js"), path], stderr: "pipe" }));
      const tools = (await client.listTools()).tools;
      assert.equal(tools.filter(tool => tool.name.startsWith("desktop_")).length, enabled ? Object.keys(desktopSchemas).length : 0);
      assert.equal(client.getInstructions()?.includes("agent-desktop CLI directly"), enabled);
      const capabilities = CallToolResultSchema.parse(await client.callTool({ name: "host_capabilities", arguments: {} }));
      const body = JSON.parse((capabilities.content[0] as { text: string }).text);
      assert.equal(body.gui_control, enabled); assert.equal(body.desktop.enabled, enabled);
    } finally { await client.close(); }
  }
});
