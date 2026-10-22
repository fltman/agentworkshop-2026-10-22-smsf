# SMSF contract (team krilju) - v1 (aligned with UDM v0 and AMF v0 drafts)

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

When the UE answers with RP-ERROR the SMSF returns `502 {"result":"FAILURE","cause":"UE answered RP-ERROR","rpCause":<integer, TS 24.011 8.2.5.4>,"deliveryReport":{"hex"}}`.
`rpCause` is the single source of the RP-Cause and is always present. `deliveryReport.hex` is optional and, when present, is the bare TPDU (SMS-DELIVER-REPORT), never an RP envelope. The SMSC classifies on `rpCause` alone.

`POST /smsc/alert-service-centre` (not used by us; goes to SMSC when UE becomes reachable, stretch goal).

## Used (as agreed with the owners' contracts)

- NRF: `PUT /nnrf-nfm/v1/nf-instances/{id}` (register, stable id), `GET /nnrf-disc/v1/nf-instances?target-nf-type=X&requester-nf-type=SMSF`. Base URL of a peer = `nfServices[0].apiPrefix`.
- UDM (hetoteam): Activate does `PUT /nudm-uecm/v1/{supi}/registrations/smsf-3gpp-access`, then `GET /nudm-sdm/v2/{supi}/sms-data` (`smsSubscribed` false gives 403 SMS_NOT_ALLOWED and we deregister) and `GET .../sms-mng-data` (`moSmsSubscribed` false or `moSmsBarringAll` true gives 403 MO_SMS_BARRED on UplinkSMS). Deactivate does `DELETE` on the registration.
- AMF (tompa): MT SMS via `POST /namf-comm/v1/ue-contexts/{supi}/n1-n2-messages` with `n1MessageContainer.n1MessageClass "SMS"`, top-level `smsPayload {contentType, hex}` and `smsRecordId`. 404 or 504 gives ABSENT_SUBSCRIBER towards the SMSC.
- MT delivery report: the UE answers with UplinkSMS (`sendsms`) carrying the same `smsRecordId`. The SMSF matches it to the pending MT (15 s timeout), does not forward it to the SMSC as MO, and answers the SMSC's MT call with the report. A first octet with RP-MTI 4 is treated as RP-ERROR.
- SMSC (holminator, to be confirmed): `POST /smsc/mo-forward-short-message` body `{"supi","msisdn","sms":{"hex"},"smsRecordId"}`, answer `{"result":"SUCCESS","deliveryReport":{"hex"}}`

## NRF profile

nfType `SMSF`, stable nfInstanceId `6f1c2c1e-0000-4000-8000-0000006b7269`, service `nsmsf-sms` v2, fqdn `smsf.torget.bjarby.com`, apiPrefix `/t/krilju`, apiRoot `https://smsf.torget.bjarby.com/t/krilju`. We heartbeat the NRF every 20 s and re-register if the NRF forgot us. The SMSC is discovered as `CUSTOM_SMSC`.

## RP layering (agreed with tompa and holminator)

The RP layer (TS 24.011) exists only between UE and SMSF. The SMSF to SMSC leg carries the bare TS 23.040 TPDU in `sms.hex`.
- MO: UplinkSMS `smsPayload.hex` is an RP-DATA (MTI 0). The SMSF strips it, sends the SMS-SUBMIT TPDU to the SMSC with `scAddress` taken from RP-DA, and returns the RP message for the UE in the response as `smsPayload {contentType, hex}`: RP-ACK (MTI 3, with the SUBMIT-REPORT in RP-User-Data) on success, RP-ERROR (MTI 5, cause 21 for an SMSC rejection, 38 otherwise) in the error body. The same RP-MR is used.
- MT: the SMSC sends the bare SMS-DELIVER TPDU. The SMSF wraps it in RP-DATA network to MS (MTI 1, new RP-MR, RP-OA = SC address, RP-DA empty) for the N1N2 call. The UE's RP-ACK or RP-ERROR comes back via UplinkSMS, matched on `smsRecordId` or on supi plus RP-MR.

## Triggers and logs

`GET /t/krilju/log` last messages in/out, `GET /t/krilju/contexts` current UE contexts.

Changes are announced in `#build` before they ship.
