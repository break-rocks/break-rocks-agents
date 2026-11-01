// `breakrocks-news start`: flags, --from, or questions for what is missing; universes checked live with
// the break.rocks CLI; then the launch files, and the loop (dry run the first time).
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { THEMES, answersFromFile, answersSchema, launchExists, scopeValues, splitCommand, type StartAnswers, type Theme } from './setup.js';

export interface Flags { [k: string]: string | boolean | string[] | undefined }

const BOOLEAN = new Set(['yes', 'no-run', 'once', 'live', 'dry-run', 'skip-universe-check', 'json', 'print', 'force', 'help']);
const REPEAT = new Set(['universe']);

/** --key value | --key=value | --flag; repeatable --universe. Positionals in _. */
export function parseFlags(argv: string[]): { flags: Flags; positionals: string[] } {
  const flags: Flags = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) { positionals.push(a); continue; }
    const eq = a.indexOf('=');
    const key = a.slice(2, eq > 0 ? eq : undefined);
    if (BOOLEAN.has(key)) { flags[key] = true; continue; }
    const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (value === undefined) throw new Error(`--${key} needs a value`);
    if (REPEAT.has(key)) flags[key] = [...((flags[key] as string[]) ?? []), value];
    else flags[key] = value;
  }
  return { flags, positionals };
}

const list = (v: string) => v.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
const int = (v: string | undefined, name: string) => { if (v === undefined) return undefined; const n = Number(v); if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a whole number`); return n; };

/** Flags -> partial answers (only what was given). */
export function answersFromFlags(f: Flags): Partial<StartAnswers> {
  const a: Partial<StartAnswers> = {};
  const s = (k: string) => (typeof f[k] === 'string' ? (f[k] as string) : undefined);
  if (s('name')) a.name = s('name');
  if (s('countries')) a.scope = { kind: 'countries', values: scopeValues('countries', s('countries')!) };
  else if (s('languages')) a.scope = { kind: 'languages', values: scopeValues('languages', s('languages')!) };
  else if (s('scope') === 'world') a.scope = { kind: 'world', values: [] };
  if (s('themes')) a.themes = list(s('themes')!).map((t) => t.replace('-', '_')) as Theme[];
  const universes: Record<string, string[]> = {};
  if (s('universes')) for (const t of a.themes ?? []) universes[t] = list(s('universes')!);
  for (const u of (f.universe as string[] | undefined) ?? []) {
    const [theme, addrs] = u.split('=');
    if (!theme || !addrs) throw new Error(`--universe takes theme=%a,%b (got ${u})`);
    universes[theme.replace('-', '_')] = list(addrs);
  }
  if (Object.keys(universes).length) a.universes = universes;
  if (s('every')) a.every = s('every');
  const ph = int(s('per-hour'), 'per-hour'), pd = int(s('per-day'), 'per-day'), b = int(s('batch'), 'batch');
  if (ph !== undefined) a.perHour = ph;
  if (pd !== undefined) a.perDay = pd;
  if (b !== undefined) a.batch = b;
  if (s('verification')) a.verification = s('verification')!.replace('-', '_') as StartAnswers['verification'];
  if (f.live || s('mode') === 'live') a.mode = 'live';
  else if (f['dry-run'] || s('mode') === 'dry-run' || s('mode') === 'dry_run') a.mode = 'dry_run';
  if (s('runner') || s('runner-template')) a.runner = { kind: (s('runner') ?? 'custom') as StartAnswers['runner']['kind'], ...(s('runner-template') ? { template: s('runner-template') } : {}) };
  const id = { operatorId: s('operator-id'), agentId: s('agent-id'), keyFile: s('agent-key-file') ? resolve(s('agent-key-file')!) : undefined };
  if (id.operatorId || id.agentId || id.keyFile) a.identity = Object.fromEntries(Object.entries(id).filter(([, v]) => v)) as StartAnswers['identity'];
  if (s('breakrocks-cmd')) a.breakrocks = s('breakrocks-cmd');
  if (s('description')) a.description = s('description');
  return a;
}

// ---- universe check ----

export interface UniverseCheck { address: string; universe: string; exists?: boolean; agentsForbidden?: boolean; myRole?: string | null; error?: string }

export type ShowUniverse = (cmd: string, universe: string, env: NodeJS.ProcessEnv) => Promise<unknown>;

const showWithCli: ShowUniverse = (cmd, universe, env) => new Promise((res, rej) => {
  const [bin, ...pre] = splitCommand(cmd);
  execFile(bin!, [...pre, 'universes', 'show', universe, '--json'], { env, timeout: 90_000, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
    if (err && !stdout) return rej(new Error((stderr || err.message).trim().split('\n').at(-1)));
    try { res(JSON.parse(stdout)); } catch { rej(new Error('the CLI did not answer JSON')); }
  });
});

/** %tech#startups and %tech/sub live in %tech. */
export const universeOf = (address: string) => address.split(/[#/]/)[0]!;

export async function checkUniverse(cmd: string, address: string, env: NodeJS.ProcessEnv, show: ShowUniverse = showWithCli): Promise<UniverseCheck> {
  const universe = universeOf(address);
  try {
    const doc = (await show(cmd, universe, env)) as { universe?: Record<string, unknown>; error?: { code?: string; message?: string } };
    if (doc.error || !doc.universe) throw new Error(doc.error ? `${doc.error.code ?? 'error'}: ${doc.error.message ?? ''}`.slice(0, 200) : 'no universe in the answer');
    const u = doc.universe ?? {};
    return {
      address, universe, exists: u.exists === true,
      // D-232: agentsForbidden / agentPostsForbidden may not exist yet; absent means unknown.
      ...(typeof u.agentsForbidden === 'boolean' || typeof u.agentPostsForbidden === 'boolean' ? { agentsForbidden: u.agentsForbidden === true || u.agentPostsForbidden === true } : {}),
      myRole: (u.myRole as string | null | undefined) ?? null,
    };
  } catch (e) { return { address, universe, error: (e as Error).message }; }
}

export function describeCheck(c: UniverseCheck): string {
  if (c.error) return `${c.address}: not checked (${c.error})`;
  if (!c.exists) return `${c.address}: ${c.universe} does not exist`;
  const agents = c.agentsForbidden === undefined ? 'agent rule unknown (no agentsForbidden field yet)' : c.agentsForbidden ? 'FORBIDS AGENTS' : 'agents allowed';
  return `${c.address}: exists, ${agents}${c.myRole ? `, your role ${c.myRole}` : ''}`;
}

export const blocking = (c: UniverseCheck) => !c.error && (!c.exists || c.agentsForbidden === true);

// ---- the wizard ----

export interface Io { ask(q: string): Promise<string>; print(s: string): void; close(): void }

export function terminalIo(): Io {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return { ask: (q) => rl.question(q), print: (s) => console.log(s), close: () => rl.close() };
}

async function askUntil<T>(io: Io, q: string, def: string | undefined, parse: (v: string) => T): Promise<T> {
  for (;;) {
    const raw = (await io.ask(`${q}${def !== undefined ? ` [${def}]` : ''}: `)).trim() || def || '';
    try { return parse(raw); } catch (e) { io.print(`  ${(e as Error).message}`); }
  }
}

const freq = (v: string) => { if (!/^\d+[mhd]$/.test(v)) throw new Error('A frequency like 15m, 1h or 1d'); if (/^\d+m$/.test(v) && Number(v.slice(0, -1)) < 5) throw new Error('At least 5m'); return v; };
const whole = (v: string) => { const n = Number(v); if (!Number.isInteger(n) || n < 0) throw new Error('A whole number'); return n; };

export interface StartContext { home: string; io?: Io; yes: boolean; skipUniverseCheck: boolean; show?: ShowUniverse; env?: NodeJS.ProcessEnv; existed: boolean }

/** Fills what is missing (questions, or defaults with --yes), checks the universes, confirms live. */
export async function completeAnswers(given: Partial<StartAnswers>, ctx: StartContext): Promise<StartAnswers> {
  const a: Partial<StartAnswers> = { ...given };
  const io = ctx.io;
  const need = (what: string) => { if (ctx.yes || !io) throw new Error(`Missing ${what} (give it as a flag, or run without --yes to be asked)`); return io; };

  if (!a.name) a.name = await askUntil(need('--name'), 'Launch name (lower case, digits, dashes)', undefined, (v) => { if (!/^[a-z0-9][a-z0-9-]*$/.test(v)) throw new Error('Lower case letters, digits and dashes'); return v; });
  if (!a.scope) {
    if (ctx.yes || !io) a.scope = { kind: 'world', values: [] };
    else {
      const kind = await askUntil(io, 'Scope: world, countries or languages', 'world', (v) => { if (!['world', 'countries', 'languages'].includes(v)) throw new Error('world, countries or languages'); return v as 'world' | 'countries' | 'languages'; });
      a.scope = kind === 'world' ? { kind, values: [] }
        : { kind, values: await askUntil(io, kind === 'countries' ? 'Countries, ISO codes (up to 20, e.g. FR,BE,CH)' : 'Languages, ISO codes (up to 20, e.g. fr,en)', undefined, (v) => { const x = scopeValues(kind, v); if (!x.length) throw new Error('At least one'); return x; }) };
    }
  }
  if (!a.themes?.length) {
    a.themes = await askUntil(need('--themes'), `Themes, comma separated (${THEMES.join(', ')})`, undefined, (v) => {
      const t = list(v).map((x) => x.replace('-', '_'));
      const bad = t.filter((x) => !(THEMES as readonly string[]).includes(x));
      if (!t.length || bad.length) throw new Error(`Unknown: ${bad.join(', ') || '(none given)'}`);
      return t as Theme[];
    });
  }
  a.universes = { ...a.universes };
  const env = ctx.env ?? process.env;
  for (const theme of a.themes) {
    for (;;) {
      if (!a.universes[theme]?.length) {
        a.universes[theme] = await askUntil(need(`--universe ${theme}=%...`), `Universes for ${theme} (main first, then reposts; e.g. %${theme.replace('_', '-')})`, undefined, (v) => {
          const x = list(v); if (!x.length || x.some((u) => !u.startsWith('%'))) throw new Error('Addresses starting with %'); return x;
        });
      }
      if (ctx.skipUniverseCheck) break;
      const checks = await Promise.all(a.universes[theme]!.map((u) => checkUniverse(a.breakrocks ?? 'breakrocks', u, env, ctx.show)));
      for (const c of checks) (io ?? { print: (s: string) => console.log(s) }).print(`  ${describeCheck(c)}`);
      const bad = checks.filter(blocking);
      if (!bad.length) break;
      if (ctx.yes || !io) throw new Error(`Universes not usable for ${theme}: ${bad.map(describeCheck).join('; ')} (or pass --skip-universe-check)`);
      io.print('  Choose other universes.');
      a.universes[theme] = [];
    }
  }
  if (!ctx.yes && io) {
    if (given.every === undefined) a.every = await askUntil(io, 'Collection frequency (e.g. 15m, 30m, 1h)', '30m', freq);
    if (given.perHour === undefined) a.perHour = await askUntil(io, 'Posts per hour at most', '4', whole);
    if (given.perDay === undefined) a.perDay = await askUntil(io, 'Posts per day at most', '30', whole);
    if (given.verification === undefined) a.verification = await askUntil(io, 'Publish corroborated events only (c), or also "to confirm" single-source ones (t)', 'c', (v) => { if (!/^[ct]/i.test(v)) throw new Error('c or t'); return /^c/i.test(v) ? 'corroborated' : 'to_confirm'; });
    if (!given.runner) {
      const kind = await askUntil(io, 'AI runner: claude (claude -p), codex (codex exec) or custom', 'claude', (v) => { if (!['claude', 'codex', 'custom'].includes(v)) throw new Error('claude, codex or custom'); return v as 'claude' | 'codex' | 'custom'; });
      a.runner = kind === 'custom'
        ? { kind, template: await askUntil(io, 'Command template ({prompt} {promptFile} {mcpConfig} {launch} {launchDir} {kitDir} {allowedTools} {codexMcp})', undefined, (v) => { if (!v.includes('{prompt')) throw new Error('It must use {prompt} or {promptFile}'); splitCommand(v); return v; }) }
        : { kind };
    }
    if (!given.identity) {
      io.print('The break.rocks delegated agent (BREAKROCKS_OPERATOR_ID, BREAKROCKS_AGENT_ID, BREAKROCKS_AGENT_KEY). Leave empty to use the CLI profile.');
      const operatorId = (await io.ask('Operator id: ')).trim() || undefined;
      const agentId = (await io.ask('Agent id: ')).trim() || undefined;
      const keyFile = agentId ? await askUntil(io, 'Path of the agent key file (PEM; it is read at run time, never shown or copied)', undefined, (v) => checkKeyFile(v)) : undefined;
      a.identity = { ...(operatorId ? { operatorId } : {}), ...(agentId ? { agentId } : {}), ...(keyFile ? { keyFile } : {}) };
    }
    if (given.mode === undefined) a.mode = await askUntil(io, 'Mode: dry-run (drafts only) or live', ctx.existed ? 'live' : 'dry-run', (v) => { if (!['dry-run', 'live'].includes(v)) throw new Error('dry-run or live'); return v === 'live' ? 'live' : 'dry_run'; });
  }
  if (a.identity?.keyFile) a.identity.keyFile = checkKeyFile(a.identity.keyFile);

  if (a.mode === 'live') {
    if (ctx.yes || !io) {
      if (!ctx.existed) { (io ?? { print: (s: string) => console.log(s) }).print('First start of this launch: dry run (drafts only). Check launches/<name>/drafts/, then start again with --mode live.'); a.mode = 'dry_run'; }
    } else {
      const ok = (await io.ask(`Go LIVE: posts are published on break.rocks${a.identity?.agentId ? ` as agent ${a.identity.agentId}` : ''}. Type "live" to confirm: `)).trim();
      if (ok !== 'live') { io.print('Staying in dry run.'); a.mode = 'dry_run'; }
    }
  }
  return answersSchema.parse(a);
}

/** Checks that the key file is a readable private key, without ever printing it. Returns its absolute path. */
export function checkKeyFile(path: string): string {
  const abs = resolve(path.replace(/^~(?=\/)/, process.env.HOME ?? '~'));
  if (!existsSync(abs)) throw new Error(`No file at ${abs}`);
  let body: string;
  try { body = readFileSync(abs, 'utf8'); } catch { throw new Error(`Cannot read ${abs}`); }
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(body)) throw new Error(`${abs} is not a PEM private key`);
  return abs;
}

export const existed = (home: string, name?: string) => !!name && launchExists(home, name);

export { answersFromFile };
