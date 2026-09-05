# ADR-0015 — OpenAPI from Nest DTOs Is the Admin FE↔BE Contract; Class DTOs Are the Precondition

**Status:** accepted
**Date:** 2026-09-05
**Amends:** `docs/adr/009-frontend-data-fetch-pattern.md`
**Resolves:** contract-parity-enforcer#CONTRACT-001 … #CONTRACT-025; table-grid-auditor#GRID-009; list-visibility-auditor#LIST-001, #LIST-002, #LIST-007; data-readback-auditor#READ-001 … #READ-004; test-runner#TEST-003, #TEST-004; form-write-auditor#FORM-003; tenant-isolation-auditor#ISO-005
**Finding reference:** docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#CONTRACT-CRITICAL-003

## Context

Options: OpenAPI generated from Nest DTOs with FE codegen; a shared hand-maintained TS contract package; GraphQL like the rest of the platform.

`libs/backend-common/src/bootstrap/create-service-app.ts:852-874` already calls `SwaggerModule.createDocument` in non-production; `@ApiTags` is present on admin controllers; `swagger.spec.ts:71` exercises generation. admin-api has no GraphQL layer (34 controllers, 603 routes). The current gate (`apps/admin-api-service/src/__tests__/contract-validation.spec.ts`) compares URL strings only, treats `PUT ≡ PATCH`, matches `:param` against any literal, and suppresses 50 endpoints through `KNOWN_EXCEPTIONS` (`:399-811`) with no owner or expiry. It compares zero fields.

An `interface`-typed `@Body()` yields `design:paramtypes = Object`: `ValidationPipe` skips it and Swagger emits an empty schema. 29 such parameters exist. Generating from them would produce `{}` and a vacuously green gate.

Two envelope heuristics — `apps/admin-api-service/src/shared/response.interceptor.ts:47-65` and `web/modules/admin-panel/src/services/http-client.ts:342-349` — flatten differently; nine services return `{items,total}` the interceptor never lifts.

## Decision

We generate the admin contract from Nest DTOs. A new Nx target `admin-api-service:openapi` boots the app offline, calls the existing `SwaggerModule.createDocument`, and writes `apps/admin-api-service/openapi.json` as a committed artifact. `web/modules/admin-panel` runs `openapi-typescript` over it into `src/services/generated/`. `src/services/types/*` and every hand-written response interface are deleted.

Hard precondition: all 29 interface-typed `@Body()` parameters become classes with class-validator decorators before the artifact is trusted; DB CHECK / length / `inet` constraints land in the same change.

One paginated envelope: a single `Paginated<T>` in `libs/event-contracts`, returned by every list handler, serialised by one interceptor branch, generated into the FE; `totalPages` is required and server-computed. Enums (`AuditAction`, `AuditSeverity`, `TenantStatus`, `TenantPlan`, `ErrorStatus`, `TicketCategory`, `CustomPlanStatus`) live once in event-contracts; `AuditLogInput.action` becomes `AuditAction`.

GraphQL is rejected (transport rewrite on the most privileged surface while ADR-0006 is open). The shared hand-maintained package is rejected (same drift class, no generator, no gate).

Gates: `contract-validation.spec.ts` and `KNOWN_EXCEPTIONS` are deleted and replaced by `tests/invariants/admin-openapi-artifact-parity.spec.ts` (regenerate and assert byte-equality of the artifact and of the generated client) and `tests/invariants/admin-body-dto-is-class.spec.ts` (every `@Body()` / `@Query()` resolves to a class carrying at least one class-validator decorator).

## Consequences

- ~50 pages are re-typed by the compiler; the widest FE ripple in the set and the highest defect-closure count, because class DTOs re-arm `ValidationPipe` across billing, modules, settings, support and messaging in one change.
- A contract change that is not regenerated and committed fails the PR.
- The losing side: the URL-shape gate and its exception list, which hid drift instead of catching it.
