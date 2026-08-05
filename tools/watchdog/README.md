# Data-Flow Integrity Watchdog (W-A skeleton)

Probe layer for the platform's blackbox gap: Prometheus scrapes only
self-reported service metrics; nothing exercises the contracts between
services. Probes here emit `probe_*` metrics; `infrastructure/monitoring/
droplet/rules/60-dataflow-integrity.yml` thresholds them; sustained
CRITICALs are filed to the finding registry (owner_agent = the routed
Lane-B auditor) and ingested into ARIA via
`aria-kernel runtime signal ingest` (verbs added in this same change).

W-A ships rules on already-exported metrics plus this skeleton. W-B adds
the T1 probe set + hourly workflow. Design of record: plan
tranquil-sniffing-pancake §Faz 5 (domain matrix, tiers T0-T3, rollout).
