import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Serialize short, synchronous read-modify-write operations across Bridge processes. */
export function withFileStoreLock<T>(path: string, operation: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const lock = path + ".lock";
  const deadline = Date.now() + 5000;
  let fd: number;
  for (;;) {
    try {
      fd = openSync(lock, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid }));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(readFileSync(lock, "utf8")) as { pid?: number };
        if (typeof owner.pid === "number" && !processIsAlive(owner.pid)) {
          unlinkSync(lock);
          continue;
        }
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
      }
      if (Date.now() >= deadline) throw new Error("Registry write is busy; retry the operation.");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { return operation(); }
  finally { closeSync(fd); unlinkSync(lock); }
}

export function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export function atomicJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const staging = path + "." + process.pid + ".tmp";
  try {
    writeFileSync(staging, JSON.stringify(value) + "\n", { mode: 0o600 });
    renameSync(staging, path);
  } finally {
    try { unlinkSync(staging); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
