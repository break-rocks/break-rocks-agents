// Article normalisation: canonical URL, stable id, title tokens and entities, category.
import { createHash } from 'node:crypto';
import type { Article, Source } from './types.js';

const TRACKING = /^(utm_|fbclid$|gclid$|mc_|xtor$|at_|ns_|ocid$|cmpid$|_ga$|ref$|src$)/i;

export function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    if (u.protocol === 'http:') u.protocol = 'https:';
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return raw.trim();
  }
}

export const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
export const articleId = (url: string) => `a_${sha1(canonicalUrl(url)).slice(0, 16)}`;

// Small multilingual stop-word list (en, fr, de, es, it, pt, nl): enough for title shingles.
const STOP = new Set(`a an the of to in on for and or but is are was were be been at by with from as it its this that these those
not no new says say said after over into up out about more than how why what who when will can could would has have had
le la les un une des du de d l et ou mais est sont a au aux en dans sur pour par avec sans ce cette ces qui que quoi dont
ne pas plus se sa son ses leur leurs il elle ils elles on nous vous y comme selon après avant face vers chez entre
der die das ein eine und oder ist sind im in am an auf für mit von zu zum zur den dem des nicht auch wie nach bei aus
el la los las un una y o es son en de del al por para con sin que se su sus como más tras ante
il lo gli le un una e o è sono di da in con per su tra fra che del della dei delle al alla nel nella
o a os as um uma e ou é são de do da dos das em no na nos nas por para com sem que se seu sua
de het een en of is zijn in op voor met van te dat die niet ook`.split(/\s+/));

/** Lower-case, accent-free word tokens of a title, stop words and 1-letter words removed. */
export function tokenize(title: string): string[] {
  return title
    .normalize('NFKD').replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’`]/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Rubric labels some outlets put before the headline ("Actualité :", "Bon plan :"), removed before grouping. */
const LABEL = /^\s*(actualit[ée]|top bon plan|bon plans?|test|vid[ée]o|live|direct|en direct|exclusif|info|breaking|update|analyse|opinion|tribune|podcast|interview|guide|comparatif)\s*[:|-]\s*/iu;
export const stripLabel = (title: string) => title.replace(LABEL, '');

/**
 * Named-entity guess without ML: runs of consecutive capitalised words (not the headline's first word,
 * unless an acronym), normalised like tokens; "Black Friday" is one entity, "Christine Lagarde" another.
 */
export function entities(title: string): string[] {
  const words = stripLabel(title).replace(/['’`]/g, ' ').split(/[^\p{L}\p{N}-]+/u).filter(Boolean);
  const out = new Set<string>();
  let run: string[] = [];
  const flush = () => {
    const t = run.map((w) => tokenize(w).join('')).filter((w) => w.length > 1 && !STOP.has(w)).join(' ');
    if (t) out.add(t);
    run = [];
  };
  words.forEach((w, i) => {
    const acronym = /^\p{Lu}{2,}\d*$/u.test(w);
    if (acronym || (i > 0 && /^\p{Lu}/u.test(w))) run.push(w);
    else flush();
  });
  flush();
  return [...out];
}

const DEFAULT_KEYWORDS: Record<string, string[]> = {
  crime_justice: ['accused', 'accuses', 'accuse', 'accusé', 'accusée', 'arrested', 'arrest', 'murder', 'killed', 'police', 'trial', 'charged', 'convicted', 'suspect', 'court', 'lawsuit',
    'interpellé', 'garde à vue', 'meurtre', 'procès', 'condamné', 'mis en examen', 'suspect', 'tribunal', 'plainte', 'enquête',
    'festgenommen', 'mord', 'prozess', 'detenido', 'asesinato', 'juicio', 'arrestato', 'omicidio', 'processo', 'preso', 'julgamento'],
};

export function categorize(title: string, fallback: string, extra?: Record<string, string[]>): string {
  const t = ` ${title.toLowerCase()} `;
  const table = { ...DEFAULT_KEYWORDS, ...(extra ?? {}) };
  for (const [category, words] of Object.entries(table)) {
    if (words.some((w) => new RegExp(`(^|[^\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}]|$)`, 'iu').test(t))) return category;
  }
  return fallback;
}

export const outletOf = (url: string) => {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return 'unknown'; }
};

export function decodeEntities(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;|&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

export interface RawItem { url: string; title: string; publishedAt?: string; outlet?: string; language?: string; country?: string }

export function normalizeItem(item: RawItem, source: Source, collectedAt: string, keywords?: Record<string, string[]>): Article | undefined {
  const title = decodeEntities(item.title ?? '');
  if (!item.url || !title) return undefined;
  const url = canonicalUrl(item.url);
  const published = item.publishedAt ? new Date(item.publishedAt) : undefined;
  const outlet = item.outlet ?? source.name;
  return {
    id: articleId(url), url, title, outlet,
    group: source.type === 'rss' ? (source.group ?? source.name) : outlet,
    sourceId: source.id,
    language: item.language ?? source.language,
    country: item.country ?? source.country,
    publishedAt: published && !Number.isNaN(published.getTime()) ? published.toISOString() : collectedAt,
    collectedAt,
    category: categorize(title, source.category, keywords),
    official: !!source.official,
    tokens: tokenize(stripLabel(title)),
    entities: entities(title),
  };
}
