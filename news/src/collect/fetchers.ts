// Fetching the sources politely (conditional GET, timeouts, one User-Agent) and parsing them into raw items.
import { XMLParser } from 'fast-xml-parser';
import { outletOf, type RawItem } from '../normalize.js';
import type { SourceState } from '../store.js';
import type { Source } from '../types.js';

export interface FetchResult { status: number; notModified: boolean; body?: string; etag?: string; lastModified?: string; retryAfter?: string }

export type Fetcher = (url: string, headers: Record<string, string>) => Promise<{ status: number; headers: Headers; arrayBuffer: () => Promise<ArrayBuffer> }>;

/** Decodes a body with the charset of Content-Type, else of the XML declaration, else UTF-8. */
export function decodeBody(buf: ArrayBuffer, contentType: string | null): string {
  const head = new TextDecoder('latin1').decode(buf.slice(0, 200));
  const charset = /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1] ?? /<\?xml[^>]*encoding=["']([\w-]+)/i.exec(head)?.[1] ?? 'utf-8';
  try { return new TextDecoder(charset.toLowerCase()).decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}

const defaultFetcher: Fetcher = (url, headers) => fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(20_000) });

export async function conditionalGet(url: string, state: SourceState, userAgent: string, fetcher: Fetcher = defaultFetcher): Promise<FetchResult> {
  const headers: Record<string, string> = { 'User-Agent': userAgent, Accept: 'application/rss+xml, application/atom+xml, application/xml, application/json;q=0.9, */*;q=0.5' };
  if (state.etag) headers['If-None-Match'] = state.etag;
  if (state.lastModified) headers['If-Modified-Since'] = state.lastModified;
  const res = await fetcher(url, headers);
  if (res.status === 304) return { status: 304, notModified: true, etag: state.etag, lastModified: state.lastModified };
  if (res.status >= 400) return { status: res.status, notModified: false, retryAfter: res.headers.get('retry-after') ?? undefined };
  return { status: res.status, notModified: false, body: decodeBody(await res.arrayBuffer(), res.headers.get('content-type')), etag: res.headers.get('etag') ?? undefined, lastModified: res.headers.get('last-modified') ?? undefined };
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', textNodeName: '#text', processEntities: true, htmlEntities: true });

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const text = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object' && '#text' in (v as object)) return String((v as Record<string, unknown>)['#text']);
  return '';
};

/** RSS 2.0, RSS 1.0 (RDF) and Atom. */
export function parseFeed(body: string): RawItem[] {
  const doc = xml.parse(body) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (doc.rss) {
    return arr(doc.rss.channel?.item).map((i: Record<string, unknown>) => ({
      url: text(i.link) || text(i.guid), title: text(i.title), publishedAt: text(i.pubDate) || text(i['dc:date']) || undefined,
    }));
  }
  const rdf = doc['rdf:RDF'];
  if (rdf) return arr(rdf.item).map((i: Record<string, unknown>) => ({ url: text(i.link), title: text(i.title), publishedAt: text(i['dc:date']) || undefined }));
  if (doc.feed) {
    return arr(doc.feed.entry).map((e: Record<string, any>) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const links = arr(e.link) as Record<string, string>[];
      const link = links.find((l) => !l['@rel'] || l['@rel'] === 'alternate') ?? links[0];
      return { url: link?.['@href'] ?? text(e.id), title: text(e.title), publishedAt: text(e.published) || text(e.updated) || undefined };
    });
  }
  return [];
}

const GDELT_LANG: Record<string, string> = {
  english: 'en', french: 'fr', german: 'de', spanish: 'es', italian: 'it', portuguese: 'pt', dutch: 'nl', japanese: 'ja', chinese: 'zh', arabic: 'ar',
  russian: 'ru', korean: 'ko', polish: 'pl', turkish: 'tr', hindi: 'hi', indonesian: 'id', swedish: 'sv',
};

/** The GDELT DOC 2.0 API (no key): the URL for a source, and its artlist JSON. */
export function gdeltUrl(source: Source): string {
  const u = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
  u.searchParams.set('query', source.query ?? '');
  u.searchParams.set('mode', 'artlist');
  u.searchParams.set('format', 'json');
  u.searchParams.set('maxrecords', '75');
  u.searchParams.set('timespan', '1d');
  u.searchParams.set('sort', 'datedesc');
  return u.toString();
}

/** GDELT sometimes answers its rate limit with a 200 and a plain-text message instead of a 429. */
export const isGdeltRateLimit = (body: string) => !body.trimStart().startsWith('{') && /limit requests|too many requests|rate limit/i.test(body.slice(0, 500));

export function parseGdelt(body: string): RawItem[] {
  let doc: { articles?: { url: string; title: string; seendate?: string; domain?: string; language?: string; sourcecountry?: string }[] };
  try { doc = JSON.parse(body); } catch { return []; } // GDELT answers rate limits in plain text
  return (doc.articles ?? []).map((a) => {
    const d = a.seendate && /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(a.seendate);
    return {
      url: a.url, title: a.title, outlet: a.domain ?? outletOf(a.url),
      publishedAt: d ? `${d[1]}-${d[2]}-${d[3]}T${d[4]}:${d[5]}:${d[6]}Z` : undefined,
      language: a.language ? GDELT_LANG[a.language.toLowerCase()] : undefined,
      country: a.sourcecountry || undefined,
    };
  });
}

/** Hacker News through the Algolia search API (no key): the linked articles, outlet = their domain. */
export function parseHackerNews(body: string): RawItem[] {
  const doc = JSON.parse(body) as { hits?: { url?: string; title?: string; created_at?: string; objectID: string }[] };
  return (doc.hits ?? []).filter((h) => h.url && h.title).map((h) => ({ url: h.url!, title: h.title!, outlet: outletOf(h.url!), publishedAt: h.created_at }));
}

export function itemsOf(source: Source, body: string): RawItem[] {
  if (source.type === 'gdelt') return parseGdelt(body);
  if (source.type === 'hackernews') return parseHackerNews(body);
  return parseFeed(body);
}

export const requestUrl = (source: Source) => (source.type === 'gdelt' ? gdeltUrl(source) : source.url);
