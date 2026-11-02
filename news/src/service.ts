// The operations behind the MCP tools: collect, pending events, event detail, publication record, marks.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lexicalSimilarity, matches, type Candidate, type Signature, type Similarity } from './cluster.js';
import { conditionalGet, isGdeltRateLimit, itemsOf, requestUrl, type Fetcher } from './collect/fetchers.js';
import { frequencyMs } from './config.js';
import { hybrid, ollamaDecider, type Decider } from './decider.js';
import { similarityFor, type Embedder } from './embed.js';
import { normalizeItem } from './normalize.js';
import { isSensitive, readiness, verificationOf } from './status.js';
import { Store } from './store.js';
import type { Article, Launch, NewsEvent, PublicationStatus, Source } from './types.js';

export const openStore = (launch: Launch) => new Store(join(launch.dir, 'data'));

export interface CollectOptions { force?: boolean; now?: Date; fetcher?: Fetcher; similarity?: Similarity; embedder?: Embedder; onlySources?: string[]; sleep?: (ms: number) => Promise<void>; decider?: Decider }

export interface SourceReport {
  id: string; status: 'fetched' | 'cached' | 'not_modified' | 'not_due' | 'backoff' | 'disabled' | 'error';
  http?: number; items?: number; added?: number; promo?: number; error?: string; until?: string;
}

const H = 3_600_000;
const DAY = 24 * H;

const mostCommon = (xs: string[]) => {
  const n = new Map<string, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
};

/** Recomputes an event from its articles (status and publication snapshot are kept). */
export function summarize(id: string, articles: Article[], launch: Launch, previous?: NewsEvent): NewsEvent {
  const byDate = [...articles].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  const sensitiveCat = articles.map((a) => a.category).find((c) => isSensitive(c, launch.config));
  const category = sensitiveCat ?? mostCommon(articles.map((a) => a.category));
  const lead = [...byDate].reverse().find((a) => a.official) ?? byDate[byDate.length - 1]!;
  return {
    id, title: lead.title, category, language: mostCommon(articles.map((a) => a.language)), sensitive: !!sensitiveCat,
    firstSeen: previous?.firstSeen ?? byDate[0]!.collectedAt,
    lastSeen: articles.map((a) => a.collectedAt).sort().at(-1)!,
    eventDate: byDate[0]!.publishedAt,
    status: previous?.status ?? 'open',
    verification: verificationOf(articles, launch.config.verification.minOutlets),
    articleCount: articles.length,
    outlets: [...new Set(articles.map((a) => a.outlet))],
    ...(articles.filter((a) => a.promo).length * 2 > articles.length ? { promo: true } : {}),
    ...(previous?.mergedFrom?.length ? { mergedFrom: previous.mergedFrom } : {}),
    ...(previous?.published ? { published: previous.published } : {}),
  };
}

interface Live extends Candidate { published: boolean; firstSeen: string }

/**
 * Adds normalised articles to the store, grouping them into events. An article that matches two open
 * events, both at or above clustering.mergeThreshold, bridges them: they are merged (the published one,
 * else the older one, keeps its id; the other id becomes an alias). Two published events are never merged.
 * With an embedding similarity, the vectors are read from the store (collect embeds before ingesting).
 * With a decider (decider.merges), each bridge is asked "same event?": a sure no rejects a proposed merge,
 * a sure yes merges an event that matched above the threshold but below mergeThreshold. The plan is made
 * first (asking the model), the store is written after, in one transaction.
 */
export async function ingest(store: Store, launch: Launch, articles: Article[], similarity: Similarity = lexicalSimilarity, now = new Date(), decider?: Decider): Promise<{ added: number; newEvents: number; touched: Set<string>; merged: { into: string; from: string }[]; decided?: { asked: number; rejected: number; added: number } }> {
  const { threshold, windowHours, mergeThreshold } = launch.config.clustering;
  const fresh = articles.filter((a, i) => !store.hasArticle(a.id) && articles.findIndex((b) => b.id === a.id) === i)
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  if (!fresh.length) return { added: 0, newEvents: 0, touched: new Set(), merged: [] };
  const model = (similarity as Similarity & { model?: string }).model;
  const since = new Date(Date.parse(fresh[0]!.publishedAt) - windowHours * H).toISOString();
  const recent = store.recentEvents(since).filter(({ event }) => event.status !== 'skipped');
  const vectors = model ? store.vectorsOf([...fresh.map((a) => a.id), ...recent.flatMap((r) => r.members.map((m) => m.id))], model) : new Map<string, Float32Array>();
  const sigOf = (a: Article): Signature => ({ title: a.title, tokens: a.tokens, entities: a.entities, at: a.publishedAt, ...(vectors.has(a.id) ? { vector: vectors.get(a.id)! } : {}) });
  const live = new Map<string, Live>();
  for (const { event, members } of recent) live.set(event.id, { eventId: event.id, members: members.map(sigOf), published: !!event.published, firstSeen: event.firstSeen });
  const touched = new Set<string>();
  const merged: { into: string; from: string }[] = [];
  let newEvents = 0;
  const cfg = launch.config.decider;
  const ask = decider && cfg?.merges ? decider : undefined;
  const decided = { asked: 0, rejected: 0, added: 0 };
  const titleOf = (sig: Signature, c: Live) => {
    let best = -1, title = '';
    for (const m of c.members) { const x = similarity.score(sig, m); if (x > best && m.title) { best = x; title = m.title; } }
    return title;
  };
  const placed: [Article, string][] = [];
  for (const a of fresh) {
    const sig = sigOf(a);
    const hits = a.tokens.length || sig.vector ? matches(sig, [...live.values()], { threshold, windowHours, similarity }) : [];
    let eventId = hits[0]?.eventId ?? Store.eventIdFor(a.id);
    if (!hits.length) { newEvents++; live.set(eventId, { eventId, members: [], published: false, firstSeen: a.collectedAt }); }
    // Bridges: every other event this article also matches strongly (or, with a decider, matches at all).
    if (hits[0] && (hits[0].score >= mergeThreshold || ask)) {
      for (const h of hits.slice(1)) {
        if (h.score < mergeThreshold && !ask) break;
        const x = live.get(eventId)!, y = live.get(h.eventId);
        if (!y || (x.published && y.published)) continue;
        let merge = h.score >= mergeThreshold && hits[0].score >= mergeThreshold;
        if (ask) {
          const other = titleOf(sig, y);
          const p = other ? await ask.sameEvent(a.title, other) : undefined;
          if (p !== undefined) decided.asked++;
          const verdict = hybrid(merge, p, cfg!);
          if (merge && !verdict) decided.rejected++;
          if (!merge && verdict) decided.added++;
          merge = verdict;
        }
        if (!merge) continue;
        const [into, from] = y.published || (!x.published && y.firstSeen < x.firstSeen) ? [y, x] : [x, y];
        into.members.push(...from.members);
        live.delete(from.eventId);
        merged.push({ into: into.eventId, from: from.eventId });
        touched.delete(from.eventId);
        touched.add(into.eventId);
        eventId = into.eventId;
      }
    }
    live.get(eventId)!.members.unshift(sig);
    placed.push([a, eventId]);
    touched.add(eventId);
  }
  store.tx(() => {
    for (const [a, eventId] of placed) store.insertArticle(a, eventId);
    const at = now.toISOString();
    for (const { into, from } of merged) {
      const i = store.resolve(into), f = store.resolve(from);
      if (i === f) continue;
      // An event born in this batch has no row yet: its articles move all the same.
      if (!store.getEvent(i)) store.saveEvent(summarize(i, store.articlesOf(i).concat(store.articlesOf(f)), launch));
      store.mergeEvents(i, f, at);
    }
    for (const id of touched) {
      const arts = store.articlesOf(id);
      if (arts.length) store.saveEvent(summarize(id, arts, launch, store.getEvent(id)));
    }
  });
  for (const id of touched) store.writeEventFile(id);
  return { added: fresh.length, newEvents, touched, merged, ...(ask ? { decided } : {}) };
}

/** Embeds the titles of [articles] not yet embedded with [embedder]'s model, and stores the vectors. */
export async function embedArticles(store: Store, embedder: Embedder, articles: Article[]): Promise<number> {
  const missing = articles.filter((a, i) => articles.findIndex((b) => b.id === a.id) === i && !store.hasArticle(a.id) && !store.vectorsOf([a.id], embedder.model).size);
  if (!missing.length) return 0;
  const vecs = await embedder.embed(missing.map((a) => a.title));
  if (vecs.length !== missing.length) throw new Error(`embedder returned ${vecs.length} vectors for ${missing.length} titles`);
  store.tx(() => missing.forEach((a, i) => store.putVector(a.id, embedder.model, vecs[i]!)));
  return missing.length;
}

/** Retry-After in milliseconds: seconds or an HTTP date. */
export function retryAfterMs(value: string | undefined, now: number): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : Math.max(0, t - now);
}

/** The backoff after the [n]th consecutive 429: Retry-After if given, else 5 min doubling, at most 6 h. */
export const backoffMs = (n: number, retryAfter?: number) => Math.max(retryAfter ?? 0, Math.min(6 * H, 5 * 60_000 * 2 ** Math.max(0, n - 1)));

/** Purges a launch past its retention (store, event files, old logs and runs.jsonl lines). */
export function purgeLaunch(launch: Launch, store: Store, now = new Date()) {
  const r = launch.config.retention ?? { articlesDays: 30, eventsDays: 180, logsDays: 30 };
  const iso = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
  const res = store.purge(iso(r.articlesDays), iso(r.eventsDays), now.toISOString());
  let logs = 0;
  const logsDir = join(launch.dir, 'data', 'logs');
  const logCut = now.getTime() - r.logsDays * DAY;
  try {
    for (const f of readdirSync(logsDir)) if (statSync(join(logsDir, f)).mtimeMs < logCut) { rmSync(join(logsDir, f), { force: true }); logs++; }
  } catch { /* no logs */ }
  const runs = join(launch.dir, 'data', 'runs.jsonl');
  try {
    const lines = readFileSync(runs, 'utf8').split('\n').filter(Boolean);
    const kept = lines.filter((l) => { try { return (JSON.parse(l) as { at: string }).at >= iso(r.logsDays); } catch { return false; } });
    if (kept.length !== lines.length) writeFileSync(runs, kept.length ? `${kept.join('\n')}\n` : '');
  } catch { /* never ran */ }
  return { ...res, logs };
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]!); }
  }));
  return out;
}

export async function collect(launch: Launch, opts: CollectOptions = {}) {
  const store = openStore(launch);
  try {
    const now = opts.now ?? new Date();
    const nowMs = now.getTime();
    const collectedAt = now.toISOString();
    const minDate = nowMs - launch.config.collect.maxAgeHours * H;
    const pol = launch.config.politeness ?? { gdeltMinFrequency: '1h', disableAfter429: 3, disableHours: 24, cacheMinutes: 15 };
    const promoCategories = launch.config.filters?.promoCategories;
    const all: Article[] = [];
    const sources = launch.sources.filter((s) => !opts.onlySources || opts.onlySources.includes(s.id));
    const later = (iso?: string) => !!iso && Date.parse(iso) > nowMs;
    const minEvery = (source: Source) => source.type === 'gdelt' ? Math.max(frequencyMs(source.frequency), frequencyMs(pol.gdeltMinFrequency)) : frequencyMs(source.frequency);
    const take = (source: Source, body: string, http: number): SourceReport & { items: number } => {
      const items = itemsOf(source, body);
      const arts = items.map((i) => normalizeItem(i, source, collectedAt, launch.config.categoryKeywords, promoCategories))
        .filter((a): a is Article => !!a && Date.parse(a.publishedAt) >= minDate && Date.parse(a.publishedAt) <= nowMs + H);
      all.push(...arts);
      return { id: source.id, status: 'fetched', http, items: items.length, added: arts.length, promo: arts.filter((a) => a.promo).length };
    };
    const fetchOne = async (source: Source): Promise<SourceReport> => {
      const st = store.sourceState(source.id);
      if (later(st.disabledUntil)) return { id: source.id, status: 'disabled', until: st.disabledUntil };
      if (later(st.backoffUntil)) return { id: source.id, status: 'backoff', until: st.backoffUntil };
      const url = requestUrl(source);
      // GDELT has no conditional GET: a recent answer is reused rather than asked again (force included).
      const hit = source.type === 'gdelt' ? store.cached(url) : undefined;
      if (hit && Date.parse(hit.fetchedAt) + pol.cacheMinutes * 60_000 > nowMs) return { ...take(source, hit.body, 200), status: 'cached' };
      if (!opts.force && st.lastFetchAt && Date.parse(st.lastFetchAt) + minEvery(source) > nowMs) return { id: source.id, status: 'not_due' };
      const reset = { backoffUntil: undefined, consecutive429: undefined, disabledUntil: undefined };
      try {
        const res = await conditionalGet(url, st, launch.config.collect.userAgent, opts.fetcher);
        const limited = res.status === 429 || (source.type === 'gdelt' && !!res.body && isGdeltRateLimit(res.body));
        if (limited) {
          const n = (st.consecutive429 ?? 0) + 1;
          const wait = backoffMs(n, retryAfterMs(res.retryAfter, nowMs));
          const disabled = n >= pol.disableAfter429 ? new Date(nowMs + pol.disableHours * H).toISOString() : undefined;
          store.saveSourceState({ ...st, lastFetchAt: collectedAt, lastStatus: '429', consecutive429: n, backoffUntil: new Date(nowMs + wait).toISOString(), disabledUntil: disabled });
          return { id: source.id, status: disabled ? 'disabled' : 'error', http: 429, error: disabled ? `HTTP 429 ${n} times in a row: disabled until ${disabled}` : `HTTP 429: retry after ${Math.round(wait / 60_000)} min`, ...(disabled ? { until: disabled } : {}) };
        }
        if (res.notModified) { store.saveSourceState({ ...st, ...reset, lastFetchAt: collectedAt, lastStatus: '304' }); return { id: source.id, status: 'not_modified', http: 304 }; }
        if (!res.body) { store.saveSourceState({ ...st, lastFetchAt: collectedAt, lastStatus: String(res.status) }); return { id: source.id, status: 'error', http: res.status, error: `HTTP ${res.status}` }; }
        if (source.type === 'gdelt') store.cache(url, res.body, collectedAt);
        const report = take(source, res.body, res.status);
        store.saveSourceState({ sourceId: source.id, etag: res.etag, lastModified: res.lastModified, lastFetchAt: collectedAt, lastStatus: String(res.status), lastCount: report.items });
        return report;
      } catch (e) {
        store.saveSourceState({ ...st, lastFetchAt: collectedAt, lastStatus: 'error' });
        return { id: source.id, status: 'error', error: (e as Error).message };
      }
    };
    // GDELT asks for one request every 5 seconds: its sources go one by one, after the feeds.
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const feeds = sources.filter((s) => s.type !== 'gdelt');
    const gdelt = sources.filter((s) => s.type === 'gdelt');
    const reports = await pool(feeds, launch.config.collect.concurrency, fetchOne);
    let asked = false;
    for (const s of gdelt) {
      if (asked) await sleep(6_000);
      const r = await fetchOne(s);
      asked = r.status === 'fetched' || r.http === 429 || r.status === 'error';
      reports.push(r);
    }
    let similarity = opts.similarity;
    let embedding: { model: string; embedded: number } | { error: string } | undefined;
    if (!similarity) {
      try {
        const sel = similarityFor(launch.config, opts.embedder);
        similarity = sel.similarity;
        if (sel.embedder) embedding = { model: sel.embedder.model, embedded: await embedArticles(store, sel.embedder, all) };
      } catch (e) {
        // The embedder is unavailable (not installed, endpoint down): this collect groups lexically.
        embedding = { error: (e as Error).message };
        similarity = lexicalSimilarity;
      }
    }
    // The decider (off by default): built once per collect; it warns once and steps aside if unavailable.
    const dcfg = launch.config.decider;
    const decider = dcfg?.enabled ? opts.decider ?? ollamaDecider(dcfg) : undefined;
    let promoDecided: { asked: number; flipped: number } | undefined;
    if (decider && dcfg!.promo) {
      promoDecided = { asked: 0, flipped: 0 };
      for (const a of all.filter((x, i) => !store.hasArticle(x.id) && all.findIndex((y) => y.id === x.id) === i)) {
        const p = await decider.promotional(a.title, a.url);
        if (p === undefined) break;
        promoDecided.asked++;
        const v = hybrid(!!a.promo, p, dcfg!);
        if (v !== !!a.promo) promoDecided.flipped++;
        if (v) a.promo = true; else delete a.promo;
      }
      for (const a of all) { const first = all.find((y) => y.id === a.id)!; if (first !== a) { if (first.promo) a.promo = true; else delete a.promo; } }
    }
    const { added, newEvents, touched, merged, decided } = await ingest(store, launch, all, similarity, now, decider);
    const lastPurge = store.meta('last_purge');
    const purged = !lastPurge || Date.parse(lastPurge) + DAY <= nowMs ? purgeLaunch(launch, store, now) : undefined;
    const fetched = reports.filter((r) => r.status === 'fetched' || r.status === 'cached').length;
    return {
      launch: launch.name, at: collectedAt, similarity: similarity.name,
      sources: {
        total: sources.length, fetched, notModified: reports.filter((r) => r.status === 'not_modified').length, notDue: reports.filter((r) => r.status === 'not_due').length,
        backoff: reports.filter((r) => r.status === 'backoff' || r.status === 'disabled').map((r) => ({ id: r.id, status: r.status, until: r.until })),
        errors: reports.filter((r) => r.status === 'error' || (r.status === 'disabled' && r.error)),
      },
      articles: { seen: all.length, added, promo: all.filter((a) => a.promo).length }, events: { created: newEvents, touched: touched.size, merged },
      ...(embedding ? { embedding } : {}),
      ...(decider ? { decider: { model: decider.model, merges: decided, promo: promoDecided } } : {}),
      ...(purged ? { purged } : {}),
      totals: store.counts(),
      pending: pendingEvents(launch, 1000, store).length,
    };
  } finally { store.close(); }
}

/**
 * Events ready to publish (kind new) or to update (kind update), updates first then the most covered.
 * Promotions are left out unless filters.keepPromo. A merged event says so in its reasons ("merged") and
 * lists the ids merged into it (mergedFrom).
 */
export function pendingEvents(launch: Launch, limit = 20, existing?: Store) {
  const store = existing ?? openStore(launch);
  try {
    const keepPromo = !!launch.config.filters?.keepPromo;
    const out = [];
    for (const e of store.allEvents()) {
      if (e.promo && !keepPromo) continue;
      const r = readiness(e, launch.config);
      if (r.kind !== 'new' && r.kind !== 'update') continue;
      out.push({
        id: e.id, kind: r.kind, reasons: r.reasons, title: e.title, category: e.category, language: e.language, sensitive: e.sensitive, verification: e.verification,
        eventDate: e.eventDate, outlets: e.outlets, articleCount: e.articleCount, published: e.published, universes: universesFor(launch, e),
        nextSummaryVersion: (e.published?.summaryVersion ?? 0) + 1,
        ...(e.promo ? { promo: true } : {}), ...(e.mergedFrom?.length ? { mergedFrom: e.mergedFrom } : {}),
      });
    }
    // Updates first (a published post is out of date), then the most covered stories.
    out.sort((a, b) => (a.kind === b.kind ? b.outlets.length - a.outlets.length || b.eventDate.localeCompare(a.eventDate) : a.kind === 'update' ? -1 : 1));
    return out.slice(0, limit);
  } finally { if (!existing) store.close(); }
}

/** What the caps count: posts that went out (new posts, "Update" replies) and, in dry run, drafts. */
export const COUNTED: PublicationStatus[] = ['published', 'update_reply', 'drafted'];

/** An event handed out and not recorded is not handed out again for this long (no double post). */
export const LEASE_MINUTES = 120;

/** Posts counted in the last hour and day: recorded ones and the ones handed out by pending_events. */
export function capUsage(store: Store, now = new Date()) {
  return {
    hour: store.capUsage(new Date(now.getTime() - H).toISOString(), COUNTED),
    day: store.capUsage(new Date(now.getTime() - DAY).toISOString(), COUNTED),
  };
}

/**
 * pending_events as the AI gets it: with an agent block, never more events than the hourly and daily caps
 * leave, every event handed out counts against the caps at once (recording it later does not count it
 * twice), and an event handed out and not recorded is held back for LEASE_MINUTES. So an AI that publishes
 * without recording cannot go past the caps.
 */
export function pendingForAi(launch: Launch, limit = 20, now = new Date()) {
  const store = openStore(launch);
  try {
    const limits = launch.config.agent?.limits;
    const at = now.toISOString();
    const leaseCut = now.getTime() - LEASE_MINUTES * 60_000;
    const key = (e: { id: string; nextSummaryVersion: number }) => `${e.id}:v${e.nextSummaryVersion}`;
    const all = pendingEvents(launch, 100_000, store);
    const held = all.filter((e) => { const h = store.handoutAt(key(e)); return !!h && Date.parse(h) > leaseCut; });
    const free = all.filter((e) => !held.includes(e));
    const used = capUsage(store, now);
    const remaining = limits ? Math.max(0, Math.min(limits.perHour - used.hour, limits.perDay - used.day)) : Infinity;
    const events = free.slice(0, Math.min(limit, remaining));
    store.tx(() => { for (const e of events) store.handout(key(e), e.id, at); });
    const after = capUsage(store, now);
    return {
      events,
      caps: limits ? { perHour: limits.perHour, perDay: limits.perDay, usedHour: after.hour, usedDay: after.day, remaining: Math.max(0, Math.min(limits.perHour - after.hour, limits.perDay - after.day)) } : null,
      withheld: { byCaps: Math.max(0, free.length - events.length), handedOutNotRecorded: held.map((e) => e.id) },
    };
  } finally { store.close(); }
}

export function universesFor(launch: Launch, e: Pick<NewsEvent, 'category' | 'language'>): string[] {
  const u = launch.config.universes;
  return u.byCategory?.[e.category] ?? u.byLanguage?.[e.language] ?? u.default;
}

export function eventDetail(launch: Launch, id: string) {
  const store = openStore(launch);
  try {
    const event = store.getEvent(id);
    if (!event) throw new Error(`Unknown event ${id} in ${launch.name}`);
    id = event.id;
    const sources = new Map(launch.sources.map((s) => [s.id, s]));
    return {
      event, aliases: store.aliasesOf(id), readiness: readiness(event, launch.config), universes: universesFor(launch, event),
      articles: store.articlesOf(id).map(({ tokens: _t, entities: _e, ...a }) => ({ ...a, rights: sources.get(a.sourceId)?.rights })),
      publications: store.publicationsOf(id),
    };
  } finally { store.close(); }
}

export function recordPublication(launch: Launch, input: { eventId: string; postId: string; summaryVersion: number; text: string; status: PublicationStatus }) {
  const store = openStore(launch);
  try {
    const event = store.getEvent(input.eventId);
    if (!event) throw new Error(`Unknown event ${input.eventId} in ${launch.name}`);
    const at = new Date().toISOString();
    const sources = store.articlesOf(event.id).map((a) => a.url);
    store.tx(() => {
      store.addPublication({ ...input, eventId: event.id, verification: event.verification, sources, recordedAt: at });
      if (input.status !== 'failed' && input.status !== 'drafted') {
        const { mergedFrom: _m, ...rest } = event;
        store.saveEvent({ ...rest, status: 'published', published: { postId: event.published?.postId ?? input.postId, summaryVersion: input.summaryVersion, outlets: event.outlets, verification: event.verification, title: event.title, at } });
      }
    });
    store.writeEventFile(event.id);
    return { event: store.getEvent(event.id), publications: store.publicationsOf(event.id).length };
  } finally { store.close(); }
}

export function markEvent(launch: Launch, id: string, status: 'skipped' | 'needs_review') {
  const store = openStore(launch);
  try {
    const event = store.getEvent(id);
    if (!event) throw new Error(`Unknown event ${id} in ${launch.name}`);
    store.setStatus(event.id, status);
    // A skipped or held event gives its hand-out back to the caps.
    store.releaseHandouts(event.id);
    store.writeEventFile(event.id);
    return store.getEvent(event.id);
  } finally { store.close(); }
}

/**
 * Dry run: writes the post the AI would publish to launches/<name>/drafts/<eventId>-v<n>.md and records it
 * (status drafted). A never-published event becomes "drafted" and stops coming back; a published one keeps
 * its post and gets a fresh snapshot, as after an update.
 */
export function saveDraft(launch: Launch, input: { eventId: string; kind: 'new' | 'update'; text: string; universes: string[]; summaryVersion?: number }) {
  const store = openStore(launch);
  try {
    const event = store.getEvent(input.eventId);
    if (!event) throw new Error(`Unknown event ${input.eventId} in ${launch.name}`);
    const version = input.summaryVersion ?? (event.published?.summaryVersion ?? 0) + 1;
    const dir = join(launch.dir, 'drafts');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${event.id}-v${version}.md`);
    const at = new Date().toISOString();
    const front = ['---', `event: ${event.id}`, `kind: ${input.kind}`, `summaryVersion: ${version}`, `verification: ${event.verification}`, `universes: ${JSON.stringify(input.universes)}`,
      `outlets: ${JSON.stringify(event.outlets)}`, `draftedAt: ${at}`, '---', ''].join('\n');
    writeFileSync(file, `${front}${input.text.trim()}\n`);
    const sources = store.articlesOf(event.id).map((a) => a.url);
    store.tx(() => {
      store.addPublication({ eventId: event.id, postId: `draft:${event.id}-v${version}`, summaryVersion: version, text: input.text, status: 'drafted', verification: event.verification, sources, recordedAt: at });
      store.clearMerged(event.id);
      if (event.published) store.saveEvent({ ...event, mergedFrom: undefined, published: { ...event.published, summaryVersion: version, outlets: event.outlets, verification: event.verification, title: event.title, at } });
      else store.setStatus(event.id, 'drafted');
    });
    store.writeEventFile(event.id);
    return { file, summaryVersion: version };
  } finally { store.close(); }
}
