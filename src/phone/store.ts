import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile, open, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export const token = () => randomBytes(32).toString('hex');
export class PhoneStore {
  constructor(readonly dir: string) {}
  async read<T>(name: string): Promise<T | undefined> {
    try { return JSON.parse(await readFile(join(this.dir, name), 'utf8')) as T; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('PHONE_STATE_CORRUPT'); }
  }
  async save(name: string, value: unknown) {
    const target = join(this.dir, name), temp = `${target}.${token()}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temp, target);
  }
  async paused() { try { await stat(join(this.dir, 'PAUSED')); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }
  async lock<T>(work: () => Promise<T>): Promise<T> {
    const path = join(this.dir, 'operation.lock');
    try { await mkdir(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('PHONE_BUSY_OR_ABANDONED_LOCK'); throw e; }
    try { await writeFile(join(path, 'pid'), String(process.pid)); return await work(); }
    finally { await rm(path, { recursive: true }); }
  }
}
