// `breakrocks-news start`: the answers of the wizard (or flags, or --from), and the files they become:
// <news home>/launches/<name>/config.yaml, sources.yaml (picked from catalogue/sources.yaml), start.yaml and .mcp.json.
// Pure functions except writeLaunch / loadCatalogue.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { frequencyMs, kitDir, sourceSchemaOf } from './config.js';
import type { AgentSettings, Source } from './types.js';

export const THEMES = ['politics', 'economy', 'sport', 'entertainment', 'culture', 'tech', 'crime_justice', 'international', 'science', 'climate', 'health'] as const;
export type Theme = (typeof THEMES)[number];

/** Catalogue categories that belong to a theme without being its name. */
export const SUBCATEGORIES: Record<string, Theme> = { monetary_policy: 'economy', statistics: 'economy', trade: 'economy', security: 'tech', startups: 'tech', regulation: 'tech' };
export const themeOf = (s: Pick<Source, 'category' | 'theme'>): string => s.theme ?? SUBCATEGORIES[s.category] ?? s.category;

export const RUNNERS = ['claude', 'codex', 'custom'] as const;

export const answersSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lower case letters, digits and dashes'),
  description: z.string().optional(),
  scope: z.object({ kind: z.enum(['world', 'countries', 'languages']), values: z.array(z.string().min(2)).max(20).default([]) })
    .refine((s) => s.kind === 'world' || s.values.length > 0, 'a set of countries or languages needs at least one value'),
  themes: z.array(z.enum(THEMES)).min(1),
  /** Destination universes per theme: the first is the main universe, the others get reposts (D-231). */
  universes: z.record(z.string(), z.array(z.string().regex(/^%[^\s]+$/, 'a universe address starts with %')).min(1)),
  every: z.string().regex(/^\d+[mhd]$/).default('1h'),
  perHour: z.number().int().min(0).default(4),
  perDay: z.number().int().min(0).default(30),
  batch: z.number().int().min(1).max(50).default(5),
  verification: z.enum(['corroborated', 'to_confirm']).default('corroborated'),
  mode: z.enum(['dry_run', 'live']).default('dry_run'),
  runner: z.object({ kind: z.enum(RUNNERS).default('claude'), template: z.string().optional() }).prefault({}),
  /** agent: a local agent of the breakrocks CLI (`breakrocks agents local`), env its environment; operatorId, agentId, keyFile: deprecated. */
  identity: z.object({ agent: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(), env: z.enum(['dev', 'staging', 'prod']).optional(), operatorId: z.string().optional(), agentId: z.string().optional(), keyFile: z.string().optional() }).prefault({}),
  breakrocks: z.string().default('breakrocks'),
  /** The optional decision model (Strands Decider via a local Ollama) beside the merges and the promo filter. */
  decider: z.boolean().default(false),
}).refine((a) => a.themes.every((t) => a.universes[t]?.length), { message: 'every theme needs at least one destination universe', path: ['universes'] })
  .refine((a) => a.runner.kind !== 'custom' || !!a.runner.template, { message: 'a custom runner needs a template', path: ['runner'] });

export type StartAnswers = z.infer<typeof answersSchema>;

/** "FR, be" | "fr,en" -> normalised values: countries upper case, languages lower case. */
export function scopeValues(kind: 'countries' | 'languages', raw: string): string[] {
  const values = [...new Set(raw.split(/[\s,]+/).map((v) => v.trim()).filter(Boolean).map((v) => (kind === 'countries' ? v.toUpperCase() : v.toLowerCase())))];
  if (values.length > 20) throw new Error(`At most 20 ${kind} (got ${values.length})`);
  return values;
}

export function loadCatalogue(file = join(kitDir(), 'catalogue', 'sources.yaml')): Source[] {
  const raw = parse(readFileSync(file, 'utf8')) as { sources?: unknown[] };
  return z.array(sourceSchemaOf()).parse(raw.sources ?? []);
}

/**
 * The sources of a launch: catalogue sources of its themes, within its scope (countries: the source's
 * country, plus international ones; languages: the source's language). A source is never fetched more
 * often than the launch's collection frequency (slower sources keep their own pace).
 */
export function selectSources(catalogue: Source[], a: Pick<StartAnswers, 'scope' | 'themes' | 'every'>): Source[] {
  const every = frequencyMs(a.every);
  return catalogue.filter((s) => (a.themes as string[]).includes(themeOf(s)))
    .filter((s) => a.scope.kind === 'world' || (a.scope.kind === 'countries' ? a.scope.values.includes(s.country) || (s.country === 'INT' && s.type === 'rss') : a.scope.values.includes(s.language)))
    .map((s) => ({ ...s, frequency: frequencyMs(s.frequency) >= every ? s.frequency : a.every }));
}

/** A cron line (informative, and for the cron scheduler) from a frequency. */
export function cronOf(every: string): string {
  const m = /^(\d+)([mhd])$/.exec(every)!;
  const n = Number(m[1]);
  if (m[2] === 'm') return n >= 60 ? `0 */${Math.max(1, Math.round(n / 60))} * * *` : `*/${n} * * * *`;
  if (m[2] === 'h') return n >= 24 ? '0 0 * * *' : `0 */${n} * * *`;
  return `0 0 */${n} * *`;
}

export function buildConfig(a: StartAnswers, sources: Source[]) {
  const languages = a.scope.kind === 'languages' ? a.scope.values : [...new Set(sources.map((s) => s.language))].sort();
  const byCategory: Record<string, string[]> = {};
  for (const t of a.themes) byCategory[t] = a.universes[t]!;
  for (const [sub, t] of Object.entries(SUBCATEGORIES)) if (a.universes[t]) byCategory[sub] = a.universes[t];
  const agent: AgentSettings = {
    mode: a.mode, every: a.every, scope: a.scope,
    limits: { perHour: a.perHour, perDay: a.perDay, batch: a.batch },
    runner: { kind: a.runner.kind, ...(a.runner.template ? { template: a.runner.template } : {}), timeoutMinutes: 30 },
    identity: a.identity, breakrocks: a.breakrocks,
  };
  return {
    description: a.description ?? `${a.themes.join(', ')} news (${a.scope.kind === 'world' ? 'world' : a.scope.values.join(', ')}), set up by breakrocks-news start.`,
    languages: languages.length ? languages : ['en'],
    themes: [...a.themes],
    universes: { default: a.universes[a.themes[0]!]!, byCategory },
    verification: { minOutlets: 2, sensitiveCategories: ['crime_justice', 'politics'], publishUnconfirmed: a.verification === 'to_confirm' },
    clustering: { backend: 'lexical', threshold: 0.34, windowHours: 48, mergeThreshold: 0.5 },
    collect: { maxAgeHours: 48, concurrency: 6 },
    schedule: cronOf(a.every),
    ...(a.decider ? { decider: { enabled: true, url: 'http://127.0.0.1:11434', model: 'strands-decider', high: 0.8, low: 0.2 } } : {}),
    agent,
  };
}

/**
 * The MCP servers the runner gets: this kit and the break.rocks CLI, started as the local agent
 * (`breakrocks mcp --agent <name> --env <env>`: the CLI signs it in with the key of the system keychain).
 * Deprecated identity (no local agent): the BREAKROCKS_* variables of the environment.
 */
export function mcpConfig(launchesHome: string, breakrocks: string, identity: StartAnswers['identity'] = {}) {
  const [command, ...args] = splitCommand(breakrocks);
  if (identity.agent) {
    return { mcpServers: {
      'breakrocks-news': { command: process.execPath, args: [join(kitDir(), 'dist', 'index.js')], env: { BREAKROCKS_NEWS_HOME: launchesHome } },
      breakrocks: { command: command!, args: [...args, 'mcp', '--agent', identity.agent, ...(identity.env ? ['--env', identity.env] : [])] },
    } };
  }
  return {
    mcpServers: {
      'breakrocks-news': { command: process.execPath, args: [join(kitDir(), 'dist', 'index.js')], env: { BREAKROCKS_NEWS_HOME: launchesHome } },
      breakrocks: {
        command: command!, args: [...args, 'mcp'],
        env: { BREAKROCKS_OPERATOR_ID: '${BREAKROCKS_OPERATOR_ID:-}', BREAKROCKS_AGENT_ID: '${BREAKROCKS_AGENT_ID:-}', BREAKROCKS_AGENT_KEY: '${BREAKROCKS_AGENT_KEY:-}' },
      },
    },
  };
}

/** Splits a command line like a shell would for words and quotes (no expansion, no operators). */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let cur = '', quote: '"' | "'" | undefined, has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) { if (c === quote) quote = undefined; else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i]; else cur += c; continue; }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (c === '\\' && i + 1 < line.length) { cur += line[++i]; has = true; continue; }
    if (/\s/.test(c)) { if (has || cur) out.push(cur); cur = ''; has = false; continue; }
    cur += c;
  }
  if (quote) throw new Error(`Unclosed quote in: ${line}`);
  if (has || cur) out.push(cur);
  return out;
}

const header = (what: string) => `# ${what}, written by \`breakrocks-news start\`. Edit freely; \`start --from start.yaml\` regenerates it.\n`;

/** Writes the launch folder. Returns its path. The home is the news home (the folder holding launches/). */
export function writeLaunch(home: string, a: StartAnswers, catalogue: Source[]) {
  const dir = join(home, 'launches', a.name);
  mkdirSync(join(dir, 'drafts'), { recursive: true });
  const sources = selectSources(catalogue, a);
  if (!sources.length) throw new Error('No catalogue source matches these themes and this scope: widen the scope or add sources to the catalogue (catalogue/sources.yaml of the kit)');
  writeFileSync(join(dir, 'config.yaml'), header(`${a.name}: launch settings`) + stringify(buildConfig(a, sources), { lineWidth: 0 }));
  writeFileSync(join(dir, 'sources.yaml'), header(`${a.name}: ${sources.length} sources picked from catalogue/sources.yaml`) + stringify({ sources: sources.map(({ theme: _t, ...s }) => s) }, { lineWidth: 0 }));
  writeFileSync(join(dir, 'start.yaml'), header(`${a.name}: the answers of the wizard`) + stringify(a, { lineWidth: 0 }));
  writeFileSync(join(dir, '.mcp.json'), `${JSON.stringify(mcpConfig(resolve(home), a.breakrocks, a.identity), null, 2)}\n`);
  return { dir, sources };
}

export const launchExists = (home: string, name: string) => existsSync(join(home, 'launches', name, 'config.yaml'));

/** Reads --from: a start.yaml (the answers) or a generated config.yaml (with its agent block). */
export function answersFromFile(file: string): Partial<StartAnswers> {
  const doc = parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const agent = doc.agent as AgentSettings | undefined;
  if (!agent) return doc as Partial<StartAnswers>;
  const u = doc.universes as { byCategory?: Record<string, string[]> };
  const themes = (doc.themes as string[]) ?? [];
  return {
    themes: themes as Theme[], universes: Object.fromEntries(themes.map((t) => [t, u.byCategory?.[t] ?? []])), scope: agent.scope, every: agent.every,
    perHour: agent.limits.perHour, perDay: agent.limits.perDay, batch: agent.limits.batch, mode: agent.mode, runner: agent.runner, identity: agent.identity, breakrocks: agent.breakrocks,
    verification: (doc.verification as { publishUnconfirmed?: boolean })?.publishUnconfirmed ? 'to_confirm' : 'corroborated', description: doc.description as string,
    decider: !!(doc.decider as { enabled?: boolean } | undefined)?.enabled,
  };
}

/**
 * The answers an example launch of the kit (examples/<name>/config.yaml) gives as a template: its themes
 * (those of the wizard), their universes, its languages as the scope, its verification.
 */
export function answersFromExample(file: string): Partial<StartAnswers> {
  const doc = parse(readFileSync(file, 'utf8')) as { themes?: string[]; languages?: string[]; description?: string; universes?: { default?: string[]; byCategory?: Record<string, string[]> }; verification?: { publishUnconfirmed?: boolean }; agent?: unknown };
  if (doc.agent) return answersFromFile(file);
  const themes = (doc.themes ?? []).filter((t): t is Theme => (THEMES as readonly string[]).includes(t));
  const universes = Object.fromEntries(themes.map((t) => [t, doc.universes?.byCategory?.[t] ?? doc.universes?.default ?? []]));
  return {
    themes, universes, ...(doc.description ? { description: doc.description } : {}),
    ...(doc.languages?.length ? { scope: { kind: 'languages' as const, values: doc.languages } } : {}),
    verification: doc.verification?.publishUnconfirmed ? 'to_confirm' : 'corroborated',
  };
}
