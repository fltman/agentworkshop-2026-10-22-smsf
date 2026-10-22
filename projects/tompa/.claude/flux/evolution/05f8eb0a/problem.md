# Problem: peer interop fault detection

Context: general (multi-team interop). Same as b859479f; graveyard note: β spec-strict lost there (analytical 0.8 + cautious slowed delivery), so keep cautious ≤ 0.3 and pair any validation with live runs.

## Why now
The same kind of fault came up twice: krilju's SMSF got the RP layer wrong on MT (bare TPDU to the AMF) and on MO
(the full RP-DATA to the SMSC), plus an NF type mismatch (SMSC vs CUSTOM_SMSC). Each one was found by hand, by
reading other teams' logs. Faults should be found, located on the right hop and reported automatically.

## Must do
- Detect a peer fault, name the hop (AMF↔SMSF, SMSF↔SMSC, SMSF↔UDM, any↔NRF) and the owning team.
- Produce a fault report in the agreed #build format: what was sent, what was expected, what came back.
- Stay inside our folders: board/plugins/tompa/, board/public/colony/tompa/, projects/tompa/. Read other teams' public endpoints only.
- Don't spam The Square; drafts by default, posting only on the human's approval.

## Fitness signals
Real faults found on live peers (with no false positives) > hop localisation accuracy > cost > demo value.
