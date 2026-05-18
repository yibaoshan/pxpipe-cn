// Build the Node bundle. The Worker target is built by wrangler directly
// from src/worker.ts (no separate build step needed).
import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const OUT = 'dist';
if (!existsSync(OUT)) await mkdir(OUT, { recursive: true });

await build({
  entryPoints: ['src/node.ts'],
  outfile: 'dist/node.js',
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  sourcemap: true,
  // Atlas is inlined as a base64 string in src/core/atlas.ts, so no external assets.
  external: [],
  banner: { js: '#!/usr/bin/env node' },
});

console.log('✓ built dist/node.js');
