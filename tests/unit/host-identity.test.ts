import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadHostIdentity } from "../../src/host-identity.js";
import { buildServerInstructions, LONG_TASK_INSTRUCTIONS, SERVER_INSTRUCTIONS } from "../../src/server-instructions.js";
import { PHONE_INSTRUCTIONS } from "../../src/phone/tools.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "bridge-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "workspaces.json");
  await writeFile(configPath, "[]\n");
  return { root, configPath, identityPath: configPath + ".identity.json" };
}

const configuredIdentity = {
  hostname: hostname().toLowerCase(),
  display_name: "测试工作台",
  instructions: "连接当前测试电脑。\n仅当用户明确指定测试工作台时使用。\n支持该电脑上的文件读写。"
};

test("missing identity sidecar returns the actual hostname without a deployment default", async t => {
  const f = await fixture(t);
  assert.deepEqual(await loadHostIdentity(f.identityPath), { hostname: hostname() });
  assert.deepEqual(await readdir(f.root), ["workspaces.json"]);
});

test("matching identity preserves the exact Chinese description and reports OS hostname casing", async t => {
  const f = await fixture(t);
  await writeFile(f.identityPath, "\uFEFF" + JSON.stringify(configuredIdentity));
  assert.deepEqual(await loadHostIdentity(f.identityPath), { ...configuredIdentity, hostname: hostname() });
});

test("identity sidecar rejects a different host", async t => {
  const f = await fixture(t);
  await writeFile(f.identityPath, JSON.stringify({ ...configuredIdentity, hostname: hostname() + "-other" }));
  await assert.rejects(loadHostIdentity(f.identityPath), /HOST_IDENTITY_HOSTNAME_MISMATCH/);
});

test("malformed, incomplete and unreadable identity configurations fail instead of using defaults", async t => {
  const f = await fixture(t);
  for (const source of ["{", "null", "{}", JSON.stringify({ ...configuredIdentity, hostname: 1 }),
    JSON.stringify({ ...configuredIdentity, display_name: "  " }),
    JSON.stringify({ ...configuredIdentity, instructions: "\n" }),
    JSON.stringify({ ...configuredIdentity, enabled: false })]) {
    await writeFile(f.identityPath, source);
    await assert.rejects(loadHostIdentity(f.identityPath));
  }
  await rm(f.identityPath);
  await mkdir(f.identityPath);
  await assert.rejects(loadHostIdentity(f.identityPath));
});

test("server instructions preserve existing guidance and append only the validated deployment text", async t => {
  const f = await fixture(t);
  const absent = await loadHostIdentity(f.identityPath);
  assert.equal(buildServerInstructions(absent), SERVER_INSTRUCTIONS);
  assert.equal(buildServerInstructions(absent, PHONE_INSTRUCTIONS), `${SERVER_INSTRUCTIONS}\n\n${PHONE_INSTRUCTIONS}`);
  assert.ok(SERVER_INSTRUCTIONS.startsWith(LONG_TASK_INSTRUCTIONS));
  assert.match(SERVER_INSTRUCTIONS, /OpenCLI/);
  assert.match(SERVER_INSTRUCTIONS, /MinerU/);
  assert.doesNotMatch(SERVER_INSTRUCTIONS, /ROG|Masked|Legion|LAPTOP-1189PH9Q|FLAWLESS|LAPTOP-NHHRR3GO/);

  for (const config of [configuredIdentity,
    { ...configuredIdentity, display_name: "另一工作台", instructions: "仅用于另一台电脑的管理。" }]) {
    await writeFile(f.identityPath, JSON.stringify(config));
    const identity = await loadHostIdentity(f.identityPath);
    const suffix = `当前 MCP 服务：${config.display_name}。当前真实主机名：${hostname()}。所有主机工具操作均在这台电脑上执行。\n\n${config.instructions}`;
    assert.equal(buildServerInstructions(identity), `${SERVER_INSTRUCTIONS}\n\n${suffix}`);
    assert.equal(buildServerInstructions(identity, PHONE_INSTRUCTIONS), `${SERVER_INSTRUCTIONS}\n\n${PHONE_INSTRUCTIONS}\n\n${suffix}`);
  }
});

test("MCP discovery returns validated identity without changing server name, tools or host policy", async t => {
  const f = await fixture(t);
  const discover = async () => {
    const client = new Client({ name: "identity-test", version: "1" });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath,
        args: [resolve("dist/src/mcp-stdio.js"), f.configPath], stderr: "pipe" }));
      const response = await client.callTool({ name: "host_capabilities", arguments: {} });
      assert.notEqual(response.isError, true);
      const content = response.content as Array<{ type: string; text: string }>;
      return {
        server: client.getServerVersion(), instructions: client.getInstructions(),
        tools: (await client.listTools()).tools,
        capabilities: JSON.parse(content[0]!.text) as Record<string, unknown>
      };
    } finally {
      await client.close();
    }
  };
  for (const enabled of [false, true]) {
    if (enabled) await writeFile(f.configPath + ".host-policy.json", JSON.stringify({ version: 1, enabled: true }));
    const baseline = await discover();
    assert.equal(baseline.server?.name, "engineering-bridge");
    assert.equal(baseline.instructions, SERVER_INSTRUCTIONS);
    assert.equal(baseline.capabilities.hostname, hostname());
    assert.equal("display_name" in baseline.capabilities, false);
    assert.equal(baseline.capabilities.enabled, enabled);

    await writeFile(f.identityPath, JSON.stringify(configuredIdentity));
    const configured = await discover();
    assert.deepEqual(configured.server, baseline.server);
    assert.deepEqual(configured.tools, baseline.tools);
    assert.deepEqual(configured.capabilities, { ...baseline.capabilities, display_name: configuredIdentity.display_name });
    assert.equal(configured.instructions, buildServerInstructions(await loadHostIdentity(f.identityPath)));
    await rm(f.identityPath);
  }
});

test("a mismatched identity exits before workspace migration or MCP startup", async t => {
  const f = await fixture(t);
  const legacyConfig = JSON.stringify([{ id: "legacy", root: f.root, allow_write: true }]);
  await writeFile(f.configPath, legacyConfig);
  await writeFile(f.identityPath, JSON.stringify({ ...configuredIdentity, hostname: hostname() + "-other" }));
  await assert.rejects(promisify(execFile)(process.execPath, [resolve("dist/src/mcp-stdio.js"), f.configPath],
    { windowsHide: true, timeout: 15_000 }), error => {
    const failure = error as Error & { code: number; stdout: string; stderr: string };
    assert.equal(failure.code, 1);
    assert.equal(failure.stdout, "");
    assert.match(failure.stderr, /HOST_IDENTITY_HOSTNAME_MISMATCH/);
    return true;
  });
  assert.equal(await readFile(f.configPath, "utf8"), legacyConfig);
  assert.deepEqual((await readdir(f.root)).sort(), ["workspaces.json", "workspaces.json.identity.json"]);
});
