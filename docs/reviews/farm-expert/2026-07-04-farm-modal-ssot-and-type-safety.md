# Farm — modal SSoT consolidation + unsafe-cast elimination (2026-07-04)

Follow-on to `2026-07-04-batch-modal-and-tracking.md` (FARM-HIGH-129). After the
New-Batch form was found opening *behind* its backdrop because it hand-rolled its
own modal shell instead of using the shared `@aquaculture/shared-ui` `Modal`, a
sweep found the same anti-pattern across the whole farm-module, plus a cluster of
`as any` / `as unknown as` escape hatches. The operator asked for both to be
fixed at the SSoT/architectural level — no patches, no silencing, no deferral.

## FARM-MEDIUM-134 — 36 farm-module components hand-rolled their own modal shell instead of the shared Modal SSoT — RESOLVED

**Scope.** 37 modal dialogs across 36 files (setup ×11, storage ×7, tasks ×5,
reports ×5, feeding+harvest ×5 files/10 modals, water-chemistry ×4) each rendered
their own `fixed inset-0` backdrop + centered panel + hand-rolled close button.

**Root cause (same class as FARM-HIGH-129).** A hand-rolled shell paints the
dimming backdrop as a `position: fixed` element and the panel as a non-positioned
(or `transform`-only) in-flow box. CSS paint order draws the backdrop on top of
the panel, so the dialog can open *behind* the scrim (unreachable). Even the
shells that avoided the visual bug (panel marked `relative`) duplicated modal
concerns — focus-trap, Escape, scroll-lock, `role=dialog`, portal-to-body — that
the shared `Modal` already owns.

**Fix (tier 1/2).** Every modal now routes through the shared `Modal` primitive,
which `createPortal`s to `document.body` (escaping transformed/overflow-clipped
federated ancestors) and positions its panel `relative` — making the whole
paint-order bug class impossible. Header title → `Modal.title`; body + actions →
children; hand-rolled close buttons deleted (Modal renders its own); tab buttons
that moved inside a `<form>` got `type="button"`. 100% of form state, handlers,
validation and queries preserved — shell swap only. `ReportWizard` (a reusable
wizard used by 5 report tabs) was migrated internally; its consumers are
unchanged. `ProtocolDetailDrawer` is intentionally left as-is: it is a right-side
slide-over drawer (`fixed inset-y-0 right-0`, positioned panel), not a centered
modal — forcing it into `Modal` would change its UX, and it does not exhibit the
paint-order bug. A future shared `Drawer` primitive should absorb it.

**Enforcement (tier 1 — make it impossible to regress).**
`tests/invariants/web-no-hand-rolled-modal-shell.spec.ts` (layer-1) scans
`web/modules/farm-module/src/**/*.tsx` for the modal-backdrop signature
(`fixed inset-0` + a translucent dark dim) and fails on any hand-rolled shell. Its
`KNOWN_OFFENDERS` ratchet is now empty and can only shrink — a new hand-rolled
modal fails CI; a baselined one that is fixed must be removed from the set.

## FARM-MEDIUM-135 — farm-module carried 15 unsafe `as any` / `as unknown as` casts — RESOLVED

Type-safety escape hatches defeat the compiler at exactly the boundaries most
likely to drift. All 15 removed by fixing the real types:

- **HarvestPlansPage** (6× `as any`): the filter/create-input fields were already
  the right enum/optional types (`HarvestPlanFilterInput.status?: HarvestPlanStatus`,
  `CreateHarvestPlanInput.harvestType?` optional, `'planned'` a valid status) — the
  casts were redundant and were simply deleted.
- **EquipmentTab** (2× `as unknown as SpecificationSchema`): root-caused to the
  source — `useEquipment.EquipmentType.specificationSchema` was typed
  `Record<string, unknown>`; retyped to `SpecificationSchema` (its real shape,
  already how the code uses it), so both consumer casts vanished.
- **SitesTab** (2× `as unknown as` + `handleSave(formData: any)` + `siteData: any`):
  typed the save contract — `handleSave(formData: Partial<SiteFormData>)` (exported
  from `SiteFormModal`), built a typed `CreateSiteInput`, and derived `UpdateSiteInput`
  by spread. Empty-string→`undefined` per field replaces the untyped generic
  key-stripping with identical wire behavior.
- **useFarmRealtimeStream** (4× `as unknown as`): `import.meta.env.VITE_WS_URL` is
  already typed via `vite/client`; `window.__RUNTIME_CONFIG__` got a proper
  `declare global` Window augmentation; `socket.auth` is a writable Socket property
  (no cast needed).
- **SlaughterReportTab** (1× `as any`): `lokalitetsnummer: number | ''` already
  matches `parseInt(...) || ''`; cast deleted.

Result: `grep -rE '\bas any\b|as unknown as|@ts-ignore|@ts-expect-error'` over
`web/modules/farm-module/src` (excluding specs) returns **0**. New occurrences are
already blocked on added lines by the `banned-construct` gate.

## Verification

`nx test farm-module` → 106 green (incl. the FARM-HIGH-129 and FARM-MEDIUM-133
regression specs). `tsc -p web/modules/farm-module` clean. `eslint` clean on all
changed files. `invariants:fast` → 142 suites / 1752 tests green (new modal-shell
invariant included).
