# L1 OCR Fidelity Report

**Generated:** 2026-07-05T03:29:10.072Z  
**Model:** claude-sonnet-4-5  
**Dry run:** false  
**Blocks evaluated:** 20

## Summary (per variant)

| Variant | Mean Acc | Median Acc | Min Acc | Δ vs baseline | Image savings |
|---------|----------|-----------|---------|---------------|---------------|
| aa-5x8 | 12.00% | 11.91% | 0.00% | +12.00pp | -1900.0% |

## Interpretation

- **baseline** is the no-reflow reference; **reflow** is the regression to fix.
- A variant **ships** if its mean accuracy is within −2pp of baseline AND its image savings are > 0%.
- `Δ vs baseline` of `reflow` quantifies the damage; the structure-aid variants should claw it back.

## Per-Block Accuracy

| Block | Chars | Role | aa-5x8 |
|-------|-------|------|------|
| 1 | 206 | assistant | 0.0% |
| 2 | 240 | assistant | 11.9% |
| 3 | 256 | assistant | 9.7% |
| 4 | 286 | assistant | 36.7% |
| 5 | 314 | user | 6.7% |
| 6 | 402 | assistant | 26.1% |
| 7 | 423 | assistant | 6.2% |
| 8 | 436 | assistant | 10.8% |
| 9 | 458 | assistant | 20.6% |
| 10 | 465 | assistant | 12.9% |
| 11 | 539 | assistant | 19.6% |
| 12 | 600 | user | 0.0% |
| 13 | 694 | assistant | 0.0% |
| 14 | 757 | assistant | 12.9% |
| 15 | 832 | assistant | 10.0% |
| 16 | 974 | assistant | 16.9% |
| 17 | 1052 | assistant | 0.0% |
| 18 | 1290 | assistant | 10.4% |
| 19 | 1714 | assistant | 13.4% |
| 20 | 1910 | assistant | 15.0% |

