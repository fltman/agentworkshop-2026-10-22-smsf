# SMS sequence diagrams (SMSF view)

Mermaid; renders on GitHub. RP layer (RP-DATA/ACK/ERROR) exists only UE <-> SMSF. SMSF <-> SMSC carries the bare TPDU.

## 1. Activation (UE registered, SMS service enabled)

```mermaid
sequenceDiagram
    participant UE
    participant AMF
    participant SMSF
    participant NRF
    participant UDM
    SMSF->>NRF: PUT nf-instances (register) + PATCH [] heartbeat every 20 s
    UE->>AMF: Registration (SMS requested)
    AMF->>SMSF: PUT /nsmsf-sms/v2/ue-contexts/{supi}
    SMSF->>NRF: discover UDM
    NRF-->>SMSF: UDM apiRoot
    SMSF->>UDM: register SMSF (UECM)
    SMSF->>UDM: GET sms-data + sms-mng-data
    UDM-->>SMSF: subscription (allowed / barred)
    SMSF-->>AMF: 201 Created (or 403 if SMS not allowed)
```

## 2. MO SMS (UE -> SMSC)

```mermaid
sequenceDiagram
    participant UE
    participant AMF
    participant SMSF
    participant NRF
    participant SMSC
    UE->>AMF: UL NAS: RP-DATA (MS->N) with SMS-SUBMIT
    AMF->>SMSF: POST /nsmsf-sms/v2/ue-contexts/{supi}/sendsms (smsPayload hex, smsRecordId)
    SMSF->>SMSF: check context + MO barring, strip RP-DATA
    SMSF->>NRF: discover SMSC (CUSTOM_SMSC)
    NRF-->>SMSF: SMSC apiRoot
    SMSF->>SMSC: POST /smsc/mo-forward-short-message {supi, msisdn, scAddress, smsRecordId, sms.hex = bare SMS-SUBMIT}
    alt accepted
        SMSC-->>SMSF: 200 SUCCESS
        SMSF-->>AMF: 200 smsPayload = RP-ACK
    else rejected
        SMSC-->>SMSF: 400/403 + SUBMIT-REPORT
        SMSF-->>AMF: error + smsPayload = RP-ERROR
    end
    AMF-->>UE: DL NAS: RP-ACK / RP-ERROR
```

## 3. MT SMS (SMSC -> UE)

```mermaid
sequenceDiagram
    participant SMSC
    participant SMSF
    participant NRF
    participant AMF
    participant UE
    SMSC->>SMSF: POST /smsc/mt-forward-short-message {supi, smsRecordId, sms.hex = bare SMS-DELIVER}
    SMSF->>SMSF: find UE context, wrap in RP-DATA (N->MS) with new RP-MR
    SMSF->>NRF: discover AMF (apiRoot from context)
    SMSF->>AMF: POST /namf-comm/v1/ue-contexts/{supi}/n1-n2-messages (smsPayload, smsRecordId)
    alt UE reachable
        AMF-->>SMSF: 200 N1_N2_TRANSFER_INITIATED
        AMF->>UE: DL NAS: RP-DATA
        UE->>AMF: UL NAS: RP-ACK (or RP-ERROR)
        AMF->>SMSF: POST .../sendsms (UplinkSMS, RP-ACK)
        SMSF->>SMSF: match on smsRecordId or supi + RP-MR
        SMSF-->>SMSC: 200 delivered (or failure cause)
    else not reachable
        AMF-->>SMSF: 404 CONTEXT_NOT_FOUND / 504 UE_NOT_REACHABLE
        SMSF-->>SMSC: ABSENT_SUBSCRIBER
    end
```

## Test checklist (subscribers from UDM)

| Case | SUPI | Expected |
|---|---|---|
| MO ok | imsi-001010000000001 | RP-ACK |
| MO barred | imsi-001010000000005 | RP-ERROR |
| SMS not allowed | imsi-001010000000003 | activation refused |
| MT barred | imsi-001010000000004 | failure to SMSC |
| Unknown | imsi-001019999999999 | USER_NOT_FOUND |
