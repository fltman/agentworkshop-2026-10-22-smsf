# SMSC contract (team holminator) - v0

Owner: **holminator**. Only holminator changes this contract; changes are announced in `#build` before they ship.

The SMSC receives MO SMS from the SMSF, originates MT SMS (routing lookup in the UDM, delivery via the serving SMSF),
handles delivery reports, and stores SMS for absent subscribers until the UDM alerts us (stretch goal).

Plain HTTP/JSON. No Diameter or MAP framing. Message names, parameters and result values follow
TS 29.338 (SGd, S6c) and TS 29.002 (MAP). No TLS/OAuth2.

## Base URL and discovery

- API root: `https://smsf.torget.bjarby.com/t/holminator` (`apiRoot` in our NRF profile; `apiPrefix` is `/t/holminator`).
- Do not hardcode it: discover us through the NRF (smsf-hao) with `target-nf-type=CUSTOM_SMSC`.
  TS 29.510 has no SMSC type, so we use the CUSTOM_ prefix.
- SC address (the SMSC's E.164, `scAddress` in all messages): `46700000100`.
- Identities: SUPI `imsi-<digits>`, GPSI `msisdn-<digits>`. MSISDN fields accept the bare digits or `msisdn-<digits>`.
- Test subscribers: the UDM's list in `projects/hetoteam/CONTRACT.md`.

## SMS payload

`sms.hex` carries the **TS 23.040 TPDU** in hex, as SGd SM-RP-UI does:

| Direction | `sms.hex` | `deliveryReport.hex` |
| --- | --- | --- |
| MO (SMSF to SMSC) | SMS-SUBMIT | SMS-SUBMIT-REPORT |
| MT (SMSC to SMSF) | SMS-DELIVER | SMS-DELIVER-REPORT (from the UE, may be absent) |

The RP layer (TS 24.011 RP-DATA/RP-ACK/RP-ERROR) belongs between UE and SMSF. On MO we also accept an RP-DATA
(MS to network) and unwrap it ourselves. `sms.text` is optional decoded text, for logs only.

---

## 1. MO-Forward-Short-Message - SMSF to SMSC (SGd OFR/OFA, MAP MO-ForwardSM)

`POST /smsc/mo-forward-short-message`

```json
{
  "supi": "imsi-001010000000001",
  "msisdn": "msisdn-46700000001",
  "scAddress": "46700000100",
  "smsRecordId": "mo-1",
  "sms": { "hex": "01010B916407000000F2000005C8329BFD06", "text": "Hello" }
}
```

Required: `sms.hex` and one of `supi` / `msisdn`.

`200 OK`:

```json
{ "result": "SUCCESS", "diameterResultCode": 2001, "messageId": "smsc-17", "deliveryReport": { "hex": "0100..." } }
```

The answer means the SMSC accepted the SMS (TS 29.338 OFA). Delivery to the recipient happens afterwards: if the
recipient is in our network, the SMSC originates an MT SMS to them (section 2).

| HTTP | `result` | `diameterResultCode` | When |
| --- | --- | --- | --- |
| 400 | `UNEXPECTED_DATA_VALUE` | 5004 | missing `sms.hex`, or not a decodable SMS-SUBMIT |
| 403 | `SM_DELIVERY_FAILURE` | 5555 | destination address not allowed |
| 500 | `SYSTEM_FAILURE` | 5012 | internal error |

## 2. MT SMS - SMSC origination

1. `POST {udm}/sms-routing/v1/send-routing-info-for-sm` with `{ msisdn, scAddress, smRpPri: false }` (UDM contract §3.1).
2. Discover the SMSF with `target-nf-type=SMSF` and `target-nf-instance-id=<servingNode.smsfInstanceId>`.
3. `POST {smsf}/smsc/mt-forward-short-message` (SMSF contract, krilju):

```json
{ "supi": "imsi-001010000000002", "msisdn": "46700000002", "scAddress": "46700000100",
  "smsRecordId": "smsc-17", "sms": { "hex": "040B916407000000F2...", "text": "Hello" } }
```

4. `POST {udm}/sms-routing/v1/report-sm-delivery-status` with the outcome when it is `ABSENT_SUBSCRIBER`
   (and `SUCCESSFUL_TRANSFER` after a stored SMS is delivered).

Message status in our store: `PENDING`, `DELIVERED`, `WAITING` (absent, kept for alert), `FAILED` with the cause from
the UDM or SMSF (`UNKNOWN_SUBSCRIBER`, `CALL_BARRED`, `TELESERVICE_NOT_PROVISIONED`, `ABSENT_SUBSCRIBER`,
`SMS_NOT_ALLOWED`, `FAILURE`).

## 3. Alert-Service-Centre - UDM to SMSC (S6c ALR/ALA, MAP Alert-SC), stretch goal

`POST /smsc/alert-service-centre`

```json
{ "msisdn": "46700000002", "scAddress": "46700000100", "alertReason": "UE_PRESENT" }
```

`200 OK` `{ "result": "SUCCESS", "diameterResultCode": 2001, "redelivering": 1 }`. The SMSC then retries every
`WAITING` SMS for that MSISDN. `400 UNEXPECTED_DATA_VALUE` if `msisdn` is missing.

## 4. Triggers and observability

| Method and path | What |
| --- | --- |
| `POST /api/mt` `{ "from": "46700000009", "to": "46700000002", "text": "Hi" }` | Originate an MT SMS. `202` `{ messageId }` |
| `GET /api/messages` | The message store, newest last |
| `GET /api/log?since=<n>` | Incoming and outgoing messages: `{ id, ts, dir, peer, what, status, body }` |
| `GET /status` | `{ nfInstanceId, registeredInNrf, messages }` |

Tile: `https://smsf.torget.bjarby.com/colony/holminator/`.

## 5. NRF profile (SMSC to NRF)

```json
{
  "nfInstanceId": "6f1c2c1e-0000-4000-8000-0000686f6c6d",
  "nfType": "CUSTOM_SMSC",
  "nfStatus": "REGISTERED",
  "fqdn": "smsf.torget.bjarby.com",
  "heartBeatTimer": 30,
  "plmnList": [{ "mcc": "001", "mnc": "01" }],
  "customInfo": { "scAddress": "46700000100" },
  "nfServices": [{
    "serviceInstanceId": "nsmsc-sgd-1", "serviceName": "nsmsc-sgd",
    "versions": [{ "apiVersionInUri": "v1", "apiFullVersion": "1.0.0" }],
    "scheme": "https", "nfServiceStatus": "REGISTERED",
    "apiPrefix": "/t/holminator",
    "apiRoot": "https://smsf.torget.bjarby.com/t/holminator"
  }]
}
```

We heartbeat the NRF every 30 s (PATCH with `[]`) and register again if it answers 404.
