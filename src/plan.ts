import type { Automation } from './config.js';
import { READ_AUTO_LABEL, READ_CLAUDE_LABEL } from './modules/read.js';

export type ModuleName = 'validate' | 'notify' | 'read';

export interface ModulePlan {
  name: ModuleName;
  run: boolean;
  /** Why it runs or not; shown in the job summary and quest-status. */
  reason: string;
}

export interface Plan {
  event: string;
  modules: ModulePlan[];
  /** Upsert the PR comment listing adds, changes and removals. */
  comment: boolean;
}

const VALIDATE_EVENTS = new Set(['pull_request', 'push', 'workflow_dispatch']);
const NOTIFY_EVENTS = new Set(['schedule', 'workflow_dispatch', 'pull_request']);

/** Which modules run for an event, and why. Pure: the event name, config and PR labels in, the plan out. */
export function plan(event: string, config: Automation, labels: string[] = []): Plan {
  const validate: ModulePlan = !VALIDATE_EVENTS.has(event)
    ? { name: 'validate', run: false, reason: `not run on ${event}` }
    : !config.validate.enabled
      ? { name: 'validate', run: false, reason: 'validate.enabled is false' }
      : { name: 'validate', run: true, reason: `${event}` };

  // Pushes go to devices; with none, or no public key, there's nothing to send to.
  const notify: ModulePlan = !NOTIFY_EVENTS.has(event)
    ? { name: 'notify', run: false, reason: `not run on ${event}` }
    : !config.notify.enabled
      ? { name: 'notify', run: false, reason: 'notify.enabled is false' }
      : !config.notify.vapidPublicKey
        ? { name: 'notify', run: false, reason: 'notify.vapidPublicKey is not set' }
        : !config.notify.devices.length
          ? { name: 'notify', run: false, reason: 'no devices in notify.devices' }
          : { name: 'notify', run: true, reason: event === 'pull_request' ? 'pull_request (warpZone)' : `${event} (timebox, review)` };

  // The app adds a label only when the repo's reader is one of these, so a photo added then is
  // still read if the setting has since changed.
  const readLabel = [READ_AUTO_LABEL, READ_CLAUDE_LABEL].find((l) => labels.includes(l));
  const read: ModulePlan = event !== 'pull_request'
    ? { name: 'read', run: false, reason: `not run on ${event}` }
    : !readLabel
      ? { name: 'read', run: false, reason: 'no reader label' }
      : { name: 'read', run: true, reason: readLabel };

  return { event, modules: [validate, notify, read], comment: event === 'pull_request' && validate.run && config.validate.comment };
}
