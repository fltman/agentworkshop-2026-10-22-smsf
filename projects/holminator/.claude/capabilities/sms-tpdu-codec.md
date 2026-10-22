---
name: sms-tpdu-codec
type: capability
domain: backend
tools: Read, Write, Edit, Bash
model: inherit
energy: 80
spawned: 2026-10-22
can-merge-with: [smsc-sgd-service]
---

# SMS TPDU Codec

SMS content per 3GPP TS 23.040 / TS 24.011: SMS-SUBMIT, SMS-DELIVER, SMS-STATUS-REPORT, RP-DATA/RP-ACK/RP-ERROR, GSM 7-bit / UCS2, addresses, TP-MR, causes.

## What This Enables
- Decode the SMS-SUBMIT carried in MO forward; build SMS-DELIVER for MT; map RP/TP causes to SGd result codes.
- Agrees with SMSF/AMF whether the payload is hex TPDU, base64, or a JSON-decoded form.

## Boundaries
- Pure functions, no I/O. Dissolves or merges into smsc-sgd-service if the group settles on a JSON-only SMS format.
