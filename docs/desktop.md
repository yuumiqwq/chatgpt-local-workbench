# Direct desktop tools

Workbench can invoke the official [agent-desktop CLI](https://github.com/vercel-labs/agent-desktop) directly from its existing STDIO MCP server. These calls do not start Codex/DSH, create conversations or change native model/thread settings. No second server, plugin or runtime Agent Skill is required: tool schemas and server instructions describe the observe, act and verify workflow.

Desktop access is disabled by default and requires both host `enabled` and `desktop.enabled`, plus a matching real OS hostname in `allowed_hosts`. Installing or updating this repository on Legion or another computer grants no desktop permission. Permissions belong to the private `<workspaces.json>.host-policy.json` loaded at startup; `reload_workspace_config` does not reload them. An administrator must review this configuration locally and arrange a restart after active work ends. Do not use host file/command tools or a full-access executor to bypass that policy change.

## Installation and policy

Install from the official npm package or matching [official release](https://github.com/vercel-labs/agent-desktop/releases). For example, `npm install --prefix E:\Tools\agent-desktop --cache E:\Caches\npm agent-desktop@1.0.2 --no-audit --no-fund` keeps the installation outside the source checkout and off C:. Review npm registry repository metadata and lockfile integrity; verify the native binary's SHA-256 against the packaged/release checksum. Keep any platform helper beside its executable. No binary or vendor artifact belongs in Git or the Workbench package. The native executable can be used directly without npm launcher/postinstall changes.

This adapter was checked against npm 1.0.2, JSON contract 2.5, using the installed binary's `version`, `<command> --help` and bundled documentation. Upstream main currently documents contract 2.6; compatible additional fields are preserved. Recheck installed help and the [JSON contract](https://github.com/vercel-labs/agent-desktop/blob/main/docs/json-output.md) before upgrading, then update the policy hash deliberately. On Windows the npm native executable is `node_modules/agent-desktop/bin/agent-desktop-win32-x64.exe` or its ARM64 counterpart. Only a real native executable is configured; no shell script, npm shim, user-supplied binary path or executable fallback is accepted.

Merge the following `desktop` object into the existing private host policy, retaining all other settings. Replace the hostname, paths and SHA-256 with locally verified values. This initial example enables semantic operations and plain-text clipboard access; screenshots and foreground/physical control remain separately configurable.

```json
{
  "desktop": {
    "enabled": true,
    "allowed_hosts": ["YOUR-ROG-HOSTNAME"],
    "executable": "E:\\Tools\\agent-desktop\\node_modules\\agent-desktop\\bin\\agent-desktop-win32-x64.exe",
    "executable_sha256": "REPLACE_WITH_VERIFIED_LOWERCASE_SHA256",
    "state_directory": "E:\\BridgePrivate\\desktop-state",
    "allow_mutations": true,
    "allow_headed": false,
    "allow_physical_input": false,
    "allow_screenshot": false,
    "clipboard": "read-write",
    "launch_apps": { "editor": "notepad.exe" },
    "max_output_bytes": 8388608
  }
}
```

Use a dedicated private state directory outside shared/export roots. `AGENT_DESKTOP_HOME` is set to it, so snapshot refmaps remain there instead of the default user profile. Workbench file tools deny reads/writes of desktop state, deny writes to the binary directory, and reject their export. Protect those locations with local account ACLs; enabled arbitrary host commands or full-access agents still have OS account authority. CLI namespaces retain private refmaps on disk; an operator can remove retired state during maintenance with all desktop calls stopped. Workbench does not enable tracing, screenshots-on-action, overlays or session recording.

`allow_mutations` gates actions, app/window controls and clipboard writes. `allow_headed` permits explicitly requested headed window/focus operations; `allow_physical_input` additionally gates physical input and headed ref actions, and requires `allow_headed`. On Windows, `type` and `right-click` are physical, while `set-value` supplies semantic text replacement. Double/triple click and focus need headed mode. `clipboard` is `disabled`, `read` or `read-write`; `allow_screenshot` separately permits window PNG capture. Command execution permission is independent: `commands_enabled` need not be enabled for desktop tools. These permissions authorize desktop access under the service account, not an application sandbox.

`launch_apps` maps caller-visible keys to reviewed launch targets. Windows requires an absolute `.exe` path or a bare system binary such as `notepad.exe`, not an application display name. No caller-provided launch arguments, environment, working directory, force switch or DevTools endpoint is available. Application startup can itself present a window, so explain the intended action before use.

The process must run in the signed-in user's interactive desktop session. Session 0, secure/UAC desktops, locked sessions and other users' sessions are not supported; elevation boundaries still apply. A hidden CLI console does not authorize application focus or physical input.

## MCP surface

All tools accept a typed `request` object. Unknown fields and commands are rejected; no raw argv/advanced shell interface is exposed. Optional mutation, clipboard, screenshot and physical-input tool groups are absent from discovery when their policy disables them. Individual calls enforce policy again.

| Tool | Operations |
| --- | --- |
| `desktop_status` | `status`, `version`, `permissions`; checks only, no permission prompt/guide. |
| `desktop_list` | `list-apps`, `list-windows`, `list-displays`, `list-surfaces`. |
| `desktop_snapshot` | Scoped accessibility tree, root drill-down, skeleton, depth, bounds, compact/interactive options. |
| `desktop_find` | Scoped role/name/text/value/description/native-ID/state search. |
| `desktop_read` | `get` text/value/title/bounds/role/states; `is` visible/enabled/checked/focused/expanded/selected. |
| `desktop_act` | click/right/double/triple click, type/set-value/select, clear, focus, toggle/check/uncheck, expand/collapse, scroll/scroll-to. |
| `desktop_window` | Allowlisted launch, graceful close, focus/resize/move/minimize/maximize/restore, open system surface. |
| `desktop_clipboard` | Plain-text get/set/clear; no file/image paths. |
| `desktop_screenshot` | One explicit window ID, native JSON with Base64 PNG; no file destination or entire-display capture. |
| `desktop_wait` | Element predicate, text/window/menu condition, or scoped lifecycle event. |
| `desktop_input` | Targeted key combination, coordinate click/move/wheel, or ref-to-ref drag; explicit headed mode only. |

Read `host_capabilities` and `desktop_status` first. Discover a window, then pass an explicit app/window or root into observations. Choose a unique task `namespace` and reuse it for all snapshot/find/read/action/ref-wait calls. Workbench passes it as `--session wb-<namespace>` without creating a trace manifest. Fully-qualified refs such as `@s8f3k2p9:e8` remain tied to that namespace. After UI changes obtain fresh refs; do not use bare `@e8` or guess targets. Surface support differs by OS and is reported by CLI status.

`desktop_act` with `command: "set-value"` uses `text` as the replacement value; `select` uses it as the option value. `desktop_wait` with `predicate: "value"` requires `value`. Snapshot/find time budgets are 100–40,000 ms; their process deadline includes 3,000 ms of cleanup headroom. Status, lists, reads, clipboard and ordinary window/input calls have a 15-second process deadline; screenshot has 30 seconds. Launch and wait use the requested bounded budget. Only one CLI operation runs at a time per Workbench process; concurrent calls return `DESKTOP_BUSY` without dispatch. The upstream CLI coordinates native interactions across processes; Workbench does not grant exclusive desktop ownership across separate clients.

## Results and validation

Tool text and `structuredContent` contain the same unmodified CLI envelope. Exit codes 1/2 can carry valid errors; Workbench preserves `error.disposition`, recovery and all other fields. A successful partial snapshot retains `data.complete=false`, truncation markers and observed nodes; narrow or extend the observation before treating a missing item as absent. `identity_unproven`, when present, also remains visible.

Observe, act once, then verify with `desktop_read` or another snapshot. `ok=true` can mean `delivered_unverified`, and even element readback does not establish application persistence. Follow recovery only when `error.disposition.retry` is `safe`; waiting cannot repair a target marked non-retryable. Bridge never retries a CLI call. Timeout, cancellation, output overflow or invalid output after mutation dispatch returns unknown delivery and unsafe retry. A transport interruption also requires observation before deciding what to do next. Held-key/button commands, force shortcuts, batches, arbitrary CLI commands and trace/file output flags are not exposed.

Requests are capped at 16 KiB UTF-8 before typed schema validation, with bounded flat fields and collections; text values allow at most 8,192 characters. This is an application request bound after transport JSON decoding, not a transport-wide frame limit. Combined stdout/stderr is bounded by policy, at most 16 MiB. Oversized output is stopped and rejected rather than parsed as a partial JSON document. Children use argument arrays with `shell:false`, hidden windows and a minimal OS/session environment without inherited provider credentials or desktop override variables. Argument values are separate literals; options are generated from fixed schemas. The executable hash is verified on every call. Audit entries contain only tool name and state, never arguments, refs, desktop output or raw stderr. Audit failure before dispatch prevents execution; final audit failure preserves the result with a warning and must not trigger replay.

Tests mock native processes, validate policy and argv, exercise JSON/error/cancellation/limit handling, and check registration through the actual MCP STDIO entry point. Version/status/permission smoke tests inspect CLI health only. Real snapshot/action/screenshot and foreground-safety acceptance require separately authorized desktop testing; passing unit tests or a ready tunnel is not that evidence. After an administrator enables policy and restarts the existing Bridge, refresh the ChatGPT connection/tool metadata and check `host_capabilities`. A Git push alone does not update existing processes.
