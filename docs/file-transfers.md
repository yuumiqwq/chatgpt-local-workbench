# Direct peer file transfers

`transfer_file` receives one file on the Workbench host running the tool. The receiving device starts OpenSSH SFTP against an administrator-configured source device over its Tailscale address. File contents travel over SSH between devices, outside MCP and chat attachments. The tool is absent unless both host operations and `transfer.enabled` are enabled; enabling it does not require `commands_enabled`. Its name and inputs are identical in the v1 and v2 API profiles.

ROG and Legion already share a tailnet and direct ping has been verified by the operator. This change adds code and offline tests only. SSH accounts, firewall rules, server installation, host policy files and running services have not been changed. An actual ROG–Legion SFTP transfer remains a deployment acceptance step after running work finishes.

## Request and result

| Required input | Meaning |
| --- | --- |
| `source_peer` | A key in local `transfer.peers`, such as `legion`. |
| `source_root` | A key in that peer's `read_roots`, such as `exports`. |
| `source_path` | One relative file path, using forward slashes. Unicode and spaces are supported. |
| `destination` | An absolute local file path within HostPolicy `write_roots`; its parent must already exist. |
| `expected_sha256` | Independently obtained SHA-256 of the source file, as 64 lowercase hexadecimal characters. |
| `expected_bytes` | Exact source byte count, including zero for an empty file. |

The result contains the source aliases and relative path, canonical destination, verified `bytes` and `sha256`, and `transport: "openssh_sftp"`. Both MCP JSON text and `structuredContent` contain the same result. Obtain the expected digest and size through a trusted source-side read or a reviewed manifest before calling; a destination file with unknown content is never accepted. The source is left unchanged. An existing destination is an error, including when another writer creates it during the transfer.

`host_capabilities.transfer` exposes the enabled flag, limits and available peer/root aliases. It omits host addresses, usernames, credential paths and remote filesystem roots. Transfer audit records contain aliases, destination and outcome; client stdout/stderr and credential contents are not returned or logged. Failure messages use fixed error codes and sanitized text.

## Receiver configuration

Add this optional object to the local host policy during the later deployment window. The addresses and paths below are placeholders, and `enabled` deliberately remains false. Set host `write_roots` to an existing private receive directory on E: and enable host operations separately.

```json
{
  "transfer": {
    "enabled": false,
    "executable": "C:/Windows/System32/OpenSSH/sftp.exe",
    "ssh_executable": "C:/Windows/System32/OpenSSH/ssh.exe",
    "max_bytes": 536870912,
    "timeout_ms": 120000,
    "peers": {
      "legion": {
        "host": "100.64.0.2",
        "port": 22,
        "user": "workbench_read",
        "identity_file": "E:/WorkbenchPrivate/legion_ed25519",
        "known_hosts_file": "E:/WorkbenchPrivate/legion_known_hosts",
        "read_roots": { "exports": "/E:/WorkbenchExports" }
      }
    }
  }
}
```

Use the actual Tailscale IP or reviewed MagicDNS name of the source device. A fixed IP avoids dependence on DNS routing. IPv4 and IPv6 are supported. Configure the remote path exactly as exposed by that server's SFTP namespace; a chrooted source might expose `/exports` instead of `/E:/WorkbenchExports`. Only a specific directory is accepted, with no trailing slash. Each direction needs its own receiving policy and source authorization.

Both executable paths must identify administrator-installed native OpenSSH programs; neither executable is discovered through PATH. Use a matched, supported OpenSSH installation with the configured options available. The tool supplies an empty SSH configuration with `-F`, an explicit SSH executable with `-S`, batch input, one outstanding read request and 32 KiB buffers. Public-key authentication is the only authentication method; SSH agents, password prompts, proxy commands, forwarding, local commands and shared control sockets are disabled. The options follow the [OpenSSH SFTP manual](https://man.openbsd.org/sftp) and [SSH client configuration manual](https://man.openbsd.org/ssh_config).

The receiving account needs private-key read access without interactive unlocking. Protect that dedicated key with OS permissions and restrict its server-side authorization to the intended source account and receiver. Store a separately verified source host public key in the configured `known_hosts_file`. For a nonstandard port, use the `[host]:port` known-hosts entry. Verify the fingerprint through a trusted local source console or an existing trusted channel; `ssh-keyscan` output alone does not authenticate the key. Unknown or changed host keys fail, and the tool never enrolls or updates keys. Configured credential files are excluded from host reads and writes, and executable directories are protected from host writes.

## Restricted source and Tailscale setup

Use a dedicated non-administrator source account with filesystem read access only to reviewed export data and the minimum OS paths needed for SFTP. Keep personal profiles, credentials and task working directories outside its accessible export namespace. Prepare immutable export copies or snapshots when a running task may continue modifying its outputs. The source account must not be able to write, replace or create links inside its export tree.

Configure the account for an SFTP-only forced command with read-only mode, public-key-only authentication and forwarding/PTY disabled. OpenSSH `internal-sftp -R`, or the installed `sftp-server` read-only equivalent, rejects filesystem-changing requests; `-d` selects a starting directory and does not confine reads. Use a reviewed chroot or equivalent filesystem confinement together with read ACLs. Remote aliases enforce lexical selection on the receiver; SFTP can follow remote links, so the source export tree must exclude symlinks, junctions and reparse points that expose other data. Source-side confinement is required to enforce the readable namespace. See [OpenSSH read-only server options](https://man.openbsd.org/sftp-server).

On Windows, verify the installed OpenSSH server's SFTP chroot/forced-command support and NTFS ACL behavior before enabling the tool. Microsoft documents SFTP-specific `ChrootDirectory` support and `ForceCommand internal-sftp`; apply the supported equivalent for the installed release. Ensure the test account cannot obtain an interactive shell or read outside the intended export area. Server configuration changes take effect on a later service restart, which belongs in the agreed idle window. See [Microsoft's OpenSSH server configuration](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-server-configuration).

Use ordinary OpenSSH on the Tailscale network. Tailscale SSH is a separate authentication service and is not part of this configuration; do not enable it for this tool. Permit only the receiving device to reach the source's selected TCP SSH port using tailnet grants/ACLs and the host firewall, with the listener bound or restricted to the intended Tailscale interface. Direct ping proves device reachability; TCP access, host-key verification and SFTP account restrictions need separate acceptance. Tailscale may relay traffic when a direct path is unavailable; this implementation does not force or attest a direct physical route. See [Tailscale SSH's separate authentication model](https://tailscale.com/docs/features/tailscale-ssh).

## Verification, limits and cleanup

The tool rejects parent traversal, absolute source paths, backslashes in source paths, glob syntax, control/format characters, quotes, shell metacharacters and Windows device/alternate-stream spellings. It never accepts hostnames, commands or extra SSH arguments from tool requests. Local destination ancestors are checked for symlinks and junctions even if ordinary HostPolicy reads permit following links. Existing credential and protected-path rules still apply.

A randomly named `.workbench-transfer-*` directory is created inside the authorized destination parent, with a private temporary file. After SFTP exits successfully, the receiver checks the byte count and streams a SHA-256 calculation, flushes the file and rechecks its identity and path authorization. A same-filesystem hard link publishes the verified file atomically only if the destination is absent, then staging is removed. Filesystems without hard-link support fail without a copy/rename fallback. Cancellation is checked immediately before publication and removes unpublished staging. Cancellation racing the atomic publication can leave the verified destination committed; a published file is never rolled back.

One transfer may run per Bridge instance. The configured size ceiling is 1–536,870,912 bytes and the deadline is 1–600 seconds, defaulting to 120 seconds. The expected byte count provides the tighter per-request size limit. Disk growth is checked every 25 ms while SFTP runs, and stdout/stderr are discarded with a combined 64 KiB limit. Oversized transfers are terminated; no file is published unless the final size and digest match exactly. OpenSSH writes directly to disk, so polling can temporarily overshoot the disk size threshold. Use a filesystem quota or isolated volume if an exact disk-consumption ceiling is required.

Timeout, request cancellation or connection shutdown terminates the spawned process tree and removes staging after termination. If termination cannot be confirmed within the cleanup grace period, `HOST_TRANSFER_CLEANUP_FAILED` preserves the staging directory for operator inspection instead of racing a potentially live writer. Abrupt process/OS termination may also leave staging; inspect and remove abandoned `.workbench-transfer-*` directories only after confirming no transfer owns them. A private receiver directory and trusted local account are prerequisites: portable Node path checks are not a sandbox against another process racing ancestor replacement or editing staged content under the same account. POSIX mode bits do not replace Windows directory ACLs.

## Deployment acceptance

After active user tasks finish, prepare and verify the restricted source account, read-only export confinement, Tailscale TCP authorization, dedicated receiver key and independently pinned host key. Check permissions on executable directories, credential files and the receive directory. Enable the policy on the receiving device and perform an operator-arranged build/deployment and runtime restart, then refresh the client tool catalog.

Transfer a reviewed small binary and a zero-byte file, checking the destination digest and byte count independently. Verify refusal of an existing destination, a wrong digest and an unconfigured alias. Exercise cancellation and a deliberately invalid host pin, confirming no published file or staging remains. Test source-side write denial and attempts to access outside the export namespace using the restricted account. Repeat with roles reversed only if both directions are configured. Offline unit/mock integration results do not establish live SSH readiness or ROG–Legion acceptance.
