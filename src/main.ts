// The action's runtime: event → plan → modules → job summary + quest-status.
// action.yml has already checked out the data repo and resolved the core.
import * as core from '@actions/core';
import * as github from '@actions/github';
import webpush from 'web-push';
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import * as quest from './core.js';
import { checkConclusion, createCheckRun, upsertComment, type Annotation } from './github.js';
import { loadState, pruneState, runNotify, saveState, type NotifyOutcome, type PrContext, type Sender } from './modules/notify.js';
import { CHECK_NAME, COMMENT_MARKER, runValidate, type ValidateOutcome } from './modules/validate.js';
import { plan as makePlan, type Plan } from './plan.js';
import { readSecrets } from './secrets.js';
import { newStatus, writeStatus, type QuestStatus } from './status.js';

interface Env {
  event: string;
  payload: Record<string, any>;
  workspace: string;
  coreDir: string;
  coreVersion: string;
  statusDir: string;
  token: string;
  /** Record API writes to this file instead of calling GitHub (CI fixtures). */
  dryRunOut?: string;
  baseRefOverride?: string;
  /** Dedup state file, restored from and saved to the Actions cache on scheduled and dispatch runs. */
  notifyState: string;
  /** The run time `quest.py timers` works at (QUEST_NOW overrides it for fixtures). */
  now: Date;
}

function readEnv(): Env {
  const need = (name: string) => {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is not set; run this through action.yml.`);
    return v;
  };
  const eventPath = process.env.GITHUB_EVENT_PATH;
  return {
    event: need('GITHUB_EVENT_NAME'),
    payload: eventPath ? JSON.parse(readFileSync(eventPath, 'utf8')) : {},
    workspace: process.env.QUEST_DATA_DIR || need('GITHUB_WORKSPACE'),
    coreDir: need('QUEST_CORE_PATH'),
    coreVersion: need('QUEST_CORE_VERSION'),
    statusDir: process.env.QUEST_STATUS_DIR || join(process.env.RUNNER_TEMP ?? '/tmp', 'quest-status'),
    token: core.getInput('token'),
    dryRunOut: process.env.QUEST_DRY_RUN_OUT || undefined,
    baseRefOverride: process.env.QUEST_BASE_REF || undefined,
    notifyState: process.env.QUEST_NOTIFY_STATE || join(process.env.RUNNER_TEMP ?? '/tmp', 'quest-notify', 'state.json'),
    now: process.env.QUEST_NOW ? new Date(process.env.QUEST_NOW) : new Date(),
  };
}

/** API writes, real or recorded for a dry run. */
function writer(env: Env) {
  if (env.dryRunOut) {
    const out = env.dryRunOut;
    const record = (kind: string, data: unknown) => appendFileSync(out, JSON.stringify({ kind, data }) + '\n');
    return {
      checkRun: async (run: object) => record('checkRun', run),
      comment: async (body: string) => (record('comment', body), 'dry-run'),
      previousConclusion: async (): Promise<string | undefined> => undefined,
      // Endpoints ending in /gone answer 410, so fixtures can check expiredDevices.
      send: (async (subscription, payload, options) => {
        if (subscription.endpoint.endsWith('/gone')) throw Object.assign(new Error('Gone'), { statusCode: 410 });
        record('push', { endpoint: subscription.endpoint, payload: JSON.parse(payload), urgency: options.urgency, TTL: options.TTL });
        return { statusCode: 201 };
      }) as Sender,
    };
  }
  const octokit = github.getOctokit(env.token);
  const repo = github.context.repo;
  const headSha = env.payload.pull_request?.head?.sha ?? github.context.sha;
  return {
    checkRun: async (run: { conclusion: 'success' | 'failure'; title: string; summary: string; annotations: Annotation[] }) => {
      await createCheckRun(octokit, repo, { name: CHECK_NAME, headSha, ...run });
    },
    comment: (body: string) => upsertComment(octokit, repo, env.payload.pull_request.number, COMMENT_MARKER, body),
    previousConclusion: () => checkConclusion(octokit, repo, env.payload.before, CHECK_NAME),
    send: webpush.sendNotification as unknown as Sender,
  };
}

/** Whether a PR changes anything under data/ against its base (true when git can't say). */
function prTouchesData(env: Env): boolean {
  const base = env.baseRefOverride ?? `origin/${env.payload.pull_request.base.ref}`;
  const r = spawnSync('git', ['-C', env.workspace, 'diff', '--name-only', `${base}...HEAD`, '--', 'data/'], { encoding: 'utf8' });
  return r.status !== 0 || r.stdout.trim() !== '';
}

async function prContext(env: Env, validate: ValidateOutcome | undefined, previousConclusion: () => Promise<string | undefined>): Promise<PrContext> {
  const pr = env.payload.pull_request;
  const action: string = env.payload.action ?? 'opened';
  let previous: PrContext['previous'];
  if (action === 'synchronize' && validate?.ok && env.payload.before) {
    try {
      const c = await previousConclusion();
      if (c === 'success' || c === 'failure') previous = c;
    } catch (e) {
      core.warning(`Couldn't read the previous ${CHECK_NAME} result (${(e as Error).message}).`);
    }
  }
  return {
    number: pr.number,
    action,
    title: pr.title ?? `PR #${pr.number}`,
    attachment: String(pr.head?.ref ?? '').startsWith('quest/attach/') || (pr.labels ?? []).some((l: { name?: string }) => l.name === 'quest:attachment'),
    ok: validate?.ok,
    previous,
    touchesData: prTouchesData(env),
  };
}

async function jobSummary(p: Plan, status: QuestStatus, validate?: ValidateOutcome, notify?: NotifyOutcome) {
  const rows = p.modules.map((m) => [m.name, status.modules[m.name]?.ran ? 'ran' : 'skipped', status.modules[m.name]?.reason ?? m.reason]);
  core.summary
    .addHeading('Quest Log', 2)
    .addRaw(`Event \`${p.event}\` · core ${status.core.version}`, true)
    .addTable([[{ data: 'Module', header: true }, { data: 'Result', header: true }, { data: 'Why', header: true }], ...rows]);
  if (validate) {
    core.summary.addRaw(validate.ok ? `✓ ${validate.files} data file(s) valid` : `✗ ${validate.issues} issue(s) found`, true);
    if (validate.changes) {
      const c = validate.changes;
      core.summary.addRaw(`Changes: ${c.added.length} added, ${c.changed.length} changed, ${c.removed.length} removed`, true);
    }
    for (const d of validate.degraded) core.summary.addRaw(`⚠ ${d}`, true);
  }
  if (notify?.ran) {
    const sent = Object.values(notify.sent).reduce((a, b) => a + b, 0);
    core.summary.addRaw(`Push: ${sent} sent, ${notify.deduped} already sent before, ${notify.failed} failed`, true);
    if (notify.expiredDevices.length) core.summary.addRaw(`⚠ Stopped receiving pushes: ${notify.expiredDevices.join(', ')}`, true);
  }
  await core.summary.write();
}

export async function run(): Promise<void> {
  let status: QuestStatus | null = null;
  let env: Env | null = null;
  try {
    env = readEnv();
    const secrets = readSecrets(process.env, core.setSecret);
    core.info(`Secrets: ${Object.keys(secrets.values).join(', ') || 'none'}${secrets.missing.length ? ` (not passed: ${secrets.missing.join(', ')})` : ''}`);

    const loaded = loadConfig(env.workspace);
    if (loaded.error) core.warning(loaded.error);
    const p = makePlan(env.event, loaded.config);
    status = newStatus(env.event, env.coreVersion, p);
    for (const m of p.modules) core.info(`${m.name}: ${m.run ? 'runs' : 'skipped'} (${m.reason})`);

    const coreRef: quest.Core = { dir: env.coreDir, version: env.coreVersion };
    const w = writer(env);
    let validate: ValidateOutcome | undefined;
    if (p.modules.find((m) => m.name === 'validate')?.run) {
      const base = env.baseRefOverride ?? (env.payload.pull_request ? `origin/${env.payload.pull_request.base.ref}` : undefined);
      validate = await runValidate({
        dir: env.workspace,
        coreVersion: env.coreVersion,
        validate: () => quest.validate(coreRef, env!.workspace),
        changes: p.comment && base ? () => quest.changes(coreRef, env!.workspace, base) : undefined,
        baseRef: base?.replace(/^origin\//, ''),
        createCheckRun: w.checkRun,
        upsertComment: p.comment ? w.comment : undefined,
        annotate: (a) => core.error(a.message, { file: a.path, startLine: a.start_line, title: a.title }),
        warn: (m) => core.warning(m),
      });
      status.modules.validate = {
        ran: true,
        reason: status.modules.validate!.reason,
        ok: validate.ok,
        detail: { files: validate.files, issues: validate.issues, ...(validate.degraded.length ? { degraded: validate.degraded } : {}) },
      };
    }

    let notify: NotifyOutcome | undefined;
    if (p.modules.find((m) => m.name === 'notify')?.run) {
      const e = env;
      const scheduled = e.event !== 'pull_request';
      const state = scheduled ? pruneState(loadState(e.notifyState), e.now) : undefined;
      notify = await runNotify({
        config: loaded.config.notify,
        privateKey: secrets.values.QUEST_VAPID_PRIVATE_KEY,
        ctx: {
          now: e.now,
          timers: scheduled ? quest.timers(coreRef, e.workspace, e.now) : undefined,
          pr: scheduled ? undefined : await prContext(e, validate, w.previousConclusion),
        },
        state,
        send: w.send,
        warn: (m) => core.warning(m),
      });
      if (state) {
        saveState(e.notifyState, state);
        core.setOutput('notify-state', 'saved');
      }
      status.sent = notify.sent;
      status.expiredDevices = notify.expiredDevices;
      status.modules.notify = {
        ran: notify.ran,
        reason: notify.reason ?? status.modules.notify!.reason,
        ok: notify.failed === 0,
        detail: { sent: Object.values(notify.sent).reduce((a, b) => a + b, 0), deduped: notify.deduped, failed: notify.failed, expired: notify.expiredDevices.length },
      };
      if (notify.reason) core.info(`notify: nothing sent (${notify.reason})`);
      for (const id of notify.expiredDevices) core.warning(`Device ${id} stopped receiving pushes (404/410). Remove it in Settings → Automation.`);
    }

    await jobSummary(p, status, validate, notify);
    if (validate && !validate.ok) core.setFailed(`${validate.issues} issue(s) in the quest data. See the ${CHECK_NAME} check.`);
  } catch (e) {
    const message = (e as Error).message;
    if (status) status.error = message;
    core.setFailed(message);
  } finally {
    if (env) {
      const s = status ?? { ...newStatus(env.event, env.coreVersion, null), error: 'failed before planning' };
      writeStatus(env.statusDir, s);
    }
  }
}

await run();
