#!/usr/bin/env node
/**
 * scripts/cn-baseline.mjs
 *
 * Offline CJK rendering baseline (Phase 0 of the CN adaptation).
 *
 * Renders the extracted Chinese corpus (eval/corpus/text-blocks-cn.json)
 * through the shared dense-page pipeline (renderDensePages — the same code
 * path the proxy and `pxpipe export` use) and reports, per block and in
 * aggregate:
 *   - droppedChars / droppedCodepoints  (atlas coverage gaps)
 *   - glyphs per page, px per glyph     (density vs the Latin 28,080 budget)
 *   - estimated image tokens (w*h/750) and chars per image-token
 *
 * Writes PNGs to eval/results/cn-baseline/ for eyeballing and a summary
 * JSON + markdown alongside. No API calls; run after `pnpm run build`.
 *
 * Usage:
 *   node scripts/cn-baseline.mjs [--corpus eval/corpus/text-blocks-cn.json]
 *                                [--out-dir eval/results/cn-baseline]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const { values: args } = parseArgs({
  options: {
    corpus:    { type: 'string', default: 'eval/corpus/text-blocks-cn.json' },
    'out-dir': { type: 'string', default: 'eval/results/cn-baseline' },
  },
});

const RENDER_PATH = resolve(ROOT, 'dist', 'core', 'render.js');
if (!existsSync(RENDER_PATH)) {
  console.error('dist/core/render.js not found — run `pnpm run build` first.');
  process.exit(1);
}
const { renderDensePages, DENSE_CONTENT_CHARS_PER_IMAGE } = await import(RENDER_PATH);

const corpusPath = resolve(ROOT, args.corpus);
if (!existsSync(corpusPath)) {
  console.error(`corpus not found: ${corpusPath} — run \`node eval/extract-corpus.mjs --cjk\` first.`);
  process.exit(1);
}
const blocks = JSON.parse(readFileSync(corpusPath, 'utf8'));
const outDir = resolve(ROOT, args['out-dir']);
mkdirSync(outDir, { recursive: true });

const PIXELS_PER_TOKEN = 750; // matches ANTHROPIC_PIXELS_PER_TOKEN in transform.ts

const rows = [];
const droppedTotal = new Map(); // codepoint -> count

for (let i = 0; i < blocks.length; i++) {
  const block = blocks[i];
  const pages = await renderDensePages(block.text, { reflow: true });

  let dropped = 0;
  let charsRendered = 0;
  let pixels = 0;
  pages.forEach((p, j) => {
    dropped += p.droppedChars;
    charsRendered += p.charsRendered;
    pixels += p.width * p.height;
    for (const [cp, n] of p.droppedCodepoints) {
      droppedTotal.set(cp, (droppedTotal.get(cp) ?? 0) + n);
    }
    writeFileSync(join(outDir, `block-${String(i).padStart(2, '0')}-p${j}.png`), p.png);
  });

  const imageTokens = Math.ceil(pixels / PIXELS_PER_TOKEN);
  rows.push({
    block: i,
    cjkFraction: block.cjkFraction ?? null,
    chars: block.text.length,
    pages: pages.length,
    charsRendered,
    droppedChars: dropped,
    pixels,
    imageTokens,
    charsPerImageToken: Number((block.text.length / imageTokens).toFixed(2)),
  });
}

// ---------------------------------------------------------------------------
// Aggregate + report
// ---------------------------------------------------------------------------

const totChars = rows.reduce((a, r) => a + r.chars, 0);
const totDropped = rows.reduce((a, r) => a + r.droppedChars, 0);
const totPages = rows.reduce((a, r) => a + r.pages, 0);
const totTokens = rows.reduce((a, r) => a + r.imageTokens, 0);

const topDropped = [...droppedTotal.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20)
  .map(([cp, n]) => ({
    codepoint: 'U+' + cp.toString(16).toUpperCase().padStart(4, '0'),
    char: String.fromCodePoint(cp),
    count: n,
  }));

const summary = {
  generatedAt: new Date().toISOString(),
  corpus: args.corpus,
  denseCharBudgetPerPage: DENSE_CONTENT_CHARS_PER_IMAGE,
  blocks: rows.length,
  totalChars: totChars,
  totalPages: totPages,
  totalDroppedChars: totDropped,
  droppedRate: Number((totDropped / totChars).toFixed(5)),
  totalImageTokens: totTokens,
  charsPerImageToken: Number((totChars / totTokens).toFixed(2)),
  topDroppedCodepoints: topDropped,
  perBlock: rows,
};
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

const md = [
  '# CN rendering baseline (current atlas)',
  '',
  `- generated: ${summary.generatedAt}`,
  `- blocks: ${rows.length}, total chars: ${totChars}, pages: ${totPages}`,
  `- **dropped chars: ${totDropped}** (${(summary.droppedRate * 100).toFixed(2)}%)`,
  `- image tokens (est. px/750): ${totTokens} → **${summary.charsPerImageToken} chars/image-token**`,
  '',
  '## Top dropped codepoints',
  '',
  '| codepoint | char | count |',
  '|---|---|---:|',
  ...topDropped.map(d => `| ${d.codepoint} | ${d.char} | ${d.count} |`),
  '',
].join('\n');
writeFileSync(join(outDir, 'summary.md'), md, 'utf8');

console.log(md);
console.log(`PNGs + summary written to ${outDir}`);
