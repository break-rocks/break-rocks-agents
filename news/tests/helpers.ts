import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeItem } from '../src/normalize.js';
import type { Article, Launch, Source } from '../src/types.js';

export const source = (over: Partial<Source> = {}): Source => ({
  id: 'src', url: 'https://example.org/feed', type: 'rss', name: 'Example', country: 'FR', language: 'fr', category: 'economy', frequency: '1h', rights: 'links only', ...over,
});

export function tmpLaunch(over: Partial<Launch['config']> = {}, sources: Source[] = [source()]): Launch {
  const dir = mkdtempSync(join(tmpdir(), 'news-'));
  return {
    name: 'test', dir, sources,
    config: {
      name: 'test', description: '', languages: ['fr', 'en'], themes: [], universes: { default: ['%news'], byCategory: { tech: ['%tech'] } },
      verification: { minOutlets: 2, sensitiveCategories: ['crime_justice', 'politics'], publishUnconfirmed: true },
      clustering: { backend: 'lexical', threshold: 0.34, windowHours: 48, mergeThreshold: 0.5 }, collect: { maxAgeHours: 72, concurrency: 2, userAgent: 'test' }, schedule: '0 * * * *', ...over,
    },
  };
}

export const art = (title: string, url: string, src: Partial<Source> = {}, publishedAt = '2026-11-01T08:00:00Z'): Article =>
  normalizeItem({ url, title, publishedAt }, source(src), '2026-11-01T09:00:00Z')!;
