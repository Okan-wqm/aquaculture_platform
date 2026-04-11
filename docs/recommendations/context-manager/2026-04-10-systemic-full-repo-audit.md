# Context-Manager Systemic Pattern Analysis

**Date:** 2026-04-10  
**Cycle ID:** 2026-04-10  
**Scope:** Systemic patterns observed in the 2026-04-10 full-repo audit plus the 2026-04-09 tier-1 compaction

## Systemic-001 - Tenant isolation gaps span request, async, and client-storage boundaries
This pattern is now visible in multiple independent surfaces rather than a single service:
- `/var/aqua-saas/docs/reviews/auth-security-expert/2026-04-10-full-repo-audit.md` - gateway tenant resolution fails because the lookup provider is not registered.
- `/var/aqua-saas/docs/reviews/messaging-expert/2026-04-10-full-repo-audit.md` - conversation UUIDs are readable/writable across tenants and write paths drop `tenantId`.
- `/var/aqua-saas/docs/reviews/multi-tenant-saas-expert/2026-04-10-full-repo-audit.md` - tenant provisioning becomes `ACTIVE` before provisioning completes and quota state fails open.
- `/var/aqua-saas/docs/reviews/frontend-expert/2026-04-10-full-repo-audit.md` - AquaMobil offline cache keys are not tenant-prefixed.
- `/var/aqua-saas/docs/reviews/platform-kernel-expert/2026-04-10-full-repo-audit.md` - CQRS has no first-class request envelope for tenant/correlation metadata.
- `/var/aqua-saas/docs/reviews/data-expert/2026-04-10-full-repo-audit.md` - tenant identity drift appears in event contracts and entities.

Recommendation:
- Define tenant identity once at the platform kernel boundary and require it in request envelopes, async write paths, browser cache APIs, and entity schemas.
- Make missing tenant context a hard failure in production instead of a best-effort convention.
- Treat `tenantId` omission as a build-time or startup-time defect, not a runtime warning.

## Systemic-002 - Security-sensitive controls still fail open or fall back permissively
Independent occurrences:
- `/var/aqua-saas/docs/reviews/platform-kernel-expert/2026-04-10-full-repo-audit.md` - event-bus startup continues when NATS is unavailable.
- `/var/aqua-saas/docs/reviews/multi-tenant-saas-expert/2026-04-10-full-repo-audit.md` - AI quota counters and budgets fall back to in-memory state when Redis is missing.
- `/var/aqua-saas/docs/reviews/platform-services/2026-04-10-full-repo-audit.md` - webhook encryption derives a deterministic key when the required secret is absent.
- `/var/aqua-saas/docs/reviews/mcp-expert/2026-04-10-full-repo-audit.md` - degraded mode still advertises the full tool catalog.
- `/var/aqua-saas/docs/reviews/infra-expert/2026-04-10-full-repo-audit.md` - production deploys remain mutable because `latest` is still the runtime target, and image scanning does not cover the full release surface.
- `/var/aqua-saas/docs/reviews/security-reviewer/2026-04-10-full-repo-audit.md` - build/runtime supply-chain entry points still rely on mutable tags and unverified downloads.

Recommendation:
- Convert these controls to fail-closed behavior in production.
- Split optional degradation from required startup readiness so health checks and operator messaging are explicit.
- Remove deterministic security fallbacks from production code paths.

## Systemic-003 - Exactness/replayability is drifting in stateful business and control paths
Independent occurrences:
- `/var/aqua-saas/docs/reviews/platform-services/2026-04-10-full-repo-audit.md` - hydroponics nutrient math uses native `number`.
- `/var/aqua-saas/docs/reviews/sensor-expert/2026-04-10-full-repo-audit.md` - sensor pagination can trigger OFFSET DoS and installer output can contradict broker mode.
- `/var/aqua-saas/docs/reviews/database-reviewer/2026-04-10-full-repo-audit.md` - receipt uniqueness is partition-dependent.
- `/var/aqua-saas/docs/reviews/farm-expert/2026-04-10-full-repo-audit.md` - close-batch metadata is corrupted by positional argument ordering and capacity checks are bypassed.
- `/var/aqua-saas/docs/reviews/data-expert/2026-04-10-full-repo-audit.md` - restore target schema is ignored and event payloads are permanently sensitive.

Recommendation:
- Use exact numeric types and schema-enforced invariants for all control, audit, and financial calculations.
- Replace positional APIs with typed objects where metadata integrity matters.
- Prefer explicit identity and exact replay semantics over convenience defaults.
