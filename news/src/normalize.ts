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

// ---- promotions and deals ----

/** Deal words and phrases in en, fr, de, es, it, pt, nl (whole words, lower case, accents removed). */
const PROMO_PHRASES = ['bon plan', 'bons plans', 'code promo', 'codes promo', 'prix casse', 'prix sacrifie', 'vente flash', 'moins cher', 'prix en baisse', 'au meilleur prix',
  'offre speciale', 'chute de prix', 'best price', 'lowest price', 'price drop', 'price cut', 'on sale', 'flash sale', 'promo code', 'promo codes', 'prezzo piu basso',
  'black friday deal', 'prime day deal', 'cyber monday deal', 'deal of the day', 'good deal'];
const PROMO_SINGLE = new Set(['deals', 'bargain', 'bargains', 'coupons', 'discount', 'discounted', 'voucher', 'vouchers', 'soldes', 'reduction', 'remise', 'promos',
  'angebot', 'angebote', 'rabatt', 'gutschein', 'schnappchen', 'preissturz', 'bestpreis', 'descuento', 'descuentos', 'chollo', 'chollos', 'rebaja', 'rebajas', 'cupon',
  'sconto', 'sconti', 'promocao', 'promocoes', 'desconto', 'descontos', 'cupom', 'aanbieding', 'aanbiedingen', 'korting', 'kortingscode',
  'oferta', 'ofertas', 'offerta', 'offerte', 'promo', 'coupon', 'deal']);
/** Words that are deal words alone only in titles: "promo", "offerta", "oferta" also mean news ("a public offer"). */
const WEAK = new Set(['oferta', 'ofertas', 'offerta', 'offerte', 'promo', 'promos', 'coupon', 'deal', 'reduction', 'remise', 'angebot', 'discount']);

const PRICE = /(\d[\d\s.,]*\s?(€|\$|£|eur|euros?|usd|chf)(?![\p{L}])|[€$£]\s?\d)/iu;
const DISCOUNT = /(-\s?\d{1,2}\s?%|\d{1,2}\s?%\s?(off|de r[ée]duction|de remise|rabatt|de descuento|di sconto)|au lieu de|instead of|statt|en lugar de|invece di|was \$|ab \d+[,.]?\d*\s?€)/iu;
const AFFILIATE_PARAMS = /^(tag|affid|aff_id|affiliate|affiliate_id|aff|awc|clickref|irclickid|cjevent|ranmid|ranEAID|ascsubtag|subid|sub_id|campid|mkevt|partnerid|zanpid|utm_medium)$/i;
const AFFILIATE_HOSTS = /(^|\.)(amzn\.to|amzn\.eu|tidd\.ly|awin1\.com|prf\.hn|go\.skimresources\.com|click\.linksynergy\.com|anrdoezrs\.net|dpbolvw\.net|shareasale\.com|ebay\.us|bit\.ly\/deal)$/i;
const PROMO_PATHS = /\/(bons?-plans?|deals?|promos?|soldes|codes?-promo|angebote|ofertas|offerte|shopping|coupons?)(\/|-|$)/i;

export interface PromoVerdict { promo: boolean; reasons: string[] }

/**
 * A promotion or a deal rather than news: deal words, a price with a discount, an affiliate link, a deal
 * section of the site, or a source whose category is a deal one. Two weak hints are needed for a word
 * that also means news; one strong hint is enough.
 */
export function promoVerdict(title: string, rawUrl: string, sourceCategory = '', promoCategories: string[] = ['deals', 'promo', 'shopping', 'bons-plans']): PromoVerdict {
  const reasons: string[] = [];
  const t = ` ${title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/['’`]/g, ' ')} `;
  const words = new Set(t.split(/[^\p{L}\p{N}%]+/u).filter(Boolean));
  const phrase = PROMO_PHRASES.find((p) => t.includes(` ${p} `) || t.includes(` ${p}:`) || t.includes(` ${p},`));
  if (phrase) reasons.push(`words: ${phrase}`);
  const strong = [...words].find((w) => PROMO_SINGLE.has(w) && !WEAK.has(w));
  if (strong) reasons.push(`word: ${strong}`);
  const weak = [...words].find((w) => WEAK.has(w));
  const price = PRICE.test(title), discount = DISCOUNT.test(title);
  if (price && discount) reasons.push('price with a discount');
  else if (discount && /%/.test(title) && (weak || strong)) reasons.push('discount');
  let url: URL | undefined;
  try { url = new URL(rawUrl); } catch { /* not a URL */ }
  if (url) {
    const params = [...url.searchParams.keys()].filter((k) => AFFILIATE_PARAMS.test(k) && !(k.toLowerCase() === 'utm_medium' && !/affil|partner/i.test(url!.searchParams.get(k) ?? '')));
    if (params.length) reasons.push(`affiliate link: ${params.join(', ')}`);
    if (AFFILIATE_HOSTS.test(url.hostname)) reasons.push(`affiliate host: ${url.hostname}`);
    if (PROMO_PATHS.test(url.pathname)) reasons.push('deal section of the site');
  }
  if (promoCategories.includes(sourceCategory)) reasons.push(`source category: ${sourceCategory}`);
  if (weak && !reasons.length && price) reasons.push(`word: ${weak} with a price`);
  return { promo: reasons.length > 0, reasons };
}

export interface RawItem { url: string; title: string; publishedAt?: string; outlet?: string; language?: string; country?: string }

export function normalizeItem(item: RawItem, source: Source, collectedAt: string, keywords?: Record<string, string[]>, promoCategories?: string[]): Article | undefined {
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
    promo: promoVerdict(title, item.url, source.category, promoCategories).promo,
  };
}
