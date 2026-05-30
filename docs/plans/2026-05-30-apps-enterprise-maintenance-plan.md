# Apps Enterprise Maintenance Plan

**Date:** 2026-05-30  
**Branch:** `maintanance`  
**Workspace:** `/var/aqua-saas/.codex-worktrees/maintanance`  
**Scope:** `apps/*` backend applications, plus shared boundaries required to verify app ownership.

## Purpose

This plan defines how to maintain the `apps/` services in logical bottom-up order with enterprise-grade architecture as the standard. The goal is to remove systemic SSOT drift, tenant-boundary ambiguity, best-effort critical paths, security gaps, performance risks, and stale deploy/runtime assumptions without applying narrow patches that hide the underlying design issue.

The output of this phase is a durable docs baseline: one main plan plus four agent review reports. Implementation packages must be derived from this baseline and must close the architecture boundary, not only the immediate symptom.

## Non-Negotiable Remediation Standard

A finding is not resolved by:

- swallowing errors with `try/catch`, warning logs, or best-effort fallbacks;
- disabling tests, lint rules, schema gates, RLS, throttles, or migration checks;
- adding an env bypass without an audited owner, TTL, and production runbook;
- writing directly to another service's owned schema or table;
- duplicating SSOT data without an explicit read model, owner, sync contract, and reconciliation test;
- accepting "works locally" without deployment, tenant, and failure-mode evidence.

A finding is resolved only when the implementation proves:

- the owning service and schema are explicit;
- all cross-service writes use a typed contract;
- tenant context is explicit for HTTP, GraphQL, NATS, cron, MQTT, sidecar, and batch paths;
- critical events are durable, replayable, and idempotent;
- security controls fail closed in production;
- tests and gates prevent the same regression.

## Four-Agent Review Model

The review is split into four independent slices so each agent can inspect a coherent ownership layer.

| Agent slice              | Apps                                                                                  | Primary questions                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation               | `db-migrate`, `event-store-service`, `config-service`, `observability-service`        | Is production DDL owned by one writer? Are schema gates, release ledger, config system tenant, event store ordering, and observability least privilege correct? |
| Trust + communication    | `auth-service`, `messaging-service`, `notification-service`                           | Does auth own identity/PII/action-token contracts? Are messaging memberships, GDPR, notification delivery, NATS subjects, and PII retention contract-safe?      |
| Domain                   | `sensor-service`, `farm-service`, `alert-engine`, `hydroponics-service`, `ai-service` | Are data-plane SSOT, tenant routing, outbox/event reliability, subgraph controls, AI cost controls, and domain authorization enterprise-grade?                  |
| Business + control plane | `billing-service`, `hr-service`, `admin-api-service`, `gateway-api`                   | Are financial/HR/admin writes routed through the owner? Are roles, throttles, idempotency, decimals, and gateway/subgraph exposure safe?                        |

Detailed reports:

- `docs/reviews/apps-maintenance/2026-05-30-foundation.md`
- `docs/reviews/apps-maintenance/2026-05-30-trust-communication.md`
- `docs/reviews/apps-maintenance/2026-05-30-domain.md`
- `docs/reviews/apps-maintenance/2026-05-30-business-control-plane.md`

## Recommended Review Order

1. **Foundation layer**
   - `db-migrate`
   - `event-store-service`
   - `config-service`
   - `observability-service`

2. **Trust and identity layer**
   - `auth-service`
   - `messaging-service`
   - `notification-service`

3. **Core domain layer**
   - `sensor-service`
   - `farm-service`
   - `alert-engine`
   - `hydroponics-service`
   - `ai-service`

4. **Business and control-plane layer**
   - `billing-service`
   - `hr-service`
   - `admin-api-service`
   - `gateway-api`

This order is load-bearing. Lower layers define schema authority, release truth, identity, tenant, and event contracts. Upper services must not be remediated first if doing so would only mask a broken lower-layer ownership boundary.

## Initial Architecture Findings

| Priority | Area          | Enterprise issue                                                                                                                  | First remediation package                                  |
| -------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| P0       | Foundation    | `observability-service` is not gated by the authoritative migration ledger; runtime DDL still exists in config/event-store paths. | Migration authority and schema-gate package.               |
| P0       | Event store   | Append path calls a sequence not created by baseline migration; tenant uniqueness/projection keys are inconsistent.               | Event-store correctness and tenant isolation package.      |
| P0       | Trust         | Notification expects auth internal delivery routes that auth does not expose; messaging GDPR calls an undefined auth subject.     | Auth internal contract and GDPR command package.           |
| P0       | Domain        | Sensor metadata/metrics tenant SSOT is split between source schema, tenant schemas, and ingestion paths.                          | Sensor data-plane SSOT package.                            |
| P0       | Control plane | Admin directly writes billing/auth-owned data despite declaring read-only cross-schema posture.                                   | Admin-to-owner command delegation package.                 |
| P1       | Events        | Farm and alert critical events still publish best-effort after writes.                                                            | Transactional outbox and idempotent consumer package.      |
| P1       | Billing       | Billing admin NATS handler bypasses CQRS; renewal/payment paths lack strong idempotency/decimal guarantees.                       | Financial correctness package.                             |
| P1       | HR            | HR performance and employee mutation APIs have broad tenant-level IDOR/over-permission risks.                                     | HR authorization model package.                            |
| P1       | Subgraphs     | AI and other subgraph exposure controls are inconsistent.                                                                         | Service-identity, SDL, throttle, depth/complexity package. |
| P2       | Docs/deploy   | Compose, runbooks, READMEs, and required-signal docs are stale in several foundation paths.                                       | Deploy parity and documentation gate package.              |

## Candidate Remediation Already Present

The branch currently contains an early candidate change in `apps/db-migrate`:

- `apps/db-migrate/src/main.ts`
- `apps/db-migrate/src/cli-args.ts`
- `apps/db-migrate/src/__tests__/cli-args.spec.ts`

Intent: wire the documented `aqua-db-migrate --down N --schema <name>` rollback path to the real entrypoint and harden CLI parsing.

Status: **candidate remediation only**. It is not considered resolved until it is reviewed against the same enterprise criteria: release-ledger semantics, operator safety, tenant-aware rollback boundaries, docs/runbook parity, tests, and deploy evidence.

## Implementation Packages

1. **Foundation authority package**
   - Make `db-migrate` the only production DDL writer.
   - Add/verify schema gates for all long-running services, including observability.
   - Move runtime RLS/audit-column DDL into migrations or `db-migrate` hardening hooks.
   - Add a static guard that fails if an app in authoritative mode registers runtime DDL bootstrap without an explicit exception.

2. **Identity and communication contract package**
   - Define auth-owned internal contracts for PII lookup, tenant info, action-token URL resolution, password verification, and user validation.
   - Normalize NATS subjects through shared constants/helpers.
   - Enforce `UserDeleted` schema parity and GDPR cascade requirements.
   - Prove notification and messaging paths fail closed when auth contracts are unavailable.

3. **Tenant and data-plane SSOT package**
   - Decide and document sensor metadata/Timescale ownership: central source-schema read model or per-tenant replicated model.
   - Align ingestion, sidecar, GraphQL, migrations, metadata cache, and profile defaults to that decision.
   - Add explicit tenant loops/search-path handling for background jobs.

4. **Durable events package**
   - Convert critical farm, alert, and financial state changes to transactional outbox or equivalent durable event emission.
   - Define idempotency keys, replay owner, DLQ behavior, and retry semantics per event.
   - Add a gate that blocks save-then-best-effort-publish patterns on critical domains.

5. **Business correctness package**
   - Move admin direct writes to billing/auth behind owner-service commands.
   - Replace raw billing admin mutations with CQRS command handlers and transaction/audit/event semantics.
   - Standardize money as decimal-safe values and enforce idempotency for renewal/payment paths.
   - Normalize role/permission taxonomy across gateway, admin, billing, and HR.

6. **Control-plane security package**
   - Harden HR self/team/admin authorization at resolver and handler levels.
   - Add global/service throttling where decorators already imply limits.
   - Add subgraph service identity and deterministic SDL artifact paths.
   - Document network assumptions for introspection and composition-only access.

7. **Docs and deploy parity package**
   - Refresh READMEs for apps that are empty or stale.
   - Align compose env names, required signals, runbooks, and service presence.
   - Add a docs gate or checklist requiring every app review to state owner, schema, runtime mode, health, and deploy prerequisites.

## Test And Gate Plan

- Per package, run targeted `nx test`, `nx build`, and lint for touched projects.
- Add invariant tests for:
  - schema-gated production boot;
  - no runtime DDL in authoritative mode;
  - cross-service write ownership;
  - event contract shape and NATS subject parity;
  - tenant-scoped background workers;
  - no direct best-effort critical event publish after durable state writes;
  - no PII in JWTs/events/logs outside approved contracts;
  - billing decimal/idempotency behavior;
  - HR self/team/admin access matrices.
- Do not close a finding without at least one negative test proving the old failure is rejected.

## Worktree And Branch Notes

- Worktree: `/var/aqua-saas/.codex-worktrees/maintanance`
- Branch: `maintanance`
- Base: `origin/main`
- Existing uncommitted candidate code edits are intentionally preserved and documented above.
