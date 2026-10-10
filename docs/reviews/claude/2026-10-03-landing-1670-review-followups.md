# Review follow-ups from landing #1670 (2026-10-03)

Owner: okan. Raised while landing PR #1670 on `fix/land-farmsetup-fixes`; the code each finding cites
runs in production in the hand-built farm-service and farm-module images.

## SEC-HIGH-188

Severity: HIGH (security). Deadline: 2026-10-04.

`HarvestPlanService.completeHarvest` (#1670, 8b61d726a) issues one `CreateHarvestRecordCommand` per
stocked tank and passed `userRoles?.length ? userRoles : [Role.TENANT_ADMIN]`: a caller with no roles
moved stock with tenant-admin authority, and because MODULE_MANAGER+ bypasses
`SiteAuthorizationService.assertSiteAssignment`, the per-tank site check never ran for it. The
resolver re-derived the roles by filtering loose strings against the `Role` enum, so any role value
outside the enum produced an empty set that was then promoted. The service had no floor of its own.

Probe on ca9d9d4cb: `completeHarvest(..., roles [])` was not refused and issued
`CreateHarvestRecordCommand` with `userRoles ["TENANT_ADMIN"]`.

Fix: the resolver passes the verified `SiteScopeCaller` (roles validated as canonical `Role` values
by the JWT guard) unchanged; the service refuses, before any read, a caller whose roles do not reach
the `completeHarvestPlan` entry of the farm permission matrix through `roleHasPermission`, and
carries the caller's roles unchanged into every stock movement. A grep of `apps/farm-service/src`
finds no other fallback from no roles to a default role.

## FE-MEDIUM-310

Severity: MEDIUM. Deadline: 2026-10-09.

`SitesTab` "View Details" first navigated to `/sites/:id`, a route farm-module redirects back to the
list, and #1670 (c53d16b4a) pointed it at `handleEdit`, so viewing a site opened the edit form, a
write surface, even for users without `updateSite`. Fix: a read-only `SiteDetailsDrawer` that renders
the record the list already holds; editing stays behind the permission-gated edit button.

## FE-HIGH-311

Severity: HIGH. Deadline: 2026-10-09.

`useLocalConfirm` (#1670) exists because `useConfirm()` from shared-ui throws inside farm-module.
Measured cause: every federation vite config (shell and the 8 remotes) aliases
`@aquaculture/shared-ui` to an absolute path (`resolveSharedUiAlias` → `web/shared-ui/dist`). The
`@module-federation/vite` 1.20.8 build warns that the shared module "is aliased ... to
.../web/shared-ui/dist" and "will bypass Module Federation's sharing mechanism". Neither the
production bundles (shell, farm-module, tenant-admin) nor a fresh build contain a `loadShare` module
for shared-ui; farm-module's index chunk embeds its own shared-ui copy, including the
`ConfirmProvider bulunamadı` error text.

So every remote has its own shared-ui React contexts:

- `useConfirm()` reads the remote's `ConfirmContext`, finds no provider, and throws inside the click
  handler: the dead Delete buttons #1670 hit.
- `useToast()` falls back to per-component state, so a remote's toasts render only where the
  component mounts its own container.
- `useI18n()` falls back to English.

The production shell is also built from a tree that predates `ConfirmProvider` (aae401bc8,
2026-09-18), so the provider is missing there too.

This is not a bounded change. Sharing shared-ui for real moves every context boundary in the shell
and all 8 remotes at once, and the static `'1.0.0'` shared version lets a remote accept an older host
copy that lacks newer exports. The fix needs package resolution instead of the path alias, a shared
version that tracks the content, and a browser-level federation check in staging. Until it lands,
farm-module keeps `useLocalConfirm`, which renders shared-ui's `ConfirmModal` from the remote's own
tree.

## Farm review of PR #1736 (2026-10-10)

The farm review of the landing branch blocked on `completeHarvest`. Each item below was registered with
the allocator and is fixed on the same branch. The SEC-HIGH-188 authority check moved with the
completion logic into `CompleteHarvestPlanHandler`, and it behaves as before.

### FARM-HIGH-394

Severity: HIGH. Deadline: 2026-10-17.

`HarvestPlanService.completeHarvest` read the tank stock outside any transaction. It then dispatched one
`CreateHarvestRecordCommand` per tank, each in its own `runInTenantTransaction`, and saved the plan
COMPLETED last through the injected repository. Nothing locked the plan row. A failure on tank 2 left
tank 1 harvested and the plan IN_PROGRESS, so the retry harvested tank 1 again. Two concurrent submits
both saw IN_PROGRESS and both moved the stock.

Fix: `CompleteHarvestPlanCommand` and its handler run in one tenant transaction. The handler:

1. locks the plan row FOR UPDATE;
2. checks the plan status: IN_PROGRESS proceeds; COMPLETED with the same figures is an idempotent no-op;
   COMPLETED with other figures is a 409;
3. locks the batch row, then the tank-batch rows that hold the batch;
4. writes every tank through `HarvestRecordWriter`;
5. marks the plan COMPLETED.

`HarvestRecordWriter` is now the only code that writes a harvest. It was extracted from
`CreateHarvestRecordHandler` and takes the transaction's `EntityManager`, and the direct harvest uses it
too. The batch-closure chain still runs after the commit.
`complete-harvest-plan-atomicity.postgres.spec.ts` proves two cases against a real Postgres: a failure
on tank 2 rolls tank 1 back, and a concurrent double submit completes the plan and moves the stock only
once.

### FARM-HIGH-395

Severity: HIGH. Deadline: 2026-10-17.

The mutation took four bare scalars, and the ValidationPipe never sees bare scalars. The farm-module
modal initialised its form while no plan was selected, so it submitted a 0 g weight. Fix: a
`CompleteHarvestPlanInput` DTO with the same bounds as `CreateHarvestRecordInput`. The modal form is now
keyed by plan and pre-fills only positive estimates.

### FARM-HIGH-396

Severity: HIGH. Deadline: 2026-10-17.

Every harvest booked through a plan was recorded as quality class SUPERIOR (RPT-007). Each one also
carried a fabricated "Plan HP-…" customer delivery. Fix: `qualityClass` is a required input that the
operator picks in the modal, and plan completion passes no buyer, so it writes no delivery row.

### FARM-MEDIUM-397

Severity: MEDIUM. Deadline: 2026-10-17.

The split of the counted quantity across tanks was not bounded by the book stock, so a count above the
stock was refused on every retry. The farm has no fish count-variance ledger. A surplus over the total
book stock is therefore refused, and the error message gives both figures. Within the book stock the
split is proportional, using the largest-remainder method (`harvest-allocation.ts`).

### FARM-MEDIUM-398

Severity: MEDIUM. Deadline: 2026-10-17.

Three #1670 fixes had no test that would fail if the fix were reverted:

- the create-site quota now skips soft-deleted sites;
- the create-system and create-site inputs now have bounds;
- notification-service now mounts `VerifiedUserAssertionMiddleware`.

The `completeHarvestPlan` resolver comment also claimed that the JWT guard validates roles as canonical
`Role` values. Nothing does: the middleware checks only that the roles are strings. Fix: each fix now has
a test that pins it; notification-service is in the SEC-HIGH-156 invariant list; the comment describes
the real trust chain.

## Farm re-review of PR #1736 (2026-10-10)

The re-review confirmed the fixes above and found two new problems plus one LOW. All three are fixed on
the branch.

### FARM-HIGH-399

Severity: HIGH. Deadline: 2026-10-17.

A full plan completion across two or more tanks emits one `BatchHarvested` event per tank. Every event
but the last is non-final; the last is final. The final harvest closes the batch: `CloseBatchHandler`
sets CLOSED and `isActive=false`. `HarvestCompletedListener` then processed the non-final events. On a
non-final event it moved any status except HARVESTING to HARVESTING, through a read-modify-write. As a
result, an inactive batch showed HARVESTING, and the CLOSED guard no longer stopped a second close.

Fix: the batch lifecycle policy now owns the rule. `PARTIAL_HARVEST_SOURCE_STATUSES` in
`batch-lifecycle-policy.service.ts` lists the statuses a partial-harvest signal may move to HARVESTING:
QUARANTINE, ACTIVE, GROWING and PRE_HARVEST. A finished cycle never leaves its status. The listener
applies the rule as one conditional UPDATE (`status IN` that set), so it can no longer overwrite a
concurrent close. The Postgres spec runs a full two-tank completion through the real
`CloseBatchHandler` and the real listener. It asserts that the batch stays CLOSED and inactive, and
that a second close is refused.

### FARM-MEDIUM-400

Severity: MEDIUM. Deadline: 2026-10-17.

Plan completion locked tank-batch rows before tank rows. Direct harvest, mortality and cull lock
batch → tank → tank-batch. The handler comment claimed the opposite of what the code did. With another
batch on a shared tank, the two paths could deadlock.

Fix: completion now locks plan → batch → tanks → tank-batch rows, with tanks and tank-batch rows each in
tank-id order. The candidate tank set comes from an unlocked read, which is stable because the batch row
lock is already held. A two-connection Postgres spec holds a tank lock the way a mortality does. It
shows that while completion waits for that tank, the tank's tank-batch row is still free.

### LOW (no registry entry)

The idempotency check compared the resent figures with the stored `decimal(12,2)` and `decimal(10,2)`
columns. An identical resend with 3 decimals therefore got a 409. `actualBiomass` and `actualAvgWeight`
are now limited to 2 decimals (`@IsNumber({ maxDecimalPlaces: 2 })`), which matches the storage.
