// Bundles the action into dist/ so a release commit runs with no npm install.
// dist/ is never committed on main; release.yml builds it onto the release commit.
import { build } from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // Some CommonJS deps call require(); give the ESM bundle one.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
};

await build({ ...shared, entryPoints: { index: 'src/main.ts', resolve: 'src/resolve-cli.ts' }, outdir: 'dist', outExtension: { '.js': '.mjs' } });
