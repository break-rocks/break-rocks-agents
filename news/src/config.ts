// Launches: launches/<name>/config.yaml and sources.yaml.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Launch, LaunchConfig, Source } from './types.js';

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
  clustering: z.object({ threshold: z.number().min(0).max(1).default(0.34), windowHours: z.number().positive().default(48) }).prefault({}),
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
    identity: z.object({ operatorId: z.string().optional(), agentId: z.string().optional(), keyFile: z.string().optional() }).prefault({}),
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

export const launchesRoot = () => resolve(process.env.BREAKROCKS_NEWS_HOME ?? join(import.meta.dirname, '..'), 'launches');

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
