# Admin Panels Enterprise — PR #962 Re-derivation (2026-09-04)

Re-derivation of `origin/claude/frontend-admin-panels-enterprise-ygyy5l` (PR #962, closed unmerged
2026-08-28 as "rotted beyond merge": 21 commits, 170 files, 756 commits behind `main`) onto the
integration head `claude/branch-evaluation-merge-s5grgw` (81a7286dd).

The findings of record are in
[`2026-07-12-admin-panels-enterprise.md`](./2026-07-12-admin-panels-enterprise.md), imported with
six ids renumbered (see that document's ID-collision note). This document records what the
re-derivation LANDED, what it deliberately did NOT land, and who owns the remainder.

## Landed

| Finding                                            | Commit subject                                                                                    | Notes                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| ADMIN-HIGH-014, ADMIN-HIGH-015                     | `security(auth): make tenant MFA enforcement and session timeout real, at the mint chokepoint`    | ADR-046. Storage, enrollment gate, TTL clamp at the single mint chokepoint, revocation-on-flip. |
| ADMIN-HIGH-010, ADMIN-LOW-027                      | `feat(web): give the tenant admin a way to turn MFA enforcement on, and the user a way to comply` | tenant-admin Security screen + shell `MfaSetupScreen`.                                          |
| ADMIN-HIGH-012, ADMIN-MEDIUM-016                   | `feat(tenant-admin): give deactivation a return leg, and role assignment a batch`                 | Activate / Unlock / effective permissions / bulk role assignment.                               |
| ADMIN-HIGH-009                                     | `feat(messaging): make the two honest 501s answer with real cross-tenant aggregates`              | `MonitoringStatsService` + the two NATS patterns + both admin pages.                            |
| ADMIN-HIGH-008, ADMIN-MEDIUM-023, ADMIN-MEDIUM-024 | `feat(admin-panel): fill in the billing dashboard's five null metrics and its placeholder charts` | `GET /billing/payments/stats`, AreaChart, LineCharts, shared MetricCard.                        |
| ADMIN-MEDIUM-022, ADMIN-MEDIUM-018                 | `feat(shared-ui): make toasts actually reach the screen, from any remote`                         | `ToastProvider`, `Avatar`, parametrizable Table/ConfirmModal labels.                            |
| ADMIN-HIGH-020                                     | `security(tenant-admin): put the tenant back in two cache keys that lost it`                      | Split out of ADMIN-MEDIUM-028 — see below.                                                      |

## Deliberately not landed, with owners

### ADMIN-MEDIUM-028 — the typed-transport half of CRIT-04

**State:** IN-PROGRESS. **Owner:** `admin-expert`. **Deadline:** 2026-10-05.

The finding bundles two different defects. The security half — two hooks caching under bare,
untenanted keys — is fixed and tracked separately as ADMIN-HIGH-020, because a cross-tenant
data-exposure hazard should not sit at MEDIUM behind an architecture-cleanup title.

What remains is the architecture deviation: `useTenantBilling`, `useTenantActivity`,
`useTenantAuditLog`, `useDevicePolling`, `useAiProviderSettings` and `InstallerKeyModal` still reach
the transport through the deprecated untyped `graphqlRequest` escape hatch in
`services/tenant-api.service.ts` instead of the typed `lib/api.ts` SSoT.

**Closure criterion:** every one of those six call sites consumes a typed `lib/api.ts` function,
`graphqlRequest` is deleted (not deprecated — the untyped path must stop existing, tier 1), and
`tenant-api.service.ts` is a typed re-export only. `tenant-scoped-cache-keys.spec.ts` already guards
the key shape, so the remaining work cannot silently reintroduce the security half.

### ADMIN-MEDIUM-026 — English-only panel strings + the CI gate

**State:** IN-PROGRESS. **Owner:** `admin-expert`. **Deadline:** 2026-10-05.

PR #962 translated 12 files and added two CI invariants (`admin-panels-english-only.spec.ts`,
`admin-panel-contract-parity-tripwire.spec.ts`). Neither was ported. `main` has drifted since that
branch was cut: a codepoint-correct scan of both panels now finds **17** files carrying Turkish
characters, not 12, and the extra five are pages that did not exist when the branch was written.

Landing the invariant without first translating all 17 would make the gate red on arrival;
translating 17 files of user-visible strings, placeholders and aria-labels is a mechanical sweep
with real regression surface and no test coverage on the strings themselves, so it is not something
to smuggle into a re-derivation commit whose subject is about something else.

**Closure criterion:** all 17 files translated, `admin-panels-english-only.spec.ts` added and green
in the `invariants:fast` shard, and `ADMIN-LOW-009` (ASCII-transliterated Turkish, outside the
special-character gate's reach) either closed by the same sweep or re-scoped with fresh evidence.

### ADMIN-MEDIUM-021, ADMIN-LOW-025 — the admin-panel confirm/toast sweep

**State:** IN-PROGRESS. **Owner:** `admin-expert`. **Deadline:** 2026-10-05.

The `ToastProvider` these depend on now exists (ADMIN-MEDIUM-022), but the sweep itself — replacing
`window.confirm`/`alert` across nine admin-panel pages with `ConfirmModal` + toasts, and the
`AdminLayout` chrome cleanup — was not ported. It is a wide, mechanical UI change across pages this
cycle otherwise did not touch, and bundling it into the provider commit would have made that commit
unreviewable.

**Closure criterion:** no `window.confirm(` or `alert(` remains under `web/modules/admin-panel/src`,
every destructive action is gated by `ConfirmModal` with explicit English labels, and
`AdminLayout`'s decorative chrome (non-functional search, fake-unread bell, dead settings gear,
hardcoded `localhost:3008` docs link) is either functional or removed.

### ADMIN-HIGH-011, ADMIN-MEDIUM-019 — broken REST paths + contract-gate hardening

**State:** IN-PROGRESS. **Owner:** `admin-expert`. **Deadline:** 2026-10-05.

PR #962 repaired three reachable UI actions calling non-existent routes and rewrote the contract
extractor (per-call balanced-paren spans, per-`@Controller` prefix parsing, `matchPath`
static-vs-`:param` tightening, and a guard that fails on stale `KNOWN_EXCEPTIONS` entries).

`main`'s `contract-validation.spec.ts` has moved substantially since the fork — it now tracks 604
backend endpoints and carries its own exception set — so the branch's extractor rewrite cannot be
transplanted; it has to be re-derived against the current gate. This cycle only updated the
endpoint-count snapshot for the one route it added.

**Closure criterion:** the three live-path repairs land against main's current routes, the extractor
defects are re-fixed against main's version of the spec, and the stale-exception guard runs with an
empty allowlist.

### ADMIN-HIGH-013 — admin-api baseline-red suites

**Already resolved on `main`; nothing to port.** The four suites PR #962 repaired (41 failing tests)
are green on the integration head: admin-api-service runs 57 suites / 931 tests with 0 failures. In
particular the `mergePermissions` production defect the branch fixed is moot — `main`'s ADR-042
retired `shared.user_permissions` and deleted the code that contained it.

## Not ported for architectural reasons (not debt)

- **Tenant localization columns.** PR #962 added `timezone` and `date_format` columns to
  `auth.tenants` beside the security-policy columns. The `claude/farm-feeding-protocol-integration`
  branch — which merges next — makes tenant localization a real authority:
  `updateTenantLocalization` writes `auth.tenants.settings.localization` through the tenant
  command-receipt path (SERIALIZABLE receipt + a `TenantUpdated` outbox emission in the same
  transaction) and farm-service projects it for the feeding clock. Two timezone SSoTs on one row is
  the split-brain the ADR itself forbids, so the columns, their DTO/resolver surface and the
  branch's Localization screen were dropped from the port. ADR-046 records the exclusion.
- **`ADMIN-MEDIUM-004`/`-005` (tenant-admin → shared-ui primitive migration), `ADMIN-HIGH-016..019`,
  `ADMIN-LOW-001`/`-002`/`-004`/`-005`, `ADMIN-MEDIUM-008`/ `-014`/`-015`/`-017`.** These are the
  branch's dead-code removals, test-signal repairs and design-system migration. Several are already
  true on `main` (tenant-admin has an nx `test` target and 141 green tests; the admin-panel suite is
  green), and the rest are cleanup whose value does not justify re-deriving 170 files of drift. They
  stay registered against the 2026-07-12 document for a future cycle to pick up with fresh evidence.
- **The gateway alias-limit registration** for `setupMfa`/`verifyMfaSetup`. `main` has no
  `graphql-alias-limit.plugin.ts`; the plugin the branch edited does not exist here. Both mutations
  carry per-token `@RateLimit` decorators instead, which is where the velocity limit belongs now.

## Process notes

- `finding-registry rechain-from` cannot run from this base: it additionally asserts that the
  registry prefix equals `origin/main`'s registry byte-for-byte, and this integration branch
  legitimately carries rows `main` has not merged. The chain was re-seeded with the CLI's exact
  algorithm (same `canonicalJson`, same `prev_hash`/`content_hash` derivation) and
  `finding-registry verify` passes on every commit. The integrator restitches on merge.
- The `docs/plans/2026-06-18-enterprise-grade-debt-closure` manifest and
  `docs/aria/CURRENT_STATE.md` were deliberately NOT touched.
