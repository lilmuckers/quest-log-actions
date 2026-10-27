// Entry for the action.yml core steps, split so actions/cache can sit between them:
//   node dist/resolve.mjs pointer   read the pointer; outputs version, dir, key
//   node dist/resolve.mjs install   download (unless the cache restored it) and verify
// QUEST_CORE_DIR points at a local core (quest.py + schema/) instead, for CI fixtures and dev.
import * as core from '@actions/core';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fetchPointer, install, POINTER_URL, type Pointer } from './core-resolve.js';

async function main(cmd: string | undefined) {
  const local = process.env.QUEST_CORE_DIR;
  const root = join(process.env.RUNNER_TEMP ?? '/tmp', 'quest-core');
  if (cmd === 'pointer') {
    if (local) {
      core.notice(`Using the local core in ${local} (QUEST_CORE_DIR).`);
      core.setOutput('version', 'local');
      core.setOutput('dir', local);
      core.setOutput('local', 'true');
      return;
    }
    const url = process.env.QUEST_CORE_POINTER || POINTER_URL;
    const p = await fetchPointer(url);
    const dir = join(root, p.version);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'pointer.json'), JSON.stringify(p));
    core.info(`Quest Log core ${p.version} (${p.tag}) from ${url}`);
    core.setOutput('version', p.version);
    core.setOutput('dir', dir);
    core.setOutput('local', 'false');
  } else if (cmd === 'install') {
    if (local) return;
    const p = JSON.parse(readFileSync(join(root, 'pointer.json'), 'utf8')) as Pointer;
    const downloaded = await install(join(root, p.version), p);
    core.info(downloaded ? `Downloaded and verified core ${p.version}.` : `Core ${p.version} restored from cache and verified.`);
  } else {
    throw new Error('usage: resolve.mjs pointer | install');
  }
}

main(process.argv[2]).catch((e: Error) => core.setFailed(e.message));
