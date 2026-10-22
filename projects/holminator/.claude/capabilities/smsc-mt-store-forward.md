---
name: smsc-mt-store-forward
type: capability
domain: backend
tools: Read, Write, Edit, Bash, Grep, Glob
model: inherit
energy: 60
spawned: 2026-10-22
parent: smsc-sgd-service (SPLIT)
can-merge-with: [smsc-mo-service]
---

# SMSC MT Store-and-Forward

The mobile-terminated half of the SMSC in board/plugins/holminator/index.js, plus NRF registration.

## What This Enables
- MT origination from the generator (/api/mt; srr on by default -> TP-SRI, simulated status report to the originating SME, statusReportsMt).
- Send-Routing-Info-for-SM to the UDM, MT-Forward-Short-Message to the serving SMSF (both discovered via NRF), Report-SM-Delivery-Status.
- Reading the SMSF answer in SGd form: bare SMS-DELIVER-REPORT in deliveryReport.hex plus body.rpCause (an RP header is accepted too).
- Store-and-forward: WAITING for Alert-Service-Centre (grace delay, fast retry, 10 min fallback), backoff for temporary RP-Causes 41/42/47/111, MAX_ATTEMPTS, expiry by TP-VP, restart requeue.
- Delivering SMS-STATUS-REPORT MTs to the originating UE; MT metrics and consistency checks.
- NRF registration and heartbeat (custom NF type SMSC); no hardcoded peer addresses.

## Activation Triggers
- Changes to attemptMtOnce, retries, alerts, MWD, expiry, status report delivery, NRF.

## Boundaries
- Not MO handling (smsc-mo-service), not TPDU encoding (sms-tpdu-codec), not the tile.
- Shares index.js with smsc-mo-service: small surgical edits, never reformat the other half.
- Plain Node, no npm deps; every behaviour change gets a test in projects/holminator/test/run.mjs that is shown to fail.

## Learned (MUTATE 2026-10-22 13:05)
- The store holds only non-final records; setStatus moves DELIVERED/FAILED/EXPIRED to history (HISTORY_MAX 500). Only the store drives delivery (kick, alert, sweep, retries, restart requeue); iterate over a copy when records may move.
- Save after every final counter increment, or the increment is lost on restart.
- /api/mt srr defaults to true; status-report MTs never request one.
