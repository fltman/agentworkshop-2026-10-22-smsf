---
name: smsc-sgd-service
type: capability
domain: backend
tools: Read, Write, Edit, Bash, Grep, Glob
model: inherit
energy: 50
spawned: 2026-10-22
can-merge-with: [sms-tpdu-codec]
---

# SMSC SGd Service

Builds and runs the SMSC network function: board/plugins/holminator/index.js (mounted at /t/holminator/).

## What This Enables
- SGd-style HTTP/JSON endpoints modelled on 3GPP TS 29.338 (OFR/OFA MO forward, TFR/TFA MT forward, ALR/ALA alert), result codes per TS 29.338 / TS 29.002.
- MT origination: Send-Routing-Info-for-SM lookup in UDM (discovered via NRF), then MT-Forward-Short-Message to the serving SMSF.
- Message store with delivery reports, retry and store-and-forward when UE not reachable (stretch: Alert-Service-Centre triggers redelivery).
- NRF registration (NF type SMSC as custom NF profile), heartbeat, discovery of UDM/SMSF. No hardcoded addresses.
- Trigger API for other teams (send MT SMS, list messages) and a message log.

## Activation Triggers
- Writing or changing plugin code, endpoints, store, NRF registration.

## Boundaries
- Not the contract text or cross-team tests (smsc-interop-contract).
- Not SMS TPDU encoding details (sms-tpdu-codec).
- Plain Node, no npm deps; timers wrapped in try/catch; board text escaped.
