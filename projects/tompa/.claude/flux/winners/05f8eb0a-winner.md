---
name: 05f8eb0a-winner
problem-hash: 05f8eb0a
problem: "peer interop fault detection"
context: multi-team interop, live demo
winner: β (scenario runner)
generation: 3
fitness-history: [provisional, 56, 56, 85 live]
---
# Winner: β, scenario runner (85 vs δ 77, γ 62, α 55)

Why it won: it judges the peers by driving real end-to-end flows and comparing outcomes to the expected cause,
so it cannot blame a peer for traffic it did not send. Live: 6/6 scenarios pass, 299 MO at 1 msg/s with 0 failures,
and it was the first to notice MO now terminates at the SMSC (PR 25), forcing an MT leg via the SMSC API.

Absorbed from the losers: α's boundary decoder stays as a passive annotator (not a verdict) on the faults list;
γ's call flow stays as the group-app view; δ's per-step report field is kept in the runner output.

Meta-learnings:
- Outcome-based checks beat boundary decoding for blame: a decoder sharing the node's own codec inherits its blind
  spots (status report FP) and an endpoint-based owner guesses the sender (probe traffic blamed on krilju).
- Active scenarios need a fixed test-data contract with the peers (UE1-5, unknown SUPI) and shared time windows.
- Gaming guard: live run, not unit tests, decided this selection; the 2 FPs were counted, not hidden.

## Winning genome
---
name: timeline-β-gen-003
type: evolved-agent
timeline: β
generation: 3
parent: gen-002
problem-hash: 05f8eb0a
context: general
genome:
  traits: [methodical: 0.7, defensive: 0.5, creative: 0.3]
  skills: [testing: 0.8, api-design: 0.6]
fitness-history:
  - gen-001: idea only (unscored)
  - gen-002: 56 (FLUX strict; built, 26/26 stubbed tests, zero live runs)
  - gen-003: current
warnings: [UNPROVEN: no live run yet, GAMING FLAG gen-002: step 4 can pass vacuously, live run gated on human approval, last generation before mandatory /select]
---
# β gen-003: scenario runner, live and side-effect clean

## Mutations
- **Live gate first (no score without it)**: one full run against the live peers, after the human approves it. Record
  every row (step, expected, got, verdict, hop, owner) in `timeline-β/live-evidence.md`. Drafted reports stay drafts.
- **TRAIT_ADJUST defensive 0.4 → 0.5, remove the vacuous pass**: step 4 (MT to barred UE4) is `inconclusive`, not
  `pass`, when no cause comes back and step 1 did not prove the MT leg in the same run. A step that cannot fail must
  not count as a pass.
- **Cleanup step**: after the run, deregister the test UEs it registered and restore UE2 reachability, so the live
  KPIs and the next run start clean.
- **Traffic isolation**: refuse to start (409) while the traffic generator (traffic.js) is running, or tag scenario
  traffic so its KPIs and causes counters are kept apart. Otherwise a load fault shows up as a scenario fault.
- **TRAIT_ADJUST creative 0.4 → 0.3**: no new steps. Depth on the 6 existing steps instead of breadth.

## Fitness goal for gen-003
≥ 1 real live fault found with a correct #build draft, 0 false positives on the live run, run cost ≤ 15 s.
