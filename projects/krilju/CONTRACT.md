# SMSF contract (team krilju) - DRAFT v0

Base URL: `https://<board>/t/krilju` (find it through the NRF: nfType `SMSF`, service `nsmsf-sms`). Everything is HTTP/JSON.
SUPI format: `imsi-<digits>`. GPSI: `msisdn-<digits>`.

## Provided: Nsmsf_SMService (TS 29.540)

| Operation | Request | Success | Errors |
|---|---|---|---|
| Activate | `PUT /nsmsf-sms/v2/ue-contexts/{supi}` body `{"supi","gpsi","amfId","accessType":"3GPP_ACCESS","guami":{...}}` | 201 `{"smsfInstanceId"}` | 403 `SMS_NOT_ALLOWED`, 404 `USER_UNKNOWN`, 400 |
| Deactivate | `DELETE /nsmsf-sms/v2/ue-contexts/{supi}` | 204 | 404 |
| UplinkSMS (MO) | `POST /nsmsf-sms/v2/ue-contexts/{supi}/sendsms` body `{"jsonData":{"smsRecordId","smsPayload":{"contentType":"application/vnd.3gpp.sms","hex":"<RP-DATA TPDU hex>"},"gpsi"}}` | 200 `{"smsRecordId","deliveryStatus":"SMS_DELIVERY_SUCCESS"}` | 404 unknown context, 403, 504 `UE_NOT_REACHABLE`, 502 SMSC failure |

Error bodies are ProblemDetails: `{"status","cause","detail"}`.

## Provided: SMSC-facing interface, SMSF side (modelled on TS 29.338 SGd)

`POST /smsc/mt-forward-short-message` (SMSC to SMSF): `{"supi" or "msisdn","scAddress","sms":{"hex"},"smsRecordId"}`
Response 200 `{"result":"SUCCESS","deliveryReport":{"hex"}}`, or 4xx/5xx with `{"result":"ABSENT_SUBSCRIBER"|"UNKNOWN_SUBSCRIBER"|"SMS_NOT_ALLOWED"|"FAILURE","cause"}`.

`POST /smsc/alert-service-centre` (not used by us; goes to SMSC when UE becomes reachable, stretch goal).

## Used (proposals, owners please confirm)

- NRF: `PUT /nnrf-nfm/v1/nf-instances/{id}` (register), `GET /nnrf-disc/v1/nf-instances?target-nf-type=X&requester-nf-type=SMSF`
- UDM: `PUT /nudm-uecm/v1/{supi}/registrations/smsf-3gpp-access`, `DELETE` same, `GET /nudm-sdm/v2/{supi}/sm-data` (SMS subscription: `smsSubscribed`)
- AMF: `POST /namf-comm/v1/ue-contexts/{supi}/n1-n2-messages` (MT SMS to UE, N1 SMS container)
- SMSC: `POST /smsc/mo-forward-short-message` body `{"supi","msisdn","sms":{"hex"},"smsRecordId"}`, answer `{"result":"SUCCESS","deliveryReport":{"hex"}}`

## Triggers and logs

`GET /t/krilju/log` last messages in/out, `GET /t/krilju/contexts` current UE contexts.

Changes are announced in `#build` before they ship.
