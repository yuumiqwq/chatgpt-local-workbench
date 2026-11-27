import { spawn, execFileSync, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { signalExecution } from "../executors/executor.js";
import { absolutePath, checkAncestors, HostError, HostPolicy } from "./host-policy.js";
import { safeLocalPath, TransferRequestSchema, type TransferPeer, type TransferPolicy, type TransferRequest } from "./transfer-policy.js";

const fail = (code: string, message: string) => new HostError("HOST_TRANSFER_" + code, message);
const portable = (value: string) => value.replaceAll("\\", "/");
const quote = (value: string) => `"${portable(value)}"`;

// Config values have already rejected quotes, expansion tokens and controls.
// An empty -F file suppresses both user and system SSH configuration.
export function sftpArguments(config: TransferPolicy, peer: TransferPeer, emptyConfig: string): string[] {
  const options = [
    "BatchMode=yes", "PreferredAuthentications=publickey", "PubkeyAuthentication=yes",
    "PasswordAuthentication=no", "KbdInteractiveAuthentication=no", "HostbasedAuthentication=no",
    "GSSAPIAuthentication=no", "IdentitiesOnly=yes", "IdentityAgent=none", "CertificateFile=none",
    `IdentityFile=${quote(peer.identity_file)}`, "StrictHostKeyChecking=yes",
    `UserKnownHostsFile=${quote(peer.known_hosts_file)}`, "GlobalKnownHostsFile=none",
    "KnownHostsCommand=none", "VerifyHostKeyDNS=no", "UpdateHostKeys=no", "AddKeysToAgent=no",
    "ForwardAgent=no", "ForwardX11=no", "ClearAllForwardings=yes", "PermitLocalCommand=no",
    "ProxyCommand=none", "ProxyJump=none", "ControlMaster=no", "ControlPath=none",
    "ControlPersist=no", "CanonicalizeHostname=no", "ConnectionAttempts=1", "ConnectTimeout=10",
    "ServerAliveInterval=5", "ServerAliveCountMax=2", "RequestTTY=no", `User=${peer.user}`
  ];
  return ["-F", emptyConfig, "-S", config.ssh_executable!, "-b", "-", "-B", "32768", "-R", "1",
    "-P", String(peer.port), ...options.flatMap(value => ["-o", value]),
    peer.host.includes(":") ? `[${peer.host}]` : peer.host];
}

export interface SftpJob {
  executable: string;
  args: string[];
  cwd: string;
  batch: string;
  temporaryFile: string;
  maxBytes: number;
}
export type SftpRunner = (job: SftpJob, signal: AbortSignal) => Promise<void>;
export type SftpStarter = (executable: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

// Only the process boundary is injectable for offline integration tests.
export async function runSftp(job: SftpJob, signal: AbortSignal, start: SftpStarter = spawn): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { LANG: "C", LC_ALL: "C" };
    for (const key of ["SystemRoot", "WINDIR"]) if (process.env[key]) env[key] = process.env[key];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = start(job.executable, job.args, { cwd: job.cwd, env, shell: false, windowsHide: true,
        detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    } catch { reject(fail("PROCESS_FAILED", "The configured SFTP client could not be started.")); return; }
    let failure: Error | undefined;
    let finished = false;
    let checking = false;
    let outputBytes = 0;
    let grace: NodeJS.Timeout | undefined;
    const stop = (error: Error) => {
      if (finished || failure) return;
      failure = error;
      signalExecution(child, process.platform, "SIGKILL", true, (_command, args, options) => {
        // Never search the destination directory or PATH for taskkill.
        execFileSync(join(process.env.SystemRoot ?? "C:/Windows", "System32/taskkill.exe"), args, options);
      });
      grace = setTimeout(() => finish(fail("CLEANUP_FAILED", "SFTP termination was not confirmed; inspect the transfer staging directory.")), 3000);
    };
    const abort = () => stop(signal.reason instanceof Error ? signal.reason : fail("CANCELLED", "The transfer was cancelled."));
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearInterval(monitor);
      clearTimeout(grace);
      signal.removeEventListener("abort", abort);
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (error) reject(error); else resolve();
    };
    // OpenSSH writes directly to disk. Monitor growth while running; final size
    // validation is mandatory even when a fast transfer finishes between polls.
    const monitor = setInterval(() => {
      if (checking || finished || failure) return;
      checking = true;
      void lstat(job.temporaryFile).then(info => {
        if (!info.isFile() || info.nlink !== 1) stop(fail("FILE_UNSUPPORTED", "The staged file is not a private regular file."));
        else if (info.size > job.maxBytes) stop(fail("SIZE_LIMIT", "The download exceeded the expected byte limit."));
      }).catch(() => stop(fail("IO_FAILED", "The staging file could not be inspected.")))
        .finally(() => { checking = false; });
    }, 25);
    const discard = (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 65_536) stop(fail("OUTPUT_LIMIT", "SFTP exceeded the diagnostic output limit."));
    };
    child.stdout.on("data", discard); child.stderr.on("data", discard);
    child.on("error", () => stop(fail("PROCESS_FAILED", "The configured SFTP client failed.")));
    child.stdin.on("error", () => stop(fail("PROCESS_FAILED", "SFTP batch input failed.")));
    child.stdout.on("error", () => stop(fail("PROCESS_FAILED", "SFTP output failed.")));
    child.stderr.on("error", () => stop(fail("PROCESS_FAILED", "SFTP output failed.")));
    child.once("close", code => finish(failure ?? (code === 0 ? undefined :
      fail("PROCESS_FAILED", "SFTP failed; check source access, pinned host key and key authentication locally."))));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else child.stdin.end(job.batch);
  });
}

async function regularFile(path: string, executable = false) {
  absolutePath(path);
  await checkAncestors(path);
  const info = await lstat(path);
  if (!info.isFile() || !executable && info.nlink !== 1 || executable && process.platform === "win32" && !/\.exe$/iu.test(path)) {
    throw fail("CONFIG_INVALID", "Transfer configuration requires regular files and native executables.");
  }
}

export function transferCapabilities(policy: HostPolicy) {
  const config = policy.config.transfer;
  return { enabled: policy.config.enabled && config.enabled, transport: "openssh_sftp", max_bytes: config.max_bytes,
    timeout_ms: config.timeout_ms, max_active: 1,
    peers: Object.fromEntries(Object.entries(config.peers).map(([alias, peer]) => [alias, { read_roots: Object.keys(peer.read_roots) }])) };
}

export class HostTransfers {
  private busy = false;
  private readonly lifetime = new AbortController();
  constructor(private readonly policy: HostPolicy, private readonly run: SftpRunner = runSftp) {}
  dispose() { this.lifetime.abort(fail("CANCELLED", "The host connection closed.")); }

  async transfer(input: TransferRequest, signal?: AbortSignal) {
    const config = this.policy.config.transfer;
    if (!this.policy.config.enabled || !config.enabled) throw fail("DISABLED", "File transfers are not enabled.");
    const parsed = TransferRequestSchema.safeParse(input);
    if (!parsed.success) throw fail("INVALID_ARGUMENT", "Invalid transfer parameters or non-literal file path.");
    const request = parsed.data;
    const peer = Object.hasOwn(config.peers, request.source_peer) ? config.peers[request.source_peer] : undefined;
    const root = peer && Object.hasOwn(peer.read_roots, request.source_root) ? peer.read_roots[request.source_root] : undefined;
    if (!peer || !root) throw fail("SOURCE_DENIED", "The source peer or read root alias is not configured.");
    if (request.expected_bytes > config.max_bytes) throw fail("SIZE_LIMIT", "Expected bytes exceed the configured transfer limit.");
    if (this.busy) throw fail("BUSY", "Another file transfer is active on this host.");
    this.busy = true;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(fail("TIMEOUT", "The transfer deadline expired.")), config.timeout_ms);
    const bounded = AbortSignal.any([this.lifetime.signal, deadline.signal, ...(signal ? [signal] : [])]);
    let staging: string | undefined;
    let terminationUnconfirmed = false;
    try {
      bounded.throwIfAborted();
      await Promise.all([regularFile(config.executable!, true), regularFile(config.ssh_executable!, true),
        regularFile(peer.identity_file), regularFile(peer.known_hosts_file)]);
      // Transfers never follow destination links, even when ordinary reads do.
      await checkAncestors(request.destination);
      const destination = await this.policy.check(request.destination, "write");
      if (!safeLocalPath(destination)) throw fail("INVALID_ARGUMENT", "The canonical destination contains unsupported syntax.");
      await checkAncestors(destination);
      const parent = dirname(destination);
      await this.policy.check(parent, "write");
      if (!(await lstat(parent)).isDirectory()) throw fail("DESTINATION_INVALID", "The destination parent must already exist.");
      try {
        await lstat(destination);
        throw fail("DESTINATION_EXISTS", "The destination already exists.");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      staging = await mkdtemp(join(parent, ".workbench-transfer-"));
      const temporaryFile = join(staging, "payload");
      const emptyConfig = join(staging, "ssh_config");
      await writeFile(emptyConfig, "", { flag: "wx", mode: 0o600 });
      const initial = await open(temporaryFile, "wx", 0o600);
      await initial.close();
      bounded.throwIfAborted();
      await this.run({ executable: config.executable!, args: sftpArguments(config, peer, emptyConfig), cwd: staging,
        batch: `get ${quote(root + "/" + request.source_path)} "payload"\nquit\n`,
        temporaryFile, maxBytes: request.expected_bytes }, bounded);
      bounded.throwIfAborted();
      await checkAncestors(temporaryFile);
      const info = await lstat(temporaryFile);
      if (!info.isFile() || info.nlink !== 1) throw fail("FILE_UNSUPPORTED", "Only a private regular file can be published.");
      if (info.size !== request.expected_bytes) throw fail("SIZE_MISMATCH", "Downloaded bytes differ from expected_bytes.");
      const handle = await open(temporaryFile, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      let sha256: string;
      try {
        const opened = await handle.stat();
        if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== info.size || opened.nlink !== 1) {
          throw fail("FILE_CHANGED", "The staging file changed before verification.");
        }
        const hash = createHash("sha256");
        const buffer = Buffer.alloc(65_536);
        let bytes = 0;
        for (;;) {
          bounded.throwIfAborted();
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          bytes += bytesRead;
          if (bytes > request.expected_bytes) throw fail("SIZE_LIMIT", "The staged file exceeded the expected byte limit.");
          hash.update(buffer.subarray(0, bytesRead));
        }
        sha256 = hash.digest("hex");
        if (bytes !== request.expected_bytes || sha256 !== request.expected_sha256) {
          throw fail("HASH_MISMATCH", "Downloaded content differs from the expected SHA-256 or byte count.");
        }
        await handle.sync();
      } finally { await handle.close(); }
      await checkAncestors(destination);
      await checkAncestors(temporaryFile);
      const finalInfo = await lstat(temporaryFile);
      if (finalInfo.ino !== info.ino || finalInfo.dev !== info.dev || finalInfo.size !== info.size ||
          finalInfo.mtimeMs !== info.mtimeMs || finalInfo.ctimeMs !== info.ctimeMs || finalInfo.nlink !== 1 ||
          relative(await this.policy.check(destination, "write"), destination) !== "") {
        throw fail("FILE_CHANGED", "The destination or staged file changed during verification.");
      }
      bounded.throwIfAborted();
      // link is an atomic create-if-absent on the same filesystem. rename would
      // overwrite on POSIX; COPYFILE_EXCL would expose a partial destination.
      try { await link(temporaryFile, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw fail("DESTINATION_EXISTS", "The destination already exists.");
        throw fail("PUBLISH_FAILED", "Atomic publication failed; the destination filesystem must support hard links.");
      }
      return { source_peer: request.source_peer, source_root: request.source_root, source_path: request.source_path,
        destination, bytes: info.size, sha256, transport: "openssh_sftp" };
    } catch (error) {
      terminationUnconfirmed = error instanceof HostError && error.code === "HOST_TRANSFER_CLEANUP_FAILED";
      if (terminationUnconfirmed) this.lifetime.abort(error);
      // Preserve a runner's first failure when the deadline expires during
      // process-tree cleanup; only translate untyped AbortSignal reasons.
      if (!(error instanceof HostError) && bounded.aborted) {
        if (deadline.signal.aborted) throw deadline.signal.reason;
        throw fail("CANCELLED", "The transfer was cancelled.");
      }
      throw error;
    } finally {
      clearTimeout(timer);
      try { if (staging && !terminationUnconfirmed) await rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
      finally { this.busy = false; }
    }
  }
}
