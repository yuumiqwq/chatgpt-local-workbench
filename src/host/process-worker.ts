import { launchProcess, type ProcessRequest, type ProcessView } from "./process-runtime.js";

// Separate supervisor keeps draining and terminates its child if Bridge crashes
// or closes IPC. It does not invoke a model or accept shell command strings.
let execution: ReturnType<typeof launchProcess> | undefined;
let sending = false;
const send = (view: ProcessView) => {
  if (sending || !process.connected) return;
  sending = true;
  process.send!({ type: "progress", view }, () => { sending = false; });
};
const interval = setInterval(() => { if (execution) send(execution.snapshot()); }, 500);
const disconnected = () => {
  if (execution) execution.stop("shutdown");
  else { clearInterval(interval); process.exitCode = 0; }
};
process.on("disconnect", disconnected);
process.on("SIGTERM", disconnected);
process.on("SIGINT", disconnected);
process.on("message", (message: { type: string; request?: ProcessRequest; reason?: "interrupt" | "shutdown" }) => {
  if (message.type === "stop") execution?.stop(message.reason ?? "interrupt");
  if (message.type !== "start" || execution || !message.request) return;
  execution = launchProcess(message.request, send);
  if (!process.connected) execution.stop("shutdown");
  void execution.done.then(view => {
    clearInterval(interval);
    if (process.connected) process.send!({ type: "done", view }, () => { if (process.connected) process.disconnect(); });
  });
});
