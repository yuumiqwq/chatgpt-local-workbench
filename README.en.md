# chatgpt-with-codex

This repository serves a personal workflow: use ChatGPT's chat mode to freely operate your own computer and call different agents as subagents, while communicating only with chat to get things done. A local MCP service sends instructions to local executors and returns progress, results and resumable work records to ChatGPT.

Codex and DeepSeek Harness (DSH) are the built-in executors. Other agents can be invoked through their CLIs when host commands are enabled, but do not automatically gain the durable conversation interface. Desktop GUI automation requires separate tools.

[中文](README.md) · [Tool reference](docs/tools.md) · [Deployment](docs/host-operations.md) · [Security](SECURITY.md)

## How it works

ChatGPT interprets the request, selects tools and decides when the goal is complete. The local Bridge executes operations and stores work metadata. Codex uses `app-server` JSONL RPC; DSH uses its one-shot `headless` interface. Host tools can also operate on files or run commands directly.

| Capability | Implementation |
| --- | --- |
| Ongoing work | `open_work` creates or adopts work; `continue_work` reuses its native Codex UUID and history. Work IDs and summaries survive Bridge restarts. |
| Temporary agent calls | `run_temp` selects Codex or DSH and saves a separate result. Codex temporary runs do not persist native conversations. |
| Project and history discovery | Search registered workspaces and browse project/thread metadata in configured Codex homes. |
| Computer tasks | Executors can edit files and use Git or network commands. Optional host tools provide direct file and command operations. |
| Execution control | `wait_task` reports progress; `control_task` interrupts execution or steers a running Codex turn. |
| Completion and retention | `finish_work` records the caller's completion decision. Archive/history deletion is caller-controlled; defaults retain 100 terminal results with no age-based history deletion. |

Workspace records identify projects. `project_root` bounds project registration, while executor access and host tool permissions are configured separately.

## Install and connect

Install Node.js 22 or newer, Git and the executor CLI you intend to use. Configure and authenticate the executor under the account running Bridge. Transport adapters, tunnels and remote authentication services are separate deployments.

```sh
git clone https://github.com/yuumiqwq/chatgpt-with-codex.git
cd chatgpt-with-codex
npm ci
npm run build
```

Create a private `workspaces.json` outside the checkout, based on [the example](config/workspaces.example.json). Use existing absolute project paths in the host platform's normalized format, without redundant separators or trailing slashes. On Windows:

```json
[
  { "id": "my-project", "root": "E:\\Projects\\my-project" },
  { "kind": "project_root", "root": "E:\\Projects" }
]
```

To browse and resume native Codex history, enable `workspaces.json.host-policy.json` beside that file, set `read_roots` to include the project directories, and set `codex_homes` to your actual history profiles. Host file writes and host commands have separate settings. See [deployment configuration](docs/host-operations.md). Without a host policy these optional capabilities are disabled; registered workspaces remain usable for temporary execution.

Configure an MCP client or tunnel runner to start the STDIO service with absolute paths:

```sh
node /absolute/path/to/chatgpt-with-codex/dist/src/mcp-stdio.js /absolute/path/to/workspaces.json
```

The process waits for MCP requests on standard input/output; it has no interactive terminal UI. `npm run mcp:stdio -- /absolute/path/to/workspaces.json` runs the same entry point.

ChatGPT can reach this STDIO service through Secure MCP Tunnel, or through a separately deployed HTTPS MCP gateway. This repository does not listen on an HTTP port. In ChatGPT's plugin connections, select the configured tunnel or enter the gateway's MCP URL, inspect the discovered tools, and enable the connection in a new chat. Consult [OpenAI's connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt) for the current UI and account availability.

## Typical workflow

Start with `list_workspaces` and use an actual returned `workspace_id`. Resolve duplicate project names by full path. To adopt an existing Codex conversation, find its UUID through `list_codex_projects` and `list_codex_threads`, then call `open_work`.

| Task | Tool flow |
| --- | --- |
| Continue an ongoing matter | Find it with `list_work`, open it with `open_work`, execute `continue_work`, then repeat `wait_task` until `ready=true`. |
| One-off inspection or editing | Call `run_temp` with a project, instruction and executor. Use `access: "read-only"` explicitly for read-only inspection. Wait using the returned `task_id`. |
| Record completion | Verify the result and artifacts, then call `finish_work` with a summary and references such as file paths or commits. Work can be reopened later. |
| Direct file operations | Inspect `host_capabilities` and read pages normally; request `include_sha256: true` in `read_host_file` once when preparing a replacement, move or deletion. |

Each `wait_task` call waits at most 300 seconds by default; call it again when `ready=false`. The maximum is configurable without affecting executor liveness. A completed execution does not establish that the goal succeeded. Interruption, timeout and the chat ending do not undo file changes. See [work management](docs/work-management.md) for state and retention details.

## Permissions and boundaries

New work and `run_temp` default to `danger-full-access`, using the current OS account's file, Git and network privileges without an additional Bridge execution approval step. `continue_work` inherits the stored work access and saves explicit overrides for later turns. Temporary runs select access independently: associating a read-only work does not change the full-access default of `run_temp`.

Codex `read-only` selects its native read-only policy with network disabled. DSH receives the same access name through its native permission policy, with different network and platform enforcement. Host file tools use configured path roots and digest checks; a host command's `cwd` constrains only its starting directory. These file policies do not contain a separate full-access executor.

This is a direct-execution service for trusted personal use. Access to its tools grants capabilities of the local account. The tunnel or gateway supplies remote authentication, and Bridge does not isolate multiple users. Read the [security policy](SECURITY.md) and [threat model](docs/threat-model.md) before connecting it.

## Interfaces and maintenance

The MCP entry point exposes 24 tools when host operations are enabled, 27 with separately authorized `export_roots`, and 14 when host operations are disabled. `export_host_file` returns metadata and an MCP resource link for verified binary transfer and delivery through the client's native chat attachments. See [file delivery and client limitations](docs/file-exports.md), the [tool reference](docs/tools.md), [architecture](docs/architecture.md) and [deployment settings](docs/host-operations.md).

Run these checks after changes. Tests build the project and use temporary fixtures or simulated executors without paid model calls; the separate build verifies the final output independently.

```sh
npm run typecheck
npm test
npm run build
npm pack --dry-run --ignore-scripts
npm audit
```

Pushing source does not deploy a local service. Build an update and arrange its restart after active work has finished; refresh ChatGPT metadata when the tool surface changes. Keep private configuration and state outside the checkout and preserve them during upgrades. See [contributing](CONTRIBUTING.md) and [compatibility](docs/compatibility.md) for development and concurrency limitations.

The repository is named `chatgpt-with-codex`. The npm package, executable, MCP identity and `ENGINEERING_BRIDGE_*` environment variables retain their existing names for installation compatibility. The project derives from [wudy29/engineering-bridge](https://github.com/wudy29/engineering-bridge) and retains its copyright notice under the [MIT license](LICENSE).
