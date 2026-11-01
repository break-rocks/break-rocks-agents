// The operations behind the MCP tools: collect, pending events, event detail, publication record, marks.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assign, type Candidate, type Similarity } from './cluster.js';
import { conditionalGet, itemsOf, requestUrl, type Fetcher } from './collect/fetchers.js';
import { frequencyMs } from './config.js';
import { normalizeItem } from './normalize.js';
import { isSensitive, readiness, verificationOf } from './status.js';
import { Store } from './store.js';
import type { Article, Launch, NewsEvent, PublicationStatus, Source } from './types.js';

export const openStore = (launch: Launch) => new Store(join(launch.dir, 'data'));

export interface CollectOptions { force?: boolean; now?: Date; fetcher?: Fetcher; similarity?: Similarity; onlySources?: string[] }

export interface SourceReport { id: string; status: 'fetched' | 'not_modified' | 'not_due' | 'error'; http?: number; items?: number; added?: number; error?: string }

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
    ...(previous?.published ? { published: previous.published } : {}),
  };
}

/** Adds normalised articles to the store, grouping them into events. Returns the touched event ids. */
export function ingest(store: Store, launch: Launch, articles: Article[], similarity?: Similarity): { added: number; newEvents: number; touched: Set<string> } {
  const { threshold, windowHours } = launch.config.clustering;
  const fresh = articles.filter((a, i) => !store.hasArticle(a.id) && articles.findIndex((b) => b.id === a.id) === i)
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  if (!fresh.length) return { added: 0, newEvents: 0, touched: new Set() };
  const since = new Date(Date.parse(fresh[0]!.publishedAt) - windowHours * 3_600_000).toISOString();
  const candidates = new Map<string, Candidate>();
  for (const { event, members } of store.recentEvents(since)) {
    if (event.status === 'skipped') continue;
    candidates.set(event.id, { eventId: event.id, members: members.map((m) => ({ tokens: m.tokens, entities: m.entities, at: m.publishedAt })) });
  }
  const touched = new Set<string>();
  let newEvents = 0;
  store.tx(() => {
    for (const a of fresh) {
      const sig = { tokens: a.tokens, entities: a.entities, at: a.publishedAt };
      const hit = a.tokens.length ? assign(sig, [...candidates.values()], { threshold, windowHours, similarity }) : undefined;
      const eventId = hit?.eventId ?? Store.eventIdFor(a.id);
      if (!hit) { newEvents++; candidates.set(eventId, { eventId, members: [] }); }
      candidates.get(eventId)!.members.unshift(sig);
      store.insertArticle(a, eventId);
      touched.add(eventId);
    }
    for (const id of touched) store.saveEvent(summarize(id, store.articlesOf(id), launch, store.getEvent(id)));
  });
  for (const id of touched) store.writeEventFile(id);
  return { added: fresh.length, newEvents, touched };
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
    const collectedAt = now.toISOString();
    const minDate = now.getTime() - launch.config.collect.maxAgeHours * 3_600_000;
    const all: Article[] = [];
    const sources = launch.sources.filter((s) => !opts.onlySources || opts.onlySources.includes(s.id));
    const fetchOne = async (source: Source): Promise<SourceReport> => {
      const st = store.sourceState(source.id);
      if (!opts.force && st.lastFetchAt && Date.parse(st.lastFetchAt) + frequencyMs(source.frequency) > now.getTime()) return { id: source.id, status: 'not_due' };
      try {
        const res = await conditionalGet(requestUrl(source), st, launch.config.collect.userAgent, opts.fetcher);
        if (res.notModified) { store.saveSourceState({ ...st, lastFetchAt: collectedAt, lastStatus: '304' }); return { id: source.id, status: 'not_modified', http: 304 }; }
        if (!res.body) { store.saveSourceState({ ...st, lastFetchAt: collectedAt, lastStatus: String(res.status) }); return { id: source.id, status: 'error', http: res.status, error: `HTTP ${res.status}` }; }
        const items = itemsOf(source, res.body);
        const arts = items.map((i) => normalizeItem(i, source, collectedAt, launch.config.categoryKeywords))
          .filter((a): a is Article => !!a && Date.parse(a.publishedAt) >= minDate && Date.parse(a.publishedAt) <= now.getTime() + 3_600_000);
        all.push(...arts);
        store.saveSourceState({ sourceId: source.id, etag: res.etag, lastModified: res.lastModified, lastFetchAt: collectedAt, lastStatus: String(res.status), lastCount: items.length });
        return { id: source.id, status: 'fetched', http: res.status, items: items.length, added: arts.length };
      } catch (e) {
        store.saveSourceState({ ...st, lastFetchAt: collectedAt, lastStatus: 'error' });
        return { id: source.id, status: 'error', error: (e as Error).message };
      }
    };
    // GDELT asks for one request every 5 seconds: its sources go one by one, after the feeds.
    const feeds = sources.filter((s) => s.type !== 'gdelt');
    const gdelt = sources.filter((s) => s.type === 'gdelt');
    const reports = await pool(feeds, launch.config.collect.concurrency, fetchOne);
    for (const [k, s] of gdelt.entries()) {
      if (k) await new Promise((r) => setTimeout(r, 6_000));
      reports.push(await fetchOne(s));
    }
    const { added, newEvents, touched } = ingest(store, launch, all, opts.similarity);
    const fetched = reports.filter((r) => r.status === 'fetched').length;
    return {
      launch: launch.name, at: collectedAt,
      sources: { total: sources.length, fetched, notModified: reports.filter((r) => r.status === 'not_modified').length, notDue: reports.filter((r) => r.status === 'not_due').length, errors: reports.filter((r) => r.status === 'error') },
      articles: { seen: all.length, added }, events: { created: newEvents, touched: touched.size },
      totals: store.counts(),
      pending: pendingEvents(launch, 1000, store).length,
    };
  } finally { store.close(); }
}

/** Events ready to publish (kind new) or to update (kind update), oldest event date first. */
export function pendingEvents(launch: Launch, limit = 20, existing?: Store) {
  const store = existing ?? openStore(launch);
  try {
    const out = [];
    for (const e of store.allEvents()) {
      const r = readiness(e, launch.config);
      if (r.kind !== 'new' && r.kind !== 'update') continue;
      out.push({ id: e.id, kind: r.kind, reasons: r.reasons, title: e.title, category: e.category, language: e.language, sensitive: e.sensitive, verification: e.verification, eventDate: e.eventDate, outlets: e.outlets, articleCount: e.articleCount, published: e.published, universes: universesFor(launch, e) });
    }
    // Updates first (a published post is out of date), then the most covered stories.
    out.sort((a, b) => (a.kind === b.kind ? b.outlets.length - a.outlets.length || b.eventDate.localeCompare(a.eventDate) : a.kind === 'update' ? -1 : 1));
    return out.slice(0, limit);
  } finally { if (!existing) store.close(); }
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
    const sources = new Map(launch.sources.map((s) => [s.id, s]));
    return {
      event, readiness: readiness(event, launch.config), universes: universesFor(launch, event),
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
      store.addPublication({ ...input, verification: event.verification, sources, recordedAt: at });
      if (input.status !== 'failed' && input.status !== 'drafted') {
        store.saveEvent({ ...event, status: 'published', published: { postId: event.published?.postId ?? input.postId, summaryVersion: input.summaryVersion, outlets: event.outlets, verification: event.verification, title: event.title, at } });
      }
    });
    store.writeEventFile(event.id);
    return { event: store.getEvent(event.id), publications: store.publicationsOf(event.id).length };
  } finally { store.close(); }
}

export function markEvent(launch: Launch, id: string, status: 'skipped' | 'needs_review') {
  const store = openStore(launch);
  try {
    if (!store.getEvent(id)) throw new Error(`Unknown event ${id} in ${launch.name}`);
    store.setStatus(id, status);
    store.writeEventFile(id);
    return store.getEvent(id);
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
      if (event.published) store.saveEvent({ ...event, published: { ...event.published, summaryVersion: version, outlets: event.outlets, verification: event.verification, title: event.title, at } });
      else store.setStatus(event.id, 'drafted');
    });
    store.writeEventFile(event.id);
    return { file, summaryVersion: version };
  } finally { store.close(); }
}
