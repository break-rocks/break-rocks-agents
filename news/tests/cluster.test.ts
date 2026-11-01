import { describe, expect, it } from 'vitest';
import { assign, jaccard, lexicalSimilarity, shingles } from '../src/cluster.js';
import { entities, tokenize } from '../src/normalize.js';

const sig = (title: string, at = '2026-11-01T08:00:00Z') => ({ tokens: tokenize(title), entities: entities(title), at });

describe('clustering', () => {
  it('normalises titles: accents, case, stop words', () => {
    expect(tokenize("La BCE relève ses taux d'intérêt")).toEqual(['bce', 'releve', 'taux', 'interet']);
    expect(entities('Christine Lagarde annonce que la BCE relève ses taux')).toEqual(['lagarde', 'bce']);
    expect(entities('Actualité : la Banque centrale européenne et Black Friday')).toEqual(['banque', 'black friday']);
  });

  it('jaccard of shingles', () => {
    expect(jaccard(shingles(['a', 'b']), shingles(['a', 'b']))).toBe(1);
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
  });

  it('scores the same story high and different stories low', () => {
    const a = sig('La BCE relève ses taux directeurs de 25 points de base');
    const b = sig('Taux directeurs : la BCE relève de 25 points de base, Lagarde prudente');
    const c = sig('Apple présente un nouvel iPhone pliable');
    expect(lexicalSimilarity.score(a, b)).toBeGreaterThan(0.34);
    expect(lexicalSimilarity.score(a, c)).toBeLessThan(0.1);
  });

  it('assigns to the best event in the window, or to none', () => {
    const candidates = [
      { eventId: 'ev_rates', members: [sig('La BCE relève ses taux directeurs')] },
      { eventId: 'ev_apple', members: [sig('Apple présente un iPhone pliable')] },
    ];
    expect(assign(sig('BCE : les taux directeurs relevés'), candidates, { threshold: 0.34, windowHours: 48 })?.eventId).toBe('ev_rates');
    expect(assign(sig('Le Tour de France 2027 dévoilé'), candidates, { threshold: 0.34, windowHours: 48 })).toBeUndefined();
    // Same words, but 3 days later: outside the 48 h window.
    expect(assign(sig('La BCE relève ses taux directeurs', '2026-11-04T08:00:00Z'), candidates, { threshold: 0.34, windowHours: 48 })).toBeUndefined();
  });

  it('accepts another similarity (the plug for embeddings)', () => {
    const always = { name: 'always', score: () => 0.9 };
    expect(assign(sig('x y'), [{ eventId: 'e', members: [sig('z w')] }], { threshold: 0.5, windowHours: 48, similarity: always })?.eventId).toBe('e');
  });
});
