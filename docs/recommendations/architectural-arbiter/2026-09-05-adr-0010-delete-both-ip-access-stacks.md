# ADR-0010 — Delete Both IP Access-Rule Stacks; No Application-Layer IP Allow-Listing

**Status:** accepted
**Date:** 2026-09-05
**Resolves:** auth-security-expert#AUTH-002; tenant-isolation-auditor#ISO-014; list-visibility-auditor#LIST-005; form-write-auditor#FORM-015, #FORM-028; button-action-auditor#BTN-024; db-audit-platform-admin#DB-ADMIN-HIGH-012
**Finding reference:** docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#SEC-HIGH-060

## Context

`apps/gateway-api/src/guards/ip-whitelist.guard.ts` is referenced only by itself and its spec: registered in no module, no `APP_GUARD`, no `@UseGuards`. It fails open (`IP_WHITELIST_ENABLED` defaults false, `:87`, `:113-115`), is IPv4-only (`:331-335`), and its tenant whitelists are an in-memory Map with no writer. `admin.ip_access_rules` has no runtime enforcer; `checkIpAccess` is reachable only from a UI button; the FE sends no `tenantId`, so a rule lands NULL and applies to every tenant. The guard also sits on gateway-api, which is not on the admin-api path (ADR-0006).

Options: adopt one enforcement point (register the guard, fix IPv6, wire the Map to the DB, add tenant binding, convert to `inet`, add CHECKs, class DTOs, choose a fail mode) — or delete both.

## Decision

We delete both stacks: the gateway guard and its spec; the admin controller, service, entity, `admin.ip_access_rules`, `IpAccessRulesPage.tsx` and its client. If IP restriction becomes a product requirement, we express it in `infrastructure/nginx/droplet.conf` as `geo` / `allow` / `deny` under the existing config-review gate, where it is fail-closed and IPv6-correct on the real peer address.

Gate: `tests/invariants/no-dead-guards.spec.ts` — every class implementing `CanActivate` in `apps/**` and `libs/**` must be referenced by an `APP_GUARD` provider, a `@UseGuards()`, or an entry in `.claude/allowlists/unregistered-guards.yaml` carrying `{owner, expiry, reason}`.

## Consequences

- A security-control page disappears. The loss is a false claim, not a control; adopting would have meant building an untested access-control path from scratch on the most privileged surface.
- Any future IP restriction is an infrastructure change, reviewed as nginx config, not a database table with no reader.
- The generic gate also catches the next unregistered guard.

## Implementation note (landed 2026-09-05)

- Both stacks are gone as decided: `IpWhitelistGuard` + spec, `IpAccessController`, `IpAccessService`, the `IpAccessRule` entity, `IpAccessRulesPage.tsx`, its client functions and type, the `settings/integrations` route and both navigation entries that pointed at it. `admin.ip_access_rules` is archived into `admin.retired_config_backups` (jsonb, count-verified) and dropped by `1808800000000-RetireIpAccessRules.ts`; the table leaves `MODULE_SCHEMAS[].infrastructureTables`. The admin route contract shrinks by the twelve `settings/ip-access` routes.
- The gate is derived, not listed: `tests/invariants/no-dead-guards.spec.ts` scans every non-abstract `implements CanActivate` class in production source and accepts as registration an `APP_GUARD` provider (`useClass` / `useExisting` / a `useFactory` that constructs it), any `UseGuards(...)` call including `applyDecorators` bundles, a `globalGuards` / `useGlobalGuards` bootstrap list, or a registered guard that `extends` it. Test files are neither definers nor registration evidence.
- Its first run found six further guards that had never been wired. Each was checked against the code path it claimed to protect, and all six were deleted rather than allowlisted: messaging's `ChannelAuthorizationGuard`, `ChannelMemberGuard`, `MessageOwnerGuard` (membership and ownership are enforced inside every channel and message handler already), `MessagingFeatureGuard` (its "is messaging enabled" read was a hard-coded `true`), gateway's `PermissionGuard` with its decorators and `permission.helpers.ts` (no consumer; authorization lives in the subgraphs), and the kernel `IdorGuard` with `@IdorCheck` / `@SkipIdorCheck` (no consumer; tenant isolation is the scoped repository and search_path). `.claude/allowlists/unregistered-guards.yaml` therefore starts empty; a future entry needs `{owner, expiry, findingId, reason}` and expires.
