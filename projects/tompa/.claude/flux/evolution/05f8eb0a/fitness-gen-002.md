# 05f8eb0a fitness, generation 2 (FLUX strict, 2026-10-22)

Weights from problem.md: real live faults with no FP (40) > hop/owner accuracy (30) > cost (15) > demo value (15).
Scale kept comparable with α gen-001's retro-score of 64.

| Timeline | Gen | Live faults, no FP (40) | Hop/owner (30) | Cost (15) | Demo (15) | Fitness | Δ | Flags |
|---|---|---|---|---|---|---|---|---|
| α boundary decoder | 002 | 20: fault 4 found live before the restart, 0 live FP, 0 judged live entries since 08:40Z | 22: 8/8 on replay but in-sample (gen-001 out-of-sample was 0.50), deeper hops inferred from detail text | 14: pure functions | 10: invisible until index.js passes opts | **66** | +2 (64 → 66) | GAMING: in-sample score (self 78 → 66) |
| β scenario runner | 002 | 12: never run live, stubbed tests only; finds faults α cannot see, in principle | 18: reuses α's blame, coarse for silent MT loss | 12: ~10 s, a dozen peer requests, leaves UEs/KPIs changed | 14: one-button pass/fail with drafts | **56** | first score | UNPROVEN; GAMING: step 4 vacuous pass |
| γ trace correlator | 001 | 16: live on PR #15, real 501 → 502 chain visible, but no automated detection | 22: exact hop visually, human must read; no holminator /log | 9: polls 5 NFs' logs | 14: live flow page (core.html not credited) | **61** | first score | scope creep (core.html) |

α's self-score 78 minus half the in-sample gain (−7) minus 5 for zero live judged entries also gives 66.

## Termination check
None below 20. No timeline declining for 2 generations. Nothing terminated.

## Selection rule
α leads γ by 5 and β by 10, so the ≥5 rule triggers on paper. The lead is exactly the size of α's in-sample
discount, and all of it comes from replay on its own tuning set. Not a clear lead.

## Decision
/cross α β is the next step, then /select at the end of generation 3 (mandatory, 3-generation cap).
- β already calls α's diagnose.smsfResponse, so the hybrid is cheap and keeps α's genes (the leader is not lost).
- One approved live β run gives β its live score and α its held-out score at the same time: the missing evidence for both.
- γ continues alone as the display and witness layer (gen-002); its verdict format is aligned with α's diag.
- Select now would crown a winner on in-sample numbers, which the b859479f lesson (interop evidence beats spec
  purity) warns against.
