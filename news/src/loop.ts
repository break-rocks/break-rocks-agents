// The autonomous loop of a launch: collect, then (when events are pending and the caps allow) one AI run,
// a log line, and a sleep until the next source is due. One instance per launch (a lock file), a
// graceful stop (SIGINT/SIGTERM), a kill switch (launches/<name>/STOP), and `--once` for cron.
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { frequencyMs, kitDir } from './config.js';
import { allowedTools, buildPrompt, codexMcpArgs, renderTemplate, spawnRunner, TEMPLATES, type RunResult } from './runner.js';
import { capUsage, collect, COUNTED, openStore, pendingEvents } from './service.js';
import type { AgentSettings, Launch } from './types.js';

export { COUNTED };

/** How many events the next AI run may handle: the batch, within what is left of the hourly and daily caps. */
export function allowance(limits: AgentSettings['limits'], usedLastHour: number, usedLastDay: number): number {
  return Math.max(0, Math.min(limits.batch, limits.perHour - usedLastHour, limits.perDay - usedLastDay));
}

export function capsUsed(launch: Launch, now = new Date()) {
  const store = openStore(launch);
  try { return capUsage(store, now); } finally { store.close(); }
}

// ---- lock ----

export class LockedError extends Error {}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

/** Takes data/run.lock (O_EXCL). A lock left by a dead process on this host is taken over. Returns the release. */
export function acquireLock(launch: Launch): () => void {
  const dir = join(launch.dir, 'data');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'run.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
      closeSync(fd);
      return () => { try { if (lockHolder(launch)?.pid === process.pid) unlinkSync(file); } catch { /* already gone */ } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const holder = lockHolder(launch);
      if (holder && (holder.host !== hostname() || alive(holder.pid))) throw new LockedError(`${launch.name} is already running (pid ${holder.pid} on ${holder.host}, since ${holder.startedAt})`);
      try { unlinkSync(file); } catch { /* raced */ }
    }
  }
  throw new LockedError(`${launch.name}: could not take the lock`);
}

export function lockHolder(launch: Launch): { pid: number; host: string; startedAt: string } | undefined {
  try { return JSON.parse(readFileSync(join(launch.dir, 'data', 'run.lock'), 'utf8')); } catch { return undefined; }
}

// ---- one cycle ----

export const stopFile = (launch: Launch) => join(launch.dir, 'STOP');
const runsFile = (launch: Launch) => join(launch.dir, 'data', 'runs.jsonl');

/** The environment of the runner: the agent's ids and key (read from its file, never printed). */
export function runnerEnv(agent: AgentSettings, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  // A local agent: the breakrocks CLI signs it in with the key of the system keychain (.mcp.json has --agent).
  if (agent.identity.agent) { env.BREAKROCKS_AGENT = agent.identity.agent; return env; }
  if (agent.identity.operatorId) env.BREAKROCKS_OPERATOR_ID = agent.identity.operatorId;
  if (agent.identity.agentId) env.BREAKROCKS_AGENT_ID = agent.identity.agentId;
  if (agent.identity.keyFile) env.BREAKROCKS_AGENT_KEY = readFileSync(agent.identity.keyFile, 'utf8');
  return env;
}

export const hasIdentity = (agent: AgentSettings) => !!(agent.identity.agent || (agent.identity.operatorId && agent.identity.agentId && agent.identity.keyFile));

export interface RunEntry {
  at: string; launch: string; mode: string; stopped?: boolean;
  collect?: { fetched: number; notModified: number; notDue: number; errors: { id: string; error?: string }[]; added: number; newEvents: number };
  pending: number; caps: { usedHour: number; usedDay: number; allowance: number };
  runner?: { argv0: string; code: number | null; durationMs: number; timedOut: boolean; counted: number; overCap: boolean; log: string };
  errors: string[];
}

export interface CycleDeps { run?: (argv: string[], opts: Parameters<typeof spawnRunner>[1]) => Promise<RunResult>; collectFn?: typeof collect; onChild?: (kill: () => void) => void; now?: () => Date }

export async function runCycle(launch: Launch, deps: CycleDeps = {}): Promise<RunEntry> {
  const agent = launch.config.agent;
  if (!agent) throw new Error(`${launch.name} has no agent block in config.yaml: set it up with breakrocks-news start`);
  const now = deps.now ?? (() => new Date());
  const entry: RunEntry = { at: now().toISOString(), launch: launch.name, mode: agent.mode, pending: 0, caps: { usedHour: 0, usedDay: 0, allowance: 0 }, errors: [] };
  if (existsSync(stopFile(launch))) { entry.stopped = true; return log(launch, entry); }
  try {
    const c = await (deps.collectFn ?? collect)(launch);
    entry.collect = { fetched: c.sources.fetched, notModified: c.sources.notModified, notDue: c.sources.notDue, errors: c.sources.errors.map((e) => ({ id: e.id, error: e.error })), added: c.articles.added, newEvents: c.events.created };
  } catch (e) { entry.errors.push(`collect: ${(e as Error).message}`); }
  entry.pending = pendingEvents(launch, 1000).length;
  const used = capsUsed(launch, now());
  entry.caps = { usedHour: used.hour, usedDay: used.day, allowance: allowance(agent.limits, used.hour, used.day) };
  if (!entry.pending || !entry.caps.allowance) return log(launch, entry);
  if (existsSync(stopFile(launch))) { entry.stopped = true; return log(launch, entry); }
  if (agent.mode === 'live' && !hasIdentity(agent)) { entry.errors.push('live mode without an agent (start --agent <name>): no AI run'); return log(launch, entry); }

  const logsDir = join(launch.dir, 'data', 'logs');
  mkdirSync(logsDir, { recursive: true });
  const stamp = entry.at.replace(/[:.]/g, '-');
  const promptFile = join(logsDir, `${stamp}.prompt.md`);
  const prompt = buildPrompt(launch, entry.caps.allowance);
  writeFileSync(promptFile, prompt);
  const mcpFile = join(launch.dir, '.mcp.json');
  const mcp = JSON.parse(readFileSync(mcpFile, 'utf8'));
  const argv = renderTemplate(agent.runner.template ?? TEMPLATES[agent.runner.kind as 'claude' | 'codex'],
    { prompt, promptFile, mcpConfig: mcpFile, launch: launch.name, launchDir: launch.dir, kitDir: kitDir(), allowedTools: allowedTools(agent.mode) },
    { codexMcp: codexMcpArgs(mcp, agent.mode) });
  const logFile = join(logsDir, `${stamp}.log`);
  let env: NodeJS.ProcessEnv;
  try { env = runnerEnv(agent); } catch (e) { entry.errors.push(`agent key: ${(e as NodeJS.ErrnoException).code ?? 'unreadable'}`); return log(launch, entry); }
  const res = await (deps.run ?? spawnRunner)(argv, { cwd: launch.dir, env, timeoutMs: agent.runner.timeoutMinutes * 60_000, log: (s) => appendFileSync(logFile, s), onChild: deps.onChild });
  const after = capsUsed(launch, now());
  const counted = after.day - used.day;
  entry.runner = { argv0: argv[0]!, code: res.code, durationMs: res.durationMs, timedOut: res.timedOut, counted, overCap: counted > entry.caps.allowance, log: logFile };
  if (res.code !== 0) entry.errors.push(`runner exited with ${res.code ?? res.signal}${res.timedOut ? ' (timeout)' : ''}: see ${logFile}`);
  if (entry.runner.overCap) entry.errors.push(`the AI went over its allowance (${counted} > ${entry.caps.allowance})`);
  entry.pending = pendingEvents(launch, 1000).length;
  return log(launch, entry);
}

function log(launch: Launch, entry: RunEntry): RunEntry {
  mkdirSync(join(launch.dir, 'data'), { recursive: true });
  appendFileSync(runsFile(launch), `${JSON.stringify(entry)}\n`);
  return entry;
}

/** Milliseconds until the next source is due (at least 30 s, at most the collection frequency). */
export function msUntilNextDue(launch: Launch, now = Date.now()): number {
  const store = openStore(launch);
  try {
    let next = Infinity;
    for (const s of launch.sources) {
      const last = store.sourceState(s.id).lastFetchAt;
      next = Math.min(next, last ? Date.parse(last) + frequencyMs(s.frequency) - now : 0);
    }
    const cap = frequencyMs(launch.config.agent?.every ?? '1h');
    return Math.max(30_000, Math.min(next, cap));
  } finally { store.close(); }
}

export function summary(e: RunEntry): string {
  if (e.stopped) return `${e.at} ${e.launch}: STOP file present, nothing done`;
  const c = e.collect;
  return `${e.at} ${e.launch} [${e.mode}]: ` + (c ? `${c.fetched} fetched, ${c.notModified} unchanged, ${c.notDue} not due, ${c.errors.length} errors, +${c.added} articles, +${c.newEvents} events; ` : '')
    + `${e.pending} pending; caps ${e.caps.usedHour}/h ${e.caps.usedDay}/d, allowance ${e.caps.allowance}`
    + (e.runner ? `; AI ${e.runner.argv0} exit ${e.runner.code} in ${Math.round(e.runner.durationMs / 1000)} s, ${e.runner.counted} ${e.mode === 'live' ? 'posts' : 'drafts'}` : '; no AI run')
    + (e.errors.length ? `\n  errors: ${e.errors.join(' | ')}` : '');
}

/** The loop. Resolves when stopped (signal, STOP file) or after one cycle with once. */
export async function runLoop(launch: Launch, opts: { once?: boolean; out?: (s: string) => void; deps?: CycleDeps } = {}) {
  const out = opts.out ?? ((s: string) => console.log(s));
  const release = acquireLock(launch);
  let stopping = false, wake: (() => void) | undefined, killChild: (() => void) | undefined;
  const onSignal = () => {
    if (stopping) { out('Second signal: stopping the AI run now.'); killChild?.(); return; }
    stopping = true;
    out('Stopping after the current step (send the signal again to stop the AI run now).');
    wake?.();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    for (;;) {
      if (existsSync(stopFile(launch))) { out(`${launch.name}: STOP file present (${stopFile(launch)}): stopping.`); if (opts.once) out(summary(await runCycle(launch, opts.deps))); break; }
      const entry = await runCycle(launch, { ...opts.deps, onChild: (k) => { killChild = k; } });
      killChild = undefined;
      out(summary(entry));
      if (opts.once || stopping) break;
      const ms = msUntilNextDue(launch);
      out(`Next cycle in ${Math.round(ms / 60_000)} min.`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, ms);
        const poll = setInterval(() => { if (existsSync(stopFile(launch))) { clearTimeout(t); clearInterval(poll); r(); } }, 5_000);
        wake = () => { clearTimeout(t); clearInterval(poll); r(); };
        t.unref?.();
      });
      if (stopping) break;
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    release();
  }
}

/** status <launch>: the last run, counts, caps, errors, lock and kill switch. */
export function launchStatus(launch: Launch) {
  let runs: RunEntry[] = [];
  try { runs = readFileSync(runsFile(launch), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as RunEntry); } catch { /* never ran */ }
  const last = runs.at(-1);
  const store = openStore(launch);
  const byStatus: Record<string, number> = {};
  let counts, sources, lastPurge;
  const nowIso = new Date().toISOString();
  try {
    counts = store.counts();
    for (const e of store.allEvents()) byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    lastPurge = store.meta('last_purge') ?? null;
    // Sources held back after 429s: in backoff, or disabled (GDELT after repeated 429s).
    sources = store.allSourceStates().filter((st) => (st.disabledUntil && st.disabledUntil > nowIso) || (st.backoffUntil && st.backoffUntil > nowIso))
      .map((st) => ({ id: st.sourceId, consecutive429: st.consecutive429 ?? 0, ...(st.disabledUntil && st.disabledUntil > nowIso ? { disabledUntil: st.disabledUntil } : { backoffUntil: st.backoffUntil }) }));
  } finally { store.close(); }
  const agent = launch.config.agent;
  const holder = lockHolder(launch);
  return {
    launch: launch.name, mode: agent?.mode ?? 'manual (no agent block)', stop: existsSync(stopFile(launch)),
    running: holder && alive(holder.pid) ? holder : null,
    lastRun: last ?? null, runs: runs.length, lastAiRun: [...runs].reverse().find((r) => r.runner)?.at ?? null,
    counts, events: byStatus, pending: pendingEvents(launch, 1000).length,
    similarity: launch.config.clustering.backend === 'embedding' ? `embedding (${launch.config.clustering.embedding?.provider}:${launch.config.clustering.embedding?.model})` : 'lexical',
    heldSources: sources, lastPurge,
    caps: agent ? { ...agent.limits, used: capsUsed(launch) } : null,
    recentErrors: runs.slice(-10).flatMap((r) => [...r.errors, ...(r.collect?.errors ?? []).map((e) => `source ${e.id}: ${e.error}`)].map((e) => `${r.at} ${e}`)).slice(-10),
  };
}

export const RUNNERS_HELP = Object.entries(TEMPLATES).map(([k, v]) => `  ${k}: ${v}`).join('\n');
