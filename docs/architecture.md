# Architecture

chatgpt-local-workbench exposes a local STDIO MCP server. ChatGPT or another MCP client owns the conversational workflow; remote transport and authentication are supplied by the deployment, outside this repository.

The MCP entry point builds a workspace registry, host policy and WorkService. The workspace registry stores project identity, root and manual/managed source only. `project_root` entries define where onboarding may register projects; they do not grant write access. Managed workspace catalog v2 stores only stable IDs and roots. Loading v1 migrates it atomically without changing either value.

WorkService stores work identity, native UUID, semantic completion, selected access and run metadata in a private sidecar; full bounded results live in its adjacent .results directory. Atomic merge writes serialize short registry updates across Bridge processes.

open_work creates or adopts a record without executing a model. continue_work creates the first native Codex thread lazily and subsequently resumes its UUID. run_temp selects Codex native ephemeral thread/start or DSH one-shot headless execution; neither returns a resumable native UUID. Execution control is routed to the live executor according to its supported operations.

The Codex executor communicates with codex app-server through JSONL RPC. Read-only and full access are passed to both thread and turn configuration. The DSH executor runs the official headless command and sets DSH_PERMISSION_MODE per invocation from the same access selection. WorkService defaults run_temp to danger-full-access for either executor, records the selected access and forwards it to the selected executor without a DSH-specific override. See [security behavior](security.md) for executor-specific enforcement.

Write authority has two independent layers. Model execution uses the `access` selected by `open_work`, `continue_work` or `run_temp`. Bridge-owned file and command tools use `read_roots`, `write_roots`, `command_roots` and related settings from the host policy. Workspace metadata participates only in project selection.

Public result and waiting interfaces read only WorkService. DSH has no fabricated native Codex history, and Codex-only model and reasoning_effort inputs remain unsupported for DSH.

Registry state and native history have different lifetimes. Completing a run does not finish a work, forgetting a work does not remove native history, and deleting native history keeps summary/reference records. See [work management](work-management.md) for the transitions and migration constraints.

## Source map

| Module | Responsibility |
| --- | --- |
| `src/mcp-stdio.ts`, `src/work-tools.ts`, `src/task-result-tools.ts` | MCP schemas, startup/configuration and caller-facing result conversion. |
| `src/tasks/` | Work identity/lifecycle, execution ownership, private registry writes and result retention. |
| `src/executors/` | Codex/DSH protocols, process discovery, deadlines and termination. |
| `src/workspaces/` | Project identity, managed registration and bounded Git initialization. |
| `src/host/` | File/command policy, direct operations and native Codex history discovery. |
| `src/core/`, `src/version.ts` | IDs, safe error serialization and package-derived version. |

There is no plugin loader for arbitrary executor types; adding one requires an adapter implementing `Executor`, factory routing and public schema changes with tests. Existing CLI-based host commands remain an independent path. Persistence and concurrency limits are listed in [compatibility](compatibility.md).
