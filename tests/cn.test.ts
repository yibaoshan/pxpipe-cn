/**
 * Chinese-adaptation offline suite (pxpipe-cn fork).
 *
 * Covers the three CN defects fixed in Phases 1–2:
 *   1. Atlas coverage — every CJK Unified ideograph, CN punctuation, kana and
 *      fullwidth form must have a glyph (Fusion Pixel or Unifont fallthrough);
 *      zero silent drops on render.
 *   2. Gate math — image side counts CELLS (CJK = 2), text side blends
 *      CPT_CJK; pure-English decisions must be bit-identical to upstream.
 *   3. Page capacity — pure-CN text paginates by cell-aware rows
 *      (≈ ceil(2N/28080)) and the estimator must match the actual renderer.
 *
 * Everything here is offline ($0): no API calls, no OCR.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  renderTextToPngs,
  renderTextToPngsWithCharLimit,
  lineCells,
  DENSE_CONTENT_COLS,
  DENSE_CONTENT_CHARS_PER_IMAGE,
  MAX_HEIGHT_PX,
  CJK_DENSE_COLS,
  CJK_DENSE_CHARS_PER_IMAGE,
  CJK_UPSCALE_FACTOR,
  CJK_CELL_H,
  CJK_DENSE_RENDER_STYLE,
  PAD_Y,
} from '../src/core/render.js';
import {
  transformRequest,
  estimateImageCount,
  evalCompressionProfitability,
  isCompressionProfitable,
} from '../src/core/transform.js';
import {
  CPT_CJK,
  isCjkCodepoint,
  cjkCharCount,
  cjkFraction,
  blendedCpt,
  blendedCptFromCounts,
  shouldUpscaleCjk,
  CJK_UPSCALE_MIN_FRACTION,
} from '../src/core/cpt.js';
import {
  atlasRank,
  ATLAS_PIXELS,
  ATLAS_NUM_GLYPHS,
  ATLAS_CELL_W,
  ATLAS_CELL_H,
  ATLAS_FONT_FAMILY,
} from '../src/core/atlas.js';
import { toTrackEvent } from '../src/core/tracker.js';
import type { ProxyEvent } from '../src/core/proxy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic hanzi sample: every `step`-th codepoint of CJK Unified. */
function hanziSample(count: number, step = 7): string {
  let out = '';
  let cp = 0x4e00;
  for (let i = 0; i < count; i++) {
    out += String.fromCharCode(cp);
    cp += step;
    if (cp > 0x9fff) cp = 0x4e00 + ((cp - 0x9fff) % 7);
  }
  return out;
}

const CN_PUNCT = '，。「」『』；：？！、……——（）【】《》·';
const FULLWIDTH_DIGITS = '０１２３４５６７８９';
const KANA_SAMPLE = 'あいうえおアイウエオんッー';

// ---------------------------------------------------------------------------
// 1. Atlas coverage — zero dropped glyphs
// ---------------------------------------------------------------------------

describe('CN atlas coverage', () => {
  it('pins the Fusion Pixel atlas build (glyph count, cell, pixel hash)', () => {
    // Regen must be deterministic; a drifting hash means gen-atlas or the font
    // assets changed without a deliberate re-record here.
    expect(ATLAS_NUM_GLYPHS).toBe(35501);
    expect(ATLAS_CELL_W).toBe(5);
    expect(ATLAS_CELL_H).toBe(8);
    expect(ATLAS_FONT_FAMILY).toContain('FusionPixel');
    const sha = createHash('sha256').update(Buffer.from(ATLAS_PIXELS)).digest('hex');
    expect(sha.slice(0, 12)).toBe('e79a813cc5e7');
  });

  it('covers the ENTIRE CJK Unified block (U+4E00–U+9FFF) — no missing hanzi', () => {
    // Fusion Pixel supplies the common set; Unifont must catch every gap.
    const missing: number[] = [];
    for (let cp = 0x4e00; cp <= 0x9fff; cp++) {
      if (atlasRank(cp) < 0) missing.push(cp);
    }
    expect(missing).toEqual([]);
  });

  it('covers CN punctuation, fullwidth digits, and kana', () => {
    for (const ch of CN_PUNCT + FULLWIDTH_DIGITS + KANA_SAMPLE) {
      expect(atlasRank(ch.codePointAt(0)!), `U+${ch.codePointAt(0)!.toString(16)}`).toBeGreaterThanOrEqual(0);
    }
  });

  it('renders a 3000-hanzi + punctuation sample with zero dropped chars', async () => {
    const text = hanziSample(3000) + CN_PUNCT + FULLWIDTH_DIGITS + KANA_SAMPLE;
    const images = await renderTextToPngs(text, DENSE_CONTENT_COLS);
    const dropped = images.reduce((s, img) => s + img.droppedChars, 0);
    expect(dropped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Cell math — lineCells and the estimator/renderer agreement
// ---------------------------------------------------------------------------

describe('CN cell math', () => {
  it('lineCells: CJK is 2 cells, ASCII is 1, mixed adds up', () => {
    expect(lineCells('abc')).toBe(3);
    expect(lineCells('中')).toBe(2);
    expect(lineCells('中文测试')).toBe(8);
    expect(lineCells('a中b文c')).toBe(7);
    expect(lineCells('')).toBe(0);
  });

  it('pure-CN pages ≈ ceil(2N / 28080): estimator matches the real renderer', async () => {
    // 30,000 hanzi as one unwrapped stream at dense geometry: 2 cells/char ⇒
    // rows = ceil(60000/312) = 193; 90 rows/page ⇒ 3 pages = ceil(2N/28080).
    const N = 30_000;
    const text = hanziSample(N);
    const est = estimateImageCount(text, DENSE_CONTENT_COLS, 1, DENSE_CONTENT_CHARS_PER_IMAGE);
    expect(est).toBe(Math.ceil((2 * N) / DENSE_CONTENT_CHARS_PER_IMAGE));
    const images = await renderTextToPngs(text, DENSE_CONTENT_COLS);
    expect(images.length).toBe(est);
  });

  it('mixed CN/EN estimator still matches the renderer', async () => {
    const line = '错误日志 error at line 42: 无法解析配置文件 config.yaml — retry 重试\n';
    const text = line.repeat(400);
    const est = estimateImageCount(text, DENSE_CONTENT_COLS, 1, DENSE_CONTENT_CHARS_PER_IMAGE);
    const images = await renderTextToPngs(text, DENSE_CONTENT_COLS);
    expect(images.length).toBe(est);
  });
});

// ---------------------------------------------------------------------------
// 3. cpt.ts — blended density model
// ---------------------------------------------------------------------------

describe('blendedCpt', () => {
  it('is the identity for pure-English text (upstream decisions unchanged)', () => {
    expect(blendedCpt('the quick brown fox jumps over the lazy dog', 4)).toBe(4);
    expect(blendedCpt('const x = 42; // comment', 2)).toBe(2);
    expect(blendedCptFromCounts(1000, 0, 4)).toBe(4);
    expect(blendedCptFromCounts(0, 0, 4)).toBe(4);
  });

  it('approaches CPT_CJK for pure-CN text', () => {
    expect(blendedCpt('中'.repeat(100), 4)).toBeCloseTo(CPT_CJK, 10);
  });

  it('interpolates mixed text by the counts formula', () => {
    const text = '中文'.repeat(25) + 'x'.repeat(50); // 50 CJK + 50 other
    const expected = 100 / (50 / CPT_CJK + 50 / 4);
    expect(blendedCpt(text, 4)).toBeCloseTo(expected, 10);
  });

  it('cjkFraction skips whitespace and counts CJK punctuation as CJK', () => {
    expect(cjkFraction('中 文')).toBe(1);
    expect(cjkFraction('ab中文')).toBe(0.5);
    expect(cjkFraction('，。')).toBe(1);
    expect(cjkFraction('')).toBe(0);
    expect(cjkCharCount('a中b，c')).toBe(2);
    expect(isCjkCodepoint(0x4e2d)).toBe(true);   // 中
    expect(isCjkCodepoint(0x61)).toBe(false);    // a
  });
});

// ---------------------------------------------------------------------------
// 4. Profitability gate — EN regression + CN flip
// ---------------------------------------------------------------------------

describe('CN gate recalibration', () => {
  it('EN regression: text-side cost is exactly len/cpt (no blend applied)', () => {
    const en = 'All work and no play makes Jack a dull boy. '.repeat(400); // 18k chars
    const r = evalCompressionProfitability(en, DENSE_CONTENT_COLS)!;
    expect(r.textTokens).toBe(en.length / 4);
  });

  it('CN text-side cost uses CPT_CJK: 8k hanzi ≈ 8000/1.5 tokens, and images win', () => {
    const cn = hanziSample(8000).replace(/(.{40})/g, '$1\n');
    const r = evalCompressionProfitability(cn, DENSE_CONTENT_COLS)!;
    // 8,000 hanzi + ~200 newlines; newlines are "other" chars in the blend.
    const hanzi = cjkCharCount(cn);
    const expectedTokens = hanzi / CPT_CJK + (cn.length - hanzi) / 4;
    expect(r.textTokens).toBeCloseTo(expectedTokens, 6);
    // Under the old len/4 math this read as 2,050 tokens; blended it is ~5,384.
    expect(r.textTokens).toBeGreaterThan(2 * (cn.length / 4));
    expect(r.profitable).toBe(true);
    expect(isCompressionProfitable(cn, DENSE_CONTENT_COLS)).toBe(true);
  });

  it('image side prices CJK-heavy text through the 2× gap2 branch (~2 cells × 4 px × 10/8 rows)', () => {
    // Equal-length unwrapped streams. The CJK one is CJK-heavy so the gate
    // prices it at the 2× production geometry (CJK_DENSE_COLS, pixelScale 2,
    // CJK_CELL_H = 10): 2 cells/char × 4 pixels/cell (2×2) × 10/8 line height
    // = ~10× the ASCII image cost, less the narrower canvas / paging
    // differences. This pins the gate to the branch the renderer actually
    // takes — if the ratio drifts back near 2, pricing and pixels have
    // desynced.
    const n = 20_000;
    const ascii = 'abcdefghij'.repeat(n / 10);
    const cjk = hanziSample(n);
    const rAscii = evalCompressionProfitability(ascii, DENSE_CONTENT_COLS)!;
    const rCjk = evalCompressionProfitability(cjk, DENSE_CONTENT_COLS)!;
    const ratio = rCjk.imageTokens / rAscii.imageTokens;
    expect(ratio).toBeGreaterThan(8);
    expect(ratio).toBeLessThan(12);
  });
});

// ---------------------------------------------------------------------------
// 5. End-to-end: token-equivalent thresholds + CJK telemetry
// ---------------------------------------------------------------------------

function makeReq(toolResultText: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      model: 'claude-3-5-sonnet',
      // Large ASCII system slab so the main compression path fires and the
      // request reaches the tool_result gate at all (mirrors paging.test.ts).
      system: 'x'.repeat(80_000),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_cn', content: toolResultText },
          ],
        },
      ],
    }),
  );
}

describe('CN end-to-end (transformRequest)', () => {
  it('4k-char pure-CN tool_result now clears the 6k threshold (the upstream flip)', async () => {
    // Upstream: 4,000 codepoints < minToolResultChars=6,000 ⇒ passthrough.
    // Token-equivalent: 4,000 hanzi ≈ 2,667 tokens ≈ 10,667 EN-chars ⇒ imaged.
    const cn = hanziSample(4000).replace(/(.{40})/g, '$1\n');
    const { info } = await transformRequest(makeReq(cn));
    expect(info.compressed).toBe(true);
    expect(info.toolResultImgs ?? 0).toBeGreaterThan(0);
  });

  it('4k-char ASCII tool_result still passes through (EN threshold unchanged)', async () => {
    const en = 'log line with some detail here\n'.repeat(130).slice(0, 4000);
    const { info } = await transformRequest(makeReq(en));
    expect(info.toolResultImgs ?? 0).toBe(0);
  });

  it('emits cjk_fraction and cpt_used telemetry for CN traffic', async () => {
    const cn = hanziSample(4000).replace(/(.{40})/g, '$1\n');
    const { info } = await transformRequest(makeReq(cn));
    expect(info.cjkFraction).toBeGreaterThan(0);
    expect(info.cptUsed).toBeLessThan(4); // blended below the EN base
    const ev = toTrackEvent({
      method: 'POST', path: '/v1/messages', status: 200, durationMs: 1, info,
    } as unknown as ProxyEvent);
    expect(ev.cjk_fraction).toBe(info.cjkFraction);
    expect(ev.cpt_used).toBe(info.cptUsed);
  });

  it('pure-EN request emits NO cjk telemetry fields', async () => {
    const { info } = await transformRequest(makeReq('plain ascii tool result\n'.repeat(300)));
    expect(info.cjkFraction).toBeUndefined();
    const ev = toTrackEvent({
      method: 'POST', path: '/v1/messages', status: 200, durationMs: 1, info,
    } as unknown as ProxyEvent);
    expect(ev.cjk_fraction).toBeUndefined();
    expect(ev.cpt_used).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. 2× CJK upscale — predicate, geometry, and gate/renderer lockstep
// ---------------------------------------------------------------------------
//
// CN L1 eval (2026-07-05): at native 5×8 hanzi OCR is encoder-resolution-
// limited (81.68% char accuracy); 2× nearest-neighbor with the SAME atlas
// recovers 93.70% mean / 97.0% median. CN gist-recall then showed the gap0
// packed rows visually interlock (39% recall) — a 2 px inter-line gap
// (CJK_LINE_GAP, cellH 10) recovers 75%. CJK-heavy blocks therefore render at
// pixelScale=2 on a 150-col × 35-row pre-scale canvas (1516×716 scaled — under
// the 1568-edge / ~1.15 MP API box), and the gate must price that exact
// geometry or profitability and pixels drift apart.

describe('CN 2× upscale path', () => {
  it('shouldUpscaleCjk gates on cjkFraction ≥ 0.3', () => {
    expect(CJK_UPSCALE_MIN_FRACTION).toBe(0.3);
    expect(shouldUpscaleCjk(hanziSample(100))).toBe(true);
    expect(shouldUpscaleCjk('plain ascii only')).toBe(false);
    // 3 CJK / 10 non-ws = exactly the threshold (inclusive).
    expect(shouldUpscaleCjk('中中中abcdefg')).toBe(true);
    expect(shouldUpscaleCjk('中中abcdefgh')).toBe(false);
  });

  it('2× gap2 geometry: full-width CN pages are 1516 px wide, ≤728 px tall, 35 rows/page', async () => {
    // 10,000 hanzi = 20,000 cells → ceil(20000/150) = 134 rows → 4 pages of ≤35.
    const rowsPerPage = Math.floor(
      (Math.floor(MAX_HEIGHT_PX / CJK_UPSCALE_FACTOR) - 2 * PAD_Y) / CJK_CELL_H,
    );
    expect(rowsPerPage).toBe(35); // CJK_DENSE_CHARS_PER_IMAGE = 150 × 35
    expect(CJK_DENSE_CHARS_PER_IMAGE).toBe(CJK_DENSE_COLS * rowsPerPage);
    const text = hanziSample(10_000);
    const imgs = await renderTextToPngsWithCharLimit(
      text,
      CJK_DENSE_COLS,
      CJK_DENSE_CHARS_PER_IMAGE,
      CJK_DENSE_RENDER_STYLE,
      MAX_HEIGHT_PX,
    );
    expect(imgs.length).toBe(Math.ceil(Math.ceil((2 * 10_000) / CJK_DENSE_COLS) / rowsPerPage));
    for (const img of imgs) {
      expect(img.width).toBe(1516); // 2 × (2·PAD_X + 150·CELL_W); long edge < 1568
      expect(img.height).toBeLessThanOrEqual(MAX_HEIGHT_PX);
      expect(img.width * img.height).toBeLessThanOrEqual(1_150_000); // ~1.15 MP cap
      expect(img.droppedChars).toBe(0);
    }
  });

  it('e2e: CN tool_result ships the 2× geometry (imageDims width 1516)', async () => {
    const cn = hanziSample(8000).replace(/(.{40})/g, '$1\n');
    const { info } = await transformRequest(makeReq(cn));
    expect(info.compressed).toBe(true);
    expect(info.toolResultImgs ?? 0).toBeGreaterThan(0);
    expect((info.imageDims ?? []).some((d) => d.width === 1516)).toBe(true);
  });

  it('e2e: EN tool_result geometry is untouched (no 2×-width pages)', async () => {
    const en = 'tool output: everything within normal parameters, code 0.\n'.repeat(300);
    const { info } = await transformRequest(makeReq(en));
    // Upstream 1× geometry (incl. multi-col packing with gutters) is out of
    // scope here — the CN adaptation must only never route EN traffic through
    // the 2× branch, whose signature page width is 1516.
    expect((info.imageDims ?? []).length).toBeGreaterThan(0);
    expect((info.imageDims ?? []).some((d) => d.width === 1516)).toBe(false);
  });
});
