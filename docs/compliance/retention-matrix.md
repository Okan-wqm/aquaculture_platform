# Retention Matrix — Authoritative per-table retention policy

**Closes:** [COMPLIANCE-HIGH-007](../reviews/compliance-expert/2026-04-28-core-platform-review.md#COMPLIANCE-HIGH-007)

**Status:** AUTHORITATIVE STRUCTURE. The retention-days values
below are derived from [ADR-024](../adr/024-compliance-retention-matrix.md)
and the canonical TypeScript registry at
`libs/backend-common/src/database/retention/retention-policy.ts`.
The TypeScript registry is the runtime source of truth — this
markdown file is the human-readable mirror referenced by
KVKK / GDPR / SOC 2 audits.

When the two diverge, the canonical TypeScript registry wins; an
invariant test (planned per COMPLIANCE-HIGH-007 follow-on) will
ensure the markdown rows stay in lockstep with the registry.

---

## How retention durations are derived

| Source of truth | Authority |
|---|---|
| TypeScript registry — `RetentionPolicy.retentionDays` per service-owned `registerRetentionPolicy()` call | Runtime enforcement (ADR-024) |
| ADR-024 §3 floor table | Per-domain minimum |
| GDPR Art 5(1)(e) — storage limitation | Outer ceiling for personal data |
| KVKK Art 7 — destruction obligation | Outer ceiling for personal data |
| Sectoral statutes (İş Kanunu, VUK, Türk Ticaret Kanunu) | Floor for HR + financial domains |
| SOC 2 CC4.1 (audit-log integrity) | Floor for audit / change-management |

When sectoral floor (e.g. İş Kanunu 10y) is higher than GDPR
ceiling (5y), the floor wins. Each row's `legal_basis` column
documents which authority dominates.

---

## Retention table — by schema + table

| Schema | Table | Retention (days) | Years | Legal basis | Destruction method | Service owner |
|---|---|---|---|---|---|---|
| `auth` | `users` | 365 after account close | 1y | KVKK Art 7 + GDPR Art 17 | DELETE (cascade) | auth-service |
| `auth` | `sessions` | 90 | 90d | Operational + auth-security audit | DELETE | auth-service |
| `auth` | `refresh_tokens` | 30 | 30d | Operational | DELETE | auth-service |
| `auth` | `audit_logs` | 2557 | 7y | SOC 2 CC4.1 + KVKK Art 16 audit retention | Anonymise userId (preserve action), delete pre-cutoff | auth-service |
| `auth` | `mfa_secrets` | Tied to `users` lifecycle | — | Operational | DELETE on user-erase | auth-service |
| `auth` | `webauthn_credentials` | Tied to `users` lifecycle | — | Operational | DELETE on user-erase | auth-service |
| `auth` | `tenants` | 2557 (after suspension) | 7y | KVKK Art 16 audit retention + financial sector | Mark `deletedAt`, hard-delete after 7y | auth-service |
| `farm` | `farm_audit_logs` | 2557 | 7y | KVKK Art 16 + ISO 22000 traceability | Anonymise userId (preserve action), delete pre-cutoff | farm-service |
| `farm` | `batches` | 1825 (5y after harvest) | 5y | İSG + traceability obligations (Su Ürünleri Yönetmeliği) | DELETE | farm-service |
| `farm` | `harvest_records` | 1825 | 5y | Same as `batches` | DELETE | farm-service |
| `farm` | `feed_records` | 365 | 1y | İSG | DELETE | farm-service |
| `farm` | `water_quality_readings` | 1825 | 5y | İSG + Su Ürünleri yönetmeliği | DELETE (TimescaleDB chunk drop) | farm-service |
| `farm` | `tenant_erasure_audit` | Permanent | ∞ | GDPR Art 17 controller-side evidence | NEVER deleted (immutability trigger) | farm-service |
| `sensor` | `sensor_audit_logs` | 365 | 1y | Operational + tampering-detection | DELETE (TimescaleDB chunk drop) | sensor-service |
| `sensor` | `sensor_readings` | 1825 | 5y | İSG + Su Ürünleri yönetmeliği | DELETE (TimescaleDB chunk drop) | sensor-service |
| `sensor` | `calibration_records` | 1825 | 5y | İSG | DELETE | sensor-service |
| `hydroponics` | `grow_cycles` | 1825 | 5y | İSG | DELETE | hydroponics-service |
| `alert` | `alert_events` | 365 | 1y | Operational | DELETE | alert-engine |
| `alert` | `alert_rules` | Tied to tenant lifecycle | — | Configuration | DELETE on tenant-erase | alert-engine |
| `billing` | `invoices` | 3650 | 10y | VUK Art 253 + Türk Ticaret Kanunu Art 82 | NEVER deleted within retention; soft-delete after | billing-service |
| `billing` | `payments` | 3650 | 10y | Same as `invoices` | Same | billing-service |
| `billing` | `subscriptions` | 3650 (after cancellation) | 10y | Same as `invoices` (financial trail) | Mark `deletedAt`; preserve audit row | billing-service |
| `billing` | `stripe_webhook_events` | 90 | 90d | Operational dedup + Stripe SLA | DELETE | billing-service |
| `hr` | `personnel` | 3650 (after termination) | 10y | İş Kanunu Art 75 personnel-record retention | Mark `terminatedAt`, hard-delete after 10y | hr-service |
| `hr` | `payroll` | 3650 | 10y | İş Kanunu + VUK | DELETE post-cutoff | hr-service |
| `hr` | `leave_records` | 3650 | 10y | İş Kanunu Art 56 (yıllık izin defter) | DELETE post-cutoff | hr-service |
| `hr` | `shifts` | 1825 | 5y | İSG + İş Kanunu | DELETE | hr-service |
| `messaging` | `channels` | Tied to tenant lifecycle | — | Operational | DELETE on tenant-erase | messaging-service |
| `messaging` | `messages` | 365 | 1y | KVKK Art 5(2)(a) açık rıza tabanlı + storage-limitation | DELETE (legal-hold filter) | messaging-service |
| `messaging` | `compliance_audit_log` | 2557 | 7y | KVKK Art 16 + SOC 2 CC4.1 | Anonymise + retain (immutability trigger) | messaging-service |
| `admin` | `audit_logs` | 2557 | 7y | SOC 2 CC4.1 + cross-tenant admin review | Anonymise + retain | admin-api-service |
| `admin` | `impersonation_sessions` | 2557 | 7y | SOC 2 CC1 — SUPER_ADMIN access reconstruction | Anonymise + retain | admin-api-service |
| `notification` | `device_tokens` | Tied to user lifecycle + 30d after disable | — | Operational | DELETE | notification-service |
| `ai` | `conversations` | 365 | 1y | KVKK Art 5(2)(a) açık rıza | DELETE | ai-service |
| `ai` | `cost_records` | 1825 | 5y | VUK + financial trail | DELETE | ai-service |
| `event_store` | `events` | 1825 | 5y | Operational + replay-window | DELETE (chunk drop) | event-store-service |
| `shared` | `audit_logs` | 2557 | 7y | SOC 2 CC4.1 + KVKK Art 16 | Anonymise + retain (immutability triggers) | cross-service |
| `shared` | `access_logs` | 90 | 90d | Operational forensics | DELETE (TimescaleDB chunk drop) | cross-service |
| `shared` | `gdpr_data_requests` | 3650 | 10y | KVKK Art 16 evidence-of-rights-fulfilment | Anonymise userId post-cutoff | cross-service |
| `shared` | `user_consents` | 3650 | 10y | KVKK Art 5(2)(a) açık rıza demonstrability | Anonymise userId post-cutoff | cross-service |
| `admin` | `retired_config_backups` | Until superseding release verified | — | Operational (retirement archive: legacy config stores + retired `shared.user_permissions` rows, ADR-042) | DELETE after recovery window review | admin-api-service |

> `shared.user_permissions` retired 2026-07-12 (ADR-042, ORPHAN-HIGH-378):
> the dead parallel permission catalog was archived into
> `admin.retired_config_backups` and dropped; live RBAC state lives in
> `auth.tenant_role_permissions`.

---

## Cross-cutting rules

### Audit-log retention (7y floor)

Every `*audit_logs*` table sits at 7y minimum per SOC 2 CC4 +
KVKK Art 16. The floor is enforced by the `AUDITTRAIL-HIGH-001`
+ `-HIGH-007` cures (90d → 7y default migration on auth-service
+ farm-service) plus the `AUDIT_RETENTION_MIN_DAYS = 2557`
constant.

### Legal-hold suspension

A row whose `legalHold = true` is EXCLUDED from every retention
sweep regardless of the schedule above. The
`audit-retention-legal-hold-filter.spec.ts` invariant pins this
at every retention call site.

### Sectoral overrides

| Sector | Floor | Authority |
|---|---|---|
| Financial (billing) | 10y | VUK Art 253 + Türk Ticaret Kanunu Art 82 |
| HR / personnel | 10y | İş Kanunu Art 75 |
| Audit (cross-cutting) | 7y | SOC 2 CC4.1 + KVKK Art 16 |
| Aquaculture traceability | 5y | Su Ürünleri Yönetmeliği |

When two policies overlap on the same table (e.g.
`hr.payroll` is both HR and financial), the LONGER floor wins.

### Cross-border-transfer awareness

Cross-border transfer alters the retention answer ONLY when the
destination jurisdiction's law shortens the local floor (rare —
GDPR is more permissive on retention than KVKK in most cases,
not less). The current platform's transfers (Stripe US, DO DE)
do not shorten any local floor.

---

## How to add a new retention row

1. Land the new entity (`@Entity` declaration).
2. Land the per-service `registerRetentionPolicy({ id, retentionDays, ... })`
   call in the service's bootstrap module — the canonical
   TypeScript registry at
   `libs/backend-common/src/database/retention/retention-policy.ts`.
3. Add a row to this markdown table. The values must MATCH the
   TypeScript registration exactly (the planned invariant will
   trip on drift).
4. If the retention exceeds GDPR storage-limitation default
   (varies by purpose), the legal_basis column must cite the
   sectoral statute or contract that justifies the longer
   retention.
5. Update [`kvkk-veri-sorumlusu.md`](./kvkk-veri-sorumlusu.md)
   §6 if the new row introduces a NEW data category not in
   the existing inventory.

---

## Engineering-side commitments

- This file's STRUCTURE (column shape, schema-organisation,
  cross-cutting-rules section) is engineering-owned.
- Per-row VALUES are engineering-owned WITH legal review on
  any deviation from ADR-024 floors.
- The TypeScript registry (`retention-policy.ts`) is the
  authoritative runtime source. This markdown is the
  audit-readable mirror.
- Future: `tools/gates/retention-matrix-coverage.ts` (planned)
  will assert every `registerRetentionPolicy()` call has a
  matching row in this file (drift detector).

## Related documents

- [ADR-024](../adr/024-compliance-retention-matrix.md) — the
  enforcement architecture.
- [`kvkk-veri-sorumlusu.md`](./kvkk-veri-sorumlusu.md) — VERBİS
  declaration referencing this file as the per-table retention
  authority.
- [`consent-versions.md`](./consent-versions.md) — per-bump
  changelog of the consent-version constant.
- `libs/backend-common/src/database/retention/retention-policy.ts`
  — the TypeScript registry (canonical runtime source).
