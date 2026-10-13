# File delivery to ChatGPT

`export_host_file` captures an authorized file and returns its filename, size, SHA-256, extension-derived MIME type, export ID and expiry. Unknown extensions use `application/octet-stream`. It also attaches a small MCP UI resource. The first tool response contains metadata, not Base64 file contents. No HTTP listener, public file service, third-party storage or new dependency is introduced.

## Enable and call

Add these fields to the existing private host policy, keeping its other settings. Use actual, existing assignment or study directories within `read_roots`:

```json
{
  "export_roots": ["E:\\Study\\Assignments", "E:\\Study\\Lessons"],
  "export_max_bytes": 512000000,
  "export_ttl_seconds": 3600
}
```

`enabled` must also be true. `read_roots` may cover C/D/E; export authorization remains restricted to the explicit directories. The checked-in example keeps exports disabled. Build the new version, wait for active work to finish, then use the deployment's normal graceful restart procedure. Refresh the ChatGPT plugin's tools and open a new chat if the old tool list persists. `reload_workspace_config` does not reload host policy or code. Existing background processes are not restarted by building or pushing this repository.

Call `export_host_file` with:

```json
{ "path": "E:\\Study\\Assignments\\实验报告.docx" }
```

In clients that render MCP Apps, click **准备下载**. The widget requests chunks from the same authenticated plugin, decodes each chunk and verifies both chunk hashes and the complete file's size/SHA-256. It then calls `window.openai.uploadFile(new File(...))` and `getFileDownloadUrl({fileId})`, using only the file ID actually returned by the host. Click the resulting **下载** link. Upload begins only after the user's gesture; no follow-up chat message is posted automatically.

This follows the [OpenAI component and file API reference](https://developers.openai.com/plugins/reference), including `_meta.ui.resourceUri`, the compatibility `openai/outputTemplate` and `openai/widgetAccessible` fields. The widget is served at `ui://engineering-bridge/file-export-v2.html` using `text/html;profile=mcp-app`; it requires no external scripts or network fetches. The versioned URI refreshes the previous widget's 128 MiB limit without changing its download controls. The actual registered URI is returned in tool metadata.

When the host APIs are absent or reject the upload, the widget offers **保存到设备** using a verified Blob URL. That fallback requires the browser or mobile WebView to permit iframe downloads. A rendered widget, working host upload API and permitted link navigation are client capabilities, not guarantees provided by an MCP server. Secure MCP Tunnel forwards MCP requests; it is not an HTTP file host. This release's local transport and widget runtime tests do not constitute an Android ChatGPT download acceptance test.

The initial MCP resource URI is `bridge-export://<export_id>`, with `direct_download: false`. It is not an HTTPS link. No `file://`, localhost URL, fabricated `file_id` or `file_uri` is returned as a chat attachment. A plain MCP client without widget support must reconstruct the bytes and attach the result using its own file facilities. No external HTTPS download bridge is required or configured.

## Binary protocol and recovery

Call `read_export_chunk` with `export_id`, byte `offset` starting at 0 and optional `max_bytes` up to 524,288 bytes (512 KiB), also the default. The response contains `content` as Base64, `bytes_read`, `next_offset`, `eof`, `chunk_sha256`, and the original `size`/`sha256`. A full chunk is 699,052 Base64 characters. Widgets set `content_text: false` so the bytes appear once in `structuredContent`, keeping the MCP response below 1 MiB; the default true retains the existing JSON-text response for other clients. A 512,000,000-byte file takes 977 chunk calls. Smaller chunks remain supported for transports with tighter payload limits. Decode each Base64 chunk separately, verify its hash, and append the decoded bytes in offset order. Base64 strings themselves must not be concatenated because chunks can contain padding. Before publishing the reconstructed file, check its byte count and full SHA-256 against `export_host_file`.

Offsets are repeatable and have no destructive read cursor. After a lost response, retry the same offset. The widget retains verified Blob chunks and an incremental SHA-256 state during pause/retry in the same render. Whole-file validation no longer allocates a file-sized ArrayBuffer or asks WebCrypto to copy the whole file. Chunk requests and download-URL lookup time out after 30 seconds; the final ChatGPT upload allows up to one hour. Pause stops waiting promptly, although an already submitted host upload may finish independently. A new render starts reception again unless a genuine uploaded file ID was already saved in private widget state. Expired transfers must be exported again. Only uploads accepted by ChatGPT have ChatGPT-managed file lifetimes; Bridge expiry applies to the local transfer snapshot.

`resources/read` accepts the returned MCP URI and supplies a complete Base64 `blob` for files up to 256 KiB. Larger resources return `HOST_EXPORT_USE_CHUNKS` instead of a truncated file. Exports are not enumerated by `resources/list`. `release_host_export` releases a snapshot after receipt or cancellation and leaves the original file intact.

Unlike `read_host_file`, exports use separate authorization and an immutable snapshot. They always calculate a full SHA-256, provide file metadata/lifetime, and remain consistent across source edits between chunk requests. Ordinary file reads and their existing behavior are unchanged.

## Limits and authorization

The default and maximum per-file limit is **512,000,000 bytes**, using decimal 512 MB, not 512 MiB (536,870,912 bytes). Each process retains at most eight exports and 1,024,000,000 bytes across snapshots and captures in progress. The default lifetime is one hour, configurable from 30 to 3600 seconds. Existing explicit policy values are preserved until the administrator updates them. Set both `export_max_bytes` and `export_ttl_seconds` in the private policy; these settings and new code take effect only when a new Bridge process starts. Expiry/release clears buffered bytes; process exit loses all transfers. The original source is never removed. Snapshots use memory rather than persistent temporary copies.

Before allocating, Bridge checks available memory with 64 MiB of headroom and includes concurrent captures in that check. Insufficient memory or a failed allocation returns `HOST_EXPORT_MEMORY` and releases the reservation for retry. This is a preflight estimate, not a guarantee against memory consumed concurrently by other processes. The widget retains the file as Blob parts and uses fixed-size SHA-256 working storage; the browser and host uploader can still require substantial memory. Catchable allocation failures permit a retry, while browser process termination cannot be handled by widget code.

The Bridge ceiling is not a promise that ChatGPT will accept every file at that size. ChatGPT's ordinary attachment ceiling is 512 MB, with lower type-specific limits such as 20 MB for images and approximately 50 MB for CSV/spreadsheets; see the [File Uploads FAQ](https://help.openai.com/en/articles/8555545-file-uploads-faq). Account, content and widget API constraints also apply. Rejected uploads retain the verified Blob download fallback, subject to the mobile WebView's download support. Small-file success does not establish 512 MB Android acceptance.

Exports reject traversal, device/alternate-stream paths on Windows, symbolic links and junctions even with ordinary `follow_links` enabled, additional hard links, known credential names and protected locations. Export roots cannot be whole volumes. Capture opens one file descriptor, compares file identity and metadata before/after the read and revalidates the authorized path before publishing any bytes. Changing or replacing the source during capture fails the export; changing it afterward does not affect the snapshot. These checks are not an OS sandbox against a malicious process running with the same account. Archive contents and arbitrarily renamed credentials are not inspected; authorize directories intended for shareable coursework.

Transfer IDs are opaque, process-local capabilities carried inside the authenticated MCP connection. Keep the existing single-user tunnel authentication. This service does not add multi-user isolation. Audit records contain operation/status and the source path for export creation, without file contents, transfer IDs or download URLs. Machine policy, generated test files and private materials remain outside commits.
