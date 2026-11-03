# Execution and host access

Codex and DSH both accept read-only and danger-full-access. run_temp defaults to danger-full-access for either executor and applies access separately on each call, including calls associated with an existing work. Full-access model tool operations use the current OS account's filesystem and network privileges; this grants no administrator elevation.

| Access | Codex | DSH |
| --- | --- | --- |
| read-only | Native readOnly sandbox with network disabled, passed to thread and turn configuration. | Per-process DSH_PERMISSION_MODE=read-only selects the native filesystem permission policy; file write/edit tools are denied. |
| danger-full-access | Native dangerFullAccess sandbox with approvalPolicy never. | Per-process DSH_PERMISSION_MODE=danger-full-access permits native filesystem writes and shell execution without the read-only sandbox. |

Bridge overrides inherited DSH_PERMISSION_MODE for each invocation and keeps the official one-shot headless launch. The environment mapping and filesystem policy were checked against @deepseek-ai/dsh 0.1.2-rc.1 and its [official base configuration](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/base/cordis.patch.yml) and [filesystem sandbox implementation](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/fs/fs-sandbox/src/index.ts). DSH read-only does not disable network. Shell containment depends on DSH's installed native sandbox implementation and platform support; Bridge adds no separate OS sandbox or containment boundary based solely on the starting directory.

Native checks with DSH 0.1.2-rc.1 on Windows verified that read-only file writes/edits inside and outside the workspace return FS_SANDBOX_DENIED without changing content, while reads succeed. A write command confined by the real Windows runner returned EPERM and created no target file. Full access allowed the corresponding filesystem and command writes. These checks exercised the installed services and native runner without a model session; they do not claim an end-to-end headless model run.

The tested Windows provider reports enforcement=partial. Its [native implementation](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sandbox/sandbox-local/src/index.ts) documents the WRITE_RESTRICTED token's required Everyone entry and NTFS hard links sharing a file object. Equal access choices do not imply identical or complete OS isolation across executors and platforms.

Access settings apply to executor tool operations, not to Bridge's own result/log persistence or the executor's own runtime data. Stopping a full-access execution does not undo changes already made.

Workspace registration identifies a project and limits onboarding through `project_root`; it does not authorize writes. Bridge-owned file and command tools are governed separately by host-policy `read_roots`, `write_roots`, `command_roots` and command settings. Successful process execution does not prove goal completion: finish_work records the caller's decision.

Optional host file tools retain configured roots, size bounds and SHA-256 replacement checks. Enabled host commands are not OS-sandboxed by their starting directory. Their maximum duration is 45 seconds and output is bounded. File policies do not restrict a separate full-access model execution.

Optional [direct desktop access](desktop.md) has a separate disabled-by-default, hostname-bound host policy. The existing MCP server invokes a hash-verified native agent-desktop executable through fixed typed commands, with hidden processes, no shell, bounded requests/output/deadlines and no automatic retries. Headed/physical input, screenshots and clipboard access have explicit gates; held inputs, arbitrary argv, trace/file output flags and forced shortcuts are unavailable. Desktop UI data is untrusted and private. Audit records contain tool names and state only; CLI stderr is not returned. Snapshot state is protected from ordinary host file reads/writes and export, and the executable directory is protected from file writes. These checks are not an OS sandbox: separately enabled arbitrary commands/full-access executors retain account authority. Policy updates remain local administrator actions followed by a runtime restart.

Executor turns use a 60-minute default hard deadline. Codex uses a five-minute ordinary active-turn inactivity watchdog, a 15-minute inactivity window while a command is in progress, and a 30-second RPC bound. Cancellation of wait_task leaves execution running; control_task interrupt stops execution without undoing edits. Registry writes use short file locks and merge changed records; this does not lock the native history against execution by another client.

Archive preserves history. Native delete_history deletes the selected thread and its spawned descendants, while retaining the registered work's summary and UUID lineage. Age-based native deletion defaults to disabled. Local registry/results are private state and should not be committed to a public repository. Authentication remains in the executor's local profile.
