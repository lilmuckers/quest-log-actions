// Runs the built action (dist/) against every fixture with a synthetic event payload, records
// the API writes (QUEST_DRY_RUN_OUT) and checks them against the fixture's expect.json.
//   node scripts/run-fixtures.mjs --core-source ../gamify-todo   core from a gamify-todo checkout
//   node scripts/run-fixtures.mjs --core DIR                     core already unpacked (quest.py + schema/)
//   node scripts/run-fixtures.mjs --live                         core resolved from the live Pages pointer
// Also checks the contract with the core's stubSample: every `with:` key it uses is an input here.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const fixtures = join(root, 'fixtures');
const args = process.argv.slice(2);
const opt = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const work = mkdtempSync(join(tmpdir(), 'quest-fixtures-'));
const SECRET = 'fixture-secret-value-123';

function resolveCore() {
  if (opt('core')) return { dir: resolve(opt('core')), version: 'local' };
  if (opt('core-source')) {
    const src = resolve(opt('core-source'));
    const dir = join(work, 'core');
    mkdirSync(dir, { recursive: true });
    cpSync(join(src, 'skills/quest-log/scripts/quest.py'), join(dir, 'quest.py'));
    cpSync(join(src, 'schema'), join(dir, 'schema'), { recursive: true });
    const sha = spawnSync('git', ['-C', src, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    return { dir, version: `source@${sha || 'unknown'}` };
  }
  if (args.includes('--live')) {
    const out = join(work, 'resolve-output');
    writeFileSync(out, '');
    const env = { ...process.env, RUNNER_TEMP: work, GITHUB_OUTPUT: out };
    delete env.QUEST_CORE_DIR;
    for (const step of ['pointer', 'install']) {
      const r = spawnSync('node', [join(root, 'dist/resolve.mjs'), step], { env, encoding: 'utf8' });
      process.stdout.write(r.stdout);
      if (r.status !== 0 || /::error::/.test(r.stdout)) throw new Error(`resolve ${step} failed:\n${r.stdout}${r.stderr}`);
    }
    const outputs = Object.fromEntries([...readFileSync(out, 'utf8').matchAll(/^(\w+)<<(\S+)\n([\s\S]*?)\n\2$/gm)].map((m) => [m[1], m[3]]));
    return { dir: outputs.dir, version: outputs.version };
  }
  throw new Error('pass --core DIR, --core-source CHECKOUT or --live');
}

/** A git repo holding the fixture's tree, with `base`'s tree as the parent commit on main. */
function makeRepo(name, expect) {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  const copy = (from) => {
    for (const f of readdirSync(dir)) if (f !== '.git') rmSync(join(dir, f), { recursive: true, force: true });
    for (const f of readdirSync(from)) if (f !== 'expect.json') cpSync(join(from, f), join(dir, f), { recursive: true });
  };
  if (expect.base) {
    copy(join(fixtures, expect.base));
    git('add', '-A');
    git('commit', '-qm', 'base');
    git('checkout', '-qb', 'pr');
  }
  copy(join(fixtures, name));
  git('add', '-A');
  git('commit', '-qm', 'head', '--allow-empty');
  return { dir, sha: git('rev-parse', 'HEAD').trim() };
}

function runFixture(name, core) {
  const expect = JSON.parse(readFileSync(join(fixtures, name, 'expect.json'), 'utf8'));
  const repo = makeRepo(name, expect);
  const out = join(work, `${name}.calls.jsonl`);
  const statusDir = join(work, `${name}-status`);
  const eventPath = join(work, `${name}.event.json`);
  const payload = expect.event === 'pull_request' ? { pull_request: { number: 1, head: { sha: repo.sha }, base: { ref: 'main' } } } : { after: repo.sha };
  writeFileSync(eventPath, JSON.stringify(payload));
  const summary = join(work, `${name}.summary.md`);
  writeFileSync(summary, '');
  const r = spawnSync('node', [join(root, 'dist/index.mjs')], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GITHUB_EVENT_NAME: expect.event,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_WORKSPACE: repo.dir,
      GITHUB_REPOSITORY: 'owner/data',
      GITHUB_SHA: repo.sha,
      GITHUB_STEP_SUMMARY: summary,
      RUNNER_TEMP: work,
      QUEST_CORE_PATH: core.dir,
      QUEST_CORE_VERSION: core.version,
      QUEST_STATUS_DIR: statusDir,
      QUEST_DRY_RUN_OUT: out,
      QUEST_BASE_REF: 'main',
      INPUT_TOKEN: 'unused-in-dry-run',
      INPUT_SECRETS: JSON.stringify({ QUEST_FOO: SECRET, OTHER_BAR: 'not-kept', github_token: 'x' }),
    },
  });
  const log = r.stdout + r.stderr;
  const calls = existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const check = calls.find((c) => c.kind === 'checkRun')?.data;
  const comment = calls.find((c) => c.kind === 'comment')?.data;
  const status = existsSync(join(statusDir, 'status.json')) ? JSON.parse(readFileSync(join(statusDir, 'status.json'), 'utf8')) : null;

  const problems = [];
  const want = (cond, msg) => cond || problems.push(msg);
  want(log.includes(`::add-mask::${SECRET}`), 'QUEST_FOO was not masked');
  want(!log.includes('::add-mask::not-kept'), 'OTHER_BAR was kept');
  want(status && status.event === expect.event && status.core.version === core.version, 'quest-status missing or wrong');
  if (expect.error) {
    want(r.status !== 0, `expected failure, exit ${r.status}`);
    want(log.includes(expect.error), `log lacks "${expect.error}"`);
    want(status?.error?.includes(expect.error), 'quest-status has no error');
  } else {
    want((r.status === 0) === expect.ok, `exit ${r.status}, expected ${expect.ok ? 0 : 'failure'}`);
    want(check?.conclusion === expect.check, `check run ${check?.conclusion}, expected ${expect.check}`);
    want(status?.modules?.validate?.ok === expect.ok, 'quest-status validate.ok wrong');
    if (expect.issueFile) want(check?.annotations?.some((a) => a.path === expect.issueFile && a.start_line > 1), `no annotation on ${expect.issueFile} with a line`);
    if ('comment' in expect) want(!!comment === expect.comment, `comment ${comment ? 'written' : 'missing'}`);
    for (const k of expect.added ?? []) want(comment?.includes(k), `comment lacks added ${k}`);
    for (const k of expect.removed ?? []) want(comment?.includes(k), `comment lacks removed ${k}`);
  }
  return { name, problems, expectedFail: expect.expectedFail, log };
}

function checkStubContract(core) {
  const corePath = join(core.dir, 'core.json');
  if (!existsSync(corePath)) return console.log('· stub contract: no core.json (local core), skipped');
  const sample = JSON.parse(readFileSync(corePath, 'utf8')).stubSample;
  if (!sample) return console.log('· stub contract: core has no stubSample yet (G1), skipped');
  const inputs = Object.keys(/^inputs:\n((?:  .*\n|\n)*)/m.exec(readFileSync(join(root, 'action.yml'), 'utf8'))?.[1].match(/^  (\w[\w-]*):/gm)?.reduce((o, k) => ({ ...o, [k.trim().slice(0, -1)]: 1 }), {}) ?? {});
  const used = [...sample.matchAll(/^\s+with:\n((?:\s{10,}\S.*\n?)*)/gm)].flatMap((m) => [...m[1].matchAll(/^\s+([\w-]+):/gm)].map((x) => x[1]));
  const unknown = used.filter((k) => !inputs.includes(k));
  if (unknown.length) throw new Error(`stubSample passes inputs this action doesn't have: ${unknown.join(', ')}`);
  if (!/uses: lilmuckers\/quest-log-actions@(v1|main)/.test(sample)) throw new Error('stubSample does not use lilmuckers/quest-log-actions@v1 or @main');
  console.log(`✓ stub contract: ${used.join(', ') || 'no inputs'} all known`);
}

const core = resolveCore();
console.log(`Core ${core.version} in ${core.dir}`);
checkStubContract(core);
let failed = 0;
for (const name of readdirSync(fixtures).sort()) {
  if (!existsSync(join(fixtures, name, 'expect.json'))) continue;
  const res = runFixture(name, core);
  if (res.expectedFail) {
    if (res.problems.length) console.log(`○ ${name} (expected to fail: ${res.expectedFail})`);
    else console.log(`::warning::${name} passes now; remove expectedFail from fixtures/${name}/expect.json`);
  } else if (res.problems.length) {
    failed++;
    console.log(`✗ ${name}\n  ${res.problems.join('\n  ')}\n--- log ---\n${res.log}`);
  } else console.log(`✓ ${name}`);
}
rmSync(work, { recursive: true, force: true });
if (failed) {
  console.error(`${failed} fixture(s) failed`);
  process.exit(1);
}
