import { hostname } from "node:os";
import { z } from "zod";

export const DesktopPolicySchema = z.object({
  enabled: z.boolean().default(false),
  allowed_hosts: z.array(z.string().min(1).max(255)).default([]),
  executable: z.string().min(1).optional(),
  executable_sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  state_directory: z.string().min(1).optional(),
  allow_mutations: z.boolean().default(false),
  allow_headed: z.boolean().default(false),
  allow_physical_input: z.boolean().default(false),
  allow_screenshot: z.boolean().default(false),
  clipboard: z.enum(["disabled", "read", "read-write"]).default("disabled"),
  launch_apps: z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u), z.string().min(1)).default({}),
  max_output_bytes: z.number().int().min(4096).max(16_777_216).default(8_388_608)
}).strict().superRefine((value, context) => {
  if (value.enabled && (!value.allowed_hosts.length || !value.executable ||
      !value.executable_sha256 || !value.state_directory)) {
    context.addIssue({ code: z.ZodIssueCode.custom,
      message: "Enabled desktop access requires allowed_hosts, executable, executable_sha256 and state_directory." });
  }
  if (value.allow_physical_input && !value.allow_headed) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Physical input requires allow_headed." });
  }
});

export type DesktopPolicy = z.infer<typeof DesktopPolicySchema>;

export function desktopEnabled(hostEnabled: boolean, policy: DesktopPolicy, host = hostname()): boolean {
  return hostEnabled && policy.enabled && policy.allowed_hosts.some(name => name.toLowerCase() === host.toLowerCase());
}
