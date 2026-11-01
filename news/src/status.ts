// Verification status and readiness of an event: pure functions, no I/O.
import { jaccard } from './cluster.js';
import { tokenize } from './normalize.js';
import type { Article, LaunchConfig, NewsEvent, Verification } from './types.js';

/** Independent outlets: distinct owner groups (two titles of one group count once). */
export const independentGroups = (articles: Pick<Article, 'group'>[]) => [...new Set(articles.map((a) => a.group))];

export function verificationOf(articles: Pick<Article, 'group' | 'official'>[], minOutlets: number): Verification {
  if (articles.some((a) => a.official)) return 'corroborated';
  return independentGroups(articles).length >= minOutlets ? 'corroborated' : 'to_confirm';
}

export const isSensitive = (category: string, config: Pick<LaunchConfig, 'verification'>) => config.verification.sensitiveCategories.includes(category);

export type Readiness = { kind: 'new' | 'update'; reasons: string[] } | { kind: 'wait'; reasons: string[] } | { kind: 'none'; reasons: string[] };

/**
 * What the AI should do with an event now:
 * - new: never published and ready (sensitive categories need corroboration; single source only if allowed);
 * - update: published, and new independent outlets, a verification change or a materially different title since;
 * - wait: not ready yet; none: nothing to do (skipped, needs_review, or up to date).
 */
export function readiness(event: NewsEvent, config: Pick<LaunchConfig, 'verification'>): Readiness {
  if (event.status === 'skipped' || event.status === 'needs_review' || event.status === 'drafted') return { kind: 'none', reasons: [event.status] };
  if (!event.published) {
    if (event.sensitive && event.verification !== 'corroborated') return { kind: 'wait', reasons: ['sensitive category: needs corroboration'] };
    if (event.verification === 'to_confirm' && !config.verification.publishUnconfirmed) return { kind: 'wait', reasons: ['single source: publishUnconfirmed is false'] };
    return { kind: 'new', reasons: [event.verification] };
  }
  const reasons: string[] = [];
  const newOutlets = event.outlets.filter((o) => !event.published!.outlets.includes(o));
  if (newOutlets.length) reasons.push(`new sources: ${newOutlets.join(', ')}`);
  if (event.verification !== event.published.verification) reasons.push(`verification: ${event.published.verification} -> ${event.verification}`);
  if (materialChange(event.published.title, event.title)) reasons.push('headline changed materially');
  return reasons.length ? { kind: 'update', reasons } : { kind: 'none', reasons: ['up to date'] };
}

/** The lead headline drifted: less than 40% of shared words. */
export const materialChange = (before: string, after: string) => jaccard(new Set(tokenize(before)), new Set(tokenize(after))) < 0.4;
