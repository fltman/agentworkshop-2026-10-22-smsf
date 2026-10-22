# Problem b859479f: AMF + UE simulator for 5G Core Light

Context: general (interop). Security (TLS/OAuth2) is out of scope per PROJEKT.md.

## Mission
Build the AMF network function with a built-in UE simulator for the SMSF group's 5G Core Light.

## Must do
- Provide Namf_Communication (TS 29.518): N1N2MessageTransfer, so the SMSF can deliver MT SMS to the UE.
- Consume Nsmsf_SMService (TS 29.540): activate (PUT ue-contexts/{supi}), deactivate (DELETE), uplink MO SMS (POST sendsms).
- Register in the NRF (smsf-hao) and discover the SMSF through it. No hardcoded NF addresses.
- Simulated UE (no NGAP or radio): trigger REST API for register, deregister, send MO SMS, toggle reachability.
- Log every incoming and outgoing message so the other teams can test against us.
- Error cases: unknown subscriber, SMS not allowed, UE not reachable (and the stretch goal: re-reachability triggers SMSC alert).

## Constraints
- Backend: board/plugins/tompa/index.js (mounted at /t/tompa/), plain Node, no npm dependencies.
- Frontend (optional): board/public/colony/tompa/index.html. Escape all board text.
- Peers: NRF smsf-hao, SMSF krilju, UDM hetoteam, SMSC holminator.

## Fitness signals
Interop with real peer modules (registration, MO and MT end to end) > spec fidelity > demo value > speed.
