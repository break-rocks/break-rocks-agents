import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { cosine, embeddingSimilarity, lexicalSimilarity } from '../src/cluster.js';
import { embedderFor, similarityFor, type Embedder } from '../src/embed.js';
import { launchStatus } from '../src/loop.js';
import { promoVerdict } from '../src/normalize.js';
import { backoffMs, collect, embedArticles, eventDetail, ingest, markEvent, openStore, pendingEvents, pendingForAi, purgeLaunch, recordPublication, retryAfterMs } from '../src/service.js';
import { Store } from '../src/store.js';
import type { Fetcher } from '../src/collect/fetchers.js';
import type { AgentSettings, Article } from '../src/types.js';
import { art, source, tmpLaunch } from './helpers.js';

/** A fake embedder: a title's vector is the sum of the concept axes its words hit. */
function fakeEmbedder(axes: Record<string, string[]>): Embedder & { calls: number } {
  const names = Object.keys(axes);
  const e = {
    model: 'fake:concepts', calls: 0,
    async embed(texts: string[]) {
      e.calls++;
      return texts.map((t) => {
        const low = t.toLowerCase();
        const v = Float32Array.from(names.map((n) => (axes[n]!.some((w) => low.includes(w)) ? 1 : 0)));
        if (!v.some(Boolean)) v[names.length - 1] = 1;
        return v;
      });
    },
  };
  return e;
}

const embeddingLaunch = (over: Record<string, unknown> = {}) => tmpLaunch({
  clustering: { backend: 'embedding', threshold: 0.6, mergeThreshold: 0.7, windowHours: 48, embedding: { provider: 'local', model: 'fake', batchSize: 8 } }, ...over,
});

async function ingestWith(store: Store, launch: ReturnType<typeof tmpLaunch>, embedder: Embedder, articles: Article[]) {
  await embedArticles(store, embedder, articles);
  return ingest(store, launch, articles, embeddingSimilarity(embedder.model, { windowHours: 48 }));
}

describe('semantic similarity (embedding backend)', () => {
  it('cosine and the hybrid score: paraphrases high, unrelated low, lexical fallback without vectors', async () => {
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([1, 0]))).toBeCloseTo(1);
    const sim = embeddingSimilarity('m');
    const at = '2026-11-01T08:00:00Z';
    const a = { tokens: ['patron', 'openai'], entities: ['openai'], at, vector: Float32Array.from([0.9, 0.1]) };
    const b = { tokens: ['sam', 'altman'], entities: ['sam altman'], at, vector: Float32Array.from([0.85, 0.2]) };
    const c = { tokens: ['bce', 'taux'], entities: ['bce'], at, vector: Float32Array.from([0, 1]) };
    expect(sim.score(a, b)).toBeGreaterThan(0.9);
    expect(sim.score(a, c)).toBeLessThan(0.2);
    const { vector: _v, ...noVec } = a;
    expect(sim.score(noVec, b)).toBe(lexicalSimilarity.score(noVec, b));
  });

  it('groups paraphrases and translations that share no words, vectors stored in SQLite once', async () => {
    const launch = embeddingLaunch();
    const store = openStore(launch);
    const emb = fakeEmbedder({ altman: ['altman', "patron d'openai", 'openai chief'], bce: ['bce', 'ecb', 'taux'], other: [] });
    const arts = [
      art("Le patron d'OpenAI quitte le conseil", 'https://a.fr/1', { id: 'a', name: 'A' }),
      art('Sam Altman steps down from the board', 'https://b.com/2', { id: 'b', name: 'B', language: 'en' }),
      art('La BCE relève ses taux', 'https://c.fr/3', { id: 'c', name: 'C' }),
    ];
    const r = await ingestWith(store, launch, emb, arts);
    expect(r.newEvents).toBe(2);
    expect(store.getEvent(Store.eventIdFor(arts[0]!.id))?.outlets).toEqual(['A', 'B']);
    expect(store.vectorsOf(arts.map((a) => a.id), emb.model).size).toBe(3);
    expect(await embedArticles(store, emb, arts)).toBe(0); // already stored articles are not embedded again
    store.close();
  });

  it('collect embeds with the configured embedder and falls back to lexical when it fails', async () => {
    const feed = `<?xml version="1.0"?><rss><channel><item><title>Sam Altman quitte OpenAI</title><link>https://x.fr/1</link><pubDate>Sun, 01 Nov 2026 08:00:00 GMT</pubDate></item></channel></rss>`;
    const fetcher: Fetcher = async () => ({ status: 200, headers: new Headers(), arrayBuffer: async () => new TextEncoder().encode(feed).buffer as ArrayBuffer });
    const now = new Date('2026-11-01T09:00:00Z');
    const ok = await collect(embeddingLaunch(), { fetcher, now, embedder: fakeEmbedder({ x: ['altman'], o: [] }) });
    expect(ok).toMatchObject({ similarity: 'embedding:fake:concepts', embedding: { model: 'fake:concepts', embedded: 1 } });
    const broken: Embedder = { model: 'x', embed: async () => { throw new Error('down'); } };
    const ko = await collect(embeddingLaunch(), { fetcher, now, embedder: broken });
    expect(ko).toMatchObject({ similarity: 'lexical-v1', embedding: { error: 'down' }, articles: { added: 1 } });
  });

  it('providers: OpenAI-compatible and Ollama endpoints, local transformers.js loaded on demand', async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const post = async (url: string, body: unknown, headers: Record<string, string>) => {
      calls.push({ url, body, headers });
      const input = (body as { input: string[] }).input;
      return { status: 200, json: async () => (url.endsWith('/api/embed') ? { embeddings: input.map(() => [3, 4]) } : { data: input.map((_, index) => ({ index, embedding: [0, 2] })).reverse() }) };
    };
    process.env.NEWS_TEST_KEY = 'k';
    const oa = embedderFor({ provider: 'openai', model: 'text-embedding-3-small', url: 'http://h/v1/', apiKeyEnv: 'NEWS_TEST_KEY', batchSize: 2 }, { post });
    const v = await oa.embed(['a', 'b', 'c']);
    expect(v.map((x) => [...x])).toEqual([[0, 1], [0, 1], [0, 1]]);
    expect(calls.map((c) => c.url)).toEqual(['http://h/v1/embeddings', 'http://h/v1/embeddings']);
    expect(calls[0]!.headers.Authorization).toBe('Bearer k');
    const ol = embedderFor({ provider: 'ollama', model: 'nomic-embed-text', prefix: 'query: ', batchSize: 8 }, { post });
    expect([...(await ol.embed(['a']))[0]!]).toEqual([0.6, 0.8].map((x) => Math.fround(x)));
    expect(calls.at(-1)).toMatchObject({ url: 'http://127.0.0.1:11434/api/embed', body: { input: ['query: a'] } });
    expect(() => embedderFor({ provider: 'openai', model: 'm', apiKeyEnv: 'NEWS_TEST_MISSING', batchSize: 1 })).toThrow(/NEWS_TEST_MISSING is not set/);
    const local = embedderFor({ provider: 'local', model: 'Xenova/x', batchSize: 8 }, { load: async () => async (t) => ({ tolist: () => t.map(() => [1, 0]) }) });
    expect(local.model).toBe('local:Xenova/x');
    expect((await local.embed(['a', 'b'])).length).toBe(2);
  });

  it('the default stays lexical, with nothing to load', async () => {
    expect(similarityFor(tmpLaunch().config)).toEqual({ similarity: lexicalSimilarity });
  });
});

describe('event merging', () => {
  const axes = { a: ['alpha'], b: ['beta'], o: [] };

  it('merges two events bridged by a new article; the old id stays an alias, marked merged for the AI', async () => {
    const launch = embeddingLaunch();
    const store = openStore(launch);
    const emb = fakeEmbedder(axes);
    const a = art('alpha story one', 'https://a.fr/1', { id: 'a', name: 'A' });
    const b = art('beta story two', 'https://b.fr/2', { id: 'b', name: 'B' }, '2026-11-01T08:30:00Z');
    await ingestWith(store, launch, emb, [a, b]);
    const ida = Store.eventIdFor(a.id), idb = Store.eventIdFor(b.id);
    store.close();
    recordPublication(launch, { eventId: idb, postId: 'post-b', summaryVersion: 1, text: 'v1', status: 'published' });
    const s2 = openStore(launch);
    const r = await ingestWith(s2, launch, emb, [art('alpha and beta together', 'https://c.fr/3', { id: 'c', name: 'C' }, '2026-11-01T09:00:00Z')]);
    // The published event keeps its id, even though it is the younger one.
    expect(r.merged).toEqual([{ into: idb, from: ida }]);
    expect(s2.getEvent(ida)?.id).toBe(idb);
    expect(s2.getEvent(idb)).toMatchObject({ articleCount: 3, mergedFrom: [ida], published: { postId: 'post-b' } });
    expect(existsSync(join(launch.dir, 'data', 'events', `${ida}.json`))).toBe(false);
    s2.close();
    const p = pendingEvents(launch);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ id: idb, kind: 'update', mergedFrom: [ida] });
    expect(p[0]!.reasons).toContain('merged');
    // Recording under the alias attaches to the merged event and clears the mark.
    recordPublication(launch, { eventId: ida, postId: 'post-b', summaryVersion: 2, text: 'v2', status: 'update_reply' });
    const d = eventDetail(launch, ida);
    expect(d.event.id).toBe(idb);
    expect(d.aliases).toEqual([ida]);
    expect(d.publications).toHaveLength(2);
    expect(d.event.mergedFrom).toBeUndefined();
  });

  it('keeps the older event when none is published, and never merges two published events', async () => {
    const launch = embeddingLaunch();
    const emb = fakeEmbedder(axes);
    const a = art('alpha one', 'https://a.fr/1', { id: 'a', name: 'A' });
    const b = art('beta two', 'https://b.fr/2', { id: 'b', name: 'B' }, '2026-11-01T08:10:00Z');
    let store = openStore(launch);
    await ingestWith(store, launch, emb, [a]);
    const ida = Store.eventIdFor(a.id), idb = Store.eventIdFor(b.id);
    await ingestWith(store, launch, emb, [{ ...b, collectedAt: '2026-11-01T09:30:00Z' }]);
    store.close();
    for (const id of [ida, idb]) recordPublication(launch, { eventId: id, postId: id, summaryVersion: 1, text: 't', status: 'published' });
    store = openStore(launch);
    expect((await ingestWith(store, launch, emb, [art('alpha beta', 'https://c.fr/3', { id: 'c', name: 'C' })])).merged).toEqual([]);
    store.close();

    const l2 = embeddingLaunch();
    store = openStore(l2);
    await ingestWith(store, l2, emb, [a]);
    await ingestWith(store, l2, emb, [{ ...b, collectedAt: '2026-11-01T09:30:00Z' }]);
    const r = await ingestWith(store, l2, emb, [art('alpha beta', 'https://c.fr/3', { id: 'c', name: 'C' })]);
    expect(r.merged).toEqual([{ into: ida, from: idb }]);
    expect(pendingEvents(l2, 20, store)[0]).toMatchObject({ kind: 'new', reasons: ['corroborated', 'merged'] });
    store.close();
  });
});

describe('promotion filter', () => {
  it('recognises deals in several languages, prices with discounts, affiliate links and deal categories', async () => {
    const yes = [
      ['Bon plan : le Galaxy S26 à 699 € au lieu de 899 €', 'https://x.fr/a'],
      ['Black Friday deal: AirPods Pro 3 for $179 ($70 off)', 'https://x.com/a'],
      ['Soldes : jusqu’à -50 % sur les TV OLED', 'https://x.fr/b'],
      ['Schnäppchen: Pixel 10 zum Bestpreis', 'https://x.de/a'],
      ['Chollo: el iPad Air con descuento', 'https://x.es/a'],
      ['Le MacBook Air M5 est en promo', 'https://x.fr/bons-plans/macbook'],
      ['Nouveau casque Sony', 'https://x.fr/c?tag=site-21'],
      ['Code promo Shein novembre 2026', 'https://x.fr/d'],
    ];
    for (const [t, u] of yes) expect(promoVerdict(t!, u!).promo, t).toBe(true);
    expect(promoVerdict('Nouveau téléphone', 'https://x.fr/e', 'deals').reasons).toEqual(['source category: deals']);
    const no = [
      ['La BCE relève ses taux de 25 points de base', 'https://x.fr/1'],
      ['Trade deal: EU and US agree on tariffs', 'https://x.com/2'],
      ['Apple dévoile l’iPhone 18 à partir de 969 €', 'https://x.fr/3'],
      ['Réduction des émissions : la France en retard', 'https://x.fr/4'],
      ['Oferta pública de adquisición sobre Sabadell', 'https://x.es/5'],
      ['Inflation à 2,1 % en octobre', 'https://x.fr/6?utm_source=rss'],
    ];
    for (const [t, u] of no) expect(promoVerdict(t!, u!).promo, t).toBe(false);
  });

  it('marks promo articles and events, keeps them out of pending unless keepPromo', async () => {
    const run = async (keepPromo: boolean) => {
      const launch = tmpLaunch({ filters: { keepPromo, promoCategories: ['deals'] } });
      const store = openStore(launch);
      const deal = art('Bon plan : la PS5 Pro à 599 € au lieu de 799 €', 'https://x.fr/deal', { id: 'x', name: 'X' });
      expect(deal.promo).toBe(true);
      await ingest(store, launch, [deal, art('Sony annonce la PS6 pour 2027', 'https://y.fr/news', { id: 'y', name: 'Y' })]);
      expect(store.getEvent(Store.eventIdFor(deal.id))?.promo).toBe(true);
      const p = pendingEvents(launch, 20, store);
      store.close();
      return p;
    };
    expect((await run(false)).map((e) => e.title)).toEqual(['Sony annonce la PS6 pour 2027']);
    expect(await run(true)).toHaveLength(2);
  });
});

describe('retention', () => {
  it('purges old unpublished events, old published events after eventsDays, old logs, then vacuums', async () => {
    const launch = tmpLaunch({ retention: { articlesDays: 30, eventsDays: 180, logsDays: 30 } });
    const store = openStore(launch);
    const mk = (title: string, url: string, at: string) => ({ ...art(title, url, { id: url.slice(8, 9), name: url.slice(8, 9) }, at), collectedAt: at });
    const oldOpen = mk('Vieille histoire jamais publiée', 'https://a.fr/1', '2026-08-01T08:00:00Z');
    const oldPub = mk('Histoire publiée en septembre', 'https://b.fr/2', '2026-09-01T08:00:00Z');
    const ancientPub = mk('Histoire publiée il y a un an', 'https://c.fr/3', '2025-10-01T08:00:00Z');
    const fresh = mk('Histoire du jour', 'https://d.fr/4', '2026-10-31T08:00:00Z');
    await ingest(store, launch, [oldOpen, oldPub, ancientPub, fresh]);
    store.close();
    for (const a of [oldPub, ancientPub]) recordPublication(launch, { eventId: Store.eventIdFor(a.id), postId: a.id, summaryVersion: 1, text: 't', status: 'published' });
    mkdirSync(join(launch.dir, 'data', 'logs'), { recursive: true });
    const oldLog = join(launch.dir, 'data', 'logs', 'old.log');
    writeFileSync(oldLog, 'x');
    utimesSync(oldLog, new Date('2026-09-01'), new Date('2026-09-01'));
    writeFileSync(join(launch.dir, 'data', 'runs.jsonl'), `${JSON.stringify({ at: '2026-09-01T00:00:00Z' })}\n${JSON.stringify({ at: '2026-10-31T00:00:00Z' })}\n`);
    const s2 = openStore(launch);
    const r = purgeLaunch(launch, s2, new Date('2026-11-01T09:00:00Z'));
    expect(r).toMatchObject({ events: 2, articles: 2, publications: 1, logs: 1 });
    expect(s2.allEvents().map((e) => e.title).sort()).toEqual(['Histoire du jour', 'Histoire publiée en septembre']);
    expect(existsSync(join(launch.dir, 'data', 'events', `${Store.eventIdFor(oldOpen.id)}.json`))).toBe(false);
    expect(s2.meta('last_purge')).toBe('2026-11-01T09:00:00.000Z');
    s2.close();
  });
});

describe('GDELT politeness', () => {
  const gdeltLaunch = () => tmpLaunch({}, [source({ id: 'gd', type: 'gdelt', url: 'https://api.gdeltproject.org/api/v2/doc/doc', query: 'x', frequency: '15m' })]);
  const answer = (status: number, body: string, headers: Record<string, string> = {}): Fetcher => async () => ({ status, headers: new Headers(headers), arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer });
  const ok = JSON.stringify({ articles: [{ url: 'https://n.fr/1', title: 'Sommet du G20 à Rio', seendate: '20261101T080000Z', domain: 'n.fr', language: 'French' }] });
  const at = (iso: string) => new Date(iso);

  it('Retry-After and exponential backoff', async () => {
    expect(retryAfterMs('120', 0)).toBe(120_000);
    expect(retryAfterMs('Sun, 01 Nov 2026 10:00:00 GMT', Date.parse('2026-11-01T09:59:00Z'))).toBe(60_000);
    expect([1, 2, 3].map((n) => backoffMs(n))).toEqual([300_000, 600_000, 1_200_000]);
    expect(backoffMs(20)).toBe(6 * 3_600_000);
    expect(backoffMs(1, 3_600_000)).toBe(3_600_000);
  });

  it('honours 429, backs off, disables for 24 h after 3 in a row, reports it in status; a success resets', async () => {
    const launch = gdeltLaunch();
    let r = await collect(launch, { fetcher: answer(429, 'Too Many Requests', { 'retry-after': '600' }), now: at('2026-11-01T09:00:00Z'), force: true });
    expect(r.sources.errors[0]).toMatchObject({ http: 429, error: 'HTTP 429: retry after 10 min' });
    r = await collect(launch, { fetcher: answer(200, ok), now: at('2026-11-01T09:05:00Z'), force: true });
    expect(r.sources.backoff).toEqual([{ id: 'gd', status: 'backoff', until: '2026-11-01T09:10:00.000Z' }]);
    // GDELT's plain-text answer to a 200 counts as a 429.
    await collect(launch, { fetcher: answer(200, 'Please limit requests to one every 5 seconds'), now: at('2026-11-01T09:11:00Z'), force: true });
    r = await collect(launch, { fetcher: answer(429, ''), now: at('2026-11-01T10:00:00Z'), force: true });
    expect(r.sources.backoff[0]).toMatchObject({ status: 'disabled', until: '2026-11-02T10:00:00.000Z' });
    const st = openStore(launch);
    expect(st.sourceState('gd')).toMatchObject({ consecutive429: 3, disabledUntil: '2026-11-02T10:00:00.000Z' });
    st.close();
    r = await collect(launch, { fetcher: answer(200, ok), now: at('2026-11-02T09:00:00Z'), force: true });
    expect(r.sources.backoff[0]?.status).toBe('disabled');
    r = await collect(launch, { fetcher: answer(200, ok), now: at('2026-11-02T10:01:00Z'), force: true });
    expect(r.sources.fetched).toBe(1);
    const st2 = openStore(launch);
    expect(st2.sourceState('gd')).toMatchObject({ consecutive429: undefined, disabledUntil: undefined });
    st2.close();
  });

  it('a slower cadence (gdeltMinFrequency) and a short cache, even with force', async () => {
    const launch = gdeltLaunch();
    let n = 0;
    const counting: Fetcher = async (u, h) => { n++; return answer(200, ok)(u, h); };
    await collect(launch, { fetcher: counting, now: at('2026-11-01T09:00:00Z') });
    const r = await collect(launch, { fetcher: counting, now: at('2026-11-01T09:05:00Z'), force: true });
    expect(r.sources.fetched).toBe(1);
    expect(n).toBe(1); // served from the cache
    expect((await collect(launch, { fetcher: counting, now: at('2026-11-01T09:30:00Z') })).sources.notDue).toBe(1); // 15m asked, 1h enforced
    await collect(launch, { fetcher: counting, now: at('2026-11-01T10:01:00Z') });
    expect(n).toBe(2);
  });

  it('status lists a disabled source', async () => {
    const launch = gdeltLaunch();
    const now = new Date();
    for (let i = 0; i < 3; i++) await collect(launch, { fetcher: answer(429, ''), now: new Date(now.getTime() + i * 7 * 3_600_000), force: true });
    expect(launchStatus(launch).heldSources[0]).toMatchObject({ id: 'gd', consecutive429: 3, disabledUntil: expect.any(String) });
  });
});

describe('server-side caps and dedup in pending_events', () => {
  const agent: AgentSettings = { mode: 'dry_run', every: '1h', scope: { kind: 'world', values: [] }, limits: { perHour: 2, perDay: 3, batch: 5 }, runner: { kind: 'claude', timeoutMinutes: 30 }, identity: {}, breakrocks: 'breakrocks' };
  const seeded = async () => {
    const launch = tmpLaunch({ agent });
    const store = openStore(launch);
    const titles = ['Sommet européen sur le climat', 'Apple rachète une startup', 'Grève à la SNCF', 'Nouveau record au Louvre', 'La NASA lance Artemis'];
    await ingest(store, launch, titles.map((t, i) => art(t, `https://s${i}.fr/${i}`, { id: `s${i}`, name: `S${i}` })));
    store.close();
    return launch;
  };

  it('hands out no more than the caps leave, counting what was handed out even when never recorded', async () => {
    const launch = await seeded();
    const t0 = new Date('2026-11-01T10:00:00Z');
    const r1 = pendingForAi(launch, 20, t0);
    expect(r1.events).toHaveLength(2);
    expect(r1.caps).toMatchObject({ usedHour: 2, remaining: 0 });
    // The AI publishes without recording and asks again: nothing more this hour.
    const r2 = pendingForAi(launch, 20, new Date('2026-11-01T10:10:00Z'));
    expect(r2.events).toEqual([]);
    expect(r2.withheld.handedOutNotRecorded).toHaveLength(2);
    // Next hour: the daily cap (3) leaves one; the two handed out are still held back (lease), no double post.
    const r3 = pendingForAi(launch, 20, new Date('2026-11-01T11:05:00Z'));
    expect(r3.events).toHaveLength(1);
    expect(r3.events.map((e) => e.id)).not.toContain(r1.events[0]!.id);
    expect(pendingForAi(launch, 20, new Date('2026-11-01T12:30:00Z')).events).toEqual([]);
  });

  it('recording a handed-out event does not count it twice; skipping gives the hand-out back', async () => {
    const launch = await seeded();
    const t0 = new Date('2026-11-01T10:00:00Z');
    const [a, b] = pendingForAi(launch, 20, t0).events;
    const store = openStore(launch);
    store.addPublication({ eventId: a!.id, postId: 'p', summaryVersion: 1, text: 't', status: 'drafted', verification: 'to_confirm', sources: [], recordedAt: '2026-11-01T10:01:00.000Z' });
    store.setStatus(a!.id, 'drafted');
    expect(store.capUsage('2026-11-01T09:00:00Z', ['drafted'])).toBe(2);
    store.close();
    markEvent(launch, b!.id, 'skipped');
    const r = pendingForAi(launch, 20, new Date('2026-11-01T10:05:00Z'));
    expect(r.events).toHaveLength(1);
    expect(r.caps).toMatchObject({ usedHour: 2, usedDay: 2 });
  });

  it('without an agent block, no caps; the CLI pending never hands out', async () => {
    const launch = await seeded();
    launch.config.agent = undefined;
    expect(pendingForAi(launch, 20).events).toHaveLength(5);
    expect(pendingForAi(launch, 20).caps).toBeNull();
    expect(pendingEvents(launch, 20)).toHaveLength(5);
  });
});

describe('store migration', () => {
  it('opens a 0.2.0 news.db and adds the new columns in place', async () => {
    const launch = tmpLaunch();
    mkdirSync(join(launch.dir, 'data'), { recursive: true });
    const db = new DatabaseSync(join(launch.dir, 'data', 'news.db'));
    db.exec(`CREATE TABLE articles (id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL, outlet TEXT NOT NULL, grp TEXT NOT NULL, source_id TEXT NOT NULL,
      language TEXT, country TEXT, published_at TEXT NOT NULL, collected_at TEXT NOT NULL, category TEXT NOT NULL, official INTEGER NOT NULL,
      tokens TEXT NOT NULL, entities TEXT NOT NULL, event_id TEXT NOT NULL);
      CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL, language TEXT NOT NULL, sensitive INTEGER NOT NULL,
      first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, event_date TEXT NOT NULL, status TEXT NOT NULL, verification TEXT NOT NULL,
      article_count INTEGER NOT NULL, outlets TEXT NOT NULL, published TEXT);
      CREATE TABLE source_state (source_id TEXT PRIMARY KEY, etag TEXT, last_modified TEXT, last_fetch_at TEXT, last_status TEXT, last_count INTEGER);
      INSERT INTO source_state VALUES ('s', NULL, NULL, '2026-10-01T00:00:00Z', '200', 3);`);
    db.close();
    const store = openStore(launch);
    expect(store.sourceState('s')).toMatchObject({ lastCount: 3, consecutive429: undefined });
    await ingest(store, launch, [art('Un titre', 'https://a.fr/1')]);
    expect(store.counts().events).toBe(1);
    store.close();
  });
});
