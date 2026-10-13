# Durable work and temporary execution

chatgpt-local-workbench separates an ongoing work from each execution performed for it. The caller chooses the work, declares completion and selects retention operations; Bridge stores and carries out those decisions without classifying natural-language goals into permanent categories.

## Choosing a work

Use `list_work` to find an existing work by project, name or summary. Project names are labels and may repeat; the stored work ID is the identity.

Workspace records identify projects through `workspace_id`, name, root and manual/managed source. They do not carry execution or host write permission. `project_root` remains the boundary used by project onboarding.

`open_work` handles creation, reopening and native-history adoption:

- Supply `work_id` to reopen the same record, including completed work.
- Supply `thread_id` to adopt a local Codex conversation discovered with `list_codex_projects` / `list_codex_threads`. Repeated adoption returns the same registered work.
- Supply `workspace_id` or an absolute `cwd`, plus `name`, to create a record. No native conversation is created yet.

`continue_work` starts a turn. The first execution creates and names a native thread. Later executions reuse its UUID and original history. Each execution gets a separate Bridge `task_id` for waiting and results. Existing archived history is unarchived when reopened.

Default access is `danger-full-access`, with no additional Codex approval prompt. It permits filesystem, Git-metadata and network operations using the current OS account. The caller can select `read-only` for an individual work or turn that must not edit files; Codex disables network in this mode. Historical work records are normalized during load. Stopping an execution does not roll back its edits.

Bridge serializes preparation inside its process and checks queued/running records visible in the shared registry. These checks do not form an atomic cross-process execution lease. Reading a conversation in another client is compatible with this flow, but simultaneous execution by another Codex client is not reliably detected; see [compatibility limits](compatibility.md).

## Temporary work

`run_temp` accepts a general instruction for any one-off use. An optional `work_id` associates the result with a work, without including or replacing that work's native history. It can inspect a repository, draft a patch, or modify project files according to its access setting.

Both `executor: "codex"` and `executor: "dsh"` accept `access: "read-only"` or `access: "danger-full-access"`. Omitting executor selects Codex, and omitting access selects full access for either executor, including calls associated with a read-only work. Supply access explicitly when the temporary run must be read-only; this per-call setting does not change the associated work's stored access.

Codex uses `thread/start` with `ephemeral: true` inside the app-server executor to avoid persisting a native rollout. It still consumes resources while running, and Bridge persists its final result separately. Durable artifacts belong in the project; include artifact paths and commits in the work's summary/references. Native validation from earlier releases is recorded in the release history and is not a guarantee for every later CLI version.

DSH uses its official one-shot headless command with `DSH_PERMISSION_MODE` set to the requested access in each child process. Its filesystem permission policy receives `read-only` or `danger-full-access`; Bridge does not depend on the parent process's permission setting. Executor-specific enforcement is described in [security behavior](security.md).

Temporary execution has no resumable UUID. Use `continue_work` for ongoing Codex context. A DSH invocation does not produce a fabricated Codex UUID and does not accept Codex-only `model` or `reasoning_effort` options; DSH's own local runtime data is outside native Codex history retention.

Editing, validation and Git operations use `continue_work` or `run_temp`. A read-only temporary turn can still return a proposed diff as text. Retired private sidecars remain historical files and are not loaded as current tasks.

## Waiting and completion

`wait_task` waits up to 300 seconds per call by default. A timeout returns current status; when `ready=false`, the caller should issue another wait. The maximum wait is configurable and remains independent from executor timeouts. Cancelling a wait leaves the execution running. These mechanics do not guarantee that ChatGPT itself will continue making calls after ending its response.

`control_task` offers `steer` and `interrupt`. Successful new executions directly become `completed` and expose `output`. `task_result` reads retained executions in the work registry.

Execution completion and goal completion are different facts. `finish_work` records the caller's completion decision with a summary and references. `open_work` can subsequently reopen it.

## Persistence and retention

The work registry is `<workspace-config>.work-items.json`. Final run results are separate files in `<workspace-config>.work-items.json.results`. These private state paths should be outside the source checkout.

Work records, summaries and native UUIDs survive restart. A previously running execution becomes interrupted/unmonitored after restart; Bridge does not claim that a process resumed automatically. Inspect outstanding file changes and other clients before continuing.

`manage_work` provides the following operations:

| Action | Effect |
| --- | --- |
| `archive` | Archive native history and hide it from the normal Codex list; retain the work record. |
| `unarchive` | Restore native history to the normal list. |
| `delete_history` | Call native `thread/delete`, deleting that thread **and its spawned descendants**. Retain the work summary, references and previous UUIDs. |
| `forget` | Remove the work registry record only. Native history and retained results remain. |

After history deletion, the next execution creates a new UUID and receives the retained summary/references. It does not recreate the deleted conversation history. When adoption or native history operations fail, the error is reported rather than claiming success.

`work_retention` reads or changes settings and can sweep immediately. An hourly sweep runs while Bridge is running. All age-based native archive/delete rules default to disabled; there is no assumed 30-day deletion policy.

| Setting | Default | Effect |
| --- | --- | --- |
| `max_results` | 100 | Retain at most this many terminal run results. |
| `result_days` | null | Optional age limit for terminal run results. |
| `archive_completed_days` | null | Archive caller-completed work after inactivity. |
| `delete_archived_days` | null | Delete registered archived history after inactivity. |

Use null to disable an age rule. Changing result limits prunes matching results immediately. Native history policies operate only on records currently in this registry, without an immutable purpose restriction. The sweep skips work currently executing in this Bridge. Project artifacts and summaries are unaffected by result pruning. Existing unregistered conversations are not selected automatically.

## Moving an installation

Move the effective configuration and its sidecar state together with the built source. Update project roots, tunnel launchers, Codex's local MCP configuration and scheduled startup actions. Preserve the current tunnel identity and credentials.

Moving workspace directories does not move the Codex profile. Native history indexes contain original paths. Windows directory junctions can preserve these paths, but **sessions and archived_sessions must resolve to the same physical volume**: the native archive operation uses rename and fails across drives. Migrating selected date folders alone is therefore unsuitable.

Move both history trees together after all Codex writers exit, verify every file and preserve their original paths through junctions. With `follow_links: false`, Bridge resolves only the exact top-level `sessions` and `archived_sessions` links for native history discovery; nested history links and host file operations through links remain denied. Do not replace a live history folder with a stale copied snapshot. Authentication and the live profile database need not move with workspace files.

After replacing public tools, refresh Engineering Bridge in ChatGPT's app/developer connection settings. Existing conversations can retain stale tool metadata; a fresh conversation after refresh loads the new surface. This is distinct from restarting the local runtime.

Official protocol references: [app-server](https://learn.chatgpt.com/docs/app-server), [refreshing ChatGPT metadata](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata).
