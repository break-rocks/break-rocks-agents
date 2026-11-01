import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandBlock, LIVE_NOTE, shellQuote, shortCommand, startCommand, writeStartScript } from '../src/command.js';
import { answersSchema, splitCommand } from '../src/setup.js';
import { answersFromFile, answersFromFlags, parseFlags } from '../src/start.js';

const BODY = 'MC4CAQAwBQYDK2VwBCIEIJm3cR3tK5secretsecretsecretsecretsecret';
const dir = mkdtempSync(join(tmpdir(), 'news-cmd-'));
const keyFile = join(dir, 'my agent key.pem');
writeFileSync(keyFile, `-----BEGIN PRIVATE KEY-----\n${BODY}\n-----END PRIVATE KEY-----\n`, { mode: 0o600 });

const full = (over = {}) => answersSchema.parse({
  name: 'fr-tech', description: "Tech, l'essentiel: 100% fr", scope: { kind: 'countries', values: ['FR', 'BE'] }, themes: ['tech', 'crime_justice'],
  universes: { tech: ['%tech', '%tech-fr', '%france/news#ia'], crime_justice: ['%justice'] },
  every: '30m', perHour: 2, perDay: 10, batch: 7, verification: 'to_confirm', mode: 'dry_run',
  runner: { kind: 'custom', template: `my-ai --title "news {launch}, 100%" {prompt}` },
  identity: { operatorId: 'op_123', agentId: 'ag_456', keyFile }, breakrocks: 'npx -y breakrocks', ...over,
});

/** What a shell would give the program: comments dropped, line continuations joined, words split. */
const words = (text: string) => splitCommand(text.split('\n').filter((l) => !l.startsWith('#')).join('\n').replace(/ \\\n/g, ' ').trim());

function replay(text: string) {
  const [bin, sub, ...rest] = words(text);
  expect([bin, sub]).toEqual(['breakrocks-news', 'start']);
  const { flags, positionals } = parseFlags(rest);
  expect(positionals).toEqual([]);
  expect(flags.yes).toBe(true);
  return answersSchema.parse(answersFromFlags(flags));
}

describe('the printed start command', () => {
  it('round-trips every answer through the flags parser', () => {
    for (const a of [
      full(),
      full({ scope: { kind: 'languages', values: ['fr', 'en'] }, mode: 'live', verification: 'corroborated', runner: { kind: 'claude' }, breakrocks: 'breakrocks', description: undefined }),
      answersSchema.parse({ name: 'w', scope: { kind: 'world', values: [] }, themes: ['sport'], universes: { sport: ['%sport'] }, runner: { kind: 'codex' } }),
    ]) expect(replay(startCommand(a))).toEqual(a);
  });

  it('starts with --yes, one flag per line, continued by backslashes', () => {
    const lines = startCommand(full()).split('\n');
    expect(lines[0]).toBe('breakrocks-news start --yes \\');
    expect(lines.slice(0, -1).every((l) => l.endsWith(' \\'))).toBe(true);
    expect(lines.at(-1)!.endsWith('\\')).toBe(false);
    expect(lines).toContain('  --universe \'tech=%tech,%tech-fr,%france/news#ia\' \\');
    expect(lines.filter((l) => l.includes('--universe'))).toHaveLength(2);
  });

  it('quotes values with spaces, commas, % and quotes so a shell reads them back unchanged', () => {
    expect(shellQuote('tech,science')).toBe('tech,science');
    expect(shellQuote('%tech')).toBe("'%tech'");
    expect(shellQuote('a b')).toBe("'a b'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote('')).toBe("''");
    for (const v of ['a b', 'x,y %z', "it's 100%", '$HOME `id` ; rm -rf /', 'tab\tnew\nline', '{prompt}', '*', '#c', '']) expect(splitCommand(shellQuote(v)), v).toEqual([v]);
    const a = full();
    const w = words(startCommand(a));
    expect(w).toContain('tech=%tech,%tech-fr,%france/news#ia');
    expect(w).toContain(a.description);
    expect(w).toContain(a.runner.template);
    expect(w).toContain(keyFile);
  });

  it('keeps --mode live with a comment about --yes, only in live', () => {
    const live = startCommand(full({ mode: 'live' }));
    expect(live.split('\n')[0]).toBe(LIVE_NOTE);
    expect(live).toContain('--mode live');
    expect(startCommand(full()).split('\n').some((l) => l.startsWith('#'))).toBe(false);
    expect(startCommand(full())).toContain('--mode dry-run');
  });

  it('prints the short form and the block', () => {
    expect(shortCommand('fr-tech')).toBe('breakrocks-news start --yes --from launches/fr-tech/start.yaml');
    const block = commandBlock(full());
    expect(block).toContain('Run the same launch again without questions:');
    expect(block).toContain(startCommand(full()));
    expect(block).toContain('breakrocks-news start --yes --from launches/fr-tech/start.yaml');
  });

  it('never prints a secret: the key is a path, its content and the environment stay out', () => {
    process.env.BREAKROCKS_AGENT_KEY = BODY;
    try {
      const out = `${commandBlock(full())}\n${startCommand(full({ mode: 'live' }))}`;
      expect(out).not.toContain(BODY);
      expect(out).not.toMatch(/PRIVATE KEY|BREAKROCKS_AGENT_KEY/);
      expect(out).toContain('--agent-key-file');
      const file = writeStartScript(dir, full());
      expect(readFileSync(file, 'utf8')).not.toContain(BODY);
    } finally { delete process.env.BREAKROCKS_AGENT_KEY; }
  });

  it('writes start.sh, executable and private, with the same command', () => {
    const d = mkdtempSync(join(tmpdir(), 'news-sh-'));
    const a = full({ mode: 'live' });
    const file = writeStartScript(d, a);
    expect(file).toBe(join(d, 'start.sh'));
    const text = readFileSync(file, 'utf8');
    expect(text.startsWith('#!/bin/sh\n')).toBe(true);
    expect(text).toContain(startCommand(a));
    expect(replay(text)).toEqual(a);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o700);
  });

  it('the short form replays the saved start.yaml to the same answers', () => {
    const a = full();
    const d = mkdtempSync(join(tmpdir(), 'news-yaml-'));
    writeFileSync(join(d, 'start.yaml'), JSON.stringify(a));
    expect(answersSchema.parse(answersFromFile(join(d, 'start.yaml')))).toEqual(a);
  });
});
