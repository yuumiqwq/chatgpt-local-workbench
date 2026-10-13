import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, extname, relative } from "node:path";

import { HostError, HostPolicy } from "./host-policy.js";
import { EXPORT_BUFFER_BYTES, EXPORT_CHUNK_BYTES } from "./export-limits.js";
export { EXPORT_BUFFER_BYTES, EXPORT_CHUNK_BYTES } from "./export-limits.js";

export const EXPORT_RESOURCE_BYTES = 262_144;
export const EXPORT_MAX_ACTIVE = 8;

const MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json"
};

export interface ExportMetadata {
  export_id: string;
  filename: string;
  size: number;
  sha256: string;
  mime_type: string;
  expires_at: string;
  transport: "mcp_base64";
  resource_uri: string;
  chunk_bytes: number;
  resource_max_bytes: number;
  direct_download: false;
}

interface Snapshot {
  metadata: ExportMetadata;
  bytes: Buffer;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

function regular(stat: BigIntStats, maxBytes: number): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    throw new HostError("HOST_FILE_UNSUPPORTED", "Export requires a regular file without additional hard links.");
  }
  if (stat.size > BigInt(maxBytes)) {
    throw new HostError("HOST_EXPORT_TOO_LARGE", "The file exceeds export_max_bytes.");
  }
}

function unchanged(before: BigIntStats, after: BigIntStats): void {
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.nlink !== after.nlink) {
    throw new HostError("HOST_FILE_CHANGED", "The source changed while preparing the export; export it again.");
  }
}

/** Immutable, bounded, process-local transfers. Source paths are never used again after capture. */
export class HostExports {
  private readonly snapshots = new Map<string, Snapshot>();
  private reservedBytes = 0;
  private reservedCount = 0;
  private capturingBytes = 0;
  private disposed = false;

  constructor(private readonly policy: HostPolicy, private readonly now: () => number = Date.now) {}

  async create(pathValue: string, signal?: AbortSignal): Promise<ExportMetadata> {
    signal?.throwIfAborted();
    if (this.disposed) throw new HostError("HOST_EXPORT_CLOSED", "The export service is closed.");
    const path = await this.policy.checkExport(pathValue);
    const before = await lstat(path, { bigint: true });
    regular(before, this.policy.config.export_max_bytes);
    this.sweep();
    const size = Number(before.size);
    if (this.reservedCount >= EXPORT_MAX_ACTIVE || this.reservedBytes + size > EXPORT_BUFFER_BYTES) {
      throw new HostError("HOST_EXPORT_CAPACITY", "Release an earlier export or wait for expiry before exporting more files.");
    }
    this.reservedCount++;
    this.reservedBytes += size;
    this.capturingBytes += size;
    let bytes: Buffer | undefined;
    let retained = false;
    try {
      const requireMemory = () => {
        if (size > 0 && this.capturingBytes + 64 * 1024 * 1024 > process.availableMemory()) {
          throw new HostError("HOST_EXPORT_MEMORY", "Insufficient available memory for this export. Release earlier exports or free memory and retry.");
        }
      };
      requireMemory();
      const hash = createHash("sha256");
      // O_NOFOLLOW covers the final component on POSIX; identity and ancestry
      // checks on both sides of the read also cover Windows and parent changes.
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const opened = await handle.stat({ bigint: true });
        regular(opened, this.policy.config.export_max_bytes);
        unchanged(before, opened);
        if (relative(path, await this.policy.checkExport(pathValue)) !== "") {
          throw new HostError("HOST_FILE_CHANGED", "The source path changed while opening the file.");
        }
        unchanged(before, await lstat(path, { bigint: true }));
        requireMemory();
        try { bytes = Buffer.alloc(size); }
        catch { throw new HostError("HOST_EXPORT_MEMORY", "The export buffer could not be allocated. Free memory and retry."); }
        let offset = 0;
        while (offset < size) {
          signal?.throwIfAborted();
          const { bytesRead } = await handle.read(bytes, offset, Math.min(EXPORT_CHUNK_BYTES, size - offset), offset);
          if (bytesRead === 0) throw new HostError("HOST_FILE_CHANGED", "The source was truncated during export.");
          hash.update(bytes.subarray(offset, offset + bytesRead));
          offset += bytesRead;
        }
        signal?.throwIfAborted();
        unchanged(before, await handle.stat({ bigint: true }));
        if (relative(path, await this.policy.checkExport(pathValue)) !== "") {
          throw new HostError("HOST_FILE_CHANGED", "The source path changed during export.");
        }
        unchanged(before, await lstat(path, { bigint: true }));
      } finally { await handle.close(); }
      signal?.throwIfAborted();
      if (this.disposed) throw new HostError("HOST_EXPORT_CLOSED", "The export service is closed.");
      const exportId = randomUUID();
      const expiresAt = this.now() + this.policy.config.export_ttl_seconds * 1000;
      const metadata: ExportMetadata = {
        export_id: exportId, filename: basename(path), size,
        sha256: hash.digest("hex"),
        mime_type: MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
        expires_at: new Date(expiresAt).toISOString(), transport: "mcp_base64",
        resource_uri: `bridge-export://${exportId}`, chunk_bytes: EXPORT_CHUNK_BYTES,
        resource_max_bytes: EXPORT_RESOURCE_BYTES, direct_download: false
      };
      const timer = setTimeout(() => this.release(exportId), this.policy.config.export_ttl_seconds * 1000);
      timer.unref();
      this.snapshots.set(exportId, { metadata, bytes: bytes!, expiresAt, timer });
      retained = true;
      return { ...metadata };
    } finally {
      this.capturingBytes -= size;
      if (!retained) {
        bytes?.fill(0);
        this.reservedCount--;
        this.reservedBytes -= size;
      }
    }
  }

  read(exportId: string, offset = 0, maxBytes = EXPORT_CHUNK_BYTES) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 || maxBytes > EXPORT_CHUNK_BYTES) {
      throw new HostError("HOST_INVALID_ARGUMENT", "Invalid export chunk bounds.");
    }
    const snapshot = this.get(exportId);
    if (offset > snapshot.bytes.length) throw new HostError("HOST_INVALID_ARGUMENT", "Offset exceeds the exported file size.");
    const bytes = snapshot.bytes.subarray(offset, Math.min(offset + maxBytes, snapshot.bytes.length));
    return { export_id: exportId, size: snapshot.metadata.size, sha256: snapshot.metadata.sha256,
      encoding: "base64" as const, offset, bytes_read: bytes.length, next_offset: offset + bytes.length,
      eof: offset + bytes.length === snapshot.bytes.length,
      chunk_sha256: createHash("sha256").update(bytes).digest("hex"), content: bytes.toString("base64") };
  }

  resource(exportId: string) {
    const snapshot = this.get(exportId);
    if (snapshot.bytes.length > EXPORT_RESOURCE_BYTES) {
      throw new HostError("HOST_EXPORT_USE_CHUNKS", "This resource exceeds 256 KiB; use read_export_chunk with export_id and next_offset.");
    }
    return { uri: snapshot.metadata.resource_uri, mimeType: snapshot.metadata.mime_type,
      blob: snapshot.bytes.toString("base64") };
  }

  release(exportId: string) {
    const snapshot = this.snapshots.get(exportId);
    if (snapshot) {
      clearTimeout(snapshot.timer);
      snapshot.bytes.fill(0);
      this.snapshots.delete(exportId);
      this.reservedBytes -= snapshot.metadata.size;
      this.reservedCount--;
    }
    return { export_id: exportId, released: Boolean(snapshot) };
  }

  dispose(): void {
    this.disposed = true;
    for (const id of this.snapshots.keys()) this.release(id);
  }

  private get(exportId: string): Snapshot {
    this.sweep();
    const snapshot = this.snapshots.get(exportId);
    if (!snapshot) throw new HostError("HOST_EXPORT_NOT_FOUND", "The export expired, was released, or belongs to another Bridge process. Export the path again.");
    return snapshot;
  }

  private sweep(): void {
    for (const [id, snapshot] of this.snapshots) if (snapshot.expiresAt <= this.now()) this.release(id);
  }
}
