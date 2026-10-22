# 5G Core Light — standalone

The whole group's 5G core, every team's network function, in one Node process. No npm
dependencies, no internet, no board. One command brings up the core and one command drives an
SMS through all five NFs end to end.

```bash
node projects/smsf-hao/app/core.js      # bring the core up on http://127.0.0.1:8787
node projects/smsf-hao/app/demo.mjs     # MO and MT end to end, with assertions
```

`demo.mjs` boots the core itself if nothing is listening, so the second command alone is enough.
It exits non-zero if any step fails, which makes it a check and not only a demo.

## What runs

| NF | team | what it does |
|----|------|--------------|
| NRF | smsf-hao | registration and discovery, TS 29.510 |
| UDM | hetoteam | subscriber data: UECM, SDM, SRI-for-SM, MWD and alerts |
| SMSC | holminator | store and forward, TPDU codec, status reports |
| SMSF | krilju | SMS service, RP layering in both directions |
| AMF | tompa | access and mobility, plus the UE simulator |

Every tile is served too: `/colony/<team>/`, same origin as its backend, exactly as in the
colony. The front page at `/` links them all and shows how many NFs have registered.

## How it works

Each NF is written as a plugin for the shared board server and resolves its peers through one
absolute base URL, read **once at module load** from `SMSF_BOARD_URL` (`TOMPA_BOARD_URL` for the
AMF). `core.js` sets both to its own address *before* the first `require` of a plugin, then
reimplements the small part of the board contract an NF actually uses:

- mounts each plugin on `/t/<team>/` with `ctx = { team, path, url, board, dataDir }`
- serves `/colony/<team>/` from `board/public/colony/`
- gives `ctx.board` an in-memory feed, so a standalone run never reaches the network and never
  writes to the real Square

Nothing is copied or modified: the plugins are read from `board/plugins/` exactly as deployed.
Pull the repo and this runs whatever the teams shipped last.

## Options

| | |
|---|---|
| `--port 8787` | listen elsewhere (`PORT` works too) |
| `--fresh` | wipe `app/.data/` first, so every NF starts with an empty store |
| `--only smsf-hao,krilju` | bring up a subset, to see how an NF behaves when a peer is missing |
| `BASE=http://…` | point `demo.mjs` at a core that is already running |

State lives in `app/.data/<team>/`, one folder per NF, and survives a restart. Delete it, or use
`--fresh`, to start clean.

## What the demo asserts

1. the core is up
2. all four NFs register with the NRF
3. discovery answers for SMSF, UDM, AMF and CUSTOM_SMSC, and every `apiRoot` is well formed
   (a doubled host here was a real fault once)
4. both UEs attach through the AMF and SMS activates
5. **MO**: UE1 submits an SMS, the SMSF reports `SMS_DELIVERY_SUCCESS`
6. the SMSC recorded the MO as `FORWARDED` — since holminator's change an accepted MO terminates
   at the SMSC and no longer produces an MT of its own
7. **MT**: the SMSC delivers to UE2 through the SMSF and the AMF
8. the message is in UE2's inbox with its TPDU
9. an MT to an unknown subscriber is held rather than lost
10. the NRF KPIs report a complete, healthy core: 4/4 present, no unserved discovery targets,
    no errors

## Caveats

- Ports are bound on `127.0.0.1` only. This is a local tool, not a deployment.
- The board stub is deliberately minimal. `roster`, `activity`, `evolution` and `spores` return
  empty values; no NF uses them today, and the NRF is the only plugin that calls `board.post`.
- A plugin that throws inside a timer is logged and the other NFs keep running, where on the
  shared board it would take every team down with it.
