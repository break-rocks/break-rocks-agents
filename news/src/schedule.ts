// schedule / unschedule: runs `breakrocks-news run <launch> --once` at the launch's collection frequency,
// with launchd on macOS, a systemd user timer on Linux, or cron when systemd is not there.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { frequencyMs, kitDir } from './config.js';
import { cronOf } from './setup.js';
import type { Launch } from './types.js';

export type Scheduler = 'launchd' | 'systemd' | 'cron';

export interface ScheduleSpec { label: string; argv: string[]; env: Record<string, string>; every: string; logDir: string }

export function specOf(launch: Launch, home: string): ScheduleSpec {
  return {
    label: `rocks.break.news.${launch.name}`,
    argv: [process.execPath, join(kitDir(), 'dist', 'index.js'), 'run', launch.name, '--once'],
    env: { BREAKROCKS_NEWS_HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' },
    every: launch.config.agent?.every ?? '1h',
    logDir: join(launch.dir, 'data', 'logs'),
  };
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sh = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export function launchdPlist(s: ScheduleSpec): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(s.label)}</string>
  <key>ProgramArguments</key><array>
${s.argv.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key><dict>
${Object.entries(s.env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n')}
  </dict>
  <key>StartInterval</key><integer>${Math.round(frequencyMs(s.every) / 1000)}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(join(s.logDir, 'scheduler.out.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(s.logDir, 'scheduler.err.log'))}</string>
</dict></plist>
`;
}

export function systemdUnits(s: ScheduleSpec): { service: string; timer: string } {
  return {
    service: `[Unit]\nDescription=breakrocks-news ${s.label}\n\n[Service]\nType=oneshot\n${Object.entries(s.env).map(([k, v]) => `Environment=${sh(`${k}=${v}`)}`).join('\n')}\nExecStart=${s.argv.map(sh).join(' ')}\n`,
    timer: `[Unit]\nDescription=breakrocks-news ${s.label}\n\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=${Math.round(frequencyMs(s.every) / 1000)}s\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`,
  };
}

export const cronMarker = (s: ScheduleSpec) => `# breakrocks-news:${s.label}`;
export function cronLine(s: ScheduleSpec): string {
  return `${cronOf(s.every)} ${Object.entries(s.env).map(([k, v]) => `${k}=${sh(v)}`).join(' ')} ${s.argv.map(sh).join(' ')} >> ${sh(join(s.logDir, 'scheduler.log'))} 2>&1 ${cronMarker(s)}`;
}

/** Replaces this launch's line in a crontab (or removes it when line is undefined). */
export function editCrontab(current: string, marker: string, line?: string): string {
  const kept = current.split('\n').filter((l) => l.trim() && !l.endsWith(marker));
  return [...kept, ...(line ? [line] : [])].join('\n') + '\n';
}

export function detectScheduler(): Scheduler {
  if (process.platform === 'darwin') return 'launchd';
  try { execFileSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' }); return 'systemd'; } catch { return 'cron'; }
}

const run = (cmd: string, args: string[], input?: string) => execFileSync(cmd, args, { input, encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
const readCrontab = () => { try { return run('crontab', ['-l']); } catch { return ''; } };

export function schedule(launch: Launch, home: string, opts: { scheduler?: Scheduler; print?: boolean } = {}): string {
  const s = specOf(launch, home);
  const kind = opts.scheduler ?? detectScheduler();
  mkdirSync(s.logDir, { recursive: true });
  if (kind === 'launchd') {
    const file = join(homedir(), 'Library', 'LaunchAgents', `${s.label}.plist`);
    if (opts.print) return `${file}\n${launchdPlist(s)}`;
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    try { run('launchctl', ['bootout', `gui/${process.getuid!()}/${s.label}`]); } catch { /* not loaded */ }
    writeFileSync(file, launchdPlist(s));
    run('launchctl', ['bootstrap', `gui/${process.getuid!()}`, file]);
    return `launchd: ${file} loaded, every ${s.every}`;
  }
  if (kind === 'systemd') {
    const dir = join(homedir(), '.config', 'systemd', 'user');
    const name = `breakrocks-news-${launch.name}`;
    const u = systemdUnits(s);
    if (opts.print) return `${dir}/${name}.service\n${u.service}\n${dir}/${name}.timer\n${u.timer}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.service`), u.service);
    writeFileSync(join(dir, `${name}.timer`), u.timer);
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', `${name}.timer`]);
    return `systemd: ${name}.timer enabled, every ${s.every} (loginctl enable-linger to run while logged out)`;
  }
  const line = cronLine(s);
  if (opts.print) return line;
  run('crontab', ['-'], editCrontab(readCrontab(), cronMarker(s), line));
  return `cron: ${cronOf(s.every)}`;
}

export function unschedule(launch: Launch, home: string, opts: { scheduler?: Scheduler } = {}): string {
  const s = specOf(launch, home);
  const kind = opts.scheduler ?? detectScheduler();
  if (kind === 'launchd') {
    const file = join(homedir(), 'Library', 'LaunchAgents', `${s.label}.plist`);
    try { run('launchctl', ['bootout', `gui/${process.getuid!()}/${s.label}`]); } catch { /* not loaded */ }
    const had = existsSync(file);
    rmSync(file, { force: true });
    return had ? `launchd: ${s.label} removed` : 'launchd: nothing scheduled';
  }
  if (kind === 'systemd') {
    const name = `breakrocks-news-${launch.name}`;
    try { run('systemctl', ['--user', 'disable', '--now', `${name}.timer`]); } catch { /* not enabled */ }
    const dir = join(homedir(), '.config', 'systemd', 'user');
    rmSync(join(dir, `${name}.service`), { force: true });
    rmSync(join(dir, `${name}.timer`), { force: true });
    try { run('systemctl', ['--user', 'daemon-reload']); } catch { /* ignore */ }
    return `systemd: ${name} removed`;
  }
  run('crontab', ['-'], editCrontab(readCrontab(), cronMarker(s)));
  return 'cron: line removed';
}
