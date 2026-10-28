// Runs the resolved core's quest.py and parses its --json output. The action never
// re-implements data rules (D7): everything about validity comes from here.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export interface ValidateResult {
  ok: boolean;
  files: number;
  skillVersion?: number;
  validator?: string;
  issues: { file: string; pointer: string; message: string }[];
}

export interface ChangesResult {
  added: string[];
  changed: string[];
  removed: string[];
  unapprovedRemovals: string[];
}

export interface Core {
  /** Directory holding quest.py and schema/. */
  dir: string;
  version: string;
}

export class CoreFailed extends Error {}

type Run = (args: string[]) => { status: number | null; stdout: string; stderr: string };

const defaultRun = (core: Core): Run => (args) => {
  const r = spawnSync('python3', [join(core.dir, 'quest.py'), '--schemas', join(core.dir, 'schema'), ...args], {
    encoding: 'utf8',
    // The core must never reach the network for schemas or skill checks.
    env: { ...process.env, QUEST_SITE: 'http://127.0.0.1:9/' },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/** Parses stdout as JSON, or explains why quest.py gave none. */
function parse<T>(what: string, r: ReturnType<Run>, okCodes: number[]): T {
  if (r.status === null || !okCodes.includes(r.status)) {
    throw new CoreFailed(`quest.py ${what} exited ${r.status}: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new CoreFailed(`quest.py ${what} printed no JSON: ${r.stderr.trim() || r.stdout.slice(0, 200)}`);
  }
}

/** `quest.py validate DIR --json`; exit 1 means issues, which is still a result. */
export function validate(core: Core, dir: string, run: Run = defaultRun(core)): ValidateResult {
  return parse('validate', run(['validate', dir, '--json']), [0, 1]);
}

/** `quest.py changes --git REF DIR --json --warn`: removals are listed, never fatal here. */
export function changes(core: Core, dir: string, ref: string, run: Run = defaultRun(core)): ChangesResult {
  return parse('changes', run(['changes', '--git', ref, dir, '--json', '--warn']), [0]);
}

/** One running clock from `quest.py timers`. Levels are the only scope today; skip unknown ones. */
export interface Timer {
  key: string;
  scope: string;
  project: string;
  world: string;
  level: string;
  title?: string;
  phase: 'ok' | 'hurry' | 'overdue';
  phaseSince: string;
  endsAt: string;
  nudge: { tone: string; text: string } | null;
}

export interface ReviewSlot {
  /** 0 = Sunday, as in JS `getDay()`. */
  weekday: number;
  hour: number;
  label: string;
}

export interface TimersResult {
  schemaVersion: number;
  now: string;
  timers: Timer[];
  reviewSlots: Record<string, ReviewSlot>;
}

/** `quest.py timers DIR --json --now ISO`: time-box phases and review slots (G3). */
export function timers(core: Core, dir: string, now: Date, run: Run = defaultRun(core)): TimersResult {
  return parse('timers', run(['timers', dir, '--json', '--now', now.toISOString()]), [0]);
}
