import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collect, eventDetail, ingest, markEvent, openStore, pendingEvents, recordPublication } from '../src/service.js';
import { Store } from '../src/store.js';
import { art, source, tmpLaunch } from './helpers.js';

describe('store and event life cycle', () => {
  it('groups articles into events with stable ids, persists SQLite and events/<id>.json', () => {
    const launch = tmpLaunch();
    const store = openStore(launch);
    const a1 = art('La BCE relève ses taux directeurs de 25 points', 'https://lemonde.fr/a?utm_source=x', { id: 'lemonde', name: 'Le Monde' });
    const r1 = ingest(store, launch, [a1, art('Apple présente un iPhone pliable', 'https://lemonde.fr/b', { id: 'lemonde', name: 'Le Monde', category: 'tech' })]);
    expect(r1).toMatchObject({ added: 2, newEvents: 2 });
    const id = Store.eventIdFor(a1.id);
    expect(store.getEvent(id)?.verification).toBe('to_confirm');
    expect(a1.url).toBe('https://lemonde.fr/a');

    // The same story from another outlet joins the event; the id does not change; duplicates are ignored.
    const r2 = ingest(store, launch, [a1, art('BCE : les taux directeurs relevés de 25 points', 'https://lesechos.fr/c', { id: 'echos', name: 'Les Echos' }, '2026-11-01T10:00:00Z')]);
    expect(r2).toMatchObject({ added: 1, newEvents: 0 });
    const e = store.getEvent(id)!;
    expect(e).toMatchObject({ verification: 'corroborated', articleCount: 2, outlets: ['Le Monde', 'Les Echos'] });
    const file = JSON.parse(readFileSync(join(launch.dir, 'data', 'events', `${id}.json`), 'utf8'));
    expect(file.articles).toHaveLength(2);
    store.close();

    const pending = pendingEvents(launch);
    expect(pending.map((p) => p.kind)).toEqual(['new', 'new']);
    expect(pending.find((p) => p.category === 'tech')?.universes).toEqual(['%tech']);
  });

  it('records publications, then asks for an update when new sources arrive; keeps the history', () => {
    const launch = tmpLaunch();
    const store = openStore(launch);
    const a1 = art('Eurostat : inflation de la zone euro à 2,1 % en octobre', 'https://lemonde.fr/i', { id: 'lemonde', name: 'Le Monde' });
    ingest(store, launch, [a1]);
    store.close();
    const id = Store.eventIdFor(a1.id);
    recordPublication(launch, { eventId: id, postId: 'post-1', summaryVersion: 1, text: 'v1', status: 'published' });
    expect(pendingEvents(launch)).toHaveLength(0);

    const s2 = openStore(launch);
    ingest(s2, launch, [art('Inflation zone euro : 2,1 % en octobre selon Eurostat', 'https://lefigaro.fr/i', { id: 'figaro', name: 'Le Figaro' }, '2026-11-01T11:00:00Z')]);
    s2.close();
    const [p] = pendingEvents(launch);
    expect(p).toMatchObject({ id, kind: 'update', verification: 'corroborated' });

    recordPublication(launch, { eventId: id, postId: 'reply-1', summaryVersion: 2, text: 'v2', status: 'update_reply' });
    const d = eventDetail(launch, id);
    expect(d.publications.map((x) => [x.summaryVersion, x.status, x.verification])).toEqual([[1, 'published', 'to_confirm'], [2, 'update_reply', 'corroborated']]);
    expect(d.event.published?.postId).toBe('post-1');
    expect(pendingEvents(launch)).toHaveLength(0);
  });

  it('a crime event waits for corroboration; mark_event removes it from pending', () => {
    const launch = tmpLaunch();
    const store = openStore(launch);
    const a = art('Un suspect interpellé après le braquage à Lyon', 'https://x.fr/1', { id: 'x', name: 'X' });
    const b = art('Grève des contrôleurs aériens ce week-end', 'https://x.fr/2', { id: 'x', name: 'X' });
    ingest(store, launch, [a, b]);
    store.close();
    expect(eventDetail(launch, Store.eventIdFor(a.id)).event).toMatchObject({ category: 'crime_justice', sensitive: true });
    expect(pendingEvents(launch).map((p) => p.id)).toEqual([Store.eventIdFor(b.id)]);
    markEvent(launch, Store.eventIdFor(b.id), 'skipped');
    expect(pendingEvents(launch)).toHaveLength(0);
  });

  it('collect is polite: conditional GET with ETag, frequency respected', async () => {
    const launch = tmpLaunch({}, [source({ id: 'feed', name: 'Feed' })]);
    const seen: Record<string, string>[] = [];
    const rss = `<?xml version="1.0"?><rss><channel><item><title>La BCE relève ses taux</title><link>https://feed.fr/1</link><pubDate>Sun, 01 Nov 2026 08:00:00 GMT</pubDate></item></channel></rss>`;
    const fetcher = async (_url: string, headers: Record<string, string>) => {
      seen.push(headers);
      return headers['If-None-Match'] === '"v1"'
        ? { status: 304, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) }
        : { status: 200, headers: new Headers({ etag: '"v1"' }), arrayBuffer: async () => new TextEncoder().encode(rss).buffer as ArrayBuffer };
    };
    const now = new Date('2026-11-01T09:00:00Z');
    const r1 = await collect(launch, { fetcher, now });
    expect(r1.articles).toEqual({ seen: 1, added: 1, promo: 0 });
    const r2 = await collect(launch, { fetcher, now: new Date('2026-11-01T09:10:00Z') });
    expect(r2.sources.notDue).toBe(1);
    const r3 = await collect(launch, { fetcher, now: new Date('2026-11-01T10:30:00Z') });
    expect(r3.sources.notModified).toBe(1);
    expect(seen.at(-1)?.['If-None-Match']).toBe('"v1"');
  });
});
