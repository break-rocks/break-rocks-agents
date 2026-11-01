// Title embeddings for the semantic backend. Three providers, chosen in config.yaml (clustering.embedding):
// - local: transformers.js with an ONNX model, an optional dependency loaded on demand (nothing to install
//   for the default lexical backend; `npm i @huggingface/transformers@4.3.1` for this one);
// - openai: any OpenAI-compatible POST <url>/embeddings (the key read from the env var apiKeyEnv);
// - ollama: POST <url>/api/embed.
import { embeddingSimilarity, lexicalSimilarity, type Similarity } from './cluster.js';
import type { EmbeddingSettings, LaunchConfig } from './types.js';

export interface Embedder {
  /** provider:model, stored with each vector so vectors of another model are never compared. */
  readonly model: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export type JsonPost = (url: string, body: unknown, headers: Record<string, string>) => Promise<{ status: number; json: () => Promise<unknown> }>;

const defaultPost: JsonPost = (url, body, headers) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });

const unit = (v: ArrayLike<number>): Float32Array => {
  const out = Float32Array.from(v);
  let n = 0;
  for (const x of out) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < out.length; i++) out[i]! /= n;
  return out;
};

async function batched(texts: string[], size: number, fn: (chunk: string[]) => Promise<Float32Array[]>): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += size) out.push(...await fn(texts.slice(i, i + size)));
  return out;
}

export function openAiEmbedder(s: EmbeddingSettings, post: JsonPost = defaultPost, env: NodeJS.ProcessEnv = process.env): Embedder {
  const base = (s.url ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const key = s.apiKeyEnv ? env[s.apiKeyEnv] : undefined;
  if (s.apiKeyEnv && !key) throw new Error(`clustering.embedding.apiKeyEnv: ${s.apiKeyEnv} is not set`);
  return {
    model: `openai:${s.model}`,
    embed: (texts) => batched(texts, s.batchSize, async (chunk) => {
      const res = await post(`${base}/embeddings`, { model: s.model, input: chunk.map((t) => (s.prefix ?? '') + t) }, key ? { Authorization: `Bearer ${key}` } : {});
      if (res.status >= 400) throw new Error(`embeddings endpoint: HTTP ${res.status}`);
      const body = await res.json() as { data?: { index: number; embedding: number[] }[] };
      return [...(body.data ?? [])].sort((a, b) => a.index - b.index).map((d) => unit(d.embedding));
    }),
  };
}

export function ollamaEmbedder(s: EmbeddingSettings, post: JsonPost = defaultPost): Embedder {
  const base = (s.url ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
  return {
    model: `ollama:${s.model}`,
    embed: (texts) => batched(texts, s.batchSize, async (chunk) => {
      const res = await post(`${base}/api/embed`, { model: s.model, input: chunk.map((t) => (s.prefix ?? '') + t) }, {});
      if (res.status >= 400) throw new Error(`ollama: HTTP ${res.status}`);
      const body = await res.json() as { embeddings?: number[][] };
      return (body.embeddings ?? []).map(unit);
    }),
  };
}

type Extractor = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist: () => number[][] }>;

/** transformers.js, imported only when this provider is chosen. The model is cached by transformers.js. */
export function localEmbedder(s: EmbeddingSettings, load?: (model: string) => Promise<Extractor>): Embedder {
  let extractor: Promise<Extractor> | undefined;
  const loader = load ?? (async (model: string) => {
    const name = '@huggingface/transformers';
    let mod: { pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<Extractor> };
    try { mod = await import(name) as typeof mod; } catch {
      throw new Error('clustering.backend embedding with provider local needs the optional dependency: npm i @huggingface/transformers@4.3.1 (in the kit folder)');
    }
    return mod.pipeline('feature-extraction', model, { dtype: 'q8' });
  });
  return {
    model: `local:${s.model}`,
    embed: (texts) => batched(texts, s.batchSize, async (chunk) => {
      extractor ??= loader(s.model);
      const out = await (await extractor)(chunk.map((t) => (s.prefix ?? '') + t), { pooling: 'mean', normalize: true });
      return out.tolist().map(unit);
    }),
  };
}

export function embedderFor(s: EmbeddingSettings, deps: { post?: JsonPost; load?: (model: string) => Promise<Extractor> } = {}): Embedder {
  if (s.provider === 'openai') return openAiEmbedder(s, deps.post);
  if (s.provider === 'ollama') return ollamaEmbedder(s, deps.post);
  return localEmbedder(s, deps.load);
}

/** The similarity of a launch, and its embedder when the backend is embedding. */
export function similarityFor(config: Pick<LaunchConfig, 'clustering'>, embedder?: Embedder): { similarity: Similarity; embedder?: Embedder } {
  const c = config.clustering;
  if (c.backend !== 'embedding' || !c.embedding) return { similarity: lexicalSimilarity };
  const e = embedder ?? embedderFor(c.embedding);
  return { similarity: embeddingSimilarity(e.model, { windowHours: c.windowHours }), embedder: e };
}

export const toBlob = (v: Float32Array) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
export const fromBlob = (b: Uint8Array) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
