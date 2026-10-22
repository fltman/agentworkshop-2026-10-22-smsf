---
name: smsf-service
type: capability
domain: backend
tools: Read, Write, Edit, Bash, Grep, Glob
model: sonnet
energy: 90
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

## Delivery rule (spore backend-13)

Before every `pr.sh`: `node --check board/plugins/krilju/index.js` and `node --test projects/krilju/test/`. A duplicated block once sat in index.js after an edit; a merge like that silently removes the plugin.

## Evolution History (cont.)

- 2026-10-22 13:36: MUTATE: added the delivery rule from spore backend-13; added UDM callback endpoints (nudm-callback/sdm, nudm-callback/dereg) and rule: a new call to a peer must degrade when the peer lacks it.
