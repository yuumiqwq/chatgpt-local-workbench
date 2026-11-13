import { apiNameProfile, createToolRegistry, toolText } from "../api-names.js";
import { isAbsolute } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { VERSION } from '../version.js';
import { loadPhoneConfig } from './config.js';
import { RealAdb } from './adb.js';
import { PhoneService } from './service.js';
import { PHONE_INSTRUCTIONS, PHONE_EFFICIENCY_INSTRUCTIONS, registerPhoneTools } from './tools.js';

async function main() {
  const nameProfile = apiNameProfile();
  const path = process.argv[2];
  if (process.argv.length !== 3 || !path || !isAbsolute(path)) throw new Error('PHONE_CONFIG_PATH_REQUIRED');
  const config = await loadPhoneConfig(path);
  if (!config) throw new Error('PHONE_NOT_CONFIGURED');
  const server = new McpServer({ name: 'legion-phone-local', version: VERSION, title: `Workbench phone (API names ${nameProfile})` }, {
    instructions: toolText(`${PHONE_INSTRUCTIONS} ${PHONE_EFFICIENCY_INSTRUCTIONS}`, nameProfile)
  });
  const tools = createToolRegistry(server, nameProfile);
  registerPhoneTools(tools, new PhoneService(config, new RealAdb(config)));
  await server.connect(new StdioServerTransport());
}

main().catch(() => { console.error('PHONE_LOCAL_STARTUP_FAILED'); process.exitCode = 1; });
