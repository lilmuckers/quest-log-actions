// Resolves the Quest Log core (quest.py + schemas) at run time (automation plan §3.6):
// GET the Pages pointer, then download the release assets and check every sha256.
// No fallback to stale rules: if the pointer can't be read, the run fails.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The core major this action version understands. */
export const CORE_MAJOR = 1;
export const POINTER_URL = `https://tasks.patrick-mckinley.com/core/v${CORE_MAJOR}.json`;
/** Assets the action needs from a release. */
export const REQUIRED_ASSETS = ['quest.py', 'schema.tar.gz', 'core.json'] as const;

export interface Pointer {
  version: string;
  tag: string;
  contentHash: string;
  released?: string;
  skillVersion?: number;
  assets: Record<string, { url: string; sha256: string }>;
}

export class CoreUnavailable extends Error {
  constructor(detail: string) {
    super(`Quest Log rules unavailable (${detail}); nothing was checked.`);
  }
}

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>;

const sha256 = (buf: Uint8Array) => createHash('sha256').update(buf).digest('hex');

/** Reads and checks the pointer. Fails on any network error, a bad shape or the wrong major. */
export async function fetchPointer(url: string, fetchFn: Fetch = fetch): Promise<Pointer> {
  let res;
  try {
    res = await fetchFn(url);
  } catch (e) {
    throw new CoreUnavailable(`pages unreachable: ${(e as Error).message}`);
  }
  if (!res.ok) throw new CoreUnavailable(`pages unreachable: GET ${url} returned ${res.status}`);
  let p: Pointer;
  try {
    p = (await res.json()) as Pointer;
  } catch {
    throw new CoreUnavailable(`pointer at ${url} is not JSON`);
  }
  const major = Number(/^(\d+)\./.exec(p?.version ?? '')?.[1]);
  if (major !== CORE_MAJOR) throw new CoreUnavailable(`pointer is core ${p?.version ?? '?'}, this action needs ${CORE_MAJOR}.x`);
  for (const name of REQUIRED_ASSETS) {
    const a = p.assets?.[name];
    if (!a?.url || !/^[0-9a-f]{64}$/.test(a.sha256 ?? '')) throw new CoreUnavailable(`pointer has no checksummed ${name}`);
  }
  return p;
}

/** Whether `dir` holds this pointer's assets with matching hashes (a cache hit). */
export function isInstalled(dir: string, p: Pointer): boolean {
  return REQUIRED_ASSETS.every((name) => {
    const path = join(dir, name);
    return existsSync(path) && sha256(readFileSync(path)) === p.assets[name]!.sha256;
  }) && existsSync(join(dir, 'schema', 'index.json'));
}

/**
 * Downloads the pointer's assets into `dir`, checks each sha256 and unpacks the schemas to
 * `dir/schema`. Release assets on a public repo need no token. Does nothing on a verified hit.
 * Returns whether it downloaded.
 */
export async function install(dir: string, p: Pointer, fetchFn: Fetch = fetch): Promise<boolean> {
  if (isInstalled(dir, p)) return false;
  mkdirSync(dir, { recursive: true });
  for (const name of REQUIRED_ASSETS) {
    const { url, sha256: want } = p.assets[name]!;
    let res;
    try {
      res = await fetchFn(url);
    } catch (e) {
      throw new CoreUnavailable(`download of ${name} failed: ${(e as Error).message}`);
    }
    if (!res.ok) throw new CoreUnavailable(`GET ${url} returned ${res.status}`);
    const body = new Uint8Array(await res.arrayBuffer());
    const got = sha256(body);
    if (got !== want) throw new CoreUnavailable(`${name} checksum mismatch (want ${want.slice(0, 12)}…, got ${got.slice(0, 12)}…)`);
    writeFileSync(join(dir, name), body);
  }
  execFileSync('tar', ['-xzf', join(dir, 'schema.tar.gz'), '-C', dir]);
  if (!existsSync(join(dir, 'schema', 'index.json'))) throw new CoreUnavailable('schema.tar.gz has no schema/index.json');
  return true;
}
