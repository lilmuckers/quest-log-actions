/** Secrets arrive as `with: secrets: ${{ toJSON(secrets) }}` (D12). Only `QUEST_*` names are kept. */
export const SECRET_PREFIX = 'QUEST_';

export interface Secrets {
  /** Kept secrets, by name. */
  values: Record<string, string>;
  /** Names that were passed in but ignored (never their values). */
  ignored: string[];
}

/**
 * Parses the `secrets` input and masks every kept value with `mask` before returning it.
 * An empty or missing input (fork PRs get no secrets) is not an error.
 */
export function parseSecrets(input: string | undefined, mask: (value: string) => void): Secrets {
  const text = (input ?? '').trim();
  if (!text) return { values: {}, ignored: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Never echo the input: it may hold secret values.
    throw new Error('The secrets input is not JSON. Pass `secrets: ${{ toJSON(secrets) }}`.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The secrets input must be a JSON object.');
  const values: Record<string, string> = {};
  const ignored: string[] = [];
  for (const [name, value] of Object.entries(raw)) {
    if (name.startsWith(SECRET_PREFIX) && typeof value === 'string' && value !== '') {
      mask(value);
      values[name] = value;
    } else {
      ignored.push(name);
    }
  }
  return { values, ignored: ignored.sort() };
}
