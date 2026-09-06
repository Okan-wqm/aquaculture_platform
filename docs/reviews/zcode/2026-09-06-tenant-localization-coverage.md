# Tenant localization settings coverage — second branch sweep, 2026-09-06

Reviewer: zcode. Cycle: `2026-09-05-branch-sweep`. Target: `origin/main` @ `f4b1c50c1`.

Recovered from `claude/frontend-admin-panels-enterprise-ygyy5l`. That branch is 1219 commits behind
main and adds seven files main does not have; main touched 103 of the 134 files they both changed
_after_ the branch last did. Six of the seven additions are rejected below. The seventh exposed a
real gap in main, but its own answer was written against a component main has since replaced, so
the fix is re-derived rather than merged.

## ADMIN-MEDIUM-095 — the screen that sets a tenant's feeding day had no test

**Severity:** MEDIUM. **Owner:** admin-expert. **State:** IN-PROGRESS.

**Evidence.** `web/modules/tenant-admin/src/components/settings/LocalizationSettings.tsx` is not a
display preference. Its own docblock records why it stopped being a "coming soon" banner: farm
jobs — day-plan generation, the morning sweep, stock coverage, the FCR alert and the daily summary —
run on the tenant's local day and take that boundary from the timezone saved here. `git log` shows
no spec has ever accompanied it; `web/modules/tenant-admin/src/components/settings/__tests__/`
held only `SecuritySettings.spec.tsx`.

The untested branch that matters most is the select's out-of-shortlist fallback. `TIMEZONE_OPTIONS`
is a 13-entry shortcut, not the accepted set — the server validates any IANA identifier. When the
saved zone is outside the shortlist the component emits an extra `<option>` for it. Remove that one
branch and `<select value="Pacific/Auckland">` has no matching option, so the DOM resolves the value
to the first entry, `UTC`, and the next save writes `UTC` over a zone the operator never touched.
The screen would show a plausible value while silently moving a whole tenant's feeding schedule.

**Rule violated.** A screen whose value drives backend scheduling is covered by a spec that fails
when the screen silently substitutes a different value.

**Fix.** `LocalizationSettings.spec.tsx` pins the three ways this screen can lie to an operator: a
saved zone outside the shortlist stays selected and round-trips untouched; "Not set" reaches the
server as `null` rather than `''`; and a rejected save renders the sanitized message instead of
"Saved!" without leaking the raw transport text. Two further cases pin the save payload and the
read-only rendering when `canEdit` is false. Verified in both directions — deleting the fallback
`<option>` fails the third case with `expected 'UTC' to be 'Pacific/Auckland'`, and the restored
component passes 5/5.

**Closure criterion.** The spec runs in tenant-admin's existing vitest project (jsdom, module-level
hook mock, same shape as its `SecuritySettings` sibling), so `nx affected --target=test` picks it up
with no config change.

## Why the branch's own six additions were not taken

- **`apps/auth-service/src/migrations/1807100000000-AddTenantSecurityLocalizationPolicy.ts`** adds
  `enforce_mfa`, `session_timeout_minutes`, `timezone` and `date_format` to `auth.tenants`. Main's
  `1819000000000-AddTenantAuthSecurityPolicy.ts` adds the first two only, and
  `tenant.entity.ts:260-292` states why the other two are absent: localization is written through
  the tenant command-receipt path into `settings.localization` and fanned out on `TenantUpdated`, so
  "a second timezone column on this row would be split-brain". Merging it would re-introduce the
  second writer main deliberately refused.
- **`apps/gateway-api/src/plugins/graphql-alias-limit.plugin.ts`** is superseded by
  `libs/backend-common/src/graphql/graphql-operation-limit.plugin.ts`, which additionally counts
  aliases as `selection.alias?.value ?? fieldName`, enforces amplification limits, carries its own
  spec, and is wired into both gateway-api and farm-service.
- **`docs/adr/045-tenant-auth-security-policy-ssot.md`** is the superseded draft of main's ADR-046,
  whose Numbering note names this branch as the origin of the earlier "ADR-042"/"ADR-045" attempts.
- **`tests/invariants/admin-panel-contract-parity-tripwire.spec.ts`** defers, in its own docblock, to
  `apps/admin-api-service/src/__tests__/contract-validation.spec.ts`, which already runs per PR
  alongside ten other `admin-*` invariants on main.
- **`tests/invariants/admin-panels-english-only.spec.ts`** enforces a decision main does not hold.
  1203 TypeScript sources under `web/`, `apps/`, `libs/` and `platform/` contain Turkish-specific
  letters, 20 of them inside the two admin panels; and `LocalizationSettings.tsx` ships a locale
  picker whose options are native language names (`Türkçe (tr)`, `Norsk bokmål (nb)`). The gate
  would be red on main on arrival, and one of its offenders would be a correct string.
- **`web/modules/tenant-admin/src/components/roles/DeleteRoleModal.tsx`** was deleted from main in
  `e12207cac`, "delete orphaned modal duplicates". Merging the branch would resurrect it.
