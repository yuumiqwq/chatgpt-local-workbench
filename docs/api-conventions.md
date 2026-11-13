# API conventions and discovery

Examples below use the default v1 names. See [name profiles](api-name-profiles.md) for the implemented v2 canonical names, switch and retention boundaries.

Use a small vocabulary: a **workspace** identifies a registered project directory; a **work** records durable Codex work and the caller's completion decision; a **thread** is native Codex history; a **task** is one agent or native process execution. Internal `run` records use the public `task_id`. A process has no fabricated agent access mode, work or thread.

| Need | Public interface |
| --- | --- |
| Find a registered project | `list_workspaces`; `bind_project` registers an existing directory, `create_project` creates an empty Git directory and registers it. |
| Find native Codex history | `list_codex_projects` groups one bounded page by cwd; `list_codex_threads` returns native IDs. Neither is the workspace registry. |
| Prepare durable work | `open_work`, then `continue_work` for a Codex turn. `open_work` itself does not run a model. |
| One-off agent reasoning | `run_temp`, using Codex or DSH. Temporary refers to the conversation; retained results and filesystem edits can persist. |
| Short ordinary command | `run_host_command`, synchronous with a maximum 45-second deadline. |
| Long ordinary command | `start_host_process`, asynchronous without a model. |
| Recover a lost start receipt | `list_tasks`, then inspect candidates using `task_result`; never automatically replay an uncertain start. |
| Observe or control execution | `task_result` returns current status/output; `wait_task` waits; `control_task` interrupts or steers a supported agent. Cancelling a wait does not stop execution. |
| Record the goal as complete | `finish_work` records the caller's assessment. It does not terminate execution or verify artifacts. |
| History and retention | `manage_work` changes archive/history/registration state; `work_retention` also applies to retained agent and process results. |

`list_tasks({kind:"process", state:"running", limit:20})` discovers recent retained process IDs. Omit state when recovering a receipt because a task may already have finished. `created_after` is an inclusive UTC ISO timestamp. Follow `next_offset`, deduplicate by task_id if concurrent starts/pruning shift pages, and use `task_result` for details. Results include metadata only, with no argv, instruction, stdout/stderr or owner PID. Paths can still be private. Retention removes terminal records; an empty page cannot establish that a lost start never ran.

`control_available` indicates an active handle in this Bridge instance. Other instances sharing the same registry can observe tasks but cannot control their OS process or executor. A true value is not a promise that every control action is supported. No automatic restart, owner transfer or exactly-once start guarantee is introduced.

`tools/list` is the exposed catalog. `host_capabilities` describes loaded policy and returns the selected `api_name_profile` plus `server_version` from the Workbench package; the existing `version` field is the policy schema version. Package versions may span several commits, so use deployment records to establish the exact revision. `desktop.tool_names` lists the policy-selected desktop tools, while `gui_control` means that module is enabled, not that every action is allowed or the CLI is ready. Generic command tools remain listed when command execution is disabled. Document parsing follows host read policy and has no independent enable flag. Phone configuration is independent; its legacy `server_status` reports the Android adapter, not overall Bridge or tunnel health.

The default v1 catalog keeps existing names and signatures. The explicit v2 name profile uses canonical names in place of old names, never alongside them. `list_tasks` fills a missing recovery path in both profiles. Full connection recovery guidance lives in server instructions; task tools retain compact reminders. Mutating tool annotations are advisory; policy and executor checks enforce access.

MCP success, terminal task state and UI delivery are separate from goal completion. Existing domains retain their response/error formats for compatibility. A final audit-log failure is reported through `_meta.audit_warning` without hiding a successful operation's normal receipt. See the [complete inventory and architecture audit](api-architecture-audit.zh-CN.md) for module boundaries, compatibility decisions and v2 proposals.
