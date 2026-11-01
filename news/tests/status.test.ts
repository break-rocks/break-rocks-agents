import { describe, expect, it } from 'vitest';
import { materialChange, readiness, verificationOf } from '../src/status.js';
import type { NewsEvent } from '../src/types.js';

const config = { verification: { minOutlets: 2, sensitiveCategories: ['crime_justice', 'politics'], publishUnconfirmed: true } };
const ev = (over: Partial<NewsEvent> = {}): NewsEvent => ({
  id: 'ev_1', title: 'La BCE relève ses taux', category: 'economy', language: 'fr', sensitive: false, firstSeen: '', lastSeen: '', eventDate: '',
  status: 'open', verification: 'to_confirm', articleCount: 1, outlets: ['Le Monde'], ...over,
});

describe('verification status', () => {
  it('to_confirm with one source, corroborated with two independent groups', () => {
    expect(verificationOf([{ group: 'A', official: false }], 2)).toBe('to_confirm');
    expect(verificationOf([{ group: 'A', official: false }, { group: 'A', official: false }], 2)).toBe('to_confirm');
    expect(verificationOf([{ group: 'A', official: false }, { group: 'B', official: false }], 2)).toBe('corroborated');
  });
  it('one official source corroborates', () => {
    expect(verificationOf([{ group: 'ECB', official: true }], 2)).toBe('corroborated');
  });
});

describe('readiness', () => {
  it('a single-source economy event is ready (to_confirm)', () => {
    expect(readiness(ev(), config).kind).toBe('new');
    expect(readiness(ev(), { verification: { ...config.verification, publishUnconfirmed: false } }).kind).toBe('wait');
  });
  it('a sensitive event waits for corroboration', () => {
    expect(readiness(ev({ category: 'crime_justice', sensitive: true }), config).kind).toBe('wait');
    expect(readiness(ev({ category: 'politics', sensitive: true, verification: 'corroborated', outlets: ['A', 'B'] }), config).kind).toBe('new');
  });
  it('skipped and needs_review are never pending', () => {
    expect(readiness(ev({ status: 'skipped' }), config).kind).toBe('none');
    expect(readiness(ev({ status: 'needs_review' }), config).kind).toBe('none');
  });
  it('a published event needs an update on new sources or verification change', () => {
    const published = { postId: 'p1', summaryVersion: 1, outlets: ['Le Monde'], verification: 'to_confirm' as const, title: 'La BCE relève ses taux', at: '' };
    expect(readiness(ev({ status: 'published', published }), config).kind).toBe('none');
    const r = readiness(ev({ status: 'published', published, outlets: ['Le Monde', 'Les Echos'], verification: 'corroborated' }), config);
    expect(r.kind).toBe('update');
    expect(r.reasons).toHaveLength(2);
  });
  it('detects a material headline change', () => {
    expect(materialChange('La BCE relève ses taux', 'La BCE relève ses taux directeurs')).toBe(false);
    expect(materialChange('La BCE relève ses taux', 'Démission surprise du gouverneur')).toBe(true);
  });
});
