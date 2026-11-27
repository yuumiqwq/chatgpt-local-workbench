import { isAbsolute } from "node:path";
import { isIP } from "node:net";
import { z } from "zod";

export const TRANSFER_MAX_BYTES = 512 * 1024 * 1024;
export const transferAlias = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u);
const unsafe = /[\p{Cc}\p{Cf}\u2028\u2029"'`$!;|&<>*?\[\]{}%]/u;

export function safeRelativePath(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && !unsafe.test(value) && !/[\\:]/u.test(value) &&
    value.split("/").every(part => part !== "" && part !== "." && part !== ".." &&
      !/[. ]$/u.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part));
}

export function safeLocalPath(value: string): boolean {
  if (!isAbsolute(value) || unsafe.test(value)) return false;
  if (process.platform === "win32" && !/^[a-zA-Z]:[\\/]/u.test(value)) return false;
  const portable = value.replaceAll("\\", "/");
  return safeRelativePath(portable.replace(/^(?:[a-zA-Z]:)?\//u, ""));
}

const localPath = z.string().max(4096).refine(safeLocalPath, "Use an absolute local path without special syntax.");
const remoteRoot = z.string().max(4096).refine(value => value.startsWith("/") &&
  safeRelativePath(value.replace(/^\/(?:[a-zA-Z]:\/)?/u, "")),
"Use a specific absolute SFTP read root, with forward slashes and no trailing slash.");
const peerSchema = z.object({
  host: z.string().max(253).refine(value => isIP(value) !== 0 ||
    /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/u.test(value), "Use a fixed IP or DNS name."),
  port: z.number().int().min(1).max(65535).default(22),
  user: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/u),
  identity_file: localPath,
  known_hosts_file: localPath,
  read_roots: z.record(transferAlias, remoteRoot).refine(value => Object.keys(value).length > 0)
}).strict();

export const TransferPolicySchema = z.object({
  enabled: z.boolean().default(false),
  executable: localPath.optional(),
  ssh_executable: localPath.optional(),
  max_bytes: z.number().int().min(1).max(TRANSFER_MAX_BYTES).default(TRANSFER_MAX_BYTES),
  timeout_ms: z.number().int().min(1000).max(600_000).default(120_000),
  peers: z.record(transferAlias, peerSchema).default({})
}).strict().superRefine((value, context) => {
  if (value.enabled && (!value.executable || !value.ssh_executable || !Object.keys(value.peers).length)) {
    context.addIssue({ code: z.ZodIssueCode.custom,
      message: "Enabled transfers require absolute SFTP and SSH executables and configured source peers." });
  }
});

export type TransferPolicy = z.infer<typeof TransferPolicySchema>;
export type TransferPeer = z.infer<typeof peerSchema>;

export const transferInput = {
  source_peer: transferAlias,
  source_root: transferAlias,
  source_path: z.string().refine(safeRelativePath, "Use a relative literal file path with forward slashes."),
  destination: localPath,
  expected_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  expected_bytes: z.number().int().min(0).max(TRANSFER_MAX_BYTES)
};
export const TransferRequestSchema = z.object(transferInput).strict();
export type TransferRequest = z.infer<typeof TransferRequestSchema>;
