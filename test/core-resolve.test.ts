import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreUnavailable, fetchPointer, install, isInstalled, type Pointer } from '../src/core-resolve.js';

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

/** A fake release: quest.py, schema.tar.gz (made with tar) and core.json, served by `fetchFn`. */
function release(version = '1.0.0') {
  const src = mkdtempSync(join(tmpdir(), 'rel-'));
  mkdirSync(join(src, 'schema'));
  writeFileSync(join(src, 'schema/index.json'), '{"schemas":[]}');
  execFileSync('tar', ['-czf', join(src, 'schema.tar.gz'), '-C', src, 'schema']);
  const files: Record<string, Uint8Array> = {
    'quest.py': Buffer.from('print("hi")\n'),
    'schema.tar.gz': readFileSync(join(src, 'schema.tar.gz')),
    'core.json': Buffer.from(JSON.stringify({ version })),
  };
  const base = `https://github.com/o/r/releases/download/core-v${version}/`;
  const pointer: Pointer = {
    version,
    tag: `core-v${version}`,
    contentHash: 'c',
    assets: Object.fromEntries(Object.entries(files).map(([n, b]) => [n, { url: base + n, sha256: sha(b) }])),
  };
  const calls: string[] = [];
  const fetchFn = async (url: string) => {
    calls.push(url);
    if (url.endsWith('/v1.json')) return response(200, JSON.stringify(pointer));
    const name = url.slice(base.length);
    return files[name] ? response(200, files[name]) : response(404, '');
  };
  return { pointer, files, fetchFn, calls };
}

function response(status: number, body: string | Uint8Array) {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  return {
    ok: status < 400,
    status,
    json: async () => JSON.parse(Buffer.from(buf).toString('utf8')),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  };
}

describe('fetchPointer', () => {
  it('returns a good pointer', async () => {
    const r = release();
    expect((await fetchPointer('https://x/core/v1.json', r.fetchFn)).version).toBe('1.0.0');
  });
  it('fails when pages are unreachable or missing', async () => {
    await expect(fetchPointer('u', async () => Promise.reject(new Error('ECONNREFUSED')))).rejects.toThrow(/pages unreachable: ECONNREFUSED/);
    await expect(fetchPointer('u', async () => response(404, ''))).rejects.toThrow(CoreUnavailable);
    await expect(fetchPointer('u', async () => response(404, ''))).rejects.toThrow(/nothing was checked/);
  });
  it('fails on the wrong major or a pointer without checksums', async () => {
    const r = release('2.0.0');
    await expect(fetchPointer('https://x/core/v1.json', r.fetchFn)).rejects.toThrow(/needs 1\.x/);
    const bad = { ...release().pointer, assets: {} };
    await expect(fetchPointer('u', async () => response(200, JSON.stringify(bad)))).rejects.toThrow(/no checksummed quest\.py/);
  });
});

describe('install', () => {
  it('downloads, verifies and unpacks, then hits the cache next time', async () => {
    const r = release();
    const dir = join(mkdtempSync(join(tmpdir(), 'core-')), '1.0.0');
    expect(await install(dir, r.pointer, r.fetchFn)).toBe(true);
    expect(isInstalled(dir, r.pointer)).toBe(true);
    expect(readFileSync(join(dir, 'schema/index.json'), 'utf8')).toContain('schemas');
    r.calls.length = 0;
    expect(await install(dir, r.pointer, r.fetchFn)).toBe(false);
    expect(r.calls).toEqual([]);
  });
  it('refuses a checksum mismatch', async () => {
    const r = release();
    const tampered = { ...r.pointer, assets: { ...r.pointer.assets, 'quest.py': { ...r.pointer.assets['quest.py']!, sha256: '0'.repeat(64) } } };
    const dir = mkdtempSync(join(tmpdir(), 'core-'));
    await expect(install(dir, tampered, r.fetchFn)).rejects.toThrow(/quest\.py checksum mismatch/);
  });
  it('re-downloads when a cached file was changed', async () => {
    const r = release();
    const dir = mkdtempSync(join(tmpdir(), 'core-'));
    await install(dir, r.pointer, r.fetchFn);
    writeFileSync(join(dir, 'quest.py'), 'tampered');
    expect(isInstalled(dir, r.pointer)).toBe(false);
    expect(await install(dir, r.pointer, r.fetchFn)).toBe(true);
    expect(readFileSync(join(dir, 'quest.py'), 'utf8')).toBe('print("hi")\n');
  });
});
