export const ERROR_CODES = [
  "INTERNAL_ERROR",
  "INVALID_STATE_TRANSITION",
  "UNKNOWN_WORKSPACE",
  "WORKSPACE_BOUNDARY_VIOLATION",
  "WORKSPACE_PRECONDITION_FAILED",
  "CODEX_UNAVAILABLE",
  "CODEX_PROTOCOL_ERROR",
  "CODEX_THREAD_BUSY",
  "CODEX_RPC_ERROR",
  "CODEX_RPC_TIMEOUT",
  "CODEX_TURN_FAILED",
  "CODEX_EXECUTION_FAILED",
  "EXECUTION_DEADLINE_EXCEEDED",
  "EXECUTOR_STALLED",
  "DSH_UNAVAILABLE",
  "DSH_PROTOCOL_ERROR",
  "DSH_EXECUTION_FAILED",
  "TASK_INTERRUPTED",
  "WORK_RESULT_WRITE_FAILED",
  "HOST_PROCESS_FAILED",
  "HOST_PROCESS_START_FAILED",
  "HOST_PROCESS_OUTCOME_UNKNOWN",
  "UNSUPPORTED_ACTION"
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const CODEX_RPC_METHODS = [
  "initialize", "model/list", "thread/start", "thread/resume", "thread/name/set",
  "turn/start", "turn/steer", "turn/interrupt"
] as const;
export type CodexRpcMethod = (typeof CODEX_RPC_METHODS)[number];
export const CODEX_RPC_ERROR_CATEGORIES = ["thread_busy", "unknown"] as const;
export type CodexRpcErrorCategory = (typeof CODEX_RPC_ERROR_CATEGORIES)[number];

export interface SerializedError {
  code: ErrorCode;
  message: string;
  rpc_method?: CodexRpcMethod;
  rpc_error_code?: number;
  rpc_error_category?: CodexRpcErrorCategory;
}

const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  INTERNAL_ERROR: "The request could not be completed.",
  INVALID_STATE_TRANSITION: "The requested state transition is not allowed.",
  UNKNOWN_WORKSPACE: "The requested workspace is not registered.",
  WORKSPACE_BOUNDARY_VIOLATION: "The workspace boundary could not be verified.",
  WORKSPACE_PRECONDITION_FAILED: "The workspace preconditions were not met.",
  CODEX_UNAVAILABLE: "Codex is unavailable.",
  CODEX_PROTOCOL_ERROR: "Codex returned an invalid response.",
  CODEX_THREAD_BUSY: "The Codex thread is currently in use by another writer.",
  CODEX_RPC_ERROR: "Codex rejected the RPC request.",
  CODEX_RPC_TIMEOUT: "Codex did not answer the RPC request before its deadline.",
  CODEX_TURN_FAILED: "Codex reported that the turn failed.",
  CODEX_EXECUTION_FAILED: "Codex execution failed.",
  EXECUTION_DEADLINE_EXCEEDED: "The executor exceeded its configured deadline.",
  EXECUTOR_STALLED: "The executor stopped producing protocol activity.",
  DSH_UNAVAILABLE: "DSH is unavailable.",
  DSH_PROTOCOL_ERROR: "DSH returned an invalid response.",
  DSH_EXECUTION_FAILED: "DSH execution failed.",
  TASK_INTERRUPTED: "The task was interrupted.",
  WORK_RESULT_WRITE_FAILED: "Execution ended but its result could not be persisted. Check project files before retrying.",
  HOST_PROCESS_FAILED: "The host process exited with a nonzero code or signal.",
  HOST_PROCESS_START_FAILED: "The host process could not be started.",
  HOST_PROCESS_OUTCOME_UNKNOWN: "The process supervisor exited without reporting an outcome. Inspect artifacts and running processes before retrying.",
  UNSUPPORTED_ACTION: "The requested action is not supported."
};

function isErrorCode(value: unknown): value is ErrorCode {
  return ERROR_CODES.some((code) => code === value);
}

export class CoreError extends Error {
  constructor(public readonly code: ErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "CoreError";
  }
}

// Never retain the server's message, data, or stderr on a rejected RPC.
export class CodexRpcError extends CoreError {
  constructor(public readonly rpc_method: CodexRpcMethod, public readonly rpc_error_code: number,
    public readonly rpc_error_category: CodexRpcErrorCategory) {
    super(rpc_error_category === "thread_busy" ? "CODEX_THREAD_BUSY" : "CODEX_RPC_ERROR");
    this.name = "CodexRpcError";
  }
}

export class CodexRpcTimeoutError extends CoreError {
  constructor(public readonly rpc_method: CodexRpcMethod) {
    super("CODEX_RPC_TIMEOUT");
    this.name = "CodexRpcTimeoutError";
  }
}

export function serializeError(error: unknown): SerializedError {
  const code = error instanceof CoreError && isErrorCode(error.code)
    ? error.code
    : "INTERNAL_ERROR";
  const serialized: SerializedError = {
    code,
    message: ERROR_MESSAGES[code]
  };
  if (error instanceof CodexRpcTimeoutError && CODEX_RPC_METHODS.some(method => method === error.rpc_method) &&
      code === "CODEX_RPC_TIMEOUT") {
    serialized.rpc_method = error.rpc_method;
  }
  if (error instanceof CodexRpcError &&
      CODEX_RPC_METHODS.some(method => method === error.rpc_method) &&
      Number.isSafeInteger(error.rpc_error_code) &&
      CODEX_RPC_ERROR_CATEGORIES.some(category => category === error.rpc_error_category) &&
      code === (error.rpc_error_category === "thread_busy" ? "CODEX_THREAD_BUSY" : "CODEX_RPC_ERROR")) {
    serialized.rpc_method = error.rpc_method;
    serialized.rpc_error_code = error.rpc_error_code;
    serialized.rpc_error_category = error.rpc_error_category;
  }
  return serialized;
}
