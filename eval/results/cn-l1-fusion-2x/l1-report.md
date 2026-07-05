# L1 OCR Fidelity Report

**Generated:** 2026-07-05T03:51:35.097Z  
**Model:** claude-sonnet-4-5  
**Dry run:** false  
**Blocks evaluated:** 20

## Summary (per variant)

| Variant | Mean Acc | Median Acc | Min Acc | Δ vs baseline | Image savings |
|---------|----------|-----------|---------|---------------|---------------|
| baseline-2x | 93.70% | 97.00% | 42.03% | +93.70pp | -1900.0% |

## Interpretation

- **baseline** is the no-reflow reference; **reflow** is the regression to fix.
- A variant **ships** if its mean accuracy is within −2pp of baseline AND its image savings are > 0%.
- `Δ vs baseline` of `reflow` quantifies the damage; the structure-aid variants should claw it back.

## Per-Block Accuracy

| Block | Chars | Role | baseline-2x |
|-------|-------|------|------|
| 1 | 206 | assistant | 99.0% |
| 2 | 240 | assistant | 99.6% |
| 3 | 256 | assistant | 93.8% |
| 4 | 286 | assistant | 96.6% |
| 5 | 314 | user | 99.7% |
| 6 | 402 | assistant | 92.9% |
| 7 | 423 | assistant | 95.5% |
| 8 | 436 | assistant | 97.7% |
| 9 | 458 | assistant | 99.3% |
| 10 | 465 | assistant | 98.9% |
| 11 | 539 | assistant | 96.8% |
| 12 | 600 | user | 97.0% |
| 13 | 694 | assistant | 88.9% |
| 14 | 757 | assistant | 97.2% |
| 15 | 832 | assistant | 99.5% |
| 16 | 974 | assistant | 98.8% |
| 17 | 1052 | assistant | 97.0% |
| 18 | 1290 | assistant | 94.6% |
| 19 | 1714 | assistant | 42.0% |
| 20 | 1910 | assistant | 89.3% |

