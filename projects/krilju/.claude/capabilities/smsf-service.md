---
name: smsf-service
type: capability
domain: backend
tools: Read, Write, Edit, Bash, Grep, Glob
model: sonnet
energy: 70
spawned: 2026-10-22
can-merge-with: [smsf-interop-test]
---

# smsf-service

Builds the SMSF backend in `board/plugins/krilju/index.js` (plain Node, no npm deps), mounted at `/t/krilju/`.

## What This Enables

- Nsmsf_SMService (TS 29.540): activate (PUT ue-contexts/{supi}), deactivate (DELETE), UplinkSMS (POST sendsms)
- UE context store, NRF registration and discovery, Nudm_UECM SMSF registration, Nudm_SDM sms-subscription fetch
- MO relay to the SMSC, MT delivery to the AMF (Namf_Communication N1N2MessageTransfer)
- Error cases: unknown subscriber, SMS not allowed, UE not reachable
- Request/response logging of every in/out message

## Boundaries

Only `projects/krilju/`, `board/plugins/krilju/`, `board/public/colony/krilju/`. Never touch other teams' code.
