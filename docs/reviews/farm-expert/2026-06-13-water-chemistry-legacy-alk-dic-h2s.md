# Water Chemistry — single ALK/DIC Deffeyes chart + H₂S toxic zone

**Date:** 2026-06-13
**Agent:** farm-expert
**Cycle:** 2026-06-13-water-chemistry-legacy-alk-dic-h2s

## Context

The water-chemistry page (`web/modules/farm-module/src/pages/water-chemistry/`)
shipped two Deffeyes-diagram renderers behind a build-time mode flag
(`VITE_DEFFEYES_CHART_MODE`): the original **ALK/DIC** chart (X=DIC,
Y=alkalinity, pH isolines) and a newer **DIC/pH** ("Millero") chart (X=DIC,
Y=pH, alkalinity lines, FARM-HIGH-004). The DIC/pH chart was defaulted on for
evaluation. The operator decided the DIC/pH orientation was a test, wants the
ALK/DIC orientation as the single canonical chart, and additionally wants the
**H₂S toxic zone** shaded on it — the ALK/DIC chart only shaded NH₃ and CO₂,
while the DIC/pH chart already had an H₂S band.

## FARM-MEDIUM-004 — ALK/DIC is the sole chart; add H₂S toxic-zone overlay; remove DIC/pH machinery

**Severity:** MEDIUM
**State:** RESOLVED

### What

1. **H₂S toxic zone (engine + UI).** Add `generateH2SToxicZone` and a
   `h2sToxicZone` field on `DeffeyesChartData`. H₂S is toxic *below* a critical
   pH (`criticalPHforH2S`), so the boundary is that critical-pH isoline and the
   band fills downward to the X-axis — the same low-pH family as CO₂. `ToxicLimits`
   carries `h2sMeasuredUgL` / `h2sLimitUgL` / `h2sMeasuredAtPH`. `DeffeyesChart`
   gains an "H₂S Toxic" layer toggle (`#b91c1c`) and a `forceSafetyOverlays` prop
   so the printed report shows NH₃ + CO₂ + H₂S + the safe zone regardless of the
   user's per-layer toggles.

2. **ALK/DIC is the only chart.** Remove `DeffeyesPhChart`, the chart-mode
   machinery (`VITE_DEFFEYES_CHART_MODE`, `?deffeyesMode=` override, generation
   fallback, `shouldUseLegacyDeffeyesChart`), the DIC/pH engine paths
   (`generateDeffeyesPHChartData` + projection helpers + `DicPh*` /
   `DeffeyesPHChartData` / `DeffeyesPHLimits` types), and the CI `chart_mode`
   scenario matrix. The status-panel critical-pH solvers
   (`criticalPHforNH3PHChartDomain`, `criticalPHforH2SPHChartDomain`) are retained.

### Evidence

- `web/modules/farm-module/src/pages/water-chemistry/components/DeffeyesChart.tsx` — H₂S toggle + Area + forceSafetyOverlays
- `libs/aquaculture-engines/src/water-chemistry/deffeyes-data.ts` — generateH2SToxicZone + DIC/pH path removal
- `web/modules/farm-module/src/pages/water-chemistry/WaterChemistryPage.tsx` — legacy-only render, mode machinery removed

### Rule

Single canonical chart per surface; toxicity bands must be complete (NH₃ + CO₂ +
H₂S); dead pH-mode machinery removed rather than left behind a flag.

### Not done (operator follow-up)

Removing the now-inert `VITE_DEFFEYES_CHART_MODE` /
`VITE_DEFFEYES_ALLOW_DIAGNOSTIC_MODE_OVERRIDE` lines from `.env.example`,
`.env.production.example` and the deployment `.env` is blocked by the `.env` deny
rule; the reader was deleted so the lines are inert (cosmetic).
