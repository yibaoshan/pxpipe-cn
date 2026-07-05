#!/usr/bin/env node
/**
 * scripts/calibrate-cn-cpt.mjs
 *
 * Fit CPT_CJK (chars-per-token for CJK codepoints, src/core/cpt.ts) from
 * real tokenizer counts over the extracted corpus.
 *
 * Model: tokens ≈ cjkChars/CPT_CJK + otherChars/cptOther + overhead
 * i.e. a linear regression  tokens = a·cjk + b·other + c  with
 * CPT_CJK = 1/a, cptOther = 1/b, c = per-request message overhead.
 * Mixing CN and EN blocks spreads cjkFraction over [0,0.8] so the two
 * coefficients are well-conditioned.
 *
 * Probe modes (auto-detected, override with --mode):
 *   count  – POST /v1/messages/count_tokens (FREE). Needs ANTHROPIC_API_KEY
 *            against api.anthropic.com; most relays don't implement it.
 *   usage  – POST /v1/messages with max_tokens=1 and reads usage.input_tokens.
 *            Works through ANTHROPIC_BASE_URL relays. BILLED, but ~40 requests
 *            × a few kTok input on haiku ≈ pennies.
 *
 * Usage:
 *   node scripts/calibrate-cn-cpt.mjs [--mode auto|count|usage]
 *     [--model claude-haiku-4-5] [--max-blocks 40] [--dry-run]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const { values: args } = parseArgs({
  options: {
    mode:         { type: 'string', default: 'auto' },   // auto|count|usage
    model:        { type: 'string', default: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || 'claude-haiku-4-5' },
    'max-blocks': { type: 'string', default: '40' },
    'out-dir':    { type: 'string', default: 'eval/results' },
    'dry-run':    { type: 'boolean', default: false },
  },
});

// --- CJK counting: MUST match src/core/cpt.ts isCjkCodepoint ---------------
function isCjkCodepoint(cc) {
  return (
    (cc >= 0x4e00 && cc <= 0x9fff) ||
    (cc >= 0x3400 && cc <= 0x4dbf) ||
    (cc >= 0x3000 && cc <= 0x30ff) ||
    (cc >= 0xff00 && cc <= 0xffef) ||
    (cc >= 0xac00 && cc <= 0xd7af)
  );
}
function cjkCharCount(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (isCjkCodepoint(text.charCodeAt(i))) n++;
  return n;
}

// --- load corpus (CN + EN for cjkFraction spread) ---------------------------
function loadBlocks(rel) {
  const p = resolve(ROOT, rel);
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, 'utf8')).map((b) => b.text).filter(Boolean);
}
const cnBlocks = loadBlocks('eval/corpus/text-blocks-cn.json');
const enBlocks = loadBlocks('eval/corpus/text-blocks.json');
if (cnBlocks.length === 0) {
  console.error('no CN corpus — run `node eval/extract-corpus.mjs --cjk` first.');
  process.exit(1);
}
const MAX_BLOCKS = parseInt(args['max-blocks'], 10);
// Interleave CN/EN so a truncated run still spans the cjkFraction range.
const texts = [];
for (let i = 0; i < Math.max(cnBlocks.length, enBlocks.length) && texts.length < MAX_BLOCKS; i++) {
  if (i < cnBlocks.length) texts.push(cnBlocks[i]);
  if (i < enBlocks.length && texts.length < MAX_BLOCKS) texts.push(enBlocks[i]);
}

// --- probe transport ---------------------------------------------------------
const OFFICIAL = 'https://api.anthropic.com';
const API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const RELAY_BASE = (process.env.ANTHROPIC_BASE_URL ?? OFFICIAL).replace(/\/+$/, '');
const RELAY_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN ?? API_KEY;

async function probeCountTokens(text) {
  const res = await fetch(`${OFFICIAL}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: args.model, messages: [{ role: 'user', content: text }] }),
  });
  if (!res.ok) throw new Error(`count_tokens ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  if (typeof j.input_tokens !== 'number') throw new Error('no input_tokens in response');
  return j.input_tokens;
}

async function probeUsage(text) {
  const res = await fetch(`${RELAY_BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${RELAY_TOKEN}`,
      'x-api-key': RELAY_TOKEN,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: args.model,
      max_tokens: 1,
      messages: [{ role: 'user', content: text }],
    }),
  });
  if (!res.ok) throw new Error(`messages ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const u = j.usage ?? {};
  const n = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  if (!n) throw new Error('no usage.input_tokens in response');
  return n;
}

let mode = args.mode;
if (mode === 'auto') mode = API_KEY ? 'count' : 'usage';
const probe = mode === 'count' ? probeCountTokens : probeUsage;
console.log(`[calibrate-cn-cpt] mode=${mode} model=${args.model} blocks=${texts.length} (${cnBlocks.length} CN + ${enBlocks.length} EN available)`);
if (mode === 'usage') console.log('[calibrate-cn-cpt] usage mode is BILLED (max_tokens=1 per block; ~pennies on haiku)');

if (args['dry-run']) {
  console.log('[calibrate-cn-cpt] dry-run: would probe', texts.length, 'blocks; exiting.');
  process.exit(0);
}

// --- collect ----------------------------------------------------------------
const rows = [];
for (let i = 0; i < texts.length; i++) {
  const text = texts[i];
  const cjk = cjkCharCount(text);
  try {
    const tokens = await probe(text);
    rows.push({ i, len: text.length, cjk, other: text.length - cjk, tokens });
    console.log(`  block ${i}: len=${text.length} cjk=${cjk} tokens=${tokens} (${(text.length / tokens).toFixed(2)} c/t)`);
  } catch (e) {
    console.error(`  block ${i}: probe failed — ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 300)); // be nice to the relay
}
if (rows.length < 6) {
  console.error(`only ${rows.length} successful probes — not enough to fit. Aborting.`);
  process.exit(1);
}

// --- least squares: tokens = a·cjk + b·other + c ------------------------------
// Normal equations for X = [cjk, other, 1].
function fit(rows) {
  // X'X (3×3) and X'y
  let Scc = 0, Sco = 0, Sc1 = 0, Soo = 0, So1 = 0, S11 = rows.length;
  let Scy = 0, Soy = 0, S1y = 0;
  for (const r of rows) {
    Scc += r.cjk * r.cjk; Sco += r.cjk * r.other; Sc1 += r.cjk;
    Soo += r.other * r.other; So1 += r.other;
    Scy += r.cjk * r.tokens; Soy += r.other * r.tokens; S1y += r.tokens;
  }
  const A = [
    [Scc, Sco, Sc1],
    [Sco, Soo, So1],
    [Sc1, So1, S11],
  ];
  const y = [Scy, Soy, S1y];
  // Gaussian elimination (3×3)
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]]; [y[col], y[piv]] = [y[piv], y[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let c = col; c < 3; c++) A[r][c] -= f * A[col][c];
      y[r] -= f * y[col];
    }
  }
  const a = y[0] / A[0][0], b = y[1] / A[1][1], c = y[2] / A[2][2];
  // R²
  const mean = rows.reduce((s, r) => s + r.tokens, 0) / rows.length;
  let ssRes = 0, ssTot = 0;
  for (const r of rows) {
    const pred = a * r.cjk + b * r.other + c;
    ssRes += (r.tokens - pred) ** 2;
    ssTot += (r.tokens - mean) ** 2;
  }
  return { a, b, c, r2: 1 - ssRes / ssTot };
}

const { a, b, c, r2 } = fit(rows);
const cptCjk = 1 / a;
const cptOther = 1 / b;

const result = {
  generatedAt: new Date().toISOString(),
  mode,
  model: args.model,
  blocks: rows.length,
  fit: { a, b, intercept: c, r2: Number(r2.toFixed(5)) },
  cptCjk: Number(cptCjk.toFixed(3)),
  cptOther: Number(cptOther.toFixed(3)),
  perBlock: rows,
};
const outDir = resolve(ROOT, args['out-dir']);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'cn-cpt-calibration.json'), JSON.stringify(result, null, 2), 'utf8');

console.log('');
console.log(`  fitted over ${rows.length} blocks (R² = ${r2.toFixed(4)}):`);
console.log(`    CPT_CJK   = ${cptCjk.toFixed(3)} chars/token  (cpt.ts ships ${'1.5'})`);
console.log(`    cptOther  = ${cptOther.toFixed(3)} chars/token  (EN mixed-content reference)`);
console.log(`    overhead  = ${c.toFixed(1)} tokens/request`);
console.log('');
console.log(`  → update CPT_CJK in src/core/cpt.ts to ${cptCjk.toFixed(2)} (round conservatively UP:`);
console.log('    a higher CPT_CJK means "text is cheaper", biasing the gate against imaging).');
console.log(`  full data: ${join(outDir, 'cn-cpt-calibration.json')}`);
