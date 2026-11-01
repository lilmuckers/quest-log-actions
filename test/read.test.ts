import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runRead } from '../src/modules/read.js';
import { DEFAULTS } from '../src/config.js';
import { plan } from '../src/plan.js';

function setup(result?: string, save = vi.fn(() => ({ sha: 'new' }))) {
  const outDir = mkdtempSync(join(tmpdir(), 'read-'));
  if (result !== undefined) writeFileSync(join(outDir, 'result.json'), result);
  const handOver = vi.fn();
  return { outDir, save, handOver, warn: vi.fn() };
}
const read = { kind: 'receipt', confidence: 'high' };

describe('runRead', () => {
  it('saves a good read, passing only the read block', () => {
    const d = setup(JSON.stringify({ flag: false, why: null, model: 'm', read }));
    expect(runRead(d)).toEqual({ result: 'read', sha: 'new' });
    const [file, model, flag] = d.save.mock.calls[0] as unknown as [string, string, boolean];
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(read);
    expect([model, flag]).toEqual(['m', false]);
    expect(d.handOver).not.toHaveBeenCalled();
  });
  it('saves a poor read flagged for an agent', () => {
    const d = setup(JSON.stringify({ flag: true, why: 'unclear', read }));
    expect(runRead(d)).toEqual({ result: 'flagged', sha: 'new', why: 'unclear' });
  });
  it.each([
    ['no result', undefined],
    ['broken JSON', '{ nope'],
    ['no read block', '{"caption":true}'],
  ])('hands the photo over on %s', (_, text) => {
    const d = setup(text);
    expect(runRead(d).result).toBe('handed-over');
    expect(d.save).not.toHaveBeenCalled();
    expect(d.handOver).toHaveBeenCalledOnce();
  });
  it('hands the photo over when the read is refused', () => {
    const d = setup(JSON.stringify({ flag: false, read }), vi.fn(() => { throw new Error('not valid'); }));
    expect(runRead(d).result).toBe('handed-over');
    expect(d.warn).toHaveBeenCalledOnce();
  });
});

describe('plan: read', () => {
  const run = (event: string, labels: string[]) => plan(event, DEFAULTS, labels).modules.find((m) => m.name === 'read')!.run;
  it('runs only on a pull request labelled for the models', () => {
    expect(run('pull_request', ['quest:attachment', 'quest:read-auto'])).toBe(true);
    expect(run('pull_request', ['quest:attachment', 'quest:read-agent'])).toBe(false);
    expect(run('push', ['quest:read-auto'])).toBe(false);
  });
});
