// Storage of a launch: SQLite (node:sqlite) in launches/<name>/data/news.db, plus one JSON file per
// event in launches/<name>/data/events/<id>.json (the event, its articles and every publication).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha1 } from './normalize.js';
import type { Article, EventStatus, NewsEvent, Publication, PublicationStatus, Verification } from './types.js';

export interface SourceState { sourceId: string; etag?: string; lastModified?: string; lastFetchAt?: string; lastStatus?: string; lastCount?: number }

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
`;

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
  }

  close() { this.db.close(); }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  hasArticle(id: string) { return !!this.db.prepare('SELECT 1 FROM articles WHERE id = ?').get(id); }

  insertArticle(a: Article, eventId: string) {
    this.db.prepare(`INSERT OR IGNORE INTO articles VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      a.id, a.url, a.title, a.outlet, a.group, a.sourceId, a.language, a.country, a.publishedAt, a.collectedAt, a.category, a.official ? 1 : 0,
      JSON.stringify(a.tokens), JSON.stringify(a.entities), eventId);
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

  getEvent(id: string): NewsEvent | undefined {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Row | undefined;
    return row ? toEvent(row) : undefined;
  }

  allEvents(): NewsEvent[] { return (this.db.prepare('SELECT * FROM events ORDER BY last_seen DESC').all() as Row[]).map(toEvent); }

  saveEvent(e: NewsEvent) {
    this.db.prepare(`INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, category=excluded.category, language=excluded.language, sensitive=excluded.sensitive, first_seen=excluded.first_seen,
      last_seen=excluded.last_seen, event_date=excluded.event_date, status=excluded.status, verification=excluded.verification,
      article_count=excluded.article_count, outlets=excluded.outlets, published=excluded.published`).run(
      e.id, e.title, e.category, e.language, e.sensitive ? 1 : 0, e.firstSeen, e.lastSeen, e.eventDate, e.status, e.verification,
      e.articleCount, JSON.stringify(e.outlets), e.published ? JSON.stringify(e.published) : null);
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

  sourceState(sourceId: string): SourceState {
    const r = this.db.prepare('SELECT * FROM source_state WHERE source_id = ?').get(sourceId) as Row | undefined;
    return r ? { sourceId, etag: s(r.etag), lastModified: s(r.last_modified), lastFetchAt: s(r.last_fetch_at), lastStatus: s(r.last_status), lastCount: r.last_count === null ? undefined : Number(r.last_count) } : { sourceId };
  }

  saveSourceState(st: SourceState) {
    this.db.prepare(`INSERT INTO source_state VALUES (?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET etag=excluded.etag,
      last_modified=excluded.last_modified, last_fetch_at=excluded.last_fetch_at, last_status=excluded.last_status, last_count=excluded.last_count`).run(
      st.sourceId, st.etag ?? null, st.lastModified ?? null, st.lastFetchAt ?? null, st.lastStatus ?? null, st.lastCount ?? null);
  }

  counts() {
    const one = (sql: string) => Number((this.db.prepare(sql).get() as Row).n);
    return { articles: one('SELECT COUNT(*) n FROM articles'), events: one('SELECT COUNT(*) n FROM events'), publications: one('SELECT COUNT(*) n FROM publications') };
  }

  /** Writes events/<id>.json: the event, its articles and its publication history. */
  writeEventFile(id: string) {
    const event = this.getEvent(id);
    if (!event) return;
    const body = { event, articles: this.articlesOf(id).map(({ tokens: _t, entities: _e, ...a }) => a), publications: this.publicationsOf(id) };
    writeFileSync(join(this.eventsDir, `${id}.json`), `${JSON.stringify(body, null, 2)}\n`);
  }
}

function toArticle(r: Row): Article {
  return {
    id: String(r.id), url: String(r.url), title: String(r.title), outlet: String(r.outlet), group: String(r.grp), sourceId: String(r.source_id),
    language: String(r.language ?? ''), country: String(r.country ?? ''), publishedAt: String(r.published_at), collectedAt: String(r.collected_at),
    category: String(r.category), official: r.official === 1, tokens: JSON.parse(String(r.tokens)) as string[], entities: JSON.parse(String(r.entities)) as string[],
  };
}

function toEvent(r: Row): NewsEvent {
  return {
    id: String(r.id), title: String(r.title), category: String(r.category), language: String(r.language), sensitive: r.sensitive === 1,
    firstSeen: String(r.first_seen), lastSeen: String(r.last_seen), eventDate: String(r.event_date), status: r.status as EventStatus,
    verification: r.verification as Verification, articleCount: Number(r.article_count), outlets: JSON.parse(String(r.outlets)) as string[],
    ...(r.published ? { published: JSON.parse(String(r.published)) as NewsEvent['published'] } : {}),
  };
}
