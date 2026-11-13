import assert from "node:assert/strict";
import test from "node:test";

import { CoreError, CodexRpcError, CodexRpcTimeoutError, ERROR_CODES, serializeError } from "../../src/core/errors.js";

test("exposes the executor error codes", () => {
  assert.deepEqual(ERROR_CODES, [
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
  ]);
  assert.deepEqual(serializeError(new CoreError("CODEX_UNAVAILABLE")), {
    code: "CODEX_UNAVAILABLE", message: "Codex is unavailable."
  });
  assert.deepEqual(serializeError(new CoreError("CODEX_PROTOCOL_ERROR")), {
    code: "CODEX_PROTOCOL_ERROR", message: "Codex returned an invalid response."
  });
  assert.deepEqual(serializeError(new CoreError("CODEX_THREAD_BUSY")), {
    code: "CODEX_THREAD_BUSY", message: "The Codex thread is currently in use by another writer."
  });
  assert.deepEqual(serializeError(new CoreError("CODEX_RPC_ERROR")), {
    code: "CODEX_RPC_ERROR", message: "Codex rejected the RPC request."
  });
  assert.deepEqual(serializeError(new CoreError("CODEX_RPC_TIMEOUT")), {
    code: "CODEX_RPC_TIMEOUT", message: "Codex did not answer the RPC request before its deadline."
  });
  assert.deepEqual(serializeError(new CoreError("CODEX_TURN_FAILED")), {
    code: "CODEX_TURN_FAILED", message: "Codex reported that the turn failed."
  });
  assert.deepEqual(serializeError(new CoreError("CODEX_EXECUTION_FAILED")), {
    code: "CODEX_EXECUTION_FAILED", message: "Codex execution failed."
  });
  assert.deepEqual(serializeError(new CoreError("EXECUTION_DEADLINE_EXCEEDED")), {
    code: "EXECUTION_DEADLINE_EXCEEDED", message: "The executor exceeded its configured deadline."
  });
  assert.deepEqual(serializeError(new CoreError("DSH_UNAVAILABLE")), {
    code: "DSH_UNAVAILABLE", message: "DSH is unavailable."
  });
  assert.deepEqual(serializeError(new CoreError("DSH_PROTOCOL_ERROR")), {
    code: "DSH_PROTOCOL_ERROR", message: "DSH returned an invalid response."
  });
  assert.deepEqual(serializeError(new CoreError("DSH_EXECUTION_FAILED")), {
    code: "DSH_EXECUTION_FAILED", message: "DSH execution failed."
  });
  assert.deepEqual(serializeError(new CoreError("TASK_INTERRUPTED")), {
    code: "TASK_INTERRUPTED", message: "The task was interrupted."
  });
  assert.deepEqual(serializeError(new CoreError("UNSUPPORTED_ACTION")), {
    code: "UNSUPPORTED_ACTION", message: "The requested action is not supported."
  });
  assert.deepEqual(serializeError(new CoreError("UNKNOWN_WORKSPACE")), {
    code: "UNKNOWN_WORKSPACE", message: "The requested workspace is not registered."
  });
  assert.deepEqual(serializeError(new CoreError("WORKSPACE_BOUNDARY_VIOLATION")), {
    code: "WORKSPACE_BOUNDARY_VIOLATION", message: "The workspace boundary could not be verified."
  });
  assert.deepEqual(serializeError(new CoreError("WORKSPACE_PRECONDITION_FAILED")), {
    code: "WORKSPACE_PRECONDITION_FAILED", message: "The workspace preconditions were not met."
  });
});

test("serializeError exposes an allowlisted core error", () => {
  const serialized = serializeError(new CoreError("INVALID_STATE_TRANSITION"));

  assert.deepEqual(serialized, {
    code: "INVALID_STATE_TRANSITION",
    message: "The requested state transition is not allowed."
  });
});

test("serializeError ignores mutated CoreError details", () => {
  const secretMarkers = ["secret-message", "secret-stack", "secret-cause", "/test-only/private-path"] as const;
  const error = new CoreError("INVALID_STATE_TRANSITION");

  Object.assign(error, {
    message: secretMarkers[0],
    stack: secretMarkers[1],
    cause: new Error(secretMarkers[2]),
    path: secretMarkers[3]
  });

  const serialized = serializeError(error);
  const json = JSON.stringify(serialized);

  assert.deepEqual(serialized, {
    code: "INVALID_STATE_TRANSITION",
    message: "The requested state transition is not allowed."
  });
  for (const marker of secretMarkers) {
    assert.equal(json.includes(marker), false);
  }
});

test("serializeError removes details from unknown errors and values", () => {
  const secretMarkers = ["secret-message", "secret-stack", "secret-cause", "/test-only/private-path"] as const;
  const error = Object.assign(new Error(secretMarkers[0]), {
    stack: secretMarkers[1],
    cause: new Error(secretMarkers[2]),
    path: secretMarkers[3]
  });
  const inputs: unknown[] = [error, secretMarkers[0], { path: secretMarkers[3] }, [], 42, null, undefined];

  for (const input of inputs) {
    const serialized = serializeError(input);
    const json = JSON.stringify(serialized);

    assert.deepEqual(serialized, {
      code: "INTERNAL_ERROR",
      message: "The request could not be completed."
    });
    for (const marker of secretMarkers) {
      assert.equal(json.includes(marker), false);
    }
  }
});

test("serializeError preserves RPC timeout method metadata", () => {
  const error = new CodexRpcTimeoutError("turn/start");
  Object.assign(error, { message: "secret-message", stack: "secret-stack" });
  assert.deepEqual(serializeError(error), {
    code: "CODEX_RPC_TIMEOUT",
    message: "Codex did not answer the RPC request before its deadline.",
    rpc_method: "turn/start"
  });
});

test("serializeError preserves only allowlisted RPC metadata", () => {
  const error = new CodexRpcError("thread/resume", -32600, "thread_busy");
  Object.assign(error, { message: "secret-message", stack: "secret-stack", cause: "secret-cause",
    data: { token: "secret-token" }, stderr: "secret-stderr" });
  assert.deepEqual(serializeError(error), {
    code: "CODEX_THREAD_BUSY", message: "The Codex thread is currently in use by another writer.",
    rpc_method: "thread/resume", rpc_error_code: -32600, rpc_error_category: "thread_busy"
  });
});

test("serializeError rejects mutated or fabricated RPC metadata", () => {
  for (const metadata of [
    { rpc_method: "secret-method" }, { rpc_error_category: "secret-category" },
    { rpc_error_code: "secret-code" }, { rpc_error_code: Infinity }, { rpc_error_code: NaN },
    { rpc_error_code: 1.5 }, { rpc_error_code: Number.MAX_SAFE_INTEGER + 1 }
  ]) {
    const error = Object.assign(new CodexRpcError("initialize", -32600, "unknown"), metadata);
    assert.deepEqual(serializeError(error), { code: "CODEX_RPC_ERROR", message: "Codex rejected the RPC request." });
  }
  const error = Object.assign(new CoreError("CODEX_RPC_ERROR"), {
    rpc_method: "initialize", rpc_error_code: -32600, rpc_error_category: "unknown"
  });
  assert.deepEqual(serializeError(error), { code: "CODEX_RPC_ERROR", message: "Codex rejected the RPC request." });
});
