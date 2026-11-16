import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createToolRegistry } from "../../../src/api-names.js";
import { DesktopCli, desktopFailure, type DesktopEnvelope } from "../../../src/host/desktop-cli.js";
import { desktopSequenceSchema, runDesktopSequence } from "../../../src/host/desktop-sequence.js";
import { registerDesktopTools } from "../../../src/host/desktop-tools.js";
import { HostPolicy } from "../../../src/host/host-policy.js";

const target = { namespace: "sequence", ref: "@s123:e1" };
const read = { tool: "desktop_read" as const, request: { ...target, command: "get", property: "value" } };
const act = { tool: "desktop_act" as const, request: { ...target, command: "set-value", text: "done" } };
const verify = { observation: read, data_path: ["value"], equals: "done" };
const delivered: DesktopEnvelope = { ok: true, data: { disposition: { delivery: "delivered_unverified", retry: "unsafe" } } };
const observation: DesktopEnvelope = { ok: true, data: { value: "done" } };
const sequence = { namespace: "sequence", steps: [{ operation: act, verify }, { operation: read }] };
const audit = async () => {};
const signal = () => AbortSignal.timeout(5000);

test("sequence uses existing schemas, preserves refs, requires one namespace and bounds steps", () => {
  assert.ok(desktopSequenceSchema.safeParse(sequence).success);
  for (const value of [
    { ...sequence, steps: [] }, { ...sequence, steps: Array(9).fill(sequence.steps[0]) },
    { ...sequence, namespace: "other" }, { ...sequence, script: "anything" },
    { ...sequence, steps: [{ operation: { ...act, request: { ...act.request, ref: "@e1" } } }] },
    { ...sequence, steps: [{ operation: { tool: "desktop_input", request: {} } }] }
  ]) assert.equal(desktopSequenceSchema.safeParse(value).success, false);
});

test("sequence verifies each mutation, audits every operation and bounds output", async () => {
  const calls: unknown[] = [], events: Record<string, unknown>[] = [];
  const result = await runDesktopSequence(sequence, { run: async (tool, request) => {
    calls.push([tool, request]); return tool === "desktop_act" ? delivered : { ...observation, extra: "x".repeat(30_000) };
  } }, async event => { events.push(event); }, signal());
  assert.equal(result.ok, true); assert.equal(result.completed_count, 2); assert.equal(calls.length, 3);
  assert.equal(events.length, 6); assert.ok(Buffer.byteLength(JSON.stringify(result)) < 20_000);
  assert.equal((calls[0] as unknown[])[0], "desktop_act");
  assert.deepEqual((calls[0] as unknown[])[1], { ...act.request, headed: false, timeout_ms: 10_000 });
});

test("sequence stops on failed, unknown, unverified or mismatching results without replay", async () => {
  for (const [first, verificationResult, expected, callsExpected] of [
    [desktopFailure("STALE_REF", "observe"), observation, "operation_failed", 1],
    [{ ok: true, data: { disposition: { delivery: "unknown" } } }, observation, "unknown_delivery", 1],
    [delivered, { ok: true, data: { value: "wrong" } }, "verification_failed", 2],
    [delivered, { ok: true, data: { other: "done" } }, "verification_failed", 2],
    [delivered, { ok: true, data: { value: "done", identity_unproven: true } }, "verification_failed", 2],
    [delivered, { ok: false, error: { code: "TIMEOUT" } }, "verification_failed", 2]
  ] as const) {
    let calls = 0;
    const result = await runDesktopSequence(sequence, { run: async () => ++calls === 1 ? first : verificationResult }, audit, signal());
    assert.equal(result.ok, false); assert.equal(result.completed_count, 0);
    assert.equal(result.stopped_reason, expected); assert.equal(calls, callsExpected);
  }
  let calls = 0;
  const unverified = await runDesktopSequence({ ...sequence, steps: [{ operation: act }, { operation: read }] },
    { run: async () => { calls++; return delivered; } }, audit, signal());
  assert.equal(unverified.stopped_reason, "mutation_unverified"); assert.equal(calls, 1);
});

test("sequence wait predicates, total deadline and headed policy use the same CLI boundary", async () => {
  const waitVerify = { observation: { tool: "desktop_wait", request: {
    condition: "element", ...target, predicate: "value", value: "done", timeout_ms: 100
  } }, data_path: ["matched"], equals: true };
  let calls = 0;
  const verified = await runDesktopSequence({ ...sequence, steps: [{ operation: act, verify: waitVerify }] },
    { run: async tool => { calls++; return tool === "desktop_act" ? delivered : { ok: true, data: { matched: true } }; } }, audit, signal());
  assert.equal(verified.ok, true); assert.equal(calls, 2);
  const timer = setTimeout(() => {}, 1000);
  try {
    const timed = await runDesktopSequence({ ...sequence, timeout_ms: 100 }, { run: async (_tool, _args, signal) => {
      await new Promise<void>(resolve => signal!.addEventListener("abort", () => resolve(), { once: true }));
      return desktopFailure("DESKTOP_TIMEOUT", "deadline", true);
    } }, audit, signal());
    assert.equal(timed.completed_count, 0); assert.equal(timed.attempted_count, 1);
  } finally { clearTimeout(timer); }
  const policy = await HostPolicy.create({ version: 1, enabled: true, desktop: {
    enabled: true, allowed_hosts: [hostname()], executable: process.execPath, executable_sha256: "0".repeat(64),
    state_directory: resolve("codex-generated/sequence-policy-state"), allow_mutations: true
  } }, resolve("codex-generated/sequence-policy.json"));
  const denied = await runDesktopSequence({ namespace: "sequence", steps: [{ operation: {
    tool: "desktop_window", request: { command: "focus-window", window_id: "w1", headed: true }
  } }] }, new DesktopCli(policy), audit, signal());
  assert.match(JSON.stringify(denied), /DESKTOP_POLICY_DENIED/);
});

test("sequence preserves partial progress, cancellation, audit failure and actual CLI policy checks", async () => {
  let calls = 0;
  const controller = new AbortController();
  const result = await runDesktopSequence({ ...sequence, steps: [{ operation: read }, { operation: act, verify }] },
    { run: async () => { calls++; controller.abort(); return observation; } }, audit, controller.signal);
  assert.equal(result.completed_count, 1); assert.equal(calls, 1); assert.equal(result.ok, false);
  calls = 0;
  const denied = await runDesktopSequence(sequence, { run: async () => { calls++; return delivered; } }, async () => { throw new Error(); }, signal());
  assert.equal(denied.ok, false); assert.equal(calls, 0);
  const policy = await HostPolicy.create({ version: 1 }, resolve("codex-generated/sequence-denied-policy.json"));
  const disabled = await runDesktopSequence(sequence, new DesktopCli(policy), audit, signal());
  assert.match(JSON.stringify(disabled), /DESKTOP_DISABLED/);
  const thrown = await runDesktopSequence(sequence, { run: async () => { throw new Error(); } }, audit, signal());
  assert.match(JSON.stringify(thrown), /DESKTOP_UNKNOWN_RESULT/);
});

test("desktop_sequence dispatches in both profiles with stub CLI, locks other calls and cancels on disconnect", async t => {
  const base = resolve("codex-generated/sequence-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "case-")); t.after(() => rm(root, { recursive: true, force: true }));
  for (const profile of ["v1", "v2"] as const) {
    const policy = await HostPolicy.create({ version: 1, enabled: true, desktop: {
      enabled: true, allowed_hosts: [hostname()], executable: process.execPath, executable_sha256: "0".repeat(64),
      state_directory: root, allow_mutations: true
    } }, join(root, "policy.json"));
    const server = new McpServer({ name: "sequence", version: "1" });
    let pending = false, observedAbort = false;
    registerDesktopTools(createToolRegistry(server, profile), policy, audit, { run: async (tool, _args, signal) => {
      if (pending) await new Promise<void>(resolve => signal!.addEventListener("abort", () => { observedAbort = true; resolve(); }, { once: true }));
      return tool === "desktop_act" ? delivered : observation;
    } });
    const client = new Client({ name: "sequence", version: "1" }); const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b); await client.connect(a);
    const result = await client.callTool({ name: "desktop_sequence", arguments: { request: sequence } });
    assert.equal(result.isError, false); assert.equal((result.structuredContent as Record<string, unknown>).completed_count, 2);
    pending = true;
    const running = client.callTool({ name: "desktop_sequence", arguments: { request: sequence } }).catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    const busy = await client.callTool({ name: "desktop_read", arguments: { request: read.request } });
    assert.equal(busy.isError, true); assert.match(JSON.stringify(busy), /DESKTOP_BUSY/);
    await client.close(); await server.close(); await running;
    await new Promise(resolve => setImmediate(resolve)); assert.equal(observedAbort, true);
  }
});
