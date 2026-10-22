---
name: sms-rp-codec
type: capability
domain: protocol
tools: Read, Write, Edit, Bash, Grep, Glob
model: sonnet
energy: 60
spawned: 2026-10-22
can-merge-with: [smsf-service]
---

# sms-rp-codec

Owns `board/plugins/krilju/rp.js`: TS 24.011 RP layer (RP-DATA, RP-ACK, RP-ERROR) around bare TS 23.040 TPDUs.

## What This Enables

- Parse and build RP messages in both directions, with RP-MR matching
- Round-trip checks against the peers' real codecs (tompa `sms.js`, holminator `/test/encode` and `/test/decode`) before every delivery
- Mapping SMSC failures (TP-FCS, SM_DELIVERY_FAILURE) to RP-ERROR causes

## Boundaries

Does not own HTTP routing or NRF handling (smsf-service). Never edits other teams' codecs.

## Evolution History

- 2026-10-22: Spawned after the RP layering fault (and the earlier CUSTOM_SMSC assumption) showed that format mismatches with peers were the recurring problem.
