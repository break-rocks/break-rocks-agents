import { describe, expect, it } from 'vitest';
import { decodeBody, parseFeed, parseGdelt, parseHackerNews } from '../src/collect/fetchers.js';
import { canonicalUrl } from '../src/normalize.js';

describe('parsers', () => {
  it('RSS 2.0, Atom and RDF', () => {
    expect(parseFeed('<rss><channel><item><title>T &amp; U</title><link>https://a.fr/1</link><pubDate>Sun, 01 Nov 2026 08:00:00 GMT</pubDate></item></channel></rss>'))
      .toEqual([{ url: 'https://a.fr/1', title: 'T & U', publishedAt: 'Sun, 01 Nov 2026 08:00:00 GMT' }]);
    expect(parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>A</title><link rel="alternate" href="https://b.fr/2"/><updated>2026-11-01T08:00:00Z</updated></entry></feed>'))
      .toEqual([{ url: 'https://b.fr/2', title: 'A', publishedAt: '2026-11-01T08:00:00Z' }]);
    expect(parseFeed('<rdf:RDF><item><title>R</title><link>https://c.fr/3</link><dc:date>2026-11-01</dc:date></item></rdf:RDF>')[0]?.url).toBe('https://c.fr/3');
  });
  it('GDELT and Hacker News', () => {
    expect(parseGdelt(JSON.stringify({ articles: [{ url: 'https://d.de/x', title: 'EZB', seendate: '20261101T080000Z', domain: 'd.de', language: 'German', sourcecountry: 'Germany' }] })))
      .toEqual([{ url: 'https://d.de/x', title: 'EZB', outlet: 'd.de', publishedAt: '2026-11-01T08:00:00Z', language: 'de', country: 'Germany' }]);
    expect(parseGdelt('Please limit requests')).toEqual([]);
    expect(parseHackerNews(JSON.stringify({ hits: [{ objectID: '1', url: 'https://www.e.com/p', title: 'Show HN', created_at: '2026-11-01T08:00:00Z' }, { objectID: '2', title: 'Ask HN' }] })))
      .toEqual([{ url: 'https://www.e.com/p', title: 'Show HN', outlet: 'e.com', publishedAt: '2026-11-01T08:00:00Z' }]);
  });
  it('decodes ISO-8859-1 feeds', () => {
    const latin = new Uint8Array([...new TextEncoder().encode('<?xml version="1.0" encoding="ISO-8859-1"?><t>'), 0xe9, ...new TextEncoder().encode('</t>')]);
    expect(decodeBody(latin.buffer, 'text/xml')).toContain('<t>é</t>');
    expect(decodeBody(new TextEncoder().encode('é').buffer as ArrayBuffer, 'text/xml; charset=UTF-8')).toBe('é');
  });
  it('canonical URLs drop tracking and fragments', () => {
    expect(canonicalUrl('http://www.Le-Monde.fr/a/?utm_source=rss&id=3#top')).toBe('https://le-monde.fr/a?id=3');
  });
});
