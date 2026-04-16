# ADR-004: Temporal Workflow Adoption — SUPERSEDED / REJECTED

**Status:** SUPERSEDED by current reality (2026-04-16 — retrodocumented during W1 audit)
**Original intent:** Accepted (date unknown; file was 0 bytes until W1 audit)

## Why this ADR was superseded

W1 Part A audit (`docs/reviews/_audit/2026-04-W16-adr-drift-matrix.md`) flagged ADR-004 as a **phantom ADR**: "Accepted" status but zero implementation evidence. No `@temporalio` dependencies in `package.json`, no Temporal worker processes in any service, no `TemporalModule` or `WorkflowClient` imports anywhere. Accepting an ADR for infrastructure adoption that was never implemented corrupts every downstream knowledge pass.

This marker supersedes the phantom decision.

## Current reality (workflow orchestration)

- **Saga pattern** via `@nestjs/cqrs` 11 `ICommand` + saga decorators for cross-command orchestration (e.g., tenant-provisioning in auth-service).
- **NATS JetStream durable consumers** for at-least-once delivery + transactional outbox pattern (`platform/libs/outbox`) for atomic DB-write + event-publish.
- **Nx task orchestrator** for build-time/deploy-time fan-out (not runtime workflow).
- **Manual compensation handlers** for multi-step rollback (see provision-tenant skill — BLOCKER-14 calls out saga + advisory-lock compensation).

These three cover current workflow needs (multi-step tenant provisioning, GDPR erasure cascade, billing saga against Stripe). Temporal was never needed.

## If Temporal adoption is reopened

Open a new ADR (017+) with:
- Specific workflow not covered by sagas + durable NATS.
- Comparison vs current stack — operational overhead (cluster, version compatibility).
- Migration path for existing saga-based workflows.

## References

- `/var/aqua-saas/docs/reviews/_audit/2026-04-W16-adr-drift-matrix.md` — ADR-004-TIER4-CRITICAL
- `/root/.claude/plans/declarative-riding-shamir.md` BLOCKER-18
- `/var/aqua-saas/platform/libs/outbox/` — current approach
