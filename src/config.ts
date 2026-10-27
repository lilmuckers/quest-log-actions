import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const AUTOMATION_PATH = 'data/automation.json';

/** `data/automation.json` (automation plan §3.2). The core's `quest.py validate` decides validity. */
export interface Automation {
  channel: 'stable' | 'beta';
  schedule: { every: '6h' | '3h' | '1h' | 'off' };
  validate: { enabled: boolean; comment: boolean };
  notify: { enabled: boolean; vapidPublicKey?: string; devices: Device[] };
}

export interface Device {
  id: string;
  label: string;
  timezone: string;
  events: { timebox?: boolean; review?: 'fri' | 'mon' | 'sun' | 'off'; warpZone?: boolean };
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
}

/** A missing file means validate on, everything else off. */
export const DEFAULTS: Automation = {
  channel: 'stable',
  schedule: { every: '3h' },
  validate: { enabled: true, comment: true },
  notify: { enabled: false, devices: [] },
};

export interface LoadedConfig {
  config: Automation;
  /** Whether data/automation.json exists. */
  present: boolean;
  /** Set when the file exists but isn't readable JSON; validate reports the detail. */
  error?: string;
}

/** Reads the config from a checkout, filling each block's missing fields from the defaults. */
export function loadConfig(dir: string): LoadedConfig {
  const path = join(dir, AUTOMATION_PATH);
  if (!existsSync(path)) return { config: DEFAULTS, present: false };
  let raw: Partial<Record<keyof Automation, object>>;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return { config: DEFAULTS, present: true, error: `${AUTOMATION_PATH} is not valid JSON (${(e as Error).message})` };
  }
  return { config: mergeConfig(raw), present: true };
}

export function mergeConfig(raw: Partial<Record<keyof Automation, object>>): Automation {
  const block = <K extends 'schedule' | 'validate' | 'notify'>(k: K): Automation[K] => {
    const v = raw?.[k];
    return { ...DEFAULTS[k], ...(v && typeof v === 'object' && !Array.isArray(v) ? v : {}) } as Automation[K];
  };
  const channel = raw?.channel === ('beta' as unknown) ? 'beta' : 'stable';
  const notify = block('notify');
  return {
    channel,
    schedule: block('schedule'),
    validate: block('validate'),
    notify: { ...notify, devices: Array.isArray(notify.devices) ? notify.devices : [] },
  };
}
