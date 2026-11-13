import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TaskView } from "./tasks/execution-types.js";
import type { WorkService } from "./tasks/work-service.js";
import { DEFAULT_WAIT_TASK_TIMEOUT_SECONDS, waitTaskMaxTimeoutSeconds } from "./runtime-config.js";
import { LONG_TASK_INSTRUCTIONS } from "./server-instructions.js";
import { HostError } from "./host/host-policy.js";
import { serializeError } from "./core/errors.js";

function jsonContent(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }]
  };
}

function taskResultContent(view: TaskView | undefined) {
  if (view === undefined) {
    return { isError: true, ...jsonContent({ error: "UNKNOWN_TASK" }) };
  }
  const taskView = { task_id: view.taskId, state: view.state,
    kind: view.kind ?? "agent",
    ...(view.process === undefined ? {} : { process: view.process }),
    ...(view.executor === undefined ? {} : { executor: view.executor }),
    ...(view.threadId === undefined ? {} : { thread_id: view.threadId }),
    ...(view.access === undefined ? {} : { access: view.access }),
    ready: view.ready,
    ...(view.output === undefined ? {} : { output: view.output }),
    ...(view.partial_output === undefined ? {} : { partial_output: view.partial_output }),
    evidence: view.evidence,
    ...(view.last_activity_at === undefined ? {} : { last_activity_at: view.last_activity_at }),
    ...(view.active_item === undefined ? {} : { active_item: view.active_item }),
    ...(view.elapsed_seconds === undefined ? {} : { elapsed_seconds: view.elapsed_seconds }),
    ...(view.diagnostics === undefined ? {} : { diagnostics: view.diagnostics }),
    ...(view.error === undefined ? {} : { error: view.error }) };
  return jsonContent({
    ...taskView,
    mcp_diagnostics: {
      serialized_task_view_bytes: Buffer.byteLength(JSON.stringify(taskView), "utf8")
    }
  });
}

export function registerTaskResultTools(
  server: McpServer,
  service: Pick<WorkService, "taskView" | "waitTask">
): void {
  const maxWaitSeconds = waitTaskMaxTimeoutSeconds();
  server.registerTool("task_result", {
    description: "Inspect an agent or native process task by task_id, including running status, bounded process stdout/stderr, or terminal output/error. kind distinguishes agent from process. ready marks a terminal record; inspect process.outcome_unknown/error after lost monitoring, and verify artifacts separately. This tool is read-only.",
    inputSchema: { task_id: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false }
  }, ({ task_id }) => taskResultContent(service.taskView(task_id)));

  server.registerTool("wait_task", {
    description: `Wait until a task is ready, or the timeout expires. Returns the current task view without interrupting the task. This tool is read-only. ${LONG_TASK_INSTRUCTIONS}`,
    inputSchema: {
      task_id: z.string(),
      timeout_seconds: z.number().min(1).max(maxWaitSeconds).optional().default(DEFAULT_WAIT_TASK_TIMEOUT_SECONDS)
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  }, async ({ task_id, timeout_seconds }, { signal }) => {
    const view = await service.waitTask(task_id, timeout_seconds, signal);
    signal.throwIfAborted();
    return taskResultContent(view);
  });
}

export function registerTaskControlTool(server: McpServer, service: Pick<WorkService, "taskView" | "controlTask">) {
  server.registerTool("control_task", {
    description: "Interrupt a running native process or agent execution; steer is supported only by capable agent executors. Process interrupt requests OS process-tree termination and returns promptly; use wait_task/task_result to observe actual exit. Control must reach the owning Bridge instance. Use continue_work for another durable Codex turn and finish_work for semantic completion.",
    inputSchema: { task_id: z.string(), action: z.enum(["steer", "interrupt"]), instruction: z.string().optional() }
  }, async ({ task_id, action, instruction }) => {
    if (service.taskView(task_id) === undefined) return { isError: true, ...jsonContent({ error: "UNKNOWN_TASK" }) };
    try {
      const view = await service.controlTask(task_id, action, instruction);
      return jsonContent({ task_id: view.taskId, state: view.state });
    } catch (error) {
      return { isError: true, ...jsonContent({ error: error instanceof HostError
        ? { code: error.code, message: error.message } : serializeError(error) }) };
    }
  });
}
