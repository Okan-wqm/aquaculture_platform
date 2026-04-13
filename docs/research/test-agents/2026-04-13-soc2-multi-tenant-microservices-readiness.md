# SOC 2 Readiness Research -- Multi-Tenant Microservices SaaS

Date: 2026-04-13
Owner: test-agent prompt design support

## Purpose

This note grounds the `soc2-readiness-auditor` in checked repository evidence so the agent can review current-state control truth instead of repeating generic SOC 2 advice.

The platform architecture is a multi-tenant Nx monorepo with NestJS services under `apps/`, React and PWA surfaces under `web/`, shared security and tenant infrastructure under `libs/backend-common/`, and deployment assets under `.github/`, `infrastructure/`, and `infra/`.

## Key Repo Anchors by Control Family

### 1. Tenant isolation

- `libs/backend-common/src/guards/tenant.guard.ts`
  - regular users derive tenant only from verified JWT claims
  - `SUPER_ADMIN` cross-tenant access uses `X-Act-As-Tenant`
  - cross-tenant access is audit-logged and MFA-gated by code claim
- `libs/backend-common/src/database/tenant-connection-bootstrap.service.ts`
  - reasserts `search_path` on every connection checkout
  - explicitly documents split-brain risk from contaminated pooled connections
- `libs/backend-common/src/database/tenant-scoped-repository.ts`
  - forces tenant scoping on read and write operations
- `libs/backend-common/src/redis/tenant-redis.service.ts`
  - prefixes Redis keys with `tenant:{tenantId}:`

### 2. Privileged access and impersonation

- `apps/admin-api-service/src/guards/platform-admin.guard.ts`
  - admin JWT verification and role enforcement
- `apps/admin-api-service/src/impersonation/services/impersonation.service.ts`
  - reason, duration, permissions, and audit-oriented impersonation session handling
  - contains in-memory fallbacks that are weaker in multi-instance deployments
- `apps/admin-api-service/src/security/**`
  - compliance, monitoring, and activity logging surfaces

### 3. Service-to-service trust

- `libs/backend-common/src/guards/service-identity.guard.ts`
  - HMAC-signed service identity headers for subgraph access
  - production fail-fast when `INTERNAL_SERVICE_SECRET` is absent
- `libs/backend-common/src/nats/nats-connection.factory.ts`
  - strict TLS configuration rules and CA requirements
- `infrastructure/docker/nats/nats-tls-enabled.conf`
  - checked Docker production path still shows `verify: false`
  - this proves one-way TLS in that path, not mTLS

### 4. Secrets, encryption, and infra controls

- `infrastructure/terraform/modules/rds/main.tf`
  - generated password, KMS-backed encryption, Secrets Manager integration
- `infrastructure/terraform/modules/elasticache/**`
  - Secrets Manager patterns and rotation inputs
- `infrastructure/terraform/modules/networking/main.tf`
  - VPC Flow Logs present
- `infrastructure/kubernetes/**`
  - check for service accounts, pod security, and whether `NetworkPolicy` is actually present or absent in checked manifests

### 5. Entitlements and subscription-driven access

- `libs/event-contracts/src/{tenant-commands,tenant-events,billing-events}.ts`
- `web/modules/admin-panel/src/pages/TenantConfigurationPage.tsx`
- `web/modules/admin-panel/src/pages/system/FeatureTogglesPage.tsx`
- `web/modules/admin-panel/src/pages/SubscriptionManagementPage.tsx`
- `web/modules/tenant-admin/src/pages/TenantBillingPage.tsx`
- `apps/gateway-api/src/interceptors/tenant-context.interceptor.ts`

These anchors show subscription tier, module assignment, and feature-toggle surfaces, but the auditor must still verify whether enforcement is server-side and consistent.

### 6. Logging, monitoring, and change management

- `.github/workflows/security-trivy.yml`
- `.github/workflows/cd-production.yml`
- `.github/workflows/db-migration-check.yml`
- `apps/observability-service/**`
- `infrastructure/monitoring/prometheus/alerts/**`
- `docs/runbooks/**`

These prove that CI security scanning, migration validation, observability surfaces, and some runbook patterns exist, but they do not by themselves prove branch protection, approver separation, or live incident response effectiveness.

## Evidence Boundary Rules

The auditor must separate:

- checked technical enforcement
- checked documentation or roadmap intent
- human-process evidence not normally stored in source control

Examples:

- JIT access, quarterly access reviews, manager approvals, termination-within-24-hours, vendor reassessments, and tabletop exercises usually require external records. If those records are not checked in, the correct status is `HUMAN_EVIDENCE_REQUIRED`, `DOC_ONLY`, or `MISSING`.
- One-way TLS in a checked runtime path means mTLS is not current-state truth for that path, even if roadmap docs recommend mTLS later.
- Secrets Manager resources in Terraform prove platform capability, but application-level secret consumption still needs verification.

## Review Heuristics

- Prefer `CONTRADICTED` when a checked claim and a checked runtime artifact disagree.
- Prefer `PARTIAL` when architectural direction is real but the enforcement chain is incomplete.
- Prefer `HUMAN_EVIDENCE_REQUIRED` when the technical side looks plausible but auditor-grade proof must come from tickets, IAM exports, screenshots, or review records.
- Do not collapse admin, tenant, transport, and evidence issues into one generic security score. Report them separately.

## Recommended Control Domains for Every SOC 2 Review Cycle

1. Tenant isolation
2. Privileged access and impersonation
3. Module entitlement enforcement
4. Service-to-service trust and broker security
5. Secrets and certificate management
6. Logging, auditability, and monitoring
7. Change management and deployment controls
8. Incident response readiness
9. Human access lifecycle
10. Vendor risk plus elected Availability, Confidentiality, Processing Integrity, and Privacy criteria
