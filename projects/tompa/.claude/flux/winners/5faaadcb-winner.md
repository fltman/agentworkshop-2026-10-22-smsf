# Winner: 5faaadcb α×β (status lights + canary SMS)

Problem: end-to-end health check across all five NFs from the group app.
Fitness: α×β 84 (β alone 80, α alone 68, γ 41)

Evidence, measured on smsf-hao's standalone core with all five NFs:
- Right after start-up, the AMF and NRF showed as warming, not faulty.
- After warm-up: green, and the canary passed (MO 200, MT RP-DATA delivered to UE2). A second canary within 30 s got 429.
- Both AMF instances failed through our fault switch. Before the fix, the canary blamed krilju (wrong). After it, the
  canary gives skip naming the tompa fault switch, and the summary is amber.
- 56 tompa tests pass, including tests for the α verdicts, the summary and the simulated-outage skip.

Crossover: α gives cheap per-NF lights with the NRF cross-check; β proves the chain carries an SMS and names the
failing hop. Neither alone tells "NF up, chain broken" from "NF down".

Genome: methodical 0.6, defensive 0.6, testing 0.6, analytical 0.5, api-design 0.5
