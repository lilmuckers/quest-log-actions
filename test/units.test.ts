import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, loadConfig, mergeConfig } from '../src/config.js';
import { changes, CoreFailed, validate } from '../src/core.js';
import { pointerLine } from '../src/json-line.js';
import { plan } from '../src/plan.js';
import { readSecrets } from '../src/secrets.js';
import { newStatus } from '../src/status.js';

describe('secrets', () => {
  it('reads the named secrets from the environment and masks them', () => {
    const masked: string[] = [];
    const s = readSecrets({ QUEST_VAPID_PRIVATE_KEY: 'k1', QUEST_CORE_PATH: '/tmp/core', OTHER: 'no' }, (v) => masked.push(v));
    expect(s.values).toEqual({ QUEST_VAPID_PRIVATE_KEY: 'k1' });
    expect(masked).toEqual(['k1']);
    expect(s.missing).toEqual([]);
  });
  it('lists names that arrived empty (unset, older stub or fork PR)', () => {
    expect(readSecrets({ QUEST_VAPID_PRIVATE_KEY: '' }, () => {})).toEqual({ values: {}, missing: ['QUEST_VAPID_PRIVATE_KEY'] });
    expect(readSecrets({}, () => {})).toEqual({ values: {}, missing: ['QUEST_VAPID_PRIVATE_KEY'] });
  });
});

describe('config', () => {
  it('defaults to validate on, everything else off when the file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    expect(loadConfig(dir)).toEqual({ config: DEFAULTS, present: false });
  });
  it('fills each block from the defaults', () => {
    const c = mergeConfig({ validate: { comment: false }, notify: { enabled: true } } as never);
    expect(c.validate).toEqual({ enabled: true, comment: false });
    expect(c.notify).toEqual({ enabled: true, devices: [] });
    expect(c.schedule).toEqual({ every: '3h' });
    expect(mergeConfig({ channel: 'beta' } as never).channel).toBe('beta');
  });
  it('reports a broken file instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data/automation.json'), '{ nope');
    const r = loadConfig(dir);
    expect(r.present).toBe(true);
    expect(r.error).toMatch(/not valid JSON/);
    expect(r.config).toEqual(DEFAULTS);
  });
});

describe('plan', () => {
  const run = (event: string, config = DEFAULTS) => Object.fromEntries(plan(event, config).modules.map((m) => [m.name, m.run]));
  it('validates on pull_request, push and dispatch', () => {
    expect(run('pull_request').validate).toBe(true);
    expect(run('push').validate).toBe(true);
    expect(run('workflow_dispatch').validate).toBe(true);
    expect(run('schedule').validate).toBe(false);
  });
  it('honours validate.enabled and validate.comment', () => {
    expect(run('push', mergeConfig({ validate: { enabled: false } } as never)).validate).toBe(false);
    expect(plan('pull_request', DEFAULTS).comment).toBe(true);
    expect(plan('push', DEFAULTS).comment).toBe(false);
    expect(plan('pull_request', mergeConfig({ validate: { comment: false } } as never)).comment).toBe(false);
  });
  it('never runs notify yet, and says why', () => {
    const p = plan('schedule', mergeConfig({ notify: { enabled: true } } as never));
    expect(p.modules.find((m) => m.name === 'notify')).toEqual({ name: 'notify', run: false, reason: 'notify arrives in v1.1' });
  });
  it('seeds quest-status from the plan', () => {
    const s = newStatus('push', '1.0.0', plan('push', DEFAULTS), new Date('2026-10-27T10:00:00Z'));
    expect(s).toMatchObject({ ranAt: '2026-10-27T10:00:00.000Z', event: 'push', core: { version: '1.0.0' }, sent: {}, expiredDevices: [] });
    expect(s.modules.validate).toEqual({ ran: false, reason: 'push' });
  });
});

describe('core output', () => {
  const core = { dir: '/core', version: '1.0.0' };
  const reply = (status: number, stdout: string, stderr = '') => () => ({ status, stdout, stderr });
  it('treats validate exit 1 as a result', () => {
    const r = validate(core, '.', reply(1, JSON.stringify({ ok: false, files: 2, issues: [{ file: 'data/a.json', pointer: '/x', message: 'bad' }] })));
    expect(r.issues).toHaveLength(1);
  });
  it('fails clearly on other exits or missing JSON', () => {
    expect(() => validate(core, '.', reply(2, '', 'error: No data/ folder in /x'))).toThrow(CoreFailed);
    expect(() => validate(core, '.', reply(2, '', 'error: No data/ folder in /x'))).toThrow(/No data\/ folder/);
    expect(() => validate(core, '.', reply(0, '✓ 3 data file(s) valid'))).toThrow(/printed no JSON/);
  });
  it('asks changes for --json --warn', () => {
    let seen: string[] = [];
    changes(core, 'dir', 'origin/main', (a) => ((seen = a), { status: 0, stdout: '{"added":[],"changed":[],"removed":[],"unapprovedRemovals":[]}', stderr: '' }));
    expect(seen).toEqual(['changes', '--git', 'origin/main', 'dir', '--json', '--warn']);
  });
});

describe('pointerLine', () => {
  const text = JSON.stringify({ id: 'l', items: [{ id: 'a', status: 'todo' }, { id: 'b', notes: 'x\ny', status: 'nope' }] }, null, 2);
  const lineOf = (needle: string) => text.split('\n').findIndex((l) => l.includes(needle)) + 1;
  it('finds nested values', () => {
    expect(pointerLine(text, '/items/1/status')).toBe(lineOf('"nope"'));
    expect(pointerLine(text, '/items/0')).toBe(lineOf('"id": "a"') - 1);
    expect(pointerLine(text, '/id')).toBe(2);
    expect(pointerLine(text, '')).toBe(1);
  });
  it('falls back to the deepest parent found', () => {
    expect(pointerLine(text, '/items/1/missing')).toBe(lineOf('"id": "b"') - 1);
    expect(pointerLine('{ "a": ', '/a/b')).toBe(1);
  });
});
