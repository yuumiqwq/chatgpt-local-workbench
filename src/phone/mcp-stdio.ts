import { isAbsolute } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { VERSION } from '../version.js';
import { loadPhoneConfig } from './config.js';
import { RealAdb } from './adb.js';
import { PhoneService } from './service.js';
import { PHONE_EFFICIENCY_INSTRUCTIONS, registerPhoneTools } from './tools.js';

async function main() {
  const path = process.argv[2];
  if (process.argv.length !== 3 || !path || !isAbsolute(path)) throw new Error('PHONE_CONFIG_PATH_REQUIRED');
  const config = await loadPhoneConfig(path);
  if (!config) throw new Error('PHONE_NOT_CONFIGURED');
  const server = new McpServer({ name: 'legion-phone-local', version: VERSION }, {
    instructions: `Local phone tools use the existing ADB connection and shared control lease. Acquire control for writes and release it when finished. ${PHONE_EFFICIENCY_INSTRUCTIONS}`
  });
  registerPhoneTools(server, new PhoneService(config, new RealAdb(config)));
  await server.connect(new StdioServerTransport());
}

main().catch(() => { console.error('PHONE_LOCAL_STARTUP_FAILED'); process.exitCode = 1; });
