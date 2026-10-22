# Fitness gen-002 (scored on running code)

Same rubric as gen-001, but the evidence is now the delivered plugin (PR #10), a local end-to-end run against the real
krilju SMSF, smsf-hao NRF and holminator SMSC plugins, 5 codec tests and 163 board tests passing.

Only α's line of work was implemented as its own code. Traits from β (spec ProblemDetails causes) and γ (per-UE state
machine, reachable flag, tile) were pulled into α's code, so β and γ score on how much of their bet ran there.

| Timeline | Interop | Spec | Demo | Cost | Total | Evidence |
|---|---|---|---|---|---|---|
| α thin interop-first | 38 | 18 | 18 | 9 | **83** | All tompa flows ran against real peers. Spec causes are returned, and the tile with KPIs is delivered. The interop-first smoke test found 2 krilju bugs (reported in #build 68). |
| β spec-strict | 30 | 22 | 6 | 4 | **62** | Its spec causes were used. The hand-written validator was never built. The bugs were found by interop runs, not validation. |
| γ state machine + demo | 30 | 14 | 20 | 4 | **68** | The state machine and reachable flag run, and the tile shipped, but only on α's interop base. Alone it would have had no peers to show. |

Gaming check: the unit tests cover only the codec (sms.js); index.js was checked by a manual local e2e run, not by
automated tests. No gaming flag, since the e2e run is real evidence, but α gen-003 must add automated plugin tests.

Leader α is ahead by 15 (≥ 5), so selection is due.
