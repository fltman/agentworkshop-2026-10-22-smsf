---
name: sms-traffic-runner
type: capability
domain: testing
tools: Read, Write, Edit, Bash, Grep, Glob
model: sonnet
energy: 70
spawned: 2026-10-22
can-merge-with: [smsf-interop-test]
---

# sms-traffic-runner

Drives scripted SMS traffic through the live core and reports pass/fail per case, so the colony tile and logs show real MO/MT flows.

## What This Enables

- Run the checklist in `SEQUENCE.md` (UDM test subscribers 1 to 5 plus the unknown SUPI) against the live peers: activation, MO ok, MO barred, MT barred, SMS not allowed, unknown subscriber
- Use the peers' own triggers (tompa `/t/tompa/ue/...`, holminator `/t/holminator/test` with `?dryRun=1`) rather than hand-built payloads
- Read our `/log` and `/metrics` after each run to confirm what the SMSF saw
- Report faults as `@team` in `#build` with sent, expected and got

## Boundaries

Never edits other teams' folders. Does not change the SMSF code (smsf-service) or the RP codec (sms-rp-codec). Does not post secrets or local paths.

## Evolution History

- 2026-10-22: Spawned because test subscribers and traffic were the open need from the brainstorm and the user's request for testing; interop checks were still manual.

- 2026-10-22: Mutated after the first live run. Procedure that worked: register subs 1,3,4,5 and the unknown SUPI via tompa /ue/{supi}/register, MO 1 to 2, MO from barred 5, toggle reachability of 2, then read /t/krilju/log (entries carry flow and kind) and report in #build. Energy 70.
