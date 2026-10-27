# quest-log-actions

The GitHub Action behind [Quest Log](https://tasks.patrick-mckinley.com) data repos. Each data
repo holds a thin workflow (the *stub*) that the Quest Log app writes for you; all the pipeline
code lives here, so fixes reach every repo without anyone editing their workflow.

What it does today (`v1.0`):

- **validate**: on every pull request and push, checks `data/` with the live Quest Log rules.
  The result is a `Quest validate` check run with an annotation on each problem line. On pull
  requests it also keeps one comment up to date, listing what the PR adds, changes and removes.
  The job fails when the data is invalid.
- **quest-status**: every run uploads a small `quest-status` artifact
  (`{ ranAt, event, core, modules, sent, expiredDevices }`) that the app reads to show run status.

Coming in `v1.1`: **notify**, Web Push for time-boxes, the weekly review and Warp Zone PRs.

## The stub

You don't write this by hand: turn automation on in **Settings → Automation** in the app, and it
commits `.github/workflows/quest.yml` for you, re-rendering it whenever the settings change.
It looks like this:

```yaml
# quest-stub: 1  (written by Quest Log — change it in Settings → Automation)
name: Quest Log
on:
  pull_request: { types: [opened, synchronize, reopened, labeled] }
  push: { branches: [main], paths: ['data/**'] }
  workflow_dispatch:
permissions: { contents: write, pull-requests: write, checks: write }
concurrency:
  group: quest-${{ github.ref }}
  cancel-in-progress: false
jobs:
  quest:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: lilmuckers/quest-log-actions@v1
        env:
          QUEST_VAPID_PRIVATE_KEY: ${{ secrets.QUEST_VAPID_PRIVATE_KEY }}
```

Secrets are passed **by name**, never with `toJSON(secrets)`: GitHub holds a workflow that
passes all secrets as "may be malicious" until someone approves it, and again after every edit.
The stub lists every secret name the action knows, set or not; an unset one arrives empty and
that feature stays off. A new secret name comes with a new stub version (`quest-stub: N`), which
the app offers to write.

### Inputs

| Input | Default | What it's for |
|---|---|---|
| `token` | `${{ github.token }}` | Writes the check run and the PR comment. |

Secrets come in as step `env:` (see the stub), not as an input.

On pull requests from forks GitHub passes no secrets and a read-only token. The action still
validates, and reports problems as workflow annotations instead of a check run.

## Configuration: `data/automation.json`

Optional. With no file, validate is on and everything else is off.

```json
{
  "channel": "stable",
  "schedule": { "every": "3h" },
  "validate": { "enabled": true, "comment": true },
  "notify": { "enabled": false, "devices": [] }
}
```

- `channel`: `stable` uses `@v1`, `beta` uses `@main`. The app writes the matching stub.
- `validate.comment`: turn off the PR comment and keep just the check run.
- `schedule` and `notify` are for the notify module (`v1.1`).

## Secrets

| Name | Used by |
|---|---|
| `QUEST_VAPID_PRIVATE_KEY` | notify (`v1.1`); the app sets it the first time a device turns on push |

The stub passes each one as step `env:`, and the action reads only these names (`SECRET_NAMES`
in `src/secrets.ts`) and masks each value. Other secrets in the repo never reach it.

## Where the rules come from (the core)

The action never contains Quest Log's data rules. On every run it reads
`https://tasks.patrick-mckinley.com/core/v1.json`, a pointer to the latest `core-v1.x.y` release
of [gamify-todo](https://github.com/lilmuckers/gamify-todo/releases), downloads `quest.py` and
the schemas from that release, checks their sha256s, and caches them by version. So a rule change
reaches every data repo as soon as gamify-todo deploys, with no action release.

If the pointer can't be read, or points at a major version this action doesn't know, the run
fails with "Quest Log rules unavailable … nothing was checked". It never validates with stale
rules. The core version used is shown in the job summary and in `quest-status`.

## Versions and channels

- `v1.N.M` tags are immutable releases; `v1` moves to the newest one. Releases are the only
  commits that contain `dist/`.
- `main` is the beta channel. It has no `dist/`, so the action builds itself on the runner
  first (about 20 seconds more).
- A breaking change to the stub or the config is `v2`. The app notices the old stub and offers the
  upgrade.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build                                          # dist/index.mjs and dist/resolve.mjs
npm run fixtures -- --core-source ../gamify-todo       # run dist/ on fixtures/ with a local core
npm run fixtures -- --live                             # same, with the core from the live pointer
```

Each folder in `fixtures/` is a data repo plus an `expect.json` (event, expected result, comment
contents). The runner commits it into a temporary git repo (on top of `base`, for PR fixtures),
runs `dist/index.mjs` with a synthetic event, records the check run and comment it would write
(`QUEST_DRY_RUN_OUT`), and compares. A fixture with `expectedFail` is allowed to fail until the
core it needs is released.

Environment overrides, for development only:

| Variable | Effect |
|---|---|
| `QUEST_CORE_DIR` | Use a local core (`quest.py` + `schema/`) instead of the pointer |
| `QUEST_CORE_POINTER` | Read the pointer from another URL |
| `QUEST_DRY_RUN_OUT` | Record API writes to this file instead of calling GitHub |

CI runs the unit tests, then the fixtures against gamify-todo `main` and against the live
pointer. The live run also happens daily, so a bad core release shows up here first.

**Releasing** (action code only): run the *Release* workflow with a version such as `1.0.0`. It
builds `dist/` onto a release commit off `main`, tags `v1.0.0` and moves `v1`.
