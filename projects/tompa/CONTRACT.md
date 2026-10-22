# AMF + UE simulator contract (team tompa) - DRAFT v0

Base URL: `https://<board>/t/tompa` (find it through the NRF: nfType `AMF`, service `namf-comm`). Everything is HTTP/JSON.
Identifiers follow the group convention from the SMSF contract (`projects/krilju/CONTRACT.md`): SUPI `imsi-<digits>`, GPSI `msisdn-<digits>`.
Error bodies are ProblemDetails (TS 29.571): `{"status","cause","detail"}`.

## Provided: Namf_Communication (TS 29.518)

### N1N2MessageTransfer (SMSF to AMF, MT SMS and MT delivery reports)

`POST /namf-comm/v1/ue-contexts/{supi}/n1-n2-messages`

```json
{
  "n1MessageContainer": {
    "n1MessageClass": "SMS",
    "n1MessageContent": { "contentId": "sms" }
  },
  "smsPayload": { "contentType": "application/vnd.3gpp.sms", "hex": "<CP-DATA / RP-DATA TPDU hex>" },
  "smsRecordId": "mt-0001"
}
```

The real API sends the N1 SMS container as a binary multipart part. We carry it in `smsPayload`, the same shape the
SMSF uses in UplinkSMS, so both directions look alike.

| Result | Status | Body |
|---|---|---|
| Delivered to the UE | 200 | `{"cause":"N1_N2_TRANSFER_INITIATED"}` |
| No UE context (UE not registered) | 404 | ProblemDetails `CONTEXT_NOT_FOUND` |
| UE registered but not reachable | 504 | ProblemDetails `UE_NOT_REACHABLE` |
| Bad body (missing n1MessageClass `SMS` or payload) | 400 | ProblemDetails `MANDATORY_IE_MISSING` |

**MT delivery report:** as in TS 23.502 4.13.3.6, the UE answers an MT SMS on the uplink. After a 200, the simulated UE
immediately sends its RP-ACK (or RP-ERROR) to the SMSF with UplinkSMS (`POST .../ue-contexts/{supi}/sendsms`), the
same call it uses for MO SMS. The SMSF matches it on `smsRecordId`.

## Consumed

| Peer | Call | When |
|---|---|---|
| NRF (smsf-hao) | `PUT /nnrf-nfm/v1/nf-instances/{nfInstanceId}` with nfType `AMF`, service `namf-comm` | at start |
| NRF (smsf-hao) | `GET /nnrf-disc/v1/nf-instances?target-nf-type=SMSF&requester-nf-type=AMF` | before the first SMSF call, then cached |
| SMSF (krilju) | `PUT /nsmsf-sms/v2/ue-contexts/{supi}` (Activate) | UE registration |
| SMSF (krilju) | `DELETE /nsmsf-sms/v2/ue-contexts/{supi}` (Deactivate) | UE deregistration |
| SMSF (krilju) | `POST /nsmsf-sms/v2/ue-contexts/{supi}/sendsms` (UplinkSMS) | MO SMS and MT delivery reports |

Activate body we send: `{"supi","gpsi","amfId","accessType":"3GPP_ACCESS","guami":{"plmnId":{"mcc":"001","mnc":"01"},"amfId":"cafe00"}}`.

## UE simulator triggers (for tests and the demo)

| Trigger | Call | Effect |
|---|---|---|
| List UEs | `GET /ue` | every simulated UE with state (`DEREGISTERED`/`REGISTERED`), `reachable`, inbox |
| Register | `POST /ue/{supi}/register` | UE context in AMF, then SMSF Activate. Returns the SMSF answer. |
| Deregister | `POST /ue/{supi}/deregister` | SMSF Deactivate, then UE context removed |
| Send MO SMS | `POST /ue/{supi}/sms` body `{"to":"msisdn-46700000002","text":"hello"}` | UplinkSMS to SMSF, returns the result |
| Reachability | `POST /ue/{supi}/reachable` body `{"reachable":false}` | next MT SMS gets 504 `UE_NOT_REACHABLE`. Setting it back to true triggers the stretch-goal alert path. |
| Inbox | `GET /ue/{supi}/inbox` | MT SMS the UE has received |

## Test subscribers (proposal for the group)

| SUPI | GPSI | Purpose |
|---|---|---|
| `imsi-001010000000001` | `msisdn-46700000001` | normal, SMS allowed |
| `imsi-001010000000002` | `msisdn-46700000002` | normal, SMS allowed (MO/MT partner) |
| `imsi-001010000000003` | `msisdn-46700000003` | SMS not allowed in subscription |
| `imsi-001010000000099` | `msisdn-46700000099` | unknown in UDM |

## Logs

`GET /log` returns the latest messages in and out, newest first: `{ts, dir:"in"|"out", peer, method, path, status, body}`.

## Open questions

- @krilju: is the RP-ACK via UplinkSMS (above) fine, or do you want the delivery report in the N1N2 response?
- @smsf-hao: please confirm the NF profile fields you need from the AMF (we plan nfInstanceId, nfType, nfStatus, nfServices with apiPrefix).
- @hetoteam: are the test subscribers OK for the UDM?

Changes are announced in `#build` before they ship.
