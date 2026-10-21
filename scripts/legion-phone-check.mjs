#!/usr/bin/env node
// Local read-only device acceptance: no taps, launch, wake, IME selection, or daemon control.
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

if (hostname().toUpperCase() !== 'LAPTOP-NHHRR3GO') throw new Error('This acceptance script runs only on LAPTOP-NHHRR3GO; ROG is not the target.');
const config = process.argv[2];
if (!config || !isAbsolute(config)) throw new Error('Usage: node scripts/legion-phone-check.mjs ABSOLUTE_WORKSPACES_JSON [--ui]');
const client = new Client({ name: 'legion-phone-readonly-check', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [fileURLToPath(new URL('../dist/src/mcp-stdio.js', import.meta.url)), resolve(config)], stderr: 'pipe' });
const timeout = setTimeout(() => { void client.close().finally(() => { process.exitCode = 1; }); }, 110000);
const parse = r => {
  if (r.isError) throw new Error(r.content?.find(c => c.type === 'text')?.text ?? 'MCP error');
  return JSON.parse(r.content.find(c => c.type === 'text').text);
};
try {
  await client.connect(transport);
  const names = new Set((await client.listTools()).tools.map(t => t.name));
  for (const name of ['list_workspaces', 'host_capabilities', 'run_temp', 'server_status', 'phone_acquire_control', 'phone_release_control', 'phone_observe', 'phone_list_apps', 'phone_open_app', 'phone_input', 'phone_sequence', 'phone_display', 'phone_recover']) assert.ok(names.has(name), name);
  parse(await client.callTool({ name: 'list_workspaces', arguments: {} }));
  const status = parse(await client.callTool({ name: 'server_status', arguments: {} }, undefined, { timeout: 60000 }));
  assert.equal(status.hostname.toUpperCase(), 'LAPTOP-NHHRR3GO');
  assert.equal(status.adb.serial, 'AYCVVB2B09005827');
  console.log(JSON.stringify({ hostname: status.hostname, adb: status.adb, first_unlock: status.first_unlock, battery: status.battery, display: status.display }));
  if (status.adb.state !== 'device') throw new Error('needs_user_action: USB/ADB authorization must be verified under the actual service account.');
  const observation = await client.callTool({ name: 'phone_observe', arguments: { ui: process.argv.includes('--ui') } }, undefined, { timeout: 60000 });
  const frame = parse(observation);
  assert.ok(observation.content.some(c => c.type === 'image' && c.mimeType === 'image/png'));
  assert.ok(Buffer.byteLength(JSON.stringify(observation)) < 10 * 1024 * 1024);
  assert.equal(frame.coordinate_space, 'original_physical_pixels');
  assert.deepEqual([frame.width, frame.height].sort((a,b) => a-b), [1080, 2400]);
  parse(await client.callTool({ name: 'phone_list_apps', arguments: { limit: 1 } }));
  console.log(JSON.stringify({ read_only_probe: 'passed', frame: { width: frame.width, height: frame.height, rendered: frame.rendered, rotation: frame.rotation, ui_status: frame.ui.status, flag_secure: frame.flag_secure }, hardware_writes_tested: false, tunnel_tested: false }));
} finally { clearTimeout(timeout); await client.close(); }
