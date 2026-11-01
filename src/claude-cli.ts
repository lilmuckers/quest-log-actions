// The "Read the photo with Claude" step: finds the photo on the attachment branch, reads it and
// leaves result.json for the next step. Always exits 0: a failure is recorded in the result, and
// the next step reports it on the pull request.
import Anthropic from '@anthropic-ai/sdk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chooseModel, readPhoto, type Photo, type ReadResult } from './claude-read.js';

const TYPES: Record<string, Photo['mediaType']> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function findPhoto(ref: string): Photo | undefined {
  const id = ref.startsWith('quest/attach/') ? ref.slice('quest/attach/'.length) : '';
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) return undefined;
  for (const [ext, mediaType] of Object.entries(TYPES)) {
    const path = join('data/attachments', `${id}.${ext}`);
    if (existsSync(path)) return { data: readFileSync(path).toString('base64'), mediaType };
  }
  return undefined;
}

function configuredModel(): unknown {
  try {
    return JSON.parse(readFileSync('data/automation.json', 'utf8')).photos?.model;
  } catch {
    return undefined;
  }
}

async function main(): Promise<ReadResult> {
  const key = process.env.QUEST_CLAUDE_KEY;
  if (!key) return { error: 'the repo has no ANTHROPIC_API_KEY secret, or its workflow needs updating. See Settings → Automation.' };
  const photo = findPhoto(process.env.QUEST_PHOTO_REF ?? '');
  if (!photo) return { error: 'no photo that Claude can read was found on this branch.' };
  return readPhoto(new Anthropic({ apiKey: key, timeout: 5 * 60 * 1000 }), photo, chooseModel(configuredModel()), console.log);
}

const out = process.env.QUEST_READ_OUT!;
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'result.json'), JSON.stringify(await main()));
