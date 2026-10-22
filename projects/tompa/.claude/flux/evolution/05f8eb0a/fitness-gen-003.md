# 05f8eb0a fitness, generation 3 (FLUX strict, 2026-10-22 11:07)

Same weights as gen-002: live faults with no FP (40), hop/owner (30), cost (15), demo (15).

| Timeline | Gen | Live (40) | Hop/owner (30) | Cost (15) | Demo (15) | Fitness | Δ | Flags |
|---|---|---|---|---|---|---|---|---|
| α boundary decoder | 003 | 14: FIRST LIVE FALSE POSITIVE, holminator #build 174: a valid SMS-STATUS-REPORT (TP-MTI 2) was flagged "RP-DATA does not decode" and our UE sent RP-ERROR, the SMSF answered 502. Fixed in sms.parseMt within 7 min (PR 20). | 22: blame on the FP was wrong (SMSF blamed, the defect was ours) | 14 | 13: opts and diag.also now wired in index.js | **63** | −3 ▼ | own-node blind spot: the decoder shares the codec it judges |
| β scenario runner | 003 | 12: still not run live (PR 20 not deployed) | 18 | 12 | 14 | **56** | 0 ─ | UNPROVEN, stagnant on paper only |
| γ trace correlator | 002 | 16: no new work | 22 | 9 | 14 | **61** | 0 ─ | idle |
| δ α×β cross | 001 | provisional, no live run | | | | **61 (provisional)** | — | unscored |

## Termination check
None below 20. No timeline has two scored declines. Nothing terminated.

## Mutations recorded (no gen-004: 3-generation cap)
- α: SKILL_ADD spec-coverage 0.7 (enumerate every TP-MTI/RP-MTI the peer may legally send before calling it a fault);
  defensive 0.6 → 0.7; rule: when the decoder throws on OUR codec, blame tompa first, not the sender.
- β, δ: no mutation until live evidence. γ: none.

## Decision
Generation 3 is scored, but β and δ have zero live evidence and α's lead is gone (63 vs 61 vs 61, < 5).
Selecting now would crown a winner on paper. /select runs right after the approved live run
(6 scenarios, then 1 msg/s for 5 min) as soon as PR 20 is live; that run scores β, δ and α held-out at once.
Lesson for the graveyard/winner file: a decoder that reuses the node's own codec inherits its blind spots.
