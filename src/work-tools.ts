import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HostError } from "./host/host-policy.js";
import { serializeError } from "./core/errors.js";
import { WorkService } from "./tasks/work-service.js";
import { CONNECTION_RECOVERY_INSTRUCTIONS } from "./server-instructions.js";

export function registerWorkTools(server: McpServer, works: WorkService) {
  const id = z.string().uuid(), text = z.string().min(1);
  const access = z.enum(["read-only", "danger-full-access"])
    .describe("Per-execution access for Codex and DSH: read-only or danger-full-access. New work and run_temp default to danger-full-access; continue_work inherits the work setting unless overridden.");
  const turn = { instruction: text.max(200_000), model: text.optional(),
    reasoning_effort: text.optional(), access: access.optional() };
  const safe = async (operation: () => unknown) => {
    try { return { content: [{ type: "text" as const, text: JSON.stringify(await operation()) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({
      error: error instanceof HostError ? { code: error.code, message: error.message } : serializeError(error)
    }) }] }; }
  };
  server.registerTool("list_work", {
    description: "Find durable work IDs by project, name, status or summary. Names are searchable labels, not unique routing keys. Pagination uses offset. Omit archived to include all records. last_run reports process completion; work status records the caller's semantic completion decision.",
    inputSchema: { query: text.optional(), workspace_id: text.optional(), cwd: text.optional(),
      status: z.enum(["active", "completed"]).optional(), archived: z.boolean().optional(),
      offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(20) },
    annotations: { readOnlyHint: true }
  }, args => safe(() => works.list(args)));
  server.registerTool("open_work", {
    description: "Create, reopen or adopt work through one interface. work_id reopens its record; thread_id adopts an existing local Codex history and returns the existing work if already mapped. Otherwise supply workspace_id or cwd plus a display name. New records create no native thread until continue_work. Reopening archived history unarchives it. After delete_history the next turn creates a new UUID using retained summary/references. Does not start a model turn.",
    inputSchema: { work_id: id.optional(), thread_id: id.optional(), workspace_id: text.optional(),
      cwd: text.optional(), name: text.max(256).optional(), access: access.optional() }
  }, args => safe(() => works.open(args)));
  server.registerTool("continue_work", {
    description: `Execute a turn in a durable work, reusing its native Codex UUID and history. Default access is danger-full-access: the current OS account can edit files, write Git metadata and access the network without an extra approval prompt. Select read-only for analysis that must not edit files. Edits happen immediately and stopping does not undo them. Returns task_id; after a successful ready=false response, call wait_task again until the run finishes. A completed run does not mark the work complete. Bridge coordinates its own executions only; other clients' activity is unknown. ${CONNECTION_RECOVERY_INSTRUCTIONS}`,
    inputSchema: { work_id: id, ...turn }
  }, ({ work_id, ...args }) => safe(() => works.continue(work_id, args)));
  server.registerTool("run_temp", {
    description: `Run any one-off instruction, including inspection or file editing, without persisting a native Codex conversation. Supply work_id, workspace_id or cwd. Optional work association does not reuse its history or access setting. Codex uses ephemeral app-server mode; DSH uses its headless executor. Both accept read-only or danger-full-access, defaulting to danger-full-access with OS account privileges and no extra approval prompt. Access is passed to the selected executor's native permission policy. Saves the result separately under the registry's .results directory, subject to retention. Save lasting artifacts in the project and reference them in finish_work. wait_task cancellation does not stop execution. ${CONNECTION_RECOVERY_INSTRUCTIONS}`,
    inputSchema: { work_id: id.optional(), workspace_id: text.optional(), cwd: text.optional(),
      executor: z.enum(["codex", "dsh"]).default("codex"), ...turn }
  }, args => safe(() => works.temp(args)));
  server.registerTool("finish_work", {
    description: "Record the caller's decision that the work is complete, with a summary and optional artifact/commit references. Does not independently establish that the goal succeeded. open_work can reopen it later using the same work ID.",
    inputSchema: { work_id: id, summary: z.string().max(100_000), references: z.array(text).max(100).optional() }
  }, ({ work_id, summary, references }) => safe(() => works.finish(work_id, summary, references)));
  server.registerTool("manage_work", {
    description: "Manage a selected work's retention directly. archive hides native history while retaining it; unarchive restores it. delete_history calls Codex thread/delete, which deletes that persisted thread AND its spawned descendants; keeps this work's summary/references and UUID lineage. forget removes only the work registry record, leaving native history and retained run results. No immutable purpose categories or confirmation tokens. Running executions must finish first.",
    inputSchema: { work_id: id, action: z.enum(["archive", "unarchive", "delete_history", "forget"]) },
    annotations: { destructiveHint: true }
  }, ({ work_id, action }) => safe(() => works.manage(work_id, action)));
  server.registerTool("work_retention", {
    description: "Read/update retention and optionally sweep now. Runs hourly while Bridge is running. Defaults: retain 100 terminal run results, no age-based archive/delete. Nullable day settings disable their rule. archive_completed_days uses caller-marked completed works; delete_archived_days applies to registered archived works without purpose categories. Native deletion also removes spawned descendants. Result pruning does not delete project artifacts or work summaries. Updating max_results/result_days immediately prunes matching results.",
    inputSchema: { max_results: z.number().int().min(1).max(1000).optional(),
      result_days: z.number().positive().nullable().optional(),
      archive_completed_days: z.number().positive().nullable().optional(),
      delete_archived_days: z.number().positive().nullable().optional(), sweep: z.boolean().default(false) },
    annotations: { destructiveHint: true }
  }, ({ sweep, ...args }) => safe(async () => {
    const settings = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
    const retention = Object.keys(settings).length ? works.configureRetention(settings) : works.list({ limit: 0 }).retention;
    return sweep ? works.sweep() : { retention, registry_file: works.path, results_directory: works.resultDirectory };
  }));
}
