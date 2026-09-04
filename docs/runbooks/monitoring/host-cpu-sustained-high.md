# Runbook — HostCpuSustainedHigh

**Alert:** `HostCpuSustainedHigh` (warning) · **Rule:**
`infrastructure/monitoring/droplet/rules/35-broker-jetstream.yml`

**Meaning.** Host CPU (node-exporter, non-idle across all cores) exceeded 70% for 10 minutes. The
locked 2K msg/s production envelope requires steady p95 CPU ≤ 70% — while this fires, the envelope
claim is void and tenant capacity activation is gated off.

**First actions:**

1. `docker stats --no-stream | sort -k3 -h | tail -8` — which containers own the CPU (compare
   against the compose manifest's 8.4 vCPU of limits on 4 physical cores — oversubscription is
   expected; sustained saturation is not).
2. Correlate with telemetry load: JetStream storage rate
   (`rate(nats_server_jetstream_total_storage_bytes[5m])`) and the ingestion rate. A 15K-style burst
   is expected to saturate briefly — sustained saturation at 2K steady is the violation.
3. Check for retry storms: `HighCpuUsage` on a single app plus redelivery metrics points at a
   backoff loop, not capacity.

**Likely causes:** genuine envelope overshoot (more tenants than the 2K budget), a retry/backoff
storm, or NATS/PG contention on the shared disk (check I/O wait within the CPU number).

**Escalation:** sustained at honest 2K load = the droplet resize branch from the plan (Task 0.5 gate
decision). Do not activate further tenant capacity until this is green for a full steady window.
