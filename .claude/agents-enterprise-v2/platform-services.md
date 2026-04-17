---
name: platform-services
description: DEPRECATED 2026-04-16 — agent split in Phase 11 of abstract-brewing-mochi plan into billing-expert, alert-engine-expert, observability-expert. Remaining services redistributed. See redirections below. This file preserved for historical orchestrator dispatch resolution.
model: opus
effort: max
---

# Platform-Services — DEPRECATED / ARCHIVED

**Status:** ARCHIVED 2026-04-16 as part of Phase 11 of `/root/.claude/plans/abstract-brewing-mochi.md`.

**Reason:** this agent sırtladığı 7 domain (billing + notification + config + event-store + observability + alert-engine + hydroponics) aynı uzmanlık seviyesinde karşılık bulamıyordu. Billing precision + event-store polymorphic jsonb + alert-engine rule DSL + Prometheus cardinality discipline — 4 farklı uzmanlık. Tek agent'ta sıkıştırmak domain-expertise drift'ine neden oluyordu.

## Split destination map

| Domain | New primary agent | Rationale |
|---|---|---|
| `apps/billing-service/**` | **billing-expert** | Stripe webhook + metered billing + subscription saga — 3 deep sub-disciplines |
| `apps/alert-engine/**` | **alert-engine-expert** | Rule DSL + escalation + life-safety thresholds — safety-adjacent discipline |
| `apps/observability-service/**` + `infrastructure/monitoring/**` + cross-service metric/span/log discipline | **observability-expert** | Cardinality + OTEL coverage + Loki hygiene — cross-cutting by nature |
| `apps/event-store-service/**` | **data-expert** | Event ledger + polymorphic jsonb + projection checkpoint — persistence discipline |
| `apps/config-service/**` | **platform-kernel-expert** | Config is kernel concern; ADR-011 violation tracked there (PLAT-CRITICAL-002) |
| `apps/notification-service/**` | **auth-security-expert** (default per plan UC-5, pending explicit user confirmation) | PII content handling + email/SMS template injection surface |
| `apps/hydroponics-service/**` + `web/modules/hydroponics-module/**` | **farm-expert** | Hydroponics is aquaculture-farm domain; formulas + nutrient calculations fit farm-expert |

## Invocation after deprecation

Orchestrator routing table updated 2026-04-16 to point every path above at the new primary. Invoking `Agent(platform-services, ...)` is a PROCESS HIGH finding — the orchestrator must reject this dispatch and redirect to the matching new agent per the map above.

For historical review cycles still referencing `docs/reviews/platform-services/` paths, the finding registry retains ownership history for traceability; new findings use the new agent's prefix (`BILLING-*`, `ALERT-*`, `OBS-*`, `DATA-*`, `PLAT-*`, `SEC-*`, `FARM-*`).

## Grace period + full removal

- 2026-04-16 — this deprecation commit (Phase 11 landing)
- 2026-05-16 — 30-day grace (same window as `.claude/agents.legacy/`)
- After 2026-05-16 — file may be deleted; routing table entry for `platform-services` is already removed.

## References

- `/root/.claude/plans/abstract-brewing-mochi.md#Phase-11` — split rationale and redistribution map
- `.claude/agents-enterprise-v2/billing-expert.md` (new primary)
- `.claude/agents-enterprise-v2/alert-engine-expert.md` (new primary)
- `.claude/agents-enterprise-v2/observability-expert.md` (new primary)
- `docs/reviews/platform-services/` — historical cycles (read-only)
