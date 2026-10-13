import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { EXPORT_MAX_FILE_BYTES, EXPORT_TTL_SECONDS } from "./export-limits.js";

const PolicySchema = z.object({
  version: z.literal(1),
  enabled: z.boolean().default(false),
  follow_links: z.boolean().default(false),
  read_roots: z.array(z.string().min(1)).default([]),
  export_roots: z.array(z.string().min(1)).default([]),
  export_max_bytes: z.number().int().min(1).max(EXPORT_MAX_FILE_BYTES).default(EXPORT_MAX_FILE_BYTES),
  export_ttl_seconds: z.number().int().min(30).max(EXPORT_TTL_SECONDS).default(EXPORT_TTL_SECONDS),
  write_roots: z.array(z.string().min(1)).default([]),
  command_roots: z.array(z.string().min(1)).default([]),
  commands_enabled: z.boolean().default(false),
  codex_homes: z.array(z.string().min(1)).default([]),
  protected_paths: z.array(z.string().min(1)).default([])
}).strict();

export type HostPolicyConfig = z.infer<typeof PolicySchema>;

export class HostError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function containsPath(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
}

export function absolutePath(value: string): string {
  if (!isAbsolute(value) || value.includes("\0") || value.split(/[\\/]/u).includes("..")) {
    throw new HostError("HOST_PATH_DENIED", "An absolute path without parent traversal is required.");
  }
  if (process.platform === "win32") {
    const tail = value.slice(parse(value).root.length);
    if (value.startsWith("\\\\") || /[<>:"|?*]/u.test(tail) ||
        tail.split(/[\\/]/u).some(part => /[. ]$/u.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
      throw new HostError("HOST_PATH_DENIED", "Device, network and alternate-stream paths are not supported.");
    }
  }
  return normalize(value);
}

// All ancestors are checked. Host file operations intentionally do not follow
// symlinks or junctions, including links located inside an allowed directory.
export async function checkAncestors(path: string): Promise<void> {
  let current = path;
  for (;;) {
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new HostError("HOST_PATH_DENIED", "Symbolic links and junctions are not supported.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export async function existingCanonicalPath(
  path: string,
  resolveExisting: (path: string) => Promise<string> = realpath
): Promise<string> {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try { return resolve(await resolveExisting(current), ...missing.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(parse(current).base);
      current = parent;
    }
  }
}

// Protected paths may not exist yet. Resolve their nearest existing ancestor
// so aliases use the same representation as paths returned by check().
// A missing leaf is supported; failure to resolve its storage root must fail
// policy loading rather than silently keeping an incomparable alias.
const canonicalProtectionPath = (path: string) => existingCanonicalPath(path);

export class HostPolicy {
  private constructor(
    readonly config: HostPolicyConfig,
    readonly policyPath: string,
    private readonly canonicalReadRoots: readonly string[],
    private readonly canonicalExportRoots: readonly string[],
    private readonly canonicalWriteRoots: readonly string[],
    private readonly canonicalCommandRoots: readonly string[],
    private readonly protectedPaths: readonly string[],
    private readonly canonicalPolicyPath: string,
    private readonly auditPrefixes: readonly string[],
    private readonly credentialPaths: readonly string[]
  ) {}

  static async load(policyPath: string): Promise<HostPolicy> {
    let source: unknown = { version: 1 };
    try {
      source = JSON.parse((await readFile(policyPath, "utf8")).replace(/^\uFEFF/u, ""));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return HostPolicy.create(source, policyPath);
  }

  static async create(source: unknown, policyPath: string): Promise<HostPolicy> {
    const config = PolicySchema.parse(source);
    const canonicalRoots = async (roots: readonly string[]) => {
      const result: string[] = [];
      for (const root of roots) {
        const path = absolutePath(root);
        if (!config.follow_links) await checkAncestors(path);
        if (!(await lstat(path)).isDirectory()) throw new Error("Host policy roots must be existing directories.");
        result.push(await realpath(path));
      }
      return result;
    };
    const [readRoots, writeRoots, commandRoots] = await Promise.all([
      canonicalRoots(config.read_roots), canonicalRoots(config.write_roots),
      canonicalRoots(config.command_roots)
    ]);
    const exportRoots: string[] = [];
    for (const root of config.export_roots) {
      const path = absolutePath(root);
      // Export authorization is independent of ordinary read/link settings.
      await checkAncestors(path);
      if (!(await lstat(path)).isDirectory()) throw new Error("Export roots must be existing directories.");
      const canonical = await realpath(path);
      if (relative(parse(canonical).root, canonical) === "" ||
          !readRoots.some(readRoot => containsPath(readRoot, canonical))) {
        throw new Error("Export roots must be specific directories within read_roots, never an entire volume.");
      }
      exportRoots.push(canonical);
    }
    for (const home of config.codex_homes) {
      absolutePath(home);
      if (!config.follow_links) await checkAncestors(home);
      if (!(await lstat(home)).isDirectory()) throw new Error("Codex homes must exist.");
    }
    const protectedPaths = config.protected_paths.map(absolutePath);
    if (process.platform === "win32") {
      for (const key of ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"]) {
        const path = process.env[key];
        if (path) protectedPaths.push(absolutePath(path));
      }
    } else {
      protectedPaths.push("/etc", "/usr", "/bin", "/sbin", "/boot", "/proc", "/sys", "/dev");
    }
    const checkedPolicyPath = absolutePath(policyPath);
    const [canonicalProtectedPaths, canonicalPolicyPath, credentialPaths] = await Promise.all([
      Promise.all(protectedPaths.map(canonicalProtectionPath)),
      existingCanonicalPath(checkedPolicyPath),
      Promise.all([...config.codex_homes, join(homedir(), ".codex")]
        .map(home => canonicalProtectionPath(join(home, "auth.json"))))
    ]);
    // Audit filenames are formed by appending to the configured policy path.
    // A short alias of the policy filename does not extend to its audit siblings.
    const configuredAuditPrefix = join(await existingCanonicalPath(dirname(checkedPolicyPath)),
      parse(checkedPolicyPath).base + ".audit");
    return new HostPolicy(config, checkedPolicyPath, readRoots, exportRoots, writeRoots, commandRoots,
      [...protectedPaths, ...canonicalProtectedPaths], canonicalPolicyPath,
      [configuredAuditPrefix, canonicalPolicyPath + ".audit"], credentialPaths);
  }

  isWriteRoot(canonicalPath: string): boolean {
    return this.canonicalWriteRoots.some(root => relative(root, canonicalPath) === "");
  }

  async checkExport(pathValue: string): Promise<string> {
    if (this.canonicalExportRoots.length === 0) {
      throw new HostError("HOST_EXPORT_DISABLED", "Configure export_roots to authorize file delivery.");
    }
    await checkAncestors(absolutePath(pathValue));
    const canonical = await this.check(pathValue, "read");
    await checkAncestors(canonical);
    const name = parse(canonical).base;
    const parts = canonical.toLowerCase().split(/[\\/]/u);
    const secret = parts.some(part => [".git", ".codex", ".gnupg", ".kube"].includes(part)) ||
      /^(?:auth\.json|credentials(?:\..*)?|tokens?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|\.npmrc|\.netrc|\.git-credentials)$/iu.test(name) ||
      /\.(?:pem|key|p12|pfx|kdbx)$/iu.test(name);
    const comparison = process.platform === "win32" ? canonical.toLowerCase() : canonical;
    if (!this.canonicalExportRoots.some(root => containsPath(root, canonical)) || secret ||
        this.protectedPaths.some(root => containsPath(root, canonical)) ||
        relative(this.canonicalPolicyPath, canonical) === "" ||
        this.auditPrefixes.some(prefix => comparison.startsWith(process.platform === "win32" ? prefix.toLowerCase() : prefix))) {
      throw new HostError("HOST_EXPORT_DENIED", "Only authorized, non-credential files inside export_roots can be exported.");
    }
    return canonical;
  }

  async check(pathValue: string, access: "read" | "write" | "command"): Promise<string> {
    if (!this.config.enabled) throw new HostError("HOST_DISABLED", "Host operations are not enabled by the local administrator.");
    if (access === "command" && !this.config.commands_enabled) {
      throw new HostError("HOST_COMMAND_DISABLED", "Host command execution is not enabled.");
    }
    const path = absolutePath(pathValue);
    const roots = access === "read" ? this.canonicalReadRoots :
      access === "write" ? this.canonicalWriteRoots : this.canonicalCommandRoots;
    if (!this.config.follow_links) await checkAncestors(path);
    const canonical = await existingCanonicalPath(path);
    if (!roots.some(root => containsPath(root, canonical))) {
      throw new HostError("HOST_PATH_DENIED", "The path is outside the configured roots.");
    }
    // The command's cwd is a starting directory, not an OS sandbox. Arbitrary
    // commands are a separate administrator opt-in and can access other paths.
    if (access !== "command") {
      const parts = canonical.split(/[\\/]/u);
      const secretName = parts.some(part => [".ssh", ".aws", ".azure", "tunnel-secrets"].includes(part.toLowerCase())) ||
        /^\.env(?:$|\.(?!example$|sample$))/iu.test(parse(canonical).base);
      if (secretName || this.credentialPaths.some(secret => relative(secret, canonical) === "")) {
        throw new HostError("HOST_PATH_DENIED", "Credential files are not exposed by host file tools.");
      }
    }
    const comparisonPath = process.platform === "win32" ? canonical.toLowerCase() : canonical;
    if (access === "write" && (
      this.protectedPaths.some(root => containsPath(root, canonical)) ||
      relative(this.canonicalPolicyPath, canonical) === "" ||
      this.auditPrefixes.some(prefix => comparisonPath.startsWith(
        process.platform === "win32" ? prefix.toLowerCase() : prefix))
    )) throw new HostError("HOST_PATH_DENIED", "The path is protected from host file writes.");
    return canonical;
  }
}
