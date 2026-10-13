# Deployment and host operations

Run the built STDIO entry point with one workspace configuration path. The MCP client or tunnel runner owns the process lifetime; Bridge has no bundled HTTP listener, login UI or service installer. Keep the configuration directory writable by that account and outside the source checkout.

## Files and startup

For a configuration named `workspaces.json`, Bridge uses these adjacent paths:

| Path | Purpose |
| --- | --- |
| `workspaces.json` | Manual project IDs/roots and optional `project_root` onboarding boundaries. |
| `workspaces.json.managed-workspaces.json` | Automatically registered project IDs and roots. |
| `workspaces.json.host-policy.json` | Optional host capabilities and native history discovery policy. |
| `workspaces.json.work-items.json` | Durable work metadata, run status and retention settings. |
| `workspaces.json.work-items.json.results/` | Retained execution outputs and diagnostics. |
| `workspaces.json.host-policy.json.audit.jsonl` | Host operation names, paths and status, with one rotated `.previous` file. |

A generic STDIO MCP client configuration is shown below. Replace the command and both arguments with real absolute paths; use the client's own environment configuration if its syntax differs.

```json
{
  "mcpServers": {
    "engineering-bridge": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/chatgpt-local-workbench/dist/src/mcp-stdio.js",
        "/absolute/path/to/private/workspaces.json"
      ],
      "env": {
        "ENGINEERING_BRIDGE_CODEX_DISABLE_MCP": "1"
      }
    }
  }
}
```

This JSON configures a local launcher, not a URL field in ChatGPT. Secure MCP Tunnel can launch the STDIO service; an HTTPS deployment needs a separate MCP transport gateway. Follow [OpenAI's connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt) when attaching either transport to ChatGPT, and keep remote authentication in that transport.

## Host policy

The checked-in [policy example](../config/host-policy.example.json) disables host operations. For personal use with native history and direct file/command tools, an example Windows policy is:

```json
{
  "version": 1,
  "enabled": true,
  "read_roots": ["E:\\Projects"],
  "write_roots": ["E:\\Projects"],
  "command_roots": ["E:\\Projects"],
  "commands_enabled": true,
  "codex_homes": ["E:\\Profiles\\Codex"],
  "protected_paths": [],
  "follow_links": false
}
```

Replace every directory with an existing local path. `codex_homes` identifies actual Codex profiles containing history; it is not a request to move or recreate a profile. Use `write_roots: []` and `commands_enabled: false` if only history discovery and file reads are needed.

| Setting | Meaning |
| --- | --- |
| `enabled` | Enables the optional host/history tool group. Without it the MCP entry point exposes 14 tools instead of 24. |
| `read_roots` | Paths available to file reads, arbitrary `cwd` selection and native-history project validation. |
| `export_roots` | Explicit file-delivery directories within read_roots. Empty by default; whole volumes and linked directories are rejected. Enables three export tools and the MCP file resource template. |
| `export_max_bytes`, `export_ttl_seconds` | Per-export size limit defaults to and permits at most 512,000,000 bytes (decimal 512 MB); lifetime 30–3600 seconds, default 3600. Existing explicit values require an administrator update and later restart. See [file delivery](file-exports.md). |
| `write_roots` | Paths available to Bridge file mutations. This does not select executor access. |
| `command_roots`, `commands_enabled` | Opt-in command execution and allowed starting directories. Commands can access other paths under the OS account. |
| `codex_homes` | Profiles used for history listing and verified rollout lookup. The first is the default home for new work. |
| `protected_paths` | Additional paths blocked from host file writes. |
| `follow_links` | Defaults to false, rejecting links in ordinary host paths. Keep false unless the linked layout has been reviewed. |

Host file tools exclude credential locations and protect the host policy itself from writes. A replacement or file deletion requires the current SHA-256; new copies and text creation refuse to overwrite an existing destination. Limits are 512 MiB per regular file, 2 MiB per text write and 256 KiB per read chunk. These checks coordinate mutations inside one Bridge process and do not provide atomic protection from all external writers.

`run_host_command` requires an absolute executable and an argument array. It uses no implicit shell, allows 1–45 seconds and captures at most 65,536 bytes across stdout/stderr. On Windows use a real `.exe` or `.com`; invoke a script through an explicit interpreter. Cancellation stops the command, while cancellation of `wait_task` leaves an agent execution running.

Processes started directly by Bridge use hidden console windows on Windows. An executor can still explicitly start an application or open a window; GUI operations are outside the built-in tool set.

## Executor configuration

Executors must be installed and configured before use. Codex is discovered on PATH; Windows npm launchers are resolved to their Node entry point without passing instructions through a shell. DSH uses PATH or its installed profile launcher.

| Variable | Use |
| --- | --- |
| `CODEX_HOME` | Existing Codex profile fallback when no home is selected in the host policy. |
| `ENGINEERING_BRIDGE_CODEX_AUTH_HOME` | Optional execution profile override. History discovery still uses the configured history homes. Cross-home resume uses a verified rollout path and checks the returned UUID. |
| `ENGINEERING_BRIDGE_CODEX_PROVIDER` | Optional provider ID already configured in the selected Codex profile. |
| `ENGINEERING_BRIDGE_CODEX_DEFAULT_MODEL` | Default Codex model for Bridge executions, including resumed turns. An explicit model selection still takes precedence, and the user Codex profile is unchanged. |
| `ENGINEERING_BRIDGE_CODEX_DISABLE_MCP=1` | Disables detected configured MCP servers in spawned Codex processes, including `engineering-bridge`, to avoid recursive tool invocation. Does not edit the profile configuration. |
| `ENGINEERING_BRIDGE_CODEX_FORWARD_PROXY=1` | Explicitly forwards `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` into spawned Codex processes. |
| `ENGINEERING_BRIDGE_CODEX_EXECUTION_TIMEOUT_SECONDS` | Codex turn hard deadline; default 3600 seconds. |
| `ENGINEERING_BRIDGE_CODEX_PROTOCOL_INACTIVITY_TIMEOUT_SECONDS` | Ordinary active-turn protocol inactivity window; default 300 seconds. |
| `ENGINEERING_BRIDGE_CODEX_COMMAND_INACTIVITY_TIMEOUT_SECONDS` | Protocol inactivity window while a command execution item is active; default 900 seconds. |
| `ENGINEERING_BRIDGE_CODEX_RPC_TIMEOUT_SECONDS` | Individual Codex app-server RPC deadline; default 30 seconds. |
| `ENGINEERING_BRIDGE_WAIT_TASK_MAX_TIMEOUT_SECONDS` | Maximum allowed long-poll for one `wait_task` call; default 300 seconds. |
| `DSH_HOME`, `DEEPSEEK_API_KEY`, `DSH_TOOLS_MODE` | DSH profile location and supported runtime inputs. Supply secrets through private process configuration. |
| `DSH_PERMISSION_MODE` | Set by Bridge for each DSH invocation from `access`; an inherited value does not override the tool request. |

Only allowlisted environment variables reach executor children. Arbitrary provider credentials and DSH proxy settings are not automatically inherited; use the executor's supported private configuration. Different executors may need different setup, and Bridge does not manage their accounts.

## Updating and troubleshooting

`reload_workspace_config` validates and reloads project identities when no known executions are pending. It does not reload host policy. Changing host policy or replacing running code requires an operator-arranged restart after active work ends; pushing Git commits has no deployment effect.

After a tool schema update, refresh the ChatGPT connection and start a new chat. First inspect `host_capabilities` and `list_workspaces` to distinguish a connection problem from a project or permission problem.

| Symptom | Check |
| --- | --- |
| No host or history tools | Confirm the adjacent policy filename and `enabled`, then inspect the running process's configuration path. |
| `CODEX_UNAVAILABLE` / `DSH_UNAVAILABLE` | Check executable discovery and private executor configuration under the runtime account. |
| `CODEX_THREAD_BUSY` | The Codex thread is in use by another writer. Wait for that writer to release it before continuing the same thread. This identifies the explicit active-writer conflict, not every RPC `-32600`. |
| `CODEX_RPC_ERROR` | Codex returned a valid RPC error. Inspect `rpc_method`, `rpc_error_code` and the safe `rpc_error_category`; raw server messages, error data and stderr are not returned. |
| `CODEX_PROTOCOL_ERROR` | Codex returned malformed or unexpected protocol messages/structure. Check the installed CLI version against the expected app-server protocol. The current adapter invokes `codex app-server --stdio`; CLI protocol changes require validation before upgrading. |
| `CODEX_RPC_TIMEOUT` | A Codex app-server RPC did not answer before its configured deadline. The safe result includes the RPC method. |
| `CODEX_TURN_FAILED` | Codex explicitly completed the active turn with failed status. Raw upstream details remain hidden. |
| `EXECUTION_DEADLINE_EXCEEDED` | The executor exceeded its configured total deadline. An active Codex turn is interrupted cooperatively before process termination. |
| `EXECUTOR_STALLED` | Codex stopped producing qualifying active-turn protocol activity. The default is five minutes ordinarily and 15 minutes while a command execution is active. Inspect saved results and file changes before continuing; already-written changes remain. |
| `WORK_RESULT_WRITE_FAILED` | Execution ended but its result could not be written. Check state-directory space, permissions and conflicting files before retrying. |
| Empty project search with a cursor | Follow the cursor using the same home/archive settings; groups and counts cover one page only. |
| History resume denied | Check configured homes, the original working directory and allowed read roots; preserve linked native history layouts. |

See [work management](work-management.md) for moving an installation and [compatibility](compatibility.md) for retained identifiers and concurrency limitations.
