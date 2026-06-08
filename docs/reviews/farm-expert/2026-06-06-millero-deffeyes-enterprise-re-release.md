# Millero Deffeyes Enterprise Re-Release Review

Finding: FARM-HIGH-004
Status: IN-PROGRESS
Cycle: 2026-06-06-millero-deffeyes-enterprise-re-release

## Scope

This review tracks the re-release hardening package for the Millero/Deffeyes
DIC/pH chart rollout after the first candidate stack failed enterprise review.
The release is blocked until rollback, report security, API compatibility,
domain SSOT, environment SSOT, and focused validation all pass together.

## Agent Findings

- Engine domain and API review: pH domains must be exported from the engine and
  consumed by chart generation, compatibility wrappers, omega solving, and
  output calculations. Public H2S callers must keep the deprecated `currentPH`
  alias for one release and resolve `h2sMeasuredAtPH ?? currentPH ?? params.pH`.
- Farm rollback review: legacy mode must skip DIC/pH chart generation and every
  DIC/pH projection helper for reagent, dosing, and on-demand paths. Legacy
  reports must not emit DIC/pH projection diagnostics.
- Report security review: report printing must not rely on inline Blob scripts
  or a weakened script CSP. Cloned SVGs must be sanitized before embedding.
- Chart lint review: both the new DIC/pH chart and the active legacy rollback
  chart must be typed without broad `any` or local lint suppression.
- CI/browser review: farm water-chemistry tests need a focused non-quarantined
  CI gate, and production browser smoke must prove rollback and report paths.
- Release hygiene review: the finding registry must contain an open
  FARM-HIGH-004 entry before product changes are released, then be closed with
  the final product commit SHA.

## Evidence Targets

- `libs/aquaculture-engines/src/water-chemistry/domains.ts`
- `libs/aquaculture-engines/src/water-chemistry/deffeyes-data.ts`
- `libs/aquaculture-engines/src/water-chemistry/water-quality.ts`
- `libs/aquaculture-engines/src/water-chemistry/types.ts`
- `web/modules/farm-module/src/pages/water-chemistry/WaterChemistryPage.tsx`
- `web/modules/farm-module/src/pages/water-chemistry/components/DeffeyesPhChart.tsx`
- `web/modules/farm-module/src/pages/water-chemistry/components/DeffeyesChart.tsx`
- `web/modules/farm-module/src/pages/water-chemistry/waterChemistryReportExport.ts`
- `web/modules/farm-module/vite.config.ts`
- `.github/workflows/ci-affected.yml`
- `e2e/tests/water-chemistry/deffeyes-release-smoke.spec.ts`

## Validation Evidence

Captured during the implementation session before closing FARM-HIGH-004:

- `npx tsc -p libs/aquaculture-engines/tsconfig.json --noEmit` passed.
- `npx tsc -p web/modules/farm-module/tsconfig.json --noEmit` passed.
- `npx nx test aquaculture-engines -- --runInBand` passed.
- `npm --workspace @aquaculture/farm-module run test:water-chemistry` passed
  with expected React/Recharts animation `act(...)` warnings only.
- Focused ESLint passed for the touched water-chemistry farm files, engine chart
  files, report export helper/spec, standalone farm entrypoint, and Playwright
  smoke files.
- `npx nx build farm-module` passed.
- Production browser smoke passed for `VITE_DEFFEYES_CHART_MODE=ph`.
- Production browser smoke passed for
  `VITE_DEFFEYES_CHART_MODE=legacy` with
  `?deffeyesMode=ph` denied.
- Production browser smoke passed for
  `VITE_DEFFEYES_CHART_MODE=legacy` with
  `VITE_DEFFEYES_ALLOW_DIAGNOSTIC_MODE_OVERRIDE=true` and
  `?deffeyesMode=ph` allowed.

The browser smoke verifies chart mode selection, report print lifecycle, CSP
console safety, and absence of sentinel pH leakage in report/export output.
FARM-HIGH-004 must not be closed until the product commit exists and the registry
is updated with that commit SHA through `tools/gates/finding-registry.ts close`.
