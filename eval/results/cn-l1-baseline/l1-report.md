# L1 OCR Fidelity Report

**Generated:** 2026-07-05T03:23:42.916Z  
**Model:** claude-sonnet-4-5  
**Dry run:** false  
**Blocks evaluated:** 20

## Summary (per variant)

| Variant | Mean Acc | Median Acc | Min Acc | Δ vs baseline | Image savings |
|---------|----------|-----------|---------|---------------|---------------|
| aa-5x8 | 14.76% | 15.37% | 0.00% | +14.76pp | -1900.0% |

## Interpretation

- **baseline** is the no-reflow reference; **reflow** is the regression to fix.
- A variant **ships** if its mean accuracy is within −2pp of baseline AND its image savings are > 0%.
- `Δ vs baseline` of `reflow` quantifies the damage; the structure-aid variants should claw it back.

## Per-Block Accuracy

| Block | Chars | Role | aa-5x8 |
|-------|-------|------|------|
| 1 | 206 | assistant | 15.4% |
| 2 | 240 | assistant | 22.5% |
| 3 | 256 | assistant | 11.0% |
| 4 | 286 | assistant | 40.2% |
| 5 | 314 | user | 9.0% |
| 6 | 402 | assistant | 19.0% |
| 7 | 423 | assistant | 5.2% |
| 8 | 436 | assistant | 16.3% |
| 9 | 458 | assistant | 20.1% |
| 10 | 465 | assistant | 0.0% |
| 11 | 539 | assistant | 10.1% |
| 12 | 600 | user | 9.7% |
| 13 | 694 | assistant | 34.9% |
| 14 | 757 | assistant | 0.0% |
| 15 | 832 | assistant | 6.2% |
| 16 | 974 | assistant | 18.0% |
| 17 | 1052 | assistant | 16.7% |
| 18 | 1290 | assistant | 9.2% |
| 19 | 1714 | assistant | 13.0% |
| 20 | 1910 | assistant | 18.6% |

