// The breakrocks CLI as the kit uses it (D-235): its local agents (`agents local --json`), creating one
// (`agents create`, the operator signed in), and `doctor --json` before the loop. The CLI holds the keys:
// the kit never reads nor writes one.
import { execFile, spawn } from 'node:child_process';
import { splitCommand } from './setup.js';

export interface LocalAgent { name: string; operatorId: string; agentId: string; env: 'dev' | 'staging' | 'prod'; keyStorage: string }
export interface DoctorCheck { name: string; status: 'ok' | 'warn' | 'fail' | 'skip'; detail: string; code?: string }
export interface DoctorReport { ok: boolean; checks: DoctorCheck[]; missingFields?: string[] }

export interface Cli {
  localAgents(): Promise<LocalAgent[]>;
  /** Creates a delegated agent as a local agent, the person at the terminal (the operator signed in). */
  createAgent(name: string): Promise<void>;
  doctor(agent: string | undefined, env: string | undefined): Promise<DoctorReport>;
}

const json = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => new Promise<unknown>((res, rej) => {
  const [bin, ...pre] = splitCommand(cmd);
  execFile(bin!, [...pre, ...args], { env, timeout: 120_000, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
    if (stdout.trim()) { try { return res(JSON.parse(stdout)); } catch { /* below */ } }
    rej(new Error((stderr || err?.message || 'the CLI did not answer JSON').trim().split('\n').at(-1)));
  });
});

export function cliOf(cmd: string, env: NodeJS.ProcessEnv = process.env): Cli {
  return {
    localAgents: async () => {
      const r = await json(cmd, ['agents', 'local', '--json'], env) as LocalAgent[] | { error?: { code?: string; message?: string } };
      if (!Array.isArray(r)) throw new Error(r.error?.code === 'UNKNOWN_COMMAND' ? `${cmd} has no local agents: update the breakrocks CLI to 0.14.0 or later` : r.error?.message ?? 'agents local failed');
      return r;
    },
    createAgent: (name) => new Promise((res, rej) => {
      const [bin, ...pre] = splitCommand(cmd);
      spawn(bin!, [...pre, 'agents', 'create', name], { env, stdio: 'inherit' }).on('exit', (code) => (code === 0 ? res() : rej(new Error(`breakrocks agents create ${name} failed (exit ${code})`)))).on('error', rej);
    }),
    doctor: async (agent, environment) => {
      const r = await json(cmd, ['doctor', '--json', ...(agent ? ['--agent', agent] : []), ...(environment ? ['--env', environment] : [])], env) as DoctorReport | { error?: { code?: string; message?: string } };
      if (!('checks' in r)) {
        const e = (r as { error?: { code?: string; message?: string } }).error;
        if (e?.code === 'UNKNOWN_COMMAND') return { ok: false, checks: [{ name: 'version', status: 'fail', detail: `${cmd} has no doctor: update the breakrocks CLI to 0.14.0 or later` }] };
        return { ok: false, checks: [{ name: 'doctor', status: 'fail', detail: `${e?.code ?? 'error'}: ${e?.message ?? ''}` }] };
      }
      return r;
    },
  };
}

/** The failures of a doctor report, one line each, for the message that stops the loop. */
export const doctorFailures = (r: DoctorReport) => r.checks.filter((c) => c.status === 'fail').map((c) => `${c.name}: ${c.detail}`);

/** Runs doctor; throws a clear message when a check fails (the loop does not start). */
export async function doctorGate(cli: Cli, agent: string | undefined, env: string | undefined): Promise<DoctorReport> {
  const report = await cli.doctor(agent, env);
  if (!report.ok) throw new Error(`breakrocks doctor failed${agent ? ` for the agent "${agent}"` : ''}, the loop does not start:\n  ${doctorFailures(report).join('\n  ')}\nFix it, then check with: breakrocks doctor${agent ? ` --agent ${agent}` : ''}`);
  return report;
}
