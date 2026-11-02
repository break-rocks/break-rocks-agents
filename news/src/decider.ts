// Optional decision model (D-252, pilot): AWS's Strands Decider 2B served locally by Ollama
// (`ollama pull strands-decider`, Ollama >= 0.40 on Apple silicon). It answers true/false questions with a
// probability (POST <url>/v1/systemone, question type `noul`), no text. Used beside the current methods:
// it confirms or rejects the merges the clustering proposes, and the promo verdict of an article. It acts
// only when sure (p >= high or p <= low); in between, the current method's answer stands. Unavailable
// (Ollama down, model not pulled): one warning, then the current methods alone.
import type { DeciderSettings } from './types.js';
import type { JsonPost } from './embed.js';

export const DECIDER_DEFAULTS: DeciderSettings = { enabled: false, url: 'http://127.0.0.1:11434', model: 'strands-decider', high: 0.8, low: 0.2, merges: true, promo: false, timeoutMs: 20_000 };

const SAME_EVENT = 'Are these two news headlines about the same specific news event (the same happening, not merely the same topic, company, person or place)?';
const PROMO = 'Is this article a promotion, a deal, a discount, a coupon, a shopping recommendation or an advertisement, rather than news?';

export interface Decider {
  readonly model: string;
  /** Probability that the two headlines report the same event; undefined when the model is unavailable. */
  sameEvent(a: string, b: string): Promise<number | undefined>;
  /** Probability that the article is promotional; undefined when the model is unavailable. */
  promotional(title: string, url: string): Promise<number | undefined>;
}

/** The hybrid rule: the model decides when sure, else the current answer stands. */
export const hybrid = (current: boolean, p: number | undefined, s: Pick<DeciderSettings, 'high' | 'low'>) =>
  p === undefined ? current : p >= s.high ? true : p <= s.low ? false : current;

const clip = (s: string, n = 600) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function ollamaDecider(settings: Partial<DeciderSettings> = {}, opts: { post?: JsonPost; warn?: (m: string) => void } = {}): Decider {
  const s = { ...DECIDER_DEFAULTS, ...settings };
  const base = s.url.replace(/\/$/, '');
  const post: JsonPost = opts.post ?? ((url, body, headers) =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(s.timeoutMs) }));
  const warn = opts.warn ?? ((m: string) => console.error(m));
  let down = false;
  const ask = async (state: string, instructions: string): Promise<number | undefined> => {
    if (down) return undefined;
    try {
      const res = await post(`${base}/v1/systemone`, { model: s.model, state, questions: { q: { type: 'noul', instructions, criteria: {} } } }, {});
      if (res.status >= 400) throw new Error(`HTTP ${res.status}${res.status === 404 ? ` (is the model pulled? ollama pull ${s.model})` : ''}`);
      const body = await res.json() as { answers?: { q?: { noul?: unknown } } };
      const p = body.answers?.q?.noul;
      if (typeof p !== 'number' || !Number.isFinite(p)) throw new Error('no probability in the answer');
      return Math.min(1, Math.max(0, p));
    } catch (e) {
      // Warned once; the rest of the run uses the current methods.
      down = true;
      warn(`decider unavailable (${(e as Error).message}): using the current methods`);
      return undefined;
    }
  };
  return {
    model: `ollama:${s.model}`,
    sameEvent: (a, b) => ask(`Headline A: ${clip(a)}\nHeadline B: ${clip(b)}`, SAME_EVENT),
    promotional: (title, url) => ask(`Headline: ${clip(title)}\nURL: ${clip(url, 300)}`, PROMO),
  };
}
