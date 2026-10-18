import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { z } from "zod";

const IdentityConfigSchema = z.object({
  hostname: z.string().min(1),
  display_name: z.string().refine(value => value.trim().length > 0),
  instructions: z.string().refine(value => value.trim().length > 0)
}).strict();

export interface HostIdentity {
  hostname: string;
  display_name?: string;
  instructions?: string;
}

export async function loadHostIdentity(path: string): Promise<HostIdentity> {
  const actualHostname = hostname();
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { hostname: actualHostname };
    throw error;
  }
  const config = IdentityConfigSchema.parse(JSON.parse(source.replace(/^\uFEFF/u, "")));
  if (config.hostname.toLowerCase() !== actualHostname.toLowerCase()) {
    throw new Error(`HOST_IDENTITY_HOSTNAME_MISMATCH: configured ${config.hostname}, actual ${actualHostname}`);
  }
  return { hostname: actualHostname, display_name: config.display_name, instructions: config.instructions };
}
