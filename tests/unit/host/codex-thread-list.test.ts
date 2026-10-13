import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import test from "node:test";
import type { ProcessStarter } from "../../../src/executors/codex-process.js";
import { queryCodexThread, queryCodexThreadList } from "../../../src/host/codex-thread-list.js";
import { HostError } from "../../../src/host/host-policy.js";

function fixture(mode: "ok" | "hold" | "oversize" | "error" = "ok") {
  const messages: { method: string; params: Record<string, unknown> }[] = [];
  let killed = false;
  const start: ProcessStarter = (_exe, args, options) => {
    assert.equal(options.windowsHide, true);
    assert.equal(options.shell, false);
    assert.equal(options.env?.PRIVATE_KEY, undefined);
    assert.equal(args.includes('mcp_servers.engineering-bridge.enabled=false'), true);
    const child = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new Writable({ write(chunk, _encoding, done) {
      const message = JSON.parse(chunk.toString());
      messages.push(message);
      queueMicrotask(() => {
        if (mode === "hold" || message.id === undefined) return;
        if (message.id === 1) { stdout.write(JSON.stringify({ id: 1, result: {} }) + "\n"); return; }
        if (mode === "oversize") { stdout.write("x".repeat(1_048_577)); return; }
        if (mode === "error") { stdout.write(JSON.stringify({ id: 2, error: { message: "PRIVATE_KEY" } }) + "\n"); return; }
        const response = Buffer.from(JSON.stringify({ id: 2, result: { data: [], nextCursor: "下一页" } }) + "\n");
        const split = response.indexOf(Buffer.from("下")) + 1;
        stdout.write(response.subarray(0, split));
        stdout.write(response.subarray(split));
      });
      done();
    } });
    Object.assign(child, { stdin, stdout, stderr, kill() { killed = true; return true; } });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return { start, messages, killed: () => killed };
}

test("catalog uses native thread/list without starting a model and handles split UTF-8", async () => {
  const f = fixture();
  const result = await queryCodexThreadList(process.cwd(), { limit: 2 }, undefined, f.start, 1000, { PRIVATE_KEY: "hidden" });
  assert.deepEqual(result, { data: [], nextCursor: "下一页" });
  assert.deepEqual(f.messages.map(message => message.method), ["initialize", "initialized", "thread/list"]);
  assert.equal(f.killed(), true);
});

test("catalog timeout and cancellation clean up only their own child", async () => {
  const timeout = fixture("hold");
  await assert.rejects(queryCodexThreadList(process.cwd(), {}, undefined, timeout.start, 20, {}),
    { code: "CODEX_CATALOG_TIMEOUT" });
  assert.equal(timeout.killed(), true);
  const cancelled = fixture("hold");
  const controller = new AbortController();
  const pending = queryCodexThreadList(process.cwd(), {}, controller.signal, cancelled.start, 1000, {});
  controller.abort();
  await assert.rejects(pending, { code: "CODEX_CATALOG_CANCELLED" });
  assert.equal(cancelled.killed(), true);
  assert.throws(() => queryCodexThreadList(process.cwd(), {}, controller.signal, cancelled.start, 1000, {}),
    { name: "AbortError" });
});

test("catalog rejects oversized and error responses without reflecting private diagnostics", async () => {
  for (const mode of ["oversize", "error"] as const) {
    const f = fixture(mode);
    await assert.rejects(queryCodexThreadList(process.cwd(), {}, undefined, f.start, 1000, {}), error =>
      error instanceof HostError && error.code === "CODEX_CATALOG_FAILED" && !error.message.includes("PRIVATE_KEY"));
    assert.equal(f.killed(), true);
  }
});

test("native management errors describe the request without misreporting a thread-list failure", async () => {
  const f = fixture("error");
  await assert.rejects(queryCodexThread(process.cwd(), "thread/archive", { threadId: "thread" }, undefined, f.start, 1000, {}), error =>
    error instanceof HostError && error.code === "CODEX_CATALOG_FAILED" &&
    error.message === "Codex could not complete the local request.");
  assert.equal(f.messages.at(-1)?.method, "thread/archive");
  assert.equal(f.killed(), true);
});
