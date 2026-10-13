import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { containsPath } from "../../../src/host/host-policy.js";
import { windowsPathAlias } from "../../helpers/windows-path-alias.js";

test("MCP validates and reloads workspace identity configuration", async t => {
  const root = await mkdtemp(join(tmpdir(), "bridge-reload-"));
  const configuredRoot = windowsPathAlias(root, t);
  const project = join(configuredRoot, "project");
  await mkdir(project);
  const configPath = join(configuredRoot, "workspaces.json");
  const approvedRoot = { kind: "project_root", root: configuredRoot };
  const initial = [{ id: "project", root: project }, approvedRoot];
  await writeFile(configPath, JSON.stringify(initial));
  await writeFile(configPath + ".host-policy.json", JSON.stringify({
    version: 1, enabled: true, read_roots: [root], write_roots: [root]
  }));
  const client = new Client({ name: "reload-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve("dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(), stderr: "pipe"
  });
  t.after(async () => {
    await client.close();
    assert.ok(containsPath(resolve(tmpdir()), resolve(root)));
    await rm(root, { recursive: true, force: true });
  });
  await client.connect(transport);
  const canonicalConfigPath = await realpath(configPath);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args });
    const items = response.content as Array<{ type: string; text: string }>;
    return { error: response.isError === true, body: JSON.parse(items[0]!.text) };
  };
  const before = await call("list_workspaces");
  assert.deepEqual(Object.keys(before.body.workspaces[0]).sort(), ["name", "root", "source", "workspace_id"]);
  const read = await call("read_host_file", { path: configPath, include_sha256: true });
  const invalid = await call("write_host_text_file", { path: canonicalConfigPath,
    content: JSON.stringify([{ id: "bad", root: "relative" }]), expected_sha256: read.body.sha256 });
  assert.equal(invalid.error, true);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), initial);
  const legacyField = await call("write_host_text_file", { path: canonicalConfigPath,
    content: JSON.stringify([{ id: "project", root: project, allow_write: true }]),
    expected_sha256: read.body.sha256 });
  assert.equal(legacyField.error, true);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), initial);
  const changed = await call("write_host_text_file", { path: canonicalConfigPath,
    content: JSON.stringify([{ id: "renamed-project", root: project }, approvedRoot]),
    expected_sha256: read.body.sha256 });
  assert.equal(changed.error, false);
  const reload = await call("reload_workspace_config");
  assert.equal(reload.error, false);
  assert.equal(reload.body.workspaces[0].workspace_id, "renamed-project");
  assert.equal((await call("list_workspaces")).body.workspaces[0].workspace_id, "renamed-project");
  const rebound = await call("bind_project", { project_path: await realpath(project) });
  assert.equal(rebound.error, false);
  assert.deepEqual(rebound.body, { workspace_id: "renamed-project", root: project, source: "manual" });
  const capabilities = await call("host_capabilities");
  assert.equal(capabilities.body.commands_enabled, false);
  assert.equal(capabilities.body.commands_are_os_sandboxed, false);
});
