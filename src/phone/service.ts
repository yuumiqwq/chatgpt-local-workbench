import { hostname } from 'node:os';
import { createHash, createHmac } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Adb } from './adb.js';
import type { PhoneConfig } from './config.js';
import { PhoneStore, digest, token } from './store.js';
import { VERSION } from '../version.js';
import { HostError } from '../host/host-policy.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
const pkg = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/).max(200);
const point = z.number().int().min(0).max(16384);
const auth = { lease_id: id, request_id: id };
export const phoneSchemas = {
  server_status: z.object({}).strict(),
  phone_acquire_control: z.object({}).strict(),
  phone_release_control: z.object({ lease_id: id }).strict(),
  phone_observe: z.object({ ui: z.boolean().default(false) }).strict(),
  phone_list_apps: z.object({ search: z.string().max(100).default(''), offset: z.number().int().min(0).max(10000).default(0), limit: z.number().int().min(1).max(100).default(50), refresh: z.boolean().default(false) }).strict(),
  phone_open_app: z.object({ ...auth, package: pkg }).strict(),
  phone_input: z.object({ ...auth, frame_id: id, action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('tap'), x: point, y: point }).strict(),
    z.object({ type: z.literal('long_press'), x: point, y: point, duration_ms: z.number().int().min(400).max(2000).default(600) }).strict(),
    z.object({ type: z.literal('swipe'), x: point, y: point, to_x: point, to_y: point, duration_ms: z.number().int().min(100).max(2000).default(300) }).strict(),
    z.object({ type: z.literal('key'), key: z.enum(['BACK', 'HOME', 'APP_SWITCH', 'ENTER', 'DEL']) }).strict(),
    z.object({ type: z.literal('text'), text: z.string().min(1).max(4096), mode: z.enum(['append', 'replace']) }).strict()
  ]) }).strict(),
  phone_display: z.object({ ...auth, action: z.enum(['physical_off', 'wake']) }).strict(),
  phone_recover: z.object({ ...auth, action: z.enum(['check', 'reconnect', 'wake']) }).strict()
};
export type PhoneTool = keyof typeof phoneSchemas;
type Lease = { hash: string; expires: number; epoch: string };
const leaseSchema = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), expires: z.number().finite().nonnegative(), epoch: z.string().min(1) }).strict();
type Frame = { frame_id: string; timestamp: string; at: number; package: string | null; rotation: number; width: number; height: number; hash: string };
type Request = { fingerprint: string; lease_hash: string; state: 'pending' | 'completed'; result?: unknown };
const json = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

export class PhoneService {
  readonly store: PhoneStore;
  private apps: { at: number; packages: string[] } | undefined;
  private faults: { at: string; code: string }[] = [];
  private fault(code: string) {
    this.faults.push({ at: new Date(this.now()).toISOString(), code });
    this.faults = this.faults.slice(-20);
  }
  constructor(readonly config: PhoneConfig, private adb: Adb, private now = Date.now) { this.store = new PhoneStore(config.state_dir); }
  private async shell(...args: string[]) { return (await this.adb.run(['shell', ...args])).toString('utf8'); }
  private async epoch() {
    const epoch = await this.store.read<unknown>('epoch.json');
    if (epoch === undefined) return 'initial';
    if (typeof epoch !== 'string' || !/^[a-f0-9]{64}$/.test(epoch)) throw new Error('PHONE_STATE_CORRUPT');
    return epoch;
  }
  private async readLease(): Promise<Lease | undefined> {
    const raw = await this.store.read<unknown>('lease.json');
    if (raw === undefined || raw === null) return;
    const result = leaseSchema.safeParse(raw);
    if (!result.success) throw new Error('PHONE_STATE_CORRUPT');
    return result.data;
  }
  private async lease(key: string) {
    if (await this.store.paused()) throw new Error('PHONE_ADMIN_PAUSED');
    const lease = await this.readLease();
    if (!lease || lease.hash !== digest(key) || lease.expires <= this.now() || lease.epoch !== await this.epoch()) throw new Error('PHONE_LEASE_INVALID');
    return lease;
  }
  private async renew(key: string) { const lease = await this.lease(key); await this.store.save('lease.json', { ...lease, expires: this.now() + this.config.lease_seconds * 1000 }); }
  private async controlled<T>(key: string, operation: () => Promise<T>) {
    return this.store.lock(async () => {
      await this.renew(key);
      let heartbeat = Promise.resolve();
      const timer = setInterval(() => {
        heartbeat = heartbeat.then(() => this.renew(key)).catch(() => {});
      }, Math.min(5000, this.config.lease_seconds * 1000 / 3));
      try { return await operation(); }
      finally { clearInterval(timer); await heartbeat; }
    });
  }
  async assertHostCommandAllowed() {
    // Block all generic commands during control, including shells and wrappers; matching argv alone is bypassable.
    const lease = await this.readLease();
    if (await this.store.paused() || (lease && lease.expires > this.now() && lease.epoch === await this.epoch())) throw new HostError('PHONE_MAINTENANCE_COMMAND_BLOCKED', 'Generic host commands are maintenance authority and are blocked while phone control is leased or paused.');
  }
  async maintenanceCommand<T>(operation: () => Promise<T>): Promise<T> {
    return this.store.lock(async () => { await this.assertHostCommandAllowed(); return operation(); });
  }
  private async context() {
    // Fixed shell program, no caller-controlled interpolation. One bounded process per context.
    const w = await this.shell('dumpsys window; wm size');
    const packageName = /mCurrentFocus=.*?\s([A-Za-z][\w.]*)\//.exec(w)?.[1] ?? null;
    const degrees = /mRotation=ROTATION_(0|90|180|270)\b/.exec(w)?.[1];
    const rawRotation = /(?:mRotation|rotation)=([0-3])\b/.exec(w)?.[1];
    const size = /Physical size: (\d+)x(\d+)/.exec(w);
    const override = /Override size: (\d+)x(\d+)/.exec(w);
    if ((degrees === undefined && rawRotation === undefined) || !packageName || !size) throw new Error('PHONE_DISPLAY_CONTEXT_UNKNOWN');
    if (override && (override[1] !== size[1] || override[2] !== size[2])) throw new Error('PHONE_DISPLAY_OVERRIDE_UNSUPPORTED');
    const rotation = degrees === undefined ? Number(rawRotation) : Number(degrees) / 90;
    return { package: packageName, rotation, width: Number(size[rotation % 2 ? 2 : 1]), height: Number(size[rotation % 2 ? 1 : 2]) };
  }
  private async capture(ui: boolean): Promise<{ frame: Frame; png: Buffer; ui: unknown; rendered: { width: number; height: number } }> {
    const before = await this.context();
    const png = await this.adb.run(['exec-out', 'screencap', '-p']);
    const capturedAt = this.now();
    if (png.length < 33 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.subarray(12, 16).toString() !== 'IHDR') throw new Error('PHONE_SCREENSHOT_FAILED');
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    if (!width || !height || width > 16384 || height > 16384) throw new Error('PHONE_INVALID_PNG');
    if (width !== before.width || height !== before.height) throw new Error('PHONE_FRAME_CHANGED_DURING_CAPTURE');
    let uiResult: unknown = { status: 'not_requested' };
    if (ui) {
      // stdout-only fresh dump: no shared device XML path and no last-known cache.
      const raw = await this.adb.run(['exec-out', 'uiautomator', 'dump', '/dev/tty']);
      const xml = /(<\?xml[\s\S]*?<\/hierarchy>)/.exec(raw.toString('utf8'))?.[1];
      if (!xml) throw new Error('PHONE_UI_DUMP_FAILED');
      uiResult = { status: 'fresh', xml, trusted: false };
    }
    const after = await this.context();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('PHONE_FRAME_CHANGED_DURING_CAPTURE');
    const frame: Frame = { ...after, frame_id: token(), timestamp: new Date(capturedAt).toISOString(), at: capturedAt, width, height,
      hash: createHash('sha256').update(png).digest('hex') };
    // A full serialized response stays comfortably below the tunnel's 10 MiB limit.
    // Coordinate validation and hashes always use the original physical raster.
    const { default: sharp } = await import('sharp');
    const rendered = await sharp(png, { limitInputPixels: 40_000_000 }).resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
      .timeout({ seconds: 3 }).png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
    if (rendered.data.length > 3 * 1024 * 1024 || Buffer.byteLength(JSON.stringify(uiResult)) > 512 * 1024) throw new Error('PHONE_OBSERVATION_TOO_LARGE');
    await this.store.save('frame.json', frame);
    return { frame, png: rendered.data, ui: uiResult, rendered: { width: rendered.info.width, height: rendered.info.height } };
  }
  private observation(o: Awaited<ReturnType<PhoneService['capture']>>, extra: unknown = {}): CallToolResult {
    const { hash: _hash, at: _at, ...frame } = o.frame;
    return { content: [{ type: 'text', text: JSON.stringify({ ...frame, ui: o.ui, flag_secure: 'unknown', capture_atomic: false,
      rendered: o.rendered, coordinate_space: 'original_physical_pixels',
      consistency: 'one fresh PNG; package, physical dimensions and rotation checked before and after; UI XML has a short collection race; secure regions remain unknown', result: extra }) },
    { type: 'image', mimeType: 'image/png', data: o.png.toString('base64') }] };
  }
  private async status() {
    const probe = async (args: string[]) => { try { return await this.shell(...args); } catch { return null; } };
    let state = 'unknown';
    try {
      const devices = (await this.adb.run(['devices'])).toString();
      state = new RegExp(`^${this.config.serial}\\s+(\\w+)`, 'm').exec(devices)?.[1] ?? 'disconnected';
    } catch { /* bounded probe, no guessed authorization */ }
    const battery = state === 'device' ? await probe(['dumpsys', 'battery']) : null;
    const number = (pattern: RegExp) => { const match = battery?.match(pattern); return match ? Number(match[1]) : null; };
    const level = number(/level:\s*(\d+)/), scale = number(/scale:\s*(\d+)/), chargingStatus = number(/status:\s*(\d+)/);
    const memory = state === 'device' ? await probe(['cat', '/proc/meminfo']) : null;
    const disk = state === 'device' ? await probe(['df', '-k', '/data']) : null;
    const display = state === 'device' ? await probe(['dumpsys', 'power']) : null;
    const size = state === 'device' ? await probe(['wm', 'size']) : null;
    const physicalSize = size ? /Physical size: (\d+)x(\d+)/.exec(size) : null;
    return { hostname: hostname(), service_version: VERSION, phone_protocol_version: '1', capabilities: Object.keys(phoneSchemas),
      tunnel_status: 'unknown', adb: { serial: this.config.serial, state }, first_unlock: 'unknown',
      battery: { percent: level !== null && scale !== null && scale > 0 ? level * 100 / scale : null,
        charging: chargingStatus === 2 ? true : chargingStatus !== null && [3, 4, 5].includes(chargingStatus) ? false : null,
        external_power: battery && /(?:AC|USB|Wireless) powered: (true|false)/.test(battery) ? /(?:AC|USB|Wireless) powered: true/.test(battery) : null,
        temperature_celsius: number(/temperature:\s*(-?\d+)/) === null ? null : number(/temperature:\s*(-?\d+)/)! / 10 },
      memory: memory ? { status: 'reported', mem_total_kib: /MemTotal:\s*(\d+)/.exec(memory)?.[1] ?? null, mem_available_kib: /MemAvailable:\s*(\d+)/.exec(memory)?.[1] ?? null } : null,
      disk: disk ? { status: 'reported', data_df_kib: disk.slice(0, 2048) } : null,
      display: { wakefulness: display ? /mWakefulness=(\w+)/.exec(display)?.[1] ?? 'unknown' : 'unknown', physical_off_supported: false,
        physical_width: physicalSize ? Number(physicalSize[1]) : null, physical_height: physicalSize ? Number(physicalSize[2]) : null,
        rotation: 'unknown; available in a fresh observation', physical_panel_state: 'unknown' },
      admin_paused: await this.store.paused(), recent_faults: this.faults };
  }
  private async listApps(args: z.infer<typeof phoneSchemas.phone_list_apps>) {
    if (!this.apps || args.refresh || this.now() - this.apps.at > 60000) {
      const output = await this.shell('cmd', 'package', 'query-activities', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER');
      if (/Error|Exception|Unknown command/.test(output)) throw new Error('PHONE_APP_QUERY_FAILED');
      this.apps = { at: this.now(), packages: [...new Set(output.split(/\r?\n/).map(s => s.trim().split('/')[0] ?? '').filter(s => pkg.safeParse(s).success))].sort() };
    }
    const matches = this.apps.packages.filter(p => p.toLowerCase().includes(args.search.toLowerCase()));
    return json({ packages: matches.slice(args.offset, args.offset + args.limit), total: matches.length, cached_at: this.apps.at });
  }
  private async write(name: PhoneTool, args: Record<string, unknown>) {
    const key = args.lease_id as string, requestId = args.request_id as string;
    const file = `request-${digest(requestId)}.json`, fingerprint = createHmac('sha256', key).update(JSON.stringify({ name, ...args, lease_id: undefined })).digest('hex');
    // Check the durable receipt even if a crashed process left the operation lock behind.
    const previous = await this.store.read<Request>(file);
    if (previous) {
      if (previous.lease_hash !== digest(key) || previous.fingerprint !== fingerprint) throw new Error('PHONE_REQUEST_CONFLICT');
      return json({ request_id: requestId, status: previous.state === 'pending' ? 'outcome_unknown' : 'completed', replayed: true,
        result: previous.result, observation: 'not_replayed; call phone_observe for a fresh frame' });
    }
    return this.controlled(key, async () => {
      if ((await readdir(this.store.dir)).filter(n => n.startsWith('request-')).length >= 10000) throw new Error('PHONE_JOURNAL_FULL');
      // The lock serializes reads as well as writes to the device and the journal.
      if (await this.store.read(file)) throw new Error('PHONE_REQUEST_RETRY');
      const completedWithoutDispatch = async (result: unknown) => {
        await this.store.save(file, { fingerprint, lease_hash: digest(key), state: 'completed', result });
        return json(result);
      };
      let command: string[];
      if (name === 'phone_input') {
        const input = phoneSchemas.phone_input.parse(args);
        const expected = await this.store.read<Frame>('frame.json');
        if (!expected || expected.frame_id !== input.frame_id || this.now() - expected.at > this.config.frame_seconds * 1000) throw new Error('PHONE_FRAME_EXPIRED');
        const current = await this.capture(false);
        if (this.now() - expected.at > this.config.frame_seconds * 1000) throw new Error('PHONE_FRAME_EXPIRED');
        if (current.frame.hash !== expected.hash || current.frame.package !== expected.package || current.frame.rotation !== expected.rotation || current.frame.width !== expected.width || current.frame.height !== expected.height) throw new Error('PHONE_FRAME_CHANGED');
        const a = input.action;
        if ('x' in a && (a.x >= expected.width || a.y >= expected.height || ('to_x' in a && (a.to_x >= expected.width || a.to_y >= expected.height)))) throw new Error('PHONE_COORDINATES_OUTSIDE_FRAME');
        if (a.type === 'tap') command = ['input', 'tap', String(a.x), String(a.y)];
        else if (a.type === 'long_press') command = ['input', 'swipe', String(a.x), String(a.y), String(a.x), String(a.y), String(a.duration_ms)];
        else if (a.type === 'swipe') command = ['input', 'swipe', String(a.x), String(a.y), String(a.to_x), String(a.to_y), String(a.duration_ms)];
        else if (a.type === 'key') command = ['input', 'keyevent', `KEYCODE_${a.key}`];
        else {
          if (!this.config.ime_enabled) throw new Error('PHONE_IME_NOT_CONFIGURED');
          if ((await this.shell('settings', 'get', 'secure', 'default_input_method')).trim() !== 'org.workbench.ime/.WorkbenchIme') throw new Error('PHONE_IME_NOT_SELECTED');
          command = ['am', 'broadcast', '-a', 'org.workbench.ime.INPUT', '-p', 'org.workbench.ime', '--es', 'payload', Buffer.from(a.text).toString('base64'), '--es', 'mode', a.mode];
        }
      } else if (name === 'phone_open_app') {
        const output = await this.shell('cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', args.package as string);
        const component = output.trim().split(/\r?\n/).at(-1) ?? '';
        if (!/^[A-Za-z][\w.]*\/[A-Za-z_.][\w.$]*$/.test(component) || component.split('/')[0] !== args.package) throw new Error('PHONE_APP_NOT_LAUNCHABLE');
        command = ['am', 'start', '-n', `'${component}'`];
      } else if (name === 'phone_display') {
        if (args.action === 'physical_off') return completedWithoutDispatch({ status: 'unsupported_unverified', physical_screen_off: 'unknown', recovery: 'Use phone_display wake or the physical power button. No scrcpy process is started.' });
        command = ['input', 'keyevent', 'KEYCODE_WAKEUP'];
      } else if (args.action === 'check') {
        const status = await this.status();
        return completedWithoutDispatch({ ...status, status: status.adb.state === 'device' ? 'connection_available_first_unlock_unknown' : 'needs_user_action' });
      }
      else if (args.action === 'reconnect') {
        // adb reconnect can affect transport state held by Phone-Host. Probe only in this implementation.
        return completedWithoutDispatch({ status: 'needs_user_action', action: 'Reconnect USB and authorize this OS account on the phone; shared ADB server and Phone-Host remain untouched.', first_unlock: 'unknown' });
      } else command = ['input', 'keyevent', 'KEYCODE_WAKEUP'];
      await this.renew(key);
      const record: Request = { fingerprint, lease_hash: digest(key), state: 'pending' };
      await this.store.save(file, record);
      await this.lease(key); // Local pause revokes the capability before dispatch.
      try {
        const output = await this.shell(...command);
        if (name === 'phone_input' && (args.action as {type: string}).type === 'text' && !/result=1\b/.test(output)) throw new Error('PHONE_IME_UNCONFIRMED');
        const observation = await this.capture(false);
        const result = { status: 'completed', request_id: requestId, request_sent: true,
          target_app_observed: name === 'phone_open_app' ? observation.frame.package === args.package : undefined };
        await this.store.save(file, { ...record, state: 'completed', result });
        // A paused or expired lease is never silently resurrected.
        await this.renew(key).catch(() => {});
        return this.observation(observation, result);
      } catch {
        this.fault('PHONE_OUTCOME_UNKNOWN');
        return json({ status: 'outcome_unknown', request_id: requestId, observation: 'unavailable; do not repeat under a new request_id' });
      }
    });
  }
  async call(name: PhoneTool, raw: unknown): Promise<CallToolResult> {
    try {
      const args = phoneSchemas[name].parse(raw) as Record<string, unknown>;
      if (['phone_input', 'phone_open_app', 'phone_display', 'phone_recover'].includes(name)) return await this.write(name, args);
      return await this.store.lock(async () => {
        if (name === 'server_status') return json(await this.status());
        if (name === 'phone_observe') return this.observation(await this.capture(args.ui as boolean));
        if (name === 'phone_list_apps') return this.listApps(phoneSchemas.phone_list_apps.parse(args));
        if (name === 'phone_release_control') {
          const current = await this.readLease();
          if (current?.hash === digest(args.lease_id as string)) await this.store.save('lease.json', null);
          return json({ released: true });
        }
        if (await this.store.paused()) throw new Error('PHONE_ADMIN_PAUSED');
        const current = await this.readLease();
        if (current && current.expires > this.now() && current.epoch === await this.epoch()) return json({ status: 'busy', expires_at: new Date(current.expires).toISOString() });
        const leaseId = token(), expires = this.now() + this.config.lease_seconds * 1000;
        await this.store.save('lease.json', { hash: digest(leaseId), expires, epoch: await this.epoch() });
        return json({ lease_id: leaseId, expires_at: new Date(expires).toISOString(), identity: 'bearer_capability; actual client account unknown' });
      });
    } catch (e) {
      const message = e instanceof Error && /^PHONE_[A-Z_]+$|^ADB_FAILED_OR_TIMEOUT$/.test(e.message) ? e.message : 'PHONE_INVALID_REQUEST_OR_STATE';
      this.fault(message);
      return { isError: true, ...json({ error: message }) };
    }
  }
}
