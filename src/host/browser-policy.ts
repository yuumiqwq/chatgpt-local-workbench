import { hostname } from "node:os";
import { isAbsolute } from "node:path";
import { z } from "zod";

export const BrowserPolicySchema = z.object({
  enabled: z.boolean().default(false),
  allowed_hosts: z.array(z.string().min(1).max(255)).default([]),
  state_directory: z.string().min(1).optional(),
  profile_name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u).optional(),
  opencli_entry: z.string().min(1).optional(),
  opencli_context: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u).optional(),
  opencli_version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u).default("1.8.8-yuumi.1"),
  timeout_ms: z.number().int().min(1000).max(45_000).default(30_000),
  max_output_bytes: z.number().int().min(4096).max(65_536).default(16_384)
}).strict().superRefine((value, context) => {
  if (value.enabled && (!value.allowed_hosts.length || !value.state_directory ||
      !isAbsolute(value.state_directory) || /^[cC]:/u.test(value.state_directory))) {
    context.addIssue({ code: z.ZodIssueCode.custom,
      message: "Enabled browser access requires allowed_hosts and an absolute private state_directory outside C:." });
  }
});

export type BrowserPolicy = z.infer<typeof BrowserPolicySchema>;
export function browserEnabled(hostEnabled: boolean, policy: BrowserPolicy, host = hostname()) {
  return hostEnabled && policy.enabled && policy.allowed_hosts.some(name => name.toLowerCase() === host.toLowerCase());
}
