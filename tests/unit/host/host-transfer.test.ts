import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createToolRegistry } from "../../../src/api-names.js";
import { HostError, HostPolicy } from "../../../src/host/host-policy.js";
import { registerHostTools } from "../../../src/host/host-tools.js";
import { HostTransfers, runSftp, sftpArguments, transferCapabilities, type SftpJob, type SftpRunner } from "../../../src/host/host-transfer.js";
import { safeLocalPath, safeRelativePath, TransferPolicySchema, TransferRequestSchema } from "../../../src/host/transfer-policy.js";

const payload = Buffer.from("verified transfer\0数据", "utf8");
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
async function fixture(t: TestContext, overrides: Record<string, unknown> = {}) {
  const base = resolve("codex-generated/transfer-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "case-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const allowed = join(root, "allowed"); await mkdir(allowed);
  const identity = join(allowed, "private-identity"), known = join(allowed, "host-pins");
  await writeFile(identity, "TEST_ONLY_NOT_A_KEY"); await writeFile(known, "TEST_ONLY_NOT_A_HOST_KEY");
  const config = { enabled: true, executable: process.execPath, ssh_executable: process.execPath,
    peers: { legion: { host: "100.64.0.2", user: "workbench_read", port: 2222,
      identity_file: identity, known_hosts_file: known, read_roots: { exports: "/exports/reviewed" } } }, ...overrides };
  const policy = await HostPolicy.create({ version: 1, enabled: true, read_roots: [allowed], write_roots: [allowed],
    transfer: config }, join(root, "policy.json"));
  const request = { source_peer: "legion", source_root: "exports", source_path: "sub dir/数据.bin",
    destination: join(allowed, "received.bin"), expected_sha256: digest(payload), expected_bytes: payload.length };
  return { root, allowed, identity, known, config, policy, request };
}
const receive: SftpRunner = async job => { await writeFile(job.temporaryFile, payload); };
const clean = async (directory: string) => assert.deepEqual((await readdir(directory)).filter(name => name.startsWith(".workbench-transfer-")), []);

test("transfer is default-off and enabled configuration is strict", () => {
  assert.equal(TransferPolicySchema.parse({}).enabled, false);
  for (const value of [{ enabled: true }, { enabled: true, executable: "sftp" }, { args: [] },
    { max_bytes: 536870913 }, { timeout_ms: 600001 }, { timeout_ms: 0 }]) {
    assert.equal(TransferPolicySchema.safeParse(value).success, false);
  }
});

test("literal paths reject traversal, Windows aliases, globs and SFTP injection", async t => {
  const f = await fixture(t);
  for (const path of ["../x", "a/../x", "/absolute", "C:/file", "a\\b", "a//b", "./a", "a/.", "a/",
    "a*", "a?", "[ab]", "{ab}", "a\nb", "a\rb", "a\0b", "a\tb", 'a"b', "a'b", "a`b", "a$b", "!cmd", "a;b",
    "a|b", "a&b", "a<b", "a>b", "a:b", "a%h", "NUL", "con.txt", "a. ", "a.", "a\u2028b", "a\u202eb"]) {
    assert.equal(safeRelativePath(path), false, JSON.stringify(path));
    await assert.rejects(new HostTransfers(f.policy, () => assert.fail("must not spawn"))
      .transfer({ ...f.request, source_path: path }), code("HOST_TRANSFER_INVALID_ARGUMENT"));
  }
  for (const path of ["a", "file with spaces", "中文/数据.bin", "sub/-file"]) assert.equal(safeRelativePath(path), true);
  assert.equal(TransferRequestSchema.safeParse({ ...f.request, host: "attacker" }).success, false);
  if (process.platform === "win32") for (const path of ["/root-relative", "\\root-relative", "C:relative", "\\\\server\\share\\file"]) {
    assert.equal(safeLocalPath(path), false, path);
  }
  for (const peer of [{ host: "-oProxyCommand=x" }, { user: "a\nProxyCommand=x" }, { identity_file: "relative" },
    { known_hosts_file: f.known + '"' }, { read_roots: { exports: "/" } }, { read_roots: { exports: "/export/../secret" } }]) {
    assert.equal(TransferPolicySchema.safeParse({ ...f.config, peers: { legion: { ...f.config.peers.legion, ...peer } } }).success, false);
  }
  assert.equal(TransferPolicySchema.safeParse({ ...f.config,
    peers: { legion: { ...f.config.peers.legion, read_roots: { exports: "/E:/Exports" } } } }).success, true);
});

test("SSH invocation pins identity, host keys, executables and noninteractive direct transport", async t => {
  const f = await fixture(t), config = f.policy.config.transfer;
  const args = sftpArguments(config, config.peers.legion!, join(f.root, "empty config"));
  assert.deepEqual(args.slice(0, 12), ["-F", join(f.root, "empty config"), "-S", process.execPath,
    "-b", "-", "-B", "32768", "-R", "1", "-P", "2222"]);
  for (const option of ["BatchMode=yes", "IdentitiesOnly=yes", "IdentityAgent=none", "StrictHostKeyChecking=yes",
    "PasswordAuthentication=no", "KbdInteractiveAuthentication=no", "GlobalKnownHostsFile=none",
    "ProxyCommand=none", "ProxyJump=none", "ControlPath=none", "PermitLocalCommand=no", "UpdateHostKeys=no"])
    assert.ok(args.includes(option), option);
  assert.ok(args.includes(`UserKnownHostsFile="${f.known.replaceAll("\\", "/")}"`));
  assert.equal(args.at(-1), "100.64.0.2");
  assert.equal(sftpArguments(config, { ...config.peers.legion!, host: "fd7a:115c:a1e0::1" }, "unused").at(-1), "[fd7a:115c:a1e0::1]");
});

test("verified binary and zero-byte files publish atomically and staging disappears", async t => {
  const f = await fixture(t);
  const result = await new HostTransfers(f.policy, async job => {
    await assert.rejects(lstat(f.request.destination), { code: "ENOENT" });
    assert.equal(job.batch, 'get "/exports/reviewed/sub dir/数据.bin" "payload"\nquit\n');
    assert.equal(await readFile(join(job.cwd, "ssh_config"), "utf8"), "");
    assert.equal(job.maxBytes, payload.length);
    await receive(job, new AbortController().signal);
  }).transfer(f.request);
  assert.equal(result.sha256, digest(payload)); assert.equal(result.bytes, payload.length);
  assert.deepEqual(await readFile(f.request.destination), payload);
  assert.equal((await lstat(f.request.destination)).nlink, 1);
  await clean(f.allowed);
  const empty = { ...f.request, destination: join(f.allowed, "empty"), expected_bytes: 0, expected_sha256: digest("") };
  await new HostTransfers(f.policy, async job => { await writeFile(job.temporaryFile, ""); }).transfer(empty);
  assert.equal((await lstat(empty.destination)).size, 0); await clean(f.allowed);
});

test("peer aliases, write roots, protected paths and expected size fail before launching", async t => {
  const f = await fixture(t, { max_bytes: 100 });
  const transfers = new HostTransfers(f.policy, () => assert.fail("must not spawn"));
  for (const [change, expected] of [
    [{ source_peer: "other" }, "HOST_TRANSFER_SOURCE_DENIED"],
    [{ source_peer: "constructor" }, "HOST_TRANSFER_SOURCE_DENIED"],
    [{ source_root: "other" }, "HOST_TRANSFER_SOURCE_DENIED"],
    [{ destination: join(f.root, "outside") }, "HOST_PATH_DENIED"],
    [{ destination: f.identity }, "HOST_PATH_DENIED"],
    [{ destination: f.known }, "HOST_PATH_DENIED"],
    [{ destination: f.request.destination + "\n" }, "HOST_TRANSFER_INVALID_ARGUMENT"],
    [{ destination: f.allowed + "/sub/../escaped" }, "HOST_TRANSFER_INVALID_ARGUMENT"],
    [{ expected_bytes: 101 }, "HOST_TRANSFER_SIZE_LIMIT"],
    [{ destination: join(f.allowed, "missing", "file") }, "ENOENT"]
  ] as const) await assert.rejects(transfers.transfer({ ...f.request, ...change }), code(expected));
  await assert.rejects(f.policy.check(f.identity, "read"), code("HOST_PATH_DENIED"));
  await clean(f.allowed);
});

test("existing and racing destinations are never overwritten", async t => {
  const f = await fixture(t);
  await writeFile(f.request.destination, "existing");
  await assert.rejects(new HostTransfers(f.policy, () => assert.fail("must not spawn")).transfer(f.request), code("HOST_TRANSFER_DESTINATION_EXISTS"));
  await rm(f.request.destination);
  await assert.rejects(new HostTransfers(f.policy, async job => {
    await writeFile(job.temporaryFile, payload); await writeFile(f.request.destination, "racing writer");
  }).transfer(f.request), code("HOST_TRANSFER_DESTINATION_EXISTS"));
  assert.equal(await readFile(f.request.destination, "utf8"), "racing writer"); await clean(f.allowed);
});

test("hash mismatch, truncation and excess bytes remove staging without publication", async t => {
  const f = await fixture(t);
  for (const [data, expected] of [[Buffer.alloc(payload.length), "HASH_MISMATCH"],
    [payload.subarray(1), "SIZE_MISMATCH"], [Buffer.concat([payload, payload]), "SIZE_MISMATCH"]] as const) {
    await assert.rejects(new HostTransfers(f.policy, async job => { await writeFile(job.temporaryFile, data); })
      .transfer(f.request), code("HOST_TRANSFER_" + expected));
    await assert.rejects(lstat(f.request.destination), { code: "ENOENT" }); await clean(f.allowed);
  }
});

test("destination junctions and staging hard links are rejected", async t => {
  const f = await fixture(t);
  const alias = join(f.allowed, "alias"); await symlink(f.root, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(new HostTransfers(f.policy, receive).transfer({ ...f.request, destination: join(alias, "escape") }), code("HOST_PATH_DENIED"));
  const insideAlias = join(f.allowed, "inside-alias");
  await symlink(f.allowed, insideAlias, process.platform === "win32" ? "junction" : "dir");
  const followsLinks = await HostPolicy.create({ version: 1, enabled: true, follow_links: true,
    write_roots: [f.allowed], transfer: f.config }, join(f.root, "follow-policy"));
  await assert.rejects(new HostTransfers(followsLinks, receive).transfer({ ...f.request, destination: join(insideAlias, "file") }), code("HOST_PATH_DENIED"));
  await assert.rejects(new HostTransfers(f.policy, async job => {
    await writeFile(job.temporaryFile, payload); await link(job.temporaryFile, join(f.root, "extra-link"));
  }).transfer(f.request), code("HOST_TRANSFER_FILE_UNSUPPORTED"));
  await clean(f.allowed);
});

test("cancellation before launch, concurrency limit and disconnect cleanup", async t => {
  const f = await fixture(t);
  await assert.rejects(new HostTransfers(f.policy, () => assert.fail("must not spawn"))
    .transfer(f.request, AbortSignal.abort()), code("HOST_TRANSFER_CANCELLED"));
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const transfers = new HostTransfers(f.policy, async (job, signal) => {
    await writeFile(job.temporaryFile, "partial"); started();
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const active = transfers.transfer(f.request); const rejected = assert.rejects(active, code("HOST_TRANSFER_CANCELLED"));
  await ready;
  await assert.rejects(transfers.transfer(f.request), code("HOST_TRANSFER_BUSY"));
  transfers.dispose(); await rejected; await clean(f.allowed);
  await assert.rejects(lstat(f.request.destination), { code: "ENOENT" });
});

function mockRunner(mode: string, pids: number[], ready?: () => void): SftpRunner {
  return (job, signal) => runSftp(job, signal, (executable, args, options) => {
    assert.equal(executable, process.execPath);
    assert.equal(args.at(-1), "100.64.0.2");
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.equal(options.env?.SSH_AUTH_SOCK, undefined); assert.equal(options.env?.PATH, undefined);
    const child = spawn(process.execPath, [resolve("tests/fixtures/mock-sftp.mjs"), mode], options);
    if (child.pid) pids.push(child.pid);
    child.once("spawn", () => ready?.());
    return child;
  });
}

test("mock process integration covers success, diagnostics, growth, deadline and cancellation", async t => {
  for (const mode of ["success", "failure", "output", "grow", "hang", "cancel"]) await t.test(mode, async t => {
    const f = await fixture(t, { timeout_ms: mode === "hang" ? 1000 : 10000 });
    const pids: number[] = [], abort = new AbortController();
    const transfer = new HostTransfers(f.policy, mockRunner(mode === "cancel" ? "hang" : mode, pids,
      mode === "cancel" ? () => setTimeout(() => abort.abort(), 100) : undefined));
    const operation = transfer.transfer(f.request, abort.signal);
    if (mode === "success") {
      await operation; assert.deepEqual(await readFile(f.request.destination), payload);
    } else {
      const expected: Record<string, string> = { failure: "PROCESS_FAILED", output: "OUTPUT_LIMIT", grow: "SIZE_LIMIT", hang: "TIMEOUT", cancel: "CANCELLED" };
      await assert.rejects(operation, error => {
        assert.doesNotMatch(String(error), /PRIVATE_DIAGNOSTIC/);
        return code("HOST_TRANSFER_" + expected[mode])(error);
      });
      await assert.rejects(lstat(f.request.destination), { code: "ENOENT" });
    }
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await clean(f.allowed);
  });
});

test("spawn failure is sanitized and removes staging", async t => {
  const f = await fixture(t);
  const runner = (job: SftpJob, signal: AbortSignal) => runSftp(job, signal,
    (_exe, _args, options) => spawn(join(f.root, "missing.exe"), [], options));
  await assert.rejects(new HostTransfers(f.policy, runner).transfer(f.request), code("HOST_TRANSFER_PROCESS_FAILED"));
  await clean(f.allowed);
});

test("a recorded transfer failure survives cancellation during process cleanup", async t => {
  const f = await fixture(t), abort = new AbortController();
  await assert.rejects(new HostTransfers(f.policy, async () => {
    const failure = new HostError("HOST_TRANSFER_SIZE_LIMIT", "Download exceeded the expected bytes.");
    abort.abort();
    throw failure;
  }).transfer(f.request, abort.signal), code("HOST_TRANSFER_SIZE_LIMIT"));
  await clean(f.allowed);
});

test("cancellation terminates the mock SFTP and SSH descendant before cleanup", async t => {
  const f = await fixture(t), abort = new AbortController(), pids: number[] = [];
  const runner: SftpRunner = (job, signal) => runSftp(job, signal, (_exe, _args, options) => {
    const child = spawn(process.execPath, [resolve("tests/fixtures/mock-sftp.mjs"), "tree"], options);
    pids.push(child.pid!);
    let output = "";
    child.stdout.on("data", chunk => {
      output += String(chunk);
      const match = /CHILD_PID=(\d+)\n/u.exec(output);
      if (match && !abort.signal.aborted) { pids.push(Number(match[1])); abort.abort(); }
    });
    return child;
  });
  await assert.rejects(new HostTransfers(f.policy, runner).transfer(f.request, abort.signal), code("HOST_TRANSFER_CANCELLED"));
  assert.equal(pids.length, 2);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await clean(f.allowed);
});

test("unconfirmed termination preserves staging and disables further transfers on that instance", async t => {
  const f = await fixture(t);
  let launches = 0;
  const transfers = new HostTransfers(f.policy, async () => {
    launches++;
    // Match the production runner's explicit error type without leaving a live child.
    throw new HostError("HOST_TRANSFER_CLEANUP_FAILED", "Unconfirmed process termination");
  });
  await assert.rejects(transfers.transfer(f.request), code("HOST_TRANSFER_CLEANUP_FAILED"));
  assert.equal((await readdir(f.allowed)).filter(name => name.startsWith(".workbench-transfer-")).length, 1);
  await assert.rejects(transfers.transfer(f.request), code("HOST_TRANSFER_CLEANUP_FAILED"));
  assert.equal(launches, 1);
  await assert.rejects(lstat(f.request.destination), { code: "ENOENT" });
});

test("both MCP profiles expose transfer only on opt-in and redact configuration details", async t => {
  const f = await fixture(t);
  for (const profile of ["v1", "v2"] as const) for (const enabled of [false, true]) for (const host of [false, true]) {
    const policy = await HostPolicy.create({ version: 1, enabled: host, write_roots: [f.allowed],
      transfer: { ...f.config, enabled } }, join(f.root, "mcp-policy.json"));
    const server = new McpServer({ name: "transfer-test", version: "1" });
    registerHostTools(createToolRegistry(server, profile), policy);
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(b); await client.connect(a);
      const tools = (await client.listTools()).tools;
      assert.equal(tools.some(tool => tool.name === "transfer_file"), enabled && host);
      const caps = await client.callTool({ name: "host_capabilities", arguments: {} });
      const serialized = JSON.stringify(caps);
      assert.ok(!serialized.includes(f.identity.replaceAll("\\", "\\\\")));
      assert.doesNotMatch(serialized, /100\.64\.0\.2|workbench_read|TEST_ONLY/);
      assert.equal(transferCapabilities(policy).enabled, enabled && host);
      if (enabled && host) {
        const tool = tools.find(tool => tool.name === "transfer_file")!;
        assert.deepEqual(Object.keys(tool.inputSchema.properties!).sort(), Object.keys(f.request).sort());
        assert.equal(tool.annotations?.openWorldHint, true);
        assert.equal(tool.annotations?.destructiveHint, false);
        const result = await client.callTool({ name: "transfer_file", arguments: { ...f.request, source_peer: "unconfigured" } });
        assert.equal(result.isError, true); assert.match(JSON.stringify(result), /HOST_TRANSFER_SOURCE_DENIED/);
      }
    } finally { await client.close(); await server.close(); }
  }
  const audit = await readFile(join(f.root, "mcp-policy.json.audit.jsonl"), "utf8");
  assert.doesNotMatch(audit, /100\.64\.0\.2|workbench_read|TEST_ONLY|private-identity|host-pins/);
});
