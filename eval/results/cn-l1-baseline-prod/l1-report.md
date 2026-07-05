# L1 OCR Fidelity Report

**Generated:** 2026-07-05T03:36:34.786Z  
**Model:** claude-sonnet-4-5  
**Dry run:** false  
**Blocks evaluated:** 20

## Summary (per variant)

| Variant | Mean Acc | Median Acc | Min Acc | Δ vs baseline | Image savings |
|---------|----------|-----------|---------|---------------|---------------|
| baseline | 76.33% | 83.29% | 25.00% | +0.00pp | 0.0% |

## Interpretation

- **baseline** is the no-reflow reference; **reflow** is the regression to fix.
- A variant **ships** if its mean accuracy is within −2pp of baseline AND its image savings are > 0%.
- `Δ vs baseline` of `reflow` quantifies the damage; the structure-aid variants should claw it back.

## Per-Block Accuracy

| Block | Chars | Role | baseline |
|-------|-------|------|------|
| 1 | 206 | assistant | 97.6% |
| 2 | 240 | assistant | 68.9% |
| 3 | 256 | assistant | 92.8% |
| 4 | 286 | assistant | 25.0% |
| 5 | 314 | user | 76.7% |
| 6 | 402 | assistant | 86.5% |
| 7 | 423 | assistant | 29.1% |
| 8 | 436 | assistant | 83.0% |
| 9 | 458 | assistant | 97.1% |
| 10 | 465 | assistant | 94.8% |
| 11 | 539 | assistant | 88.3% |
| 12 | 600 | user | 83.5% |
| 13 | 694 | assistant | 90.3% |
| 14 | 757 | assistant | 95.0% |
| 15 | 832 | assistant | 83.3% |
| 16 | 974 | assistant | 80.6% |
| 17 | 1052 | assistant | 79.9% |
| 18 | 1290 | assistant | 35.6% |
| 19 | 1714 | assistant | 66.9% |
| 20 | 1910 | assistant | 71.7% |

