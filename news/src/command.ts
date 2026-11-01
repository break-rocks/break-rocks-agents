// The complete non-interactive command that replays a set of answers: printed at the end of the wizard
// and saved as <news home>/launches/<name>/start.sh. Never carries a secret: the agent is a name (its key
// stays in the system keychain, with the breakrocks CLI); a deprecated key is a path, never its content.
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StartAnswers } from './setup.js';

const SAFE = /^[A-Za-z0-9_@/.:,+-]+$/;

/** One shell word: left bare when it only holds safe characters, else single-quoted (a quote becomes '\''). */
export function shellQuote(value: string): string {
  if (SAFE.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The flags (name and value words) that replay the answers, in a stable order. */
export function startFlags(a: StartAnswers): string[][] {
  const flags: string[][] = [['--name', a.name]];
  if (a.description) flags.push(['--description', a.description]);
  flags.push(a.scope.kind === 'world' ? ['--scope', 'world'] : [`--${a.scope.kind}`, a.scope.values.join(',')]);
  flags.push(['--themes', a.themes.join(',')]);
  for (const t of a.themes) flags.push(['--universe', `${t}=${a.universes[t]!.join(',')}`]);
  flags.push(['--every', a.every], ['--per-hour', String(a.perHour)], ['--per-day', String(a.perDay)], ['--batch', String(a.batch)]);
  flags.push(['--verification', a.verification.replace('_', '-')]);
  flags.push(['--mode', a.mode === 'live' ? 'live' : 'dry-run']);
  flags.push(['--runner', a.runner.kind]);
  if (a.runner.template) flags.push(['--runner-template', a.runner.template]);
  if (a.identity.agent) flags.push(['--agent', a.identity.agent]);
  if (a.identity.operatorId) flags.push(['--operator-id', a.identity.operatorId]);
  if (a.identity.agentId) flags.push(['--agent-id', a.identity.agentId]);
  if (a.identity.keyFile) flags.push(['--agent-key-file', a.identity.keyFile]);
  if (a.breakrocks !== 'breakrocks') flags.push(['--breakrocks-cmd', a.breakrocks]);
  return flags;
}

export const LIVE_NOTE = '# Live with --yes only works on a launch that already exists; for a new name the first start is a dry run.';

/** `breakrocks-news start --yes \` then one flag per line, each continued by ` \`. */
export function startCommand(a: StartAnswers): string {
  const lines = ['breakrocks-news start --yes', ...startFlags(a).map((f) => f.map(shellQuote).join(' '))];
  const command = lines.map((l, i) => (i === 0 ? l : `  ${l}`)).join(' \\\n');
  return a.mode === 'live' ? `${LIVE_NOTE}\n${command}` : command;
}

/** Replays the saved answers; [dir]: the launch folder (in the news home). */
export const shortCommand = (dir: string) => `breakrocks-news start --yes --from ${shellQuote(join(dir, 'start.yaml'))}`;

/** The block printed before the loop starts. */
export function commandBlock(a: StartAnswers, dir: string): string {
  return ['', 'Run the same launch again without questions:', '', startCommand(a), '', 'or, from the saved answers:', '', shortCommand(dir), '', `Saved in ${join(dir, 'start.sh')}`].join('\n');
}

/** Writes <launch dir>/start.sh (mode 0700) next to start.yaml. Returns its path. */
export function writeStartScript(dir: string, a: StartAnswers): string {
  const file = join(dir, 'start.sh');
  writeFileSync(file, `#!/bin/sh\n# ${a.name}: the same launch again, without questions. Written by \`breakrocks-news start\`.\n${startCommand(a)}\n`, { mode: 0o700 });
  chmodSync(file, 0o700);
  return file;
}
