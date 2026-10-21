# Release notes

## Unreleased

- Add `phone_sequence` for caller-supplied short input sequences, automatic IME readiness waiting, optional final settling, and one final observation. Preserve the shared control lock and durable receipts, report step timings and partial progress, and stop on failure or condition timeout without replaying actions.
- Recover a transient IME connection change after an in-sequence tap only while text remains undispatched, within the original readiness budget. Keep the ready path free of additional polling and preserve pending/unknown outcomes without replay.

- Reduce phone observation latency by bundling ordered display/IME queries in one ADB process, reading the display section of window state, and overlapping PNG encoding with the final context query. Keep PNG quality, context consistency checks and serialized device access. Remove shopping-specific guidance from MCP tool descriptions.
- Add `dist/src/phone/mcp-stdio.js PHONE_CONFIG_JSON` for local Codex/SSH sessions. It exposes the same nine phone tools and shared lease without a tunnel or the host task surface.

- Add opt-in `observation:context` and `phone_observe(ui:false,image:false)` for short, predetermined input sequences. Intermediate actions return current application/window and IME readiness without screenshots, UI dumps or a fixed settling delay; callers use already observed targets and inspect a final UI/image observation. Return server action/observation timing.

- Remove all phone input pixel/region comparisons and UI subtree/page-anchor comparisons. Coordinate actions no longer capture a pre-action screenshot; semantic clicks use the referenced observation’s coordinates. Text checks the active input connection. Preserve device context, coordinate bounds, short leases, pause and durable request deduplication.

- Prepare the installed Workbench IME when acquiring phone control with local text input enabled. Report readiness without blocking non-text operations if preparation fails, and reselect the IME on the next acquisition after a manual keyboard change.
- Avoid foreground clickable overlays when scrolling Android lists by moving the touch path into an exposed part of the container. Return `PHONE_SCROLL_AREA_OCCLUDED` before dispatch if no usable area remains, and report observed content movement separately from the driver's end-of-list boolean.
- Add bounded variation to ordinary Android scroll duration and native scroll distance without additional pauses. Default post-action observations to accessible controls/text, with automatic PNG fallback for sparse, unavailable or undescribed visual content; callers can explicitly select UI or image responses.
- Fix ordinary scrolling in nested Android lists by selecting the innermost enclosing scrollable and dispatching Appium's `mobile: scrollGesture`. Preserve pointer gestures when the UI exposes no unique target, return the driver's `can_scroll_more` feedback, and never retry a dispatched gesture. Coordinate taps and drag gestures retain their existing timing and path behavior.
- Poll waiting tasks every 500 ms instead of 100 ms to reduce repeated registry reads, while respecting the remaining timeout and cancellation signal.
- Coordinate managed workspace registration and legacy migration across Bridge processes with a shared file lock. Preserve existing IDs and other processes' records, reusing the work registry's atomic JSON writer and removing the redundant catalog write queue.
- Persist successful native unarchive transitions before session lookup, so overlapping status queries or a failed lookup cannot restore an obsolete archived flag.
- Upgrade the MCP SDK to `^1.32.1` and refresh affected transitive dependencies to patched compatible versions. Preserve existing tool interfaces and permission settings.
- Correct native-management failure messages that previously described archive/unarchive/delete requests as thread-list requests.
- Read file pages without computing a full-file SHA-256 by default. Callers preparing a replacement, move or deletion can request `include_sha256: true`; refresh client tool metadata after deployment.
- Preserve complete UTF-8 characters and byte offsets across file pages, including Chinese, emoji and byte order marks. Base64 reads retain exact byte pagination.
- Raise the default executor turn deadline to 60 minutes. Codex now uses a five-minute ordinary protocol-inactivity watchdog and a 15-minute command-in-progress inactivity watchdog, with environment overrides for both and for the 30-second RPC deadline.
- Distinguish total-deadline, RPC-timeout and failed-turn outcomes as `EXECUTION_DEADLINE_EXCEEDED`, `CODEX_RPC_TIMEOUT` and `CODEX_TURN_FAILED`; retain the existing safe server-overloaded message and RPC rejection metadata.
- Allow `wait_task` long-polls up to 300 seconds by default without extending executor liveness, and expose live `last_activity_at`, `active_item` and `elapsed_seconds` diagnostics while a task is running.
- Report explicit Codex active-writer conflicts as `CODEX_THREAD_BUSY`; other valid JSON-RPC errors use `CODEX_RPC_ERROR`, including unrelated `-32600` errors. Keep malformed or unexpected protocol responses under `CODEX_PROTOCOL_ERROR`; unanswered RPC deadlines now use `CODEX_RPC_TIMEOUT`, ordinary failed turns use `CODEX_TURN_FAILED`, and total turn deadlines use `EXECUTION_DEADLINE_EXCEEDED`.
- Preserve bounded, allowlisted `rpc_method`, numeric `rpc_error_code` and `rpc_error_category` through executor failure, steering and stored result/registry reads. Expose fixed safe messages without retaining raw server messages, error data or stderr. Existing records without these optional fields remain readable.
- Preserve successful execution, permission settings and thread lifecycle; add regression coverage for classification, malformed responses, secret filtering and persistence. No automatic retry, writer coordination or thread replacement is introduced.

## 1.7.0-local.3

This maintenance release presents the project as `chatgpt-with-codex`, a personal ChatGPT chat interface to local agents and computer tasks. Package/executable names, MCP identifiers, access defaults and persisted data migrations remain compatible with existing installations.

- Prevent explicitly unrelated Codex thread/turn items from replacing the current output or evidence, and retain completed agent text when an unfinished message is interrupted.
- Preserve DSH interruption/failure status while cleaning up descendants after direct-child exit.
- Record `WORK_RESULT_WRITE_FAILED` when execution ends but result persistence fails, preventing a permanently running task; clean up staging files after failed atomic writes.
- Accept child project directories when the configured onboarding boundary is a filesystem root, using the existing canonical path containment check.
- Remove unused imports and redundant registry fields/validation, enable unused-code checks, and cover Windows/Linux with Node 22/24 in CI.
- Update the locked Hono dependency from 4.12.34 to 4.13.7. Keep the existing direct dependency ranges and executor interfaces.
- Rewrite the Chinese/English READMEs and deployment documentation, add compatibility notes, and give security policy and threat-model documents separate purposes.

Regression coverage first reproduced five failures against the previous implementation, then passed with the fixes. Validation uses the unit/MCP transport suite without restarting a running Bridge/Codex deployment or performing a live model turn.

Local validation on Windows with Node 24.19.0: typecheck and build pass; 215 tests, 214 passing and one POSIX-only test skipped. The package dry run and current-document link checks pass, and `npm audit` reports zero known vulnerabilities for the installed dependency tree.

## 1.7.0-local.2

- Give Codex and DSH the same `run_temp` access choices: `read-only` and `danger-full-access`, with full access the default for both. Preserve the selected access in run metadata and results.
- Pass DSH access through its existing per-process `DSH_PERMISSION_MODE` integration, overriding inherited permission settings for each invocation. Retain DSH's one-shot headless lifecycle and reject Codex-only model options.
- Keep Codex native sandbox behavior and durable-history semantics unchanged. Current permission boundaries are documented in [security behavior](SECURITY.md) and [work management](docs/work-management.md).
- Make workspace records identity-only across manual configuration, runtime discovery, onboarding results and managed persistence. Execution write access remains a per-work setting, and host operations remain governed by the separate host policy.
- Migrate manual configuration and managed catalog v1 records once while preserving every valid workspace ID, root and project-root boundary. New managed catalogs use schema version 2.
- Remove the remaining unused workspace authorization methods and error codes, and refresh current documentation.
- Allow durable Codex continuation to resolve the two top-level native history links under a configured Codex home. Links inside those history trees and all links used through host file tools remain rejected when `follow_links` is false.

Validation on Windows: typecheck and build pass. The full suite has 211 tests: 210 pass and one platform-specific test is skipped. Release metadata and a real MCP smoke expose 24 tools, accept only `read-only` and `danger-full-access`, preserve six workspace identities, and complete a native temporary execution.

Native DSH 0.1.2-rc.1 checks without a model session verified read-only filesystem denial inside/outside the workspace and command-write denial through the Windows runner, plus successful full-access writes. The native Windows provider reports partial enforcement, and DSH read-only does not disable network; see [security behavior](SECURITY.md) for scope and sources.

The versioned entries below describe their historical releases. Earlier DSH read-only restrictions and retired APIs are not the current interface; see [compatibility](docs/compatibility.md) and [current tools](docs/tools.md).

## 1.7.0-local.1

- Remove the remaining six patch/write-authorization tools and the patch, validation and supervisor engines, leaving 24 host-enabled tools.
- Keep full access as default and read-only as the only optional restriction. Normalize old workspace-write work settings while preserving historical run evidence.
- Replace obsolete top-level documentation with the current workflow. Persisted legacy proposal files are historical data and no longer loaded as runtime tasks.

## 1.6.0-local.1

- Unify create/adopt/reopen and same-UUID continuation; persist summaries, results and restart interruption state.
- Use native ephemeral Codex execution for one-off instructions; remove overlapping run/resume/generate/refine tools.
- Provide caller-managed archive, history deletion and retention without purpose categories or literal confirmation parameters.
- Default work to full account access, including Git metadata; retain selectable restricted access.
- Support junction history layouts and explicitly disable inherited MCP entries for subprocess execution.
- Preserve optional controlled-patch data and validation/apply/commit operations.


## v1.5.0-local.3

Add project-first native conversation browsing. `list_codex_projects` groups a
bounded page by original cwd, supports project-name/path matching and provides
exact arguments for the existing per-project thread list. Counts are explicitly
page-local, same-name directories remain distinct, and older projects remain
reachable through the native cursor.

## v1.5.0-local.2

Discover local Codex conversations by title or project without manually supplying
UUIDs. The native metadata-only catalog supports bounded previews, pagination and
archived histories. Native resume now defaults to workspace-write within the
original authorized cwd, with an explicit read-only option; continued turns keep
the selected access. Writes happen during execution, before supervisor acceptance.
Ordinary run_task and controlled-patch generation remain read-only.

## v1.5.0-local.1

Local fork release: cancellable task waiting, optional administrator-configured
host file operations, validated workspace configuration reload, and native
Codex continuation. Ordinary and resumed model tasks remain read-only. Host
commands are separately enabled and run with current OS account privileges.
See [host operations](docs/host-operations.md) for configuration and limits.

## v1.4.2

v1.4.2 is a correctness release for controlled initial commits in fresh Git repositories with no existing commit.

### Fixed

- Support controlled `COMMIT` for an applied proposal in a fresh/unborn Git repository, creating a root commit from exactly the proposal targets.
- Preserve proposal-target-only staging and leave unrelated untracked recovery anchors unchanged, untracked, and unstaged.
- Before creating the root commit, recheck the unborn state and expected branch ref so concurrent HEAD or ref creation is rejected.
- After creating the root commit, verify that it has no parent, contains exactly the proposal paths, and leaves the index and tracked worktree clean.
- If post-commit verification fails, report the failure without resetting, amending, or otherwise rewriting the commit that was already created.

### Compatibility

- Controlled `COMMIT` for repositories with a normal existing `HEAD` keeps the v1.4.1 semantics and safety boundaries unchanged.

## v1.4.1

v1.4.1 is an emergency correctness release for Windows-authored workspace configuration, active Codex turn liveness, and controlled-commit recovery safety.

### Fixed

- Accept a workspace configuration whose first character is one UTF-8 BOM (`U+FEFF`) while preserving strict JSON parsing; a second BOM and all other malformed JSON remain rejected.
- Reset the Codex inactivity watchdog on any app-server notification only when both `threadId` and `turnId` exactly match the active turn. Other threads, other turns, global notifications, and RPC responses cannot keep the turn alive.
- Preserve stable unrelated untracked recovery anchors during controlled `COMMIT`, stage and commit only exact proposal targets, reject pre-existing staged or unrelated tracked dirt, and leave history advanced rather than rewriting it if post-commit recovery-anchor verification fails.

### Windows operation notes

- A foreground `tunnel-client run` belongs to its PowerShell process; closing that PowerShell window terminates the foreground tunnel.
- Installing Codex Desktop does not guarantee that the `codex` CLI exists on the `PATH` inherited by the process that starts Bridge.
- Workspace registration controls which roots MCP callers may select. It is separate from filesystem read isolation: Bridge's read-only executor settings restrict writes but do not create an OS-level read sandbox.

## v1.4.0

v1.4.0 closes the supervised controlled-write loop while keeping publication outside Bridge.

### Added

- Add optional controlled-patch validation through `configure_validation_profile` and `validate_controlled_patch`. Validation runs only when explicitly requested, uses a fixed per-workspace profile in a temporary detached worktree, and reports `PASS`, `FAIL`, or `INCOMPLETE`; it does not authorize or imply `APPLY`.
- Add `commit_controlled_patch` as a separate exact `COMMIT` gate for an already-`APPLY`ed controlled patch. It creates one Git commit containing only that applied patch and never pushes.

### Release boundary

- The local STDIO MCP surface is now 13 tools.
- `APPLY` remains the explicit filesystem-mutation gate; `COMMIT` is a separate Git-history gate. Neither gate implies push or Release creation.
- Fresh-chat catalog verification confirmed all 13 tools, and a disposable controlled-COMMIT E2E confirmed that `APPLY` leaves HEAD unchanged and `COMMIT` alone advances HEAD while leaving the worktree clean.

## v1.3.0

v1.3.0 has been published as a Git tag and GitHub Release. This does not indicate npm publication.

### Added

- Add `submit_controlled_patch` for registering a caller-provided complete unified Git diff against the exact current `base_head`. Submission runs the shared read-only preflight, records `source: "submitted"` without an executor identity, survives restart, and still requires human review, write authorization, and exact `APPLY`.
- Let `generate_controlled_patch` and `refine_controlled_patch` select Codex or DSH per call (default Codex), while keeping application deterministic and model-free. Refinement does not inherit the source proposal's executor.
- Add optional Codex-only `model` and `reasoning_effort` inputs to `run_task`, `generate_controlled_patch`, and `refine_controlled_patch`; requested values are checked against Codex `model/list`. DSH rejects these options.
- Allow running generated or refined proposal tasks to be interrupted through `control_task`; interrupted tasks finish with `TASK_INTERRUPTED`.

### Fixed

- Bound executor termination across normal completion, interruption, direct-child exit, inherited open pipes, hard deadlines, and live Windows process trees so tasks settle without leaving the one-shot executor process tree running.
- Preserve the beginning and true end of oversized DSH stdout, including interrupted output, within the existing 1 MiB bound.
- Harden controlled-patch application recovery, serialize concurrent applications per workspace, and persist final applied metadata before releasing the retained task.
- Bound controlled-patch and onboarding Git subprocesses, preserve supported public error classifications, and finalize tasks when terminal-result handlers fail.

### Reliability / Performance

- Bound short Codex JSON-RPC calls to 30 seconds independently of the 15-minute executor deadline; active Codex turns also fail after two minutes without matching protocol activity.
- Restore retained controlled-patch tasks in one validated batch, eliminating repeated global terminal-retention scans while preserving task order and provenance.

The v1.2.1 Windows validation boundary is unchanged; full multi-client / all-Windows certification is not claimed.

## v1.2.1

v1.2.1 is a Windows launch-compatibility patch for both executors. The DSH executor itself was added in v1.2.0; v1.2.1 does not add an executor, it fixes how npm-installed Codex and DSH CLIs are resolved and launched on Windows.

### Windows CLI compatibility

- Fix Windows command resolution for npm-installed Codex and DSH CLIs.
- Standard Windows npm installs expose:

  ```
  codex.cmd
  dsh.cmd
  ```

- Bridge now resolves those npm shims to their official Node entrypoints:

  ```
  @openai/codex/bin/codex.js
  @deepseek-ai/dsh/lib/bin.js
  ```

- The launch path uses `process.execPath` + the JS entrypoint.
- A real `codex.exe` / `dsh.exe` remains directly supported and preferred.

### Safety

- No `cmd.exe` / `ComSpec` runtime path.
- No `shell: true`.
- The Codex instruction still travels through JSON-RPC stdin.
- The DSH instruction remains a single argv argument.
- Unresolved shim targets fail closed through the existing shell-free fallback chain.

### Verification

Validated on a real GitHub Actions `windows-latest` runner with Node 22 and actual npm-installed `@openai/codex` and `@deepseek-ai/dsh` packages.

Windows smoke confirmed:

- real `codex.cmd` and `dsh.cmd` layouts
- resolver discovery
- both official Node launchers start successfully
- focused executor tests pass

Windows compatibility improved and this specific npm CLI path is now verified; full multi-client / all-Windows-environment certification is not claimed.

## v1.2.0

v1.2.0 keeps the Codex behavior of v1.1.0 (including its default selection) and adds a second executor, managed workspace onboarding, restart persistence for controlled patches, and more honest task reporting.

### Executors

- `run_task` accepts an optional `executor: "codex" | "dsh"`; omitting it still defaults to `codex`, so existing calls are unchanged.
- DSH runs through the official headless interface, pinned to read-only per process (`DSH_PERMISSION_MODE=read-only`); the bridge forwards only an explicit environment allowlist, including `DEEPSEEK_API_KEY` and `DSH_TOOLS_MODE`, and never forwards proxy variables.
- DSH returns a legitimate empty output for a successful run with no agent text, and an interrupted DSH task keeps its real partial stdout as `partial_output`.

### Workspace onboarding and write authorization

- New `project_root` configuration entries define approved root directories.
- `bind_project` registers an existing directory inside a `project_root` after exact `BIND` confirmation.
- `create_project` creates and git-initializes a new directory inside a `project_root` after exact `CREATE` confirmation (the repository is left unborn; no commit is made).
- Managed workspaces are registered read-only by default. `authorize_workspace_write` grants controlled-write permission to a managed workspace only, after exact `AUTHORIZE` confirmation.
- Manual workspaces from `workspaces.json` remain authoritative for their own `allow_write`; `AUTHORIZE` never modifies a manual entry.

### Controlled patches

- `generate_controlled_patch` and `refine_controlled_patch` are read-only proposals and work in any registered workspace; no write authorization is needed to generate or refine.
- Write authorization (managed `AUTHORIZE` or a manual `allow_write: true` entry) is required only at `apply_controlled_patch` with exact `APPLY`.
- Controlled-patch proposals and applied history now survive a bridge restart; invalid retained records are quarantined safely instead of blocking startup.
- Unborn repositories (for example, fresh `create_project` workspaces) are supported: proposals may add ordinary 100644 text files. The bridge still never stages, commits, or pushes.

### Honest task reporting

- `task_result` reports the fixed `executor` and, for Codex tasks, the real native app-server thread id. DSH has no machine-resumable headless session, so it never gets a fabricated thread id; a DSH `continue` starts a new execution.
- `partial_output` appears only when a genuine interrupt produced real partial output; the task still ends `failed`, and ordinary failures never re-expose stderr or partial stdout.
- Codex evidence truncation is now visible: oversized strings are marked `[truncated]`, oversized change lists report how many changes were omitted, and evidence evicted by the count limit is reported through a synthetic drop item. Bounds are unchanged; the markers only say the diagnostic information is incomplete.

### Not changed

- The Codex default path, controlled-`APPLY` validation, and safety checks from v1.1.0 are unchanged; the bridge still never automatically tests, stages, commits, pushes, or releases.

## v1.1.0

v1.1.0 adds `refine_controlled_patch` for refining an existing completed controlled-patch proposal into a new complete proposal against the same `base_head`, preserving the source proposal and still requiring explicit `APPLY` before workspace modification.

## v1.0.0

controlled APPLY now accepts valid Codex-generated patches with Markdown fence context, stale hunk counts, and zero-context hunks, while retaining existing workspace, target, and explicit APPLY safeguards.

## v1.0.0-rc.2

Failed Codex turns with `codexErrorInfo=serverOverloaded` are surfaced as a clear model-capacity failure instead of only the generic `CODEX_EXECUTION_FAILED` message. Raw upstream error details remain hidden.

## 1.0.0 stable

This stable V1 release exposes five STDIO MCP tools: `run_task`, `task_result`, `control_task`, `generate_controlled_patch`, and `apply_controlled_patch`. Ordinary `run_task` execution is always read-only. Successful interactive turns enter `waiting_for_supervisor_review`; `task_result` exposes state/readiness, bounded evidence, and `review_output` before acceptance, then final `output` or `error` after finalization. `control_task` is restricted to interactive `run_task` task IDs and state-checks `continue`, `steer`, `interrupt`, and `accept`. Continue preserves native Codex thread continuity; interrupt is available only while an interactive task is running and finalizes it as failed.

Controlled patch generation remains on the legacy proposal-task path. Poll its returned patch task ID through `task_result` until `state=completed`, when the unified diff is returned as `output`. Proposal tasks do not enter `waiting_for_supervisor_review`, do not expose `review_output`, and cannot be accepted through `control_task`. Human review occurs outside task state; an acceptable completed diff is passed directly to `apply_controlled_patch` with that `patch_task_id` and exact `APPLY`.

The Codex backend uses `codex app-server --stdio` without a shell, with approval `never` and network disabled. Ordinary/supervisor tasks and proposal generation stay read-only; exact reviewed `APPLY` is the filesystem write path. Bridge does not automatically test, stage, commit, or push. State is process-local with no restart recovery or automatic timeout; explicit interruption exists only for running interactive tasks. Alpha.4 project binding is not implemented, so `workspace_id` remains required.

This is the stable V1 / 1.0.0 release. It does not indicate npm publication.

## v0.2.0-alpha.3 release candidate

This release candidate reduces the public STDIO MCP interface to four tools: `run_task`, `task_result`, `generate_controlled_patch`, and `apply_controlled_patch`. `task_result` is now the single polling tool and reports active tasks with `ready: false`, completed output, or a fixed safe error. Serialized errors contain exactly `code` and `message` while preserving the existing error codes and non-leakage behavior.

Controlled patches may continue to modify existing tracked regular text files and may now add an ordinary text file when the diff uses exact `new file mode 100644` and matching `/dev/null` headers, contains a text hunk, and targets a safe path absent from base HEAD, the current index, and the worktree. Deletions and other unsafe patch forms remain rejected. Documentation has been reduced and aligned with this interface and behavior.

This is a release candidate description only. It does not assert that a v0.2.0-alpha.3 tag, GitHub Release, or npm publication exists.

## v0.2.0-alpha.2

Engineering Bridge v0.2.0-alpha.2 adds opt-in controlled writes while keeping every workspace read-only by default. A write-enabled clean Git workspace can generate a patch proposal without changing files; application requires human review and confirmation exactly equal to `APPLY`. Bridge rechecks repository state and patch targets before applying, and never automatically tests, stages, commits, or pushes.

This release also compares canonical real paths during controlled-write Git-root validation, so macOS aliases such as `/tmp` and `/private/tmp` no longer cause the same directory to be rejected. The English and Chinese READMEs explain client compatibility, component roles, a generic STDIO MCP configuration, a reproducible first read-only run, and the complete controlled-write flow. The architecture, security, threat-model, and tool-reference documents are aligned with the current implementation.

Current limits remain: no cancellation or timeout, no persistence across restart, no caller authentication or remote service, and no OS-level read containment for ordinary read-only tasks. Every proposal still requires human review.

This version has been published as a Git tag and GitHub Release.
