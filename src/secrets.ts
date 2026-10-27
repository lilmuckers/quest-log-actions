/**
 * Secrets the stub passes by name as step `env:` (D12): `QUEST_X: ${{ secrets.QUEST_X }}`.
 * Keep in step with `SECRET_NAMES` in gamify-todo's `shared/src/stub.ts`. A named list, not every
 * `QUEST_*` variable, because the action's own settings (`QUEST_CORE_PATH`, …) share the prefix.
 */
export const SECRET_NAMES = ['QUEST_VAPID_PRIVATE_KEY'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export interface Secrets {
  /** Secrets that arrived with a value, by name. */
  values: Partial<Record<SecretName, string>>;
  /** Names that arrived empty: not set in the repo, an older stub, or a fork PR. */
  missing: SecretName[];
}

/** Reads the known secrets from `env` and masks every value with `mask` before returning it. */
export function readSecrets(env: Record<string, string | undefined>, mask: (value: string) => void): Secrets {
  const values: Secrets['values'] = {};
  const missing: SecretName[] = [];
  for (const name of SECRET_NAMES) {
    const value = env[name];
    if (value) {
      mask(value);
      values[name] = value;
    } else {
      missing.push(name);
    }
  }
  return { values, missing };
}
