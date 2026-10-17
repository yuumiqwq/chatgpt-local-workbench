# Security policy

chatgpt-local-workbench is a personal direct-execution MCP service. New work and temporary runs default to full OS account access; only connect clients and transports authorized to exercise those capabilities.

The authoritative [execution and host policy reference](docs/security.md) describes permission modes and their limits. The [threat model](docs/threat-model.md) identifies trust assumptions, and [deployment configuration](docs/host-operations.md) explains the separate host policy.

## Reporting

Report vulnerabilities through this repository's [private vulnerability reporting page](https://github.com/yuumiqwq/chatgpt-local-workbench/security/advisories/new). Include the affected commit/version and a minimal reproduction with dummy paths and credentials. Keep tokens, native conversation contents and private task results out of public issues.

Ordinary setup failures can use the [issue templates](https://github.com/yuumiqwq/chatgpt-local-workbench/issues/new/choose). Maintainers validate fixes against the current development branch; historical tags do not imply a separately maintained security release line.

## Optional Android maintenance authority

The opt-in phone module uses shared bearer leases and crash-aware request receipts. Generic host commands are blocked during a lease, while Codex/DSH and OS-account maintenance authority can still bypass the phone protocol. See [phone security](docs/phone-security.md) and [Lenovo deployment and acceptance](docs/phone-legion-deployment.md). Configured roots are not an OS sandbox.
