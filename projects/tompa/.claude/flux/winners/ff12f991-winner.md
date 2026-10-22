# Winner: ff12f991-β (twin AMF + fault switch)

Problem: second AMF instance so the SMSF can test AMF failover (krilju).
Fitness: 82 (α 60, γ 48)

Evidence:
- Delivered in PR 42. 51 tompa tests and 163 board tests pass.
- Instance 2 serves N1N2 under /amf2; instance 1 or 2 can be failed (mode 503 or down) on demand.
- Activation moves to the healthy instance; mode down issues a DELETE to the NRF; mode ok re-registers.
- A safety gene was required and met: every fault expires by itself (ttlS ≤ 900), and a simulated outage is tagged as ours, never as a peer fault.

Genome: methodical 0.6, defensive 0.5, testing 0.6, api-design 0.5, experimental 0.4
