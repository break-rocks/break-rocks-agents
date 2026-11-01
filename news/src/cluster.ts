// Grouping articles into events. Default backend, without ML: title shingles + Jaccard, entity overlap,
// a time window. Embedding backend (src/embed.ts): cosine of multilingual title vectors, combined with
// the entity overlap and the time distance, behind the same Similarity contract.

export interface Signature { tokens: string[]; entities: string[]; at: string; vector?: Float32Array }

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
    // Two shared entities are a strong hint (e.g. "ECB" + "Lagarde"); one alone ("Black Friday") is weak.
    return Math.max(sh, 0.55 * tok + 0.45 * entityScore(a, b));
  },
};

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Shared entities, 0 to 1: two shared entities count fully, one alone counts for less. */
export function entityScore(a: Signature, b: Signature): number {
  const ent = overlap(new Set(a.entities), new Set(b.entities));
  const inter = a.entities.filter((e) => b.entities.includes(e)).length;
  return inter >= 2 ? ent : ent * 0.4;
}

/**
 * Semantic similarity: the cosine of the title vectors (a paraphrase or a translation scores high), plus
 * a bonus for shared entities, minus a small penalty for the time distance. Without vectors on both
 * sides it falls back to the lexical score. [name] carries the model, so the vectors stay comparable.
 */
export function embeddingSimilarity(model: string, opts: { windowHours?: number; entityWeight?: number; timePenalty?: number } = {}): Similarity & { model: string } {
  const windowMs = (opts.windowHours ?? 48) * 3_600_000;
  const we = opts.entityWeight ?? 0.15, wt = opts.timePenalty ?? 0.05;
  return {
    name: `embedding:${model}`, model,
    score(a, b) {
      if (!a.vector || !b.vector || a.vector.length !== b.vector.length) return lexicalSimilarity.score(a, b);
      const cos = cosine(a.vector, b.vector);
      const dt = Math.min(1, Math.abs(Date.parse(a.at) - Date.parse(b.at)) / windowMs);
      const s = cos + we * entityScore(a, b) - wt * dt;
      // The same phrasing stays a strong hint whatever the model says.
      return Math.max(Math.min(1, s), jaccard(shingles(a.tokens), shingles(b.tokens)));
    },
  };
}

export interface Candidate { eventId: string; members: Signature[] }

/**
 * The best event for an article: highest score against any recent member, within the window and above
 * the threshold; undefined means "start a new event".
 */
export function assign(article: Signature, candidates: Candidate[], opts: { threshold: number; windowHours: number; similarity?: Similarity }): { eventId: string; score: number } | undefined {
  return matches(article, candidates, opts)[0];
}

/** Every event the article matches (best score per event, above the threshold), best first. */
export function matches(article: Signature, candidates: Candidate[], opts: { threshold: number; windowHours: number; similarity?: Similarity }): { eventId: string; score: number }[] {
  const sim = opts.similarity ?? lexicalSimilarity;
  const t = Date.parse(article.at);
  const windowMs = opts.windowHours * 3_600_000;
  const out: { eventId: string; score: number }[] = [];
  for (const c of candidates) {
    let best = -1;
    for (const m of c.members) {
      if (Math.abs(Date.parse(m.at) - t) > windowMs) continue;
      best = Math.max(best, sim.score(article, m));
    }
    if (best >= opts.threshold) out.push({ eventId: c.eventId, score: best });
  }
  return out.sort((a, b) => b.score - a.score);
}
