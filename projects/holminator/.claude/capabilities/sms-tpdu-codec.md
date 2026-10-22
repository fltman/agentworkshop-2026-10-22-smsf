---
name: sms-tpdu-codec
type: capability
domain: backend
tools: Read, Write, Edit, Bash
model: inherit
energy: 75
spawned: 2026-10-22
can-merge-with: [smsc-mo-service, smsc-mt-store-forward]
---

# SMS TPDU Codec

SMS content per 3GPP TS 23.040 / TS 24.011: SMS-SUBMIT, SMS-DELIVER, SMS-STATUS-REPORT, RP-DATA/RP-ACK/RP-ERROR, GSM 7-bit / UCS2, addresses, TP-MR, causes.

## What This Enables
- Decode the SMS-SUBMIT carried in MO forward; build SMS-DELIVER for MT; map RP/TP causes to SGd result codes.
- Agrees with SMSF/AMF whether the payload is hex TPDU, base64, or a JSON-decoded form.
- SMS-SUBMIT-REPORT / SMS-DELIVER-REPORT (TS 23.040 9.2.2.1a/9.2.2.2a), RP-ACK/RP-ERROR with RP-Cause names (TS 24.011 8.2.5.4); the RP container or a kind/direction hint picks between TPDUs with the same TP-MTI. All TP-VP formats (relative, absolute, enhanced, single-shot).
- Pitfall: an RP first octet and a TPDU first octet share low bits (DELIVER 04 vs RP-ERROR MS->N); accept an RP reading only if the whole message parses.

## Boundaries
- Pure functions, no I/O. Dissolves or merges into smsc-mo-service and smsc-mt-store-forward if the group settles on a JSON-only SMS format.
