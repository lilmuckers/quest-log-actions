// The notify module: Web Push to the devices in data/automation.json (automation plan §3.4).
// Scheduled and dispatch runs read the core's `quest.py timers` for time-box crossings and
// review slots, and de-dupe against state kept in the Actions cache. PR runs send Warp Zone
// pushes, which need no dedup: each fires once per head sha. The data rules come from the core
// (D8); this file only holds the policy: devices, timezones, event toggles, dedup and sending.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Automation, Device } from '../config.js';
import type { Timer, TimersResult } from '../core.js';

export const SUBJECT = 'https://tasks.patrick-mckinley.com';
export const TTL = 12 * 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Dedup entries older than this are dropped. Longer than any window below, so nothing re-sends. */
export const PRUNE_MS = 30 * DAY_MS;
/** A crossing older than this isn't news (first run after turning push on, or a lost cache). */
export const CROSSING_WINDOW_MS = 7 * DAY_MS;
/** A review slot is still worth a push this long after it passed (late or coarse schedules). */
export const REVIEW_WINDOW_MS = DAY_MS;

export interface Payload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export interface Push {
  /** Dedup key; scheduled events only. */
  key?: string;
  payload: Payload;
  urgency: 'normal' | 'high';
}

/** What a PR run knows, for warpZone. */
export interface PrContext {
  number: number;
  action: string;
  title: string;
  attachment: boolean;
  /** The validate result for this head sha; absent when validate didn't run. */
  ok?: boolean;
  /** The validate conclusion on the previous head (synchronize only), to spot a fix. */
  previous?: 'success' | 'failure';
  /** Whether the PR changes anything under data/. */
  touchesData: boolean;
}

export interface EventContext {
  now: Date;
  /** Present on scheduled and dispatch runs. */
  timers?: TimersResult;
  /** Present on pull_request runs. */
  pr?: PrContext;
}

/** One function per event: the pushes it wants for one device. Later events slot in here. */
export const EVENTS = {
  timebox: (ctx: EventContext, device: Device): Push[] => {
    if (!ctx.timers || device.events?.timebox === false) return [];
    return ctx.timers.timers.filter((t) => isCrossing(t, ctx.now)).map(timeboxPush);
  },
  review: (ctx: EventContext, device: Device): Push[] => {
    const day = device.events?.review ?? 'fri';
    const slot = ctx.timers?.reviewSlots[day];
    if (!slot || day === 'off') return [];
    const at = lastSlot(ctx.now, device.timezone, slot.weekday, slot.hour);
    if (ctx.now.getTime() - at.getTime() >= REVIEW_WINDOW_MS) return [];
    const week = isoWeek(localParts(at, device.timezone));
    return [{ key: `review:${week}`, urgency: 'normal', payload: { title: 'Weekly review', body: `${slot.label}: time to look back at the week and pick what's next.`, url: '#/review', tag: 'review' } }];
  },
  warpZone: (ctx: EventContext, device: Device): Push[] => {
    const pr = ctx.pr;
    if (!pr || device.events?.warpZone === false) return [];
    const push = (title: string, body: string): Push[] => [{ urgency: 'normal', payload: { title, body, url: `#/pr/${pr.number}`, tag: `pr:${pr.number}` } }];
    if (pr.action === 'opened' || pr.action === 'reopened') {
      if (!pr.touchesData) return [];
      if (pr.ok === false) return push(`❌ PR #${pr.number} failed its check`, pr.title);
      return push(pr.attachment ? '📷 New photo waiting' : `New PR #${pr.number} in the Warp Zone`, pr.title);
    }
    if (pr.action === 'synchronize') {
      if (pr.ok === false) return push(`❌ PR #${pr.number} failed its check`, pr.title);
      if (pr.ok === true && pr.previous === 'failure') return push(`✅ PR #${pr.number} is ready in the Warp Zone`, pr.title);
    }
    return [];
  },
} satisfies Record<string, (ctx: EventContext, device: Device) => Push[]>;

export type EventName = keyof typeof EVENTS;

function isCrossing(t: Timer, now: Date): boolean {
  if (t.scope !== 'level' || (t.phase !== 'hurry' && t.phase !== 'overdue')) return false;
  return now.getTime() - Date.parse(t.phaseSince) < CROSSING_WINDOW_MS;
}

function timeboxPush(t: Timer): Push {
  const overdue = t.phase === 'overdue';
  const name = t.title || t.level;
  const e = encodeURIComponent;
  return {
    key: `timebox:${t.project}/${t.world}/${t.level}:${t.phase}`,
    urgency: overdue ? 'high' : 'normal',
    payload: {
      title: overdue ? `⏰ ${name}: time-box blown` : `⏳ ${name}: time's nearly up`,
      body: t.nudge?.text ?? (overdue ? 'Hurry up! Time-box blown.' : 'Under 25% of time left — ship the MVP or cut scope.'),
      url: `#/p/${e(t.project)}/${e(t.world)}/${e(t.level)}`,
      // Same tag for both phases, so "overdue" replaces "hurry" on the device.
      tag: `timebox:${t.project}/${t.world}/${t.level}`,
    },
  };
}

// ---- timezones -------------------------------------------------------------------------------

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Wall-clock parts of `at` in `timeZone`. Throws RangeError for an unknown zone. */
export function localParts(at: Date, timeZone: string): LocalParts {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
    formatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return { year: +p.year!, month: +p.month!, day: +p.day!, hour: +p.hour!, minute: +p.minute!, weekday: WEEKDAYS.indexOf(p.weekday!) };
}

/** The instant a wall-clock time in `timeZone` happens (the later one across a DST change). */
function zonedInstant(year: number, month: number, day: number, hour: number, timeZone: string): Date {
  const wall = Date.UTC(year, month - 1, day, hour);
  let t = wall;
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(t), timeZone);
    const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - t;
    const next = wall - offset;
    if (next === t) break;
    t = next;
  }
  return new Date(t);
}

/** The most recent slot (`weekday` at `hour`:00 in `timeZone`) at or before `now`. */
export function lastSlot(now: Date, timeZone: string, weekday: number, hour: number): Date {
  const p = localParts(now, timeZone);
  let back = (p.weekday - weekday + 7) % 7;
  if (back === 0 && p.hour < hour) back = 7;
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day - back));
  return zonedInstant(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hour, timeZone);
}

/** ISO week of a calendar date, e.g. 2026-W44. */
export function isoWeek(p: { year: number; month: number; day: number }): string {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - jan1) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ---- dedup state -----------------------------------------------------------------------------

/** `{ sent: { [deviceId]: { [key]: isoTime } } }`, kept in the Actions cache (§3.4). */
export interface NotifyState {
  sent: Record<string, Record<string, string>>;
}

export function loadState(path: string): NotifyState {
  if (!existsSync(path)) return { sent: {} };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return raw && typeof raw.sent === 'object' && raw.sent ? { sent: raw.sent } : { sent: {} };
  } catch {
    return { sent: {} };
  }
}

/** Drops entries older than PRUNE_MS and devices with none left. */
export function pruneState(state: NotifyState, now: Date): NotifyState {
  const sent: NotifyState['sent'] = {};
  for (const [device, keys] of Object.entries(state.sent)) {
    const kept = Object.entries(keys).filter(([, at]) => now.getTime() - Date.parse(at) < PRUNE_MS);
    if (kept.length) sent[device] = Object.fromEntries(kept);
  }
  return { sent };
}

export function saveState(path: string, state: NotifyState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state) + '\n');
}

// ---- running ---------------------------------------------------------------------------------

export interface SendOptions {
  TTL: number;
  urgency: 'normal' | 'high';
  contentEncoding: 'aes128gcm';
  vapidDetails: { subject: string; publicKey: string; privateKey: string };
}

/** web-push's sendNotification: resolves with the status, rejects with `statusCode` on HTTP errors. */
export type Sender = (subscription: Device['subscription'], payload: string, options: SendOptions) => Promise<{ statusCode: number }>;

export interface NotifyDeps {
  config: Automation['notify'];
  privateKey?: string;
  ctx: EventContext;
  /** Present on scheduled and dispatch runs: the dedup state, updated in place. */
  state?: NotifyState;
  send: Sender;
  warn(message: string): void;
}

export interface NotifyOutcome {
  ran: boolean;
  /** Why nothing was sent, when that's not just "nothing due". */
  reason?: string;
  sent: Record<string, number>;
  expiredDevices: string[];
  /** Pushes held back because the dedup state had them. */
  deduped: number;
  failed: number;
}

/** Runs every event for every device and sends what's due and not yet sent. */
export async function runNotify(deps: NotifyDeps): Promise<NotifyOutcome> {
  const out: NotifyOutcome = { ran: false, sent: {}, expiredDevices: [], deduped: 0, failed: 0 };
  const { config, privateKey } = deps;
  if (!config.vapidPublicKey) return { ...out, reason: 'notify.vapidPublicKey is not set' };
  if (!config.devices.length) return { ...out, reason: 'no devices in notify.devices' };
  if (!privateKey) return { ...out, reason: 'the QUEST_VAPID_PRIVATE_KEY secret is not set (or not passed on fork PRs)' };
  out.ran = true;

  const now = deps.ctx.now;
  const vapidDetails = { subject: SUBJECT, publicKey: config.vapidPublicKey, privateKey };
  for (const device of config.devices) {
    let pushes: Push[];
    try {
      pushes = (Object.keys(EVENTS) as EventName[]).flatMap((name) => EVENTS[name](deps.ctx, device));
    } catch (e) {
      deps.warn(`Skipped device ${device.id}: ${(e as Error).message}`);
      out.failed++;
      continue;
    }
    const seen = deps.state?.sent[device.id] ?? {};
    for (const push of pushes) {
      if (push.key && deps.state && seen[push.key]) {
        out.deduped++;
        continue;
      }
      try {
        await deps.send(device.subscription, JSON.stringify(push.payload), { TTL, urgency: push.urgency, contentEncoding: 'aes128gcm', vapidDetails });
        out.sent[device.id] = (out.sent[device.id] ?? 0) + 1;
        if (push.key && deps.state) (deps.state.sent[device.id] ??= {})[push.key] = now.toISOString();
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          out.expiredDevices.push(device.id);
          break;
        }
        out.failed++;
        deps.warn(`Push to ${device.id} failed${status ? ` (${status})` : ''}: ${(e as Error).message}`);
      }
    }
  }
  return out;
}
