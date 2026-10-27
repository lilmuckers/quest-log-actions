// The `quest-status` artifact every run uploads (D13). The app reads the latest one through the
// Actions API to show run status and to prompt about expired devices.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan } from './plan.js';

export const STATUS_VERSION = 1;

export interface QuestStatus {
  version: typeof STATUS_VERSION;
  ranAt: string;
  event: string;
  core: { version: string };
  modules: Record<string, { ran: boolean; reason: string; ok?: boolean; detail?: Record<string, unknown> }>;
  /** Pushes sent per device id (notify, v1.1). */
  sent: Record<string, number>;
  /** Device ids whose push endpoint returned 404/410 (notify, v1.1). */
  expiredDevices: string[];
  error?: string;
}

export function newStatus(event: string, coreVersion: string, plan: Plan | null, now = new Date()): QuestStatus {
  return {
    version: STATUS_VERSION,
    ranAt: now.toISOString(),
    event,
    core: { version: coreVersion },
    modules: Object.fromEntries((plan?.modules ?? []).map((m) => [m.name, { ran: false, reason: m.reason }])),
    sent: {},
    expiredDevices: [],
  };
}

/** Writes status.json into `dir`, which the upload-artifact step publishes. */
export function writeStatus(dir: string, status: QuestStatus): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'status.json');
  writeFileSync(path, JSON.stringify(status, null, 2) + '\n');
  return path;
}
