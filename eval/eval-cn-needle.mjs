#!/usr/bin/env node
/**
 * eval/eval-cn-needle.mjs  —  CN needle-in-haystack (exact readback)
 *
 * The worst case for a lossy compressor: a unique, high-entropy fact (phone
 * number / record ID / order code) that exists ONLY inside imaged content.
 * Upstream's EN needle eval found verbatim recall from 1× dense images
 * unreliable (0/15) — the acceptance bar here is therefore RELATIVE:
 * CN through the production 2× CJK path must be ≥ the EN 1× control run
 * under the identical harness, not an absolute 100%.
 *
 * Arms (both use the PUBLIC production render entry, dist/core/library.js
 * renderTextToImages with reflow — i.e. exactly what the proxy ships):
 *   cn-2x  — CJK-heavy haystack → auto-routes through the 2× upscale branch
 *   en-1x  — EN haystack (control) → 1× dense geometry
 *
 * Per trial: 3 needles at ~20/50/80% depth, ONE call asking all three back.
 * A needle scores 1 iff its exact string appears in the reply.
 *
 * Flags: --dry-run | --confirm | --trials N (default 5) | --model NAME
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const { values: args } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    'confirm': { type: 'boolean', default: false },
    'trials':  { type: 'string',  default: '5' },
    'model':   { type: 'string',  default: 'claude-sonnet-4-5' },
    'out-dir': { type: 'string',  default: join(__dirname, 'results') },
  },
});
const DRY_RUN = args['dry-run'];
const TRIALS = Math.max(1, parseInt(args.trials, 10));
const OUT_DIR = resolve(args['out-dir']);

const { renderTextToImages } = await import(join(ROOT, 'dist', 'core', 'library.js'));
const { bytesToBase64 } = await import(join(ROOT, 'dist', 'core', 'png.js'));
const { createClient } = await import('./lib/anthropic-client.mjs');

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — same needles/positions on every run so
// re-runs and A/B arms are comparable.
// ---------------------------------------------------------------------------
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const digits = (r, n) => Array.from({ length: n }, () => Math.floor(r() * 10)).join('');
const alnum = (r, n) => {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
  return Array.from({ length: n }, () => A[Math.floor(r() * A.length)]).join('');
};

/** Three needle kinds per trial: 手机号 / 备案号 / 订单号. */
function makeNeedles(r, arm) {
  const phone = `1${['3', '5', '7', '8', '9'][Math.floor(r() * 5)]}${digits(r, 9)}`;
  const record = digits(r, 18);
  const order = alnum(r, 10);
  if (arm === 'cn-2x') {
    return [
      { key: '备用联系电话', value: phone, sentence: `\n备注：客户备用联系电话为 ${phone}，仅限紧急情况使用。\n` },
      { key: '备案编号', value: record, sentence: `\n该系统的备案编号是 ${record}，请勿外传。\n` },
      { key: '订单编号', value: order, sentence: `\n对应的内部订单编号：${order}（区分大小写）。\n` },
    ];
  }
  return [
    { key: 'backup contact phone', value: phone, sentence: `\nNote: the customer's backup contact phone is ${phone}, emergencies only.\n` },
    { key: 'record ID', value: record, sentence: `\nThe registered record ID for this system is ${record}; do not share.\n` },
    { key: 'order code', value: order, sentence: `\nInternal order code: ${order} (case-sensitive).\n` },
  ];
}

/** Build a ~targetChars haystack from corpus blocks (rotated per trial) with
 *  the 3 needles spliced in at ~20/50/80% depth. */
function makeHaystack(blocks, trial, targetChars, needles) {
  const parts = [];
  let len = 0;
  for (let i = 0; len < targetChars; i++) {
    const b = blocks[(trial * 7 + i) % blocks.length].text;
    parts.push(b);
    len += b.length;
  }
  let text = parts.join('\n\n');
  // Splice at depth fractions, snapping to the nearest newline so needles sit
  // on natural line boundaries like real tool output would.
  const fracs = [0.2, 0.5, 0.8];
  for (let i = fracs.length - 1; i >= 0; i--) {
    let pos = Math.floor(text.length * fracs[i]);
    const nl = text.indexOf('\n', pos);
    pos = nl >= 0 ? nl : pos;
    text = text.slice(0, pos) + needles[i].sentence + text.slice(pos);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------
const cnBlocks = JSON.parse(readFileSync(join(__dirname, 'corpus', 'cn', 'text-blocks.json'), 'utf8'));

// EN control filler: the corpus JSONs were extracted from the operator's own
// (Chinese) sessions — every block is CJK-heavy, so they'd route through the
// 2× branch and stop being a 1× control. Use the repo's English docs instead,
// with any residual CJK lines stripped, chunked to corpus-like blocks.
const enFiller = ['FINDINGS.md', 'README.en.md', 'docs/CACHING_AND_SAVINGS.md', 'docs/RENDER_SIZING.md']
  .map((f) => readFileSync(join(ROOT, f), 'utf8'))
  .join('\n\n')
  .split('\n')
  .filter((l) => !/[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(l))
  .join('\n');
const enBlocks = [];
for (let i = 0; i + 1500 <= enFiller.length; i += 1500) {
  enBlocks.push({ text: enFiller.slice(i, i + 1500) });
}

const ARMS = [
  {
    name: 'cn-2x',
    blocks: cnBlocks,
    targetChars: 6000,
    system:
      '你是一个精确的信息检索助手。图片中是渲染成图像的文本内容（↵ 表示原始换行）。' +
      '请只根据图片内容作答，逐字精确输出，不要解释。',
    prompt: (needles) =>
      `图片内容中包含以下 ${needles.length} 项信息，请逐项找到并【原样】输出对应的值` +
      `（每行一项，格式 “名称: 值”，不要输出其他内容）：\n` +
      needles.map((n, i) => `${i + 1}. ${n.key}`).join('\n'),
  },
  {
    name: 'en-1x',
    blocks: enBlocks,
    targetChars: 12000, // ≈ same token mass as 6k CN chars
    system:
      'You are a precise retrieval assistant. The images contain rendered text (↵ marks an ' +
      'original line break). Answer ONLY from the image content, verbatim, no commentary.',
    prompt: (needles) =>
      `The image content contains the following ${needles.length} items. Find each and output ` +
      `its value EXACTLY (one per line, format "name: value", nothing else):\n` +
      needles.map((n, i) => `${i + 1}. ${n.key}`).join('\n'),
  },
];

// ---------------------------------------------------------------------------
// Cost gate
// ---------------------------------------------------------------------------
const estCalls = ARMS.length * TRIALS;
const estUsd = estCalls * 0.012; // ~3 pages ≈ 4.4k img tok + prompt ≈ $0.015/call sonnet
console.log(`[needle] ${ARMS.length} arms × ${TRIALS} trials = ${estCalls} calls, est ~$${(estUsd * 1.5).toFixed(2)}`);
if (!DRY_RUN && !args.confirm) {
  console.error('[needle] Real API calls require --confirm (or use --dry-run).');
  process.exit(1);
}

const client = createClient({ model: args.model, dryRun: DRY_RUN });

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
mkdirSync(OUT_DIR, { recursive: true });
const rows = [];

for (const arm of ARMS) {
  for (let t = 0; t < TRIALS; t++) {
    const r = rng(0xcafe + t * 31 + (arm.name === 'cn-2x' ? 0 : 1000));
    const needles = makeNeedles(r, arm.name);
    const haystack = makeHaystack(arm.blocks, t, arm.targetChars, needles);

    // PRODUCTION path: public renderer, reflow on — CJK-heavy input auto-routes
    // through the 2× branch, EN stays 1× dense. No style overrides.
    const rendered = await renderTextToImages(haystack, { reflow: true });
    const content = rendered.pages.map((p) => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: bytesToBase64(p.png) },
    }));
    content.push({ type: 'text', text: arm.prompt(needles) });

    let reply = '';
    let err = null;
    if (!DRY_RUN) {
      try {
        const resp = await client.messages({
          system: arm.system,
          messages: [{ role: 'user', content }],
          // The relay force-enables thinking, which shares this budget — 2048
          // yielded empty text replies (all-thinking). 8192 leaves headroom.
          max_tokens: 8192,
        });
        reply = resp.content?.[0]?.text ?? '';
      } catch (e) {
        err = e.message;
      }
    }

    const hits = needles.map((n) => ({ key: n.key, value: n.value, hit: reply.includes(n.value) }));
    const nHit = hits.filter((h) => h.hit).length;
    rows.push({
      arm: arm.name, trial: t, chars: haystack.length, pages: rendered.pages.length,
      pageDims: rendered.pages.map((p) => `${p.width}x${p.height}`),
      dropped: rendered.droppedChars, hits, nHit, err, reply: reply.slice(0, 500),
    });
    console.log(
      `[needle] ${arm.name} trial ${t + 1}/${TRIALS}: ${nHit}/3 ` +
      `(${rendered.pages.length}p ${rows.at(-1).pageDims.join(',')}, drop=${rendered.droppedChars})` +
      (err ? `  ERROR ${err}` : ''),
    );
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const summary = {};
for (const arm of ARMS) {
  const rs = rows.filter((x) => x.arm === arm.name && !x.err);
  const total = rs.length * 3;
  const hit = rs.reduce((s, x) => s + x.nHit, 0);
  summary[arm.name] = { trials: rs.length, needles: total, hit, rate: total ? hit / total : 0 };
}
const outPath = join(OUT_DIR, 'cn-needle.json');
writeFileSync(outPath, JSON.stringify({ model: args.model, dryRun: DRY_RUN, summary, rows }, null, 2));

console.log('\n──────── CN NEEDLE SUMMARY ────────');
for (const [name, s] of Object.entries(summary)) {
  console.log(`  ${name.padEnd(8)} ${s.hit}/${s.needles}  (${(s.rate * 100).toFixed(1)}%)  trials=${s.trials}`);
}
console.log(`  → ${outPath}`);
