import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { loadLaunch } from '../src/config.js';
import { acquireLock, allowance, LockedError, runCycle } from '../src/loop.js';
import { allowedTools, buildPrompt, codexMcpArgs, renderTemplate, TEMPLATES } from '../src/runner.js';
import { cronLine, editCrontab, launchdPlist, systemdUnits } from '../src/schedule.js';
import { ingest, openStore, pendingEvents, saveDraft } from '../src/service.js';
import { answersSchema, cronOf, loadCatalogue, mcpConfig, selectSources, splitCommand, writeLaunch } from '../src/setup.js';
import { answersFromFlags, checkUniverse, completeAnswers, parseFlags, type Io } from '../src/start.js';
import { art, source } from './helpers.js';

const answers = (over = {}) => answersSchema.parse({ name: 'mini', scope: { kind: 'languages', values: ['fr'] }, themes: ['tech'], universes: { tech: ['%tech', '%tech-fr'] }, ...over });
const home = () => mkdtempSync(join(tmpdir(), 'news-home-'));

describe('config generation', () => {
  const catalogue = [
    source({ id: 'a', language: 'fr', country: 'FR', category: 'tech', frequency: '15m' }),
    source({ id: 'b', language: 'fr', country: 'FR', category: 'security', frequency: '6h' }),
    source({ id: 'c', language: 'en', country: 'GB', category: 'tech' }),
    source({ id: 'd', language: 'fr', country: 'FR', category: 'sport' }),
    source({ id: 'e', language: 'en', country: 'INT', category: 'tech' }),
  ];

  it('selects by theme (with subcategories) and scope, and slows sources to the frequency', () => {
    const fr = selectSources(catalogue, { scope: { kind: 'languages', values: ['fr'] }, themes: ['tech'], every: '1h' });
    expect(fr.map((s) => [s.id, s.frequency])).toEqual([['a', '1h'], ['b', '6h']]);
    expect(selectSources(catalogue, { scope: { kind: 'countries', values: ['GB'] }, themes: ['tech'], every: '1h' }).map((s) => s.id)).toEqual(['c', 'e']);
    expect(selectSources(catalogue, { scope: { kind: 'world', values: [] }, themes: ['tech', 'sport'], every: '1h' })).toHaveLength(5);
  });

  it('builds a config that loads, with universes per theme and the agent block', () => {
    const h = home();
    const { dir, sources } = writeLaunch(h, answers({ verification: 'to_confirm', perHour: 2 }), catalogue);
    expect(sources).toHaveLength(2);
    const l = loadLaunch('mini', join(h, 'launches'));
    expect(l.config.universes).toEqual({ default: ['%tech', '%tech-fr'], byCategory: { tech: ['%tech', '%tech-fr'], security: ['%tech', '%tech-fr'], startups: ['%tech', '%tech-fr'], regulation: ['%tech', '%tech-fr'] } });
    expect(l.config.verification.publishUnconfirmed).toBe(true);
    expect(l.config.agent).toMatchObject({ mode: 'dry_run', limits: { perHour: 2, perDay: 30, batch: 5 }, runner: { kind: 'claude' }, scope: { kind: 'languages', values: ['fr'] } });
    expect(l.config.languages).toEqual(['fr']);
    const mcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
    expect(Object.keys(mcp.mcpServers)).toEqual(['breakrocks-news', 'breakrocks']);
    expect(JSON.stringify(mcp)).not.toMatch(/PRIVATE KEY/);
    expect(parse(readFileSync(join(dir, 'start.yaml'), 'utf8')).name).toBe('mini');
  });

  it('refuses a theme without universes, more than 20 scope values, a custom runner without template', () => {
    expect(() => answers({ themes: ['tech', 'sport'] })).toThrow(/destination universe/);
    expect(() => answers({ scope: { kind: 'countries', values: Array.from({ length: 21 }, (_, i) => `C${i}`) } })).toThrow();
    expect(() => answers({ runner: { kind: 'custom' } })).toThrow(/template/);
  });

  it('the shared catalogue covers every theme in fr and en, with rights notes', () => {
    const cat = loadCatalogue();
    for (const t of ['politics', 'economy', 'sport', 'entertainment', 'culture', 'tech', 'crime_justice', 'international', 'science', 'climate', 'health']) {
      for (const lang of ['fr', 'en']) expect(selectSources(cat, { scope: { kind: 'languages', values: [lang] }, themes: [t as 'tech'], every: '1h' }).length, `${t} ${lang}`).toBeGreaterThanOrEqual(2);
    }
    expect(new Set(cat.map((s) => s.id)).size).toBe(cat.length);
  });

  it('cron expressions and MCP config', () => {
    expect([cronOf('15m'), cronOf('2h'), cronOf('1d'), cronOf('90m')]).toEqual(['*/15 * * * *', '0 */2 * * *', '0 0 */1 * *', '0 */2 * * *']);
    expect(mcpConfig('/h', 'npx -y breakrocks').mcpServers.breakrocks).toMatchObject({ command: 'npx', args: ['-y', 'breakrocks', 'mcp'] });
  });
});

describe('flags and wizard', () => {
  it('parses flags into answers', () => {
    const { flags, positionals } = parseFlags(['x', '--name', 'n', '--languages=fr,EN', '--themes', 'tech,crime-justice', '--universe', 'tech=%a,%b', '--universe', 'crime_justice=%c', '--per-hour', '3', '--live', '--yes']);
    expect(positionals).toEqual(['x']);
    expect(answersFromFlags(flags)).toEqual({ name: 'n', scope: { kind: 'languages', values: ['fr', 'en'] }, themes: ['tech', 'crime_justice'], universes: { tech: ['%a', '%b'], crime_justice: ['%c'] }, perHour: 3, mode: 'live' });
  });

  const fakeIo = (replies: string[]) => {
    const asked: string[] = [], printed: string[] = [];
    const io: Io = { ask: async (q) => { asked.push(q); return replies.shift() ?? ''; }, print: (s) => printed.push(s), close: () => undefined };
    return { io, asked, printed };
  };
  const show = (universes: Record<string, object>) => async (_c: string, u: string) => ({ universe: { exists: false, ...universes[u] } });

  it('asks for what is missing, re-asks a universe that forbids agents, confirms live', async () => {
    const { io, asked, printed } = fakeIo(['mini', 'languages', 'fr', 'tech', '%closed', '%tech', '30m', '3', '20', 't', 'claude', '', '', 'live', 'live']);
    const a = await completeAnswers({ breakrocks: 'breakrocks' }, { home: home(), io, yes: false, skipUniverseCheck: false, existed: false, show: show({ '%closed': { exists: true, agentsForbidden: true }, '%tech': { exists: true } }) });
    expect(a).toMatchObject({ name: 'mini', scope: { kind: 'languages', values: ['fr'] }, themes: ['tech'], universes: { tech: ['%tech'] }, every: '30m', perHour: 3, perDay: 20, verification: 'to_confirm', mode: 'live', identity: {} });
    expect(printed.join('\n')).toMatch(/%closed: exists, FORBIDS AGENTS/);
    expect(printed.join('\n')).toMatch(/%tech: exists, agent rule unknown/);
    expect(asked.at(-1)).toMatch(/Type "live"/);
  });

  it('--yes never asks, fails on a missing name, and keeps the first start in dry run', async () => {
    await expect(completeAnswers({ themes: ['tech'] }, { home: home(), yes: true, skipUniverseCheck: true, existed: false })).rejects.toThrow(/--name/);
    const a = await completeAnswers({ name: 'm', themes: ['tech'], universes: { tech: ['%t'] }, mode: 'live' }, { home: home(), yes: true, skipUniverseCheck: true, existed: false, io: fakeIo([]).io });
    expect(a.mode).toBe('dry_run');
    const b = await completeAnswers({ name: 'm', themes: ['tech'], universes: { tech: ['%t'] }, mode: 'live' }, { home: home(), yes: true, skipUniverseCheck: true, existed: true });
    expect(b.mode).toBe('live');
  });

  it('checks a universe through the CLI output, tolerating a missing agentsForbidden', async () => {
    expect(await checkUniverse('br', '%tech#ia', {}, async (_c, u) => ({ universe: { name: u, exists: true, myRole: null } }))).toEqual({ address: '%tech#ia', universe: '%tech', exists: true, myRole: null });
    expect((await checkUniverse('br', '%x', {}, async () => { throw new Error('not found'); })).error).toBe('not found');
    expect((await checkUniverse('br', '%x', {}, async () => ({ universe: { exists: true, agentPostsForbidden: true } }))).agentsForbidden).toBe(true);
    expect((await checkUniverse('br', '%x', {}, async () => ({ error: { code: 'GRAPHQL_ERROR', message: 'Field undefined' } }))).error).toMatch(/GRAPHQL_ERROR/);
  });
});

describe('runner templating', () => {
  const vars = { prompt: 'Run "it"; rm -rf /', promptFile: '/p.md', mcpConfig: '/l/.mcp.json', launch: 'mini', launchDir: '/l', kitDir: '/k', allowedTools: allowedTools('dry_run') };

  it('renders claude without a shell: the prompt stays one argument', () => {
    const argv = renderTemplate(TEMPLATES.claude, vars);
    expect(argv).toEqual(['claude', '-p', 'Run "it"; rm -rf /', '--mcp-config', '/l/.mcp.json', '--strict-mcp-config', '--allowedTools', 'mcp__breakrocks-news,mcp__breakrocks__breakrocks_universes_show,mcp__breakrocks__breakrocks_universes_conditions_show,mcp__breakrocks__breakrocks_posts_show,mcp__breakrocks__breakrocks_whoami']);
    expect(allowedTools('live')).toBe('mcp__breakrocks-news,mcp__breakrocks');
  });

  it('custom templates: quotes, embedded placeholders, list placeholders, unknown ones', () => {
    expect(renderTemplate(`my-ai --file={promptFile} "--title=news {launch}" {codexMcp}`, vars, { codexMcp: [] })).toEqual(['my-ai', '--file=/p.md', '--title=news mini']);
    expect(() => renderTemplate('x {nope}', vars)).toThrow(/Unknown placeholder \{nope\}/);
    expect(splitCommand(`a 'b c' "d \\"e\\"" f\\ g ''`)).toEqual(['a', 'b c', 'd "e"', 'f g', '']);
  });

  it('codex gets its MCP servers as -c overrides, and no break.rocks server in dry run', () => {
    const mcp = mcpConfig('/h', 'breakrocks');
    const dry = codexMcpArgs(mcp, 'dry_run');
    expect(dry.join(' ')).toContain('mcp_servers."breakrocks-news".command=');
    expect(dry.join(' ')).not.toContain('"breakrocks".command');
    const live = codexMcpArgs(mcp, 'live');
    expect(live).toContain('mcp_servers."breakrocks".env_vars=["BREAKROCKS_OPERATOR_ID","BREAKROCKS_AGENT_ID","BREAKROCKS_AGENT_KEY"]');
    expect(renderTemplate(TEMPLATES.codex, vars, { codexMcp: dry })[0]).toBe('codex');
  });

  it('the prompt carries the allowance and the mode', () => {
    const h = home();
    writeLaunch(h, answers(), [source({ category: 'tech' })]);
    const p = buildPrompt(loadLaunch('mini', join(h, 'launches')), 3, '# PROMPT');
    expect(p).toMatch(/limit: 3/);
    expect(p).toMatch(/DRY RUN/);
    expect(p.endsWith('# PROMPT')).toBe(true);
  });
});

describe('caps, lock and cycle', () => {
  it('allowance: the batch within the hourly and daily caps', () => {
    const limits = { perHour: 4, perDay: 10, batch: 5 };
    expect(allowance(limits, 0, 0)).toBe(4);
    expect(allowance(limits, 3, 3)).toBe(1);
    expect(allowance(limits, 1, 9)).toBe(1);
    expect(allowance(limits, 5, 5)).toBe(0);
    expect(allowance({ ...limits, perHour: 20 }, 0, 0)).toBe(5);
  });

  const launch = () => {
    const h = home();
    writeLaunch(h, answers({ perHour: 1, perDay: 5, verification: 'to_confirm' }), [source({ category: 'tech' })]);
    return loadLaunch('mini', join(h, 'launches'));
  };

  it('one instance per launch; a stale lock is taken over', () => {
    const l = launch();
    const release = acquireLock(l);
    expect(() => acquireLock(l)).toThrow(LockedError);
    release();
    expect(existsSync(join(l.dir, 'data', 'run.lock'))).toBe(false);
    writeFileSync(join(l.dir, 'data', 'run.lock'), JSON.stringify({ pid: 999_999_9, host: hostname(), startedAt: 'x' }));
    acquireLock(l)();
  });

  it('a cycle runs the AI once within the caps, drafts count, STOP stops', async () => {
    const l = launch();
    const store = openStore(l);
    ingest(store, l, [art('Une faille critique dans un routeur', 'https://a.fr/1', { category: 'tech' }), art('Apple sort un casque', 'https://b.fr/2', { category: 'tech' })]);
    store.close();
    const collectFn = (async () => ({ sources: { fetched: 1, notModified: 0, notDue: 0, errors: [] }, articles: { added: 2 }, events: { created: 2 } })) as never;
    const calls: string[][] = [];
    const run = async (argv: string[]) => {
      calls.push(argv);
      const [id] = pendingEvents(l, 1).map((e) => e.id);
      saveDraft(l, { eventId: id!, kind: 'new', text: 'Draft', universes: ['%tech'] });
      return { code: 0, signal: null, durationMs: 5, timedOut: false };
    };
    const first = await runCycle(l, { collectFn, run });
    expect(calls).toHaveLength(1);
    expect(first.caps).toEqual({ usedHour: 0, usedDay: 0, allowance: 1 });
    expect(first.runner).toMatchObject({ code: 0, counted: 1, overCap: false });
    expect(first.pending).toBe(1);
    const second = await runCycle(l, { collectFn, run });
    expect(second.caps.allowance).toBe(0);
    expect(calls).toHaveLength(1);
    writeFileSync(join(l.dir, 'STOP'), '');
    expect((await runCycle(l, { collectFn, run })).stopped).toBe(true);
    expect(readFileSync(join(l.dir, 'data', 'runs.jsonl'), 'utf8').trim().split('\n')).toHaveLength(3);
  });
});

describe('scheduling', () => {
  const spec = { label: 'rocks.break.news.mini', argv: ['/usr/bin/node', '/k/dist/index.js', 'run', 'mini', '--once'], env: { BREAKROCKS_NEWS_HOME: '/h & co' }, every: '30m', logDir: '/l' };
  it('launchd, systemd and cron entries', () => {
    expect(launchdPlist(spec)).toContain('<integer>1800</integer>');
    expect(launchdPlist(spec)).toContain('/h &amp; co');
    expect(systemdUnits(spec).timer).toContain('OnUnitActiveSec=1800s');
    expect(cronLine(spec)).toMatch(/^\*\/30 \* \* \* \* BREAKROCKS_NEWS_HOME='\/h & co' \/usr\/bin\/node .* # breakrocks-news:rocks.break.news.mini$/);
    const tab = editCrontab('0 1 * * * other\n', '# breakrocks-news:x', 'line # breakrocks-news:x');
    expect(editCrontab(tab, '# breakrocks-news:x')).toBe('0 1 * * * other\n');
  });
});
