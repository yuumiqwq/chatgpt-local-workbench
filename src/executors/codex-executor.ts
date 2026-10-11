import { spawn } from "node:child_process";
import { relative } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CoreError, CodexRpcError, CodexRpcTimeoutError, serializeError, type CodexRpcMethod } from "../core/errors.js";
import { VERSION } from "../version.js";
import { startCodexAppServer, type ProcessStarter } from "./codex-process.js";
export type { ProcessStarter } from "./codex-process.js";
import {
  DEFAULT_EXECUTOR_TIMING,
  signalExecution,
  signalProcessGroup,
  type Executor,
  type ExecutorEvidence,
  type ExecutorRequest,
  type ExecutorResult,
  type ExecutorTiming
} from "./executor.js";
import { codexExecutorTimingFromEnvironment } from "../runtime-config.js";

const MAX_EVIDENCE = 50;
const MAX_TEXT = 16_384;
const MAX_EVIDENCE_BYTES = 65_536;
// Bound wire messages separately from the smaller caller-facing evidence budget.
// Large agent messages may contain a complete patch; never truncate that patch.
const MAX_JSONL_LINE_BYTES = 1_048_576;
const DEFAULT_RPC_CALL_TIMEOUT_MS = 30_000;
const ACTIVE_WRITER_MESSAGE = /^thread [0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12} already has an active writer$/iu;
// Machine- and human-readable marker appended to any bounded evidence string
// that was cut by MAX_TEXT, and the basis of the synthetic change/evidence
// entries that make list and count truncation visible.
const TRUNCATION_MARKER = "[truncated]";

function failure(code: "CODEX_UNAVAILABLE" | "CODEX_PROTOCOL_ERROR" | "CODEX_EXECUTION_FAILED" | "CODEX_TURN_FAILED" | "CODEX_RPC_TIMEOUT" | "EXECUTION_DEADLINE_EXCEEDED" | "EXECUTOR_STALLED"): ExecutorResult {
  return { kind: "failed", error: serializeError(new CoreError(code)) };
}
function failedTurn(turn: Record<string, unknown>): ExecutorResult {
  const error = object(turn.error) ? turn.error : undefined;
  if (error?.codexErrorInfo === "serverOverloaded") {
    return {
      kind: "failed",
      error: {
        code: "CODEX_EXECUTION_FAILED",
        message: "Codex execution failed: the selected model is at capacity."
      }
    };
  }
  return failure("CODEX_TURN_FAILED");
}
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function bounded(value: unknown): string {
  if (typeof value !== "string") return "";
  if (value.length <= MAX_TEXT) return value;
  // The marker must fit inside the MAX_TEXT budget: its length plus the
  // newline separator is deducted from the retained content, so the final
  // string never exceeds MAX_TEXT.
  const retained = MAX_TEXT - TRUNCATION_MARKER.length - 1;
  return `${value.slice(0, retained)}\n${TRUNCATION_MARKER}`;
}

export class CodexExecutor implements Executor {
  private child: ChildProcessWithoutNullStreams | undefined;
  private threadId?: string;
  private turnId: string | undefined;
  private startedTurnId: string | undefined;
  private nextId = 1;
  private pending = new Map<number, {
    method: CodexRpcMethod;
    resolve: (value: unknown) => void;
    reject: (reason?: CoreError) => void;
    timer: NodeJS.Timeout;
  }>();
  private beginInterrupt: (() => void) | undefined;

  constructor(private readonly workspaceRoot: string, private readonly startProcess: ProcessStarter = spawn,
    private readonly hostEnvironment: Readonly<NodeJS.ProcessEnv> = process.env,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly timing: ExecutorTiming = codexExecutorTimingFromEnvironment(hostEnvironment)) {}

  async execute(request: ExecutorRequest): Promise<ExecutorResult> {
    const resumeFromPath = request.threadPath !== undefined &&
      (request.threadHome === undefined || this.hostEnvironment.CODEX_HOME === undefined ||
        relative(this.hostEnvironment.CODEX_HOME, request.threadHome) !== "");
    const executorStartedAt = new Date().toISOString();
    const withDiagnostics = (result: ExecutorResult): ExecutorResult => ({
      ...result,
      diagnostics: {
        executor_started_at: executorStartedAt,
        executor_ended_at: new Date().toISOString()
      }
    });
    this.turnId = undefined;
    this.startedTurnId = undefined;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = startCodexAppServer(this.workspaceRoot, this.hostEnvironment, this.platform, this.startProcess);
      this.child = child;
    } catch { return withDiagnostics(failure("CODEX_UNAVAILABLE")); }

    const evidence = new Map<string, ExecutorEvidence>();
    const activeCommandItems = new Set<string>();
    let activeCommand: { id: string; command?: string } | undefined;
    let evidenceDropped = 0;
    let output = "";
    let buffer = "";
    let terminal: ((result: ExecutorResult) => void) | undefined;
    let terminalPromise: Promise<ExecutorResult>;
    terminalPromise = new Promise((resolve) => { terminal = resolve; });
    let settled = false;
    let directExited = false;
    let deadlineTimer: NodeJS.Timeout | undefined;
    let inactivityTimer: NodeJS.Timeout | undefined;
    let interruptTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let exitImmediate: NodeJS.Immediate | undefined;
    let terminationResult: ExecutorResult | undefined;
    let killSignalled = false;
    const rejectPending = (reason = new CoreError("CODEX_EXECUTION_FAILED")): void => {
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(reason);
      }
      this.pending.clear();
    };
    const finish = (result: ExecutorResult): void => {
      if (settled) return;
      const finalResult = terminationResult?.kind === "interrupted"
        ? { ...terminationResult, output, evidence: visibleEvidence() }
        : terminationResult?.kind === "failed"
          ? { ...terminationResult, ...(this.threadId === undefined ? {} : { threadId: this.threadId }),
            ...((this.threadId !== undefined || evidence.size > 0 || evidenceDropped > 0) ? { evidence: visibleEvidence() } : {}) }
          : result;
      settled = true;
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
      if (interruptTimer !== undefined) clearTimeout(interruptTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (exitImmediate !== undefined) clearImmediate(exitImmediate);
      rejectPending();
      if (this.child === child) {
        this.child = undefined;
        this.turnId = undefined;
        this.startedTurnId = undefined;
        this.beginInterrupt = undefined;
      }
      // Every protocol terminal event ends this one-shot app-server, including
      // a cooperative interrupt completion. Settling the Bridge task must not
      // leave a detached process tree alive.
      if (!killSignalled) {
        if (directExited) {
          signalProcessGroup(child, this.platform, "SIGTERM");
          signalProcessGroup(child, this.platform, "SIGKILL");
        } else {
          signalExecution(child, this.platform, "SIGTERM");
          signalExecution(child, this.platform, "SIGKILL");
        }
        killSignalled = true;
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      terminal?.(withDiagnostics(finalResult));
    };
    const stop = (result: ExecutorResult): void => {
      if (settled) return;
      terminationResult = result;
      signalExecution(child, this.platform, "SIGKILL");
      killSignalled = true;
      finish(result);
    };
    const unavailable = (): void => stop(failure("CODEX_UNAVAILABLE"));
    // The evidence view a caller receives. Real evidence and the synthetic
    // evidence-drop marker together never exceed MAX_EVIDENCE: the marker only
    // appears once real entries were evicted, and the eviction loop above
    // reserves its slot within the same budget. Rebuilt from a single counter,
    // it can never grow evidence unboundedly.
    const visibleEvidence = (): readonly ExecutorEvidence[] => {
      const items = [...evidence.values()];
      return evidenceDropped === 0
        ? items
        : [...items, {
          id: "evidence-drop",
          type: "commandExecution",
          status: "completed",
          command: `${evidenceDropped} evidence item(s) dropped: evidence limit exceeded`
        }];
    };
    const enforceEvidenceBudget = (): void => {
      while (evidence.size > 0 &&
        Buffer.byteLength(JSON.stringify(visibleEvidence()), "utf8") > MAX_EVIDENCE_BYTES) {
        evidence.delete(evidence.keys().next().value as string);
        evidenceDropped += 1;
      }
    };
    const currentTerminationResult = (): ExecutorResult =>
      terminationResult?.kind === "interrupted"
        ? {
          kind: "interrupted",
          output,
          ...(this.threadId === undefined ? {} : { threadId: this.threadId }),
          evidence: visibleEvidence()
        }
        : terminationResult?.kind === "failed"
          ? { ...terminationResult, ...(this.threadId === undefined ? {} : { threadId: this.threadId }),
            ...((this.threadId !== undefined || evidence.size > 0 || evidenceDropped > 0) ? { evidence: visibleEvidence() } : {}) }
          : failure("CODEX_EXECUTION_FAILED");
    const forceKill = (): void => {
      signalExecution(child, this.platform, "SIGKILL", !directExited);
      killSignalled = true;
      finish(currentTerminationResult());
    };
    const sendTerm = (): void => {
      if (settled) return;
      signalExecution(child, this.platform, "SIGTERM");
      killTimer = setTimeout(forceKill, this.timing.killGraceMs);
    };
    const beginTermination = (result: ExecutorResult, cooperativeMs: number): void => {
      if (settled || terminationResult !== undefined) return;
      terminationResult = result;
      if (inactivityTimer !== undefined) {
        clearTimeout(inactivityTimer);
        inactivityTimer = undefined;
      }
      if (cooperativeMs === 0) sendTerm();
      else interruptTimer = setTimeout(sendTerm, cooperativeMs);
    };
    const reportActivity = (): void => {
      request.onActivity?.({
        at: new Date().toISOString(),
        ...(activeCommand === undefined ? {} : {
          active_item: { type: "commandExecution" as const, status: "inProgress",
            ...(activeCommand.command === undefined ? {} : { command: bounded(activeCommand.command) }) }
        })
      });
    };
    const startInactivityWatchdog = (): void => {
      if (settled || terminationResult !== undefined) return;
      if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
      const timeoutMs = activeCommandItems.size > 0
        ? this.timing.commandProtocolInactivityTimeoutMs
          ?? this.timing.protocolInactivityTimeoutMs
          ?? DEFAULT_EXECUTOR_TIMING.commandProtocolInactivityTimeoutMs
          ?? 15 * 60_000
        : this.timing.protocolInactivityTimeoutMs
          ?? DEFAULT_EXECUTOR_TIMING.protocolInactivityTimeoutMs
          ?? 5 * 60_000;
      inactivityTimer = setTimeout(
        () => beginTermination(failure("EXECUTOR_STALLED"), 0),
        timeoutMs
      );
    };
    const resetInactivityWatchdog = (): void => {
      if (inactivityTimer !== undefined) startInactivityWatchdog();
    };
    const activeTurnActivity = (params: Record<string, unknown>): boolean => {
      return this.threadId !== undefined &&
        this.startedTurnId !== undefined &&
        params.threadId === this.threadId &&
        params.turnId === this.startedTurnId;
    };
    this.beginInterrupt = () => {
      if (settled || terminationResult !== undefined) return;
      const result: ExecutorResult = { kind: "interrupted", output, evidence: visibleEvidence() };
      if (this.threadId !== undefined) Object.assign(result, { threadId: this.threadId });
      if (this.threadId && this.startedTurnId) {
        // The protocol request is best-effort. Its response is not the terminal
        // signal, and its Promise must never hold control_task open.
        void this.call("turn/interrupt", {
          threadId: this.threadId,
          turnId: this.startedTurnId
        }).catch((): void => {});
        beginTermination(result, this.timing.interruptGraceMs);
      } else {
        // initialize/thread-start/turn-start have no cooperative turn seam.
        beginTermination(result, 0);
      }
    };
    const beginDeadlineTermination = (): void => {
      const result = failure("EXECUTION_DEADLINE_EXCEEDED");
      if (this.threadId && this.startedTurnId) {
        void this.call("turn/interrupt", { threadId: this.threadId, turnId: this.startedTurnId }).catch((): void => {});
        beginTermination(result, this.timing.interruptGraceMs);
      } else {
        beginTermination(result, 0);
      }
    };
    deadlineTimer = setTimeout(beginDeadlineTermination, this.timing.executionTimeoutMs);
    child.on("error", unavailable);
    child.stdin.on("error", unavailable);
    child.stdout.on("error", unavailable);
    child.stderr.on("error", unavailable);
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const rawLine = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(rawLine, "utf8") > MAX_JSONL_LINE_BYTES) {
          finish(failure("CODEX_PROTOCOL_ERROR"));
          return;
        }
        const line = rawLine.trim();
        if (!line) continue;
        let message: unknown;
        try { message = JSON.parse(line); } catch { finish(failure("CODEX_PROTOCOL_ERROR")); return; }
        if (!object(message) || ("jsonrpc" in message && message.jsonrpc !== "2.0")) { finish(failure("CODEX_PROTOCOL_ERROR")); return; }
        if (typeof message.id === "number" && ("result" in message || "error" in message)) {
          if (!Number.isSafeInteger(message.id) || "method" in message || "params" in message ||
              ("result" in message && "error" in message)) { finish(failure("CODEX_PROTOCOL_ERROR")); return; }
          const waiter = this.pending.get(message.id);
          let responseError: CodexRpcError | undefined;
          if ("error" in message) {
            const rpcError = message.error;
            if (!object(rpcError) || typeof rpcError.code !== "number" || !Number.isSafeInteger(rpcError.code) ||
                typeof rpcError.message !== "string") { finish(failure("CODEX_PROTOCOL_ERROR")); return; }
            if (waiter) responseError = new CodexRpcError(waiter.method, rpcError.code,
              rpcError.code === -32600 && ACTIVE_WRITER_MESSAGE.test(rpcError.message) ? "thread_busy" : "unknown");
          }
          if (waiter) {
            this.pending.delete(message.id);
            clearTimeout(waiter.timer);
            responseError ? waiter.reject(responseError) : waiter.resolve(message.result);
          }
          continue;
        }
        if (typeof message.method !== "string" || !object(message.params)) { finish(failure("CODEX_PROTOCOL_ERROR")); return; }
        const isActiveTurnActivity = activeTurnActivity(message.params);
        if (message.method === "turn/started") {
          const turn = object(message.params.turn) ? message.params.turn : message.params;
          if (message.params.threadId === this.threadId &&
            typeof turn.id === "string" &&
            (!this.turnId || turn.id === this.turnId)) {
            this.startedTurnId = turn.id;
            reportActivity();
            startInactivityWatchdog();
          }
        }
        const item = object(message.params.item) ? message.params.item : undefined;
        if (isActiveTurnActivity && item?.type === "commandExecution" && typeof item.id === "string") {
          if (message.method === "item/started") {
            activeCommandItems.add(item.id);
            activeCommand = { id: item.id, ...(typeof item.command === "string" ? { command: item.command } : {}) };
          }
          if (message.method === "item/completed") {
            activeCommandItems.delete(item.id);
            if (activeCommand?.id === item.id) activeCommand = undefined;
          }
        }
        if (isActiveTurnActivity) { reportActivity(); resetInactivityWatchdog(); }
        if ((message.method === "item/started" || message.method === "item/completed") && item) {
          // Preserve unscoped notifications from older protocol versions, but
          // never let an explicitly different thread or turn replace our result.
          if ((message.params.threadId !== undefined && message.params.threadId !== this.threadId) ||
              (message.params.turnId !== undefined && message.params.turnId !== (this.startedTurnId ?? this.turnId))) continue;
          if (item.type === "agentMessage") {
            if (message.method === "item/completed" && typeof item.text !== "string") { finish(failure("CODEX_PROTOCOL_ERROR")); return; }
            if (message.method === "item/completed" && typeof item.text === "string") output = item.text;
          }
          const id = typeof item.id === "string" ? item.id : undefined;
          if (id && (item.type === "commandExecution" || item.type === "fileChange")) {
            const status = typeof item.status === "string" ? item.status : message.method === "item/started" ? "inProgress" : "completed";
            let entry: ExecutorEvidence;
            if (item.type === "commandExecution") entry = { id, type: item.type, status, command: bounded(item.command) };
            else {
              const rawChanges = Array.isArray(item.changes) ? item.changes : [];
              // The 50-entry bound includes the synthetic truncation marker: a
              // truncated list keeps 49 real entries and spends the 50th slot
              // on the marker, so the final list never exceeds the bound.
              const kept = rawChanges.length > 50 ? 49 : 50;
              const changes = rawChanges.slice(0, kept).filter(object).map((c) => ({ path: bounded(c.path), diff: bounded(c.diff) }));
              if (rawChanges.length > 50) {
                // omitted counts exactly the real changes that were never
                // returned to the caller.
                changes.push({ path: `[truncated: ${rawChanges.length - kept} additional changes omitted]`, diff: "" });
              }
              entry = { id, type: item.type, status, changes };
            }
            evidence.set(id, entry);
            // The MAX_EVIDENCE budget includes the evidence-drop marker: once
            // any drop has happened the marker reserves one slot within the
            // same budget, so the final visible list never exceeds
            // MAX_EVIDENCE entries.
            while (evidence.size + (evidenceDropped > 0 ? 1 : 0) > MAX_EVIDENCE) {
              evidence.delete(evidence.keys().next().value as string);
              evidenceDropped += 1;
            }
            enforceEvidenceBudget();
            request.onEvidence?.(visibleEvidence());
          }
        }
        if (message.method === "turn/completed") {
          const turn = object(message.params.turn) ? message.params.turn : message.params;
          if (message.params.threadId !== this.threadId ||
            typeof turn.id !== "string" ||
            turn.id !== (this.startedTurnId ?? this.turnId)) continue;
          const status = turn.status;
          const common = { threadId: this.threadId, evidence: visibleEvidence() };
          if (status === "failed") finish({ ...failedTurn(turn), ...common });
          else if (status === "interrupted") finish({ kind: "interrupted", output, ...common });
          else if (status === "completed") finish({ kind: "completed", output, ...common });
          else finish(failure("CODEX_PROTOCOL_ERROR"));
        }
      }
      if (Buffer.byteLength(buffer, "utf8") > MAX_JSONL_LINE_BYTES) {
        finish(failure("CODEX_PROTOCOL_ERROR"));
      }
    });
    const finishFromExit = (code: number | null): void => {
      if (settled) return;
      if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
      directExited = true;
      // The app-server can no longer answer. Reject RPC callers immediately;
      // descendant cleanup may continue for the bounded kill grace below.
      rejectPending();
      const result = terminationResult ?? (code === 0
        ? failure("CODEX_PROTOCOL_ERROR")
        : failure("CODEX_EXECUTION_FAILED"));
      terminationResult = result;
      if (signalProcessGroup(child, this.platform, "SIGTERM")) {
        if (killTimer === undefined) killTimer = setTimeout(forceKill, this.timing.killGraceMs);
        return;
      }
      if (buffer.trim()) { try { JSON.parse(buffer); } catch { finish(failure("CODEX_PROTOCOL_ERROR")); return; } }
      finish(currentTerminationResult());
    };
    child.on("exit", (code) => {
      // `close` can be withheld indefinitely by descendants that inherited an
      // app-server pipe. Drain already-delivered events once, then settle from
      // the direct child's exit and reject every outstanding RPC.
      directExited = true;
      exitImmediate = setImmediate(() => {
        exitImmediate = undefined;
        finishFromExit(code);
      });
    });
    child.on("close", finishFromExit);

    try {
      await this.call("initialize", { clientInfo: { name: "engineering-bridge", version: VERSION },
        ...(resumeFromPath ? { capabilities: { experimentalApi: true } } : {}) });
      this.notify("initialized", {});
      const selectedModel = request.model ?? this.hostEnvironment.ENGINEERING_BRIDGE_CODEX_DEFAULT_MODEL;
      if (selectedModel !== undefined || request.reasoning_effort !== undefined) {
        const modelResult = await this.call("model/list", {});
        if (!object(modelResult) || !Array.isArray(modelResult.data)) throw new Error();
        const models = modelResult.data.filter((entry): entry is Record<string, unknown> =>
          object(entry) && typeof entry.model === "string"
        );
        const selected = selectedModel !== undefined
          ? models.find((entry) => entry.model === selectedModel)
          : models.find((entry) => entry.isDefault === true);
        if (!selected) throw new CoreError("UNSUPPORTED_ACTION");
        if (request.reasoning_effort !== undefined) {
          const efforts = Array.isArray(selected.supportedReasoningEfforts)
            ? selected.supportedReasoningEfforts
            : [];
          if (!efforts.some((effort) => object(effort) && effort.reasoningEffort === request.reasoning_effort)) {
            throw new CoreError("UNSUPPORTED_ACTION");
          }
        }
      }
      const sandbox = request.sandbox ?? "read-only";
      const threadParams: Record<string, unknown> = { cwd: this.workspaceRoot, approvalPolicy: "never", sandbox };
      if (!request.threadId && request.ephemeral) threadParams.ephemeral = true;
      if (this.hostEnvironment.ENGINEERING_BRIDGE_CODEX_PROVIDER !== undefined) {
        threadParams.modelProvider = this.hostEnvironment.ENGINEERING_BRIDGE_CODEX_PROVIDER;
      }
      if (request.threadId) {
        threadParams.threadId = request.threadId;
        // Do not transmit the entire old history as one bounded JSONL response.
        threadParams.excludeTurns = true;
        if (resumeFromPath) threadParams.path = request.threadPath;
      }
      const threadResult = await this.call(request.threadId ? "thread/resume" : "thread/start", threadParams);
      if (!object(threadResult) || !object(threadResult.thread) || typeof threadResult.thread.id !== "string") throw new Error();
      if (request.threadId && threadResult.thread.id !== request.threadId) throw new Error("Unexpected resumed thread.");
      this.threadId = threadResult.thread.id;
      request.onThreadId?.(this.threadId);
      if (request.threadName && !request.ephemeral) {
        await this.call("thread/name/set", { threadId: this.threadId, name: request.threadName });
      }
      const sandboxPolicy = sandbox === "danger-full-access" ? { type: "dangerFullAccess" }
        : { type: "readOnly", networkAccess: false };
      const turnParams: Record<string, unknown> = {
        threadId: this.threadId, input: [{ type: "text", text: request.instruction }],
        cwd: this.workspaceRoot, approvalPolicy: "never", sandboxPolicy
      };
      if (selectedModel !== undefined) turnParams.model = selectedModel;
      if (request.reasoning_effort !== undefined) turnParams.effort = request.reasoning_effort;
      const turnResult = await this.call("turn/start", turnParams);
      if (!object(turnResult) || !object(turnResult.turn) || typeof turnResult.turn.id !== "string") throw new Error();
      this.turnId = turnResult.turn.id;
      if (this.startedTurnId !== this.turnId) this.startedTurnId = undefined;
    } catch (error) {
      if (!settled) finish(error instanceof CoreError
        ? { kind: "failed", error: serializeError(error) }
        : failure("CODEX_PROTOCOL_ERROR"));
    }
    return terminalPromise;
  }

  async steer(instruction: string): Promise<void> {
    if (!this.threadId || !this.startedTurnId) throw new CoreError("INVALID_STATE_TRANSITION");
    await this.call("turn/steer", { threadId: this.threadId, expectedTurnId: this.startedTurnId, input: [{ type: "text", text: instruction }] });
  }
  async interrupt(): Promise<void> {
    if (!this.child || !this.beginInterrupt) throw new CoreError("INVALID_STATE_TRANSITION");
    this.beginInterrupt();
  }
  private call(method: CodexRpcMethod, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.stdin.destroyed) { reject(new CoreError("CODEX_UNAVAILABLE")); return; }
      const rejectWaiter = (reason?: CoreError): void => reject(reason ?? new CodexRpcTimeoutError(method));
      const timer = setTimeout(() => {
        const waiter = this.pending.get(id);
        if (!waiter) return;
        this.pending.delete(id);
        clearTimeout(waiter.timer);
        waiter.reject();
      }, this.timing.rpcCallTimeoutMs ?? DEFAULT_EXECUTOR_TIMING.rpcCallTimeoutMs ?? DEFAULT_RPC_CALL_TIMEOUT_MS);
      this.pending.set(id, { method, resolve, reject: rejectWaiter, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch {
        const waiter = this.pending.get(id);
        if (!waiter) return;
        this.pending.delete(id);
        clearTimeout(waiter.timer);
        waiter.reject(new CoreError("CODEX_UNAVAILABLE"));
      }
    });
  }
  private notify(method: string, params: unknown): void { this.child?.stdin.write(`${JSON.stringify({ method, params })}\n`); }
}
