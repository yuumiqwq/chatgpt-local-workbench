import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { PhoneConfig } from './config.js';
import type { PhoneContext } from './context.js';
import type { Adb } from './adb.js';
import { dirname, join } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export type DragPoint = { x: number; y: number };
export interface PhoneDrag {
  start(context: PhoneContext, point: DragPoint, leaseHash: string, epoch: string, dragId: string): Promise<void>;
  move(point: DragPoint, duration: number): Promise<void>;
  end(cancel: boolean): Promise<void>;
}

// scrcpy 5.0.1 control protocol. A finger uses -2, distinct from mouse (-1).
export function touchPacket(action: 0 | 1 | 2 | 3, point: DragPoint, size: { width: number; height: number }): Buffer {
  if (![point.x, point.y, size.width, size.height].every(Number.isInteger) || point.x < 0 || point.y < 0 ||
    size.width < 1 || size.height < 1 || size.width > 16384 || size.height > 16384 || point.x >= size.width || point.y >= size.height)
    throw new Error('PHONE_COORDINATES_OUTSIDE_FRAME');
  const packet = Buffer.alloc(32);
  packet[0] = 2; packet[1] = action; packet.writeBigInt64BE(-2n, 2);
  packet.writeInt32BE(point.x, 10); packet.writeInt32BE(point.y, 14);
  packet.writeUInt16BE(size.width, 18); packet.writeUInt16BE(size.height, 20);
  packet.writeUInt16BE(action === 1 || action === 3 ? 0 : 0xffff, 22);
  return packet;
}

// This adapter runs in a separate child. Parent death closes IPC, so the child
// can send CANCEL and remove its own forward without relying on parent cleanup.
export class ScrcpyTouchConnection {
  private socket: Socket | undefined;
  private server: ChildProcess | undefined;
  private port: number | undefined;
  private remote: string | undefined;
  private point: DragPoint | undefined;
  private size: { width: number; height: number } | undefined;
  constructor(private config: PhoneConfig, private adb: Adb) {}
  async open() {
    if (!this.config.scrcpy_path) throw new Error('PHONE_DRAG_NOT_CONFIGURED');
    const version = await new Promise<string>((resolve, reject) => execFile(this.config.scrcpy_path!, ['--version'],
      { windowsHide: true, timeout: 5000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    if (!/^scrcpy 5\.0\.1\b/.test(version)) throw new Error('PHONE_DRAG_SCRCPY_VERSION_UNSUPPORTED');
    const scid = (randomBytes(4).readUInt32BE() & 0x7fffffff).toString(16).padStart(8, '0');
    this.remote = `/data/local/tmp/workbench-drag-${scid}.jar`;
    try {
      await this.adb.run(['push', join(dirname(this.config.scrcpy_path), 'scrcpy-server'), this.remote]);
      this.port = Number((await this.adb.run(['forward', 'tcp:0', `localabstract:scrcpy_${scid}`])).toString().trim());
      if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) throw new Error('PHONE_DRAG_FORWARD_FAILED');
      this.server = execFile(this.config.adb_path, ['-s', this.config.serial, 'shell', `CLASSPATH=${this.remote}`,
        'app_process', '/', 'com.genymobile.scrcpy.Server', '5.0.1', `scid=${scid}`, 'log_level=error',
        'video=false', 'audio=false', 'control=true', 'tunnel_forward=true', 'send_device_meta=false',
        'clipboard_autosync=false', 'power_on=false', 'cleanup=false'],
      { windowsHide: true, maxBuffer: 128 * 1024, env: { ...process.env, ADB_SERVER_SOCKET: 'tcp:localhost:5037' } });
      this.server.on('error', () => {});
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          this.socket = await new Promise<Socket>((resolve, reject) => {
            const socket = createConnection({ host: '127.0.0.1', port: this.port! });
            const timer = setTimeout(() => { socket.destroy(); reject(new Error('PHONE_DRAG_CONNECT_FAILED')); }, 200);
            const fail = () => { clearTimeout(timer); socket.destroy(); reject(new Error('PHONE_DRAG_CONNECT_FAILED')); };
            socket.once('error', fail); socket.once('close', fail);
            // The server's dummy byte confirms acceptance, unlike TCP connect to adb.
            socket.once('data', () => { clearTimeout(timer); socket.off('error', fail); socket.off('close', fail);
              socket.on('error', () => {}); socket.on('data', () => {}); socket.setNoDelay(true); resolve(socket); });
          });
          return;
        } catch { if (this.server.exitCode !== null) break; await delay(75); }
      }
      throw new Error('PHONE_DRAG_CONNECT_FAILED');
    } catch (error) { await this.close(); throw error; }
  }
  private async send(action: 0 | 1 | 2 | 3, point: DragPoint) {
    if (!this.socket || this.socket.destroyed || !this.size) throw new Error('PHONE_DRAG_CONNECTION_LOST');
    const packet = touchPacket(action, point, this.size);
    await new Promise<void>((resolve, reject) => this.socket!.write(packet, error => error ? reject(error) : resolve()));
    this.point = point;
  }
  async start(size: { width: number; height: number }, point: DragPoint) {
    this.size = size; await this.send(0, point);
  }
  async move(point: DragPoint, duration: number) {
    if (!this.point) throw new Error('PHONE_DRAG_NOT_ACTIVE');
    touchPacket(2, point, this.size!);
    const from = this.point, count = Math.max(1, Math.ceil(duration / 16)), start = performance.now();
    for (let i = 1; i <= count; i++) {
      const t = i / count, eased = t * t * (3 - 2 * t);
      await delay(Math.max(0, start + duration * t - performance.now()));
      await this.send(2, { x: Math.round(from.x + (point.x - from.x) * eased), y: Math.round(from.y + (point.y - from.y) * eased) });
    }
  }
  async end(cancel: boolean) {
    if (this.point) { await this.send(cancel ? 3 : 1, this.point); this.point = undefined; await delay(40); }
  }
  async close() {
    try { await this.end(true); } catch { /* connection may already be lost */ }
    this.socket?.destroy(); this.socket = undefined;
    this.server?.kill(); this.server = undefined;
    if (this.port) await this.adb.run(['forward', '--remove', `tcp:${this.port}`]).catch(() => {});
    if (this.remote) await this.adb.run(['shell', 'rm', '-f', this.remote]).catch(() => {});
    this.port = undefined; this.remote = undefined;
  }
}

export class DragWorker implements PhoneDrag {
  private child: ChildProcess | undefined;
  private index = 0;
  private pending = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private config: PhoneConfig) {}
  private command(message: object): Promise<void> {
    const id = ++this.index;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); if (this.child?.connected) this.child.disconnect(); reject(new Error('PHONE_DRAG_WORKER_TIMEOUT')); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.child?.connected) { clearTimeout(timer); this.pending.delete(id); reject(new Error('PHONE_DRAG_NOT_ACTIVE')); return; }
      this.child.send({ ...message, id }, error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(new Error('PHONE_DRAG_CONNECTION_LOST')); }
      });
    });
  }
  async start(context: PhoneContext, point: DragPoint, leaseHash: string, epoch: string, dragId: string) {
    if (this.child) throw new Error('PHONE_DRAG_ALREADY_ACTIVE');
    const child = spawn(process.execPath, [fileURLToPath(new URL('./drag-worker.js', import.meta.url))], { windowsHide: true, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    this.child = child;
    child.on('message', (message: any) => {
      const item = this.pending.get(message.id); if (!item) return;
      clearTimeout(item.timer); this.pending.delete(message.id);
      if (message.error) item.reject(new Error(/^PHONE_[A-Z_]+$/.test(message.error) ? message.error : 'PHONE_DRAG_FAILED'));
      else item.resolve();
    });
    child.on('error', () => {});
    child.on('exit', () => {
      if (this.child === child) this.child = undefined;
      if (!this.child) {
        for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('PHONE_DRAG_CONNECTION_LOST')); }
        this.pending.clear();
      }
    });
    try { await this.command({ type: 'start', config: this.config, context, point, leaseHash, epoch, dragId }); }
    catch (e) { if (child.connected) child.disconnect(); throw e; }
  }
  async move(point: DragPoint, duration: number) { await this.command({ type: 'move', point, duration }); }
  async end(cancel: boolean) {
    if (!this.child) return;
    const child = this.child;
    try { await this.command({ type: 'end', cancel }); }
    finally { if (child.connected) child.disconnect(); this.child = undefined; }
  }
}
