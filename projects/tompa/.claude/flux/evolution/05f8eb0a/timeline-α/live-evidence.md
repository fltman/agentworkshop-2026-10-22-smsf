# α live evidence (2026-10-22 10:49 CEST, GET only)

## What the live system showed
Every peer restarted at 08:40:11Z (the deploy of PRs #12 krilju, #13 smsf-hao and #14 tompa), so the earlier fault traffic is gone from all logs.

| Source | Entries | Content |
|---|---|---|
| /t/tompa/log | 40 | NRF register at 08:40:11 plus heartbeats. Two `POST /ue/imsi-…01/sms` triggers at 08:42 with no outbound call, because the UE was not registered on the live AMF. **No entry has a `diag`.** |
| /t/tompa/faults | 0 | `[]` |
| /t/krilju/log | 20 | 08:41:50: Activate UE1 → UDM 200/200/200 → **201**. Activate UE3 → sms-data `smsSubscribed:false` → UECM DELETE → **403**. That AMF used our nfInstanceId, but none of it is in /t/tompa/log, so it was not the live AMF (most likely a local run). |
| /t/hetoteam/log | 25 | Mirrors krilju's 08:41:50 UDM calls (5–10). Otherwise NRF heartbeats. |
| /t/smsf-hao/log | 60 | Heartbeats only. All 4 NFs plus the AMF are registered. |
| /t/holminator/status, /metrics | – | CUSTOM_SMSC, registered, `messages 0`, no MO received since the restart. |

The live corpus therefore has **0 judged entries**. The precision/recall below comes from replaying (`timeline-α/live/replay.js`, removed after the run). The replay is:
- the boundary messages the live peers produced, with bodies reconstructed from the peers' current code (krilju `index.js` and `rp.js`, holminator `index.js`, both read-only);
- the four known faults, taken from earlier runs (checkpoint 002).

## Checked entries

| ts / source | op | α gen-001 verdict / owner | True root cause / owner | gen-001 correct? | gen-002 |
|---|---|---|---|---|---|
| 08:41:50 krilju #12 | activate UE1 201 | ok | ok | ✔ | ✔ |
| 08:41:50 krilju #20 | activate UE3 403 SMS_NOT_ALLOWED | expected | expected (test data) | ✔ | ✔ |
| replay (krilju l.149) | activate 9999 404 USER_UNKNOWN | expected | expected | ✔ | ✔ |
| replay (krilju l.201) | sendsms UE5 403 MO_SMS_BARRED | expected | expected | ✔ | ✔ |
| earlier live e2e, fault 4 | sendsms UE1 502 `{cause FAILURE, detail "SMSC answered 501"}` | fault SMSF→SMSC holminator | holminator, MO not implemented | ✔ (from the 502's `detail`) | ✔ |
| earlier local run, fault 1 | N1N2 with a bare SMS-DELIVER | fault SMSF→AMF krilju | krilju | ✔ | ✔ |
| after #12 (krilju rpDataToUe) | N1N2 with RP-DATA MTI 1 | ok | ok | ✔ | ✔ |
| fault 2 with MO live at the SMSC | sendsms 502 `{UNEXPECTED_DATA_VALUE, "SMSC answered 400"}` | fault SMSF→SMSC **holminator** | krilju (malformed request to the SMSC) | ✘ owner | ✔ |
| fault 3 (wrong NF type) | sendsms 503 `{NF_DISCOVERY_FAILED, "no SMSC found in NRF"}` | fault SMSF→SMSC **holminator** | krilju, SMSF→NRF query | ✘ hop+owner | ✔ |
| synthetic, krilju contract l.38 | sendsms 200 + RP-ACK MTI 3, same RP-MR | ok | ok | ✔ | ✔ |
| synthetic | sendsms 200 + RP-ACK with the wrong RP-MR | ok | krilju | ✘ FN | ✔ |
| synthetic (MO twin of fault 1) | sendsms 200 + bare SUBMIT-REPORT TPDU | ok | krilju | ✘ FN | ✔ |
| replay (krilju l.150) | activate 502 `{UDM_REGISTRATION_FAILED, "UDM answered 400"}` | fault **hetoteam** | krilju (malformed UECM PUT) | ✘ owner | ✔ |
| replay (krilju l.155) | activate 502 `{UDM_UNAVAILABLE, "UDM answered 500"}` | fault hetoteam | hetoteam | ✔ | ✔ |
| holminator ?scenario=SC_CONGESTION | sendsms 502 `{SC_CONGESTION, "SMSC answered 403"}` | fault holminator | expected (forced by the test) | ✘ FP | ✔ (needs `opts.expectCause`) |

## Numbers (15 cases: 8 real faults, 7 non-faults)

| | TP | FP | FN | TN | mis-attributed (of TP) | precision | recall | hop/owner accuracy |
|---|---|---|---|---|---|---|---|---|
| gen-001 | 6 | 1 | 2 | 6 | 3 | 0.86 | 0.75 | 0.50 |
| gen-002 | 8 | 0 | 0 | 7 | 0 | 1.00 | 1.00 | 1.00 |

Caveat: the four gen-002 fixes were written against this same corpus, so gen-002's score is in-sample. On the live system only, the score is "no false positives, no data", because no judged entry exists after the restart.

## Answers to the specific questions
- **Who gets the 502 on sendsms?** holminator (SMSF→SMSC), in both gen-001 and gen-002. α can tell from the 502 body alone: krilju sends `detail: "SMSC answered <status>"` and `cause = SMSC result` (krilju index.js l.219–221), and blame() matches the detail. krilju is not wrongly blamed. The weak spot is the reverse: when the SMSC answers 400 because krilju's request was malformed, gen-001 blamed holminator.
- **Can α detect fault 2 (MO RP layering)?** Not directly: the SMSF→SMSC payload never crosses our boundary. While the SMSC answered 501, fault 2 was **masked** by fault 4 and indistinguishable (FN by construction). Now that holminator decodes SM-RP-UI and answers 400 `UNEXPECTED_DATA_VALUE` for an undecodable TPDU, gen-002 attributes that 400 to krilju. The other half of the MO layering, the RP-ACK/RP-ERROR back to the UE, does cross our boundary, and gen-002 checks it (MTI 3/5 plus RP-MR).
- **Fault 3 (SMSC vs CUSTOM_SMSC)**: krilju's discovery is not visible to us. α sees it only as an SMSF 503 `NF_DISCOVERY_FAILED`, which gen-002 now puts on SMSF→NRF / krilju. This attribution is wrong if the SMSC really is not registered; checking the NRF directly is γ's job.

## Remaining gaps
1. index.js does not yet pass `opts` (`sentHex`, `expectCause`), so the MO RP check and the forced-scenario handling are inactive live.
2. `diag.also` (an RP fault reported next to an SMSC fault) is not counted in `/faults`.
3. A 403 MO_SMS_BARRED for a non-barred UE is blamed on krilju (AMF→SMSF). It could also be wrong UDM sms-mng-data (hetoteam). α cannot tell from the boundary.
4. There is no self-check of our own uplink RP-DATA. A 400 from the SMSC caused by a bad tompa encoding would be blamed on krilju.
5. Live evidence is thin: a fresh live e2e run is needed, and only after approval, since it POSTs.
