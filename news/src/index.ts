#!/usr/bin/env node
// breakrocks-news: the MCP server on stdio, and the commands of the autonomous loop.
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { commandBlock, writeStartScript } from './command.js';
import { cliOf, doctorGate } from './cli.js';
import { examplesDir, launchesRoot, loadLaunch, migrateKitLaunches, newsHome } from './config.js';
import { launchStatus, LockedError, runLoop, stopFile } from './loop.js';
import { schedule, unschedule, type Scheduler } from './schedule.js';
import { createServer } from './server.js';
import { collect, openStore, pendingEvents, purgeLaunch } from './service.js';
import { answersFromExample, loadCatalogue, writeLaunch } from './setup.js';
import type { Launch } from './types.js';
import { answersFromFile, answersFromFlags, completeAnswers, existed, parseFlags, terminalIo } from './start.js';

const USAGE = `Usage:
  breakrocks-news                          the MCP server on stdio
  breakrocks-news start [flags]            set up a launch (asks for what is missing) and start its loop
  breakrocks-news run <launch> [--once]    the loop: collect, AI run within the caps, log, sleep
  breakrocks-news status <launch> [--json] last run, counts, caps, errors
  breakrocks-news stop <launch>            the kill switch: creates <home>/launches/<launch>/STOP
  breakrocks-news schedule <launch> [--print] [--scheduler launchd|systemd|cron]
  breakrocks-news unschedule <launch>
  breakrocks-news collect <launch> [--force]
  breakrocks-news pending <launch>
  breakrocks-news purge <launch>           delete what is past retention now, then VACUUM

Launches live in the news home: ~/.breakrocks/kits/news/launches/<name>/ (BREAKROCKS_NEWS_HOME or --home
to change it; BREAKROCKS_HOME moves the breakrocks home).

start flags (all optional; --yes never asks):
  --name <name> --scope world | --countries FR,BE | --languages fr,en      (up to 20)
  --themes tech,science          politics economy sport entertainment culture tech crime_justice
                                 international science climate health
  --universe tech=%tech,%tech-fr  (repeat per theme; main universe first, then reposts)
  --universes %a,%b              (the same universes for every theme)
  --every 30m --per-hour 4 --per-day 30 --batch 5
  --verification corroborated|to-confirm  --mode dry-run|live (or --live / --dry-run)
  --decider / --no-decider        decision model (local Strands Decider via Ollama) for merges and promos; off by default
  --runner claude|codex|custom --runner-template "<cmd with {prompt} {mcpConfig} ...>"
  --agent <name>                 a local agent of the breakrocks CLI (breakrocks agents local); asked if absent
  --from-example <name>          start from an example of the kit (examples/: fr-tech, world-economy)
  --breakrocks-cmd "breakrocks"  --from <start.yaml|config.yaml>  --skip-universe-check  --home <dir>
  deprecated: --operator-id <id> --agent-id <id> --agent-key-file <path>  (use --agent)
  --yes  --no-run  --once`;

const home = () => resolve(launchesRoot(), '..');
const [cmd, ...args] = process.argv.slice(2);

/** The breakrocks CLI installed on this computer (on PATH); none: how to install it. */
function defaultBreakrocks(): string {
  try { execFileSync(process.platform === 'win32' ? 'where' : 'sh', process.platform === 'win32' ? ['breakrocks'] : ['-c', 'command -v breakrocks'], { stdio: 'ignore' }); return 'breakrocks'; } catch {
    throw new Error('The breakrocks CLI is not on PATH: install it (npm i -g breakrocks, or the installer of break-rocks-cli), or give --breakrocks-cmd');
  }
}

/** doctor of the breakrocks CLI for the launch's agent, before the loop: a failure stops with its reasons. */
async function checkBeforeLoop(launch: Launch) {
  const agent = launch.config.agent;
  if (!agent || (agent.mode !== 'live' && !agent.identity.agent)) return;
  const report = await doctorGate(cliOf(agent.breakrocks), agent.identity.agent, agent.identity.env);
  console.log(`breakrocks doctor: ${report.checks.map((c) => `${c.name} ${c.status}`).join(', ')}`);
}

async function main() {
  const { flags, positionals } = parseFlags(args);
  const name = positionals[0];
  if (flags.help) { console.log(USAGE); return; }
  if (typeof flags.home === 'string') process.env.BREAKROCKS_NEWS_HOME = resolve(flags.home);
  if (cmd !== undefined) {
    const { moved, kept } = migrateKitLaunches();
    if (moved.length) console.log(`Moved the launches ${moved.join(', ')} from the kit to ${launchesRoot()}`);
    if (kept.length) console.log(`Left in the kit (a launch of the same name is in ${launchesRoot()}): ${kept.join(', ')}`);
  }
  switch (cmd) {
    case undefined: await createServer().connect(new StdioServerTransport()); return;
    case 'collect': if (!name) break; console.log(JSON.stringify(await collect(loadLaunch(name), { force: !!flags.force }), null, 2)); return;
    case 'pending': if (!name) break; console.log(JSON.stringify(pendingEvents(loadLaunch(name), 50), null, 2)); return;
    case 'purge': {
      if (!name) break;
      const l = loadLaunch(name), store = openStore(l);
      try { console.log(JSON.stringify(purgeLaunch(l, store), null, 2)); } finally { store.close(); }
      return;
    }
    case 'start': {
      let example = {};
      if (typeof flags['from-example'] === 'string') {
        const file = join(examplesDir(), flags['from-example'], 'config.yaml');
        if (!/^[a-z0-9-]+$/.test(flags['from-example']) || !existsSync(file)) throw new Error(`No example "${flags['from-example']}" in ${examplesDir()}`);
        example = { name: flags['from-example'], ...answersFromExample(file) };
      }
      const given = { ...example, ...(typeof flags.from === 'string' ? answersFromFile(flags.from) : {}), ...answersFromFlags(flags) };
      if (given.identity?.operatorId || given.identity?.agentId || given.identity?.keyFile) console.error('--operator-id, --agent-id and --agent-key-file are deprecated: keep the agent with breakrocks agents import <name> --operator … --agent … --key <file>, then pass --agent <name>');
      given.breakrocks ??= defaultBreakrocks();
      const yes = !!flags.yes;
      const io = yes ? undefined : terminalIo();
      try {
        const answers = await completeAnswers(given, { home: newsHome(), io, yes, skipUniverseCheck: !!flags['skip-universe-check'], existed: existed(home(), given.name), cli: cliOf(given.breakrocks) });
        const { dir, sources } = writeLaunch(home(), answers, loadCatalogue());
        console.log(`\n${answers.name}: ${sources.length} sources, ${answers.themes.join(', ')}, ${answers.mode === 'live' ? 'LIVE' : 'dry run (drafts in drafts/)'}; caps ${answers.perHour}/h, ${answers.perDay}/day; runner ${answers.runner.kind}.`);
        console.log(`Written: ${dir}/{config.yaml,sources.yaml,start.yaml,start.sh,.mcp.json}`);
        writeStartScript(dir, answers);
        console.log(commandBlock(answers, dir));
        if (flags['no-run']) { console.log(`Next: breakrocks-news run ${answers.name}   (or schedule ${answers.name})`); return; }
        io?.close();
        await checkBeforeLoop(loadLaunch(answers.name));
        console.log(`Starting the loop (Ctrl-C to stop, or: breakrocks-news stop ${answers.name}).`);
        await runLoop(loadLaunch(answers.name), { once: !!flags.once });
      } finally { io?.close(); }
      return;
    }
    case 'run': if (!name) break; await checkBeforeLoop(loadLaunch(name)); await runLoop(loadLaunch(name), { once: !!flags.once }); return;
    case 'status': {
      if (!name) break;
      const s = launchStatus(loadLaunch(name));
      if (flags.json) { console.log(JSON.stringify(s, null, 2)); return; }
      console.log(`${s.launch}: ${s.mode}${s.stop ? ', STOPPED (STOP file)' : ''}${s.running ? `, running (pid ${s.running.pid} since ${s.running.startedAt})` : ', not running'}`);
      console.log(`runs: ${s.runs}, last ${s.lastRun?.at ?? 'never'}, last AI run ${s.lastAiRun ?? 'never'}`);
      console.log(`store: ${s.counts?.articles} articles, ${s.counts?.events} events, ${s.counts?.publications} publications; events ${JSON.stringify(s.events)}; ${s.pending} pending`);
      console.log(`grouping: ${s.similarity}; last purge ${s.lastPurge ?? 'never'}`);
      for (const h of s.heldSources) console.log(`source ${h.id}: ${'disabledUntil' in h ? `DISABLED until ${h.disabledUntil}` : `backoff until ${h.backoffUntil}`} (${h.consecutive429} x 429)`);
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
