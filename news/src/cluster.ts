// Grouping articles into events, without ML: title shingles + Jaccard, entity overlap, a time window.
// The Similarity interface is the plug for embeddings later (cosine of title vectors, same contract).

export interface Signature { tokens: string[]; entities: string[]; at: string }

export interface Similarity {
  readonly name: string;
  /** 0 (unrelated) to 1 (same story). */
  score(a: Signature, b: Signature): number;
}

/** Word unigrams plus bigrams of the normalised title: bigrams reward the same phrasing. */
export function shingles(tokens: string[]): Set<string> {
  const out = new Set(tokens);
  for (let i = 0; i + 1 < tokens.length; i++) out.add(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Overlap coefficient of the entity sets: |A∩B| / min(|A|,|B|). */
export function overlap<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size);
}

export const lexicalSimilarity: Similarity = {
  name: 'lexical-v1',
  score(a, b) {
    const sh = jaccard(shingles(a.tokens), shingles(b.tokens));
    const tok = jaccard(new Set(a.tokens), new Set(b.tokens));
    const ent = overlap(new Set(a.entities), new Set(b.entities));
    // Two shared entities are a strong hint (e.g. "ECB" + "Lagarde"); one alone ("Black Friday") is weak.
    const entInter = a.entities.filter((e) => b.entities.includes(e)).length;
    const entScore = entInter >= 2 ? ent : ent * 0.4;
    return Math.max(sh, 0.55 * tok + 0.45 * entScore);
  },
};

export interface Candidate { eventId: string; members: Signature[] }

/**
 * The best event for an article: highest score against any recent member, within the window and above
 * the threshold; undefined means "start a new event".
 */
export function assign(article: Signature, candidates: Candidate[], opts: { threshold: number; windowHours: number; similarity?: Similarity }): { eventId: string; score: number } | undefined {
  const sim = opts.similarity ?? lexicalSimilarity;
  const t = Date.parse(article.at);
  const windowMs = opts.windowHours * 3_600_000;
  let best: { eventId: string; score: number } | undefined;
  for (const c of candidates) {
    for (const m of c.members) {
      if (Math.abs(Date.parse(m.at) - t) > windowMs) continue;
      const score = sim.score(article, m);
      if (score >= opts.threshold && (!best || score > best.score)) best = { eventId: c.eventId, score };
    }
  }
  return best;
}
