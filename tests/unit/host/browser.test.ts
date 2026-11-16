import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createToolRegistry } from "../../../src/api-names.js";
import { BrowserPolicySchema } from "../../../src/host/browser-policy.js";
import { BROWSER_BACKEND_METHODS, BrowserSession, browserCapabilities, browserSchemas, createBrowserBackend, registerBrowserTools, type BrowserBackend } from "../../../src/host/browser-tools.js";
import { HostPolicy } from "../../../src/host/host-policy.js";

async function fixture(t: TestContext, overrides: Record<string, unknown> = {}) {
  const base = resolve("codex-generated/browser-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "case-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const policy = await HostPolicy.create({ version: 1, enabled: true, browser: {
    enabled: true, allowed_hosts: [hostname()], state_directory: root, ...overrides
  } }, join(root, "policy.json"));
  return { root, policy };
}
const result = (text: string, isError = false): CallToolResult => ({ content: [{ type: "text", text }], isError });
const signal = () => AbortSignal.timeout(60_000);
const audit = async () => {};

test("official pinned MCP child advertises the exact allowed input contract without launching a browser", async () => {
  const client = new Client({ name: "browser-contract", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [resolve("node_modules/@playwright/mcp/cli.js"), "--browser", "msedge", "--headless"], stderr: "ignore" }));
    const tools = (await client.listTools()).tools;
    for (const name of BROWSER_BACKEND_METHODS) assert.ok(tools.some(tool => tool.name === name), name);
    for (const name of ["browser_click", "browser_type"]) {
      const schema = tools.find(tool => tool.name === name)!.inputSchema;
      assert.ok(schema.properties?.target); assert.ok(schema.required?.includes("target"));
    }
    const snapshot = tools.find(tool => tool.name === "browser_snapshot")!.inputSchema;
    assert.ok(snapshot.properties?.target); assert.ok(snapshot.properties?.depth);
    assert.deepEqual(tools.find(tool => tool.name === "browser_close")!.inputSchema.properties, {});
    const version = JSON.parse(await readFile("node_modules/@playwright/mcp/package.json", "utf8")).version;
    assert.equal(version, "0.0.85");
  } finally { await client.close(); }
});

test("browser policy, strict arguments, clipping, failure fencing and connection disposal", async t => {
  assert.equal(BrowserPolicySchema.parse({}).enabled, false);
  assert.throws(() => BrowserPolicySchema.parse({ enabled: true }));
  assert.throws(() => BrowserPolicySchema.parse({ enabled: true, allowed_hosts: [hostname()], state_directory: "C:\\private" }));
  assert.throws(() => browserSchemas.browser_navigate.parse({ url: "file:///E:/secret" }));
  assert.throws(() => browserSchemas.browser_navigate.parse({ url: "https://user:pass@example.com" }));
  assert.throws(() => browserSchemas.browser_act.parse({ action: "click", target: "body" }));
  assert.throws(() => browserSchemas.browser_session.parse({ action: "create", cdp: "http://localhost" }));
  const { policy } = await fixture(t, { max_output_bytes: 4096 });
  const calls: string[] = []; let closes = 0, fail = false;
  const backend: BrowserBackend = { call: async name => { calls.push(name); return result("- button Test [ref=e1]\n" + "x".repeat(6000), fail); }, close: async () => { closes++; } };
  const session = new BrowserSession(policy, async () => backend);
  assert.equal((await session.run("browser_navigate", { url: "http://localhost" }, signal(), audit)).ok, false);
  await session.run("browser_session", { action: "create" }, signal(), audit);
  const clipped = await session.run("browser_observe", { action: "snapshot" }, signal(), audit);
  assert.equal(clipped.truncated, true); assert.equal(Buffer.byteLength(String(clipped.output)), 4096);
  fail = true;
  assert.equal((await session.run("browser_act", { action: "click", target: "e1" }, signal(), audit)).ok, false);
  fail = false;
  const before = calls.length;
  assert.equal((await session.run("browser_act", { action: "click", target: "e1" }, signal(), audit)).ok, false);
  assert.equal(calls.length, before);
  await session.run("browser_observe", { action: "snapshot" }, signal(), audit);
  assert.equal((await session.run("browser_act", { action: "fill", target: "e1", text: "hello" }, signal(), audit)).ok, true);
  await session.dispose(); assert.equal(closes, 1);
  assert.equal((await session.run("browser_session", { action: "create" }, signal(), audit)).ok, false);
});

test("browser registration and dispatch work in both profiles; policy and audit fail before launch", async t => {
  for (const profile of ["v1", "v2"] as const) {
    const { policy } = await fixture(t); let launches = 0, closes = 0;
    const server = new McpServer({ name: "browser-tools", version: "1" });
    const session = registerBrowserTools(createToolRegistry(server, profile), policy, audit, async () => {
      launches++; return { call: async () => result("- heading Ready [ref=e1]"), close: async () => { closes++; } };
    })!;
    const client = new Client({ name: "browser-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b); await client.connect(a);
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), Object.keys(browserSchemas).sort());
    for (const [name, request] of [
      ["browser_session", { action: "create" }], ["browser_navigate", { url: "http://localhost" }],
      ["browser_observe", { action: "snapshot" }], ["browser_act", { action: "click", target: "e1" }],
      ["browser_tabs", { action: "list" }]
    ] as const) assert.equal((await client.callTool({ name, arguments: { request } })).isError, false);
    assert.equal(launches, 1);
    await client.close(); await server.close(); await session.dispose(); assert.equal(closes, 1);
    const denied = new BrowserSession(policy, async () => { launches++; throw new Error(); });
    assert.equal((await denied.run("browser_session", { action: "create" }, signal(), async () => { throw new Error(); })).ok, false);
    assert.equal(launches, 1);
  }
  const wrong = await fixture(t, { allowed_hosts: ["wrong-host"] });
  assert.equal(browserCapabilities(wrong.policy).enabled, false);
  const denied = new BrowserSession(wrong.policy, async () => { throw new Error("must not launch"); });
  assert.equal((await denied.run("browser_session", { action: "create" }, signal(), audit)).ok, false);
});

test("browser cancellation and concurrent requests never replay a mutation", async t => {
  const { policy } = await fixture(t); let calls = 0, closes = 0;
  const session = new BrowserSession(policy, async () => ({ close: async () => { closes++; },
    call: async (name, _args, signal) => {
      if (name === "browser_snapshot") return result("- button Test [ref=e1]");
      calls++; await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); return result("");
    } }));
  await session.run("browser_session", { action: "create" }, signal(), audit);
  await session.run("browser_observe", { action: "snapshot" }, signal(), audit);
  const controller = new AbortController();
  const first = session.run("browser_act", { action: "click", target: "e1" }, controller.signal, audit);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await session.run("browser_act", { action: "click", target: "e1" }, signal(), audit)).ok, false);
  controller.abort(); assert.equal((await first).ok, false); assert.equal(calls, 1); assert.equal(closes, 1);
  await session.dispose();
});

test("browser private state is protected and sessions cannot cross Bridge connections", async t => {
  const { root, policy } = await fixture(t);
  const configured = await HostPolicy.create({ version: 1, enabled: true, read_roots: [root], write_roots: [root],
    export_roots: [root], browser: { ...policy.config.browser, state_directory: join(root, "private") }
  }, join(root, "policy.json"));
  await mkdir(join(root, "private")); await writeFile(join(root, "private", "Cookies"), "test-only");
  for (const access of ["read", "write"] as const) await assert.rejects(configured.check(join(root, "private", "Cookies"), access));
  await assert.rejects(configured.checkExport(join(root, "private", "Cookies")));
  let launches = 0;
  const factory = async () => { launches++; return { call: async () => result("- button Test [ref=e1]"), close: async () => {} }; };
  const first = new BrowserSession(policy, factory), second = new BrowserSession(policy, factory);
  await first.run("browser_session", { action: "create" }, signal(), audit);
  assert.equal((await second.run("browser_navigate", { url: "http://localhost" }, signal(), audit)).ok, false);
  assert.equal((await first.run("browser_act", { action: "click", target: "e1" }, signal(), audit)).ok, false);
  assert.equal(launches, 1);
  await first.dispose(); await second.dispose();
});

test("real headless Edge local-page smoke, persistent profile lock and cleanup", {
  skip: process.env.WORKBENCH_BROWSER_SMOKE !== "1", timeout: 120_000
}, async t => {
  const { root, policy } = await fixture(t, { profile_name: "smoke" });
  const http = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end('<title>Workbench smoke</title><label>Name<input id="name"></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output>Pending</output><p id="persist"></p><script>persist.textContent=localStorage.getItem("own-test")||"First visit";localStorage.setItem("own-test","Returning visit")</script>');
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => http.close(() => resolve())));
  const port = (http.address() as { port: number }).port;
  for (const profile of ["v1", "v2"] as const) {
    const server = new McpServer({ name: "browser-smoke", version: "1" });
    const session = registerBrowserTools(createToolRegistry(server, profile), policy, audit)!;
    const client = new Client({ name: "browser-smoke", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
    const call = async (name: string, request: unknown) => {
      const value = await client.callTool({ name, arguments: { request } });
      assert.equal(value.isError, false, JSON.stringify(value));
      return value.structuredContent as Record<string, unknown>;
    };
    try {
      await call("browser_session", { action: "create" });
      await assert.rejects(createBrowserBackend(policy.config.browser, signal()), /EEXIST/);
      await call("browser_navigate", { url: `http://127.0.0.1:${port}` });
      const snapshot = String((await call("browser_observe", { action: "snapshot" })).output);
      assert.match(snapshot, profile === "v1" ? /First visit/ : /Returning visit/);
      const input = snapshot.match(/textbox.*?\[ref=(e\d+)\]/u)![1];
      const button = snapshot.match(/button.*?\[ref=(e\d+)\]/u)![1];
      await call("browser_act", { action: "fill", target: input, text: "Local smoke" });
      await call("browser_act", { action: "type", target: input, text: " passed" });
      await call("browser_act", { action: "click", target: button });
      await call("browser_observe", { action: "wait", text: "Local smoke passed" });
      assert.match(String((await call("browser_observe", { action: "find", text: "Local smoke passed" })).output), /Local smoke passed/);
      await call("browser_tabs", { action: "new" });
      await call("browser_tabs", { action: "select", index: 0 });
      await call("browser_tabs", { action: "close", index: 1 });
      await call("browser_tabs", { action: "list" });
    } finally { await client.close(); await server.close(); await session.dispose(); }
    assert.deepEqual((await readdir(root)).filter(name => name.startsWith("browser-") || name.endsWith(".lock")), []);
    assert.ok((await readdir(root)).includes("profile-smoke"));
  }
});
