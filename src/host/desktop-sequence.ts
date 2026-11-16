import { z } from "zod";
import { buildDesktopCommand, desktopRequestWithinLimit, desktopSchemas, type DesktopTool } from "./desktop-commands.js";
import { desktopFailure, type DesktopCli, type DesktopEnvelope } from "./desktop-cli.js";

const operation = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("desktop_snapshot"), request: desktopSchemas.desktop_snapshot }).strict(),
  z.object({ tool: z.literal("desktop_find"), request: desktopSchemas.desktop_find }).strict(),
  z.object({ tool: z.literal("desktop_read"), request: desktopSchemas.desktop_read }).strict(),
  z.object({ tool: z.literal("desktop_act"), request: desktopSchemas.desktop_act }).strict(),
  z.object({ tool: z.literal("desktop_window"), request: desktopSchemas.desktop_window }).strict(),
  z.object({ tool: z.literal("desktop_wait"), request: desktopSchemas.desktop_wait }).strict()
]);
const verification = z.object({
  observation: z.discriminatedUnion("tool", [
    z.object({ tool: z.literal("desktop_read"), request: desktopSchemas.desktop_read }).strict(),
    z.object({ tool: z.literal("desktop_wait"), request: desktopSchemas.desktop_wait }).strict()
  ]),
  data_path: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u)).min(1).max(4)
    .describe("Exact property path inside the returned data object, observed from the CLI contract."),
  equals: z.union([z.string().max(8192), z.boolean(), z.number(), z.null()])
}).strict();
export const desktopSequenceSchema = z.object({
  namespace: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u),
  steps: z.array(z.object({ operation, verify: verification.optional() }).strict()).min(1).max(8),
  timeout_ms: z.number().int().min(100).max(120_000).default(45_000)
}).strict().superRefine((value, context) => {
  for (const step of value.steps) for (const item of [step.operation, step.verify?.observation]) {
    if (!item) continue;
    try {
      if (!desktopRequestWithinLimit(item.request)) throw new Error();
      buildDesktopCommand(item.tool, item.request);
      if ("namespace" in item.request && item.request.namespace !== value.namespace) throw new Error();
    } catch { context.addIssue({ code: z.ZodIssueCode.custom, message: "Every step must satisfy the existing command schema and reuse the sequence namespace." }); }
  }
});

function clipped(value: DesktopEnvelope, cap: number) {
  const bytes = Buffer.from(JSON.stringify(value));
  return bytes.length <= cap ? value : { ok: value.ok, truncated: true,
    preview: new TextDecoder().decode(bytes.subarray(0, cap), { stream: true }) };
}
function matches(result: DesktopEnvelope, predicate: z.infer<typeof verification>) {
  if (!result.ok) return false;
  if (result.data && typeof result.data === "object" &&
      (result.data as Record<string, unknown>).identity_unproven === true) return false;
  let value = result.data;
  for (const key of predicate.data_path) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return false;
    value = (value as Record<string, unknown>)[key];
  }
  return value === predicate.equals;
}

export async function runDesktopSequence(input: unknown, cli: Pick<DesktopCli, "run">,
  audit: (entry: Record<string, unknown>) => Promise<void>, signal: AbortSignal): Promise<DesktopEnvelope> {
  const parsed = desktopSequenceSchema.safeParse(input);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(input)) > 65_536)
    return desktopFailure("DESKTOP_INVALID_ARGUMENT", "Sequence requires 1-8 bounded steps in one namespace, at most 64 KiB.");
  const request = parsed.data;
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(request.timeout_ms)]);
  const steps: Record<string, unknown>[] = [];
  let latest: DesktopEnvelope | undefined, completed = 0, stopped: string | undefined;
  const invoke = async (tool: DesktopTool, args: unknown, index: number, phase: string) => {
    if (boundedSignal.aborted) return desktopFailure("DESKTOP_CANCELLED", "Sequence cancelled before dispatch.");
    try { await audit({ operation: tool, sequence_step: index, phase, state: "started" }); }
    catch { return desktopFailure("DESKTOP_AUDIT_FAILED", "Audit unavailable; step not dispatched."); }
    if (boundedSignal.aborted) return desktopFailure("DESKTOP_CANCELLED", "Sequence cancelled before dispatch.");
    let result: DesktopEnvelope;
    try { result = await cli.run(tool, args, boundedSignal); }
    catch { result = desktopFailure("DESKTOP_UNKNOWN_RESULT", "Step result was lost; do not replay.", true); }
    try { await audit({ operation: tool, sequence_step: index, phase, state: result.ok ? "completed" : "failed" }); }
    catch { result = { ...result, audit_warning: "Final audit unavailable; sequence stopped without replay." }; }
    return result;
  };
  for (const [index, step] of request.steps.entries()) {
    const mutation = buildDesktopCommand(step.operation.tool, step.operation.request).mutation;
    const result = await invoke(step.operation.tool, step.operation.request, index, "operation");
    const summary: Record<string, unknown> = { index, tool: step.operation.tool, result: clipped(result, 2048) };
    steps.push(summary);
    if (!mutation) latest = result;
    if (!result.ok || result.audit_warning) { stopped = result.audit_warning ? "audit_failed" : "operation_failed"; break; }
    const data = result.data as { disposition?: { delivery?: string } } | undefined;
    if (mutation && (!data?.disposition || !["delivered", "delivered_verified", "verified", "delivered_unverified"].includes(data.disposition.delivery ?? ""))) {
      stopped = "unknown_delivery"; break;
    }
    if (step.verify) {
      latest = await invoke(step.verify.observation.tool, step.verify.observation.request, index, "verification");
      const verified = matches(latest, step.verify);
      summary.verification = clipped(latest, 2048); summary.verified = verified;
      if (!verified || latest.audit_warning) { stopped = "verification_failed"; break; }
    } else if (mutation) { stopped = "mutation_unverified"; break; }
    completed++;
  }
  return { ok: !stopped, completed_count: completed, attempted_count: steps.length, steps,
    ...(stopped ? { stopped_reason: stopped } : {}), ...(latest ? { latest_observation: clipped(latest, 8192) } : {}),
    automatic_retries: false };
}
