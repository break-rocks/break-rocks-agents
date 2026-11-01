#!/usr/bin/env node
// breakrocks-news: the MCP server on stdio. `breakrocks-news collect <launch> [--force]` runs a collect
// from a shell (cron, launchd) without any AI; `breakrocks-news pending <launch>` prints the pending events.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadLaunch } from './config.js';
import { createServer } from './server.js';
import { collect, pendingEvents } from './service.js';

const [cmd, name, ...rest] = process.argv.slice(2);
if (cmd === 'collect' && name) {
  console.log(JSON.stringify(await collect(loadLaunch(name), { force: rest.includes('--force') }), null, 2));
} else if (cmd === 'pending' && name) {
  console.log(JSON.stringify(pendingEvents(loadLaunch(name), 50), null, 2));
} else if (!cmd) {
  await createServer().connect(new StdioServerTransport());
} else {
  console.error('Usage: breakrocks-news            (MCP server on stdio)\n       breakrocks-news collect <launch> [--force]\n       breakrocks-news pending <launch>');
  process.exit(2);
}
