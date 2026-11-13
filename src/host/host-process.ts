import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ProcessRequest, ProcessView } from "./process-runtime.js";

/** IPC is bounded to one progress message in flight by the supervisor. */
export function superviseProcess(request: ProcessRequest, changed: (view: ProcessView) => void) {
  const worker = spawn(process.execPath, [fileURLToPath(new URL("./process-worker.js", import.meta.url))], {
    shell: false, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"]
  });
  let last: ProcessView = { executable: request.executable, cwd: request.cwd,
    started_at: new Date().toISOString(), exit_code: null, signal: null,
    stdout: "", stderr: "", truncated: false, timed_out: false, cancelled: false };
  let complete: ProcessView | undefined;
  let resolveDone!: (view: ProcessView) => void;
  const done = new Promise<ProcessView>(resolve => { resolveDone = resolve; });
  worker.on("message", (message: { type: string; view: ProcessView }) => {
    if (message.type === "progress") { last = message.view; changed(last); }
    if (message.type === "done") complete = message.view;
  });
  const finish = () => resolveDone(complete ?? { ...last, outcome_unknown: true });
  worker.once("error", finish);
  worker.once("close", finish);
  worker.send!({ type: "start", request }, (error: Error | null) => { if (error && worker.connected) worker.disconnect(); });
  return { done, snapshot: () => last,
    stop: (reason: "interrupt" | "shutdown" = "interrupt") => {
      if (worker.connected) worker.send!({ type: "stop", reason }, () => {});
    }
  };
}
