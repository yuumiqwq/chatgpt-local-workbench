# Public tool name profiles

Set `ENGINEERING_BRIDGE_API_NAME_PROFILE=v2` in the environment of the Bridge process to select the canonical names below. Unset or `v1` preserves the existing catalog. Other values fail startup. The main STDIO and standalone phone entrypoints use the same setting; each instance registers exactly one name per operation, never both aliases. This is a **name profile**, not a new payload/protocol version: input fields, defaults, errors, permissions and persistent IDs are unchanged.

| v1, default | v2, explicit | Reason |
| --- | --- | --- |
| `run_temp` | `run_agent_once` | One disposable Codex/DSH turn. File edits and retained results can persist. |
| `finish_work` | `mark_work_complete` | Record semantic completion; never stop an execution. Busy work is rejected. |
| `task_result` | `get_task` | Read a running or terminal task view, including available output. |
| `work_retention` | `manage_retention` | Configure work history rules and agent/process result retention. |
| `bind_project` | `register_workspace` | Register an existing project directory and return its workspace ID. |
| `list_codex_projects` | `list_codex_history_projects` | Group native history by cwd; separate from registered workspaces. |
| `server_status` | `phone_status` | Android adapter status, including in the standalone phone server. |
| `copy_file` | `copy_host_file` | Consistent host-file scope. |
| `move_file` | `move_host_file` | Consistent host-file scope. |
| `delete_file` | `delete_host_file` | Consistent host-file scope. |
| `list_host_path` | `list_host_directory` | Lists directory entries; does not read arbitrary file content. |

Every other public name is retained. `open_work`/`continue_work` name the durable lifecycle; `list_workspaces`/`create_project` distinguish discovery from creation. `list_tasks`, `wait_task`, `control_task` describe discovery, bounded waiting and control. `run_host_command` and `start_host_process` distinguish synchronous commands from asynchronous OS processes. Existing host read/write, export, history-thread, phone and desktop names already identify their domain. `manage_work` retains grouped archive/unarchive/delete_history/forget actions rather than adding four tools. See [the complete v1 inventory](api-architecture-audit.zh-CN.md); substitute only the eleven rows above for v2.

## Switching an existing deployment

Add the variable to the MCP launcher's `env`, or to an existing Windows deployment configuration's `tunnel.environment` when that launcher owns the Bridge child. The existing deployment script passes these environment values to its child. For example, the launcher environment object can include `"ENGINEERING_BRIDGE_API_NAME_PROFILE": "v2"`. Do not put the setting in host-policy JSON. No running instance changes its profile in place, and `reload_workspace_config` does not reload this setting.

Upgrading code without setting the variable keeps v1 clients working. To enable v2, first verify that the owning Bridge has no active tasks, coordinate a normal restart, and refresh client tool metadata. Roll back names by unsetting the variable or selecting v1, restarting normally and refreshing metadata. No work_id, task_id, native thread UUID or history-file migration is needed. Instances with different profiles can read the same registry; execution control still belongs to the instance holding the live handle.

`host_capabilities` returns `api_name_profile` and the existing package-sourced `server_version`; `version: 1` remains the host-policy schema version. No version tool is added. Both servers also identify the profile in MCP `serverInfo.title`; standalone phone status includes `api_name_profile` and its actual capability names. A package version does not identify a Git commit or prove that a client refreshed its catalog: compare deployed build records and actual `tools/list` as well.

## Retention and recovery

`list_tasks` is a read-only projection of retained execution records, not a growing second registry. The default cap is **100 terminal agent/process tasks combined**, ordered by `updated_at`; queued/running tasks are outside that cap. `max_results` accepts 1-1000; `result_days` is disabled by default. Pruning runs on startup, execution completion, retention changes and the hourly sweep. Reads can reconcile status in memory but do not delete or persist records; they can observe a transient excess from other writers until a pruning transaction. Setting limits prunes immediately; `manage_retention({sweep:true})` in v2 or `work_retention({sweep:true})` in v1 reconciles and prunes explicitly.

A missing/dead Bridge owner turns unfinished records into failed tasks eligible for pruning; a credible terminal process snapshot takes precedence. Live-owner records have no age expiry. PID reuse or a live owner that lost its execution handle can still leave an indeterminate record: current liveness checks do not verify process start identity. Automatic age-based deletion would risk hiding a genuine long-running task. Work counts and native history are outside the result cap; history archive/delete rules default to disabled, and result pruning preserves summaries and project files.

If a start receipt is lost, use `list_tasks({kind:"process",limit:20})`, optionally with `created_after`, then `get_task` in v2 or `task_result` in v1. Omit state when recovering because the task may already have ended. Discovery omits argv, instructions, outputs and owner PID, but executable/cwd paths can still be private. Offset pages can shift with concurrent activity. Pruned tasks are no longer discoverable, and an empty list does not prove that a command never ran.

## Verification

`src/api-names.ts` owns the fixed operation-to-public-name registry. Registration modules retain stable internal operation keys so diagnostic records and persistence are not renamed. The adapter composes with MCP registration; it does not patch SDK methods or translate arbitrary request/result strings. Only server-authored descriptions, schema guidance and instructions use the selected names; operator instructions and user data remain unchanged.

Tests fix both `tools/list` name/schema snapshots, compare 128 actual STDIO configurations, check both standalone phone profiles, exercise v2 dispatch and v1 reopening of the same registry, and verify mixed-task retention and dead-owner reconciliation. Platform/hardware acceptance remains separate from registration tests. API envelope, selector and cross-instance lease proposals in the earlier audit are still future work; enabling the v2 name profile does not implement those proposals.
