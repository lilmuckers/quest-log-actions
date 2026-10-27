// The action's runtime: event → plan → modules → job summary + quest-status.
// action.yml has already checked out the data repo and resolved the core.
import * as core from '@actions/core';
import * as github from '@actions/github';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import * as quest from './core.js';
import { createCheckRun, upsertComment, type Annotation } from './github.js';
import { CHECK_NAME, COMMENT_MARKER, runValidate, type ValidateOutcome } from './modules/validate.js';
import { plan as makePlan, type Plan } from './plan.js';
import { parseSecrets } from './secrets.js';
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
  };
}

async function jobSummary(p: Plan, status: QuestStatus, validate?: ValidateOutcome) {
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
  await core.summary.write();
}

export async function run(): Promise<void> {
  let status: QuestStatus | null = null;
  let env: Env | null = null;
  try {
    env = readEnv();
    const secrets = parseSecrets(core.getInput('secrets'), core.setSecret);
    core.info(`Secrets: ${Object.keys(secrets.values).length ? Object.keys(secrets.values).sort().join(', ') : 'none'} (${secrets.ignored.length} non-QUEST_ ignored)`);

    const loaded = loadConfig(env.workspace);
    if (loaded.error) core.warning(loaded.error);
    const p = makePlan(env.event, loaded.config);
    status = newStatus(env.event, env.coreVersion, p);
    for (const m of p.modules) core.info(`${m.name}: ${m.run ? 'runs' : 'skipped'} (${m.reason})`);

    const coreRef: quest.Core = { dir: env.coreDir, version: env.coreVersion };
    let validate: ValidateOutcome | undefined;
    if (p.modules.find((m) => m.name === 'validate')?.run) {
      const w = writer(env);
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

    await jobSummary(p, status, validate);
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
