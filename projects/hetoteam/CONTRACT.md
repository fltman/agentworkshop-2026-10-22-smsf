# UDM contract (hetoteam) — draft v0

Owner: **hetoteam**. Only hetoteam changes this contract; changes are announced in `#build` before they ship.

The UDM holds subscriber data, stores which SMSF serves a UE, and answers the SMSC's routing lookup for MT SMS.

| Interface | Spec | Consumers |
| --- | --- | --- |
| Nudm_UECM (SMSF registration) | TS 29.503 | SMSF (krilju) |
| Nudm_SDM (SMS subscription data) | TS 29.503 | SMSF (krilju) |
| Simulated SRI-for-SM / Report-SM-Delivery-Status | TS 29.002 (MAP), TS 29.338 (S6c) | SMSC (holminator) |
| Alert-Service-Centre (UDM → SMSC, stretch goal) | TS 29.002 / TS 29.338 | UDM calls SMSC (holminator) |
| Nnrf_NFManagement | TS 29.510 | UDM calls NRF (smsf-hao) |

## Base URL and discovery

- API root: `https://smsf.torget.bjarby.com/t/hetoteam` (`apiRoot` in our NRF profile; `fqdn` + `apiPrefix` give the same).
- Do not hardcode it: discover us through the NRF with `target-nf-type=UDM`.
- HTTP/JSON. Success bodies are `application/json`. Errors are `application/problem+json` (`ProblemDetails`,
  TS 29.571): `{ "status": 404, "title": "...", "cause": "USER_NOT_FOUND", "detail": "..." }`.
- No TLS/OAuth2 (out of scope).

## UE identities

- `{ueId}` in UECM and `{supi}` in SDM accept a SUPI (`imsi-<15 digits>`). UECM also accepts a GPSI
  (`msisdn-<digits>`).
- PLMN for the workshop: MCC `001`, MNC `01`.

## Test subscribers (proposal, open for comments in #build)

| SUPI | GPSI | Profile | Expected behaviour |
| --- | --- | --- | --- |
| imsi-001010000000001 | msisdn-46700000001 | SMS allowed | All flows work |
| imsi-001010000000002 | msisdn-46700000002 | SMS allowed | All flows work (second party for MO/MT) |
| imsi-001010000000003 | msisdn-46700000003 | `smsSubscribed: false` | SMSF must reject SMS activation (SMS not allowed) |
| imsi-001010000000004 | msisdn-46700000004 | `mtSmsBarringAll: true` | MT SMS barred: SRI-for-SM returns `CALL_BARRED` |
| imsi-001010000000005 | msisdn-46700000005 | `moSmsBarringAll: true` | MO SMS barred: SMSF must reject uplink SMS |
| imsi-001019999999999 | msisdn-46799999999 | not provisioned | `404 USER_NOT_FOUND` / `UNKNOWN_SUBSCRIBER` |

Any SUPI or GPSI not in the table is unknown, for example tompa's `imsi-001010000000099`.

---

## 1. Nudm_UECM — SMSF registration for 3GPP access (TS 29.503 §5.3)

### 1.1 Register — `PUT /nudm-uecm/v1/{ueId}/registrations/smsf-3gpp-access`

Request body `SmsfRegistration`:

```json
{
  "smsfInstanceId": "6f1c2c1e-0000-4000-8000-000000000001",
  "plmnId": { "mcc": "001", "mnc": "01" },
  "smsfMAPAddress": "46700000999",
  "smsfDiameterAddress": { "name": "smsf.krilju", "realm": "workshop" },
  "supportedFeatures": "0"
}
```

Required: `smsfInstanceId`, `plmnId`. Optional: `smsfSetId`, `smsfMAPAddress`, `smsfDiameterAddress`, `supportedFeatures`.

| Result | When |
| --- | --- |
| `201 Created` + `Location` header + body `SmsfRegistration` | New registration |
| `200 OK` + body `SmsfRegistration` | Registration replaced (same or another SMSF) |
| `400 Bad Request`, cause `MANDATORY_IE_MISSING` | `smsfInstanceId` or `plmnId` missing |
| `404 Not Found`, cause `USER_NOT_FOUND` | Unknown subscriber |

Side effect (stretch goal): if the UE has Message Waiting Data, the UDM sends Alert-Service-Centre to each stored
SMSC address (see section 4).

### 1.2 Read — `GET /nudm-uecm/v1/{ueId}/registrations/smsf-3gpp-access`

`200 OK` + `SmsfRegistration`. `404` cause `USER_NOT_FOUND` (unknown UE) or `CONTEXT_NOT_FOUND` (no SMSF registered).

### 1.3 Deregister — `DELETE /nudm-uecm/v1/{ueId}/registrations/smsf-3gpp-access[?smsf-set-id=...]`

`204 No Content`. `404` cause `USER_NOT_FOUND` or `CONTEXT_NOT_FOUND`.

---

## 2. Nudm_SDM — SMS subscription data (TS 29.503 §6.1)

> Note for **@krilju**: in TS 29.503 the SMS subscription is `sms-data` and `sms-mng-data`. `sm-data` is *session
> management* (PDU session) data, which the SMSF does not need. We serve `sms-data` and `sms-mng-data`.

### 2.1 `GET /nudm-sdm/v2/{supi}/sms-data` → `SmsSubscriptionData`

```json
{ "smsSubscribed": true }
```

### 2.2 `GET /nudm-sdm/v2/{supi}/sms-mng-data` → `SmsManagementSubscriptionData`

```json
{
  "mtSmsSubscribed": true,
  "mtSmsBarringAll": false,
  "mtSmsBarringRoaming": false,
  "moSmsSubscribed": true,
  "moSmsBarringAll": false,
  "moSmsBarringRoaming": false
}
```

### 2.3 `GET /nudm-sdm/v2/{supi}?dataset-names=SMS_SUB,SMS_MNG` → `SubscriptionDataSets`

```json
{ "smsSubsData": { "smsSubscribed": true }, "smsMngData": { "mtSmsSubscribed": true, "...": "..." } }
```

Optional query parameter `plmn-id` is accepted and ignored. Errors on all SDM calls: `404` cause `USER_NOT_FOUND`;
`404` cause `DATA_NOT_FOUND` if the data set is not provisioned.

How the SMSF uses it (TS 23.502 §4.13.3.1): after UECM registration, fetch `sms-data` and `sms-mng-data`. If
`smsSubscribed` is false, reject activation (SMS not allowed). Check `moSmsSubscribed`/`moSmsBarringAll` before MO.

---

## 3. Simulated SMSC ↔ UDM routing interface (MAP SRI-for-SM / Diameter S6c)

This replaces MAP `SendRoutingInfoForSM` and `ReportSM-DeliveryStatus` (TS 29.002) and their Diameter S6c
equivalents SRR/RDR (TS 29.338) with HTTP/JSON. Parameter names follow the specs.

### 3.1 Send-Routing-Info-for-SM — `POST /sms-routing/v1/send-routing-info-for-sm`

Request:

```json
{ "msisdn": "46700000002", "scAddress": "46700000100", "smRpPri": false }
```

`200 OK` (UE has a serving SMSF):

```json
{
  "imsi": "001010000000002",
  "supi": "imsi-001010000000002",
  "servingNode": {
    "nodeType": "SMSF",
    "smsfInstanceId": "6f1c2c1e-0000-4000-8000-000000000001",
    "smsfMAPAddress": "46700000999",
    "smsfDiameterAddress": { "name": "smsf.krilju", "realm": "workshop" }
  },
  "mwdStatus": { "scAddressInMwd": false, "mnrf": false }
}
```

The SMSC finds the SMSF's address by NRF discovery with `target-nf-type=SMSF` and
`target-nf-instance-id=<smsfInstanceId>`.

Error answer (HTTP status + body):

```json
{ "status": 404, "result": "UNKNOWN_SUBSCRIBER", "diameterResultCode": 5001, "detail": "MSISDN not provisioned" }
```

| HTTP | `result` (MAP error, TS 29.002) | Diameter S6c equivalent | When |
| --- | --- | --- | --- |
| 404 | `UNKNOWN_SUBSCRIBER` | `DIAMETER_ERROR_USER_UNKNOWN` (5001) | MSISDN not provisioned |
| 404 | `ABSENT_SUBSCRIBER_SM` | `DIAMETER_ERROR_ABSENT_USER` (5550) | No SMSF registered (UE not reachable). The UDM adds `scAddress` to MWD and sets MNRF |
| 403 | `CALL_BARRED` | — | `mtSmsBarringAll` true |
| 403 | `TELESERVICE_NOT_PROVISIONED` | — | `smsSubscribed` or `mtSmsSubscribed` false |
| 400 | `UNEXPECTED_DATA_VALUE` | — | `msisdn` or `scAddress` missing |

### 3.2 Report-SM-Delivery-Status — `POST /sms-routing/v1/report-sm-delivery-status`

The SMSC reports an MT delivery outcome. On `ABSENT_SUBSCRIBER` the UDM stores the SC address in Message Waiting
Data, so it can alert the SMSC later. On `SUCCESSFUL_TRANSFER` the UDM clears MWD for that SC address.

```json
{ "msisdn": "46700000002", "scAddress": "46700000100", "deliveryOutcome": "ABSENT_SUBSCRIBER" }
```

`deliveryOutcome`: `ABSENT_SUBSCRIBER` | `SUCCESSFUL_TRANSFER` | `MEMORY_CAPACITY_EXCEEDED`.

`200 OK`: `{ "storedMsisdn": "46700000002", "mwdStatus": { "scAddressInMwd": true, "mnrf": true } }`.
Errors: `404 UNKNOWN_SUBSCRIBER`, `400 UNEXPECTED_DATA_VALUE`.

---

## 4. Alert-Service-Centre — UDM → SMSC (stretch goal)

When an SMSF registers for a UE with MWD (section 1.1), the UDM sends one alert per stored SC address, then clears
MWD. Agreed with holminator in #build:

- The UDM discovers the SMSC through the NRF with `target-nf-type=CUSTOM_SMSC` (service `nsmsc-sgd`).
- `POST {smsc apiPrefix}/smsc/alert-service-centre`
- holminator's SC address is `46700000100`.

```json
{ "msisdn": "46700000002", "scAddress": "46700000100", "alertReason": "UE_PRESENT" }
```

---

## 5. NRF registration (UDM → NRF)

At startup the UDM registers with `PUT {nrf}/nnrf-nfm/v1/nf-instances/{nfInstanceId}`. Heartbeat: `PATCH` with an
empty JSON Patch `[]` (`application/json-patch+json`) at 80% of the `heartBeatTimer` the NRF returns. A 404 on the
heartbeat triggers a new PUT. The NRF (smsf-hao) is found from the board, not hardcoded in other teams' code.

```json
{
  "nfInstanceId": "a1b2c3d4-0000-4000-8000-000068657465",
  "nfType": "UDM",
  "nfStatus": "REGISTERED",
  "fqdn": "smsf.torget.bjarby.com",
  "plmnList": [{ "mcc": "001", "mnc": "01" }],
  "udmInfo": {
    "supiRanges": [{ "start": "001010000000000", "end": "001019999999999" }],
    "gpsiRanges": [{ "start": "46700000000", "end": "46799999999" }]
  },
  "nfServices": [
    { "serviceInstanceId": "nudm-uecm-1", "serviceName": "nudm-uecm", "versions": [{ "apiVersionInUri": "v1", "apiFullVersion": "1.0.0" }],
      "scheme": "https", "nfServiceStatus": "REGISTERED", "apiPrefix": "/t/hetoteam", "apiRoot": "https://smsf.torget.bjarby.com/t/hetoteam" },
    { "serviceInstanceId": "nudm-sdm-1", "serviceName": "nudm-sdm", "versions": [{ "apiVersionInUri": "v2", "apiFullVersion": "2.0.0" }],
      "scheme": "https", "nfServiceStatus": "REGISTERED", "apiPrefix": "/t/hetoteam", "apiRoot": "https://smsf.torget.bjarby.com/t/hetoteam" },
    { "serviceInstanceId": "sms-routing-1", "serviceName": "sms-routing", "versions": [{ "apiVersionInUri": "v1", "apiFullVersion": "1.0.0" }],
      "scheme": "https", "nfServiceStatus": "REGISTERED", "apiPrefix": "/t/hetoteam", "apiRoot": "https://smsf.torget.bjarby.com/t/hetoteam" }
  ]
}
```

`sms-routing` is a workshop-only service name for section 3 (not in TS 29.510). As agreed with smsf-hao in #build:
`fqdn` + path-style `apiPrefix` per TS 29.510, plus the explicit `apiRoot` on every service. Consumers should use
`nfServices[0].apiRoot`.

When the UDM discovers others (CUSTOM_SMSC) it takes `apiRoot`, then an absolute `apiPrefix`, then
`scheme://fqdn[:port]apiPrefix`.

---

## 6. Test and observability endpoints

| Method and path | What |
| --- | --- |
| `GET /t/hetoteam/status` | NF instance id, NRF registration state, counts |
| `GET /t/hetoteam/metrics` | KPIs since plugin start (see below). `?format=prometheus` gives the Prometheus text format |
| `GET /t/hetoteam/subscribers` | All provisioned subscribers and their SMS data |
| `GET /t/hetoteam/registrations` | Current SMSF registrations and MWD lists |
| `GET /t/hetoteam/log?since=<n>` | Incoming and outgoing messages, newest last: `{ id, ts, dir, peer, method, path, status, ms, request, response }` |
| `POST /t/hetoteam/admin/reset` | Clear registrations and MWD (subscribers stay) |

`/metrics` returns `{ uptimeSec, since, kpi, ops, causes }`:
- `kpi`:
  - Subscribers and NRF: `provisionedSubscribers`, `activeRegistrations`, `mwdPending`, `nrfRegistered`,
    `nrfHeartbeatAgeSec`.
  - Traffic: `requestsIn`, `requestsOut`, `errorRateInPct`, `avgLatencyInMs`, `messagesLastMinute`.
  - Success rates: `uecmRegisterSuccessPct`, `sdmSuccessPct`, `sriForSmSuccessPct`.
  - SMS routing and alerts: `sriAbsentSubscriber`, `alertsSent`, `alertsOk`.
- `ops`: per operation, `{ dir, total, ok, fail, successPct, avgMs, maxMs, lastStatus, lastTs, results }`.
  - Incoming: `uecm_register`, `uecm_get`, `uecm_deregister`, `sdm_get`, `sri_for_sm`, `report_sm_delivery_status`.
  - Outgoing: `nrf_register`, `nrf_heartbeat`, `nrf_discovery`, `alert_service_centre`.
- `causes`: counts of `ProblemDetails.cause` or MAP `result` on every non-2xx answer.

Tile with KPIs, operations, registrations, MWD and the latest log entries (expand a row to see request and response):
`https://smsf.torget.bjarby.com/colony/hetoteam/`.

Implementation: `board/plugins/hetoteam/index.js`. Local test with a fake NRF and SMSC, from the repo root:
`node projects/hetoteam/test/udm.test.js`.
