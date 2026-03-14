# ADR-008: Guard Strategy -- Defense in Depth

**Date:** 2026-03-14
**Status:** Accepted
**Deciders:** Platform Team

---

## Context

The admin-api-service secures all endpoints with `PlatformAdminGuard`. Two layers exist:

1. **Global guard**: Registered as `APP_GUARD` in `app.module.ts` (line 137). Applies to every route automatically.
2. **Explicit controller-level guard**: Every controller also has `@UseGuards(PlatformAdminGuard)` decorator applied directly.

This was established during Sprint 1 security hardening. All 31 controllers in admin-api-service now carry the explicit decorator. The global guard alone would be sufficient, but the explicit decorator serves as a safety net.

## Decision

**Defense-in-depth: both global and explicit guards are required.**

1. `APP_GUARD` in `app.module.ts` provides baseline protection -- no route is accidentally unprotected.
2. `@UseGuards(PlatformAdminGuard)` on each controller makes the security requirement visible at the controller level -- code reviewers can verify intent without checking app.module.
3. If either layer is accidentally removed, the other still protects.

## Consequences

**Positive:**
- Zero chance of an unprotected controller -- global guard catches everything
- Security intent is self-documenting at the controller level
- Passing the explicit guard is a PR review checklist item

**Negative:**
- Slight boilerplate: every new controller must add `@UseGuards(PlatformAdminGuard)`
- Guard runs twice per request (negligible performance cost vs. security benefit)
