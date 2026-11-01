#!/usr/bin/env node
// breakrocks-news: the MCP server on stdio, and the commands of the autonomous loop.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { launchesRoot, loadLaunch } from './config.js';
import { launchStatus, LockedError, runLoop, stopFile } from './loop.js';
import { schedule, unschedule, type Scheduler } from './schedule.js';
import { createServer } from './server.js';
import { collect, pendingEvents } from './service.js';
import { loadCatalogue, writeLaunch } from './setup.js';
import { answersFromFile, answersFromFlags, completeAnswers, existed, parseFlags, terminalIo } from './start.js';

const USAGE = `Usage:
  breakrocks-news                          the MCP server on stdio
  breakrocks-news start [flags]            set up a launch (asks for what is missing) and start its loop
  breakrocks-news run <launch> [--once]    the loop: collect, AI run within the caps, log, sleep
  breakrocks-news status <launch> [--json] last run, counts, caps, errors
  breakrocks-news stop <launch>            the kill switch: creates launches/<launch>/STOP
  breakrocks-news schedule <launch> [--print] [--scheduler launchd|systemd|cron]
  breakrocks-news unschedule <launch>
  breakrocks-news collect <launch> [--force]
  breakrocks-news pending <launch>

start flags (all optional; --yes never asks):
  --name <name> --scope world | --countries FR,BE | --languages fr,en      (up to 20)
  --themes tech,science          politics economy sport entertainment culture tech crime_justice
                                 international science climate health
  --universe tech=%tech,%tech-fr  (repeat per theme; main universe first, then reposts)
  --universes %a,%b              (the same universes for every theme)
  --every 30m --per-hour 4 --per-day 30 --batch 5
  --verification corroborated|to-confirm  --mode dry-run|live (or --live / --dry-run)
  --runner claude|codex|custom --runner-template "<cmd with {prompt} {mcpConfig} ...>"
  --operator-id <id> --agent-id <id> --agent-key-file <path>   (the key is never printed)
  --breakrocks-cmd "breakrocks"  --from <start.yaml|config.yaml>  --skip-universe-check
  --yes  --no-run  --once`;

const home = () => resolve(launchesRoot(), '..');
const [cmd, ...args] = process.argv.slice(2);

function defaultBreakrocks(): string {
  try { execFileSync('sh', ['-c', 'command -v breakrocks'], { stdio: 'ignore' }); return 'breakrocks'; } catch { return 'npx -y breakrocks'; }
}

async function main() {
  const { flags, positionals } = parseFlags(args);
  const name = positionals[0];
  if (flags.help) { console.log(USAGE); return; }
  switch (cmd) {
    case undefined: await createServer().connect(new StdioServerTransport()); return;
    case 'collect': if (!name) break; console.log(JSON.stringify(await collect(loadLaunch(name), { force: !!flags.force }), null, 2)); return;
    case 'pending': if (!name) break; console.log(JSON.stringify(pendingEvents(loadLaunch(name), 50), null, 2)); return;
    case 'start': {
      const given = { ...(typeof flags.from === 'string' ? answersFromFile(flags.from) : {}), ...answersFromFlags(flags) };
      given.breakrocks ??= defaultBreakrocks();
      const yes = !!flags.yes;
      const io = yes ? undefined : terminalIo();
      try {
        const answers = await completeAnswers(given, { home: home(), io, yes, skipUniverseCheck: !!flags['skip-universe-check'], existed: existed(home(), given.name) });
        const { dir, sources } = writeLaunch(home(), answers, loadCatalogue());
        console.log(`\n${answers.name}: ${sources.length} sources, ${answers.themes.join(', ')}, ${answers.mode === 'live' ? 'LIVE' : 'dry run (drafts in drafts/)'}; caps ${answers.perHour}/h, ${answers.perDay}/day; runner ${answers.runner.kind}.`);
        console.log(`Written: ${dir}/{config.yaml,sources.yaml,start.yaml,.mcp.json}`);
        if (flags['no-run']) { console.log(`Next: breakrocks-news run ${answers.name}   (or schedule ${answers.name})`); return; }
        io?.close();
        console.log(`Starting the loop (Ctrl-C to stop, or: breakrocks-news stop ${answers.name}).`);
        await runLoop(loadLaunch(answers.name), { once: !!flags.once });
      } finally { io?.close(); }
      return;
    }
    case 'run': if (!name) break; await runLoop(loadLaunch(name), { once: !!flags.once }); return;
    case 'status': {
      if (!name) break;
      const s = launchStatus(loadLaunch(name));
      if (flags.json) { console.log(JSON.stringify(s, null, 2)); return; }
      console.log(`${s.launch}: ${s.mode}${s.stop ? ', STOPPED (STOP file)' : ''}${s.running ? `, running (pid ${s.running.pid} since ${s.running.startedAt})` : ', not running'}`);
      console.log(`runs: ${s.runs}, last ${s.lastRun?.at ?? 'never'}, last AI run ${s.lastAiRun ?? 'never'}`);
      console.log(`store: ${s.counts?.articles} articles, ${s.counts?.events} events, ${s.counts?.publications} publications; events ${JSON.stringify(s.events)}; ${s.pending} pending`);
      if (s.caps) console.log(`caps: ${s.caps.used.hour}/${s.caps.perHour} this hour, ${s.caps.used.day}/${s.caps.perDay} today, batch ${s.caps.batch}`);
      if (s.recentErrors.length) console.log(`recent errors:\n  ${s.recentErrors.join('\n  ')}`);
      return;
    }
    case 'stop': if (!name) break; { const l = loadLaunch(name); writeFileSync(stopFile(l), `stopped ${new Date().toISOString()}\n`); console.log(`${stopFile(l)} created: the loop stops at its next check. Delete it to resume.`); } return;
    case 'schedule': if (!name) break; console.log(schedule(loadLaunch(name), home(), { print: !!flags.print, scheduler: flags.scheduler as Scheduler | undefined })); return;
    case 'unschedule': if (!name) break; console.log(unschedule(loadLaunch(name), home(), { scheduler: flags.scheduler as Scheduler | undefined })); return;
  }
  console.error(USAGE);
  process.exitCode = 2;
}

try { await main(); } catch (e) {
  console.error(e instanceof LockedError ? e.message : `Error: ${(e as Error).message}`);
  process.exitCode = 1;
}
