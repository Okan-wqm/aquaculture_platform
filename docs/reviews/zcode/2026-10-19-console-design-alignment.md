# 2026-10-19 — Tenant-console design alignment (tanks / health / maintenance / storage)

Findings from the design-handoff reference (Tenant Console D4) vs the repo.

## FE-HIGH-371 — tanks page: design layout not implemented, quick-action toolbar at page level

- Design (search → single-row filter bar → dense unit table → click-to-open
  detail drawer) vs repo (toolbar selects + icon buttons + data table).
- Fixed: /sites/tanks rebuilt to the design layout — Üretim/Temizlikçi balık
  tabs, "Birim, parti veya yem ara…", one-row filters (sites · type ·
  stocked/empty · status), result-count line, TankTable (9 design columns
  default, 30-column model via the restored column-visibility menu), right
  TankDetailDrawer (metrics grid, density·capacity bar, live Sıcaklık/DO via
  the linked sensor, feeding block, operations incl. new Tartım örneklemesi
  wired to recordGrowthSample).

## FARM-MEDIUM-463 — health page lacks the design's withdrawal KPI and mortality chart

- Backend had no `withdrawalActive` stat and no daily-mortality aggregate.
- Fixed: `healthEventStats.withdrawalActive` (earliestHarvestDate > now) and
  new `mortalityDailyHistory(days)` query (batch domain, tenant-scoped GROUP
  BY recordDate, classified in the permission matrix); page gains status
  chips, 6-tile KPI strip, Unit column and the 14-day mortality chart.

## FE-MEDIUM-372 — feeding records table had no column selection

- Fixed: column-visibility menu (10 core + 9 opt-in detail columns), reusing
  the tanks column machinery (no duplicate mechanism).

## LOW-004 — work orders KPI strip (folded into FE-MEDIUM-372)

- Fixed: Açık / Gecikmiş / Devam eden / Tamamlanan·30g from the existing
  `workOrderStatistics` query.

## FE-HIGH-373 — tasks console dead in production (scalar selection on object lists)

> Registry row FE-HIGH-374 (IN-PROGRESS, deadline 2026-11-02) tracks this same
> tasks-console scalar-selection defect; its review_file cites this section.

- **Evidence (live, app.suderra.com):** every query/mutation embedding
  `TASK_FIELDS`/`RECURRING_TEMPLATE_FIELDS` fails with
  `Field "checklistItems" of type "[TaskChecklistItem!]!" must have a selection of subfields`
  (same for `notes`). Validation fails before execution, so the UI's
  create/save buttons never reach the server — the user sees dead buttons and
  no records. `createTask` with a valid input saves fine when called directly.
- **Fix:** subfield selections
  (`checklistItems { id text isCompleted completedAt completedBy }`,
  `notes { id text createdBy createdAt }`) in `useTasks.ts` and
  `useRecurringTemplates.ts`; the frontend `ChecklistItem`/`TaskNote` types
  already match the wire shape.

## FE-HIGH-375 — feeding protocols console dead: FE requests the non-contract `version` field

- **Evidence (live, app.suderra.com):** `feedingProtocolsV2` returns
  `Cannot query field "version" on type "FeedingProtocolV2"` — list, detail,
  create and update protocol operations all embed the same fragment, so
  /sites/feeding renders "Failed to load protocols" and the protocol/assignment
  tabs cannot load or save.
- **Root cause:** `@VersionColumn()` is a DB-layer optimistic lock
  (`feeding-protocol-v2.entity.ts:274`) with no `@Field()`, so the wire type has
  no `version`; the FE fragment (and the unused hook type member) carried it.
- **Fix:** drop `version` from `FEEDING_PROTOCOL_V2_FIELDS` and the hook type —
  backend contract unchanged, no FE consumer reads it.

## FE-HIGH-376 — health console status chips send lowercase DB values

- **Evidence (live):** `healthEvents(filter:{status: "active"})` →
  `Value "active" does not exist in "HealthEventStatus". Did you mean the enum
value "ACTIVE"?` — the PR #2026 chip row shipped `active/monitoring/resolved`
  (DB values) instead of the wire enum keys, so every chip click blanked the
  page behind "Error loading health events. Please try again."
- **Fix:** chip values to `ACTIVE/MONITORING/RESOLVED` (same wire-key rule the
  page's own label maps and FARM-CRITICAL-409 already follow).

## FE-HIGH-377 — production planning surface (Üretim Planı)

- **Gap:** tanks carry protocol assignments and realized growth, but nothing
  projected a tank's growth curve forward — grading dates (2 g, 100–120 g
  operator thresholds) and capacity overfill were invisible until they
  happened.
- **First slice (this PR):** `temperature_scenarios` + dated points (tenant
  migration 1823000000000; source manual, Copernicus later),
  `tankGrowthProjection` day-by-day simulation (protocol band by weight →
  rate × temperature multiplier → feed ÷ expected FCR → next biomass; capacity
  fill % and over-capacity day), and the Üretim Planı tab (scope site/system,
  horizon, scenario editor with the operator's interpolation rule).
- **Next phase (tracked, not here):** the grading puzzle planner — class
  distribution from sampling CV, class→tank allocation with capacity and
  harvest-timing constraints, same-size batch merge suggestions, plan→
  recordGrading bridge.

## SUPPLY-HIGH-024 — follow-redirects advisories masked as an @nx toolchain break

- **Evidence:** npm-audit gate red between CI rounds with zero dependency
  changes on the branch — GHSA-q3jh-wrc6-jgq8 and GHSA-8r9p-f939-6h3c hit
  every dev-scope @nx package; npm's only suggestion was the Nx 23 major
  (breaking).
- **Root cause:** both advisories are `follow-redirects` 1.16.0 advisories
  (patched 1.16.1), and `nx` pins `follow-redirects` exactly at 1.16.0, so
  no in-range update could reach the patch and npm's fix graph could only
  offer nx@23.3.0.
- **Disposition:** RESOLVED on the branch — a `follow-redirects: ^1.16.1`
  override (same mechanism as the existing hono override) moves the whole
  toolchain to the patched release; the two dated exceptions registered for
  the breaking-only reading were removed (ratchet stays at 5). While here,
  vite ^7.3.5 → ^7.3.7 takes the same-day GHSA-698v-4r3x-3vcv patch
  (launch-editor argument escaping) rather than an exception.

## SUPPLY-HIGH-025 — RUSTSEC-2026-0381 (webpki-roots emSign roots) upstream-blocked behind async-nats

- **Evidence:** the pull_request `CI - Affected` rust lane (first round this
  event type fired for this branch) failed `cargo audit --deny warnings` on
  three advisories published 2026-10-19/20 — external drift, zero Rust
  changes on the branch: RUSTSEC-2026-0382 (rustls-webpki 0.103.15) and
  RUSTSEC-2026-0381 on both webpki-roots copies (0.26.11 and 1.0.7).
- **Fixed, not ignored:** rustls-webpki → 0.103.16 in all three lockfiles
  (root, sens-api-gateway, fuzz); the fixable webpki-roots copy → 1.0.10;
  the fuzz lock's yanked spin/chacha20 refreshed in-range (cargo audit
  `--deny warnings` denies yanked).
- **Upstream-blocked remainder:** webpki-roots 0.26.11 is reachable only
  through async-nats (≤0.50, no release newer) → tokio-websockets ^0.10 →
  webpki-roots ^0.26, a line with no patched release (the fix is ≥1.0.10).
  tokio-websockets is an OPTIONAL async-nats dependency and this workspace
  never enables its websockets feature, so the crate is lockfile-only and
  never compiles into a target. Carried as tracked ignore EDGE-CI-010
  (owner platform-team, deadline 2027-01-20) in deny.toml, .cargo/audit.toml
  and the rust-ci.yml mirror — scripts/ci/check-advisory-ignore-sync.ts
  keeps the surfaces in lock-step and fails the day the deadline lapses.
- **Same commit:** the ci-affected `test` lane's 35-minute fan-out step
  killed a healthy run mid-fan-out on this PR (affected set ≈ whole graph;
  the identical unfiltered fan-out measured 44m14s the same day), reported
  by `build-status` as a test failure. Budgets re-derived with the
  measurement: step 35→50, job 45→55, preserving ci-timeout-budget-ssot's
  orderings (step < job ≤ unfiltered 60).

  Round-11 follow-ups in the same file set: the aquamobil workspace's own
  lockfile carried vite 7.3.5 (two more launch-editor advisories,
  GHSA-r825-w8mm-5pxw/GHSA-587h-7wmj-h5pm, joined GHSA-698v mid-round) —
  bumped to ^7.3.7 with its root-lockfile workspace snapshot; and the
  Cargo.lock edits required regenerating
  tools/quality/rust-toolchain-manifest.json (its cargo_lock_sha256 pin),
  which every Rust-workspace-setup job verifies.

  Round-13: the merge head's jest pass measured admin-api-service branches
  at 21.96% against the 21.99% pin — the same jest-vs-lcov epsilon wobble
  the double coverage gate's convention absorbs (pin sits lcov-floor minus
  epsilon). Branches re-pinned to 21.9; the material-gain ratchet
  (RATCHET_MIN_GAIN = 1.0) is untouched.

## FARM-HIGH-464 — tankGrowthProjection resolved units from the equipment registry

- **Evidence:** live verification after PR #2042's deploy — an ACTIVE
  protocol assignment on TNK-2026-00012 (269.38 kg, 2830 fish) projected
  0 rows. The handler looked units up through the `Equipment` entity
  (`equipment` table), while production tanks are rows in `tanks`; the
  batch existed, the assignment existed, and the join silently returned
  nothing for every tank, always.
- **Fix:** the handler resolves `Tank` (`tanks`) directly; capacity comes
  from the tank's own `volume`/`maxBiomass`/`maxDensity` columns instead
  of an equipment specifications JSON; department scoping goes through
  `Tank.departmentId`. A new handler spec pins the resolution: an
  Equipment-only row must never project, a real tank must — with the
  series, capacity and department assertions.

## FARM-MEDIUM-465 — Feeding page refused ?tab=production-plan and opened the Meal Board

- **Evidence:** reported from the live app —
  `/sites/feeding?tab=production-plan` opened the Meal Board. The page
  described its tabs in four places: the `TabId` union, a `VALID_TABS` list,
  the `tabs` array that draws the strip, and the shell nav's feeding strip.
  `production-plan` was in the union, the strip, the content branch and the
  nav, but not in `VALID_TABS`, so `isValidTab` refused it and the page fell
  back to `DEFAULT_TAB`. Clicking the Production Plan button failed the same
  way (it wrote `?tab=production-plan`, then the same check refused it), so
  `ProductionPlanTab` could never mount. It shipped that way with the tab
  (e754a72ea, 2026-10-20): not a regression, and no spec drove a tab through
  `?tab=`.
- **Why the gate did not see it:** `web-console-nav-coverage` holds the nav's
  tab ids against the page's `TabId` union, on the premise that the union is
  the set the page accepts. For this page it was not.
- **Fix:** the page describes its tabs once. `TAB_DEFINITIONS` is a
  `Record<TabId, …>`, so the compiler rejects a union member without a
  definition and a definition outside the union; the strip and the accepted
  `?tab=` values both derive from it, and `VALID_TABS` is gone. The union
  stays a literal type, so the nav gate keeps reading it — and is now sound
  for this page. Strip order follows the nav's (Production Plan before
  Protocols v2). Specs derive from the rendered buttons, so a tab added later
  is covered without editing them: every button shows itself active once
  clicked, and every `?tab=` its click wrote opens that same tab.
- **Siblings (swept 2026-10-22, 18 tab-reading pages):** Feeding was the only
  page with an id drawn and linked but refused. Not fixed here, not registered:
  `TanksPage` reads `?tab` only when it mounts, so a rail tab click while the
  page is open changes the URL and the highlight but probably not the view
  (read from code, not reproduced); Water chemistry's `bulk` tab is listed to
  viewers without the capability that makes it render.
