import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type ApiNameProfile = "v1" | "v2";

// Stable operation keys preserve adapters, stored diagnostics and v1 clients.
// Values are the canonical v2 public names. No alias is registered alongside it.
export const PUBLIC_TOOL_NAMES = {
  list_work: "list_work", open_work: "open_work", continue_work: "continue_work",
  run_temp: "run_agent_once", finish_work: "mark_work_complete", manage_work: "manage_work",
  work_retention: "manage_retention", list_workspaces: "list_workspaces", bind_project: "register_workspace",
  create_project: "create_project", task_result: "get_task", wait_task: "wait_task",
  control_task: "control_task", list_tasks: "list_tasks", host_capabilities: "host_capabilities",
  list_codex_projects: "list_codex_history_projects", list_codex_threads: "list_codex_threads",
  read_host_file: "read_host_file", list_host_path: "list_host_directory", write_host_text_file: "write_host_text_file",
  copy_file: "copy_host_file", move_file: "move_host_file", delete_file: "delete_host_file",
  run_host_command: "run_host_command", start_host_process: "start_host_process", reload_workspace_config: "reload_workspace_config",
  export_host_file: "export_host_file", read_export_chunk: "read_export_chunk", release_host_export: "release_host_export",
  server_status: "phone_status", phone_acquire_control: "phone_acquire_control", phone_release_control: "phone_release_control",
  phone_observe: "phone_observe", phone_list_apps: "phone_list_apps", phone_open_app: "phone_open_app", phone_input: "phone_input",
  phone_drag: "phone_drag", phone_sequence: "phone_sequence", phone_display: "phone_display", phone_recover: "phone_recover",
  desktop_status: "desktop_status", desktop_list: "desktop_list", desktop_snapshot: "desktop_snapshot", desktop_find: "desktop_find",
  desktop_read: "desktop_read", desktop_act: "desktop_act", desktop_window: "desktop_window", desktop_clipboard: "desktop_clipboard",
  desktop_screenshot: "desktop_screenshot", desktop_wait: "desktop_wait", desktop_input: "desktop_input"
} as const;

export function apiNameProfile(environment: Readonly<NodeJS.ProcessEnv> = process.env): ApiNameProfile {
  const value = environment.ENGINEERING_BRIDGE_API_NAME_PROFILE;
  if (value === undefined || value === "v1") return "v1";
  if (value === "v2") return "v2";
  throw new Error("ENGINEERING_BRIDGE_API_NAME_PROFILE must be v1 or v2.");
}

export function publicToolName(operation: string, profile: ApiNameProfile): string {
  if (!Object.hasOwn(PUBLIC_TOOL_NAMES, operation)) throw new Error(`Unknown public tool operation: ${operation}`);
  return profile === "v1" ? operation : PUBLIC_TOOL_NAMES[operation as keyof typeof PUBLIC_TOOL_NAMES];
}

// Only apply to server-authored guidance, never user content, paths or results.
export function toolText(text: string, profile: ApiNameProfile): string {
  if (profile === "v1") return text;
  return text.replace(/\b[a-z][a-z_]*\b/gu, word => Object.hasOwn(PUBLIC_TOOL_NAMES, word) ? publicToolName(word, profile) : word);
}

export type ToolRegistry = Pick<McpServer, "registerTool" | "registerResource" | "server"> & {
  readonly nameProfile?: ApiNameProfile;
};

/** Explicit registration boundary. Does not patch SDK methods or tool-call routing. */
export function createToolRegistry(server: McpServer, nameProfile: ApiNameProfile): ToolRegistry {
  const registerTool: McpServer["registerTool"] = (operation, config, callback) => server.registerTool(
    publicToolName(operation, nameProfile),
    { ...config, ...(config.description === undefined ? {} : { description: toolText(config.description, nameProfile) }) },
    callback
  );
  return { nameProfile, registerTool, registerResource: server.registerResource.bind(server), server: server.server };
}
