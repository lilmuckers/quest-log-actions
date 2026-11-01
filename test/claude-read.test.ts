import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { chooseModel, DEFAULT_MODEL, OUTPUT_SCHEMA, readPhoto, toRead } from '../src/claude-read.js';
import { DEFAULTS } from '../src/config.js';
import { plan } from '../src/plan.js';
import { runRead } from '../src/modules/read.js';

const photo = { data: 'AAAA', mediaType: 'image/jpeg' as const };
const empty = {
  kind: 'receipt', confidence: 'high', summary: '', text: '', title: '', takenOn: '', tags: [], todos: [],
  fields: { from: '', date: '', dueOn: '', time: '', where: '', reference: '', total: '', tax: '', currency: '', paymentMethod: '', items: [], brand: '', model: '', serial: '', spec: '', source: '', url: '', dimensions: [], caption: '' },
};
const answer = (over: object = {}, stop = 'end_turn', content: unknown[] = [{ type: 'text', text: JSON.stringify(empty) }]) => ({
  model: 'claude-opus-5-5', stop_reason: stop, content, usage: { input_tokens: 3000, output_tokens: 500 }, ...over,
});
const client = (create: (...a: any[]) => Promise<unknown>) => ({ beta: { messages: { create } } }) as any;

describe('toRead', () => {
  it('strips everything empty', () => {
    expect(toRead(empty)).toEqual({ kind: 'receipt', confidence: 'high' });
  });
  it('keeps what is there, tidied to fit the format', () => {
    const read = toRead({
      ...empty,
      summary: 'Tesco shop',
      takenOn: '2026-10-30',
      tags: ['food, shop', 'food, shop', ''],
      fields: { ...empty.fields, from: 'Tesco', date: '2026-10-30', total: '£1,111.34', currency: 'GBP', items: [{ name: 'Cheddar', qty: '2', price: '4.65' }, { name: 'Ginger', qty: '', price: '' }, { name: '', qty: '1', price: '1' }] },
    });
    expect(read).toMatchObject({ summary: 'Tesco shop', takenOn: '2026-10-30', tags: ['food  shop'] });
    expect(read.fields).toEqual({ from: 'Tesco', date: '2026-10-30', total: '1111.34', currency: 'GBP', items: [{ name: 'Cheddar', qty: 2, price: '4.65' }, { name: 'Ginger' }] });
  });
  it('drops values that do not fit rather than losing the read', () => {
    const read = toRead({ ...empty, takenOn: 'last Tuesday', fields: { ...empty.fields, date: '30/10/26', time: '25:00', currency: 'pounds', url: 'javascript:alert(1)', total: 'about 5.0.0' } });
    expect(read).toEqual({ kind: 'receipt', confidence: 'high' });
  });
  it('removes card numbers, wherever they are', () => {
    const read = toRead({ ...empty, text: 'VISA 4111 1111 1111 1111\nTOTAL 5.00', fields: { ...empty.fields, reference: '4111111111111111' } });
    expect(read.text).toBe('VISA [number removed]\nTOTAL 5.00');
    expect(JSON.stringify(read)).not.toContain('4111');
  });
  it('cuts long text to the format’s limits', () => {
    const read = toRead({ ...empty, summary: 'x'.repeat(500), todos: Array(30).fill('do it') });
    expect((read.summary as string).length).toBe(280);
    expect(read.todos).toHaveLength(20);
  });
});

describe('the schema Claude answers in', () => {
  const walk = (s: any, visit: (o: any) => void) => {
    if (s?.type === 'object') {
      visit(s);
      Object.values(s.properties).forEach((p) => walk(p, visit));
    }
    if (s?.type === 'array') walk(s.items, visit);
  };
  it('has no optional fields, so it stays inside the API’s limits', () => {
    walk(OUTPUT_SCHEMA, (o) => {
      expect(o.additionalProperties).toBe(false);
      expect(o.required.sort()).toEqual(Object.keys(o.properties).sort());
    });
  });
  it('uses only what the API supports', () => {
    expect(JSON.stringify(OUTPUT_SCHEMA)).not.toMatch(/maxLength|minLength|minimum|maximum|pattern|maxItems|anyOf/);
  });
});

describe('readPhoto', () => {
  it('makes one call with no tools, and returns the read', async () => {
    const create = vi.fn(async () => answer());
    await expect(readPhoto(client(create), photo, 'claude-opus-5-5')).resolves.toEqual({ flag: false, model: 'claude-opus-5-5', read: { kind: 'receipt', confidence: 'high' } });
    expect(create).toHaveBeenCalledOnce();
    const req = (create.mock.calls as any[])[0][0];
    expect(req.tools).toBeUndefined();
    expect(req.output_config.format.type).toBe('json_schema');
    expect(req.fallbacks).toBe('default');
    expect(req.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(req.messages[0].content[0].source).toEqual({ type: 'base64', media_type: 'image/jpeg', data: 'AAAA' });
  });
  it('asks for no fallback on Haiku, which has none', async () => {
    const create = vi.fn(async () => answer());
    await readPhoto(client(create), photo, 'claude-haiku-5-5');
    const req = (create.mock.calls as any[])[0][0];
    expect(req.fallbacks).toBeUndefined();
    expect(req.betas).toBeUndefined();
  });
  it('records the model that really answered, after a fallback', async () => {
    const r = await readPhoto(client(async () => answer({ model: 'claude-opus-4-8' })), photo, 'claude-opus-5-5');
    expect(r).toMatchObject({ model: 'claude-opus-4-8' });
  });
  it.each([
    ['a refusal', answer({}, 'refusal', []), /declined/],
    ['a cut-off answer', answer({}, 'max_tokens', [{ type: 'text', text: '{"kind"' }]), /too much/],
    ['broken JSON', answer({}, 'end_turn', [{ type: 'text', text: '{ nope' }]), /not valid/],
  ])('gives a reason on %s', async (_, response, why) => {
    const r = await readPhoto(client(async () => response), photo, 'm');
    expect((r as { error: string }).error).toMatch(why);
  });
  it('never repeats what the API said, which goes on a pull request', async () => {
    const err = new Anthropic.AuthenticationError(401, { secret: 'sk-ant-leak' }, 'bad key sk-ant-leak', new Headers());
    const r = await readPhoto(client(async () => { throw err; }), photo, 'm');
    expect((r as { error: string }).error).toMatch(/refused/);
    expect(JSON.stringify(r)).not.toContain('sk-ant');
  });
  it('explains a generic failure too', async () => {
    const r = await readPhoto(client(async () => { throw new Error('socket hang up'); }), photo, 'm');
    expect(r).toEqual({ error: 'the Claude API could not be reached.' });
  });
});

describe('chooseModel', () => {
  it('uses the repo’s model if it looks like one', () => {
    expect(chooseModel('claude-haiku-5-5')).toBe('claude-haiku-5-5');
    for (const bad of [undefined, 3, '', 'gpt-5', 'claude-x; rm -rf /']) expect(chooseModel(bad)).toBe(DEFAULT_MODEL);
  });
});

describe('the read module with a failed read', () => {
  it('passes on the reason and saves nothing', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const outDir = mkdtempSync(join(tmpdir(), 'read-'));
    writeFileSync(join(outDir, 'result.json'), JSON.stringify({ error: 'Claude declined to read it.' }));
    const d = { outDir, reader: 'Claude', save: vi.fn(() => ({ sha: 'x' })), handOver: vi.fn(), warn: vi.fn() };
    expect(runRead(d)).toEqual({ result: 'handed-over', why: 'Claude declined to read it.' });
    expect(d.save).not.toHaveBeenCalled();
    expect(d.handOver).toHaveBeenCalledWith('Claude declined to read it.');
  });
});

describe('plan: read with Claude', () => {
  const m = (labels: string[]) => plan('pull_request', DEFAULTS, labels).modules.find((x) => x.name === 'read')!;
  it('runs on the Claude label', () => {
    expect(m(['quest:attachment', 'quest:read-claude'])).toMatchObject({ run: true, reason: 'quest:read-claude' });
    expect(m(['quest:attachment', 'quest:read-done']).run).toBe(false);
  });
});

describe('action.yml keeps the Claude key to one step', () => {
  const text = readFileSync(join(import.meta.dirname, '../action.yml'), 'utf8');
  const steps = text.split(/^ {4}- /m).slice(1);
  const claude = steps.find((s) => s.startsWith('name: Read the photo with Claude'))!;
  it('only that step can see the key', () => {
    expect(steps.filter((s) => s.includes('inputs.anthropic-api-key'))).toEqual([claude]);
  });
  it('that step has no GitHub token and no other secret', () => {
    expect(claude).not.toMatch(/inputs\.token|github\.token|GH_TOKEN|INPUT_TOKEN|GITHUB_TOKEN/);
    expect(claude).toContain("QUEST_VAPID_PRIVATE_KEY: ''");
  });
  it('the open models have no secrets either', () => {
    const open = steps.find((s) => s.startsWith('name: Read the photo\n'))!;
    expect(open).not.toMatch(/inputs\.|GH_TOKEN/);
    expect(open).toContain("QUEST_VAPID_PRIVATE_KEY: ''");
  });
  it('checkout leaves no credentials behind', () => {
    expect(text).toContain('persist-credentials: false');
  });
  it('reads a photo only after checking it is still waiting', () => {
    for (const s of steps.filter((x) => x.startsWith('name: Read the photo'))) expect(s).toContain("steps.waiting.outputs.read == 'true'");
    expect(text).toContain("QUEST_READ_WAITING: ${{ steps.waiting.outputs.read || 'false' }}");
  });
});
