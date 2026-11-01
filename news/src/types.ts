// Shared types of the news kit.

export type SourceType = 'rss' | 'gdelt' | 'hackernews';

export interface Source {
  id: string;
  url: string;
  type: SourceType;
  name: string;
  /** Outlet group (owner) used to decide independence; defaults to the outlet name. */
  group?: string;
  country: string;
  language: string;
  category: string;
  /** Minimum delay between two fetches, e.g. "30m", "2h", "1d". */
  frequency: string;
  /** An official body (central bank, statistics office, ministry): one is enough to corroborate. */
  official?: boolean;
  /** GDELT only: the DOC API query. */
  query?: string;
  /** Honest note on what the outlet allows: links and facts only, never its text or images. */
  rights: string;
}

export interface LaunchConfig {
  name: string;
  description: string;
  languages: string[];
  themes: string[];
  /** Destination universes: a default list and optional per category / language routes. */
  universes: { default: string[]; byCategory?: Record<string, string[]>; byLanguage?: Record<string, string[]> };
  verification: {
    /** Independent outlets needed to call an event corroborated. */
    minOutlets: number;
    /** Categories that must be corroborated before they are ready. */
    sensitiveCategories: string[];
    /** Whether a single-source, non-sensitive event may be published (marked to_confirm). */
    publishUnconfirmed: boolean;
  };
  clustering: { threshold: number; windowHours: number };
  collect: { maxAgeHours: number; concurrency: number; userAgent: string };
  /** How often the user's AI should run the loop (cron expression, informative). */
  schedule: string;
  /** Category keyword overrides: an article whose title holds one of these words gets the category. */
  categoryKeywords?: Record<string, string[]>;
}

export interface Launch {
  name: string;
  dir: string;
  config: LaunchConfig;
  sources: Source[];
}

export interface Article {
  id: string;
  url: string;
  title: string;
  outlet: string;
  group: string;
  sourceId: string;
  language: string;
  country: string;
  publishedAt: string;
  collectedAt: string;
  category: string;
  official: boolean;
  /** Normalised title tokens and capitalised entities, for clustering. */
  tokens: string[];
  entities: string[];
}

export type Verification = 'to_confirm' | 'corroborated';
export type EventStatus = 'open' | 'published' | 'skipped' | 'needs_review';

export interface NewsEvent {
  id: string;
  title: string;
  category: string;
  language: string;
  sensitive: boolean;
  firstSeen: string;
  lastSeen: string;
  eventDate: string;
  status: EventStatus;
  verification: Verification;
  articleCount: number;
  outlets: string[];
  /** Snapshot taken by record_publication: what the last post was based on. */
  published?: { postId: string; summaryVersion: number; outlets: string[]; verification: Verification; title: string; at: string };
}

export interface Publication {
  eventId: string;
  postId: string;
  summaryVersion: number;
  text: string;
  status: PublicationStatus;
  verification: Verification;
  sources: string[];
  recordedAt: string;
}

export type PublicationStatus = 'published' | 'edited' | 'update_reply' | 'failed';
