import { readFileSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";

import { CoreError } from "../core/errors.js";
import { atomicJson, withFileStoreLock } from "../core/file-store.js";
import { isId, newId } from "../core/ids.js";
import type { Id } from "../core/ids.js";

interface ManagedWorkspaceRecord {
  readonly id: Id;
  readonly root: string;
}

const MANAGED_WORKSPACES_VERSION = 2;
const LEGACY_MANAGED_WORKSPACES_VERSION = 1;

export class ManagedWorkspaceCatalog {
  private records = new Map<string, ManagedWorkspaceRecord>();

  constructor(private readonly stateFilePath?: string) {}

  async load(): Promise<void> {
    if (this.stateFilePath === undefined) return;
    if (this.records.size !== 0) throw new CoreError("INTERNAL_ERROR");
    this.withLock(() => {
      const { records, needsMigration } = this.read();
      if (needsMigration) this.persist(records);
      this.records = records;
    });
  }

  entries(): ManagedWorkspaceRecord[] {
    return [...this.records.values()];
  }

  async registerOnce(root: string): Promise<{ id: Id; created: boolean }> {
    return this.withLock(() => {
      // Re-read inside the lock so another process's registrations and IDs survive.
      const { records, needsMigration } = this.read();
      const existing = records.get(root);
      if (existing !== undefined) {
        if (needsMigration) this.persist(records);
        this.records = records;
        return { id: existing.id, created: false };
      }
      const id = newId();
      records.set(root, { id, root });
      this.persist(records);
      this.records = records;
      return { id, created: true };
    });
  }

  private withLock<T>(operation: () => T): T {
    try {
      return this.stateFilePath === undefined ? operation() : withFileStoreLock(this.stateFilePath, operation);
    } catch {
      throw new CoreError("INTERNAL_ERROR");
    }
  }

  private read(): { records: Map<string, ManagedWorkspaceRecord>; needsMigration: boolean } {
    if (this.stateFilePath === undefined) return { records: new Map(this.records), needsMigration: false };
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.stateFilePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: new Map(), needsMigration: false };
      throw error;
    }
    if (!isObject(value) ||
        (value.version !== MANAGED_WORKSPACES_VERSION && value.version !== LEGACY_MANAGED_WORKSPACES_VERSION) ||
        !Array.isArray(value.workspaces)) {
      throw new CoreError("INTERNAL_ERROR");
    }
    const records = new Map<string, ManagedWorkspaceRecord>();
    const ids = new Set<string>();
    for (const item of value.workspaces) {
      if (!isObject(item)) continue;
      const { id, root } = item;
      if (typeof id !== "string" || !isId(id) ||
          typeof root !== "string" || root.length === 0 ||
          !isAbsolute(root) || normalize(root) !== root || ids.has(id) || records.has(root)) {
        continue; // Skip individually invalid or duplicate records.
      }
      ids.add(id);
      records.set(root, { id, root });
    }
    return { records, needsMigration: value.version === LEGACY_MANAGED_WORKSPACES_VERSION };
  }

  private persist(records: Map<string, ManagedWorkspaceRecord>): void {
    if (this.stateFilePath !== undefined) {
      atomicJson(this.stateFilePath, { version: MANAGED_WORKSPACES_VERSION, workspaces: [...records.values()] });
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
