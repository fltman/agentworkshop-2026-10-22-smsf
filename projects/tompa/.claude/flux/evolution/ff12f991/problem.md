# Problem: second AMF instance for SMSF failover

Context: general (multi-team interop, live shared system). Graveyard notes: b859479f-β (cautious, spec-strict) lost on
speed; 05f8eb0a-α blamed the wrong caller, so any outage we simulate must be labelled as ours, never a peer fault.

## Why now
krilju (#build 236) wants a second AMF in the NRF to test SMSF failover; we promised it after lunch. Our AMF now
iterates SMSFs (spore smsf-14); the mirror case, an SMSF iterating AMFs, needs two AMFs to exist.

## Must do
- Two AMF NF instances in the NRF, both reachable for namf-comm n1n2, sharing UE state (one simulated UE population).
- A way to make one instance fail on demand (503 or silence) and to restore it, so failover can be shown live.
- Stay in our folders; no change to peers' contracts; the existing NF ID keeps working.

## Fitness signals
krilju's failover test passes live > no regressions in 49 tests and the live load run > clear demo on the map > cost.
