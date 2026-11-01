// The AI runner of the loop: a command template (claude -p, codex exec, or the user's own) rendered into
// an argv (never through a shell), the run prompt (PROMPT.md + the run context), and the child process.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { kitDir } from './config.js';
import { splitCommand } from './setup.js';
import type { AgentSettings, Launch } from './types.js';

export const TEMPLATES: Record<'claude' | 'codex', string> = {
  claude: 'claude -p {prompt} --mcp-config {mcpConfig} --strict-mcp-config --allowedTools {allowedTools}',
  codex: 'codex exec --skip-git-repo-check -C {launchDir} -s read-only -c approval_policy="never" {codexMcp} {prompt}',
};

/** Read-only break.rocks tools a dry run may use. */
const READ_TOOLS = ['breakrocks_universes_show', 'breakrocks_universes_conditions_show', 'breakrocks_posts_show', 'breakrocks_whoami'];

export function allowedTools(mode: AgentSettings['mode']): string {
  return mode === 'live' ? 'mcp__breakrocks-news,mcp__breakrocks' : ['mcp__breakrocks-news', ...READ_TOOLS.map((t) => `mcp__breakrocks__${t}`)].join(',');
}

export interface TemplateVars { prompt: string; promptFile: string; mcpConfig: string; launch: string; launchDir: string; kitDir: string; allowedTools: string }

/**
 * Renders a template into an argv. Each word is split first, then its {placeholders} are replaced, so a
 * value never becomes several arguments and nothing is interpreted by a shell. A word that is exactly a
 * list placeholder ({codexMcp}) expands into its items (possibly none). Unknown placeholders are an error.
 */
export function renderTemplate(template: string, vars: TemplateVars, lists: Record<string, string[]> = {}): string[] {
  const out: string[] = [];
  for (const word of splitCommand(template)) {
    const list = /^\{(\w+)\}$/.exec(word)?.[1];
    if (list && list in lists) { out.push(...lists[list]!); continue; }
    out.push(word.replace(/\{(\w+)\}/g, (_, k: string) => {
      if (!(k in vars)) throw new Error(`Unknown placeholder {${k}} in the runner template (known: ${[...Object.keys(vars), ...Object.keys(lists)].map((x) => `{${x}}`).join(' ')})`);
      return vars[k as keyof TemplateVars];
    }));
  }
  if (!out.length) throw new Error('Empty runner template');
  return out;
}

/** Codex takes its MCP servers as -c overrides (TOML values). A dry run gets no break.rocks server at all. */
export function codexMcpArgs(mcp: { mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> }, mode: AgentSettings['mode']): string[] {
  const out: string[] = [];
  for (const [name, s] of Object.entries(mcp.mcpServers)) {
    if (name === 'breakrocks' && mode !== 'live') continue;
    const key = `mcp_servers.${JSON.stringify(name)}`;
    out.push('-c', `${key}.command=${JSON.stringify(s.command)}`, '-c', `${key}.args=${JSON.stringify(s.args)}`);
    const literal = Object.entries(s.env ?? {}).filter(([, v]) => !v.startsWith('${'));
    if (literal.length) out.push('-c', `${key}.env={${literal.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(',')}}`);
    const forwarded = Object.entries(s.env ?? {}).filter(([, v]) => v.startsWith('${')).map(([k]) => k);
    if (forwarded.length) out.push('-c', `${key}.env_vars=${JSON.stringify(forwarded)}`);
  }
  return out;
}

/** The prompt of one AI run: the run context first (it overrides the defaults of PROMPT.md), then PROMPT.md. */
export function buildPrompt(launch: Launch, allowance: number, kitPrompt = readFileSync(join(kitDir(), 'PROMPT.md'), 'utf8')): string {
  const agent = launch.config.agent!;
  const dry = agent.mode !== 'live';
  return [
    `Run the news agent for the launch \`${launch.name}\`, following the instructions below (PROMPT.md).`,
    '',
    'Run context, set by `breakrocks-news run` (it overrides the defaults of the instructions):',
    '- The collect is already done: do not call `collect`.',
    `- Handle at most ${allowance} event(s) this run: call \`pending_events({ launch: "${launch.name}", limit: ${allowance} })\`. This is the hourly and daily publishing cap; never exceed it.`,
    `- Main universe of an event: the first of its \`universes\`; the others get a repost (D-231).`,
    `- The launch's themes (the #tags you may use): ${launch.config.themes.map((t) => `#${t.replace(/_/g, '')}`).join(' ')}.`,
    dry
      ? '- MODE: DRY RUN. Do NOT publish, edit, reply or repost on break.rocks. For each event you would publish or update, call `breakrocks-news.save_draft({ launch, eventId, kind, text, universes })` with the exact text, instead of `breakrocks_post` and `record_publication`. `skipped` and `needs_review` marks work as usual.'
      : '- MODE: LIVE. Publish through the `breakrocks` MCP server and record every publication.',
    `- Stop at once if the file ${join(launch.dir, 'STOP')} exists (the kill switch).`,
    '- End with the short report of the instructions.',
    '',
    '---',
    '',
    kitPrompt,
  ].join('\n');
}

export interface RunResult { code: number | null; signal: NodeJS.Signals | null; durationMs: number; timedOut: boolean }

/** Spawns the runner (no shell), streams its output to [log], and resolves when it exits. */
export function spawnRunner(argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; log: (chunk: string) => void; onChild?: (kill: () => void) => void }): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolvePromise) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, opts.timeoutMs);
    opts.onChild?.(() => child.kill('SIGTERM'));
    child.stdout.on('data', (d: Buffer) => opts.log(d.toString()));
    child.stderr.on('data', (d: Buffer) => opts.log(d.toString()));
    child.on('error', (e) => { clearTimeout(timer); opts.log(`runner error: ${e.message}\n`); resolvePromise({ code: 127, signal: null, durationMs: Date.now() - started, timedOut }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolvePromise({ code, signal, durationMs: Date.now() - started, timedOut }); });
  });
}
