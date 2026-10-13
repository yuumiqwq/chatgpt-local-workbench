# Contributing

chatgpt-with-codex connects a ChatGPT chat workflow to local agents and host operations. Keep changes focused on the current interfaces in [docs/tools.md](docs/tools.md), and include migration coverage whenever a persisted schema changes. Preserve existing permission defaults and persistent work semantics during maintenance.

Workspace configuration defines project identity and registration boundaries. A manual workspace contains `id` and `root`; a `project_root` entry limits paths accepted by `bind_project` and `create_project`. Per-execution write access belongs to `open_work`, `continue_work` and `run_temp`. Bridge file and command operations belong to the adjacent host policy. Do not combine these independent boundaries.

Keep machine-specific paths, credentials, secrets and private runtime sidecars out of source, fixtures, documentation, commits and issue reports. Existing work records and managed workspace IDs must survive compatible migrations.

## Debugging execution

Bridge invokes Codex through `codex app-server --stdio`. For a slow or stalled task, correlate the Bridge `task_id` with the Codex thread or session ID when available, then compare session-start, tool-result, final-message and session-end timestamps. Local session JSONL files and a populated Codex log database can provide evidence, but avoid logging sensitive request bodies or allowing diagnostics to grow without a bound.

Run the standard checks before submitting a change:

```sh
npm ci
npm run typecheck
npm run build
npm test
npm pack --dry-run --ignore-scripts
npm audit
git diff --check
```

Describe the behavior change, migration path and validation performed. Security-sensitive reports should follow [SECURITY.md](SECURITY.md).

TypeScript checks include unused locals/parameters. CI covers Windows and Linux on Node 22 and 24; `npm test` builds before running the unit/MCP transport suite. Tests use temporary fixtures and mocked model execution, so native CLI or real model integration claims need separate evidence. Keep generated audit output under `codex-generated/`, which is ignored.

Package versions are read from `package.json` at runtime; update the lockfile with a version change. `npm pack` runs the prepack build unless scripts are explicitly disabled. The package includes compiled runtime modules and current documentation. It does not include tests, private sidecars or an automatic publishing/deployment workflow.

Keep the public repository metadata pointed at [yuumiqwq/chatgpt-with-codex](https://github.com/yuumiqwq/chatgpt-with-codex). Retained package/protocol identifiers and known coordination limits are explained in [compatibility](docs/compatibility.md). Project registration is coordinated through a shared file lock and covered by multi-process tests. Avoid simultaneous native-history execution across independent clients until that separate coordination has been verified.
