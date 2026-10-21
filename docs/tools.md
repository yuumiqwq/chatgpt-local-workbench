# Current MCP tools

chatgpt-local-workbench exposes durable Codex work, temporary agent execution and optional host operations. See [work management](work-management.md) for lifecycle, default full access and retention semantics.

| Tool | Inputs / purpose |
| --- | --- |
| list_work | query, workspace_id/cwd, status, archived, offset/limit; find durable work IDs. |
| open_work | work_id, thread_id, or workspace_id/cwd + name; create, reopen or adopt. Optional access. |
| continue_work | work_id + instruction; optional model, reasoning_effort, access. |
| run_temp | work_id/workspace_id/cwd + instruction; optional executor codex/dsh and access read-only/danger-full-access. model and reasoning_effort are Codex-only. |
| finish_work | work_id + summary; optional references. Caller-declared goal completion. |
| manage_work | work_id + archive/unarchive/delete_history/forget. Native deletion includes descendants. |
| work_retention | Optional result count/age and archive/delete age rules; optional sweep. |
| task_result | task_id; retrieve result, error and bounded execution evidence. |
| wait_task | task_id, timeout_seconds 1–300 by default, default 25; cancellation does not stop execution. |
| control_task | task_id, action steer/interrupt; steering also takes instruction. |
| list_workspaces | Optional query; discover registered project roots and IDs. |
| bind_project | project_path; register an existing project. |
| create_project | parent + name; create an empty Git project and register it. |
| host_capabilities | Current host settings and execution limits. |
| list_codex_projects | Optional query/codex_home/cursor/scan_limit/archived; project groups from a bounded history page. |
| list_codex_threads | Optional query/cwd/codex_home/cursor/limit/archived; native IDs and titles. |
| read_host_file | path; optional offset, max_bytes and utf8/base64 encoding. include_sha256 defaults to false; request it once before a replacement, move or deletion. |
| export_host_file | path inside export_roots; returns immutable transfer metadata and an MCP resource_link for native attachment delivery. No file bytes in the initial response. |
| read_export_chunk | export_id, offset, max_bytes up to 524,288; Base64 bytes, chunk_sha256, full sha256, size, next_offset and eof. Optional content_text=false avoids duplicating bytes outside structuredContent. |
| release_host_export | export_id; release a buffered export without modifying its source. |
| list_host_path | path; optional offset/limit. |
| write_host_text_file | path + content; expected_sha256 for replacement; optional create_parents. |
| copy_file | source + destination; optional create_parents. |
| move_file | source + destination + expected_sha256; optional create_parents. |
| delete_file | path; expected_sha256 for a file; empty directories also supported. |
| run_host_command | absolute executable + args + cwd; timeout_seconds 1–45. |
| reload_workspace_config | Validate/reload when no executions are pending. |

There are 24 tools with optional host operations enabled, 27 when export_roots is also configured, and 14 without host operations. `list_workspaces`, `bind_project` and `create_project` return project identity fields without permission metadata. Host files retain their configured roots and content hash checks; enabled host commands and full-access Codex or DSH executions use OS account privileges.

`read_host_file` reads only the requested page by default and omits `sha256`. Set `include_sha256: true` when obtaining a content hash for `expected_sha256`; this explicitly scans the whole file. UTF-8 pages may be shorter than `max_bytes` to keep characters intact; follow the returned `next_offset`. A page must fit at least one character, so `max_bytes` of at least 4 supports every UTF-8 code point. Base64 pagination retains exact byte boundaries.

Access accepts read-only or danger-full-access for Codex and DSH, with full access the default. run_temp applies its own per-call access selection even when associated with a work_id; omitting access does not inherit that work's stored mode. continue_work uses the stored work access unless overridden. Old work records are normalized during load while historical result records retain the access that was used. See [security behavior](security.md) for each executor's permission mechanism.

New successful executions return state completed, ready true and output. Failures expose structured errors; interrupted runs may expose genuine partial_output. Persistent runs carry thread_id; temporary and DSH runs do not. Executor turns use a 60-minute default deadline. Codex uses a five-minute ordinary active-turn inactivity watchdog, a 15-minute command-in-progress inactivity window and 30-second RPC deadlines. A successful wait_task response with ready=false leaves execution running and permits continued waiting. Three consecutive connection failures or request timeouts without a valid response instead require stopping retries, reporting known progress/IDs and waiting for the user to reconnect and reply `继续`; see [connection recovery](connection-recovery.md). Running task views can expose last_activity_at, active_item and elapsed_seconds for progress diagnosis.

Codex RPC rejections expose `error.rpc_method`, numeric `error.rpc_error_code` and `error.rpc_error_category`. `CODEX_THREAD_BUSY` with category `thread_busy` identifies the allowlisted `-32600` / `thread <uuid> already has an active writer` conflict; wait for the other writer to release that thread before continuing it. Other valid RPC errors use `CODEX_RPC_ERROR` with category `unknown`, including unrelated `-32600` errors. Messages are fixed safe text; raw server messages, error data and stderr are omitted. These fields also survive stored result/registry reads and steering error serialization. `CODEX_PROTOCOL_ERROR` is reserved for malformed or unexpected protocol messages/structure. An unanswered RPC deadline uses `CODEX_RPC_TIMEOUT`; a failed Codex turn uses `CODEX_TURN_FAILED`; the configured total execution deadline uses `EXECUTION_DEADLINE_EXCEEDED`. No automatic retry or thread replacement is performed.

DSH supports interruption but not steering. `control_task` must reach the Bridge process that owns the live executor; a different process can read stored status but cannot steer that executor. `WORK_RESULT_WRITE_FAILED` indicates that execution ended but its result could not be persisted; check files and storage before retrying.

Tools exchange JSON text through MCP; file exports also return structuredContent and an MCP resource_link. See [file exports](file-exports.md) for native attachment delivery and the binary reconstruction protocol. Obtain IDs from discovery/creation responses, and use one project selector per call to avoid relying on implementation precedence. The complete input schemas are returned by MCP `tools/list`; the repository's `src/work-tools.ts`, `src/host/host-tools.ts` and `src/mcp-stdio.ts` define them.

## Optional Android tools

An explicitly enabled `workspaces.json.phone.json` adds `server_status`, `phone_acquire_control`, `phone_release_control`, `phone_observe`, `phone_list_apps`, `phone_open_app`, `phone_input`, `phone_sequence`, `phone_display`, and `phone_recover` to this same stdio server. Missing/disabled configuration leaves the original tool list unchanged. Strict schemas are discoverable through tools/list and defined in `src/phone/service.ts`. See [Legion deployment](phone-legion-deployment.md) and [phone security](phone-security.md) for bearer leases, original-versus-rendered coordinates, maintenance authority, and hardware limitations. Physical display-off uses a locally configured scrcpy panel controller.

`phone_sequence` accepts 1–8 input actions with optional per-step conditions, waits for the IME connection before text entry, and returns one final observation plus step timings. Callers supply the steps for the observed page. A failure or condition timeout stops subsequent actions and returns progress; retrying the same request ID reports the receipt without resuming or repeating actions. `settle_ms` optionally waits up to 2000 ms before the final observation.
