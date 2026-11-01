// Storage of a launch: SQLite (node:sqlite) in launches/<name>/data/news.db, plus one JSON file per
// event in launches/<name>/data/events/<id>.json (the event, its articles and every publication).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fromBlob, toBlob } from './embed.js';
import { sha1 } from './normalize.js';
import type { Article, EventStatus, NewsEvent, Publication, PublicationStatus, Verification } from './types.js';

export interface SourceState {
  sourceId: string; etag?: string; lastModified?: string; lastFetchAt?: string; lastStatus?: string; lastCount?: number;
  /** No request before this date (Retry-After or exponential backoff after a 429). */
  backoffUntil?: string;
  /** Consecutive 429 answers; reset by a success. */
  consecutive429?: number;
  /** Disabled after repeated 429s, until this date. */
  disabledUntil?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL, outlet TEXT NOT NULL, grp TEXT NOT NULL, source_id TEXT NOT NULL,
  language TEXT, country TEXT, published_at TEXT NOT NULL, collected_at TEXT NOT NULL, category TEXT NOT NULL, official INTEGER NOT NULL,
  tokens TEXT NOT NULL, entities TEXT NOT NULL, event_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS articles_event ON articles(event_id);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL, language TEXT NOT NULL, sensitive INTEGER NOT NULL,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, event_date TEXT NOT NULL, status TEXT NOT NULL, verification TEXT NOT NULL,
  article_count INTEGER NOT NULL, outlets TEXT NOT NULL, published TEXT);
CREATE INDEX IF NOT EXISTS events_last_seen ON events(last_seen);
CREATE TABLE IF NOT EXISTS publications (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, post_id TEXT NOT NULL, summary_version INTEGER NOT NULL,
  text TEXT NOT NULL, status TEXT NOT NULL, verification TEXT NOT NULL, sources TEXT NOT NULL, recorded_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS publications_event ON publications(event_id);
CREATE TABLE IF NOT EXISTS source_state (
  source_id TEXT PRIMARY KEY, etag TEXT, last_modified TEXT, last_fetch_at TEXT, last_status TEXT, last_count INTEGER);
CREATE TABLE IF NOT EXISTS vectors (article_id TEXT NOT NULL, model TEXT NOT NULL, vec BLOB NOT NULL, PRIMARY KEY (article_id, model));
CREATE TABLE IF NOT EXISTS event_aliases (alias TEXT PRIMARY KEY, event_id TEXT NOT NULL, merged_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS event_aliases_event ON event_aliases(event_id);
CREATE TABLE IF NOT EXISTS handouts (key TEXT PRIMARY KEY, event_id TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS handouts_at ON handouts(at);
CREATE TABLE IF NOT EXISTS http_cache (url TEXT PRIMARY KEY, body TEXT NOT NULL, fetched_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** Columns added after 0.2.0: added in place to an existing news.db. */
const MIGRATIONS: [table: string, column: string, ddl: string][] = [
  ['articles', 'promo', 'INTEGER NOT NULL DEFAULT 0'],
  ['events', 'promo', 'INTEGER NOT NULL DEFAULT 0'],
  ['events', 'merged_from', 'TEXT'],
  ['source_state', 'backoff_until', 'TEXT'],
  ['source_state', 'consecutive_429', 'INTEGER'],
  ['source_state', 'disabled_until', 'TEXT'],
];

type Row = Record<string, string | number | null>;
const s = (v: unknown) => (v === null || v === undefined ? undefined : String(v));

export class Store {
  readonly db: DatabaseSync;
  readonly eventsDir: string;

  constructor(readonly dataDir: string) {
    mkdirSync(join(dataDir, 'events'), { recursive: true });
    this.eventsDir = join(dataDir, 'events');
    this.db = new DatabaseSync(join(dataDir, 'news.db'));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    for (const [table, column, ddl] of MIGRATIONS) {
      const cols = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((r) => r.name);
      if (!cols.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }

  close() { this.db.close(); }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  hasArticle(id: string) { return !!this.db.prepare('SELECT 1 FROM articles WHERE id = ?').get(id); }

  insertArticle(a: Article, eventId: string) {
    this.db.prepare(`INSERT OR IGNORE INTO articles (id, url, title, outlet, grp, source_id, language, country, published_at, collected_at, category, official,
      tokens, entities, event_id, promo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      a.id, a.url, a.title, a.outlet, a.group, a.sourceId, a.language, a.country, a.publishedAt, a.collectedAt, a.category, a.official ? 1 : 0,
      JSON.stringify(a.tokens), JSON.stringify(a.entities), eventId, a.promo ? 1 : 0);
  }

  // ---- vectors (embedding backend) ----

  putVector(articleId: string, model: string, v: Float32Array) {
    this.db.prepare('INSERT OR REPLACE INTO vectors VALUES (?,?,?)').run(articleId, model, toBlob(v));
  }

  vectorsOf(ids: string[], model: string): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>();
    const q = this.db.prepare('SELECT vec FROM vectors WHERE article_id = ? AND model = ?');
    for (const id of ids) {
      const r = q.get(id, model) as { vec: Uint8Array } | undefined;
      if (r) out.set(id, fromBlob(r.vec));
    }
    return out;
  }

  // ---- aliases (merged events) ----

  /** The current id of an event: itself, or the event it was merged into. */
  resolve(id: string): string {
    for (let i = 0; i < 10; i++) {
      const r = this.db.prepare('SELECT event_id FROM event_aliases WHERE alias = ?').get(id) as Row | undefined;
      if (!r) return id;
      id = String(r.event_id);
    }
    return id;
  }

  aliasesOf(id: string): string[] {
    return (this.db.prepare('SELECT alias FROM event_aliases WHERE event_id = ? ORDER BY merged_at').all(id) as Row[]).map((r) => String(r.alias));
  }

  /**
   * Merges [from] into [into]: its articles, publications and aliases move, [from] becomes an alias of
   * [into] (so a post recorded under either id stays attached), and [into] is marked merged for the AI.
   */
  mergeEvents(into: string, from: string, at: string) {
    this.db.prepare('UPDATE articles SET event_id = ? WHERE event_id = ?').run(into, from);
    this.db.prepare('UPDATE publications SET event_id = ? WHERE event_id = ?').run(into, from);
    this.db.prepare('UPDATE event_aliases SET event_id = ? WHERE event_id = ?').run(into, from);
    this.db.prepare('UPDATE handouts SET event_id = ? WHERE event_id = ?').run(into, from);
    this.db.prepare('INSERT OR REPLACE INTO event_aliases VALUES (?,?,?)').run(from, into, at);
    const target = this.db.prepare('SELECT merged_from FROM events WHERE id = ?').get(into) as Row | undefined;
    const loser = this.db.prepare('SELECT merged_from FROM events WHERE id = ?').get(from) as Row | undefined;
    const merged = [...new Set([...(target?.merged_from ? JSON.parse(String(target.merged_from)) as string[] : []), ...(loser?.merged_from ? JSON.parse(String(loser.merged_from)) as string[] : []), from])];
    this.db.prepare('UPDATE events SET merged_from = ? WHERE id = ?').run(JSON.stringify(merged), into);
    this.db.prepare('DELETE FROM events WHERE id = ?').run(from);
    rmSync(join(this.eventsDir, `${from}.json`), { force: true });
  }

  clearMerged(id: string) { this.db.prepare('UPDATE events SET merged_from = NULL WHERE id = ?').run(id); }

  // ---- handouts (server-side caps of pending_events) ----

  /** Records that [key] (event + summary version) was handed to the AI; the first hand-out time is kept. */
  handout(key: string, eventId: string, at: string) { this.db.prepare('INSERT OR IGNORE INTO handouts VALUES (?,?,?)').run(key, eventId, at); }

  /** The hand-out time of [key], if handed out. */
  handoutAt(key: string): string | undefined { return s((this.db.prepare('SELECT at FROM handouts WHERE key = ?').get(key) as Row | undefined)?.at); }

  releaseHandouts(eventId: string) { this.db.prepare('DELETE FROM handouts WHERE event_id = ? AND key NOT IN (SELECT event_id || \':v\' || summary_version FROM publications)').run(eventId); }

  /**
   * What the caps count since [since]: distinct posts, each one either recorded (a counted publication) or
   * handed out by pending_events, keyed by event and summary version so a post is never counted twice.
   */
  capUsage(since: string, statuses: string[]): number {
    const q = statuses.map(() => '?').join(',');
    return Number((this.db.prepare(`SELECT COUNT(*) n FROM (
      SELECT event_id || ':v' || summary_version k FROM publications WHERE recorded_at >= ? AND status IN (${q})
      UNION SELECT key k FROM handouts WHERE at >= ?)`).get(since, ...statuses, since) as Row).n);
  }

  // ---- HTTP cache (GDELT) and meta ----

  cached(url: string): { body: string; fetchedAt: string } | undefined {
    const r = this.db.prepare('SELECT body, fetched_at FROM http_cache WHERE url = ?').get(url) as Row | undefined;
    return r ? { body: String(r.body), fetchedAt: String(r.fetched_at) } : undefined;
  }

  cache(url: string, body: string, at: string) { this.db.prepare('INSERT OR REPLACE INTO http_cache VALUES (?,?,?)').run(url, body, at); }

  meta(key: string): string | undefined { return s((this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined)?.value); }

  setMeta(key: string, value: string) { this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, value); }

  // ---- retention ----

  /**
   * Deletes what is past retention: events never published and their articles once their last article is
   * older than [articlesBefore]; published events (articles, publications, aliases) once last seen before
   * [eventsBefore]; articles of open events older than [articlesBefore]. Then vectors, hand-outs and the
   * cache left without an owner, the JSON files of deleted events, and a VACUUM.
   */
  purge(articlesBefore: string, eventsBefore: string, now: string): { articles: number; events: number; publications: number } {
    const n = (r: { changes: number | bigint }) => Number(r.changes);
    const doomed = (this.db.prepare(`SELECT id FROM events WHERE (published IS NULL AND last_seen < ?) OR (published IS NOT NULL AND last_seen < ?)`).all(articlesBefore, eventsBefore) as Row[]).map((r) => String(r.id));
    const out = { articles: 0, events: 0, publications: 0 };
    this.tx(() => {
      const delArt = this.db.prepare('DELETE FROM articles WHERE event_id = ?');
      const delPub = this.db.prepare('DELETE FROM publications WHERE event_id = ?');
      for (const id of doomed) {
        out.articles += n(delArt.run(id));
        out.publications += n(delPub.run(id));
        this.db.prepare('DELETE FROM event_aliases WHERE event_id = ?').run(id);
        out.events += n(this.db.prepare('DELETE FROM events WHERE id = ?').run(id));
      }
      // Old articles of events still alive, unless the event is published (its sources stay readable).
      out.articles += n(this.db.prepare('DELETE FROM articles WHERE collected_at < ? AND event_id IN (SELECT id FROM events WHERE published IS NULL)').run(articlesBefore));
      this.db.prepare('DELETE FROM vectors WHERE article_id NOT IN (SELECT id FROM articles)').run();
      this.db.prepare('DELETE FROM handouts WHERE at < ?').run(articlesBefore);
      this.db.prepare('DELETE FROM http_cache WHERE fetched_at < ?').run(articlesBefore);
      this.setMeta('last_purge', now);
    });
    for (const id of doomed) rmSync(join(this.eventsDir, `${id}.json`), { force: true });
    if (out.articles || out.events) this.db.exec('VACUUM');
    return out;
  }

  articlesOf(eventId: string): Article[] {
    return (this.db.prepare('SELECT * FROM articles WHERE event_id = ? ORDER BY published_at').all(eventId) as Row[]).map(toArticle);
  }

  /** Events seen since [since], with their latest members (the clustering candidates). */
  recentEvents(since: string): { event: NewsEvent; members: Article[] }[] {
    const events = (this.db.prepare('SELECT * FROM events WHERE last_seen >= ?').all(since) as Row[]).map(toEvent);
    return events.map((event) => ({ event, members: (this.db.prepare('SELECT * FROM articles WHERE event_id = ? ORDER BY published_at DESC LIMIT 20').all(event.id) as Row[]).map(toArticle) }));
  }

  /** A stable id: derived from the first article of the event, never changed afterwards. */
  static eventIdFor(firstArticleId: string) { return `ev_${sha1(firstArticleId).slice(0, 12)}`; }

  /** An event by its id or by one of its aliases (an event merged into it). */
  getEvent(id: string): NewsEvent | undefined {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(this.resolve(id)) as Row | undefined;
    return row ? toEvent(row) : undefined;
  }

  allEvents(): NewsEvent[] { return (this.db.prepare('SELECT * FROM events ORDER BY last_seen DESC').all() as Row[]).map(toEvent); }

  saveEvent(e: NewsEvent) {
    this.db.prepare(`INSERT INTO events (id, title, category, language, sensitive, first_seen, last_seen, event_date, status, verification, article_count, outlets, published, promo, merged_from)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, category=excluded.category, language=excluded.language, sensitive=excluded.sensitive, first_seen=excluded.first_seen,
      last_seen=excluded.last_seen, event_date=excluded.event_date, status=excluded.status, verification=excluded.verification,
      article_count=excluded.article_count, outlets=excluded.outlets, published=excluded.published, promo=excluded.promo, merged_from=excluded.merged_from`).run(
      e.id, e.title, e.category, e.language, e.sensitive ? 1 : 0, e.firstSeen, e.lastSeen, e.eventDate, e.status, e.verification,
      e.articleCount, JSON.stringify(e.outlets), e.published ? JSON.stringify(e.published) : null, e.promo ? 1 : 0, e.mergedFrom?.length ? JSON.stringify(e.mergedFrom) : null);
  }

  setStatus(id: string, status: EventStatus) { this.db.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, id); }

  addPublication(p: Publication) {
    this.db.prepare('INSERT INTO publications (event_id, post_id, summary_version, text, status, verification, sources, recorded_at) VALUES (?,?,?,?,?,?,?,?)').run(
      p.eventId, p.postId, p.summaryVersion, p.text, p.status, p.verification, JSON.stringify(p.sources), p.recordedAt);
  }

  publicationsOf(eventId: string): Publication[] {
    return (this.db.prepare('SELECT * FROM publications WHERE event_id = ? ORDER BY seq').all(eventId) as Row[]).map((r) => ({
      eventId: String(r.event_id), postId: String(r.post_id), summaryVersion: Number(r.summary_version), text: String(r.text),
      status: r.status as PublicationStatus, verification: r.verification as Verification, sources: JSON.parse(String(r.sources)) as string[], recordedAt: String(r.recorded_at),
    }));
  }

  /** Publications of [statuses] recorded since [since] (ISO): what the hourly and daily caps count. */
  publicationsSince(since: string, statuses: PublicationStatus[]): number {
    const q = statuses.map(() => '?').join(',');
    return Number((this.db.prepare(`SELECT COUNT(*) n FROM publications WHERE recorded_at >= ? AND status IN (${q})`).get(since, ...statuses) as Row).n);
  }

  sourceState(sourceId: string): SourceState {
    const r = this.db.prepare('SELECT * FROM source_state WHERE source_id = ?').get(sourceId) as Row | undefined;
    return r ? {
      sourceId, etag: s(r.etag), lastModified: s(r.last_modified), lastFetchAt: s(r.last_fetch_at), lastStatus: s(r.last_status), lastCount: r.last_count === null ? undefined : Number(r.last_count),
      backoffUntil: s(r.backoff_until), consecutive429: r.consecutive_429 === null ? undefined : Number(r.consecutive_429), disabledUntil: s(r.disabled_until),
    } : { sourceId };
  }

  allSourceStates(): SourceState[] { return (this.db.prepare('SELECT source_id FROM source_state').all() as Row[]).map((r) => this.sourceState(String(r.source_id))); }

  saveSourceState(st: SourceState) {
    this.db.prepare(`INSERT INTO source_state (source_id, etag, last_modified, last_fetch_at, last_status, last_count, backoff_until, consecutive_429, disabled_until)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET etag=excluded.etag,
      last_modified=excluded.last_modified, last_fetch_at=excluded.last_fetch_at, last_status=excluded.last_status, last_count=excluded.last_count,
      backoff_until=excluded.backoff_until, consecutive_429=excluded.consecutive_429, disabled_until=excluded.disabled_until`).run(
      st.sourceId, st.etag ?? null, st.lastModified ?? null, st.lastFetchAt ?? null, st.lastStatus ?? null, st.lastCount ?? null,
      st.backoffUntil ?? null, st.consecutive429 ?? null, st.disabledUntil ?? null);
  }

  counts() {
    const one = (sql: string) => Number((this.db.prepare(sql).get() as Row).n);
    return { articles: one('SELECT COUNT(*) n FROM articles'), events: one('SELECT COUNT(*) n FROM events'), publications: one('SELECT COUNT(*) n FROM publications') };
  }

  /** Writes events/<id>.json: the event, its articles and its publication history. */
  writeEventFile(id: string) {
    const event = this.getEvent(id);
    if (!event) return;
    id = event.id;
    const body = { event, aliases: this.aliasesOf(event.id), articles: this.articlesOf(id).map(({ tokens: _t, entities: _e, ...a }) => a), publications: this.publicationsOf(id) };
    writeFileSync(join(this.eventsDir, `${id}.json`), `${JSON.stringify(body, null, 2)}\n`);
  }
}

function toArticle(r: Row): Article {
  return {
    id: String(r.id), url: String(r.url), title: String(r.title), outlet: String(r.outlet), group: String(r.grp), sourceId: String(r.source_id),
    language: String(r.language ?? ''), country: String(r.country ?? ''), publishedAt: String(r.published_at), collectedAt: String(r.collected_at),
    category: String(r.category), official: r.official === 1, tokens: JSON.parse(String(r.tokens)) as string[], entities: JSON.parse(String(r.entities)) as string[],
    ...(r.promo === 1 ? { promo: true } : {}),
  };
}

function toEvent(r: Row): NewsEvent {
  return {
    id: String(r.id), title: String(r.title), category: String(r.category), language: String(r.language), sensitive: r.sensitive === 1,
    firstSeen: String(r.first_seen), lastSeen: String(r.last_seen), eventDate: String(r.event_date), status: r.status as EventStatus,
    verification: r.verification as Verification, articleCount: Number(r.article_count), outlets: JSON.parse(String(r.outlets)) as string[],
    ...(r.promo === 1 ? { promo: true } : {}),
    ...(r.merged_from ? { mergedFrom: JSON.parse(String(r.merged_from)) as string[] } : {}),
    ...(r.published ? { published: JSON.parse(String(r.published)) as NewsEvent['published'] } : {}),
  };
}
