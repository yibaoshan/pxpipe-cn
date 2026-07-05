#!/usr/bin/env node
/**
 * eval/eval-cn-gist.mjs  —  CN gist-recall A/B (text vs production 2× images)
 *
 * CN version of eval/gist-recall (tier-1 scale): synthetic-but-realistic CN
 * transcripts (filler = real CN corpus blocks), 5 fact types + 1 unanswerable
 * injected per session at controlled depths with seeded random values. Both
 * arms get the identical transcript; the only difference is modality:
 *   text   — transcript sent as a plain text block
 *   image  — transcript rendered via the PUBLIC production entry
 *            (dist/core/library.js renderTextToImages, reflow) → CJK-heavy
 *            input auto-routes through the 2× upscale branch
 * Deterministic string grading, no LLM judge. Unanswerable probes measure
 * silent confabulation (the failure mode that matters for agents).
 *
 * Flags: --dry-run | --confirm | --sessions N (default 6) | --model NAME
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const { values: args } = parseArgs({
  options: {
    'dry-run':  { type: 'boolean', default: false },
    'confirm':  { type: 'boolean', default: false },
    'sessions': { type: 'string',  default: '6' },
    'model':    { type: 'string',  default: 'claude-sonnet-4-5' },
    'out-dir':  { type: 'string',  default: join(__dirname, 'results') },
    // Comma list of arms: text | image (production reflow) | image-raw
    // (no reflow — natural line breaks; isolates the ↵-packed-wall variable)
    // | image-h1 / image-h2 (reflow at 2× with 1/2 px inter-line gap —
    // tests whether vertically-touching packed hanzi rows are the reader's
    // "overlapping text" failure).
    'arms':     { type: 'string',  default: 'text,image' },
  },
});
const DRY_RUN = args['dry-run'];
const SESSIONS = Math.max(1, parseInt(args.sessions, 10));
const OUT_DIR = resolve(args['out-dir']);

const { renderTextToImages } = await import(join(ROOT, 'dist', 'core', 'library.js'));
const {
  renderTextToPngsWithCharLimit, reflow: reflowText,
  CJK_DENSE_COLS, CJK_DENSE_CHARS_PER_IMAGE, CJK_UPSCALE_FACTOR, DENSE_RENDER_STYLE,
} = await import(join(ROOT, 'dist', 'core', 'render.js'));
const { bytesToBase64 } = await import(join(ROOT, 'dist', 'core', 'png.js'));
const { createClient } = await import('./lib/anthropic-client.mjs');

// ---------------------------------------------------------------------------
// Seeded RNG + randomized fact values (nothing memorizable from training)
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
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];

const LIBS = ['Redis', 'Memcached', 'DragonflyDB', 'KeyDB', 'Hazelcast'];
const OLD = ['Ehcache', 'Couchbase', 'Ignite', 'Infinispan'];
const NAMES = ['张伟', '李娜', '王强', '陈静', '刘洋', '赵敏'];
const DIRS = ['src/core', 'src/api', 'src/utils', 'lib/net', 'lib/db'];
const FILES = ['session.ts', 'pool.ts', 'retry.ts', 'codec.ts', 'router.ts'];

/** 5 answerable facts + 1 unanswerable probe per session. */
function makeFacts(r) {
  const lib = pick(r, LIBS);
  const ms = 500 + Math.floor(r() * 90) * 50; // 500–4950, step 50
  const path = `${pick(r, DIRS)}/${pick(r, FILES)}`;
  const name = pick(r, NAMES);
  const dead = pick(r, OLD);
  return [
    {
      sentence: `\n经过对比评测，团队最终拍板：缓存层选用 ${lib}，其余候选全部放弃。\n`,
      probe: '缓存层最终选用了哪个方案？', expect: lib,
    },
    {
      sentence: `\n为了缓解超时问题，我们把网关的请求超时时间调整为 ${ms} 毫秒并已上线。\n`,
      probe: '网关的请求超时时间被调整为多少毫秒？', expect: String(ms),
    },
    {
      sentence: `\n排查了一整天，确认这个 bug 的根因位于 ${path} 文件里的重连逻辑。\n`,
      probe: '那个 bug 的根因位于哪个文件？', expect: path,
    },
    {
      sentence: `\n顺带一提，这个模块目前由 ${name} 负责维护，有问题直接找他/她。\n`,
      probe: '该模块目前由谁负责维护？', expect: name,
    },
    {
      sentence: `\n注意：${dead} 已经被正式弃用，所有服务都不允许再引入它。\n`,
      probe: '哪个组件已经被正式弃用？', expect: dead,
    },
    {
      // Never stated anywhere — correct answer is UNKNOWN.
      probe: '数据库连接池的最大连接数被设置为多少？', expect: 'UNKNOWN', unanswerable: true,
    },
  ];
}

/** Build a ~targetChars CN transcript with facts spliced at fixed depths. */
function makeTranscript(blocks, session, targetChars, facts) {
  const parts = [];
  let len = 0;
  for (let i = 0; len < targetChars; i++) {
    const b = blocks[(session * 11 + i) % blocks.length].text;
    parts.push(b);
    len += b.length;
  }
  let text = parts.join('\n\n');
  const depths = [0.12, 0.3, 0.5, 0.68, 0.85];
  const placed = facts.filter((f) => !f.unanswerable);
  for (let i = placed.length - 1; i >= 0; i--) {
    let pos = Math.floor(text.length * depths[i]);
    const nl = text.indexOf('\n', pos);
    pos = nl >= 0 ? nl : pos;
    text = text.slice(0, pos) + placed[i].sentence + text.slice(pos);
  }
  return text;
}

const SYSTEM =
  '你是一个严谨的会话记忆助手。用户会给你一段较长的会话记录（可能以图片形式渲染，↵ 表示原始换行），' +
  '然后就其中提到的事实提问。只依据记录内容作答；如果记录中确实没有提到，必须只回答 UNKNOWN，严禁猜测。';

function probeText(facts) {
  return (
    `请根据上面的会话记录回答以下 ${facts.length} 个问题。每行一个答案，格式 “编号. 答案”，` +
    `答案尽量简短（只给出值本身）。记录中没有提到的，该项回答 UNKNOWN。\n` +
    facts.map((f, i) => `${i + 1}. ${f.probe}`).join('\n')
  );
}

/** Grade one reply: per-probe hit if the expected string appears on that
 *  answer line (fallback: anywhere in the reply if line split fails). */
function grade(reply, facts) {
  const lines = reply.split('\n');
  return facts.map((f, i) => {
    const line = lines.find((l) => l.trim().startsWith(`${i + 1}.`) || l.trim().startsWith(`${i + 1}、`));
    const hay = line ?? reply;
    const hit = f.unanswerable
      ? /unknown/i.test(hay)
      : hay.includes(f.expect);
    // Confabulation: unanswerable probe answered with something ≠ UNKNOWN.
    const confab = f.unanswerable && !hit && (line ?? '').trim().length > 2;
    return { probe: f.probe, expect: f.expect, hit, confab, line: (line ?? '').slice(0, 120) };
  });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const cnBlocks = JSON.parse(readFileSync(join(__dirname, 'corpus', 'cn', 'text-blocks.json'), 'utf8'));
const TARGET_CHARS = 8000;
const ARM_NAMES = args.arms.split(',').map((s) => s.trim()).filter(Boolean);

const estCalls = SESSIONS * ARM_NAMES.length;
console.log(`[gist] ${SESSIONS} sessions × ${ARM_NAMES.length} arms (${ARM_NAMES.join(',')}) = ${estCalls} calls, est ~$${(estCalls * 0.03).toFixed(2)}`);
if (!DRY_RUN && !args.confirm) {
  console.error('[gist] Real API calls require --confirm (or use --dry-run).');
  process.exit(1);
}

const client = createClient({ model: args.model, dryRun: DRY_RUN });
mkdirSync(OUT_DIR, { recursive: true });
const rows = [];

for (let s = 0; s < SESSIONS; s++) {
  const r = rng(0xbeef + s * 97);
  const facts = makeFacts(r);
  const transcript = makeTranscript(cnBlocks, s, TARGET_CHARS, facts);

  const rendered = await renderTextToImages(transcript, { reflow: true });
  const renderedRaw = ARM_NAMES.includes('image-raw')
    ? await renderTextToImages(transcript, { reflow: false })
    : null;
  // Gap variants: production 2× reflow geometry + N px inter-line gap.
  // Rendered via the internal entry because an explicit style disables the
  // public wrapper's auto-upscale mirror.
  const renderGap = async (gap) => {
    const src = reflowText(transcript) ?? transcript;
    const imgs = await renderTextToPngsWithCharLimit(
      src, CJK_DENSE_COLS, CJK_DENSE_CHARS_PER_IMAGE,
      { ...DENSE_RENDER_STYLE, cellHBonus: gap, pixelScale: CJK_UPSCALE_FACTOR },
    );
    return {
      pages: imgs.map((im) => ({ png: im.png, width: im.width, height: im.height })),
      droppedChars: imgs.reduce((n, im) => n + im.droppedChars, 0),
    };
  };
  const renderedH1 = ARM_NAMES.includes('image-h1') ? await renderGap(1) : null;
  const renderedH2 = ARM_NAMES.includes('image-h2') ? await renderGap(2) : null;
  const imageArm = (name, ren) => ({
    name,
    ren,
    content: [
      ...ren.pages.map((p) => ({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: bytesToBase64(p.png) },
      })),
      { type: 'text', text: probeText(facts) },
    ],
  });
  const allArms = [
    {
      name: 'text',
      ren: null,
      content: [
        { type: 'text', text: `以下是会话记录：\n\n${transcript}\n\n（会话记录结束）` },
        { type: 'text', text: probeText(facts) },
      ],
    },
    imageArm('image', rendered),
    ...(renderedRaw ? [imageArm('image-raw', renderedRaw)] : []),
    ...(renderedH1 ? [imageArm('image-h1', renderedH1)] : []),
    ...(renderedH2 ? [imageArm('image-h2', renderedH2)] : []),
  ];
  const arms = allArms.filter((a) => ARM_NAMES.includes(a.name));

  for (const arm of arms) {
    let reply = '';
    let err = null;
    if (!DRY_RUN) {
      // The relay sometimes returns an all-thinking (empty-text) reply or a
      // transient 5xx HTML page — retry once before recording a failure.
      for (let attempt = 0; attempt < 2 && !reply; attempt++) {
        try {
          const resp = await client.messages({
            system: SYSTEM,
            messages: [{ role: 'user', content: arm.content }],
            max_tokens: 8192, // relay force-enables thinking, which shares this budget
          });
          reply = resp.content?.[0]?.text ?? '';
          err = reply ? null : 'empty reply';
        } catch (e) {
          err = e.message;
        }
      }
    }
    const graded = err ? [] : grade(reply, facts);
    const nHit = graded.filter((g) => g.hit).length;
    const nConfab = graded.filter((g) => g.confab).length;
    const ren = arm.ren;
    rows.push({
      session: s, arm: arm.name, chars: transcript.length,
      pages: ren ? ren.pages.length : 0,
      pageDims: ren ? ren.pages.map((p) => `${p.width}x${p.height}`) : [],
      dropped: ren ? ren.droppedChars : 0, graded, nHit, nConfab, err, reply: reply.slice(0, 800),
    });
    console.log(
      `[gist] s${s + 1}/${SESSIONS} ${arm.name.padEnd(9)} ${err ? 'ERROR ' + err.slice(0, 60) : `${nHit}/${facts.length}` + (nConfab ? `  CONFAB×${nConfab}` : '')}` +
      (ren ? `  (${ren.pages.length}p, drop=${ren.droppedChars})` : ''),
    );
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const summary = {};
for (const armName of ARM_NAMES) {
  const rs = rows.filter((x) => x.arm === armName && !x.err);
  const probes = rs.reduce((n, x) => n + x.graded.length, 0);
  const hit = rs.reduce((n, x) => n + x.nHit, 0);
  const confab = rs.reduce((n, x) => n + x.nConfab, 0);
  summary[armName] = { sessions: rs.length, probes, hit, confab, rate: probes ? hit / probes : 0 };
}
const outPath = join(OUT_DIR, 'cn-gist.json');
writeFileSync(outPath, JSON.stringify({ model: args.model, dryRun: DRY_RUN, summary, rows }, null, 2));

console.log('\n──────── CN GIST-RECALL SUMMARY ────────');
for (const [name, x] of Object.entries(summary)) {
  console.log(`  ${name.padEnd(6)} ${x.hit}/${x.probes} (${(x.rate * 100).toFixed(1)}%)  confab=${x.confab}  sessions=${x.sessions}`);
}
console.log(`  → ${outPath}`);
