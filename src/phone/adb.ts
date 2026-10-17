import { execFile, type ExecFileOptionsWithBufferEncoding } from 'node:child_process';
import type { PhoneConfig } from './config.js';

export interface Adb { run(args: string[]): Promise<Buffer> }
export type ExecuteAdb = (executable: string, args: string[], options: ExecFileOptionsWithBufferEncoding,
  callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void) => unknown;
export class RealAdb implements Adb {
  constructor(private config: PhoneConfig, private execute: ExecuteAdb = execFile) {}
  run(args: string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.execute(this.config.adb_path, ['-s', this.config.serial, ...args], {
        encoding: 'buffer', timeout: 8000, maxBuffer: 16 * 1024 * 1024,
        windowsHide: true, env: { ...process.env, ADB_SERVER_SOCKET: 'tcp:localhost:5037' }
      }, (error, stdout) => error ? reject(new Error('ADB_FAILED_OR_TIMEOUT')) : resolve(stdout));
    });
  }
}
