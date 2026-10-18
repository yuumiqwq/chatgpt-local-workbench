#!/usr/bin/env node

import { readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { WorkService } from "./tasks/work-service.js";
import { registerWorkTools } from "./work-tools.js";
import type { ExecutorFactory } from "./tasks/execution-types.js";
import { CodexExecutor } from "./executors/codex-executor.js";
import { DshExecutor } from "./executors/dsh-executor.js";
import { VERSION } from "./version.js";
import { loadPhoneConfig } from "./phone/config.js";
import { RealAdb } from "./phone/adb.js";
import { PhoneService } from "./phone/service.js";
import { PHONE_INSTRUCTIONS, registerPhoneTools } from "./phone/tools.js";
import { buildServerInstructions } from "./server-instructions.js";
import { loadHostIdentity } from "./host-identity.js";
import { CoreError, serializeError } from "./core/errors.js";
import { registerTaskResultTools } from "./task-result-tools.js";
import { HostError, HostPolicy } from "./host/host-policy.js";
import { registerHostTools } from "./host/host-tools.js";
import { ManagedWorkspaceCatalog } from "./workspaces/managed-workspace-catalog.js";
import { RegisteredWorkspaceRegistry } from "./workspaces/registered-workspace-registry.js";
import { WorkspaceOnboardingService } from "./workspaces/workspace-onboarding-service.js";

const WorkspaceEntrySchema = z.object({
  id: z.string().min(1),
  root: z.string().min(1)
}).strict();

const ProjectRootEntrySchema = z.object({
  kind: z.literal("project_root"),
  root: z.string().min(1)
}).strict();

const WorkspaceConfigSchema = z.array(z.union([WorkspaceEntrySchema, ProjectRootEntrySchema]));

type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>;
type ProjectRootEntry = z.infer<typeof ProjectRootEntrySchema>;

function isProjectRootEntry(entry: WorkspaceEntry | ProjectRootEntry): entry is ProjectRootEntry {
  return "kind" in entry;
}

function parseWorkspaceConfig(source: string, acceptLegacy = false) {
  const value: unknown = JSON.parse(source.replace(/^\uFEFF/u, ""));
  let migrated = false;
  const normalized = acceptLegacy && Array.isArray(value) ? value.map((item) => {
    if (!isObject(item) || item.kind !== undefined || !("allow_write" in item)) return item;
    if (typeof item.allow_write !== "boolean") throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
    const { allow_write: _legacyAuthorization, ...identity } = item;
    migrated = true;
    return identity;
  }) : value;
  const entries = WorkspaceConfigSchema.parse(normalized);
  new RegisteredWorkspaceRegistry(entries.filter((entry): entry is WorkspaceEntry => !isProjectRootEntry(entry)));
  for (const entry of entries.filter(isProjectRootEntry)) {
    if (!isAbsolute(entry.root) || normalize(entry.root) !== entry.root) {
      throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
    }
  }
  return { entries, migrated };
}

async function loadWorkspaceConfig(configPath: string) {
  const parsed = parseWorkspaceConfig(await readFile(configPath, "utf8"), true);
  if (parsed.migrated) {
    const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.migration.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(parsed.entries, null, 2)}\n`, {
        encoding: "utf8", flag: "wx", mode: 0o600
      });
      await rename(temporaryPath, configPath);
    } catch {
      await unlink(temporaryPath).catch((): void => {});
      throw new CoreError("INTERNAL_ERROR");
    }
  }
  return parsed.entries;
}

function jsonContent(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }]
  };
}

function unknownTask() {
  return {
    isError: true,
    ...jsonContent({ error: "UNKNOWN_TASK" })
  };
}

async function main(): Promise<void> {
  if (process.argv.length !== 3) {
    throw new Error("Usage: node dist/src/mcp-stdio.js /absolute/path/to/workspaces.json");
  }

  const configPath = process.argv[2];
  if (configPath === undefined) throw new Error("Workspace configuration path is required.");
  const identity = await loadHostIdentity(resolve(configPath) + ".identity.json");
  const parsed = await loadWorkspaceConfig(configPath);
  const canonicalConfigPath = await realpath(configPath);
  const workspaceEntries = parsed.filter((entry): entry is WorkspaceEntry => !isProjectRootEntry(entry));
  const projectRootEntries = parsed.filter(isProjectRootEntry);
  const registry = new RegisteredWorkspaceRegistry(workspaceEntries);
  const catalog = new ManagedWorkspaceCatalog(`${configPath}.managed-workspaces.json`);
  await catalog.load();
  for (const entry of catalog.entries()) {
    try {
      registry.registerManaged(entry.id, entry.root);
    } catch {
      // A manual or earlier managed registration already owns the id or root.
    }
  }
  let onboarding = new WorkspaceOnboardingService(
    registry,
    catalog,
    projectRootEntries.map(({ root }) => root)
  );
  const executorFactory: ExecutorFactory = (executor, workspaceRoot, codexHome) => {
      switch (executor) {
        case "codex": {
          const authHome = process.env.ENGINEERING_BRIDGE_CODEX_AUTH_HOME ?? codexHome;
          return new CodexExecutor(workspaceRoot, undefined,
            authHome === undefined ? process.env : { ...process.env, CODEX_HOME: authHome });
        }
        case "dsh": return new DshExecutor(workspaceRoot);
      }
    };
  const phoneConfig = await loadPhoneConfig(resolve(configPath) + ".phone.json");
  const phone = phoneConfig ? new PhoneService(phoneConfig, new RealAdb(phoneConfig)) : undefined;
  const server = new McpServer({ name: "engineering-bridge", version: VERSION }, {
    instructions: buildServerInstructions(identity, phone ? PHONE_INSTRUCTIONS : undefined)
  });
  if (phone) registerPhoneTools(server, phone);

  const hostPolicy = await HostPolicy.load(resolve(configPath) + ".host-policy.json");
  const works = new WorkService(resolve(configPath) + ".work-items.json", registry, executorFactory, hostPolicy);
  works.load();
  registerWorkTools(server, works);
  let sweeping = false;
  const sweep = async () => {
    if (sweeping) return;
    sweeping = true;
    try { await works.sweep(); } catch { process.stderr.write("Work retention sweep failed.\n"); }
    finally { sweeping = false; }
  };
  setInterval(() => { void sweep(); }, 3_600_000).unref();
  registerHostTools(server, hostPolicy, {
    identity,
    ...(phone ? { withCommand: <T>(operation: () => Promise<T>) => phone.maintenanceCommand(operation) } : {}),
    validateText: (path, content) => {
      if (relative(canonicalConfigPath, path) === "") parseWorkspaceConfig(content);
    },
    reloadWorkspaces: async () => {
      if (works.hasPendingTasks()) throw new HostError("HOST_TASKS_PENDING", "Finish pending executions before reloading workspaces.");
      const entries = await loadWorkspaceConfig(configPath);
      const manual = entries.filter((entry): entry is WorkspaceEntry => !isProjectRootEntry(entry));
      const roots = entries.filter(isProjectRootEntry).map(entry => entry.root);
      const next = new RegisteredWorkspaceRegistry(manual);
      for (const entry of catalog.entries()) {
        if (!next.findByRoot(entry.root)) next.registerManaged(entry.id, entry.root);
      }
      registry.replaceWith(next);
      onboarding = new WorkspaceOnboardingService(registry, catalog, roots);
      return { reloaded: true, workspaces: registry.list() };
    }
  });

  server.registerTool("list_workspaces", {
    description: "Discover registered local projects before running tasks when the user provides a project name or description instead of workspace_id. Optional query filters name, path or ID by case-insensitive substring. Omit query to list all registered projects and use their names to interpret the user's meaning. Return all ambiguous candidates; ask the user when the intended project is unclear. Never invent IDs. This read-only tool only reads the workspace registry; it does not scan project files or register directories.",
    inputSchema: { query: z.string().max(256).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ query }) => jsonContent({ workspaces: registry.list(query) }));

  registerTaskResultTools(server, works);

  server.registerTool("control_task", {
    description: "Steer or interrupt a running execution. Use continue_work for the next turn and finish_work for semantic completion.",
    inputSchema: {
      task_id: z.string(),
      action: z.enum(["steer", "interrupt"]),
      instruction: z.string().optional()
    }
  }, async ({ task_id, action, instruction }) => {
    if (works.taskView(task_id) === undefined) return unknownTask();
    try {
      const view = await works.controlTask(task_id, action, instruction);
      return jsonContent({ task_id: view.taskId, state: view.state });
    } catch (error) {
      return { isError: true, ...jsonContent({ error: serializeError(error) }) };
    }
  });

  server.registerTool("bind_project", {
    description: "Register an existing local project directory as a workspace. The path must already exist inside a configured project_root.",
    inputSchema: {
      project_path: z.string().min(1)
    }
  }, async ({ project_path }) => {
    try {
      return jsonContent(await onboarding.bind({ project_path }));
    } catch (error) {
      return { isError: true, ...jsonContent({ error: serializeError(error) }) };
    }
  });

  server.registerTool("create_project", {
    description: "Create a new empty Git project directory inside a configured project_root and register it as a workspace. Only mkdir and git init are performed.",
    inputSchema: {
      parent: z.string().min(1),
      name: z.string().min(1)
    }
  }, async ({ parent, name }) => {
    try {
      return jsonContent(await onboarding.create({ parent, name }));
    } catch (error) {
      return { isError: true, ...jsonContent({ error: serializeError(error) }) };
    }
  });

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Failed to start engineering-bridge.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
