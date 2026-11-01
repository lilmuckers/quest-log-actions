// The read module: saves what the open-weight models found in a photo (reader/) to its sidecar on
// the pull request. The models ran in an earlier step with no token; `quest.py photo-save`
// validates the result and can only change that sidecar. A poor result is saved but flagged for
// an agent, and a failed one is handed over with nothing saved.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const READ_AUTO_LABEL = 'quest:read-auto';

interface ReaderResult {
  flag: boolean;
  why?: string | null;
  model?: string;
  read: Record<string, unknown>;
}

export interface ReadDeps {
  /** The folder the reader step wrote result.json to. */
  outDir: string;
  save(file: string, model: string | undefined, flag: boolean): { sha: string };
  handOver(note: string): void;
  warn(message: string): void;
}

export interface ReadOutcome {
  /** read: saved and trusted. flagged: saved, and waiting for an agent. handed-over: nothing saved. */
  result: 'read' | 'flagged' | 'handed-over';
  why?: string;
  /** The new head of the pull request, when something was saved. */
  sha?: string;
}

function loadResult(path: string): ReaderResult | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const r = JSON.parse(readFileSync(path, 'utf8'));
    return r && typeof r.read === 'object' && r.read ? r : undefined;
  } catch {
    return undefined;
  }
}

export function runRead(deps: ReadDeps): ReadOutcome {
  const handOver = (why: string): ReadOutcome => {
    deps.handOver(why);
    return { result: 'handed-over', why };
  };
  const found = loadResult(join(deps.outDir, 'result.json'));
  if (!found) return handOver('the open models could not run on this photo.');
  const file = join(deps.outDir, 'read.json');
  writeFileSync(file, JSON.stringify(found.read));
  try {
    const { sha } = deps.save(file, found.model, !!found.flag);
    return { result: found.flag ? 'flagged' : 'read', sha, ...(found.why ? { why: found.why } : {}) };
  } catch (e) {
    deps.warn(`Couldn't save what was read (${(e as Error).message}).`);
    return handOver('what the open models found was not valid.');
  }
}
