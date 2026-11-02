// `npm run eval:decider`: the current methods vs the Strands Decider vs the hybrid rule, on the labelled
// set eval/decider-set.json (self-labelled, see its note). Needs a local Ollama with strands-decider.
// Env: DECIDER_URL (default http://127.0.0.1:11434), DECIDER_MODEL, DECIDER_HIGH, DECIDER_LOW.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lexicalSimilarity } from '../src/cluster.ts';
import { LEXICAL_DEFAULTS } from '../src/config.ts';
import { DECIDER_DEFAULTS, hybrid, ollamaDecider } from '../src/decider.ts';
import { normalizeItem, promoVerdict } from '../src/normalize.ts';
import type { Source } from '../src/types.ts';

interface Set { note: string; pairs: { a: string; b: string; same: boolean }[]; articles: { title: string; url: string; category: string; promo: boolean }[] }
const set = JSON.parse(readFileSync(join(import.meta.dirname, 'decider-set.json'), 'utf8')) as Set;
const env = process.env;
const settings = { ...DECIDER_DEFAULTS, url: env.DECIDER_URL ?? DECIDER_DEFAULTS.url, model: env.DECIDER_MODEL ?? DECIDER_DEFAULTS.model, high: Number(env.DECIDER_HIGH ?? DECIDER_DEFAULTS.high), low: Number(env.DECIDER_LOW ?? DECIDER_DEFAULTS.low), timeoutMs: 60_000 };
let warned = '';
const decider = ollamaDecider(settings, { warn: (m) => { warned = m; } });

const source: Source = { id: 'eval', url: 'https://example.org', type: 'rss', name: 'Eval', country: 'FR', language: 'fr', category: 'tech', frequency: '1h', rights: 'eval' };
const sigOf = (title: string, i: number) => {
  const a = normalizeItem({ url: `https://example.org/${i}`, title, publishedAt: '2026-11-01T08:00:00Z' }, source, '2026-11-01T09:00:00Z')!;
  return { tokens: a.tokens, entities: a.entities, at: a.publishedAt };
};

const latencies: number[] = [];
const timed = async (f: () => Promise<number | undefined>) => {
  const t = performance.now();
  const p = await f();
  latencies.push(performance.now() - t);
  if (p === undefined) throw new Error(warned || 'decider unavailable');
  return p;
};

type Row = { truth: boolean; current: boolean; p: number };
function metrics(rows: Row[], pick: (r: Row) => boolean) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const r of rows) { const v = pick(r); if (v && r.truth) tp++; else if (v) fp++; else if (r.truth) fn++; else tn++; }
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`.padStart(6);
  return `accuracy ${pct((tp + tn) / rows.length)}  precision ${pct(tp + fp ? tp / (tp + fp) : 0)}  recall ${pct(tp + fn ? tp / (tp + fn) : 0)}`;
}
const report = (title: string, rows: Row[]) => {
  const sure = rows.filter((r) => r.p >= settings.high || r.p <= settings.low).length;
  console.log(`\n${title}: ${rows.length} items, ${rows.filter((r) => r.truth).length} positive; the model is sure on ${sure}`);
  console.log(`  current  ${metrics(rows, (r) => r.current)}`);
  console.log(`  decider  ${metrics(rows, (r) => r.p >= 0.5)}`);
  console.log(`  hybrid   ${metrics(rows, (r) => hybrid(r.current, r.p, settings))}`);
};

const p50 = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };

console.log(`Decider eval: ${settings.model} at ${settings.url}, act when p >= ${settings.high} or p <= ${settings.low}`);
console.log(`Set: ${set.note}`);
const pairs: Row[] = [];
for (const [i, x] of set.pairs.entries()) {
  const current = lexicalSimilarity.score(sigOf(x.a, 2 * i), sigOf(x.b, 2 * i + 1)) >= LEXICAL_DEFAULTS.threshold;
  pairs.push({ truth: x.same, current, p: await timed(() => decider.sameEvent(x.a, x.b)) });
}
const pairLat = p50(latencies);
latencies.length = 0;
const promos: Row[] = [];
for (const x of set.articles) promos.push({ truth: x.promo, current: promoVerdict(x.title, x.url, x.category).promo, p: await timed(() => decider.promotional(x.title, x.url)) });
report(`(a) same event (current: lexical score >= ${LEXICAL_DEFAULTS.threshold})`, pairs);
report('(b) promotional (current: promo filter)', promos);
console.log(`\nLatency p50: same event ${pairLat.toFixed(0)} ms, promotional ${p50(latencies).toFixed(0)} ms (one question per call)`);
