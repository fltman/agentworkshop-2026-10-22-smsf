# SPEC-NOTES: simulated SMSC (SC + SMS-GMSC/IWMSC) for "5G Core Light"

Sources: TS 23.040 vK.0.0 (23040-k00), TS 24.011 vK.0.0, TS 29.002 vJ.1.0, TS 23.502 vK.3.0, TS 29.338 vJ.3.0 (cross-reference only).
Scope: our SMSC = SC + SMS-GMSC (MT) + SMS-IWMSC (MO) folded into one HTTP/JSON node. Per TS 23.040 Annex K, the SMSF
takes the MSC/VLR role ("MSC" -> "SMSF", "HLR" -> "UDM/HSS/HLR", "MS" -> "UE", "non GPRS" -> "5GS"). Reference point 2
(GMSC/IWMSC <-> UDM) and 3 (GMSC/IWMSC <-> SMSF) are MAP, optionally Diameter S6c/SGd or HTTP/2 (TS 23.040 Annex K.1).

Bit numbering: bit 7 = MSB of an octet. Hex values below are derived from the bit patterns in the cited tables.

---

## 1. SC behaviour on MO (SMS-SUBMIT)

### 1.1 SMS-SUBMIT layout (TS 23.040 9.2.2.2)
First octet: TP-MTI b1..b0 = `01` | TP-RD b2 | TP-VPF b4..b3 | TP-SRR b5 | TP-UDHI b6 | TP-RP b7.
Then TP-MR (1 o), TP-DA (2-12 o), TP-PID (1 o), TP-DCS (1 o), TP-VP (0, 1 or 7 o), TP-UDL (1 o), TP-UD.
Mandatory: MTI, RD, VPF, RP, MR, DA, PID, DCS, UDL. Optional: UDHI, SRR, VP, UD.

### 1.2 What the SC does with each field
| Field | SC behaviour | Ref |
|---|---|---|
| TP-MR | 0..255, set by MS; same value received at SC. SC returns it in the SMS-STATUS-REPORT for that SM. | 23.040 9.2.3.6 |
| TP-RD | RD=1 and same TP-MR + same TP-DA as an SM still held from the same OA: SC **should** discard it and answer RP-ERROR with SMS-SUBMIT-REPORT TP-FCS `C5` "SM Rejected-Duplicate SM" (or, if configured for backward compatibility, RP-ACK). RD=0: accept. | 9.2.3.6, 9.2.3.25 |
| TP-VPF | `00` (0x00) none; `10` (0x10) relative; `01` (0x08) enhanced; `11` (0x18) absolute. Unsupported value **may** be rejected with TP-FCS `C6` "TP-VPF not supported". | 9.2.3.3 |
| TP-VP relative (1 o) | 0..143: (VP+1)x5 min; 144..167: 12 h + (VP-143)x30 min; 168..196: (VP-166) days; 197..255: (VP-192) weeks. Counted from SC receipt of the SMS-SUBMIT. | 9.2.3.12.1 |
| TP-VP absolute (7 o) | Same semi-octet coding as TP-SCTS; absolute expiry time. | 9.2.3.12.2 |
| TP-VP enhanced (7 o) | Octet 1: b7 ext, b6 single-shot SM (at most one delivery attempt), b2..b0 format: 000 none, 001 relative (as 9.2.3.12.1), 010 relative 1..255 s (0 reserved), 011 relative HH MM SS semi-octets; 100..111 reserved. SC **shall** reject unsupported/reserved with TP-FCS `C7` "TP-VP not supported". | 9.2.3.12.3 |
| Validity | SC guarantees existence of the SM in SC memory for the validity period; SC retains responsibility until report received or VP expires. | 3.2.1, 6.1 |
| TP-SRR | 1 = status report requested. Status reports are optional for the SC operator. | 9.2.3.5, 3.2.9 |
| TP-RP | If SC supports reply-path requesting: when RP=1 in SMS-SUBMIT, set TP-RP=1 in the resulting SMS-DELIVER (commits SC to deliver one reply). | 9.2.3.17, Annex D.4, D.7 |
| TP-PID | b7b6=`00`: b5 telematic interworking, b4..b0 device type; b7b6=`01`: 0x40 SM Type 0, 0x41..0x47 Replace Type 1..7, 0x48 Device Triggering, 0x5F Return Call, 0x7C ANSI-136 R-DATA, 0x7D ME data download, 0x7E ME de-personalization, 0x7F (U)SIM data download; `10` reserved; `11` SC-specific. SC **may** reject reserved/unsupported values. MO with Device Triggering PID (0x48) **shall** be discarded. Replace types in MO: SC replaces stored SM with same PID + same originating address. Simple MS-to-SC = 0x00. | 9.2.3.9 |
| TP-DA | '#' terminates routing address; following digits are subaddress (optional support, copy into TP-OA on delivery). | 9.2.3.8, 6.2.1 |
| SC timestamp | SC records arrival time (1 s accuracy) as TP-SCTS; returned in SMS-SUBMIT-REPORT and the same value in SMS-STATUS-REPORT. | 3.2.2, 6.2, 9.2.2.2a note 5 |

### 1.3 SMS-SUBMIT-REPORT (TS 23.040 9.2.2.2a)
Carried as RP-User-Data in RP-ACK (positive) or RP-ERROR (negative).
- **For RP-ERROR**: TP-MTI (`01`) + TP-UDHI(O) | **TP-FCS (M)** | TP-PI (M) | **TP-SCTS (M, 7 o)** | TP-PID/TP-DCS/TP-UDL/TP-UD (O, flagged in TP-PI).
- **For RP-ACK**: TP-MTI + TP-UDHI(O) | TP-PI (M) | **TP-SCTS (M)** | TP-PID/TP-DCS/TP-UDL/TP-UD (O).
- Octet-1 bits 7 and 5..2 unused, sender sets 0. TP-UD only usable by the SC.
- TP-PI (9.2.3.27): b0 TP-PID, b1 TP-DCS, b2 TP-UDL, b7 extension. Minimal ack: `01 00 <SCTS 7 o>`.

### 1.4 TP-FCS values (TS 23.040 9.2.3.22) — hex
| Hex | Meaning | MO | MT |
|---|---|---|---|
| 80 | Telematic interworking not supported | x | |
| 81 | Short message Type 0 not supported | x | x |
| 82 | Cannot replace short message | x | x |
| 8F | Unspecified TP-PID error | x | x |
| 90 | Data coding scheme (alphabet) not supported | x | |
| 91 | Message class not supported | | x |
| 9F | Unspecified TP-DCS error | x | x |
| A0 | Command cannot be actioned | x | |
| A1 | Command unsupported | x | |
| AF | Unspecified TP-Command error | x | |
| B0 | TPDU not supported | x | x |
| C0 | SC busy | x | |
| C1 | No SC subscription | x | |
| C2 | SC system failure | x | |
| C3 | Invalid SME address | x | |
| C4 | Destination SME barred | x | |
| C5 | SM Rejected-Duplicate SM | x | |
| C6 | TP-VPF not supported | x | |
| C7 | TP-VP not supported | x | |
| D0 | (U)SIM SMS storage full | | x |
| D1 | No SMS storage capability in (U)SIM | | x |
| D2 | Error in MS | | x |
| D3 | Memory Capacity Exceeded | | x |
| D4 | (U)SIM Application Toolkit Busy | | x |
| D5 | (U)SIM data download error | | x |
| E0-FE | Application specific | x | x |
| FF | Unspecified error cause | x | x |
Reserved: 00-7F, 83-8E, 92-9E, A2-AE, B1-BF, C8-CF, D6-DF; received reserved codes are treated as unspecified.

---

## 2. SC behaviour on MT (SMS-DELIVER) and status reports

### 2.1 SMS-DELIVER (TS 23.040 9.2.2.1)
First octet: TP-MTI `00` | TP-MMS b2 | TP-LP b3 | TP-SRI b5 | TP-UDHI b6 | TP-RP b7.
Then TP-OA (2-12 o), TP-PID, TP-DCS, TP-SCTS (7 o), TP-UDL, TP-UD. Mandatory: MTI, MMS, RP, OA, PID, DCS, SCTS, UDL.
| Field | SC sets | Ref |
|---|---|---|
| TP-MMS | **0 = more messages waiting** in this SC, **1 = no more** (inverted sense!). Also mapped into MAP More-Messages-To-Send. | 9.2.3.2, 3.2.4, 29.002 12.9.3 |
| TP-SRI | 1 = a status report shall be returned to the SME (bit 5). Not otherwise specified for MS-originated SMs. | 9.2.3.4 |
| TP-OA | Originating SME address (from the SUBMIT's RP-OA / MSISDN); subaddress digits copied if supported. | 9.2.3.7, 6.2.1 |
| TP-SCTS | Arrival time at SC, semi-octets YY MM DD hh mm ss TZ (TZ in quarter hours, sign bit = bit 3 of 7th octet). Must be unique per destination MS: if several SMs to the same MS arrive within 1 s, SC **shall** modify timestamps minimally so all differ. | 9.2.3.11, 6.2 (1) |
| TP-RP | 1 if reply path is committed (see 1.2). | 9.2.3.17, Annex D |
| TP-LP | Set when SC forwards/spawns a message to a destination other than the original. | 9.2.3.28 |
| TP-PID/DCS/UD | From SUBMIT; only changes needed to convert SUBMIT->DELIVER (for data download PIDs). | 9.2.3.9 |

SC rules (6.2): only **one outstanding SMS-DELIVER per MS** at a time; **SHOULD** support overwrite (replace) from same originator.
Priority: non-priority SMs not attempted if MS known temporarily absent; priority SMs always attempted (3.2.5) -> MAP SM-RP-PRI.

### 2.2 SMS-DELIVER-REPORT (TS 23.040 9.2.2.1a)
In RP-ERROR: TP-MTI `00` + UDHI(O) | **TP-FCS (M)** | TP-PI (M) | TP-PID/DCS/UDL/UD (O).
In RP-ACK: TP-MTI + UDHI(O) | TP-PI (M) | TP-PID/DCS/UDL/UD (O).
Sending diagnostic info is optional at the MS, but when sent the PLMN shall convey it and **the SC shall support reception** (3.3.2). Arrives at SC via MAP MT-ForwardSM Response SM-RP-UI (29.002 12.9.3).

### 2.3 SMS-STATUS-REPORT (TS 23.040 9.2.2.3, 3.2.9)
Generated by SC when it has concluded the status of an MO SM for which TP-SRR=1 (optional SC feature). Treated as an SMS-DELIVER for delivery procedures (incl. alerting); MAP SRI-for-SM SM-RP-MTI = 1 (status report) vs 0 (deliver).
First octet: TP-MTI `10` | TP-MMS b2 | TP-LP b3 | TP-SRQ b5 (0 = result of SMS-SUBMIT) | TP-UDHI b6.
Fields (M unless noted): TP-MR (= MR of the original SUBMIT), TP-RA (= recipient/TP-DA of original), TP-SCTS (= SC receipt time of the SUBMIT, same as in SUBMIT-REPORT), TP-DT (discharge time), TP-ST, then optional TP-PI, TP-PID (of original SUBMIT), TP-DCS, TP-UDL, TP-UD.
TP-DT (9.2.3.13): completion time if completed; last attempt time if still trying; last attempt or disposal time if SC stopped.
RP-OA of the report may differ from the RP-DA the MS used (3.2.9).

### 2.4 TP-ST values (TS 23.040 9.2.3.15), b7 = 0
| Hex | Meaning |
|---|---|
| **Completed** | |
| 00 | Short message received by the SME |
| 01 | Forwarded by SC to SME, SC unable to confirm delivery |
| 02 | Short message replaced by the SC |
| 10-1F | SC specific |
| **Temporary error, SC still trying** | |
| 20 | Congestion |
| 21 | SME busy |
| 22 | No response from SME |
| 23 | Service rejected |
| 24 | Quality of service not available |
| 25 | Error in SME |
| 30-3F | SC specific |
| **Permanent error, SC not trying any more** | |
| 40 | Remote procedure error |
| 41 | Incompatible destination |
| 42 | Connection rejected by SME |
| 43 | Not obtainable |
| 44 | Quality of service not available |
| 45 | No interworking available |
| 46 | SM Validity Period Expired |
| 47 | SM Deleted by originating SME |
| 48 | SM Deleted by SC Administration |
| 49 | SM does not exist |
| 50-5F | SC specific |
| **Temporary error, SC not trying any more** | |
| 60 | Congestion |
| 61 | SME busy |
| 62 | No response from SME |
| 63 | Service rejected |
| 64 | Quality of service not available |
| 65 | Error in SME |
| 70-7F | SC specific |
Reserved: 03-0F, 26-2F, 4A-4F, 66-6F, 80-FF (MS treats reserved as 0x63).

### 2.5 Retry / validity / MWD (TS 23.040 3.2.6-3.2.8, 3.3, 8.1.1)
- MT failure error indications to SC (Table 1, 3.3.2), P=permanent T=temporary: Unknown subscriber (P), Teleservice not provisioned (P), Call barred (T), Facility not supported (T), Absent subscriber (T), MS busy for MT SMS (T), SMS lower layers capabilities not provisioned (T), Error in MS (T), Illegal Subscriber (P), Illegal Equipment (P), System failure (T), Memory Capacity Exceeded (T).
- Absent-subscriber diagnostic (Table 1a): 0 no paging resp via MSC, 1 IMSI detached, 2 roaming restriction, 3 dereg in HLR non-GPRS, 4 MS purged non-GPRS, 5 no paging resp via SGSN, 6 GPRS detached, 7 dereg HLR GPRS, 8 purged GPRS, 9/10 unidentified subscriber via MSC/SGSN, 11 dereg HSS/HLR for IMS, 12 no response via IP-SM-GW, 13 MS temporarily unavailable. Other values reserved.
- On absent subscriber / memory capacity exceeded for non single-shot SM, GMSC asks HLR/UDM to insert SC address into MWD (ReportSM-DeliveryStatus) and the SC is informed of failure, absence reason and MWD status (RP-ERROR RP-MSI, MSIsdn-Alert) so it can adjust retry (3.2.8 Case 1, 8.1.1, 9.3.2.4).
- If HLR stored SC address -> SC will receive Alert-SC when MS becomes reachable/memory available; if HLR cannot store it (e.g. MWD full) -> SC must retransmit periodically (3.2.8).
- On Alert-SC the SC **may** start delivery of queued messages; repeated attempts may be alert-driven or autonomous (operator choice) (3.2.7 NOTE 5).
- On successful delivery GMSC notifies HLR (successful transfer) so other SCs in MWD are alerted (8.1.1, 3.2.6 2g).
- Single-shot SM (enhanced VP b6): at most one attempt; not added to MWD (3.2.6, 9.2.3.12.3, 29.002 12.1.3 "Single Attempt Delivery").
- VP expiry -> drop SM; if SRR was set, status report TP-ST 0x46 (implied by 9.2.3.15; no explicit "shall send" text found).

---

## 3. MAP operations (TS 29.002 clause 12, ASN.1 17.6.5/17.6.6/17.7.6)

Opcodes / timers (17.6.5): sendRoutingInfoForSM local:45 (m=15-30 s), mo-ForwardSM 46 (ml=1-10 min), mt-ForwardSM 44 (ml), reportSM-DeliveryStatus 47 (s=3-10 s), alertServiceCentre 64 (s), informServiceCentre 63 (s, no result). Timer ranges 17.1.2.
Error codes (17.6.6): unknownSubscriber 1, unidentifiedSubscriber 5, absentSubscriberSM 6, illegalSubscriber 9, teleserviceNotProvisioned 11, illegalEquipment 12, callBarred 13, facilityNotSupported 21, subscriberBusyForMT-SMS 31, sm-DeliveryFailure 32, messageWaitingListFull 33, systemFailure 34, dataMissing 35, unexpectedDataValue 36.

### 3.1 MAP-SEND-ROUTING-INFO-FOR-SM (12.1) — SC/GMSC -> UDM
Request M: MSISDN, SM-RP-PRI, Service Centre Address. C/U: SM-RP-MTI (0 deliver / 1 status report), SM-RP-SMEA, GPRS Support Indicator, SM-Delivery Not Intended, IP-SM-GW Guidance Support Ind, Single Attempt Delivery, IMSI (if no MSISDN), Correlation ID, T4 Trigger Indicator, **SMSF Support Indicator**.
Response: IMSI (mandatory on success), Network Node Number (at least one target E.164 shall be present, 12.1.4), Network Node Diameter Address, LMSI, GPRS Node Ind, Additional Number(+Diameter), Third Number, IMS Node Ind, **SMSF 3GPP Number/Diameter Address, SMSF Non-3GPP Number/Diameter Address, SMSF 3GPP / Non-3GPP Address Indicator**, IP-SM-GW Guidance.
User errors: Unknown subscriber; Call Barred; Teleservice Not Provisioned; Absent Subscriber_SM; Facility Not Supported; System failure; Unexpected Data Value; Data missing.
SM-RP-PRI (7.6.8.5): whether delivery shall be attempted when SC address already in MWD.

### 3.2 MAP-MO-FORWARD-SHORT-MESSAGE (12.2) — SMSF -> SC (IWMSC)
Request M: SM RP DA (SC address from MS), SM RP OA (MSISDN of originator), SM RP UI (TPDU = SMS-SUBMIT). C: IMSI (of originator, shall be inserted), Correlation ID, SM Delivery Outcome (only with Correlation ID).
Response: SM RP UI (C) = SMS-SUBMIT-REPORT.
User errors (12.2.3): Facility Not Supported; System Failure; SM Delivery Failure with cause unknownServiceCentre / sc-Congestion / invalidSME-Address / subscriberNotSC-Subscriber / protocol error (equipmentProtocolError); Unexpected Data Value. ASN.1 ERRORS: systemFailure | unexpectedDataValue | facilityNotSupported | sm-DeliveryFailure.
SM-DeliveryFailureCause (17.7.7) = { SM-EnumeratedDeliveryFailureCause, diagnosticInfo SignalInfo OPTIONAL (carries the SUBMIT-/DELIVER-REPORT TPDU) }. Enumerated: memoryCapacityExceeded 0, equipmentProtocolError 1, equipmentNotSM-Equipped 2, unknownServiceCentre 3, sc-Congestion 4, invalidSME-Address 5, subscriberNotSC-Subscriber 6.

### 3.3 MAP-MT-FORWARD-SHORT-MESSAGE (12.9) — SC/GMSC -> SMSF
Request M: SM RP DA (IMSI or LMSI; noSM-RP-DA in subsequent transfers), SM RP OA (SC address), SM RP UI (SMS-DELIVER or SMS-STATUS-REPORT). C: More Messages To Send (from TP-MMS), SM Delivery Timer (30..600 s), SM Delivery Start Time, SMS Over IP Only Ind, Correlation ID, Maximum Retransmission Time, SMS-GMSC Address (shall be present if Max Retransmission Time present), SMS-GMSC Diameter Address.
Response: SM RP UI (C) = SMS-DELIVER-REPORT; Requested Retransmission Time (only with Absent Subscriber_SM and if Max Retransmission Time was sent); User Identifier Alert.
User errors: Unidentified subscriber; Absent Subscriber_SM (AbsentSubscriberSM-Param: absentSubscriberDiagnosticSM 0..255, additional diag, requestedRetransmissionTime, userIdentifierAlert); Subscriber busy for MT SMS; Facility Not Supported; Illegal Subscriber; Illegal equipment; System Failure; SM Delivery Failure (memoryCapacityExceeded / equipmentProtocolError / equipmentNotSM-Equipped); Unexpected Data Value; Data Missing.

### 3.4 MAP-REPORT-SM-DELIVERY-STATUS (12.3) — GMSC -> UDM
Request M: MSISDN, Service Centre Address, **SM Delivery Outcome**. C: IMSI, Absent Subscriber Diagnostic SM, GPRS Support Ind, Delivery Outcome Ind, Additional SM Delivery Outcome + diag, IP-SM-GW Ind/Outcome/diag, Single Attempt Delivery, Correlation ID, **SMSF 3GPP / non-3GPP Delivery Outcome Indicator, SM Delivery Outcome, Absent Subscriber Diagnostic SM**, Failed Serving Nodes.
Response: MSIsdn-Alert (storedMSISDN; present on unsuccessful delivery when it differs), Registered Serving Nodes.
User errors: Unknown Subscriber; Message Waiting List Full; Unexpected Data Value; Data missing.
**SM-DeliveryOutcome** (17.7.6): memoryCapacityExceeded (0), absentSubscriber (1), successfulTransfer (2).

### 3.5 MAP-ALERT-SERVICE-CENTRE (12.5) — UDM -> SC (IWMSC)
Request M: **MSIsdn-Alert**, **Service Centre Address**. C: IMSI (when no MSISDN, T4), Correlation ID, Maximum UE Availability Time (shall be included if available, HLR->IWMSC), SMS-GMSC Alert Event / SMS-GMSC Diameter Address / New SGSN/MME/MSC Number (only MME/SGSN/MSC -> GMSC variant; shall not be included HLR->IWMSC).
Result: empty (RETURN RESULT TRUE). User errors: System Failure; Unexpected Data Value; Data missing.
**Alert reasons**: ASC itself has no Alert Reason parameter. The triggering Ready-for-SM (12.4) carries AlertReason ms-Present (0) / memoryAvailable (1) (7.6.8.8, 17.7.6); 3.2.7 of 23.040: MS resumed operation or memory newly available.

### 3.6 MAP-INFORM-SERVICE-CENTRE (12.6) — UDM -> GMSC (non-confirmed, after SRI-for-SM)
Params (all C): MSIsdn-Alert (stored MSISDN in MWD), MWD Status, Absent Subscriber Diagnostic SM, Additional ASD SM, SMSF 3GPP / Non-3GPP ASD SM.
MW-Status bits (17.7.6): sc-AddressNotIncluded (0), mnrf-Set (1), mcef-Set (2), mnrg-Set (3), mnr5g-Set (4), mnr5gn3g-Set (5).
In S6c this is folded into SRA (23.040 Annex J/K note: InformSC + SRI-for-SM replaced by Diameter SRR).

### 3.7 SGd/S6c cross-reference (TS 29.338, owned by the other engineer)
Experimental results (29.338 7.3): DIAMETER_ERROR_USER_UNKNOWN 5001, ABSENT_USER 5550, USER_BUSY_FOR_MT_SMS 5551, FACILITY_NOT_SUPPORTED 5552, ILLEGAL_USER 5553, ILLEGAL_EQUIPMENT 5554, SM_DELIVERY_FAILURE 5555, SERVICE_NOT_SUBSCRIBED 5556, SERVICE_BARRED 5557, MWD_LIST_FULL 5558. SM-Enumerated-Delivery-Failure-Cause (6.3.3.6) uses the same 0..6 values as MAP. OFA on SC negative ack: SM_DELIVERY_FAILURE + cause given by SC (29.338 6.2.1).

---

## 4. TS 23.502 4.13.3 sequences (SMSC involvement marked **SC**)

### 4.1 MO SMS over NAS (4.13.3.3, CM-IDLE; 4.13.3.5 CM-CONNECTED = same without Service Request)
1. UE Service Request (if CM-IDLE).
2a. UE builds CP-DATA/RP-DATA/TPDU(SMS-SUBMIT), sends in NAS to AMF.
2b. AMF -> SMSF Nsmsf_SMService_UplinkSMS (SMS + SUPI, IMEISV, ULI, time zone).
2c-2d. SMSF -> AMF -> UE: CP-ACK.
3-5. **SC**: SMSF checks SMS subscription; if allowed, forwards to SMS-IWMSC/SC per TS 23.040 (MO-ForwardSM / SGd OFR) and gets the submit report (OFA/RP-ACK/RP-ERROR). Emergency MO: SMSF also gives GPSI and ULI to the serving-PLMN SC.
6a-6b. SMSF -> AMF -> UE: submit report (RP-ACK/RP-ERROR with SMS-SUBMIT-REPORT); optional "last message indication".
6c-6d. UE -> SMSF CP-ACK.

### 4.2 MT SMS over NAS (4.13.3.6 CM-IDLE/RRC_INACTIVE; 4.13.3.7 CM-CONNECTED; 4.13.3.8 non-3GPP)
1-3. **SC**: SC -> SMS-GMSC -> UDM routing interrogation per TS 23.040 (SRI-for-SM / S6c SRR); UDM returns both SMSF addresses if UE has 3GPP and non-3GPP AMFs; GMSC forwards SM to SMSF (MT-ForwardSM / SGd TFR), with priority header if MPS.
4. SMSF checks subscription, Namf_MT_EnableUEReachability; AMF pages; UE Service Request. If UE unreachable -> 4.13.3.9, remaining steps skipped.
5a-5b. SMSF -> AMF -> UE: CP-DATA/RP-DATA/SMS-DELIVER. 5c-5d. UE CP-ACK.
6a-6b. UE -> SMSF: delivery report (RP-ACK/RP-ERROR with SMS-DELIVER-REPORT). 6c-6d. SMSF -> UE CP-ACK; repeat 4-6c for more SMs.
7. **SC**: in parallel with 6c-6d, SMSF delivers the delivery report to the SC (MT-ForwardSM result / TFA).
CM-CONNECTED: no paging; RRC_INACTIVE NAS delivery failure -> AMF indicates non-delivery to SMSF.

### 4.3 Unsuccessful MT delivery re-attempt (4.13.3.9)
1. AMF cannot deliver (incl. power-saving): may retry other access type, else informs SMSF.
2. **SC**: SMSF sends failure report to SMS-GMSC (absent subscriber); GMSC may retry via other entity.
3. **SC**: GMSC informs UDM UE cannot receive MT-SMS (ReportSM-DeliveryStatus / S6c RDR, absentSubscriber) -> UDM sets URRP-AMF and stores SC address in MWD.
4. UDM subscribes to UE reachability in AMF (4.2.5.2) if not yet.
5. **SC**: AMF reports UE activity (4.2.5.3); if UE registered in an SMSF, UDM clears URRP-AMF, clears MWD and **alerts the SCs** (Alert-SC / S6c ALR); if no SMSF registration, MWD kept until SMSF registers.
6. **SC**: SRI-for-SM for a UE not registered in 5GC / not registered for SMS -> UDM answers absent, stores SC in MWD, indicates this to SC.
7. **SC**: Nudm_UECM_Registration from an SMSF with MWD stored and no URRP-AMF -> UDM alerts SCs and clears MWD.

---

## 5. TS 24.011 RP-cause values and mapping

RP-Cause element (24.011 8.2.5.4): always in RP-ERROR; cause value (7 bits) + optional diagnostic. Mapping to MAP is specified in TS 23.040 (clause 11); MAP return-error parameters go into the diagnostic field.

### 5.1 Table 8.4 part 1 — MO (network -> MS RP-ERROR)
| # | Cause |
|---|---|
| 1 | Unassigned (unallocated) number |
| 8 | Operator determined barring |
| 10 | Call barred |
| 11 | Reserved |
| 21 | Short message transfer rejected |
| 27 | Destination out of order |
| 28 | Unidentified subscriber |
| 29 | Facility rejected |
| 30 | Unknown subscriber |
| 38 | Network out of order |
| 41 | Temporary failure |
| 42 | Congestion |
| 47 | Resources unavailable, unspecified |
| 50 | Requested facility not subscribed |
| 69 | Requested facility not implemented |
| 81 | Invalid short message transfer reference value |
| 95 | Semantically incorrect message |
| 96 | Invalid mandatory information |
| 97 | Message type non-existent or not implemented |
| 98 | Message not compatible with SM protocol state |
| 99 | Information element non-existent or not implemented |
| 111 | Protocol error, unspecified |
| 127 | Interworking, unspecified |
Other values -> treat as 41.

### 5.2 Table 8.4 part 2 — MT (MS -> network RP-ERROR)
22 Memory capacity exceeded; 81; 95; 96; 97; 98; 99; 111 (others -> 111).
Part 3 (memory available notification): 30 P, 38 T, 41 T, 42 T, 47 T, 69 P, 95-99 P, 111 P, 127 P.

### 5.3 MO: MAP MO-ForwardSM error -> RP-Cause to UE (TS 23.040 11.3)
| MAP return error from IWMSC/SC | RP-Cause |
|---|---|
| System Failure | 38 Network out of order |
| Facility Not Supported | 69 Requested facility not implemented |
| Unexpected Data Value | 38 Network out of order |
| SM-DeliveryFailure / unknownSC | 1 Unassigned number |
| SM-DeliveryFailure / sc-Congestion | 42 Congestion |
| SM-DeliveryFailure / invalidSME-Addr | 21 Short message transfer rejected |
| SM-DeliveryFailure / subscriberNotSC-Subscriber | 28 Unidentified subscriber |
| Local/lower-layer failure (reject, timer, abort) | 38 Network out of order |
No explicit row for SM-DeliveryFailure/equipmentProtocolError in 11.3 (not found).

### 5.4 MT: RP/radio failure at SMSF -> MAP MT-ForwardSM error (TS 23.040 11.1)
| Failure at SMSF (MSC role) | MAP return error |
|---|---|
| RP-ERROR #22 Memory capacity exceeded | SM_DeliveryFailure / memoryCapacityExceeded |
| Other RP-ERROR causes | SM_DeliveryFailure / equipmentProtocolError |
| CP or lower layer error | SM_DeliveryFailure / equipmentProtocolError |
| Mobile has no SM capability | SM_DeliveryFailure / equipmentNotSM-Equipped |
| TR1N timeout, no SAPI 3 | SM_DeliveryFailure / equipmentProtocolError |
SGd equivalent: DIAMETER_ERROR_SM_DELIVERY_FAILURE (5555) + SM-Enumerated-Delivery-Failure-Cause (29.338 6.2.2). Paging failure -> Absent Subscriber_SM / DIAMETER_ERROR_ABSENT_USER.

---

## 6. Requirements for our SMSC (test checklist)

### MO
1. MUST accept SMS-SUBMIT (TP-MTI=01) in MO-ForwardSM SM-RP-UI and return result carrying SMS-SUBMIT-REPORT. [29.002 12.2; 23.040 9.2.2.2a]
2. MUST put TP-SCTS (SC arrival time, 7 semi-octets incl. TZ) in every SMS-SUBMIT-REPORT, ack and error. [23.040 9.2.2.2a, 9.2.3.11]
3. MUST set TP-PI in SUBMIT-REPORT, with bits for any included PID/DCS/UDL. [23.040 9.2.2.2a, 9.2.3.27]
4. MUST include TP-FCS in SUBMIT-REPORT for RP-ERROR, values from 9.2.3.22 table (hex). [23.040 9.2.3.22]
5. SHOULD reject a duplicate (TP-RD=1, same TP-MR + TP-DA + OA, SM still held) with RP-ERROR TP-FCS 0xC5; MAY be configured to RP-ACK. [23.040 9.2.3.6, 9.2.3.25]
6. MUST accept a duplicate with TP-RD=0 as a new SM. [23.040 9.2.3.25]
7. MUST decode TP-VPF and TP-VP (relative/absolute/enhanced) and compute expiry from SC receipt time. [23.040 9.2.3.3, 9.2.3.12]
8. MAY reject unsupported TP-VPF with TP-FCS 0xC6. [23.040 9.2.3.3]
9. MUST reject reserved/unsupported enhanced TP-VP with TP-FCS 0xC7. [23.040 9.2.3.12.3]
10. MUST discard MO with TP-PID Device Triggering (0x48). [23.040 9.2.3.9]
11. MAY reject reserved/unsupported TP-PID (TP-FCS 0x80/0x8F). [23.040 9.2.3.9]
12. MUST be able to replace a stored SM on Replace Type n PID (0x41-0x47) from same originating address. [23.040 9.2.3.9, 6.2 (3)]
13. MUST return MAP errors only from: SystemFailure(34), UnexpectedDataValue(36), FacilityNotSupported(21), SM-DeliveryFailure(32) with cause unknownServiceCentre(3)/sc-Congestion(4)/invalidSME-Address(5)/subscriberNotSC-Subscriber(6)/equipmentProtocolError(1). [29.002 12.2.3, 17.6.5]
14. SHOULD carry the SMS-SUBMIT-REPORT (RP-ERROR variant) in SM-DeliveryFailureCause.diagnosticInfo. [29.002 17.7.7; 24.011 8.2.5.4]
15. MUST map invalid destination -> invalidSME-Address (RP #21 at SMSF), congestion -> sc-Congestion (#42), unknown SC address -> unknownServiceCentre (#1). [23.040 11.3]
16. MUST honour TP-RP: set TP-RP in the resulting SMS-DELIVER if reply path requested and supported. [23.040 Annex D.4]
17. MUST keep the SM until delivered or VP expiry. [23.040 3.2.1, 6.1]

### MT
18. MUST query UDM with SRI-for-SM (MSISDN, SM-RP-PRI, SC address; SMSF Support Indicator for 5GC) before MT-Forward. [29.002 12.1; 23.040 8.1.1]
19. MUST handle SRI-for-SM errors: UnknownSubscriber, CallBarred, TeleserviceNotProvisioned, AbsentSubscriberSM, FacilityNotSupported, SystemFailure, UnexpectedDataValue, DataMissing. [29.002 12.1.3]
20. MUST use the SMSF address (SMSF 3GPP/Non-3GPP Number) from the SRI response as MT target; MAY retry via the other one on failure. [29.002 12.1.4; 23.502 4.13.3.6 step 1-3, 4.13.3.9]
21. MUST send MT-ForwardSM with SM-RP-DA = IMSI (from SRI response), SM-RP-OA = SC address, SM-RP-UI = SMS-DELIVER. [29.002 12.9.3]
22. MUST build SMS-DELIVER with TP-MTI=00, TP-MMS (0=more, 1=no more), TP-RP, TP-OA, TP-PID, TP-DCS, TP-SCTS, TP-UDL. [23.040 9.2.2.1]
23. MUST make TP-SCTS unique per destination (bump by minimal amount within same second). [23.040 6.2 (1)]
24. MUST have at most one outstanding SMS-DELIVER per destination. [23.040 6.2 (2)]
25. SHOULD set More-Messages-To-Send consistent with TP-MMS when more SMs are queued. [29.002 12.9.3; 23.040 9.2.3.2]
26. MUST accept MT-ForwardSM errors: UnidentifiedSubscriber, AbsentSubscriberSM (+diag 0..13), SubscriberBusyForMT-SMS, FacilityNotSupported, IllegalSubscriber, IllegalEquipment, SystemFailure, SM-DeliveryFailure (memoryCapacityExceeded/equipmentProtocolError/equipmentNotSM-Equipped), UnexpectedDataValue, DataMissing. [29.002 12.9.3]
27. MUST accept and store an SMS-DELIVER-REPORT in SM-RP-UI (ack) or diagnosticInfo (error). [23.040 3.3.2, 9.2.2.1a]
28. MUST classify failures temporary vs permanent per Table 1 (keep/retry T, drop P). [23.040 3.3, Table 1]
29. MUST send ReportSM-DeliveryStatus (MSISDN, SC address, SM-DeliveryOutcome) on absentSubscriber(1) or memoryCapacityExceeded(0) for non single-shot SMs, with Absent Subscriber Diagnostic SM when known. [29.002 12.3; 23.040 8.1.1]
30. SHOULD send ReportSM-DeliveryStatus successfulTransfer(2) after a successful delivery so the UDM can alert other SCs in MWD (GMSC step; required where MCEF set/MWD non-empty). [23.040 8.1.1, 3.2.6 2g; 29.002 12.3]
31. MUST handle RSDS errors UnknownSubscriber, MessageWaitingListFull (-> fall back to periodic retry), UnexpectedDataValue, DataMissing. [29.002 12.3.3; 23.040 3.2.8]
32. MUST NOT add to MWD for single-shot SMs (set Single Attempt Delivery). [29.002 12.1.3, 12.3.3; 23.040 9.2.3.12.3]
33. MUST accept Alert-Service-Centre (MSIsdn-Alert, SC address; optional IMSI, Max UE Availability Time), return empty result, errors limited to SystemFailure/UnexpectedDataValue/DataMissing. [29.002 12.5]
34. SHOULD start delivery of queued SMs for MSIsdn-Alert on Alert-SC. [23.040 3.2.7]
35. SHOULD use MSIsdn-Alert returned in RSDS/InformSC to correlate a later Alert-SC. [23.040 3.2.6 1f; 29.002 12.3.3, 12.6]
36. SHOULD stop and discard the SM at VP expiry. [23.040 3.2.1, 6.1]

### Status report
37. MUST, when supported and TP-SRR=1, send SMS-STATUS-REPORT (MTI=10, SRQ=0) once SM status is final (or SC still trying), with TP-MR = original TP-MR, TP-RA = original TP-DA, TP-SCTS = original SC timestamp, TP-DT, TP-ST. [23.040 3.2.9, 9.2.2.3, 9.2.3.6]
38. MUST use TP-ST 0x00 on successful delivery, 0x46 on validity expiry, and 0x2x / 0x4x / 0x6x for temporary-trying / permanent / temporary-stopped. [23.040 9.2.3.15]
39. MUST deliver the status report like an SMS-DELIVER (SRI-for-SM with SM-RP-MTI=1, MT-Forward, alerting). [23.040 3.2.9; 29.002 12.1.3, 17.7.6]

### Interfaces (for the HTTP/JSON simulation)
40. SHOULD use MAP parameter/error names and numeric codes from this file in JSON, with the SGd/S6c Diameter result codes as optional alias. [29.002 17.6.6; 29.338 7.3]
41. MUST treat the SMSF as MSC/VLR and the UDM as HLR for all 23.040 procedures. [23.040 Annex K.1]
