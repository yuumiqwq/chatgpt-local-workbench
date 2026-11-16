import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createToolRegistry } from "../../../src/api-names.js";
import { HostPolicy } from "../../../src/host/host-policy.js";
import { BrowserPolicySchema } from "../../../src/host/browser-policy.js";
import { BrowserSession, browserCapabilities, registerBrowserTools } from "../../../src/host/browser-tools.js";
import { BrowserCliError, createOpenCliBackend, executeBrowserCommand, opencliEnvironment, type BrowserCommand } from "../../../src/host/browser-opencli.js";

const signal = () => AbortSignal.timeout(30_000);
const audit = async () => {};
async function fixture(t: TestContext) {
  const base = resolve("codex-generated/opencli-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "case-")), entry = join(root, "opencli.mjs"), state = join(root, "private");
  await writeFile(entry, "// test CLI entry\n");
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const policy = await HostPolicy.create({ version: 1, enabled: true, browser: {
    enabled: true, allowed_hosts: [hostname()], state_directory: state, opencli_entry: entry, opencli_context: "edge-context"
  } }, join(root, "policy.json"));
  return { root, entry, state, policy };
}

function mockCli() {
  const calls: string[][] = [], pages = new Map<string, string>();
  let serial = 0;
  const settings = { pid: "1234", failAction: false, badReceipt: false, failClose: false, lostPage: false, extension: "1.0.27", version: "1.8.8-yuumi.1" };
  const execute: BrowserCommand = async args => {
    calls.push([...args]);
    if (args[0] === "--version") return settings.version;
    assert.deepEqual(args.slice(0, 2), ["--profile", "edge-context"]);
    if (args[2] === "daemon") return `Daemon: running (PID ${settings.pid})\nVersion: v${settings.version}\nExtension: connected (v${settings.extension})\nProfiles: edge-context v${settings.extension}`;
    assert.equal(args[2], "browser");
    const session = args[3]!; assert.match(session, /^wb-\d+-[a-f0-9-]+-\d+$/u);
    assert.deepEqual(args.slice(4, 6), ["--window", "background"]);
    const command = args[6];
    assert.ok(!["bind", "unbind", "focus", "eval", "keys", "network"].includes(command!));
    if (command === "tab" && args[7] === "new") { const page = `page-${++serial}`; pages.set(session, page); return JSON.stringify({ page, url: null }); }
    if (command === "tab" && args[7] === "list") return JSON.stringify(pages.has(session) ? [{ page: settings.lostPage ? "foreign-page" : pages.get(session), url: "https://local.invalid/", title: "Owned page", active: false }] : []);
    if (command === "close") { if (settings.failClose) throw new BrowserCliError("BROWSER_TIMEOUT", "test", true); pages.delete(session); return "Closed browser session"; }
    assert.equal(args[7], "--tab"); assert.equal(args[8], pages.get(session));
    if (command === "state") return "url: https://local.invalid/\ntitle: Owned page [55]\n---\n  [12]<input name=Name />\n  |scroll[8]|<button>Save [99]</button>\n  [77] {\"compound\":true}";
    if (["click", "type", "fill"].includes(command!)) {
      assert.equal(args[9], "--"); assert.match(args[10]!, /^\d+$/u);
      if (settings.failAction) throw new BrowserCliError("BROWSER_TIMEOUT", "unknown delivery", true);
      return JSON.stringify({ clicked: true, typed: true, filled: true, verified: !settings.badReceipt, matches_n: 1, match_level: settings.badReceipt ? "reidentified" : "exact" });
    }
    if (command === "open") { assert.equal(args[9], "--"); return "Navigated"; }
    if (command === "wait") return "Text appeared";
    throw new Error("Unexpected CLI command: " + command);
  };
  return { execute, calls, pages, settings };
}

test("browser is opt-in, uses only OpenCLI and reports shared Edge login capabilities", async t => {
  const { policy } = await fixture(t);
  assert.equal(BrowserPolicySchema.parse({}).enabled, false);
  const caps = browserCapabilities(policy);
  assert.equal(caps.backend, "opencli"); assert.equal(caps.reuses_existing_login, true);
  assert.equal(caps.headless, false); assert.equal(caps.existing_tabs_accessible, false);
  assert.equal(caps.tool_names.length, 5);
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(packageJson.dependencies["@playwright/mcp"], undefined);
  await assert.rejects(createOpenCliBackend(BrowserPolicySchema.parse({ ...policy.config.browser, opencli_entry: undefined }), signal()),
    error => error instanceof BrowserCliError && error.code === "BROWSER_SETUP_REQUIRED");
});

test("OpenCLI owns unique sessions/page IDs, transforms refs, uses literal argv and releases only its tabs", async t => {
  const { policy, state } = await fixture(t); const cli = mockCli();
  const backend = await createOpenCliBackend(policy.config.browser, signal(), cli.execute);
  const snapshot = await backend.call("browser_snapshot", { depth: 12 }, signal());
  assert.match(JSON.stringify(snapshot), /ref=e1/);
  assert.match(JSON.stringify(snapshot), /Owned page \[55\]/);
  assert.match(JSON.stringify(snapshot), /Save \[99\]/);
  assert.equal(JSON.stringify(snapshot).match(/ref=e\d+/gu)?.length, 2);
  const literal = '--help "quoted" $(do-not-execute)\n你好';
  await backend.call("browser_type", { target: "e1", text: literal, slowly: false }, signal());
  const fill = cli.calls.find(args => args[6] === "fill")!;
  assert.equal(fill[10], "12"); assert.equal(fill[11], literal);
  await assert.rejects(backend.call("browser_click", { target: "e1" }, signal()), /fresh reference/);
  const refreshed = await backend.call("browser_snapshot", {}, signal());
  assert.match(JSON.stringify(refreshed), /ref=e3/);
  await backend.call("browser_click", { target: "e4" }, signal());
  await backend.call("browser_tabs", { action: "new" }, signal());
  assert.equal(cli.pages.size, 2);
  await backend.call("browser_tabs", { action: "select", index: 0 }, signal());
  assert.ok(!cli.calls.some(args => args[7] === "select"));
  await assert.rejects(backend.call("browser_tabs", { action: "select", index: 31 }, signal()), /connection/);
  await backend.call("browser_navigate", { url: "http://127.0.0.1/test" }, signal());
  await backend.close(); await backend.close();
  assert.equal(cli.pages.size, 0); assert.deepEqual(await readdir(state), []);
});

test("tab mutation followed by failed inventory remains unknown and cannot be replayed", async t => {
  const { policy } = await fixture(t); const cli = mockCli(); let inventories = 0;
  const execute: BrowserCommand = async (args, signal, options) => {
    if (args[6] === "tab" && args[7] === "list" && ++inventories === 3) return "[]";
    return cli.execute(args, signal, options);
  };
  const backend = await createOpenCliBackend(policy.config.browser, signal(), execute);
  await assert.rejects(backend.call("browser_tabs", { action: "new" }, signal()),
    error => error instanceof BrowserCliError && error.uncertain);
  assert.equal(cli.calls.filter(args => args[7] === "new").length, 2);
  await backend.close();
});

test("lost ownership or daemon replacement prevents dispatch and no foreground fallback is used", async t => {
  const { policy } = await fixture(t); const cli = mockCli();
  const backend = await createOpenCliBackend(policy.config.browser, signal(), cli.execute);
  await backend.call("browser_snapshot", {}, signal()); cli.settings.lostPage = true;
  await assert.rejects(backend.call("browser_click", { target: "e1" }, signal()), /page identity/);
  assert.ok(!cli.calls.some(args => args[6] === "click")); cli.settings.lostPage = false;
  cli.settings.pid = "9999";
  await assert.rejects(backend.call("browser_navigate", { url: "https://local.invalid" }, signal()), /daemon changed/);
  cli.settings.pid = "1234"; await backend.close();
});

test("backend prerequisite failures never create a browser tab", async t => {
  for (const bad of ["version", "extension"] as const) {
    const { policy } = await fixture(t); const cli = mockCli(); cli.settings[bad] = "0.1.0";
    await assert.rejects(createOpenCliBackend(policy.config.browser, signal(), cli.execute));
    assert.ok(!cli.calls.some(args => args[2] === "browser"));
  }
});

test("unknown or unverified mutations fence later writes and are not replayed", async t => {
  for (const failure of ["failAction", "badReceipt"] as const) {
    const { policy } = await fixture(t); const cli = mockCli();
    const session = new BrowserSession(policy, (config, signal) => createOpenCliBackend(config, signal, cli.execute));
    await session.run("browser_session", { action: "create" }, signal(), audit);
    await session.run("browser_observe", { action: "snapshot" }, signal(), audit);
    cli.settings[failure] = true;
    const value = await session.run("browser_act", { action: "fill", target: "e1", text: "test" }, signal(), audit);
    assert.equal((value.error as { retry: string }).retry, "unsafe");
    assert.equal((await session.run("browser_act", { action: "fill", target: "e1", text: "test" }, signal(), audit)).ok, false);
    assert.equal(cli.calls.filter(args => args[6] === "fill").length, 1);
    await session.dispose();
  }
});

test("unsupported observation options fail explicitly and cleanup failure retains an owned lease journal", async t => {
  const { policy, state } = await fixture(t); const cli = mockCli();
  const backend = await createOpenCliBackend(policy.config.browser, signal(), cli.execute);
  for (const args of [{ target: "e1" }, { depth: 3 }]) await assert.rejects(backend.call("browser_snapshot", args, signal()), /not supported/);
  await assert.rejects(backend.call("browser_wait_for", { textGone: "test", time: 1 }, signal()), /not supported/);
  await backend.call("browser_wait_for", { text: "test", time: 1 }, signal());
  cli.settings.failClose = true;
  await assert.rejects(backend.close(), /lease.json/);
  const directories = await readdir(state); assert.equal(directories.length, 1);
  const journal = JSON.parse(await readFile(join(state, directories[0]!, "lease.json"), "utf8"));
  assert.equal(journal.tabs.length, 1); assert.match(journal.tabs[0].session, /^wb-/u);
  assert.equal(cli.calls.filter(args => args[6] === "close").length, 1);
});

test("both public name profiles dispatch OpenCLI without adding endpoints", async t => {
  for (const profile of ["v1", "v2"] as const) {
    const { policy } = await fixture(t); const cli = mockCli();
    const server = new McpServer({ name: "opencli-test", version: "1" });
    const session = registerBrowserTools(createToolRegistry(server, profile), policy, audit,
      (config, signal) => createOpenCliBackend(config, signal, cli.execute))!;
    const client = new Client({ name: "opencli-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
    try {
      assert.equal((await client.listTools()).tools.length, 5);
      for (const [name, request] of [["browser_session", { action: "create" }],
        ["browser_navigate", { url: "http://127.0.0.1/test" }], ["browser_observe", { action: "snapshot" }],
        ["browser_act", { action: "click", target: "e2" }], ["browser_tabs", { action: "new" }]] as const) {
        assert.equal((await client.callTool({ name, arguments: { request } })).isError, false);
      }
      await client.callTool({ name: "browser_tabs", arguments: { request: { action: "close", index: 1 } } });
      await client.callTool({ name: "browser_tabs", arguments: { request: { action: "close", index: 0 } } });
      assert.equal((await client.callTool({ name: "browser_tabs", arguments: { request: { action: "new" } } })).isError, false);
    } finally { await client.close(); await server.close(); await session.dispose(); }
    assert.equal(cli.pages.size, 0);
  }
});

test("real Node child preserves literal argv, bounds output, and never inherits private tokens or CDP overrides", async t => {
  const { entry, root } = await fixture(t);
  await writeFile(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
  const literal = ['--help', '"quoted"', '$(not-a-command)', 'a\nb'];
  const options = { entry, cwd: root, timeoutMs: 3000, mutation: false };
  assert.deepEqual(JSON.parse(await executeBrowserCommand(literal, signal(), options)), literal);
  const env = opencliEnvironment(root, 3000);
  assert.equal(env.OPENCLI_WINDOW, "background"); assert.equal(env.TEMP, root);
  assert.equal(env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, undefined); assert.equal(env.OPENCLI_CDP_ENDPOINT, undefined);
  await writeFile(entry, "process.stdout.write('x'.repeat(1048577))");
  await assert.rejects(executeBrowserCommand([], signal(), { ...options, mutation: true }),
    error => error instanceof BrowserCliError && error.code === "BROWSER_OUTPUT_LIMIT" && error.uncertain);
  await writeFile(entry, "process.stderr.write('private-diagnostic');process.exit(1)");
  await assert.rejects(executeBrowserCommand([], signal(), options), error => error instanceof BrowserCliError && !error.message.includes("private-diagnostic"));
});

test("real CLI wait cancellation reports unknown mutation delivery without a second dispatch", async t => {
  const { entry, root } = await fixture(t); await writeFile(entry, "setTimeout(()=>{},10000)");
  await assert.rejects(executeBrowserCommand([], AbortSignal.timeout(100), { entry, cwd: root, timeoutMs: 3000, mutation: true }),
    error => error instanceof BrowserCliError && error.code === "BROWSER_CANCELLED" && error.uncertain);
});
