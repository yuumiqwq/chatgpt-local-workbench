# Threat model

chatgpt-local-workbench assumes a trusted user controls the local runtime and authorizes the connected ChatGPT session. It is not a multi-tenant server, and an authorized full-access invocation has the powers of the operating system account running the executor.

## Trust boundaries

| Boundary | Responsibility and remaining exposure |
| --- | --- |
| ChatGPT to local MCP | A tunnel or gateway authenticates the connection. Bridge itself uses STDIO and does not authenticate multiple callers. |
| Instructions and model output | Project files, fetched material and historical previews can contain untrusted instructions. Bridge does not classify their intent or prove a model's completion claim. |
| Model execution to the machine | `access` selects executor-native policy. Full access can change files and use credentials already available to that account; Bridge does not elevate the account. |
| Direct host file operations | Allowed roots, link checks, size limits and content hashes reject ordinary path escapes and stale writes. They are not a kernel-level guarantee against a concurrent external filesystem actor. |
| Host commands | An absolute executable and argv avoid implicit shell parsing. An explicitly selected shell can still run arbitrary commands, and the starting directory does not contain its access. |
| Work state and native history | The private registry preserves summaries and run metadata. Short file locks merge registry writes; they do not provide an exclusive lease over a Codex conversation in every client. |

Codex and DSH provide different native restrictions even when the same `read-only` name is selected. Consult the [permission reference](security.md) for the tested DSH version and platform limitations instead of assuming identical isolation.

## Operational assumptions

Keep configuration and result directories private and writable by the runtime account. Repository ignore rules reduce accidental tracking, but cannot prevent an authorized executor from reading files elsewhere or publishing data when instructed.

An interrupted process can leave file changes behind. Native `delete_history` removes the selected thread and its spawned descendants; result pruning retains work summaries and does not delete project artifacts. Verify current state before retrying a failed run or managing history.

The current concurrency and compatibility limits are documented in [compatibility](compatibility.md). Changing those contracts requires separate behavior and migration tests rather than deleting compatibility paths during cleanup.
