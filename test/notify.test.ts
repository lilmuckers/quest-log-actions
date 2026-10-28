import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Automation, Device } from '../src/config.js';
import type { Timer, TimersResult } from '../src/core.js';
import { timers } from '../src/core.js';
import { isoWeek, lastSlot, loadState, pruneState, runNotify, saveState, type EventContext, type NotifyState, type PrContext, type Sender } from '../src/modules/notify.js';
import { plan } from '../src/plan.js';
import { mergeConfig } from '../src/config.js';

// web-push is mocked: the sender records what it would have sent.
const send = vi.fn<Sender>();
beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({ statusCode: 201 });
});

const SLOTS: TimersResult['reviewSlots'] = {
  fri: { weekday: 5, hour: 14, label: 'Friday afternoon' },
  mon: { weekday: 1, hour: 9, label: 'Monday morning' },
  sun: { weekday: 0, hour: 18, label: 'Sunday evening' },
};

function device(id: string, over: Partial<Device> = {}): Device {
  return {
    id,
    label: id,
    timezone: 'Europe/London',
    events: { timebox: true, review: 'off', warpZone: true },
    subscription: { endpoint: `https://push.example/${id}`, keys: { p256dh: 'p', auth: 'a' } },
    ...over,
  };
}

const notifyConfig = (devices: Device[]): Automation['notify'] => ({ enabled: true, vapidPublicKey: 'BPUB', devices });

function timer(phase: Timer['phase'], phaseSince: string, over: Partial<Timer> = {}): Timer {
  return { key: 'level:sourdough/basics/nail-one-recipe', scope: 'level', project: 'sourdough', world: 'basics', level: 'nail-one-recipe', title: 'Nail one recipe', phase, phaseSince, endsAt: '2026-11-02T00:00:00.000Z', nudge: null, ...over };
}

function scheduled(now: string, list: Timer[] = []): EventContext {
  return { now: new Date(now), timers: { schemaVersion: 1, now, timers: list, reviewSlots: SLOTS } };
}

async function run(devices: Device[], ctx: EventContext, state?: NotifyState) {
  return runNotify({ config: notifyConfig(devices), privateKey: 'PRIV', ctx, state, send, warn: () => {} });
}

const payloads = () => send.mock.calls.map((c) => JSON.parse(c[1]));

describe('notify: timebox', () => {
  it('sends a hurry crossing once; a second run sends nothing', async () => {
    const state: NotifyState = { sent: {} };
    const ctx = scheduled('2026-10-28T12:17:00Z', [timer('hurry', '2026-10-28T10:00:00Z'), timer('ok', '2026-10-20T00:00:00Z', { key: 'level:a/b/c', level: 'c' })]);
    const first = await run([device('phone')], ctx, state);
    expect(first.sent).toEqual({ phone: 1 });
    expect(payloads()[0]).toMatchObject({ url: '#/p/sourdough/basics/nail-one-recipe', tag: 'timebox:sourdough/basics/nail-one-recipe' });
    expect(send.mock.calls[0]![2]).toMatchObject({ TTL: 43200, urgency: 'normal', contentEncoding: 'aes128gcm', vapidDetails: { subject: 'https://tasks.patrick-mckinley.com', publicKey: 'BPUB', privateKey: 'PRIV' } });
    expect(state.sent.phone).toEqual({ 'timebox:sourdough/basics/nail-one-recipe:hurry': '2026-10-28T12:17:00.000Z' });

    send.mockClear();
    const second = await run([device('phone')], scheduled('2026-10-28T15:17:00Z', ctx.timers!.timers), state);
    expect(send).not.toHaveBeenCalled();
    expect(second).toMatchObject({ sent: {}, deduped: 1 });
  });

  it('sends overdue once more, with high urgency, replacing the hurry push', async () => {
    const state: NotifyState = { sent: { phone: { 'timebox:sourdough/basics/nail-one-recipe:hurry': '2026-10-28T12:17:00.000Z' } } };
    await run([device('phone')], scheduled('2026-11-02T03:17:00Z', [timer('overdue', '2026-11-02T00:00:00Z')]), state);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![2].urgency).toBe('high');
    expect(payloads()[0].tag).toBe('timebox:sourdough/basics/nail-one-recipe');
  });

  it('skips stale crossings, unknown scopes, and devices with timebox off', async () => {
    await run([device('phone')], scheduled('2026-10-28T12:00:00Z', [timer('overdue', '2026-10-01T00:00:00Z'), timer('hurry', '2026-10-28T10:00:00Z', { scope: 'world' })]), { sent: {} });
    await run([device('phone', { events: { timebox: false, review: 'off' } })], scheduled('2026-10-28T12:00:00Z', [timer('hurry', '2026-10-28T10:00:00Z')]), { sent: {} });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('notify: review', () => {
  // 2026-10-30 is a Friday. London is on GMT (DST ended 25 Oct); New York is still on EDT (until 1 Nov).
  const london = device('london', { timezone: 'Europe/London', events: { review: 'fri', timebox: false } });
  const newYork = device('ny', { timezone: 'America/New_York', events: { review: 'fri', timebox: false } });

  it('fires at each device’s own Friday 14:00', async () => {
    const state: NotifyState = { sent: {} };
    const a = await run([london, newYork], scheduled('2026-10-30T14:17:00Z'), state);
    expect(a.sent).toEqual({ london: 1 });
    expect(payloads()[0]).toMatchObject({ title: 'Weekly review', url: '#/review', tag: 'review' });

    send.mockClear();
    const b = await run([london, newYork], scheduled('2026-10-30T18:17:00Z'), state);
    expect(b.sent).toEqual({ ny: 1 });
    expect(b.deduped).toBe(1);
    expect(state.sent).toEqual({ london: { 'review:2026-W44': '2026-10-30T14:17:00.000Z' }, ny: { 'review:2026-W44': '2026-10-30T18:17:00.000Z' } });
  });

  it('on a coarse schedule, delivers late but once', async () => {
    const state: NotifyState = { sent: {} };
    // Every 6h at :17, from Friday morning to Saturday evening.
    const runs = ['2026-10-30T05:17:00Z', '2026-10-30T11:17:00Z', '2026-10-30T17:17:00Z', '2026-10-30T23:17:00Z', '2026-10-31T05:17:00Z', '2026-10-31T11:17:00Z', '2026-10-31T17:17:00Z'];
    const sentAt: string[] = [];
    for (const now of runs) {
      const r = await run([london], scheduled(now), state);
      if (r.sent.london) sentAt.push(now);
    }
    expect(sentAt).toEqual(['2026-10-30T17:17:00Z']);
  });

  it('does nothing for review off, and defaults to fri', async () => {
    await run([device('x', { events: { review: 'off' } })], scheduled('2026-10-30T14:17:00Z'), { sent: {} });
    expect(send).not.toHaveBeenCalled();
    await run([device('y', { events: {} })], scheduled('2026-10-30T14:17:00Z'), { sent: {} });
    expect(send).toHaveBeenCalledOnce();
  });

  it('works out slots across DST and the ISO week', () => {
    expect(lastSlot(new Date('2026-10-30T14:00:00Z'), 'Europe/London', 5, 14).toISOString()).toBe('2026-10-30T14:00:00.000Z');
    expect(lastSlot(new Date('2026-10-30T13:59:00Z'), 'Europe/London', 5, 14).toISOString()).toBe('2026-10-23T13:00:00.000Z');
    expect(lastSlot(new Date('2026-10-30T18:00:00Z'), 'America/New_York', 5, 14).toISOString()).toBe('2026-10-30T18:00:00.000Z');
    expect(lastSlot(new Date('2026-11-02T08:00:00Z'), 'Asia/Tokyo', 1, 9).toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(isoWeek({ year: 2027, month: 1, day: 1 })).toBe('2026-W53');
    expect(isoWeek({ year: 2026, month: 11, day: 1 })).toBe('2026-W44');
  });
});

describe('notify: warpZone', () => {
  const pr = (over: Partial<PrContext>): EventContext => ({ now: new Date(), pr: { number: 7, action: 'opened', title: 'Add a level', attachment: false, ok: true, touchesData: true, ...over } });

  it('sends one push for a PR opened, and none for a PR without data changes', async () => {
    const r = await run([device('phone')], pr({}));
    expect(r.sent).toEqual({ phone: 1 });
    expect(payloads()[0]).toEqual({ title: 'New PR #7 in the Warp Zone', body: 'Add a level', url: '#/pr/7', tag: 'pr:7' });
    send.mockClear();
    await run([device('phone')], pr({ touchesData: false }));
    expect(send).not.toHaveBeenCalled();
  });

  it('says "New photo waiting" for an attachment PR', async () => {
    await run([device('phone')], pr({ attachment: true }));
    expect(payloads()[0].title).toBe('📷 New photo waiting');
  });

  it('sends one push for a failing PR, and one when a fix turns it green', async () => {
    await run([device('phone')], pr({ action: 'synchronize', ok: false }));
    expect(payloads()[0].title).toBe('❌ PR #7 failed its check');
    send.mockClear();
    await run([device('phone')], pr({ action: 'synchronize', ok: true, previous: 'failure' }));
    expect(payloads()[0].title).toBe('✅ PR #7 is ready in the Warp Zone');
    send.mockClear();
    await run([device('phone')], pr({ action: 'synchronize', ok: true, previous: 'success' }));
    await run([device('phone')], pr({ action: 'labeled' }));
    await run([device('phone', { events: { warpZone: false } })], pr({}));
    expect(send).not.toHaveBeenCalled();
  });

  it('records a 404/410 device as expired and keeps sending to the rest', async () => {
    send.mockImplementation(async (sub) => {
      if (sub.endpoint.endsWith('/old')) throw Object.assign(new Error('Gone'), { statusCode: 410 });
      return { statusCode: 201 };
    });
    const r = await run([device('old'), device('phone')], pr({ ok: false }));
    expect(r).toMatchObject({ expiredDevices: ['old'], sent: { phone: 1 }, failed: 0 });
  });

  it('counts other failures without recording them as sent, so the next run retries', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('boom'), { statusCode: 500 }));
    const state: NotifyState = { sent: {} };
    const r = await run([device('phone')], scheduled('2026-10-28T12:17:00Z', [timer('hurry', '2026-10-28T10:00:00Z')]), state);
    expect(r).toMatchObject({ failed: 1, sent: {} });
    expect(state.sent).toEqual({});
  });
});

describe('notify: no-ops and state', () => {
  it('sends nothing, with a reason, without a key, a public key or devices', async () => {
    const ctx = scheduled('2026-10-30T14:17:00Z');
    expect(await runNotify({ config: notifyConfig([device('a')]), ctx, send, warn: () => {} })).toMatchObject({ ran: false, reason: expect.stringMatching(/QUEST_VAPID_PRIVATE_KEY/) });
    expect(await runNotify({ config: { enabled: true, devices: [device('a')] }, privateKey: 'k', ctx, send, warn: () => {} })).toMatchObject({ ran: false, reason: expect.stringMatching(/vapidPublicKey/) });
    expect(await runNotify({ config: notifyConfig([]), privateKey: 'k', ctx, send, warn: () => {} })).toMatchObject({ ran: false, reason: expect.stringMatching(/no devices/) });
    expect(send).not.toHaveBeenCalled();
  });

  it('saves, reloads and prunes entries after 30 days', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'notify-')), 'q/state.json');
    expect(loadState(path)).toEqual({ sent: {} });
    saveState(path, { sent: { a: { old: '2026-09-01T00:00:00Z', new: '2026-10-20T00:00:00Z' }, b: { old: '2026-09-01T00:00:00Z' } } });
    expect(pruneState(loadState(path), new Date('2026-10-28T00:00:00Z'))).toEqual({ sent: { a: { new: '2026-10-20T00:00:00Z' } } });
  });

  it('plans notify for scheduled, dispatch and PR runs once it has devices', () => {
    const cfg = mergeConfig({ notify: notifyConfig([device('a')]) } as never);
    for (const e of ['schedule', 'workflow_dispatch', 'pull_request']) expect(plan(e, cfg).modules.find((m) => m.name === 'notify')?.run).toBe(true);
    expect(plan('push', cfg).modules.find((m) => m.name === 'notify')).toMatchObject({ run: false, reason: 'not run on push' });
    expect(plan('schedule', mergeConfig({ notify: { enabled: true } } as never)).modules.find((m) => m.name === 'notify')).toMatchObject({ run: false, reason: 'notify.vapidPublicKey is not set' });
  });

  it('parses quest.py timers output', () => {
    const out = { schemaVersion: 1, now: '2026-10-28T00:00:00.000Z', timers: [], reviewSlots: SLOTS };
    let args: string[] = [];
    const r = timers({ dir: '/c', version: 'x' }, '/d', new Date('2026-10-28T00:00:00Z'), (a) => ((args = a), { status: 0, stdout: JSON.stringify(out), stderr: '' }));
    expect(args).toEqual(['timers', '/d', '--json', '--now', '2026-10-28T00:00:00.000Z']);
    expect(r).toEqual(out);
  });
});
