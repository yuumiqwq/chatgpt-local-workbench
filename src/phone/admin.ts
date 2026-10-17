import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PhoneStore, token } from './store.js';
import { loadPhoneConfig } from './config.js';

export async function administerPhone(store: PhoneStore, action: string, allServersStopped = false) {
  if (action === 'pause') {
    await writeFile(join(store.dir, 'PAUSED'), 'Local administrator paused phone writes.\n', { mode: 0o600 });
    await store.save('epoch.json', token());
    return { paused: true, leases_revoked: true, already_dispatched_action: 'may_finish; cannot be undone' };
  }
  if (action === 'resume') {
    await store.lock(async () => {
      await store.save('epoch.json', token());
      await rm(join(store.dir, 'PAUSED'), { force: true });
    });
    return { paused: false, old_leases_valid: false };
  }
  if (action !== 'recover-lock' || !allServersStopped || !await store.paused()) throw new Error('Pause and stop all phone-enabled stdio processes, then pass --all-servers-stopped.');
  // Deliberately no age-based takeover: slow I/O, suspended Windows or PID reuse must not create two writers.
  let owner: string | undefined;
  try { owner = await readFile(join(store.dir, 'operation.lock', 'pid'), 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  if (owner !== undefined) {
    if (!/^\d+$/.test(owner)) throw new Error('Invalid lock owner; inspect offline.');
    try { process.kill(Number(owner), 0); throw new Error('Lock owner is alive (or PID reused); no takeover.'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
  }
  await rm(join(store.dir, 'operation.lock'), { force: true, recursive: true });
  await store.save('epoch.json', token());
  return { lock_recovered: true, paused: true, journal_preserved: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = await loadPhoneConfig(process.argv[2] ?? '');
  if (!config) throw new Error('Enabled absolute phone configuration required.');
  console.log(JSON.stringify(await administerPhone(new PhoneStore(config.state_dir), process.argv[3] ?? '', process.argv[4] === '--all-servers-stopped')));
}
