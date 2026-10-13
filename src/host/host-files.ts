import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, type Stats } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { HostError, HostPolicy } from "./host-policy.js";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024 * 1024;

function checkRegularFile(stat: Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) {
    throw new HostError("HOST_FILE_UNSUPPORTED", "A regular file without additional hard links is required.");
  }
  if (stat.size > MAX_FILE_BYTES) throw new HostError("HOST_FILE_TOO_LARGE", "The file exceeds the 512 MiB operation limit.");
}

export async function fileDigest(path: string): Promise<string> {
  checkRegularFile(await lstat(path));
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function ensureAbsent(path: string): Promise<void> {
  try { await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new HostError("HOST_DESTINATION_EXISTS", "The destination already exists; read it before replacing text.");
}

async function checkDigest(path: string, expected: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(expected) || await fileDigest(path) !== expected) {
    throw new HostError("HOST_FILE_CHANGED", "The file differs from the reviewed SHA-256.");
  }
}

export class HostFiles {
  private mutationTail: Promise<unknown> = Promise.resolve();
  constructor(readonly policy: HostPolicy) {}

  private mutate<T>(work: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(work, work);
    this.mutationTail = result.catch(() => {});
    return result;
  }

  async read(pathValue: string, offset = 0, maxBytes = 65_536, encoding: "utf8" | "base64" = "utf8", includeSha256 = false) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 || maxBytes > 262_144) throw new HostError("HOST_INVALID_ARGUMENT", "Invalid read bounds.");
    const path = await this.policy.check(pathValue, "read");
    checkRegularFile(await lstat(path));
    const sha256 = includeSha256 ? await fileDigest(path) : undefined;
    const handle = await open(path, "r");
    try {
      const stat = await handle.stat();
      checkRegularFile(stat);
      const buffer = Buffer.alloc(Math.min(maxBytes, Math.max(0, stat.size - offset)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      const data = buffer.subarray(0, bytesRead);
      if (encoding === "utf8" && data.includes(0)) {
        throw new HostError("HOST_BINARY_FILE", "Use base64 encoding for a binary file.");
      }
      let content: string;
      let consumed = bytesRead;
      if (encoding === "utf8") {
        try {
          // Leave an incomplete trailing code point for the next page. Keep a
          // leading BOM so the returned byte offset still matches the file.
          content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
            .decode(data, { stream: offset + bytesRead < stat.size });
        } catch {
          throw new HostError("HOST_INVALID_UTF8", "Use a UTF-8 character boundary for offset, or base64 for non-UTF-8 data.");
        }
        consumed = Buffer.byteLength(content, "utf8");
        if (bytesRead > 0 && consumed === 0) {
          throw new HostError("HOST_INVALID_ARGUMENT", "The page cannot fit one UTF-8 character; use max_bytes of at least 4.");
        }
      } else content = data.toString("base64");
      return { path, size: stat.size, ...(sha256 === undefined ? {} : { sha256 }), encoding, offset, bytes_read: consumed,
        next_offset: offset + consumed, truncated: offset + consumed < stat.size, content };
    } finally { await handle.close(); }
  }

  async list(pathValue: string, offset = 0, limit = 200) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) ||
        limit < 1 || limit > 500) throw new HostError("HOST_INVALID_ARGUMENT", "Invalid list bounds.");
    const path = await this.policy.check(pathValue, "read");
    const all = await readdir(path, { withFileTypes: true });
    all.sort((a, b) => a.name.localeCompare(b.name));
    const entries = all.slice(offset, offset + limit).map(entry => ({
      name: entry.name, path: join(path, entry.name),
      type: entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "directory" :
        entry.isFile() ? "file" : "other"
    }));
    return { path, entries, total: all.length, next_offset: offset + entries.length,
      truncated: offset + entries.length < all.length };
  }

  async write(pathValue: string, content: string, expectedSha256?: string, createParents = false) {
    if (Buffer.byteLength(content, "utf8") > MAX_TEXT_BYTES || content.includes("\0")) {
      throw new HostError("HOST_TEXT_TOO_LARGE", "Text must be UTF-8 without NUL and at most 2 MiB.");
    }
    return this.mutate(async () => {
      const path = await this.policy.check(pathValue, "write");
      if (expectedSha256 === undefined) await ensureAbsent(path);
      else await checkDigest(path, expectedSha256);
      if (createParents) {
        await this.policy.check(dirname(path), "write");
        await mkdir(dirname(path), { recursive: true });
      }
      await this.policy.check(path, "write");
      const temp = join(dirname(path), "." + basename(path) + ".bridge-" + randomUUID() + ".tmp");
      try {
        const handle = await open(temp, "wx", expectedSha256 === undefined ? 0o600 : (await lstat(path)).mode);
        try { await handle.writeFile(content, "utf8"); await handle.sync(); }
        finally { await handle.close(); }
        await this.policy.check(path, "write");
        if (expectedSha256 === undefined) {
          // COPYFILE_EXCL makes create-only semantics atomic for competing writers.
          await copyFile(temp, path, constants.COPYFILE_EXCL);
        } else {
          await checkDigest(path, expectedSha256);
          await rename(temp, path);
        }
        return { path, bytes: Buffer.byteLength(content, "utf8"),
          sha256: createHash("sha256").update(content, "utf8").digest("hex") };
      } finally {
        await unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; });
      }
    });
  }

  async copy(sourceValue: string, destinationValue: string, createParents = false) {
    return this.mutate(() => this.copyOnce(sourceValue, destinationValue, createParents));
  }

  private async copyOnce(sourceValue: string, destinationValue: string, createParents: boolean) {
    const source = await this.policy.check(sourceValue, "read");
    const destination = await this.policy.check(destinationValue, "write");
    await ensureAbsent(destination);
    const sha256 = await fileDigest(source);
    if (createParents) {
      await this.policy.check(dirname(destination), "write");
      await mkdir(dirname(destination), { recursive: true });
    }
    await this.policy.check(source, "read");
    await this.policy.check(destination, "write");
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    const copiedSha256 = await fileDigest(destination);
    if (copiedSha256 !== sha256) {
      throw new HostError("HOST_SOURCE_CHANGED", "Source changed during copy; the destination was retained for review.");
    }
    return { source, destination, sha256, bytes: (await lstat(destination)).size };
  }

  async move(sourceValue: string, destinationValue: string, expectedSha256: string, createParents = false) {
    return this.mutate(async () => {
      const source = await this.policy.check(sourceValue, "write");
      await checkDigest(source, expectedSha256);
      const result = await this.copyOnce(source, destinationValue, createParents);
      await this.policy.check(source, "write");
      await checkDigest(source, expectedSha256);
      await unlink(source);
      return result;
    });
  }

  async remove(pathValue: string, expectedSha256?: string) {
    return this.mutate(async () => {
      const path = await this.policy.check(pathValue, "write");
      if (this.policy.isWriteRoot(path)) {
        throw new HostError("HOST_PATH_DENIED", "A configured root cannot be removed.");
      }
      const stat = await lstat(path);
      if (stat.isDirectory()) {
        if (expectedSha256 !== undefined) throw new HostError("HOST_INVALID_ARGUMENT", "Directories do not have a file digest.");
        await rmdir(path); // Empty directories only. Never recursive.
        return { path, removed: true, type: "directory" };
      }
      if (expectedSha256 === undefined) {
        throw new HostError("HOST_EXPECTED_HASH_REQUIRED", "Read the file and provide its SHA-256 before deletion.");
      }
      await checkDigest(path, expectedSha256);
      await this.policy.check(path, "write");
      await unlink(path);
      return { path, removed: true, type: "file" };
    });
  }
}
