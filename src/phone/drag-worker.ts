import { ScrcpyTouchConnection } from './drag.js';
import { PhoneStore } from './store.js';
import { RealAdb } from './adb.js';
import { PhoneConfigSchema } from './config.js';

let connection: ScrcpyTouchConnection | undefined;
let store: PhoneStore | undefined;
let owner = '', epoch = '', dragId = '', lastCommand = Date.now(), started = Date.now();
let closing = false, timer: NodeJS.Timeout | undefined;
let queue = Promise.resolve();
async function close() {
  if (closing) return;
  closing = true; clearInterval(timer);
  await connection?.close();
  if ((await store?.read<{ id: string }>('drag.json'))?.id === dragId) await store?.save('drag.json', null);
  if (process.connected) process.disconnect();
}
async function check() {
  if (!store || closing) return;
  const lease = await store.read<{ hash: string; expires: number; epoch: string }>('lease.json');
  if (!process.connected || !lease || lease.hash !== owner || lease.epoch !== epoch || lease.expires <= Date.now() ||
    (await store.read('epoch.json') ?? 'initial') !== epoch || await store.paused() ||
    Date.now() - lastCommand > 30000 || Date.now() - started > 120000) await close();
}
process.on('disconnect', () => { queue = queue.then(close).catch(close); });
process.on('message', (message: any) => {
  queue = queue.then(async () => {
    if (closing) return;
    try {
      if (message.type === 'start') {
        if (connection) throw new Error('PHONE_DRAG_ALREADY_ACTIVE');
        const config = PhoneConfigSchema.parse(message.config);
        store = new PhoneStore(config.state_dir); owner = message.leaseHash; epoch = message.epoch; dragId = message.dragId;
        connection = new ScrcpyTouchConnection(config, new RealAdb(config));
        await check(); if (closing) return;
        await connection.open();
        await check(); if (closing) return;
        await connection.start(message.context, message.point);
        timer = setInterval(() => { queue = queue.then(check).catch(close); }, 500);
      } else {
        await check(); if (closing) return;
        if (message.type === 'move') await connection!.move(message.point, message.duration);
        else if (message.type === 'end') await connection!.end(message.cancel === true);
        else throw new Error('PHONE_DRAG_INVALID_ACTION');
      }
      lastCommand = Date.now();
      if (process.connected) process.send?.({ id: message.id }, error => { if (error) queue = queue.then(close).catch(close); });
      if (message.type === 'end') await close();
    } catch (error) {
      if (process.connected) process.send?.({ id: message.id, error: error instanceof Error ? error.message : 'PHONE_DRAG_FAILED' }, () => {});
      await close();
    }
  });
});
