// The breakrocks-news MCP server: mechanical work only (no AI). The user's AI writes and publishes.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listLaunches, loadLaunch } from './config.js';
import { collect, eventDetail, markEvent, pendingForAi, recordPublication, saveDraft } from './service.js';

const VERSION = '0.3.0';

const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const wrap = <A,>(fn: (args: A) => unknown | Promise<unknown>) => async (args: A) => {
  try { return ok(await fn(args)); } catch (e) { return { content: [{ type: 'text' as const, text: JSON.stringify({ error: (e as Error).message }) }], isError: true }; }
};

const launch = z.string().describe('The launch name (a folder of launches/)');

export function createServer(): McpServer {
  const server = new McpServer({ name: 'breakrocks-news', version: VERSION }, {
    instructions: 'Collects news for launches, groups articles into events, tracks verification and publications. It never writes posts: you write an original post per event and publish it with the breakrocks MCP server (breakrocks mcp), then call record_publication. Read PROMPT.md of the kit for the rules.',
  });

  server.registerTool('launches_list', { title: 'List the launches', description: 'Every launch with its languages, themes, universes, schedule and source count.', inputSchema: {} },
    wrap(() => listLaunches().map((name) => {
      const l = loadLaunch(name);
      return { name, description: l.config.description, languages: l.config.languages, themes: l.config.themes, universes: l.config.universes, verification: l.config.verification, schedule: l.config.schedule, sources: l.sources.length };
    })));

  server.registerTool('collect', {
    title: 'Collect a launch', description: 'Fetches the due sources of a launch (RSS/Atom, GDELT DOC API, Hacker News) with ETag/If-Modified-Since and each source frequency, normalises the articles and groups them into events. force: ignore the frequencies.',
    inputSchema: { launch, force: z.boolean().optional().describe('Fetch every source now, whatever its frequency') },
  }, wrap(({ launch: name, force }: { launch: string; force?: boolean }) => collect(loadLaunch(name), { force })));

  server.registerTool('pending_events', {
    title: 'Events to publish or update', description: 'Events ready to publish (kind new) or whose post needs an update (kind update: merged with another event, new sources, verification or headline change), with their destination universes. Promotions are left out. With an agent block, the server enforces the hourly and daily caps: each event returned counts against them right away, and an event returned but not recorded is held back for 2 hours. Returns { events, caps, withheld }.',
    inputSchema: { launch, limit: z.number().int().min(1).max(200).optional().describe('Default 20') },
  }, wrap(({ launch: name, limit }: { launch: string; limit?: number }) => pendingForAi(loadLaunch(name), limit ?? 20)));

  server.registerTool('event', {
    title: 'An event', description: 'An event with its articles (url, title, outlet, language, country, dates, reuse rights note) and its publication history.',
    inputSchema: { launch, id: z.string().describe('The event id (ev_...), or the id of an event merged into it') },
  }, wrap(({ launch: name, id }: { launch: string; id: string }) => eventDetail(loadLaunch(name), id)));

  server.registerTool('record_publication', {
    title: 'Record a publication', description: 'Records what was published for an event: the break.rocks post id, the summary version (1 for the first post, +1 at each update), the exact text, and the status (published: new post in the main universe; edited: the post was edited; update_reply: an "Update" reply was posted; reposted: the post was reposted into another universe, postId = the repost id; failed: nothing went out). Keeps the full history.',
    inputSchema: {
      launch, eventId: z.string(), postId: z.string().describe('The post id returned by breakrocks (the reply id for update_reply)'),
      summaryVersion: z.number().int().min(1), text: z.string().min(1), status: z.enum(['published', 'edited', 'update_reply', 'reposted', 'failed']),
    },
  }, wrap(({ launch: name, ...input }: { launch: string; eventId: string; postId: string; summaryVersion: number; text: string; status: 'published' | 'edited' | 'update_reply' | 'reposted' | 'failed' }) => recordPublication(loadLaunch(name), input)));

  server.registerTool('save_draft', {
    title: 'Save a draft (dry run)', description: 'Dry run only: instead of publishing, save the exact post you would publish (or the update reply / edited text) for an event to launches/<launch>/drafts/. Records it (status drafted) so the event does not come back. Nothing is sent to break.rocks.',
    inputSchema: {
      launch, eventId: z.string(), kind: z.enum(['new', 'update']), text: z.string().min(1).describe('The full post text, exactly as it would be published'),
      universes: z.array(z.string()).min(1).describe('The main universe first, then the universes it would be reposted into'), summaryVersion: z.number().int().min(1).optional(),
    },
  }, wrap(({ launch: name, ...input }: { launch: string; eventId: string; kind: 'new' | 'update'; text: string; universes: string[]; summaryVersion?: number }) => saveDraft(loadLaunch(name), input)));

  server.registerTool('mark_event', {
    title: 'Mark an event', description: 'skipped: never publish it (off-topic, duplicate, not newsworthy). needs_review: a human must look at it (sensitive, unclear, contradictory sources).',
    inputSchema: { launch, id: z.string(), status: z.enum(['skipped', 'needs_review']) },
  }, wrap(({ launch: name, id, status }: { launch: string; id: string; status: 'skipped' | 'needs_review' }) => markEvent(loadLaunch(name), id, status)));

  return server;
}
