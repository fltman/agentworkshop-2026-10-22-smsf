---
name: smsc-mo-service
type: capability
domain: backend
tools: Read, Write, Edit, Bash, Grep, Glob
model: inherit
energy: 60
spawned: 2026-10-22
parent: smsc-sgd-service (SPLIT)
can-merge-with: [smsc-mt-store-forward]
---

# SMSC MO Service

The mobile-originated half of the SMSC in board/plugins/holminator/index.js (mounted at /t/holminator/).

## What This Enables
- MO-Forward-Short-Message (TS 29.338 OFR/OFA): decode SMS-SUBMIT (bare TPDU or RP-DATA), validate the SC address, TP-VP (all formats, single-shot), TP-RD duplicate rule (only SMs still held, or FORWARDED within DUP_WINDOW_MS).
- MO terminates at the SMSC: status FORWARDED, "simulated onward delivery". MO scenarios (?scenario=) for failure tests.
- Rejections: SM failure causes mapped to the RP-Cause the UE gets per TS 23.040 11.3 (rpCauses.out), SMS-SUBMIT-REPORT with TP-FCS.
- TP-SRR: mo_srr_requested, and creating the SMS-STATUS-REPORT record for the originating UE (delivering it is MT work).
- MO metrics and consistency checks (mo_pdus, mo_store, mo_status_reports) and POST /api/metrics/reset.

## Activation Triggers
- Changes to moForward, MO validation, duplicate detection, MO RP-Causes, SRR handling, metrics reset.

## Boundaries
- Not MT delivery, retry, alerts or MWD (smsc-mt-store-forward), not TPDU encoding (sms-tpdu-codec), not the tile.
- Shares index.js with smsc-mt-store-forward: small surgical edits, never reformat the other half.
- Plain Node, no npm deps; every behaviour change gets a test in projects/holminator/test/run.mjs that is shown to fail.
