import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { hostname } from 'node:os';
import { z } from 'zod';

export const PhoneConfigSchema = z.object({
  enabled: z.boolean(), hostname: z.string().min(1),
  adb_path: z.string().refine(isAbsolute), serial: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  state_dir: z.string().refine(isAbsolute),
  lease_seconds: z.number().int().min(10).max(120).default(60),
  frame_seconds: z.number().int().min(1).max(30).default(10),
  ime_enabled: z.boolean().default(false),
  scrcpy_path: z.string().refine(isAbsolute).optional(),
  dark_on_wake: z.boolean().optional(),
  appium_url: z.string().url().refine(value => {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
  }, 'Appium must listen on a loopback HTTP address').transform(value => value.replace(/\/$/, '')).optional()
}).strict();
export type PhoneConfig = z.infer<typeof PhoneConfigSchema>;
export async function loadPhoneConfig(path: string): Promise<PhoneConfig | undefined> {
  let raw: unknown;
  try { raw = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  if (typeof raw === 'object' && raw !== null && Object.keys(raw).length === 1 && 'enabled' in raw && raw.enabled === false) return;
  const config = PhoneConfigSchema.parse(raw);
  if (!config.enabled) return;
  if (hostname().toLowerCase() !== config.hostname.toLowerCase()) throw new Error('PHONE_HOSTNAME_MISMATCH');
  if (!(await stat(config.adb_path)).isFile()) throw new Error('PHONE_ADB_NOT_FILE');
  config.adb_path = await realpath(config.adb_path);
  if (config.scrcpy_path) {
    if (!(await stat(config.scrcpy_path)).isFile()) throw new Error('PHONE_SCRCPY_NOT_FILE');
    config.scrcpy_path = await realpath(config.scrcpy_path);
  }
  if (config.dark_on_wake && !config.scrcpy_path) throw new Error('PHONE_PANEL_NOT_CONFIGURED');
  // Precreate this directory with a private OS ACL; canonical paths unify all stdio processes.
  config.state_dir = await realpath(config.state_dir);
  if (!(await stat(config.state_dir)).isDirectory()) throw new Error('PHONE_STATE_NOT_DIRECTORY');
  return config;
}
