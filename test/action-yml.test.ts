import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('action.yml', () => {
  // The runner evaluates ${{ }} in descriptions too; `secrets` isn't defined there, so the action fails to load.
  it('has no expressions in any description', () => {
    const text = readFileSync(join(import.meta.dirname, '../action.yml'), 'utf8');
    const bad = text.split('\n').filter((l) => /^\s*description:/.test(l) && l.includes('${{'));
    expect(bad).toEqual([]);
  });
});
