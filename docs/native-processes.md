# Native processes and agent tasks

| Need | API | Lifetime |
| --- | --- | --- |
| Short command, such as a version or Git status check | `run_host_command(executable, args, cwd, timeout_seconds?)` | Synchronous, default 25 seconds, maximum 45. No task ID. |
| Long build, report conversion, training or script | `start_host_process(executable, args, cwd, timeout_seconds?)` | Native OS execution without Codex/DSH; returns `task_id`. |
| One-off reasoning, investigation or editing by an agent | `run_temp(instruction, work_id/workspace_id/cwd, executor?)` | One Codex or DSH execution; returns `task_id`. |
| Continuing agent work with conversation history | `open_work` then `continue_work(work_id, instruction)` | Durable Codex work has a `work_id`; each turn gets its own `task_id`. |
| Inspect execution | `task_result(task_id)` | Immediate running snapshot or terminal result. |
| Wait for execution | `wait_task(task_id, timeout_seconds?)` | Returns when ready or the wait expires; does not stop execution. |
| Stop execution | `control_task(task_id, action: "interrupt")` | Requests termination; inspect the same task until ready. |

`start_host_process` names the substantial new capability explicitly. Existing APIs remain available without deprecation or aliases: `run_temp` means temporary **agent** execution, and `task_result` already provides task inspection, so a second `get_task` endpoint is unnecessary. `finish_work` records the caller's semantic completion decision for durable agent work; it does not stop a process. `manage_work` manages that work's native history, not process tasks. See the [complete current API table](tools.md).

## Example

After inspecting `host_capabilities`, use the actual interpreter path on the connected machine. The example paths are placeholders:

```json
{"executable":"E:\\Tools\\Python\\python.exe","args":["E:\\Projects\\report\\render.py","--format","pdf"],"cwd":"E:\\Projects\\report","timeout_seconds":7200}
```

Pass this object to `start_host_process`, save its `task_id`, then call `wait_task` with that ID and `timeout_seconds: 25`. Use `task_result` for an immediate snapshot or `control_task` with `action: "interrupt"` to stop it. A short `python --version` belongs in `run_host_command`; asking an agent to diagnose a failing renderer belongs in `run_temp`. No model is invoked by native process tools.

## State and output

All asynchronous executions use the existing `queued → running → completed/failed` lifecycle and shared retention. `kind` distinguishes `process` from `agent`; old agent records remain readable. Processes have no executor, model-access mode, thread ID or work association. Their separate `process` object contains executable/cwd, PID when spawned, timestamps, stdout/stderr, truncation, cancellation/deadline flags, and actual exit code or signal. Arguments are not stored in the registry or audit log.

`completed` requires an observed zero exit without a stop request. Nonzero/signal exits, launch failures, interruption and execution deadlines are `failed`, with distinct errors. `ready` indicates terminal execution state, not artifact correctness. `exit_code: null` may accompany a signal or an unknown outcome; it never implies success. An interrupt accepted before observed exit remains an interruption even if the program exits zero during the race. Once exit is observed, later interrupts do not change its result.

Capture retains the first 65,536 raw bytes across stdout and stderr, drains further bytes, and sets `truncated`. It is UTF-8 text, not a binary transport or ordered interleaving of both streams. Partial snapshots are published about every 500 ms; the terminal snapshot includes final captured output. Save full logs/checkpoints through the program itself when needed. Stdin is closed; interactive input and process steering are unsupported.

Up to eight native tasks, including pending starts, are admitted per Bridge instance. This is a local concurrency limit, not a machine-wide quota. `work_retention` applies to both process and agent results: by default the latest 100 terminal records, without age expiry. Active tasks are not pruned. Results survive restart until retention removes them; processes are not resumed or replayed.

## Cancellation, shutdown and security

An omitted execution timeout means no deadline; an explicit timeout accepts 1–604800 seconds and starts when the OS child spawns. A wait timeout, cancelled wait, or ending a chat leaves the task running while its Bridge owner remains alive. A cancelled start request before scheduling launches nothing; after scheduling it does not stop the task. A lost start response can therefore hide a successful launch: do not blindly replay it. Start receipts identify scheduled tasks; consult the task result for launch failure.

Interruption requests forced tree termination without waiting for the exit in the tool call. Windows uses asynchronous `taskkill /T /F`, with direct-child termination as fallback; POSIX uses a dedicated process group and `SIGKILL`. Failed termination leaves the task monitored and retries while the child is live, exposing `termination_error`; it never fabricates a terminal exit. After the direct child exits, pipe draining is bounded to 250 ms, with truncation reported if pipes stay open. POSIX also attempts group cleanup on natural parent exit. Windows tree cleanup requires a still-live parent, and detached/reparented descendants may escape on either platform. This is not a Windows Job Object or OS sandbox; programs should own and join their workers rather than daemonize.

A small Node supervisor owns each native child. Bridge STDIO close or graceful shutdown requests termination; an abrupt Bridge death closes IPC and the supervisor attempts the same cleanup. If the Bridge cannot persist the final result, reload marks a dead owner's active task failed with an unknown exit outcome, retaining its last snapshot. It never kills a PID recovered from disk, which could have been reused. Killing the supervisor itself, unkillable OS processes or power loss can prevent cleanup or final result recording. Inspect artifacts and OS process state before explicitly launching a replacement. Control requests must reach the owning Bridge; other instances can read persisted snapshots.

The existing `enabled`, `commands_enabled`, executable checks and `command_roots` cwd policy apply unchanged. Cwd must be an existing authorized directory. Arguments are passed as an array with `shell: false`, hidden windows and no implicit elevation. An explicit interpreter can still execute arbitrary code. Commands inherit the Bridge environment and current account privileges, including network access; cwd roots constrain only the starting directory. Remote authentication remains the deployment's responsibility. Optional phone maintenance exclusion covers the whole process lifetime, so phone operations remain blocked while a generic native process holds that lock. Start audit records cover scheduling and omit arguments/output; execution outcome is in task storage.

## Upgrade

Build and validate the source, wait for active agent and process work to finish, then arrange a runtime restart while preserving private configuration, registry and results. Refresh MCP metadata to discover `start_host_process`. Upgrade all Bridge writers sharing a registry before creating native process records: older binaries cannot read the new process variant. Existing agent records are accepted without rewriting their identity or history; do not roll back an old binary against a registry containing process records. A Git push alone does not update the running service.

Use `list_tasks` to recover retained process IDs if a start receipt was lost. Omit the state filter to include already-finished tasks. The listing excludes argv and output; `control_available` refers only to this Bridge instance. Inspect candidates before deciding whether another execution is needed.
