# holminator: SMSC plan

Status: approved by the human 10:07. Implementation starts with steps 0 and 1.

## What we build

The SMSC of 5G Core Light. It receives MO SMS from the SMSF, originates MT SMS (routing lookup in UDM, then delivery
via the serving SMSF), handles delivery reports, stores undeliverable SMS and redelivers on alert (stretch).
The interface is HTTP/JSON modelled on Diameter SGd (TS 29.338), with S6c-style routing info from UDM.

- Runs as a board plugin: `board/plugins/holminator/index.js`, served at `/t/holminator/`. Plain Node, no deps.
- Tile: `board/public/colony/holminator/` with message store, message log and a "send MT SMS" form.
- State in `ctx.dataDir` (JSON file), so the store survives restarts.

## Decisions

- **Transport:** plain HTTP/JSON. No Diameter or MAP framing is emulated. Message names, parameters and result
  codes come from TS 29.338 (SGd/S6c) and TS 29.002 (MAP), as the other teams already do.
- **Payload:** `sms.hex` carries the bare TS 23.040 TPDU, as SGd SM-RP-UI does: SMS-SUBMIT on MO, SMS-DELIVER on
  MT, SUBMIT-REPORT / DELIVER-REPORT as `deliveryReport`. The RP layer (TS 24.011) stays between UE and SMSF.
  An optional `sms.text` holds the decoded text for logs. The SMSC is the only NF that has to decode the TPDU.
- **NRF:** `nfType: CUSTOM_SMSC`, service `nsmsc-sgd`, `apiPrefix` = our base URL. We find UDM and SMSF via
  `nfServices[0].apiPrefix` (krilju's convention).
- **SC address:** 46700000100.
- **Test subscribers:** hetoteam's list (imsi-00101000000000{1..5}, msisdn-4670000000{1..5}, 3 SMS not allowed,
  4 MT barred, 5 MO barred, imsi-001019999999999 unknown).

Proposed in #build [33], waiting for confirmation from krilju (TPDU only), hetoteam (alert path) and smsf-hao (nfType).

## Who we talk to (contracts read from PRs 1-3)

| Team | NF | We call | They call on us |
|---|---|---|---|
| krilju | SMSF | POST /smsc/mt-forward-short-message | POST /smsc/mo-forward-short-message |
| hetoteam | UDM | POST /sms-routing/v1/send-routing-info-for-sm, /report-sm-delivery-status | POST /smsc/alert-service-centre (stretch) |
| smsf-hao | NRF | nnrf-nfm register/heartbeat, nnrf-disc for SMSF and UDM | - |
| tompa | AMF+UE | - | - (indirect, end to end) |

## Our endpoints (draft for CONTRACT.md)

Base `/t/holminator`.

| Method, path | SGd/MAP model | Caller |
|---|---|---|
| POST /smsc/mo-forward-short-message | OFR/OFA, MAP MO-Forward-SM | SMSF |
| POST /smsc/alert-service-centre | ALR/ALA (S6c), MAP Alert-SC | UDM |
| POST /api/mt | trigger: originate MT SMS | humans, demo script, other teams |
| GET /api/messages, GET /api/log | message store and message log | humans, tile |

Results use the group's names: SUCCESS, UNKNOWN_SUBSCRIBER (5001), ABSENT_SUBSCRIBER (5550), SMS_NOT_ALLOWED,
CALL_BARRED, FAILURE (5555). The Diameter code goes in `diameterResultCode` where it exists, as hetoteam does.

## Flows

1. **MO:** SMSF sends MO forward with the SMS-SUBMIT. We store it and answer 2001. If the recipient is one of
   our test subscribers, we originate it as MT to them (UE to UE).
2. **MT:** trigger or MO, then SRI-for-SM to UDM (found via NRF), then MT forward to the SMSF it returned. We get the
   delivery result back in the answer, set the message status, and send a status report to the originator if it asked for one.
3. **Errors:** UDM unknown subscriber gives 5001; SMS not allowed gives 5556/5557; UE not reachable from SMSF gives 5550.
   All are visible in the log and the tile.
4. **Stretch:** on 5550 we keep the message, tell UDM (Report-SM-Delivery-Status, message waiting), and redeliver
   when UDM sends Alert-Service-Centre after the UE registers again.

## Open questions

1. krilju: TPDU only in `sms.hex`, RP layer stays with the SMSF?
2. smsf-hao: is CUSTOM_SMSC accepted as nfType?
3. hetoteam: alert path confirmed?
4. tompa and hetoteam's test subscriber lists differ slightly (unknown = ...099 vs ...9999999999). We follow UDM's.

## Steps

| # | Step | Capability | Done when |
|---|---|---|---|
| 0 | CONTRACT.md written, summary in #build, open questions asked | smsc-interop-contract | posted |
| 1 | Plugin skeleton: routes, log, store, NRF register and heartbeat, first PR | smsc-sgd-service | live in colony, visible in NRF |
| 2 | MO forward endpoint | smsc-sgd-service, sms-tpdu-codec | krilju's SMSF gets 2001 from us |
| 3 | MT: trigger, SRI to UDM, MT forward to SMSF | smsc-sgd-service | an MT SMS reaches tompa's UE |
| 4 | Error cases, mapped result codes | smsc-sgd-service | unknown, not allowed, absent all shown |
| 5 | Tile (store, log, send form; textContent only) | smsc-sgd-service | usable in demo |
| 6 | Stretch: store-and-forward plus alert | smsc-sgd-service | redelivery after re-register |
| 7 | Demo script end to end | smsc-interop-contract | runs registration, MO, MT across all NFs |

PR after every step. Tests: a local `node` test for our plugin under `projects/holminator/test/`, plus an interop script
that calls the other teams' real deployed modules. Faults go to the owning team in #build.
