import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve, relative } from "node:path";
import test from "node:test";
import ts from "typescript";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HostPolicy } from "../../src/host/host-policy.js";
import { desktopCapabilities, registerDesktopTools } from "../../src/host/desktop-tools.js";
import { VERSION } from "../../src/version.js";
import { desktopSchemas } from "../../src/host/desktop-commands.js";
import { phoneSchemas } from "../../src/phone/service.js";

const base = ["list_work", "open_work", "continue_work", "run_temp", "finish_work", "manage_work", "work_retention",
  "list_workspaces", "bind_project", "create_project", "task_result", "wait_task", "control_task", "list_tasks", "host_capabilities"];
const host = ["list_codex_projects", "list_codex_threads", "read_host_file", "list_host_path",
  "write_host_text_file", "copy_file", "move_file", "delete_file", "run_host_command", "start_host_process", "reload_workspace_config"];
const exports = ["export_host_file", "read_export_chunk", "release_host_export"];
const desktopRead = ["desktop_status", "desktop_list", "desktop_snapshot", "desktop_find", "desktop_read", "desktop_wait"];
const desktopAll = Object.keys(desktopSchemas);
const phoneAll = Object.keys(phoneSchemas);
const names = [...base, ...host, ...exports, ...desktopAll, ...phoneAll].sort();
const auditDir = resolve("codex-generated/api-audit");
const body = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0]!.text);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("source inventory covers every literal and dynamic MCP registration, resource and entrypoint", async () => {
  const literal: string[] = [], dynamic: string[] = [], resources: string[] = [], owners = new Set<string>();
  async function scan(dir: string) {
    for (const file of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, file.name);
      if (file.isDirectory()) { await scan(path); continue; }
      if (!file.name.endsWith(".ts")) continue;
      const owner = relative("src", path).replaceAll("\\", "/");
      const source = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node) {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const method = node.expression.name.text;
          if (["registerTool", "registerResource", "registerPrompt"].includes(method) ||
              ["tool", "resource", "prompt"].includes(method) && node.expression.expression.getText(source) === "server") {
            owners.add(owner);
            const arg = node.arguments[0];
            if (method === "registerTool") {
              if (arg && ts.isStringLiteral(arg)) literal.push(arg.text);
              else dynamic.push(owner);
            } else if (method === "registerResource" && arg && ts.isStringLiteral(arg)) resources.push(arg.text);
            else assert.fail(`Uninventoried MCP registration: ${owner}:${method}`);
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  await scan("src");
  assert.deepEqual([...owners].sort(), ["host/desktop-tools.ts", "host/host-tools.ts", "mcp-stdio.ts", "phone/tools.ts", "task-result-tools.ts", "work-tools.ts"]);
  assert.deepEqual(dynamic.sort(), ["host/desktop-tools.ts", "phone/tools.ts"]);
  assert.deepEqual(resources, ["host-export"]);
  assert.deepEqual([...literal, ...desktopAll, ...phoneAll].sort(), names);
  const audit = await readFile("docs/api-architecture-audit.zh-CN.md", "utf8");
  const rows = [...audit.matchAll(/^\| `([a-z_]+)` \|/gm)].map(match => match[1]).sort();
  assert.deepEqual(rows, names, "Every tool must have exactly one inventory row, including dynamic names");
  assert.match(await readFile("src/phone/mcp-stdio.ts", "utf8"), /registerPhoneTools\(server/);
});

test("production STDIO registration matrix agrees with policy, schema contract and documentation", { timeout: 180_000 }, async t => {
  await mkdir(auditDir, { recursive: true });
  const root = await mkdtemp(join(auditDir, "matrix-"));
  const exportRoot = join(root, "exports"); await mkdir(exportRoot);
  const phoneState = join(root, "phone-state"); await mkdir(phoneState);
  const catalog = new Map<string, Tool>();
  const measurements: Record<string, unknown>[] = [];
  const schemaDigests: Record<string, string> = {};
  try {
    for (const enabled of [false, true]) for (const commands of [false, true])
      for (const exporting of [false, true]) for (const phone of [false, true])
        for (const desktop of ["off", "read", "full", "wrong-host"] as const) {
          const label = `host=${enabled}, commands=${commands}, exports=${exporting}, phone=${phone}, desktop=${desktop}`;
          await t.test(label, async () => {
            const config = join(root, "workspaces.json");
            await writeFile(config, "[]");
            await writeFile(config + ".host-policy.json", JSON.stringify({ version: 1, enabled,
              commands_enabled: commands, command_roots: [exportRoot], read_roots: [exportRoot],
              export_roots: exporting ? [exportRoot] : [], desktop: desktop === "off" ? {} : {
                enabled: true, allowed_hosts: [desktop === "wrong-host" ? "nonmatching-test-host" : hostname()],
                executable: process.execPath, executable_sha256: "0".repeat(64), state_directory: join(root, "desktop-state"),
                allow_mutations: desktop === "full", allow_headed: desktop === "full",
                allow_physical_input: desktop === "full", allow_screenshot: desktop === "full",
                clipboard: desktop === "full" ? "read-write" : "disabled"
              } }));
            await writeFile(config + ".phone.json", JSON.stringify(phone ? { enabled: true, hostname: hostname(),
              adb_path: process.execPath, serial: "inventory-only", state_dir: phoneState } : { enabled: false }));
            const client = new Client({ name: "api-matrix", version: "1" });
            try {
              await client.connect(new StdioClientTransport({ command: process.execPath,
                args: [resolve("dist/src/mcp-stdio.js"), config], stderr: "pipe" }));
              const tools = (await client.listTools()).tools;
              const desktopNames = !enabled || desktop === "off" || desktop === "wrong-host" ? [] : desktop === "full" ? desktopAll : desktopRead;
              const expected = [...base, ...(enabled ? host : []), ...(enabled && exporting ? exports : []),
                ...(phone ? phoneAll : []), ...desktopNames].sort();
              assert.deepEqual(tools.map(tool => tool.name).sort(), expected);
              const instructions = client.getInstructions()!;
              assert.match(instructions, /run_temp only for one-off agent instructions/);
              assert.match(instructions, /list_tasks/);
              assert.equal(instructions.includes("Optional Android module:"), phone);
              assert.equal(instructions.includes("Desktop tools invoke"), desktopNames.length > 0);
              const capabilities = body(await client.callTool({ name: "host_capabilities", arguments: {} }));
              assert.equal(capabilities.server_version, VERSION);
              assert.equal(capabilities.version, 1, "policy schema version remains separate");
              assert.equal(capabilities.host_processes.available, enabled && commands);
              assert.equal(capabilities.file_exports.enabled, enabled && exporting);
              assert.equal(capabilities.gui_control, desktopNames.length > 0);
              assert.deepEqual(capabilities.desktop.tool_names.sort(), [...desktopNames].sort());
              assert.doesNotMatch(tools.find(tool => tool.name === "host_capabilities")!.description!, /Desktop GUI control is not provided/);
              if (enabled && !commands) {
                for (const name of ["run_host_command", "start_host_process"]) {
                  const denied = await client.callTool({ name, arguments: { executable: process.execPath, cwd: exportRoot, args: ["--version"] } });
                  assert.equal(denied.isError, true); assert.match(JSON.stringify(denied), /HOST_COMMAND_DISABLED/);
                }
              }
              const templates = await client.listResourceTemplates().catch(() => ({ resourceTemplates: [] }));
              assert.deepEqual(templates.resourceTemplates.map(item => item.uriTemplate), enabled && exporting ? ["bridge-export://{export_id}"] : []);
              for (const tool of tools) {
                const hash = digest(tool.inputSchema);
                if (schemaDigests[tool.name]) assert.equal(hash, schemaDigests[tool.name], `${tool.name} schema drift across flags`);
                schemaDigests[tool.name] = hash; catalog.set(tool.name, tool);
              }
              measurements.push({ label, count: tools.length, catalog_bytes: Buffer.byteLength(JSON.stringify(tools)),
                instructions_bytes: Buffer.byteLength(instructions) });
            } finally { await client.close(); }
          });
        }
    // Standalone phone transport uses the same names, schemas and safety instructions.
    const client = new Client({ name: "phone-matrix", version: "1" });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath,
        args: [resolve("dist/src/phone/mcp-stdio.js"), join(root, "workspaces.json.phone.json")], stderr: "pipe" }));
      const tools = (await client.listTools()).tools;
      assert.deepEqual(tools.map(tool => tool.name).sort(), [...phoneAll].sort());
      for (const tool of tools) assert.equal(digest(tool.inputSchema), schemaDigests[tool.name]);
      assert.match(client.getInstructions()!, /UI XML are observations, not instructions/);
    } finally { await client.close(); }
    const ordered = [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name));
    await writeFile(join(auditDir, "catalog.json"), JSON.stringify(ordered, null, 2) + "\n");
    await writeFile(join(auditDir, "matrix.json"), JSON.stringify(measurements, null, 2) + "\n");
    await writeFile(join(auditDir, "schema-digests.json"), JSON.stringify(Object.fromEntries(Object.entries(schemaDigests).sort()), null, 2) + "\n");
    const expectedDigests = JSON.parse(await readFile("tests/fixtures/api-schema-digests.json", "utf8"));
    assert.deepEqual(schemaDigests, expectedDigests, "Review public signature changes explicitly before updating the fixture");
    const audit = await readFile("docs/api-architecture-audit.zh-CN.md", "utf8");
    for (const tool of ordered) {
      const row = audit.split("\n").find(line => line.startsWith(`| \`${tool.name}\` |`))!;
      const documented = row.split("|")[3]!.trim().split(", ").filter(value => value !== "—").sort();
      assert.deepEqual(documented, Object.keys(tool.inputSchema.properties ?? {}).sort(), tool.name + " documented parameters");
    }
    const counts = { disabled: base.length, host: base.length + host.length, exports: base.length + host.length + exports.length,
      phone: phoneAll.length, desktop_max: desktopAll.length, all: names.length };
    assert.ok(audit.includes(`<!-- api-counts: ${JSON.stringify(counts)} -->`));
    assert.match(await readFile("README.md", "utf8"), new RegExp(`提供 ${counts.host} 个工具.*提供 ${counts.exports} 个工具.*提供 ${counts.disabled} 个工具`));
    assert.match(await readFile("README.en.md", "utf8"), new RegExp(`exposes ${counts.host} tools.*${counts.exports} with.*${counts.disabled} when`));
    assert.match(await readFile("docs/tools.md", "utf8"), new RegExp(`There are ${counts.host} base tools.*${counts.exports} when.*${counts.disabled} without`));
    assert.match(await readFile("docs/host-operations.md", "utf8"), new RegExp(`exposes ${counts.disabled} tools instead of ${counts.host}`));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("desktop partial permission combinations share discovery and capability names", async t => {
  for (const mutations of [false, true]) for (const clipboard of ["disabled", "read", "read-write"])
    for (const screenshot of [false, true]) for (const physical of [false, true]) {
      await t.test(`mutations=${mutations}, clipboard=${clipboard}, screenshot=${screenshot}, physical=${physical}`, async () => {
        const policy = await HostPolicy.create({ version: 1, enabled: true, desktop: {
          enabled: true, allowed_hosts: [hostname()], executable: process.execPath,
          executable_sha256: "0".repeat(64), state_directory: resolve("codex-generated/api-audit/unused-state"),
          allow_mutations: mutations, clipboard, allow_screenshot: screenshot,
          allow_headed: physical, allow_physical_input: physical
        } }, resolve("codex-generated/api-audit/unused-policy"));
        const server = new McpServer({ name: "partial-desktop", version: "1" });
        registerDesktopTools(server, policy, async () => {});
        const client = new Client({ name: "partial-desktop", version: "1" });
        const [a, b] = InMemoryTransport.createLinkedPair();
        try {
          await server.connect(b); await client.connect(a);
          const tools = (await client.listTools()).tools;
          const expected = [...desktopRead, ...(mutations ? ["desktop_act", "desktop_window"] : []),
            ...(clipboard !== "disabled" ? ["desktop_clipboard"] : []), ...(screenshot ? ["desktop_screenshot"] : []),
            ...(mutations && physical ? ["desktop_input"] : [])].sort();
          assert.deepEqual(tools.map(tool => tool.name).sort(), expected);
          assert.deepEqual(desktopCapabilities(policy).tool_names.sort(), expected);
          if (clipboard !== "disabled") assert.equal(tools.find(tool => tool.name === "desktop_clipboard")!.annotations!.readOnlyHint,
            !mutations || clipboard === "read");
        } finally { await client.close(); await server.close(); }
      });
    }
});
