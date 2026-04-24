# Operations — `sens-api-gateway` v1.6.0

**Audience:** Plant-IT, shift operator, service-contract lawyer, Siemens vendor-assessment reviewer.

**Scope:** operational commitments (availability, MTBF, MTTR, RTO, RPO), observability envelope (metric cardinality, log volume, trace sampling), monitoring runbook, alert rule catalogue, support tier matrix, product lifecycle & end-of-life policy, incident response, capacity planning.

**Source-of-truth date:** 2026-04-24 (HEAD `3413db47`, release tag `v1.6.0`).

---

## Chapter index

| File | Purpose | Primary reader |
|------|---------|----------------|
| [`sla.md`](./sla.md) | Availability targets per commitment tier, MTBF / MTTR / RTO / RPO, SLA-credit template | Service-contract lawyer, procurement |
| [`observability.md`](./observability.md) | Metric cardinality budget, log volume SLO, trace sampling, retention, cost attribution | SRE, Plant-IT |
| [`monitoring-runbook.md`](./monitoring-runbook.md) | What to watch per edge device, green/yellow/red thresholds, response pattern | NOC, shift operator |
| [`alert-catalogue.md`](./alert-catalogue.md) | All alert rules with PromQL, severity, runbook URL, on-call target (DESIGN — wiring pending) | SRE, on-call |
| [`support-tiers.md`](./support-tiers.md) | Bronze / Silver / Gold / Platinum matrix — response time, hours, channels, updates (pricing `{TEMPLATE}`) | Procurement, customer-success |
| [`lifecycle-eol.md`](./lifecycle-eol.md) | LTS rule, active / security-only / EOL bands, 18-month deprecation notice, migration template | Plant-IT, planning |
| [`incident-response.md`](./incident-response.md) | SEV-1 to SEV-4 classification, incident-commander flow, PSIRT / CVD intake, postmortem template | SOC, PSIRT, on-call |
| [`capacity-planning.md`](./capacity-planning.md) | Sizing guidance per site profile (small farm / medium / large / process plant) | Pre-sales engineer |

---

## Reading order by role

- **Procurement / contract review:** `sla.md` → `support-tiers.md` → `lifecycle-eol.md`.
- **SRE / Plant-IT onboarding:** `observability.md` → `monitoring-runbook.md` → `alert-catalogue.md` → `incident-response.md`.
- **Pre-sales engineer sizing a site:** `capacity-planning.md` → `sla.md`.
- **Security responder after a disclosure:** `incident-response.md` → `../security/` chapters.

---

## Evidence discipline

Every quantitative claim in this tree is one of:

1. **Measured** — cites a date, method, and artefact (e.g. soak test run reference, Grafana dashboard export).
2. **Targeted** — carries an explicit `target X, pending program Qn` label and an owner. Example: MTBF is a target, not a measured number; the measurement program starts Q3 2026.

Claims without one of the two are a review defect.

---

## Cross-references

- Performance envelope (per-sensor tag rate, end-to-end latency): `../architecture/performance-envelope.md`.
- Deployment, provisioning, OTA, backup/restore, DR: `../deployment/`.
- Threat model, crypto inventory, CVD policy: `../security/`.
- Test evidence (soak, HIL, EMC): `../testing/`.
- Lane-A SaaS-side observability authority (metrics / logs / traces stack): `@.claude/agents/observability-expert.md`. This chapter consumes that policy and does not diverge.

---

## Known gaps (open)

- **Alert rule wiring** — the 13 alert rules in [`alert-catalogue.md`](./alert-catalogue.md) are DESIGN. No `prometheus.rules.yaml` ships in `sens-api-gateway/` today (tracked under ORPHAN-EDGE-007 / ORPHAN-EDGE-008). Owner: SRE lead. Deadline: v1.7.0.
- **MTBF measurement program** — `src/telemetry.rs` publishes uptime + resource metrics, but no long-window MTBF aggregation exists. Target program start: Q3 2026.
- **Tenant-scoped cost attribution** — per-tenant labels are not uniformly applied to edge metrics / logs / traces today. Owner: observability-expert + edge-docs-orchestrator joint.

Each gap is mirrored in the relevant chapter with the same owner and deadline.
