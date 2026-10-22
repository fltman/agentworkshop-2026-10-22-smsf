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

The answer means the SMSC accepted the SMS (TS 29.338 OFA). The MO terminates at the SMSC: we store it with
`direction: "MO"` and mark it `FORWARDED` (history detail `simulated onward delivery to <TP-DA>`). There is no
SRI-for-SM and no MT-Forward for an MO. If TP-SRR is set, the originator gets an SMS-STATUS-REPORT (TP-ST 0x00) as a
new MT record (`kind: "STATUS_REPORT"`) over the real MT path (section 2). `sms.hex` may be the bare SMS-SUBMIT
(agreed) or the whole RP-DATA MS->N; in the latter case RP-DA must be our SC address. `deliveryReport.hex` is the
SMS-SUBMIT-REPORT for RP-ACK (TS 23.040 9.2.2.2a).

| HTTP | `result` | `diameterResultCode` | When |
| --- | --- | --- | --- |
| 400 | `MISSING_AVP` | 5005 | no `sms.hex`, or neither `supi` nor `msisdn` |
| 400 | `UNEXPECTED_DATA_VALUE` | 5004 | body not JSON, or `sms.hex` is not a decodable SMS-SUBMIT / RP-DATA |
| 403 | `SM_DELIVERY_FAILURE` | 5555 | see causes below |
| 403 | `FACILITY_NOT_SUPPORTED` | 5552 | only via `?scenario=` today |
| 500 | `UNABLE_TO_COMPLY` | 5012 | internal error |

A 5555 answer carries `smDeliveryFailureCause: { smEnumeratedDeliveryFailureCause, value }` (TS 29.338 / MAP values)
and, when the SC has a TP-FCS for the UE, `deliveryReport.hex` (also in `smDiagnosticInfo`): an SMS-SUBMIT-REPORT
for RP-ERROR that the SMSF should put in the RP-ERROR to the UE (TS 23.040 3.4.2).

| Cause (value) | TP-FCS | When |
| --- | --- | --- |
| `UNKNOWN_SERVICE_CENTRE` (3) | none | `scAddress` or RP-DA is not 46700000100 |
| `INVALID_SME_ADDRESS` (5) | C3 | TP-DA empty or longer than 15 digits |
| `EQUIPMENT_PROTOCOL_ERROR` (1) | C5 | TP-RD=1 and an SM with the same TP-MR, TP-DA and originator is still held (TS 23.040 9.2.3.25; an MO counts as held while `ACCEPTED`/`PENDING`/`DELIVERING`/`WAITING`, or for 60 s (`DUP_WINDOW_MS`, env `HOLMINATOR_DUP_WINDOW_MS`; covers RP TR1M retransmissions) after it went `FORWARDED`, because UEs wrap TP-MR at 256). TP-RD=0 duplicates inside that window are accepted with `duplicateOf` set and counted in `mo_duplicates_accepted`; after the window the same TP-MR is a new SM. |

## 2. MT SMS - SMSC origination

An MT record (`direction: "MT"`) comes from exactly two sources: `POST /api/mt` (the generator, `kind: "SMS"`) and a
status report for an MO with TP-SRR (`kind: "STATUS_REPORT"`, `reportFor` = the MO id). An MO is never relayed as MT.

`POST /api/mt` asks for a status report by default: `srr` defaults to `true` and sets TP-SRI in the SMS-DELIVER;
send `srr: false` for TP-SRI=0 and no report. A status report MT never requests a status report. The originator of a generator MT is an external SME we
simulate, so its status report is recorded, not sent: on the final outcome (DELIVERED, FAILED, EXPIRED) the MT record
gets `statusReport: { tpSt: "0x00", at }` (TP-ST as a hex string) and the history line
`status report to originating SME (simulated), TP-ST 0x..`, counted in `statusReportsMt`.

1. `POST {udm}/sms-routing/v1/send-routing-info-for-sm` with `{ msisdn, scAddress, smRpPri: false, smRpMti }`
   (`smRpMti` 1 for a status report, else 0). 200 gives `servingNode.smsfInstanceId`.
2. Discover that SMSF with `target-nf-type=SMSF&target-nf-instance-id=<smsfInstanceId>`. No fallback to another
   SMSF: if the instance is not in the NRF, we retry later.
3. `POST {smsf}/smsc/mt-forward-short-message` (krilju's contract) with the bare SMS-DELIVER or SMS-STATUS-REPORT
   TPDU. The SMSF wraps it in RP-DATA for the UE.

```json
{ "supi": "imsi-001010000000002", "msisdn": "46700000002", "scAddress": "46700000100",
  "smsRecordId": "smsc-17-1", "moreMessagesToSend": false, "sms": { "hex": "040B916407000000F2..." } }
```

4. `POST {udm}/sms-routing/v1/report-sm-delivery-status` with `{ msisdn, scAddress, deliveryOutcome }`:
   `ABSENT_SUBSCRIBER` (the UDM sets MWD), `MEMORY_CAPACITY_EXCEEDED`, or `SUCCESSFUL_TRANSFER` after a stored SM.

How we read the SMSF's answer: SGd carries the bare TPDU (SM-RP-UI), so `deliveryReport.hex` is normally a bare
SMS-DELIVER-REPORT (e.g. `0000`) and the RP-Cause of an RP-ERROR comes in `rpCause` (integer) in the body. 200 means
RP-ACK, 502 with a `rpCause` or a `deliveryReport` means RP-ERROR. A `deliveryReport.hex` that starts with an RP header
(RP-ACK/RP-ERROR, MTI 2-5) is accepted too; then the cause is read from it if `rpCause` is missing.

| Outcome | Our action | Status |
| --- | --- | --- |
| SMSF 200 | delivered | `DELIVERED` |
| SRI 404 `ABSENT_SUBSCRIBER_SM`, SMSF 504 `ABSENT_SUBSCRIBER` or 404 | report `ABSENT_SUBSCRIBER`, wait for the alert (fallback retry 10 min) | `WAITING` |
| SMSF RP-ERROR cause 22 | report `MEMORY_CAPACITY_EXCEEDED`, wait for the alert | `WAITING` |
| SMSF 502 RP-ERROR temporary cause 41, 42, 47 or 111 (TS 24.011 8.2.5.4) | retry with backoff 30 s x 2^n, max 10 min | `WAITING` |
| SRI 404 `UNKNOWN_SUBSCRIBER`, 403 `CALL_BARRED` / `TELESERVICE_NOT_PROVISIONED`, any other RP-ERROR cause (e.g. 21, 95-99) | stop, reason in `failure` | `FAILED` |
| UDM/SMSF 5xx (incl. 502 without `rpCause` and without a deliveryReport), timeout, SMSF not in NRF | retry with backoff 30 s x 2^n, max 10 min | `WAITING` |
| backoff retries reach 8 attempts in total | stop, reason in `failure` | `FAILED` |
| validity period passed (`validitySeconds` on `/api/mt`, default 24 h) | stop, never sent | `EXPIRED` |

An MT never carries TP-SRR (it comes from `/api/mt` or is itself a status report), so MT outcomes produce no status
report. The attempt cap applies to backoff retries only; an SM waiting for the alert (absent subscriber, memory full) is kept
until its validity period ends. After a restart, stored MT records in `ACCEPTED` or `PENDING` are sent again (expired
ones end `EXPIRED`), `WAITING` ones keep their fallback retry time, and an MO left `ACCEPTED` becomes `FORWARDED`
(with its status report if TP-SRR was set; an MO whose validity has passed ends `EXPIRED` with TP-ST 0x46 if SRR).

Rules: one MT in flight per recipient (TS 23.040 3.1), queued SMs set TP-MMS (`moreMessagesToSend`), and every
SM to the same MS gets a unique TP-SCTS.

Message status: MO `ACCEPTED` → `FORWARDED` (or `EXPIRED` on restart after the validity period). MT `PENDING` →
`DELIVERING` → `DELIVERED` / `WAITING` / `FAILED` / `EXPIRED`.

## 3. Alert-Service-Centre - UDM to SMSC (S6c ALR/ALA, MAP Alert-SC)

`POST /smsc/alert-service-centre`

```json
{ "msisdn": "46700000002", "scAddress": "46700000100", "alertReason": "UE_PRESENT" }
```

`200 OK` `{ "result": "SUCCESS", "diameterResultCode": 2001, "redelivering": ["smsc-17"] }`, then every `WAITING`
SM for that MSISDN is retried in order. The 200 comes at once but redelivery starts after a grace delay of about 2 s
(the UDM may alert while the SMSF's UECM registration is still storing the UE context), and if that alert-triggered
attempt gets SMSF 404 `UNKNOWN_SUBSCRIBER` or 504 `ABSENT_SUBSCRIBER` we make exactly one fast retry about 5 s later
before reporting `ABSENT_SUBSCRIBER` and waiting for the next alert. `400 MISSING_AVP` (5005) without `msisdn`, `400 UNEXPECTED_DATA_VALUE`
(5004) for another SC address or a body that is not JSON.

## 4. Triggers and observability

| Method and path | What |
| --- | --- |
| `POST /api/mt` `{ "from": "46700000009", "to": "46700000002", "text": "Hi", "srr": true }` | Originate an MT SMS (`from` defaults to the SC address, text at most 160 characters; optional `validitySeconds`, `singleShot: true` for one attempt only, and `srr` (default `true`: TP-SRI and a simulated status report to the SME; `false` for neither)). `202` `{ messageId, track }`; `?wait=1` answers `200` with the final status and history; `?dryRun=1` shows the TPDU without sending |
| `GET /api/messages` | The message store, oldest first (no parameters: everything we hold, at most 500). `?limit=<n>` keeps the newest n. `?since=smsc-<n>` (or just `<n>`) keeps messages created after that id; `?since=<ISO time>` keeps messages whose `updatedAt` (the `ts` of their last history entry) is later. Both combine: filter first, then limit. A bad value is `400 { error }` |
| `GET /api/messages/<id>` | One message with its history |
| `GET /log?limit=<n>` | Shared call-flow log, newest first: `{ id, ts, dir, peer, method, path, status, body, ms? }`. Answers we give have `method: null` and the operation name as `path` |
| `GET /api/log?since=<n>` | Incoming and outgoing messages: `{ id, ts, dir, peer, what, status, body, ms? }` |
| `GET /api/metrics` | Counters, PDUs, RP-Causes, status reports, SGd operations and self-checks; schema below. Persisted in `store.json` with the messages, so they survive a deploy; `since` is when they started counting, `startedAt` is this process |
| `POST /api/metrics/reset` `{ "clearMessages": false }` | Every metric back to its pre-seeded 0 (counters, results, peers, pdus, rpCauses, both byTpSt, SGd operations), `since` = now, saved to `store.json` and logged in `/api/log`. `startedAt` and NRF health stay. `clearMessages: true` also drops every stored message and cancels pending redelivery timers (a clean slate; otherwise records from before `since` are left out of the consistency checks). Body optional. Answers `{ ok: true, since, clearedMessages }` |
| `GET /metrics` | The same in Prometheus text format (`smsc_*`): `smsc_<counter>_total`, `smsc_pdus_total{dir,type}`, `smsc_rp_causes_total{dir,cause}`, `smsc_status_reports_total{outcome}`, `smsc_status_reports_waiting`, `smsc_status_reports_by_tp_st_total{tp_st}`, `smsc_status_reports_mt_requested_total`, `smsc_status_reports_mt_simulated_total`, `smsc_status_reports_mt_by_tp_st_total{tp_st}`, `smsc_sgd_operations_total{dir,operation}`, `smsc_consistency_ok{check}` |
| `GET /kpi` | Common KPI summary (tompa, #build 142): `{ nf: "SMSC", up: true, requests, errors, latencyMs, extra: { mo_accepted, mt_delivered, mt_failed, waiting, status_reports_sent, alerts_received, registeredInNrf, pdus_in, pdus_out, consistent, mo_srr_requested, mt_status_reports_simulated } }`. `requests`: inbound peer requests we answered; `errors`: our answers with status >= 400 plus outbound peer errors (no answer or 5xx); `latencyMs`: average outbound peer latency (0 before the first call); `waiting`: messages in WAITING now; `pdus_in`/`pdus_out`: totals of `pdus.in`/`pdus.out`; `consistent`: every consistency check is ok. Counters persist across restarts |
| `GET /status` | `{ nfInstanceId, registeredInNrf, messages }` |

### `GET /api/metrics` schema

Every key below exists from the start with value 0 (no key appears only after its first use).

```
{ nf, team, nfInstanceId, scAddress, startedAt, uptimeS, since, nrf: {...},
  counters: { <name>: n },              // all pre-seeded, see list
  results: { <operation>: { <result>: n } },
  peers: { <peer>: { in, out, errors, calls, latencyMsSum, latencyMsMax, latencyMsAvg } },
  messages: { total, byStatus, byDirection },
  pdus: {
    in:  { "RP-DATA/SMS-SUBMIT", "RP-ACK/SMS-DELIVER-REPORT", "RP-ACK/STATUS-REPORT-ACK",
           "RP-ERROR/SMS-DELIVER-REPORT", "none/no-report" },
    out: { "RP-ACK/SMS-SUBMIT-REPORT", "RP-ERROR/SMS-SUBMIT-REPORT", "RP-DATA/SMS-DELIVER", "RP-DATA/SMS-STATUS-REPORT" } },
  rpCauses: { in: { "22 MEMORY_CAPACITY_EXCEEDED": n, ... }, out: { ... } },   // every TS 24.011 8.2.5.4 cause
  statusReports: { requested, generated, sent, delivered, failed, expired, waiting, byTpSt: { "0x00": n, ... } },
  statusReportsMt: { requested, simulated, byTpSt: { "0x00": n, ... } },   // same pre-seeded TP-ST keys
  sgd: { results,                      // same object as top-level results
         operationsOut: { "SRI-for-SM", "MT-Forward-SM", "Report-SM-Delivery-Status", "NFDiscover", "NFRegister", "NFUpdate" },
         operationsIn:  { "MO-Forward-SM", "Alert-SC" } },
  consistency: [ { name, ok, detail } ] }
```

- `pdus.in["RP-DATA/SMS-SUBMIT"]`: every MO request. `pdus.out` SUBMIT-REPORT: one RP-ACK per accepted MO (dry runs
  too) or one RP-ERROR per rejected MO (with or without a TP-FCS).
- `pdus.out["RP-DATA/SMS-DELIVER"]` and `["RP-DATA/SMS-STATUS-REPORT"]`: one per MT-Forward sent. Its answer counts in
  `pdus.in` by the RP message in `deliveryReport`: RP-ACK (`SMS-DELIVER-REPORT` for an SMS, `STATUS-REPORT-ACK` for a
  status report), RP-ERROR (any cause), or `none/no-report` when there is no deliveryReport (or no answer).
- `rpCauses.in`: the cause in a UE RP-ERROR. `rpCauses.out`: the RP-Cause the SMSF should give the UE for our MO
  rejection, per TS 23.040 11.3: 5555 `UNKNOWN_SERVICE_CENTRE` gives 1, `SC_CONGESTION` 42, `INVALID_SME_ADDRESS` 21,
  `USER_NOT_SC_USER` 28, `EQUIPMENT_PROTOCOL_ERROR` 21 (no row in 11.3); 5552 facility not supported gives 69; 5004 and
  5005 (unexpected data value) and 5012 (system failure) give 38.
- `statusReports` (MO side, real SMS-STATUS-REPORT MTs to the UE):
  - `requested`: accepted MOs with TP-SRR=1 (`mo_srr_requested`), also those that get no report (no originating MSISDN).
  - `generated`: records made for TP-SRR.
  - `sent`: MT-Forward attempts that carry one.
  - `delivered`: acknowledged by the UE, the same as the counter `status_reports_sent`.
  - `failed`, `expired`.
  - `waiting`: currently PENDING, DELIVERING or WAITING.
  - `byTpSt`: generated per TP-ST.
- `statusReportsMt` (generator MTs with `srr`, the default, simulated towards the originating SME): `requested`
  (`mt_srr_requested`), `simulated` (`mt_status_reports_simulated`), `byTpSt` per simulated TP-ST.
- Counters:
  - General: `requests_in`, `answers_error`, `test_requests`, `store_evicted`.
  - MO: `mo_received`, `mo_accepted`, `mo_rejected`, `mo_dry_runs`, `mo_duplicates_accepted`, `mo_forwarded`, `mo_expired`.
  - MT: `mt_originated`, `mt_attempts`, `mt_forward_not_sent` (an attempt that ended before the MT-Forward: no UDM,
    SRI failure, SMSF not found), `mt_delivered`, `mt_failed`, `mt_expired`, `mt_absent`, `mt_retries_scheduled`,
    `mt_rp_error_temporary`, `mt_attempts_exhausted`, `mt_alert_fast_retries`.
  - UDM and alerts: `sri_requests`, `udm_delivery_reports`, `alerts_received`, `alerts_redelivering`.
  - Status reports: `status_reports_generated`, `status_reports_sent`, `status_reports_failed`, `status_reports_expired`,
    `mo_srr_requested`, `mt_srr_requested`, `mt_status_reports_simulated`.
  - NRF: `nrf_register_attempts`, `nrf_registrations`, `nrf_heartbeats_ok`, `nrf_heartbeats_failed`,
    `nrf_discoveries`, `nrf_discoveries_empty`, `nrf_discovery_cache_hits`.
- `consistency`. Attempts still in flight are added on the right-hand side, so the checks also hold mid-attempt.

  | name | check |
  | --- | --- |
  | `mo_pdus` | in `RP-DATA/SMS-SUBMIT` == out `RP-ACK/SMS-SUBMIT-REPORT` + out `RP-ERROR/SMS-SUBMIT-REPORT` |
  | `mt_attempts_forwarded` | `mt_attempts` == out `RP-DATA/SMS-DELIVER` + out `RP-DATA/SMS-STATUS-REPORT` + `mt_forward_not_sent` |
  | `mt_attempts_answered` | `mt_attempts` == in RP-ACK (both) + in RP-ERROR + in `none/no-report` + `mt_forward_not_sent` |
  | `status_reports` | `generated` == `delivered` + `failed` + `expired` + `waiting` (only reports generated since `since`) |
  | `mo_status_reports` | `mo_srr_requested` == `status_reports_generated` + MOs with TP-SRR stored since `since` that have no `statusReportId` (no originating MSISDN, or not forwarded yet). Skipped (ok) if `store_evicted` > 0 |
  | `mt_status_reports` | `mt_srr_requested` == `mt_status_reports_simulated` + generator MTs with `srr` stored since `since` that are not final yet. Skipped (ok) if `store_evicted` > 0 |
  | `mo_store` | `mo_received` == MO records stored since `since` + `mo_rejected` + `mo_dry_runs`. If `store_evicted` > 0 this check is skipped and reported as ok, with the reason in `detail` |

Tile: `https://smsf.torget.bjarby.com/colony/holminator/`: metrics, message store with history, live log and a
test console.

## 4a. Testing against us

Every endpoint is open. `GET /test` lists them with ready-made bodies (the MO examples in it are checked by our tests).

| What | How |
| --- | --- |
| Validate without side effects | `?dryRun=1` on MO: full validation, answer includes `decoded`, nothing stored or delivered |
| Force an outcome | `?scenario=<NAME>` on MO: `SUCCESS`, `UNKNOWN_SERVICE_CENTRE`, `INVALID_SME_ADDRESS`, `DUPLICATE`, `SC_CONGESTION`, `USER_NOT_SC_USER`, `DESTINATION_BARRED`, `SYSTEM_FAILURE`, `FACILITY_NOT_SUPPORTED`, `SERVER_ERROR`, `SLOW` (10 s), `NO_ANSWER` (30 s) |
| Build a TPDU | `POST /test/encode` `{ type: SUBMIT\|DELIVER, to\|from, text, mr, srr, rd, rp }` returns `tpduHex` (and `rpDataHex` with `rp: true`) |
| Read a TPDU | `POST /test/decode` `{ hex }` decodes RP-DATA, SMS-SUBMIT or SMS-DELIVER (counted in `test_requests`, except calls with header `x-holminator-tile: 1`, which our own tile sends) |

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
