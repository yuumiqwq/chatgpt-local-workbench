import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const VERSION_MODULE = new URL("../../src/version.js", import.meta.url);

interface ToolResult {
  content: Array<{ type?: string; text?: string } | undefined>;
}

test("workspace configuration strips exactly one leading UTF-8 BOM", async () => {
  const cases = [
    { source: "\uFEFF[]\n", accepted: true },
    { source: "\uFEFF\uFEFF[]\n", accepted: false }
  ] as const;

  for (const { source, accepted } of cases) {
    const configRoot = mkdtempSync(join(tmpdir(), "engineering-bridge-bom-"));
    const configPath = join(configRoot, "workspaces.json");
    writeFileSync(configPath, source);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
      cwd: process.cwd(),
      stderr: "pipe"
    });

    try {
      if (!accepted) {
        await assert.rejects(client.connect(transport));
        continue;
      }
      await client.connect(transport);
      const listed = await client.listTools();
      assert.equal(listed.tools.some(({ name }) => name === "run_temp"), true);
    } finally {
      try {
        await client.close();
      } finally {
        rmSync(configRoot, { recursive: true, force: true });
      }
    }
  }
});

test("MCP exposes unified work operations and rejects removed APIs", async t => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-work-surface-"));
  t.after(() => rmSync(dir, {recursive:true,force:true}));
  const configPath=join(dir,"workspaces.json");
  writeFileSync(configPath,"[]");
  const client=new Client({name:"test",version:"1"});
  await client.connect(new StdioClientTransport({command:process.execPath,
    args:[join(process.cwd(),"dist/src/mcp-stdio.js"),configPath],stderr:"pipe"}));
  try {
    const {VERSION}=await import(VERSION_MODULE.href);
    assert.equal(client.getServerVersion()?.version,VERSION);
    const instructions = client.getInstructions();
    assert.ok(instructions);
    assert.match(instructions, /independent task/);
    assert.match(instructions, /15-30 seconds/);
    assert.match(instructions, /end the ChatGPT turn/);
    assert.match(instructions, /same task_id/);
    assert.match(instructions, /timeouts do not imply local task failure/);
    assert.match(instructions, /wait_task\/task_result/);
    assert.match(instructions, /never duplicate a running task/);
    assert.match(instructions, /checkpoints/);
    const tools=(await client.listTools()).tools;
    assert.ok(tools.find(tool => tool.name === "wait_task")?.description?.includes(instructions));
    assert.equal(tools.filter(tool => tool.description?.includes(instructions)).length, 1);
    // Verify the guidance actually reaches model-visible STDIO discovery,
    // including start tools whose response may have been lost in transit.
    for (const name of ["wait_task", "continue_work", "run_temp"]) {
      const description = tools.find(tool => tool.name === name)?.description;
      assert.ok(description, name);
      assert.match(description, /After 3 consecutive Bridge connection interruptions/u);
      assert.match(description, /request timeouts without a valid response/u);
      assert.match(description, /stop automatic retries and polling across all Bridge tools/u);
      assert.match(description, /ready=false is normal waiting and resets this failure count/u);
      assert.match(description, /verified completed work, unfinished items/u);
      assert.match(description, /work_id\/task_id\/thread_id/u);
      assert.match(description, /reply '继续'/u);
      assert.match(description, /one read-only check of the original task/u);
      assert.match(description, /same work_id and original thread_id/u);
      assert.match(description, /does not cancel a running task/u);
    }
    for (const name of ["open_work","list_work","continue_work","run_temp","finish_work","manage_work","work_retention"]) {
      assert.ok(tools.some(tool=>tool.name===name));
    }
    for (const name of ["run_task","resume_codex_thread","generate_controlled_patch","refine_controlled_patch","authorize_workspace_write","submit_controlled_patch","apply_controlled_patch","commit_controlled_patch","configure_validation_profile","validate_controlled_patch"]) {
      assert.ok(!tools.some(tool=>tool.name===name));
      assert.equal((await client.callTool({name,arguments:{}})).isError,true);
    }
    for(const tool of tools)assert.equal("confirmation" in (tool.inputSchema.properties??{}),false);
    for (const name of ["run_temp","continue_work"]) {
      const props=tools.find(tool=>tool.name===name)!.inputSchema.properties!;
      assert.ok(props.model);assert.ok(props.reasoning_effort);
      assert.deepEqual((props.access as { enum: string[] }).enum, ["read-only", "danger-full-access"]);
    }
    const result=await client.callTool({name:"run_temp",arguments:{workspace_id:"missing",instruction:"inspect"}});
    assert.equal(result.isError,true);
    assert.match(JSON.stringify(result),/UNKNOWN_WORKSPACE/);
  } finally { await client.close(); }
});

test("temporary execution validates executor options before dispatch",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"bridge-temp-args-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const config=join(dir,"workspaces.json");writeFileSync(config,"[]");
  const client=new Client({name:"test",version:"1"});
  await client.connect(new StdioClientTransport({command:process.execPath,
    args:[join(process.cwd(),"dist/src/mcp-stdio.js"),config],stderr:"pipe"}));
  try {
    for(const executor of [undefined,"codex","dsh"]){
      for (const access of [undefined,"read-only","danger-full-access"]) {
        const result=await client.callTool({name:"run_temp",arguments:{workspace_id:"missing",instruction:"inspect",...(executor?{executor}:{}),...(access?{access}:{})}});
        assert.equal(result.isError,true);assert.match(JSON.stringify(result),/UNKNOWN_WORKSPACE/);
      }
      assert.equal((await client.callTool({name:"run_temp",arguments:{workspace_id:"missing",instruction:"inspect",...(executor?{executor}:{}),access:"workspace-write"}})).isError,true);
    }
    const unsupported=await client.callTool({name:"run_temp",arguments:{workspace_id:"missing",instruction:"inspect",executor:"dsh",model:"any"}});
    assert.match(JSON.stringify(unsupported),/UNSUPPORTED_ACTION/);
    assert.equal((await client.callTool({name:"run_temp",arguments:{workspace_id:"missing",instruction:"inspect",executor:"unknown"}})).isError,true);
  }finally{await client.close();}
});

test("MCP run_temp passes DSH access to its child and persists the same result metadata", async t => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-dsh-access-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const launcherDir = join(dir, "profiles", "node_modules", "@deepseek-ai", "dsh", "lib");
  mkdirSync(launcherDir, { recursive: true });
  // This transport fixture reports what the real executor passes to a DSH
  // launcher; native DSH policy enforcement is tested separately.
  writeFileSync(join(launcherDir, "bin.js"), "console.log(JSON.stringify({mode:process.env.DSH_PERMISSION_MODE,args:process.argv.slice(2)}));\n");
  const config = join(dir, "workspaces.json");
  writeFileSync(config, JSON.stringify([{ id: "project", root: dir }]));
  const client = new Client({ name: "dsh-access-test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), config], stderr: "pipe",
    env: { PATH: "", DSH_HOME: dir, DSH_PERMISSION_MODE: "workspace-write" } }));
  try {
    for (const access of [undefined, "read-only", "danger-full-access"] as const) {
      const expected = access ?? "danger-full-access";
      const started = await client.callTool({ name: "run_temp", arguments: {
        workspace_id: "project", instruction: "report invocation", executor: "dsh", ...(access ? { access } : {}) } });
      assert.notEqual(started.isError, true);
      const run = JSON.parse((started.content as ToolResult["content"])[0]!.text!);
      assert.equal(run.access, expected);
      const completed = await client.callTool({ name: "wait_task", arguments: { task_id: run.task_id } });
      assert.notEqual(completed.isError, true);
      const result = JSON.parse((completed.content as ToolResult["content"])[0]!.text!);
      assert.equal(result.state, "completed");
      assert.equal(result.access, expected);
      assert.equal(result.executor, "dsh");
      assert.deepEqual(JSON.parse(result.output), { mode: expected, args: ["--profile", "headless", "report invocation"] });
      assert.equal(JSON.parse(readFileSync(run.result_file, "utf8")).access, expected);
    }
  } finally { await client.close(); }
});

test("bind_project and create_project register workspaces inside approved project roots", async () => {
  const approved = mkdtempSync(join(tmpdir(), "engineering-bridge-approved-"));
  const configDir = mkdtempSync(join(tmpdir(), "engineering-bridge-onboard-"));
  const configPath = join(configDir, "workspaces.json");
  const manualProject = join(approved, "manual-project");
  mkdirSync(manualProject);
  const otherProject = join(approved, "other-project");
  mkdirSync(otherProject);
  writeFileSync(configPath, `${JSON.stringify([
    { kind: "project_root", root: approved },
    { id: "manual", root: manualProject, allow_write: true }
  ], null, 2)}\n`);

  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(),
    stderr: "pipe"
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: unknown }> => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as ToolResult["content"];
    const text = content[0]?.text ?? "";
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = { raw: text };
    }
    return { isError: result.isError === true, body };
  };

  try {
    await client.connect(transport);

    // Binding an existing manual workspace returns identity metadata only.
    const manualBind = await call("bind_project", {
      project_path: manualProject
    });
    assert.equal(manualBind.isError, false);
    assert.deepEqual(manualBind.body, {
      workspace_id: "manual",
      root: manualProject,
      source: "manual"
    });
    const migratedManualConfig = JSON.parse(readFileSync(configPath, "utf8")) as Array<Record<string, unknown>>;
    assert.equal("allow_write" in migratedManualConfig[1]!, false);
    assert.deepEqual(migratedManualConfig[0], { kind: "project_root", root: approved });

    // Binding a new project creates a managed workspace and reuses its id.
    const firstBind = await call("bind_project", {
      project_path: otherProject
    });
    assert.equal(firstBind.isError, false);
    const firstBody = firstBind.body as { workspace_id?: unknown; root?: unknown; source?: unknown };
    assert.equal(typeof firstBody.workspace_id, "string");
    assert.equal(firstBody.root, realpathSync.native(otherProject));
    assert.equal(firstBody.source, "managed");
    assert.deepEqual(Object.keys(firstBody).sort(), ["root", "source", "workspace_id"]);

    const secondBind = await call("bind_project", {
      project_path: otherProject
    });
    assert.deepEqual(secondBind.body, firstBind.body);

    // The managed workspace is immediately usable for task routing.
    const run = await call("run_temp", {
      workspace_id: firstBody.workspace_id,
      instruction: "inspect",
      executor: "dsh"
    });
    assert.equal(run.isError, false);
    assert.equal(typeof (run.body as { task_id?: unknown }).task_id, "string");

    // create_project performs mkdir + git init and reports an unborn HEAD.
    const created = await call("create_project", {
      parent: approved,
      name: "created-project"
    });
    assert.equal(created.isError, false);
    const createdBody = created.body as { workspace_id?: unknown; root?: unknown; git?: unknown };
    assert.equal(typeof createdBody.workspace_id, "string");
    assert.equal(createdBody.root, realpathSync.native(join(approved, "created-project")));
    assert.deepEqual(createdBody.git, { initialized: true, head: "unborn" });
    assert.deepEqual(Object.keys(createdBody).sort(), ["git", "root", "workspace_id"]);
    assert.equal(readFileSync(join(approved, "created-project", ".git", "HEAD"), "utf8").includes("ref:"), true);

    // Missing project name is rejected by the schema without side effects.
    const wrongConfirmation = await call("create_project", {
      parent: approved,
      name: ""
    });
    assert.equal(wrongConfirmation.isError, true);
    assert.equal(JSON.stringify(wrongConfirmation.body).includes("workspace_id"), false);

    // Paths outside every approved root are rejected with a structured error.
    const outside = mkdtempSync(join(tmpdir(), "engineering-bridge-outside-"));
    const outsideBind = await call("bind_project", {
      project_path: outside
    });
    assert.equal(outsideBind.isError, true);
    assert.deepEqual(outsideBind.body, {
      error: {
        code: "WORKSPACE_BOUNDARY_VIOLATION",
        message: "The workspace boundary could not be verified."
      }
    });
  } finally {
    await client.close();
  }
});

test("startup rejects relative or non-normalized project_root entries and accepts a valid one", async () => {
  for (const root of ["relative/root", "/registered/../root"]) {
    const configDir = mkdtempSync(join(tmpdir(), "engineering-bridge-badroot-"));
    const configPath = join(configDir, "workspaces.json");
    writeFileSync(configPath, `${JSON.stringify([{ kind: "project_root", root }], null, 2)}\n`);

    const client = new Client({ name: "test-client", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
      cwd: process.cwd(),
      stderr: "pipe"
    });

    // The server exits during startup, so connecting must fail.
    await assert.rejects(client.connect(transport));
    await client.close();
  }

  // A valid absolute, normalized project_root still boots.
  const configDir = mkdtempSync(join(tmpdir(), "engineering-bridge-goodroot-"));
  const configPath = join(configDir, "workspaces.json");
  writeFileSync(configPath, `${JSON.stringify([{ kind: "project_root", root: configDir }], null, 2)}\n`);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(),
    stderr: "pipe"
  });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.some(({ name }) => name === "bind_project"), true);
  } finally {
    await client.close();
  }
});

test("bind_project fails closed when no project_root is configured", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "engineering-bridge-noroots-"));
  const configPath = join(configDir, "workspaces.json");
  const project = join(configDir, "project");
  mkdirSync(project);
  writeFileSync(configPath, "[]\n");

  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(),
    stderr: "pipe"
  });

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "bind_project",
      arguments: { project_path: project, confirmation: "BIND" }
    });
    assert.equal(result.isError, true);
    const content = result.content as ToolResult["content"];
    const body = JSON.parse(content[0]?.text ?? "") as { error?: unknown };
    assert.deepEqual(body.error, {
      code: "WORKSPACE_BOUNDARY_VIOLATION",
      message: "The workspace boundary could not be verified."
    });
  } finally {
    await client.close();
  }
});
