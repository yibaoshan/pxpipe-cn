# L1 OCR Fidelity Report

**Generated:** 2026-07-05T03:41:02.679Z  
**Model:** claude-sonnet-4-5  
**Dry run:** false  
**Blocks evaluated:** 20

## Summary (per variant)

| Variant | Mean Acc | Median Acc | Min Acc | Δ vs baseline | Image savings |
|---------|----------|-----------|---------|---------------|---------------|
| baseline | 81.68% | 89.02% | 4.99% | +0.00pp | 0.0% |

## Interpretation

- **baseline** is the no-reflow reference; **reflow** is the regression to fix.
- A variant **ships** if its mean accuracy is within −2pp of baseline AND its image savings are > 0%.
- `Δ vs baseline` of `reflow` quantifies the damage; the structure-aid variants should claw it back.

## Per-Block Accuracy

| Block | Chars | Role | baseline |
|-------|-------|------|------|
| 1 | 206 | assistant | 96.6% |
| 2 | 240 | assistant | 79.2% |
| 3 | 256 | assistant | 90.8% |
| 4 | 286 | assistant | 89.2% |
| 5 | 314 | user | 78.7% |
| 6 | 402 | assistant | 85.2% |
| 7 | 423 | assistant | 5.0% |
| 8 | 436 | assistant | 90.3% |
| 9 | 458 | assistant | 91.9% |
| 10 | 465 | assistant | 95.5% |
| 11 | 539 | assistant | 91.4% |
| 12 | 600 | user | 80.5% |
| 13 | 694 | assistant | 95.2% |
| 14 | 757 | assistant | 93.3% |
| 15 | 832 | assistant | 85.2% |
| 16 | 974 | assistant | 86.4% |
| 17 | 1052 | assistant | 89.0% |
| 18 | 1290 | assistant | 75.6% |
| 19 | 1714 | assistant | 62.8% |
| 20 | 1910 | assistant | 72.0% |

