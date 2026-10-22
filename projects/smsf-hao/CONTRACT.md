# smsf-hao — NRF contract (v1)

Team **smsf-hao** owns the **NRF** in the group's 5G Core Light. Everything below is live at

```
BASE = https://smsf.torget.bjarby.com/t/smsf-hao
```

Based on 3GPP TS 29.510. Simplified: HTTP, no TLS, no OAuth2, no NFStatusNotify subscriptions
(security is out of scope per `PROJEKT.md`). Errors are TS 29.500 ProblemDetails with
`content-type: application/problem+json`.

---

## 1. Nnrf_NFManagement — register, heartbeat, deregister

### Register / replace

```
PUT {BASE}/nnrf-nfm/v1/nf-instances/{nfInstanceId}
content-type: application/json
```

Body = NFProfile. Mandatory: `nfInstanceId` (must equal the path), `nfType`.
Strongly recommended: `fqdn` or `ipv4Addresses`, and `nfServices[]` so others can actually reach you.

```json
{
  "nfInstanceId": "0f4a9b2e-1c3d-4e5f-8a7b-6c5d4e3f2a1b",
  "nfType": "SMSF",
  "nfStatus": "REGISTERED",
  "fqdn": "smsf.krilju.example",
  "heartBeatTimer": 30,
  "priority": 10,
  "capacity": 100,
  "nfServices": [
    {
      "serviceInstanceId": "krilju-nsmsf-sms-1",
      "serviceName": "nsmsf-sms",
      "versions": [{ "apiVersionInUri": "v2", "apiFullVersion": "2.0.0" }],
      "scheme": "https",
      "nfServiceStatus": "REGISTERED",
      "apiPrefix": "/t/krilju"
    }
  ]
}
```

- **201 Created** + `Location` header the first time, **200 OK** on replace. Body = the stored profile.
- `nfStatus` defaults to `REGISTERED`, `heartBeatTimer` defaults to `30` (seconds).
- Unknown `nfType` values are accepted and logged, not rejected. We would rather keep the demo running.
- **400** with ProblemDetails if `nfInstanceId` is missing or does not match the path, or `nfType` is missing.

### Heartbeat

```
PATCH {BASE}/nnrf-nfm/v1/nf-instances/{nfInstanceId}
content-type: application/json-patch+json

[]
```

An empty array (or an empty body) is a plain heartbeat → **204 No Content**.
Send one every `heartBeatTimer` seconds. Miss **3 in a row** and your profile goes `SUSPENDED` and
disappears from discovery; the next heartbeat with `nfStatus` back to `REGISTERED` revives it:

```json
[{ "op": "replace", "path": "/nfStatus", "value": "REGISTERED" }]
```

A non-empty patch returns **200** with the updated profile. Supported ops: `add`, `replace`, `remove`.
`nfInstanceId` is never patchable.

### Read / deregister / list

```
GET    {BASE}/nnrf-nfm/v1/nf-instances/{nfInstanceId}   -> 200 NFProfile | 404
DELETE {BASE}/nnrf-nfm/v1/nf-instances/{nfInstanceId}   -> 204 | 404
GET    {BASE}/nnrf-nfm/v1/nf-instances                  -> 200 { "_links": { "item": [ { "href": ... } ] } }
```

---

## 2. Nnrf_NFDiscovery — find each other

```
GET {BASE}/nnrf-disc/v1/nf-instances?target-nf-type=UDM&requester-nf-type=SMSF
```

| Query parameter | Required | Meaning |
|---|---|---|
| `target-nf-type` | **yes** | what you are looking for, e.g. `UDM`, `AMF`, `SMSF`, `SMSC` |
| `requester-nf-type` | **yes** | who you are |
| `service-names` | no | comma-separated, e.g. `nudm-uecm,nudm-sdm` |
| `target-nf-instance-id` | no | a specific instance |
| `preferred-locality` | no | instances with a matching `locality` sort first |
| `supi` | no | matched against the profile's `supiRanges` if it has any |
| `limit` | no | max number of instances returned |

Response **200**:

```json
{
  "validityPeriod": 3600,
  "nfInstances": [
    {
      "nfInstanceId": "...",
      "nfType": "UDM",
      "nfStatus": "REGISTERED",
      "fqdn": "smsf.torget.bjarby.com",
      "nfServices": [
        {
          "serviceName": "nudm-uecm",
          "versions": [{ "apiVersionInUri": "v1" }],
          "scheme": "https",
          "apiPrefix": "/t/someteam",
          "apiRoot": "https://smsf.torget.bjarby.com/t/someteam"
        }
      ]
    }
  ]
}
```

- **No match is `200` with an empty `nfInstances: []`, never 404.** That is a normal answer.
- Only `REGISTERED` instances are returned. `SUSPENDED` ones are filtered out.
- Order is stable: preferred locality, then `priority` (low wins), then `nfInstanceId`.
- **`apiRoot` is our extension**, not TS 29.510. We compute it from `scheme` + `fqdn`/`ipv4Addresses`
  (+ `ipEndPoints[0].port`) + `apiPrefix`, so you can do
  `url = service.apiRoot + "/nudm-uecm/" + version + "/..."` without assembling it yourself.
  If you set `apiRoot` in your own profile we keep yours untouched.
  If your `apiPrefix` is itself an absolute URL (`https://host/t/you`) we use it as the `apiRoot`
  rather than concatenating, so you cannot end up with `https://hosthttps://host/t/you`.
  A prefix without a leading slash gets one.
- **400** if `target-nf-type` or `requester-nf-type` is missing.

---

## 3. Helper endpoints (not 3GPP)

```
GET {BASE}/status        who is registered right now, per type, plus counters
GET {BASE}/log?limit=60  the last messages in and out of the NRF, for cross-team debugging
```

The colony tile at `/colony/smsf-hao/` shows both.

---

## 4. Testing against us

```bash
projects/smsf-hao/smoke.sh                                   # against the live board
BASE=http://localhost:8080/t/smsf-hao projects/smsf-hao/smoke.sh   # against a local server
```

It registers a dummy NF, heartbeats it, discovers it, deregisters it and prints every step.

---

## 5. What we need from you

Register once at startup with `fqdn` set to the board host and `apiPrefix` set to `/t/<your-team>`,
list your `nfServices` with the service names from the spec (`nudm-uecm`, `nudm-sdm`, `namf-comm`,
`nsmsf-sms`, …), and heartbeat every 30 s. Then discovery works for everyone.

**Changes to this contract are announced in `#build` before they ship.** Found a fault? Tell us in
`#build` with `@smsf-hao`, what you sent, what you expected and what you got.
