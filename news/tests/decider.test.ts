import { describe, expect, it } from 'vitest';
import { hybrid, ollamaDecider, type Decider } from '../src/decider.js';
import type { JsonPost } from '../src/embed.js';
import { ingest, openStore } from '../src/service.js';
import { art, tmpLaunch } from './helpers.js';

const answer = (p: number): JsonPost => async () => ({ status: 200, json: async () => ({ model: 'strands-decider', answers: { q: { type: 'noul', noul: p } } }) });

describe('decider (Strands Decider via Ollama)', () => {
  it('the hybrid rule acts only when sure', () => {
    const s = { high: 0.8, low: 0.2 };
    expect(hybrid(false, 0.9, s)).toBe(true);
    expect(hybrid(true, 0.1, s)).toBe(false);
    expect(hybrid(true, 0.5, s)).toBe(true);
    expect(hybrid(false, undefined, s)).toBe(false);
  });

  it('asks a noul question and reads its probability', async () => {
    let sent: unknown;
    const d = ollamaDecider({}, { post: async (url, body) => { sent = { url, body }; return answer(0.93)(url, body, {}); } });
    expect(await d.sameEvent('ECB raises rates', 'La BCE relève ses taux')).toBeCloseTo(0.93);
    expect(sent).toMatchObject({ url: 'http://127.0.0.1:11434/v1/systemone', body: { model: 'strands-decider', questions: { q: { type: 'noul' } } } });
  });

  it('warns once and steps aside when unavailable', async () => {
    const warnings: string[] = [];
    let calls = 0;
    const d = ollamaDecider({}, { post: async () => { calls++; throw new Error('ECONNREFUSED'); }, warn: (m) => warnings.push(m) });
    expect(await d.promotional('x', 'https://x')).toBeUndefined();
    expect(await d.sameEvent('a', 'b')).toBeUndefined();
    expect(calls).toBe(1);
    expect(warnings).toHaveLength(1);
  });

  it('a sure "different" rejects a merge the clustering proposes', async () => {
    const titles = ['Apple présente un iPhone pliable', 'Samsung dévoile sa montre connectée', 'Apple présente un iPhone pliable, Samsung dévoile sa montre connectée'];
    const run = async (decider?: Decider) => {
      const launch = tmpLaunch({ clustering: { backend: 'lexical', threshold: 0.3, windowHours: 48, mergeThreshold: 0.3 }, decider: { enabled: true, url: 'http://x', model: 'm', high: 0.8, low: 0.2, merges: true, promo: true, timeoutMs: 1000 } });
      const store = openStore(launch);
      const r = await ingest(store, launch, titles.map((t, i) => art(t, `https://s${i}.fr/${i}`, { id: `s${i}`, name: `S${i}` }, `2026-11-01T0${i + 1}:00:00Z`)), undefined, undefined, decider);
      store.close();
      return r;
    };
    const no: Decider = { model: 'fake', sameEvent: async () => 0.05, promotional: async () => 0.5 };
    const base = await run();
    const decided = await run(no);
    expect(base.merged.length).toBeGreaterThan(0);
    expect(decided.merged).toHaveLength(0);
  });
});
