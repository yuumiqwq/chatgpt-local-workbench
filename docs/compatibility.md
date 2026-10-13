# Compatibility and maintenance limits

The repository is `chatgpt-with-codex`. Existing installations continue to use the identifiers below; changing a repository URL does not require moving a local checkout or a Codex profile.

## Stable installation identifiers

| Identifier | Reason to retain it |
| --- | --- |
| npm package and executable `engineering-bridge` | Existing launchers and installed package references use this name. |
| MCP server name `engineering-bridge` | Clients and recursive-MCP disabling refer to it. |
| `ENGINEERING_BRIDGE_*` environment variables | Existing private executor and tunnel configuration uses these settings. |
| Workspace configuration sidecar suffixes | Existing managed workspace IDs, work records and results must remain discoverable. |
| Native Codex UUIDs and original paths | Continuing a work depends on its real history, not the repository display name. |

## Persisted data

Manual configuration loading accepts the historical boolean `allow_write` field and rewrites it away while preserving project IDs/roots and `project_root` entries. New configuration writes reject that field. Managed workspace catalog version 1 is migrated to identity-only version 2 with stable IDs and roots; removing these readers would strand existing installations.

Old work records using `workspace-write` normalize to the established `danger-full-access` behavior. Historical run metadata retains its recorded access, so its schema still accepts `workspace-write`; public execution inputs accept only `read-only` or `danger-full-access`. This is existing compatibility behavior, not an additional user-selectable mode.

The history catalog retains `can_resume_with_write` for response compatibility. It reflects the host file policy's write check for the project, not the executor's authority: full-access execution is selected separately through `access`. Do not use this field as permission to change files or as proof that execution will be denied.

Registry records/results are private runtime data. Retired proposal or supervisor sidecars are not loaded as current work and are not automatically removed; their contents may remain useful to their owner.

## Earlier client interfaces

The public tool list is documented in [tools](tools.md). The following historical names remain absent and have negative protocol tests:

| Retired interfaces | Current workflow |
| --- | --- |
| `run_task`, `resume_codex_thread` | Use `open_work` / `continue_work` for persistent work or `run_temp` for temporary execution. |
| `generate_controlled_patch`, `refine_controlled_patch`, `submit_controlled_patch`, `apply_controlled_patch`, `commit_controlled_patch` | Ask the selected executor to produce text or modify files/Git under the requested access. |
| `authorize_workspace_write` | Select execution `access`; workspace registration stores project identity only. |
| `configure_validation_profile`, `validate_controlled_patch` | Run the project's validation through an executor or an enabled host command. |

Refresh client metadata when upgrading across a tool-surface change. No extra approval token, proposal engine or persistent DSH conversation is introduced by this release.

## Known limits retained during the repository review

| Area | Current limitation and maintenance decision |
| --- | --- |
| Shared work registry | Short lock/merge writes preserve independent records and readers can observe other Bridge owners. Read-check-execute sequences and native-history operations do not form a cross-process lease; simultaneous activity in an unrelated Codex client is unknown. A lease would change lifecycle coordination and needs a separate design. |
| Managed workspace catalog | Registration and legacy migration re-read and update the catalog under a shared file lock, preserving IDs and records across Bridge processes. Already-running workspace lists remain snapshots; reload workspace configuration to discover projects registered elsewhere. Upgrade all writers before relying on this coordination. |
| File mutation consistency | SHA-256 checks detect reviewed-content changes, and one HostFiles instance serializes its writes. External writers can still race between filesystem checks and operations; this is not a general OS transaction. |
| Linked filesystem layouts | Native history explicitly supports the two top-level history links. Broader `follow_links` behavior has platform-dependent constraints and is not expanded in this maintenance release. |
| CLI protocol and permissions | App-server and DSH behavior depends on installed versions. Retain tested invocation and permission mappings; validate native execution separately before upgrading a deployment. |
| Runtime availability | A restart does not restore an in-flight process. A result write failure is recorded if the registry is writable; an unavailable registry still requires local storage repair. |

The September 2026 review covered the source modules, configuration and scripts, all test files, current documentation, Git refs, ignore rules and package contents. Five targeted regression scenarios reproduced failures before the fixes and passed afterward. Release validation and the changes made are recorded in [release notes](../RELEASE_NOTES.md); this review does not claim a live model or deployment restart test.
