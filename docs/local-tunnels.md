# Shared local tunnel deployment

`scripts/coordinate-tunnels.mjs` coordinates two existing tunnel profiles that use the same STDIO entry and compiled checkout. Store the machine-specific manifest outside tracked source, for example in `codex-generated/dual-workbench/deployment.json`.

The manifest supplies `repository`, `registry`, `tunnel_client`, `shared_command`, an `environment` map, a `build` command with argument array, and two `tunnels`. Each tunnel specifies its existing `alias`, `id`, `profile` path and `state_dir`. Credentials remain references in the existing profiles.

```sh
node scripts/coordinate-tunnels.mjs status /path/to/deployment.json
node scripts/coordinate-tunnels.mjs ensure /path/to/deployment.json workbench
node scripts/coordinate-tunnels.mjs plan /path/to/deployment.json
node scripts/coordinate-tunnels.mjs update /path/to/deployment.json --apply
node --test tests/deployment/coordinate-tunnels.test.mjs
```

`ensure` starts an absent managed runtime and preserves every running process. An independent scheduled invocation can supervise the second tunnel while the first tunnel keeps its existing recovery task.

Use `update` in an idle maintenance window after pausing new task submissions. It checks the shared work registry before building and immediately before each restart, builds once, and reconnects both profiles to that same output. Active queued or running work prevents restarts; the script does not interrupt work to make progress. A task arriving during the build stops the update before the next restart. If a later reconnect fails, use `status` to identify the incomplete runtime and `ensure` to reconnect it.

After a tool interface change, refresh each existing ChatGPT plugin connection and inspect its discovered tools. Local runtime health and a completed build are separate from successful remote tool calls.
