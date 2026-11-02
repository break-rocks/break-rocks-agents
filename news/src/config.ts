// Launches: <news home>/launches/<name>/config.yaml and sources.yaml. The news home is
// ~/.breakrocks/kits/news (D-235): BREAKROCKS_NEWS_HOME (or --home) first, else <breakrocks home>/kits/news.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Launch, LaunchConfig, Source } from './types.js';

/** Local model: Apache-2.0, 50+ languages, 384 dimensions, trained for paraphrases. */
export const DEFAULT_LOCAL_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
export const LEXICAL_DEFAULTS = { threshold: 0.34, mergeThreshold: 0.5 };
export const EMBEDDING_DEFAULTS = { threshold: 0.75, mergeThreshold: 0.83 };

const configSchema = z.object({
  description: z.string().default(''),
  languages: z.array(z.string()).min(1),
  themes: z.array(z.string()).default([]),
  universes: z.object({
    default: z.array(z.string()).min(1),
    byCategory: z.record(z.string(), z.array(z.string())).optional(),
    byLanguage: z.record(z.string(), z.array(z.string())).optional(),
  }),
  verification: z.object({
    minOutlets: z.number().int().min(1).default(2),
    sensitiveCategories: z.array(z.string()).default(['crime_justice', 'politics']),
    publishUnconfirmed: z.boolean().default(true),
  }).prefault({}),
  clustering: z.object({
    backend: z.enum(['lexical', 'embedding']).default('lexical'),
    threshold: z.number().min(0).max(1).optional(),
    windowHours: z.number().positive().default(48),
    mergeThreshold: z.number().min(0).max(1).optional(),
    embedding: z.object({
      provider: z.enum(['local', 'openai', 'ollama']).default('local'),
      model: z.string().default(DEFAULT_LOCAL_MODEL),
      url: z.string().url().optional(),
      apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
      prefix: z.string().optional(),
      batchSize: z.number().int().min(1).max(256).default(32),
    }).optional(),
  }).prefault({}).transform((c) => {
    const d = c.backend === 'embedding' ? EMBEDDING_DEFAULTS : LEXICAL_DEFAULTS;
    return { ...c, threshold: c.threshold ?? d.threshold, mergeThreshold: c.mergeThreshold ?? d.mergeThreshold, embedding: c.backend === 'embedding' ? c.embedding ?? { provider: 'local' as const, model: DEFAULT_LOCAL_MODEL, batchSize: 32 } : c.embedding };
  }),
  filters: z.object({ keepPromo: z.boolean().default(false), promoCategories: z.array(z.string()).default(['deals', 'promo', 'shopping', 'bons-plans']) }).prefault({}),
  decider: z.object({
    enabled: z.boolean().default(false),
    url: z.string().url().default('http://127.0.0.1:11434'),
    model: z.string().default('strands-decider'),
    high: z.number().min(0).max(1).default(0.8),
    low: z.number().min(0).max(1).default(0.2),
    merges: z.boolean().default(true),
    promo: z.boolean().default(false),
    timeoutMs: z.number().int().positive().default(20_000),
  }).refine((d) => d.low < d.high, 'decider.low must be below decider.high').optional(),
  retention: z.object({ articlesDays: z.number().positive().default(30), eventsDays: z.number().positive().default(180), logsDays: z.number().positive().default(30) }).prefault({}),
  politeness: z.object({
    gdeltMinFrequency: z.string().regex(/^\d+[mhd]$/).default('1h'),
    disableAfter429: z.number().int().min(1).default(3),
    disableHours: z.number().positive().default(24),
    cacheMinutes: z.number().min(0).default(15),
  }).prefault({}),
  collect: z.object({
    maxAgeHours: z.number().positive().default(72),
    concurrency: z.number().int().min(1).max(16).default(6),
    userAgent: z.string().default('breakrocks-news/0.1 (+https://github.com/break-rocks/break-rocks-agents)'),
  }).prefault({}),
  schedule: z.string().default('0 * * * *'),
  categoryKeywords: z.record(z.string(), z.array(z.string())).optional(),
  agent: z.object({
    mode: z.enum(['dry_run', 'live']).default('dry_run'),
    every: z.string().regex(/^\d+[mhd]$/).default('1h'),
    scope: z.object({ kind: z.enum(['world', 'countries', 'languages']), values: z.array(z.string()).max(20).default([]) }).default({ kind: 'world', values: [] }),
    limits: z.object({ perHour: z.number().int().min(0).default(4), perDay: z.number().int().min(0).default(30), batch: z.number().int().min(1).max(50).default(5) }).prefault({}),
    runner: z.object({ kind: z.enum(['claude', 'codex', 'custom']).default('claude'), template: z.string().optional(), timeoutMinutes: z.number().positive().default(30) }).prefault({}),
    identity: z.object({ agent: z.string().optional(), env: z.enum(['dev', 'staging', 'prod']).optional(), operatorId: z.string().optional(), agentId: z.string().optional(), keyFile: z.string().optional() }).prefault({}),
    breakrocks: z.string().default('breakrocks'),
  }).optional(),
});

const sourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  url: z.string().url(),
  type: z.enum(['rss', 'gdelt', 'hackernews']).default('rss'),
  name: z.string(),
  group: z.string().optional(),
  country: z.string(),
  language: z.string(),
  category: z.string(),
  frequency: z.string().regex(/^\d+[mhd]$/).default('1h'),
  official: z.boolean().optional(),
  query: z.string().optional(),
  rights: z.string().min(1),
  theme: z.string().optional(),
});

/** The kit folder (PROMPT.md, catalogue/, dist/). */
export const kitDir = () => resolve(import.meta.dirname, '..');

export const sourceSchemaOf = () => sourceSchema;

/** The breakrocks home, as the CLI resolves it: BREAKROCKS_HOME, %APPDATA%\breakrocks, $XDG_CONFIG_HOME/breakrocks, else ~/.breakrocks. */
export function breakrocksHome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.BREAKROCKS_HOME) return resolve(env.BREAKROCKS_HOME);
  if (platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'breakrocks');
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'breakrocks');
  return join(env.HOME || homedir(), '.breakrocks');
}

/** The news home (the folder holding launches/): BREAKROCKS_NEWS_HOME, else <breakrocks home>/kits/news. */
export const newsHome = (env: NodeJS.ProcessEnv = process.env) => resolve(env.BREAKROCKS_NEWS_HOME ?? join(breakrocksHome(env), 'kits', 'news'));

export const launchesRoot = () => join(newsHome(), 'launches');

/** The example launches of the kit (templates for `start --from-example`). */
export const examplesDir = () => join(kitDir(), 'examples');

/**
 * Moves the launch folders left in the kit (launches/, up to 0.1) into the news home: copied, then
 * removed from the kit; one already in the home is left where it is. Answers what moved and what did not.
 */
export function migrateKitLaunches(from = join(kitDir(), 'launches'), to = launchesRoot()): { moved: string[]; kept: string[] } {
  const moved: string[] = [], kept: string[] = [];
  if (!existsSync(from) || resolve(from) === resolve(to)) return { moved, kept };
  mkdirSync(to, { recursive: true });
  for (const d of readdirSync(from, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const src = join(from, d.name), dst = join(to, d.name);
    if (!readdirSync(src).length) { rmSync(src, { recursive: true, force: true }); continue; }
    if (existsSync(dst)) { kept.push(d.name); continue; }
    try { renameSync(src, dst); } catch {
      cpSync(src, dst, { recursive: true, preserveTimestamps: true });
      rmSync(src, { recursive: true, force: true });
    }
    moved.push(d.name);
  }
  if (!readdirSync(from).length) rmSync(from, { recursive: true, force: true });
  return { moved, kept };
}

export function listLaunches(root = launchesRoot()): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'config.yaml'))).map((d) => d.name).sort();
}

export function loadLaunch(name: string, root = launchesRoot()): Launch {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Invalid launch name: ${name}`);
  const dir = join(root, name);
  if (!existsSync(join(dir, 'config.yaml'))) throw new Error(`Unknown launch: ${name}`);
  const config: LaunchConfig = { name, ...configSchema.parse(parse(readFileSync(join(dir, 'config.yaml'), 'utf8'))) };
  const raw = parse(readFileSync(join(dir, 'sources.yaml'), 'utf8')) as { sources?: unknown[] };
  const sources: Source[] = z.array(sourceSchema).parse(raw.sources ?? []);
  const ids = new Set<string>();
  for (const s of sources) {
    if (ids.has(s.id)) throw new Error(`${name}: duplicate source id ${s.id}`);
    ids.add(s.id);
  }
  return { name, dir, config, sources };
}

/** "30m" | "2h" | "1d" in milliseconds. */
export function frequencyMs(frequency: string): number {
  const m = /^(\d+)([mhd])$/.exec(frequency);
  if (!m) throw new Error(`Invalid frequency: ${frequency}`);
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
}
