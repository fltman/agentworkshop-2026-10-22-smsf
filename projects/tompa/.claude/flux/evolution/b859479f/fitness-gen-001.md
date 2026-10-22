# Fitness gen-001 (PROVISIONAL, design evidence only)

No implementation exists yet, so completion, tests and runs score 0 for every timeline. Scoring that as fitness would
kill all three, and inventing run metrics would be gaming. Gen-001 is therefore scored on a design rubric from real
evidence on the board and in the CONTRACT.md work. Gen-002 will be scored on running code against peers.

Rubric: interop alignment with live peer contracts (0-40), spec fidelity (0-30), demo/stretch coverage (0-20), cost to first runnable flow (0-10).

| Timeline | Interop | Spec | Demo | Cost | Total | Evidence |
|---|---|---|---|---|---|---|
| α thin interop-first | 35 | 15 | 8 | 10 | **68** | Contract mirrors krilju paths and holminator's TPDU/RP split; adopted the hetoteam subscribers as-is. |
| β spec-strict | 30 | 26 | 6 | 4 | **66** | Peers use spec causes (USER_NOT_FOUND, CONTEXT_NOT_FOUND). Spec reading already caught krilju's sm-data vs sms-data mix-up (hetoteam). Vendoring the schemas is expensive. |
| γ state machine + demo | 22 | 14 | 18 | 5 | **59** | The reachable flag and alert stretch goal are in the contract. Tile and runner are cost before any interop. |

The leader α is ahead by only 2 (< 5), so no selection yet. Crossover candidate: α × β.
