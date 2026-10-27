import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChangesResult, ValidateResult } from '../src/core.js';
import { commentBody, runValidate, type ValidateDeps } from '../src/modules/validate.js';

const ok: ValidateResult = { ok: true, files: 4, issues: [] };
const bad: ValidateResult = {
  ok: false,
  files: 4,
  issues: [
    { file: 'data/p/w/l.json', pointer: '/items/0/status', message: "'nope' is not one of ['todo', 'done']" },
    { file: 'data/gone.json', pointer: '/', message: 'unexpected file' },
  ],
};
const diff: ChangesResult = { added: ['item:p/w/l/new'], changed: [], removed: ['item:p/w/l/old'], unapprovedRemovals: ['item:p/w/l/old'] };

function deps(result: ValidateResult, over: Partial<ValidateDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'val-'));
  mkdirSync(join(dir, 'data/p/w'), { recursive: true });
  writeFileSync(join(dir, 'data/p/w/l.json'), '{\n  "id": "l",\n  "items": [\n    {\n      "id": "a",\n      "status": "nope"\n    }\n  ]\n}\n');
  const log = { checks: [] as any[], comments: [] as string[], annotations: [] as any[], warnings: [] as string[] };
  const d: ValidateDeps = {
    dir,
    coreVersion: '1.0.0',
    validate: () => result,
    createCheckRun: async (r) => void log.checks.push(r),
    annotate: (a) => void log.annotations.push(a),
    warn: (m) => void log.warnings.push(m),
    ...over,
  };
  return { d, log };
}

describe('validate module', () => {
  it('writes a green check run on valid data', async () => {
    const { d, log } = deps(ok);
    const out = await runValidate(d);
    expect(out).toMatchObject({ ok: true, files: 4, issues: 0, degraded: [] });
    expect(log.checks[0]).toMatchObject({ conclusion: 'success', title: '✓ 4 data files valid', annotations: [] });
  });

  it('annotates each issue on its line', async () => {
    const { d, log } = deps(bad);
    const out = await runValidate(d);
    expect(out.ok).toBe(false);
    const [first, second] = log.checks[0].annotations;
    expect(first).toMatchObject({ path: 'data/p/w/l.json', start_line: 6, annotation_level: 'failure', title: '/items/0/status' });
    expect(second).toMatchObject({ path: 'data/gone.json', start_line: 1 });
    expect(log.checks[0].summary).toContain('| `data/p/w/l.json` | `/items/0/status` |');
  });

  it('falls back to workflow annotations when the token cannot write checks (fork PRs)', async () => {
    const { d, log } = deps(bad, { createCheckRun: async () => Promise.reject(new Error('Resource not accessible by integration')) });
    const out = await runValidate(d);
    expect(out.degraded[0]).toMatch(/check run not written/);
    expect(log.annotations).toHaveLength(2);
    expect(log.warnings[0]).toMatch(/workflow annotations/);
  });

  it('upserts a PR comment with the diff when asked', async () => {
    const comments: string[] = [];
    const { d } = deps(ok, { changes: () => diff, baseRef: 'main', upsertComment: async (b) => (comments.push(b), 'https://c') });
    const out = await runValidate(d);
    expect(out.commentUrl).toBe('https://c');
    expect(out.changes).toEqual(diff);
    expect(comments[0]).toContain('**Against `main`:** 1 addition, 0 changes, 1 removal.');
    expect(comments[0]).toContain('`item:p/w/l/old`');
    expect(comments[0]).toContain('[!WARNING]');
  });

  it('skips the comment when there is no comment writer', async () => {
    let asked = false;
    const { d } = deps(ok, { changes: () => ((asked = true), diff) });
    await runValidate(d);
    expect(asked).toBe(false);
  });

  it('caps the listed issues in the comment', () => {
    const many: ValidateResult = { ok: false, files: 1, issues: Array.from({ length: 40 }, (_, i) => ({ file: 'data/x.json', pointer: `/${i}`, message: 'm|x' })) };
    const body = commentBody(many, undefined, undefined, '1.0.0');
    expect(body).toContain('…and 10 more');
    expect(body).toContain('m\\|x');
  });
});
