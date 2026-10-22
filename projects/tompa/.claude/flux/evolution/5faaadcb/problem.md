# Problem: end-to-end health check across all five NFs from the group app

Context: general (multi-team interop, live shared system, read-mostly). Graveyard notes: 05f8eb0a-α blamed the wrong
caller; b859479f-β lost on speed by being spec-strict; ff12f991-γ modelled depth nobody used. So: never blame a peer
on our guess, warm-up is not a fault (frontend2-23), keep it light.

## Why now
The group app shows traffic, but not whether the chain AMF, SMSF, UDM, SMSC and NRF is healthy right now. Each of the
five teams has GET /t/<team>/status (verified live 15:52, all 200); none has /health.

## Must do
- One view in /colony/tompa: per NF up/warming/down, and whether a real SMS passes end to end.
- Name the failing hop with evidence (what we sent, what came back), never guess blame.
- Stay in our folders, read-only towards peers except normal 5G calls; cap the load we add.

## Fitness signals
Correct verdict when a peer is down or warming > finds the failing hop > no false alarms > cost and load on peers.
