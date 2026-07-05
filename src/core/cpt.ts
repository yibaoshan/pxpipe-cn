// CJK-blended chars-per-token estimation.
//
// The profitability gate's text-side cost model assumes English density
// (~4 chars/token conservative, ~1.91 observed). Chinese runs ~1 char/token
// on the Anthropic tokenizer, so a pure-CJK block of the same codepoint
// length is ~4× more expensive as text than the English constants predict —
// which flips many CN blocks from "not profitable" to "image me".
//
// blendedCpt() folds the measured CJK density into whichever base constant a
// call site already uses, so English behavior is bit-identical (cjk=0 ⇒
// blendedCpt(text, base) === base) and mixed text interpolates by counts.

/** Measured chars/token for CJK codepoints on the Anthropic tokenizer.
 *
 *  Calibrated 2026-07-05 via scripts/calibrate-cn-cpt.mjs (usage mode, 40
 *  probes on claude-haiku-4-5, 2 outliers rejected, R²=0.996). The relay
 *  inflates billed usage by a constant + a ~2× multiplier, so ABSOLUTE fitted
 *  values (cjk 0.765, other 2.044) are relay-scaled — but their RATIO is
 *  inflation-invariant: one CJK char costs 2.67× an "other" char. Anchored to
 *  the pipeline's baseCpt=4 that ratio gives 4 × (0.765/2.044) = 1.497 ≈ 1.5,
 *  i.e. the calibration CONFIRMS this value rather than replacing it.
 *  Full data: eval/results/cn-cpt-calibration.json. */
export const CPT_CJK = 1.5;

/** True if the codepoint is in a CJK-dense range (hanzi, Ext-A, CJK punct,
 *  kana, fullwidth forms, Hangul) — the ranges where ~1 char ≈ 1 token. */
export function isCjkCodepoint(cc: number): boolean {
  return (
    (cc >= 0x4e00 && cc <= 0x9fff) || // CJK Unified Ideographs
    (cc >= 0x3400 && cc <= 0x4dbf) || // Ext-A
    (cc >= 0x3000 && cc <= 0x30ff) || // CJK punct + kana
    (cc >= 0xff00 && cc <= 0xffef) || // fullwidth forms
    (cc >= 0xac00 && cc <= 0xd7af)    // Hangul syllables
  );
}

/** Count of CJK codepoints in `text` (single pass; surrogate-pair aware only
 *  where it matters — all CJK ranges above are BMP, so charCodeAt suffices). */
export function cjkCharCount(text: string): number {
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    if (isCjkCodepoint(text.charCodeAt(i))) cjk++;
  }
  return cjk;
}

/** Fraction of non-whitespace codepoints that are CJK. Used for telemetry
 *  (`cjk_fraction` in events.jsonl) and corpus filtering — NOT in the gate
 *  math itself, which uses raw counts via blendedCpt. */
export function cjkFraction(text: string): number {
  let cjk = 0;
  let total = 0;
  for (let i = 0; i < text.length; i++) {
    const cc = text.charCodeAt(i);
    if (cc <= 0x20) continue; // skip whitespace/control — don't dilute the ratio
    total++;
    if (isCjkCodepoint(cc)) cjk++;
  }
  return total === 0 ? 0 : cjk / total;
}

/** Effective chars-per-token for `text`, blending the caller's English-tuned
 *  base constant with CPT_CJK by codepoint counts:
 *
 *    tokens ≈ cjkChars / CPT_CJK + otherChars / baseCpt
 *    blended = text.length / tokens
 *
 *  Pure-English text returns `baseCpt` exactly; pure-CJK approaches CPT_CJK.
 *  Every gate call site keeps its own constant and passes it here. */
export function blendedCpt(text: string, baseCpt: number): number {
  return blendedCptFromCounts(text.length, cjkCharCount(text), baseCpt);
}

/** Counts-based variant of blendedCpt for callers that already scanned the text. */
export function blendedCptFromCounts(totalChars: number, cjkChars: number, baseCpt: number): number {
  if (totalChars === 0 || cjkChars === 0) return baseCpt;
  const tokens = cjkChars / CPT_CJK + (totalChars - cjkChars) / baseCpt;
  return totalChars / tokens;
}

/** cjkFraction threshold above which dense content renders at 2× (CJK_UPSCALE_FACTOR).
 *  At native 5×8, hanzi OCR is encoder-resolution-limited (~82% char accuracy);
 *  2× nearest-neighbor recovers 93.7% mean / 97.0% median with the same atlas
 *  (CN L1, 2026-07-05 — eval/EXPERIMENT_LOG.md). 0.3 matches the corpus filter's
 *  definition of "CJK-heavy"; below it most glyphs are ASCII, which reads fine at
 *  1× and would pay 4× the pixels for nothing. */
export const CJK_UPSCALE_MIN_FRACTION = 0.3;

/** True when `text` is CJK-heavy enough that the 2× upscale render pays for
 *  itself. THE single gate/renderer decision point — transform.ts pricing and
 *  every render call site must key off this same predicate or the profitability
 *  math and the actual pixels drift apart. */
export function shouldUpscaleCjk(text: string): boolean {
  return cjkFraction(text) >= CJK_UPSCALE_MIN_FRACTION;
}
