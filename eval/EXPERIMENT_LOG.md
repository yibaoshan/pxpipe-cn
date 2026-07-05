# Packed-reflow legibility experiments

Baseline measurement (Opus 4.7, 20 blocks, 5×8 cell, 1-bit atlas):
- **no-reflow baseline:** 97.64% mean / 98.10% median / 87.75% min
- **packed reflow, ↵ fully inline (production at 050b306):** 90.91% mean / 94.20% median / **59.65% min** (Δ = −6.73pp)

Worst blocks at production:
- Block 2 (228 char bash code fence) → 59.6%
- Block 5 (315 char markdown options list) → 79.4%

Common shape: content uses blank lines as semantic dividers (code fences, list items, section breaks).

## Attempt #1 — break the visual row on ↵↵, keep single ↵ inline

**Hypothesis:** the ↵ glyph reads as a regular character in dense text, so the model loses the
section-divider signal that blank lines were carrying in the source. Promoting ↵↵ to a
hard row break restores the section visually without giving up dense packing of prose.

**Change:** 6 lines in `src/core/render.ts::wrapLines` — track `lastWasSentinel`, on the
second consecutive ↵ end the current visual row and consume the second sentinel.

**Tests:** 315/315 green, build clean.

**Result:** _(pending — running)_

**Result:** 94.93% mean (Δ = −2.93pp), savings 0% — recovered ~4pp vs production, did NOT close the gap.

Per-block: catastrophic blocks gone (no block below 86%). Remaining damage is broad — 6 of 20 blocks drop 5-11pp. Failing blocks all have many `\n` per char (markdown lists, code with internal newlines). The ↵↵→row-break fix only helps content with blank-line separators; list-shaped content (`- a\n- b\n- c`) still has many inline ↵ glyphs.

**Verdict:** improvement is real but not shippable. Reverted in working tree.

---

## Attempt #2 — render the instruction *inside* the image

**Hypothesis:** when the OCR instruction sits in the `system` field and
the text sits in `user.content[].image`, the model is doing cross-modal
binding to figure out what the image is *for*. Co-rendering the
instruction into the same PNG, separated from the content by a clear
delimiter band, makes it a single-modal task.

**Change:** added a `reflow-inimage` variant to `eval/eval-L1-ocr.mjs`.
Same packed reflow as `reflow`, but the prompt body has the OCR
instruction as a header band rendered into the PNG with `===…===`
delimiters, and the API `system` field is dropped (the user message is
just `Transcribe.` plus the image).

**Result (Opus 4.7, 20 blocks, 7×10 cell):**
- `baseline` (text-only):           **97.91%** mean / 96.25% min
- `reflow` (separate `system`):     91.99% mean / 82.59% min   (Δ = −5.93pp)
- **`reflow-inimage`:**             **98.95%** mean / 96.42% min (Δ = **+1.04pp**)

Per-block: `reflow-inimage` wins on **every one of 20 blocks** vs `reflow`,
and beats baseline on **17 of 20 blocks**. Three blocks hit 100%. The
−5.93pp reflow regression that cell-pitch + section-break could only
partially recover disappears entirely.

**Verdict:** decisive at the OCR layer. The mechanism (single-modal vs
cross-modal task framing) is consistent with the per-block scatter
collapsing — no fluky outliers, just a uniform shift up. The production
lift depends on whether the same effect carries from OCR (transcription)
to comprehension (tool-use, code reasoning), which the L2 session-replay
eval can answer with the same wiring.

---

# CN adaptation (pxpipe-cn fork)

## Phase 0 — CN baseline, current Unifont atlas (2026-07-05)

Corpus: `eval/extract-corpus.mjs --cjk --cjk-min 0.3` over local `~/.claude/projects`
→ 20 blocks (13,848 chars, cjkFraction 0.31–0.77) + 9 sessions, in `eval/corpus/*-cn.json`.

Offline render baseline (`scripts/cn-baseline.mjs`, renderDensePages reflow path):
- **dropped chars: 24 / 13,848 (0.17%) — zero hanzi dropped**; all drops are emoji
  outside atlas ranges (U+FE0F, U+2B50, SMP emoji). Unifont coverage of CJK Unified
  is complete at the atlas layer.
- 20 pages, 1,582 est. image tokens (px/750) → **8.75 chars/image-token** on mixed
  CN blocks vs ~1 char/token as text — imaging strongly profitable on CN *if* the
  gate lets it through (it currently doesn't: codepoint-math rows + CPT=4).
- PNGs + summary: `eval/results/cn-baseline/`.
- L1 OCR baseline (Unifont atlas, aa-5x8 variant, same 20 blocks): running via
  subscription CLI harness → `eval/results/cn-l1-baseline/`. (Result recorded below
  when complete.)

## Phase 1 — Fusion Pixel 8px monospaced atlas (2026-07-05)

Font: Fusion Pixel (缝合怪点阵) 8px monospaced zh_hans, OFL-1.1
(`assets/FusionPixel-8px-monospaced-zh_hans.otf` + `FUSION_PIXEL_LICENSE.txt`).
Three-tier gen-atlas: Spleen (ASCII) → Fusion Pixel (CJK ranges, cmap-verified
coverage — skia silently substitutes system fonts, so coverage is read from the
font's cmap formats 4/12, not draw-and-compare) → Unifont (everything else).

Regen results:
- CJK font cmap coverage: 27,976 codepoints; **14,717 / 20,992 CJK Unified glyphs
  now from Fusion Pixel** (the zh_hans flavor's common-hanzi set), 6,275 fall
  through to Unifont; also 50 CJK punct, 87+90 kana, 167 fullwidth forms.
- Total glyphs 35,501; cell invariant held at 5×8 (wide 10×8).
- atlas.ts **867 KB (was 887 KB — net shrink)**; worker bundle 8.18 MB raw /
  2.31 MB gz (unchanged in character; was already >1 MB-free-tier before fork work).
- Coverage regression check: re-ran cn-baseline on new atlas →
  **identical drop stats (24 emoji, 0 hanzi)**, same pages/tokens (geometry
  unchanged). `eval/results/cn-baseline-fusion/`. Visual check: strokes distinctly
  cleaner than Unifont's cramped generic glyphs.

## Phase 2 — CPT_CJK calibration + gate regression guard (2026-07-05)

**EN regression guard**: full vitest suite after all transform.ts gate changes
(cell-aware `countVisualRows`/`lineRows` via `lineCells`, blendedCpt in all
three profitability gates, token-equivalent reminder/tool_result thresholds,
CJK telemetry): **642/642 pass, 31 files** — pure-English decisions unchanged
(cjk=0 ⇒ blendedCpt(text, base) === base by construction).

**Calibration** (`scripts/calibrate-cn-cpt.mjs`, usage mode — relay lacks
count_tokens; 40 × max_tokens=1 probes on claude-haiku-4-5, ~pennies):
- Raw fit R²=0.389 — two outliers (block 28: 832 chars → 6,640 tokens; block 37).
- Robust refit (iterative 2.5σ rejection, 38 rows): **R²=0.996**,
  cjk=0.765 c/t, other=2.044 c/t, intercept **841 tokens/request**.
- Interpretation: the relay injects a constant ~841 tokens AND scales billed
  usage ~1.96× (other=2.04 vs ~4 real-tokenizer mixed content). Absolute fitted
  values are relay-scaled; the **ratio is inflation-invariant**: 1 CJK char =
  2.67× an "other" char. Anchored to the pipeline's baseCpt=4:
  `CPT_CJK = 4 × (0.765/2.044) = 1.497 ≈ 1.5` — the shipped conservative value
  is **confirmed by measurement**, not changed.
- Full data + refit: `eval/results/cn-cpt-calibration.json`.

## Phase 3 — CN L1 OCR: Unifont vs Fusion Pixel A/B (2026-07-05)

Harness fix first: the subscription CLI path (cci.py) is unusable on this
machine — no Max OAuth; ANTHROPIC_AUTH_TOKEN is only valid against the relay,
so stripping ANTHROPIC_BASE_URL produced 401s and silent empty replies ($0
spent, 0% scores — discarded). Added a direct-HTTP transport to
`eval/lib/anthropic-client.mjs` (auto-selected for non-local relay + token;
`PXPIPE_EVAL_TRANSPORT` overrides) with thinking-block normalization and
source-scaled `max_tokens` (2048 truncated CJK blocks >~1.5k chars — CN runs
~1 token/char, and relay-forced thinking shares the budget).

Same 20-block CN corpus, model claude-sonnet-5 via relay, A/B via
PXPIPE_EVAL_DIST=dist-unifont / dist-fusion:

| variant | Unifont | Fusion | note |
|---|---|---|---|
| aa-5x8 (reflow, cols=100) | 14.76% | 12.00% | reflow+↵ collapses on CN — not production tool_result path |
| baseline (plain dense = production) | **76.33%** | **81.68%** (+5.35pp) | median 89.0%, min 5.0% (block 6 outlier) |

- Fusion > Unifont confirmed on the production-representative variant.
- Both are far below the EN reference (97.64% mean, Opus 4.7): at 8px the
  binding constraint is glyph RESOLUTION, not glyph design — manual probe of
  block 6 shows structurally correct transcription with heavy per-hanzi
  substitution ("我亲手把他" → "张老板馆"), worst on low-predictability prose.
- Acceptance line "CN ≥ EN −2pp" NOT met at native 8px ⇒ testing the cheap
  fallback first: 2× nearest-neighbor upscale probe (cols=150, ≤1568px edge)
  before committing to a 12px Ark Pixel atlas rebuild.
- Reports: eval/results/cn-l1-{baseline,fusion}-prod/ (aa-5x8 runs kept in
  cn-l1-{baseline,fusion}/ for the record).

## Phase 3 — 2× nearest-neighbor upscale probe (2026-07-05)

New `baseline-2x` eval variant: same Fusion 5×8 atlas, cols=150 (half of
dense 312 so the 2× width stays under the API's 1568px long-edge cap), each
glyph pixel blown up to 2×2 (`imageSmoothingEnabled=false`). Same 20-block CN
corpus, claude-sonnet-5 via relay:

| variant | mean | median | min |
|---|---|---|---|
| baseline (native 8px, Fusion) | 81.68% | 89.0% | 5.0% |
| **baseline-2x** | **93.70%** | **97.00%** | 42.0% |

- **+12.0pp mean from scaling alone, identical glyph bitmaps** — confirms the
  8px-hanzi failure is a VLM encoder-resolution limit, not glyph design.
- Sole remaining outlier is block 19 (1,714 chars, 42.0%): a dense markdown
  TABLE (pipe cells, `<br>`, emails, `⭐112k` mixed tokens) that *ends with a
  question to the reader*. Multi-image-truncation theory disproved (it renders
  as ONE 758×288 image); a re-probe with an explicit transcribe-all prompt
  scored 69.0% while OVER-generating (hyp 2,239 vs ref 1,713) — the model
  drifts into reformatting/answering rather than verbatim OCR. Intrinsically
  hard content, not a rendering defect.
- Excluding block 19: mean **96.4%** — above the acceptance line
  (EN 97.64% − 2pp = 95.64%); median passes outright. Raw mean 93.70% misses
  by 1.94pp on the strength of that single table block.
- Cost check: at 2× the imaged CJK char costs ≈0.47 tok vs ≈0.67 tok as text
  (1/CPT_CJK) — compression stays profitable, margin thinner than EN.
- **Verdict: adopt 2× upscale for CJK-heavy blocks instead of the 12px Ark
  Pixel atlas rebuild** (which would cost an atlas regen, −33% rows globally,
  and a full re-eval, for at best a similar resolution win). 12px fallback
  stays documented as the escalation path if production telemetry disagrees.
- Report: eval/results/cn-l1-fusion-2x/.

## Phase 3 — CN needle (verbatim recall), CN-2× vs EN-1× (2026-07-05)

`eval/eval-cn-needle.mjs`: 5 sessions/arm, 3 seeded needles per session
(11-digit phone / 18-digit record ID / 10-char alnum order code) at 20/50/80%
depth in ~8k-char haystacks, rendered through the PUBLIC production entry
(`renderTextToImages`, reflow). EN arm uses genuine English filler built from
the repo docs (the shipped eval corpus turned out CJK-contaminated,
cjkFraction 0.16–0.88 — unusable as a 1× control). claude-sonnet-4-5, relay.

| arm | needles hit | note |
|---|---|---|
| cn-2x | **0/12** (1 trial lost to a relay 524) | model SAW the needles but misread chars, e.g. Z→2, consistently |
| en-1x | **2/15** | reproduces upstream FINDINGS "verbatim 0/15" tier |

- Verbatim readback from imaged content is unreliable in BOTH languages —
  this is the known modality property (imaged history is gist tier), not a CN
  regression. Acceptance "CN needle 与英文持平" **met** (0/12 ≈ 2/15 ≈ noise).
- Report: eval/results/cn-needle.json.

## Phase 3 — CN gist-recall A/B + the reflow-wall finding (2026-07-05)

`eval/eval-cn-gist.mjs`: 6 sessions × 6 probes (5 seeded facts at depths
12–85% + 1 unanswerable confabulation probe), ~8k-char CN transcripts from
the real-session corpus, deterministic string grading, claude-sonnet-4-5.
Initial A/B (text vs production 2× reflow image) collapsed — then isolated
the variable with image-raw (no reflow) and inter-line-gap arms:

| arm | recall | confab |
|---|---|---|
| text | 36/36 (100%) | 0 |
| image, reflow, gap 0 (production geometry then) | 10/36 + 14/36 (28–39%) | 0 |
| image-h1 (reflow, 1px gap) | 19/36 (53%) | 0 |
| image-h2 (reflow, 2px gap) | **27/36 (75%)** | 0 |
| image-raw (no reflow, natural lines) | 31/36 (86%) | 0 |

- **Root cause:** 8px hanzi fill the full cell (no ascender/descender
  whitespace like Latin), so ↵-packed reflowed rows touch vertically and
  visually interlock — the reader's "overlapping text" failure. A 2px gap
  recovers most of it; no-reflow recovers more but triples pages (negative
  savings on CN). Clean dose-response: 33% → 53% → 75% → 86%.
- confab=0 across ALL arms: failures are honest UNKNOWNs, not fabrications —
  degradation mode is "can't read", not "makes things up".
- Economics: CN text is cheap as text (CPT_CJK=1.5), so margins are thin:
  gap0 ~28%, gap2 ~9–18% savings, no-reflow negative.
- **Decision (user-approved): ship gap2** as the production CJK 2× style.
  Blocks whose margin disappears at gap2 pricing simply stay text — the gate
  repricing makes that automatic.
- Reports: eval/results/cn-gist-run1-reflow.json, cn-gist-run2-rawAB.json,
  cn-gist.json (gap arms).

## Phase 3 — gap2 productionized + offline verification (2026-07-05)

Shipped as `CJK_LINE_GAP=2` / `CJK_CELL_H=10` / `CJK_DENSE_CHARS_PER_IMAGE=5250`
(150 cols × 35 rows, full page 1516×716 scaled) + one shared
`CJK_DENSE_RENDER_STYLE` consumed by the gate (`imageTokensForRows` now takes
`cellH`) and all three render sites (transform/history/library) — pricing and
pixels stay in lockstep by construction.

- vitest **664/664**, tsc clean; cn.test.ts geometry/ratio assertions updated
  to the gap2 numbers (rows 44→35, CJK/ASCII image-cost ratio ~10×).
- Gate fixture re-check at gap2 pricing: 4k-char CN tool_result prices at
  2,473 image tokens vs 2,692 text tokens — still profitable (~8% margin,
  down from ~28% at gap0) and still ships 2 images end-to-end. The upstream
  flip (4k CN was passthrough) survives the gap2 repricing.

## Phase 3 — 真机冒烟：本地代理 + 真实中文 Claude Code 会话 (2026-07-05)

Setup: `dist/node.js` on :47899 (relay upstream), `claude -p` (Fable 5)
reading a 13.9k-char CN meeting-notes doc built from the eval corpus, base
URL pointed at the proxy via `--settings` (the CLI's own settings.json env
otherwise overrides shell env). Model gave a correct 3-point CN summary.

events.jsonl telemetry — everything the checklist asks for:
- `compressed: true`, 4 images (static system/tool-docs slab), 95,935 chars.
- `cjk_fraction: 0.056` on the turn carrying the CN tool_result (>0 ✓),
  `cpt_used: 3.706` (blended below the EN base ✓).
- Drops: `dropped_codepoints_top: {U+1F916: 1}` — one 🤖 emoji, the known
  emoji-only atlas gap; **0 hanzi** ✓.
- `passthrough_reasons: {below_threshold: 2, not_profitable: 1}` — the
  not_profitable one IS the CN doc read. Offline recompute confirms the gate
  did the right thing: the Read tool_result is line-numbered (`cat -n`
  gutters → cjkFraction 0.41 → 2× gap2 pricing) with short ragged lines, so
  imaging costs 1.35 tok/char vs 0.38 tok/char as blended text — imaging it
  would have LOST ~3.5×. Correct passthrough, not a miss: line-number
  gutters + 41% CJK is exactly the thin-margin shape gap2 repricing is
  supposed to reject.
- `baseline_probe_status: "failed"` — the baseline_tokens counterfactual
  probe doesn't work against this relay (same auth quirk as count_tokens);
  net-savings-vs-baseline for CN traffic stays estimated from the gate
  model, not probe-measured. Known relay limitation, logged.
  → **Fixed same day by the sampled usage-probe fallback (next section).**

Verdict: proxy pipeline healthy end-to-end on real CN traffic; telemetry
fields flow; gate decisions match offline math at gap2 pricing.

## Usage-probe fallback for relays without count_tokens (2026-07-05)

Diagnosis: ergouapi.com 404s `/v1/messages/count_tokens` ("Invalid URL");
the `/anthropic/...` and `/claude/...` prefix variants return HTTP 200 but
serve the relay's HTML SPA homepage — no real count_tokens anywhere, so
baseline_probe_status was permanently 'failed' and CN net savings were
unmeasurable against this upstream.

Fix: sampled max_tokens=1 replay of the PRE-compression body against
`/v1/messages` itself, reading the billed usage block as the baseline
(`input + cache_creation + cache_read`). Same trick as the CPT_CJK
calibration script, now built into the proxy:

- Opt-in via `PXPIPE_USAGE_PROBE_RATE` (0 = off default; 0.02–0.05 plenty —
  it costs real input tokens, unlike count_tokens).
- Fires in finalize(), off the client's latency path, ONLY after
  count_tokens resolved null — standard upstreams never pay for it.
- Probe body strips all `cache_control` (no cache pollution / 1.25× write
  premium) and drops `thinking` (budget_tokens < max_tokens impossible at 1).
- Cacheable-prefix decomposition preserved: when markers exist, a second
  truncated probe fills baseline_cacheable_tokens; missing → 'partial'.
- Telemetry: `baseline_probe_method: 'count_tokens' | 'usage_sample'` on
  TrackEvent so offline scorers can segment. Relay-scaled counts are fine —
  ratios vs same-upstream usage are scale-invariant.

Live check (rate=1, one real CN request through the relay):
`baseline_tokens: 36773, baseline_probe_status: "ok",
baseline_probe_method: "usage_sample"` in events.jsonl. 9 new vitest cases
pin body shaping, fire-ordering, sampling gate, and telemetry; full suite
673/673.
