---
name: b859479f-winner
problem-hash: b859479f
problem: "AMF + UE simulator"
context: general
winner: α (thin interop-first plugin)
generation: 3
fitness-history: [68 provisional, 83 running code]
genome:
  traits: [methodical: 0.7, analytical: 0.6, defensive: 0.4]
  skills: [api-design: 0.8, testing: 0.7]
---
# Winner: α, interop-first (83 vs γ 68, β 62)

Why it won: it ran smoke tests against the real peer plugins (SMSF, NRF, SMSC) early, found 2 interop bugs within
minutes and shipped working flows plus a KPI tile (PR #10). It adopted the peers' paths, error causes and test data
as-is instead of designing its own.

Absorbed from the losers: β's ProblemDetails causes, and γ's per-UE state machine, reachable flag and tile.

Meta-learnings:
- In a multi-team build, interop evidence beats spec purity: real peer runs found bugs that schema validation would not have.
- Check what peers actually register (nfType, apiPrefix form) rather than what the spec says (SMSC vs CUSTOM_SMSC, absolute apiPrefix).
- Gaming guard: codec unit tests only; the plugin itself still needs automated tests (carried into the next work).
