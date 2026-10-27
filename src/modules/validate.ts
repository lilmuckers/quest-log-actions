// The validate module: on pull_request and push, run the core's quest.py validate and report it
// as a `Quest validate` check run (per-file annotations) and, on PRs, one upserted comment
// listing what the PR adds, changes and removes. Fails the job when it finds issues.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangesResult, ValidateResult } from '../core.js';
import type { Annotation } from '../github.js';
import { pointerLine } from '../json-line.js';

export const CHECK_NAME = 'Quest validate';
export const COMMENT_MARKER = '<!-- quest-log:validate -->';
/** Issues listed in the comment and summary; the check run carries all of them. */
const LISTED = 30;

export interface ValidateDeps {
  dir: string;
  validate(): ValidateResult;
  /** Present on PRs with commenting on: the diff against the base branch. */
  changes?: () => ChangesResult;
  baseRef?: string;
  coreVersion: string;
  createCheckRun(run: { conclusion: 'success' | 'failure'; title: string; summary: string; annotations: Annotation[] }): Promise<void>;
  upsertComment?(body: string): Promise<string>;
  /** Fallback when the token can't write checks (fork PRs): workflow-command annotations. */
  annotate(a: Annotation): void;
  warn(message: string): void;
}

export interface ValidateOutcome {
  ok: boolean;
  files: number;
  issues: number;
  changes?: ChangesResult;
  commentUrl?: string;
  /** Why the check run or comment couldn't be written, if so. */
  degraded: string[];
}

export function annotations(dir: string, result: ValidateResult): Annotation[] {
  const texts = new Map<string, string | null>();
  const text = (file: string) => {
    if (!texts.has(file)) {
      const path = join(dir, file);
      texts.set(file, existsSync(path) ? readFileSync(path, 'utf8') : null);
    }
    return texts.get(file)!;
  };
  return result.issues.map((i) => {
    const t = text(i.file);
    const line = t === null ? 1 : pointerLine(t, i.pointer);
    return {
      path: i.file,
      start_line: line,
      end_line: line,
      annotation_level: 'failure',
      title: i.pointer && i.pointer !== '/' ? i.pointer : 'Quest data',
      message: i.message,
    };
  });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function summary(result: ValidateResult, coreVersion: string): { title: string; summary: string } {
  const title = result.ok ? `✓ ${plural(result.files, 'data file')} valid` : `✗ ${plural(result.issues.length, 'issue')} in the quest data`;
  const lines = [`Checked with Quest Log core ${coreVersion}${result.validator ? ` (${result.validator} validator)` : ''}.`];
  if (!result.ok) {
    lines.push('', '| File | Where | Problem |', '|---|---|---|');
    for (const i of result.issues.slice(0, LISTED)) lines.push(`| \`${i.file}\` | \`${i.pointer || '/'}\` | ${i.message.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
    if (result.issues.length > LISTED) lines.push('', `…and ${result.issues.length - LISTED} more in the check run's annotations.`);
  }
  return { title, summary: lines.join('\n') };
}

export function commentBody(result: ValidateResult, changes: ChangesResult | undefined, baseRef: string | undefined, coreVersion: string): string {
  const s = summary(result, coreVersion);
  const out = [`### ${result.ok ? '✅' : '❌'} ${s.title.replace(/^[✓✗] /, '')}`, '', s.summary];
  if (changes) {
    const { added, changed, removed, unapprovedRemovals } = changes;
    out.push('', `**Against \`${baseRef}\`:** ${plural(added.length, 'addition')}, ${plural(changed.length, 'change')}, ${plural(removed.length, 'removal')}.`);
    const list = (label: string, keys: string[]) => {
      if (!keys.length) return;
      out.push('', `<details><summary>${label} (${keys.length})</summary>`, '', ...keys.map((k) => `- \`${k}\``), '', '</details>');
    };
    list('Added', added);
    list('Changed', changed);
    list('Removed', removed);
    if (unapprovedRemovals.length) out.push('', `> [!WARNING]`, `> This PR removes ${plural(unapprovedRemovals.length, 'thing')} that exist on \`${baseRef}\`. Check that's intended.`);
  }
  out.push('', '<sub>Quest Log · updated on every push to this PR</sub>');
  return out.join('\n');
}

/** Runs the module. Throws only for core failures; reporting problems degrade with a warning. */
export async function runValidate(deps: ValidateDeps): Promise<ValidateOutcome> {
  const result = deps.validate();
  const notes = annotations(deps.dir, result);
  const s = summary(result, deps.coreVersion);
  const degraded: string[] = [];

  try {
    await deps.createCheckRun({ conclusion: result.ok ? 'success' : 'failure', ...s, annotations: notes });
  } catch (e) {
    degraded.push(`check run not written (${(e as Error).message})`);
    deps.warn(`Couldn't write the ${CHECK_NAME} check run (${(e as Error).message}); using workflow annotations instead.`);
    for (const a of notes) deps.annotate(a);
  }

  let changes: ChangesResult | undefined;
  let commentUrl: string | undefined;
  if (deps.changes && deps.upsertComment) {
    changes = deps.changes();
    try {
      commentUrl = await deps.upsertComment(commentBody(result, changes, deps.baseRef, deps.coreVersion));
    } catch (e) {
      degraded.push(`comment not written (${(e as Error).message})`);
      deps.warn(`Couldn't write the PR comment (${(e as Error).message}).`);
    }
  }

  return { ok: result.ok, files: result.files, issues: result.issues.length, changes, commentUrl, degraded };
}
