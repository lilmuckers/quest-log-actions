// The read module: saves what a reader found in a photo to its sidecar on the pull request: the
// open-weight models (reader/) or Claude (claude-read.ts). The reader ran in an earlier step with no
// GitHub token; `quest.py photo-save` validates the result and can only change that sidecar. A poor
// result from the open models is saved but flagged for an agent. A failed one is handed over with
// nothing saved: to an agent after the open models, and to the person after Claude.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const READ_AUTO_LABEL = 'quest:read-auto';
export const READ_CLAUDE_LABEL = 'quest:read-claude';

interface ReaderResult {
  flag: boolean;
  why?: string | null;
  model?: string;
  read?: Record<string, unknown>;
  /** Why the reader couldn't read it, in a sentence safe to post. */
  error?: string;
}

export interface ReadDeps {
  /** The folder the reader step wrote result.json to. */
  outDir: string;
  /** Who read it, for the note on the pull request. */
  reader: string;
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
    return r && ((typeof r.read === 'object' && r.read) || typeof r.error === 'string') ? r : undefined;
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
  if (found?.error) return handOver(found.error);
  if (!found?.read) return handOver(`${deps.reader} could not run on this photo.`);
  const file = join(deps.outDir, 'read.json');
  writeFileSync(file, JSON.stringify(found.read));
  try {
    const { sha } = deps.save(file, found.model, !!found.flag);
    return { result: found.flag ? 'flagged' : 'read', sha, ...(found.why ? { why: found.why } : {}) };
  } catch (e) {
    deps.warn(`Couldn't save what was read (${(e as Error).message}).`);
    return handOver(`what ${deps.reader} found was not valid.`);
  }
}
