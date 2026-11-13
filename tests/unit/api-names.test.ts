import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { apiNameProfile, createToolRegistry, PUBLIC_TOOL_NAMES, publicToolName, toolText } from "../../src/api-names.js";
import { buildServerInstructions } from "../../src/server-instructions.js";
import { PhoneService, phoneSchemas } from "../../src/phone/service.js";
import { PhoneConfigSchema } from "../../src/phone/config.js";
import { registerPhoneTools } from "../../src/phone/tools.js";

const renamed = {
  run_temp: "run_agent_once", finish_work: "mark_work_complete", task_result: "get_task",
  work_retention: "manage_retention", bind_project: "register_workspace", list_codex_projects: "list_codex_history_projects",
  server_status: "phone_status", copy_file: "copy_host_file", move_file: "move_host_file",
  delete_file: "delete_host_file", list_host_path: "list_host_directory"
};
const body = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0]!.text);
async function scratch() {
  const base = resolve("codex-generated/name-profile-tests"); await mkdir(base, { recursive: true });
  return mkdtemp(join(base, "case-"));
}

test("name profiles have an explicit default, fixed v1 names, exact canonical changes and no collisions", async () => {
  assert.equal(apiNameProfile({}), "v1"); assert.equal(apiNameProfile({ ENGINEERING_BRIDGE_API_NAME_PROFILE: "v1" }), "v1");
  assert.equal(apiNameProfile({ ENGINEERING_BRIDGE_API_NAME_PROFILE: "v2" }), "v2");
  for (const value of ["", "V2", "v3", " v2", "v2 "]) assert.throws(() => apiNameProfile({ ENGINEERING_BRIDGE_API_NAME_PROFILE: value }), /must be v1 or v2/);
  const fixedV1 = Object.keys(JSON.parse(await readFile("tests/fixtures/api-schema-digests.json", "utf8"))).sort();
  assert.deepEqual(Object.keys(PUBLIC_TOOL_NAMES).sort(), fixedV1);
  assert.deepEqual(Object.fromEntries(Object.entries(PUBLIC_TOOL_NAMES).filter(([a, b]) => a !== b)), renamed);
  assert.equal(new Set(Object.values(PUBLIC_TOOL_NAMES)).size, fixedV1.length);
  const guide = await readFile("docs/api-name-profiles.md", "utf8");
  const rows = Object.fromEntries([...guide.matchAll(/^\| `([a-z_]+)` \| `([a-z_]+)` \|/gm)].map(match => [match[1], match[2]]));
  assert.deepEqual(rows, renamed, "migration documentation matches the complete set of changed names");
  assert.throws(() => publicToolName("unknown", "v1"), /Unknown public tool/);
  assert.equal(toolText("run_temp/finish_work task_result filename_run_temp", "v2"), "run_agent_once/mark_work_complete get_task filename_run_temp");
  const custom = "Keep my folder run_temp and file task_result unchanged.";
  const instructions = buildServerInstructions({ hostname: "test", display_name: "test", instructions: custom }, undefined, "v2");
  assert.ok(instructions.endsWith(custom), "operator prose is never rewritten");
});

test("invalid profiles fail startup before either entrypoint can modify configuration", async () => {
  const root = await scratch(), config = join(root, "config.json");
  await writeFile(config, 'DO NOT PARSE OR MIGRATE');
  try {
    for (const entry of ["mcp-stdio", "phone/mcp-stdio"]) {
      const client = new Client({ name: "invalid-profile", version: "1" });
      const transport = new StdioClientTransport({ command: process.execPath,
        args: [resolve(`dist/src/${entry}.js`), config], stderr: "pipe", env: { ENGINEERING_BRIDGE_API_NAME_PROFILE: "bad" } });
      try { await assert.rejects(client.connect(transport)); }
      finally { await client.close(); }
      assert.equal(await readFile(config, "utf8"), 'DO NOT PARSE OR MIGRATE');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("v2 dispatches canonical operations and switching back to v1 preserves work IDs and results", async () => {
  const root = await scratch(), allowed = join(root, "allowed"), config = join(root, "workspaces.json");
  await mkdir(allowed);
  await writeFile(config, JSON.stringify([{ kind: "project_root", root: allowed }]));
  await writeFile(config + ".host-policy.json", JSON.stringify({ version: 1, enabled: true, read_roots: [allowed], write_roots: [allowed],
    commands_enabled: true, command_roots: [allowed] }));
  // Fake only the DSH program: the real public registry, dispatcher and executor run.
  const launcher = join(root, "profiles/node_modules/@deepseek-ai/dsh/lib"); await mkdir(launcher, { recursive: true });
  await writeFile(join(launcher, "bin.js"), "console.log('profile-independent result');");
  const open = async (profile?: string) => {
    const client = new Client({ name: "profile-migration", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [resolve("dist/src/mcp-stdio.js"), config], stderr: "pipe",
      env: { PATH: "", DSH_HOME: root, ...(profile ? { ENGINEERING_BRIDGE_API_NAME_PROFILE: profile } : {}) } }));
    return client;
  };
  let client: Client | undefined;
  try {
    client = await open("v2");
    const toolNames = (await client.listTools()).tools.map(tool => tool.name);
    for (const [oldName, newName] of Object.entries(renamed)) {
      assert.equal(toolNames.includes(oldName), false);
      if (oldName !== "server_status") assert.ok(toolNames.includes(newName));
      const result = await client.callTool({ name: oldName, arguments: {} }); assert.equal(result.isError, true);
    }
    const caps = body(await client.callTool({ name: "host_capabilities", arguments: {} }));
    assert.equal(caps.api_name_profile, "v2"); assert.equal(typeof caps.server_version, "string");
    assert.equal(toolNames.includes("server_version"), false);
    const workspace = body(await client.callTool({ name: "register_workspace", arguments: { project_path: allowed } }));
    const work = body(await client.callTool({ name: "open_work", arguments: { workspace_id: workspace.workspace_id, name: "migration" } }));
    // Seed existing native history metadata without invoking a real Codex profile.
    const nativeId = randomUUID(), previousId = randomUUID();
    const history = JSON.parse(await readFile(config + ".work-items.json", "utf8"));
    history.works[0].thread_id = nativeId; history.works[0].previous_threads = [previousId];
    await writeFile(config + ".work-items.json", JSON.stringify(history));
    const task = body(await client.callTool({ name: "run_agent_once", arguments: { work_id: work.work_id, executor: "dsh", instruction: "test" } }));
    assert.equal(body(await client.callTool({ name: "wait_task", arguments: { task_id: task.task_id } })).state, "completed");
    assert.equal(body(await client.callTool({ name: "get_task", arguments: { task_id: task.task_id } })).output, "profile-independent result");
    assert.equal(body(await client.callTool({ name: "mark_work_complete", arguments: { work_id: work.work_id, summary: "kept" } })).status, "completed");
    assert.equal(body(await client.callTool({ name: "manage_retention", arguments: {} })).retention.max_results, 100);
    const a = join(allowed, "a.txt"), b = join(allowed, "b.txt"), c = join(allowed, "c.txt");
    await writeFile(a, "run_temp is user data");
    assert.notEqual((await client.callTool({ name: "copy_host_file", arguments: { source: a, destination: b } })).isError, true);
    const page = body(await client.callTool({ name: "read_host_file", arguments: { path: b, include_sha256: true } }));
    assert.equal(page.content, "run_temp is user data");
    assert.notEqual((await client.callTool({ name: "move_host_file", arguments: { source: b, destination: c, expected_sha256: page.sha256 } })).isError, true);
    assert.notEqual((await client.callTool({ name: "list_host_directory", arguments: { path: allowed } })).isError, true);
    assert.notEqual((await client.callTool({ name: "delete_host_file", arguments: { path: c, expected_sha256: page.sha256 } })).isError, true);
    const processTask = body(await client.callTool({ name: "start_host_process", arguments: {
      executable: process.execPath, cwd: allowed, args: ["-e", "setTimeout(() => {}, 30000)"]
    } }));
    const running = body(await client.callTool({ name: "get_task", arguments: { task_id: processTask.task_id } }));
    assert.equal(running.kind, "process"); assert.equal(running.ready, false);
    assert.ok(body(await client.callTool({ name: "list_tasks", arguments: { kind: "process" } })).tasks.some((r: { task_id: string }) => r.task_id === processTask.task_id));
    assert.notEqual((await client.callTool({ name: "control_task", arguments: { task_id: processTask.task_id, action: "interrupt" } })).isError, true);
    const stopped = body(await client.callTool({ name: "wait_task", arguments: { task_id: processTask.task_id } }));
    assert.equal(stopped.state, "failed"); assert.equal(stopped.process.cancelled, true);
    const saved = await readFile(config + ".work-items.json", "utf8");
    await client.close(); client = await open();
    assert.equal(body(await client.callTool({ name: "host_capabilities", arguments: {} })).api_name_profile, "v1");
    const reopened = body(await client.callTool({ name: "open_work", arguments: { work_id: work.work_id } }));
    assert.equal(reopened.work_id, work.work_id); assert.equal(reopened.summary, "kept");
    assert.equal(reopened.thread_id, nativeId); assert.deepEqual(reopened.previous_threads, [previousId]);
    assert.equal(body(await client.callTool({ name: "task_result", arguments: { task_id: processTask.task_id } })).process.cancelled, true);
    assert.equal(body(await client.callTool({ name: "task_result", arguments: { task_id: task.task_id } })).output, "profile-independent result");
    for (const newName of Object.values(renamed)) assert.equal((await client.callTool({ name: newName, arguments: {} })).isError, true);
    // Reopening changes semantic status only, never the stored execution IDs or history lineage.
    const prior = JSON.parse(saved), current = JSON.parse(await readFile(config + ".work-items.json", "utf8"));
    assert.deepEqual(current.runs, prior.runs); assert.deepEqual(current.works[0].previous_threads, prior.works[0].previous_threads);
  } finally { await client?.close(); await rm(root, { recursive: true, force: true }); }
});

test("both phone profiles advertise only their registered capability names without changing diagnostics", async () => {
  const root = await scratch();
  try {
    for (const profile of ["v1", "v2"] as const) {
      const state = join(root, profile); await mkdir(state);
      const config = PhoneConfigSchema.parse({ enabled: true, hostname: hostname(), adb_path: process.execPath, serial: "test", state_dir: state });
      const service = new PhoneService(config, { run: async () => Buffer.from("List of devices attached\n") });
      const server = new McpServer({ name: "phone-profile", version: "1" }), client = new Client({ name: "phone-profile", version: "1" });
      const original = server.registerTool;
      registerPhoneTools(createToolRegistry(server, profile), service);
      assert.equal(server.registerTool, original, "registration composes with the SDK without replacing its methods");
      const [a, b] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(b); await client.connect(a);
        const status = body(await client.callTool({ name: publicToolName("server_status", profile), arguments: {} }));
        assert.equal(status.api_name_profile, profile); assert.equal(status.diagnostic.recorded, true);
        assert.deepEqual(status.capabilities.sort(), (await client.listTools()).tools.map(tool => tool.name).sort());
        assert.equal(status.capabilities.length, Object.keys(phoneSchemas).length);
      } finally { await client.close(); await server.close(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
