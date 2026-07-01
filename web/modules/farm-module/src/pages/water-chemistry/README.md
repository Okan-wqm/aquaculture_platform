# Water Chemistry — Deffeyes chart

The center chart is the **ALK/DIC Deffeyes diagram** (`components/DeffeyesChart.tsx`):

- **X axis** = DIC (dissolved inorganic carbon, mmol/L)
- **Y axis** = Alkalinity (meq/L)
- **Contour lines** = pH isolines

It is the single, canonical chart. The former DIC/pH ("Millero") renderer and
its `VITE_DEFFEYES_CHART_MODE` / `?deffeyesMode=` switch were removed — there is
no chart mode flag anymore.

## Toxicity overlays (show/hide layers)

Each toxic zone is a toggleable shaded layer, computed in the engine
(`libs/aquaculture-engines/src/water-chemistry/deffeyes-data.ts`) and rendered
as a recharts `<Area>`:

| Layer | Engine generator | Side | Colour |
|---|---|---|---|
| NH₃ toxic | `generateNH3ToxicZone` | high pH (un-ionized ammonia) | `#ef4444` |
| CO₂ toxic | `generateCO2ToxicZone` | low pH / high DIC | `#f97316` |
| **H₂S toxic** | `generateH2SToxicZone` | low pH (un-ionized sulfide) | `#b91c1c` |

H₂S becomes toxic **below** a critical pH (`criticalPHforH2S`), so its boundary
is the critical-pH isoline and the danger band fills downward to the X-axis —
the same shape as CO₂. Inputs come from the H₂S panel (`h2sUgL`, `h2sLimitUgL`);
H₂S is measured in-situ so its measurement pH is the single realtime pH — the
same pH used for the CO₂ and NH₃ toxicity calcs (no separate H₂S pH input).

All toxic layers default to hidden. The printed report forces every toxic layer
(NH₃ + CO₂ + H₂S) plus the safe zone visible via the `forceSafetyOverlays` prop,
without mutating the user's per-layer toggles.

## Status panel

The UIA / H₂S status readouts (`ResultsPanel`) use the chart-pH-domain critical
solvers `criticalPHforNH3PHChartDomain` / `criticalPHforH2SPHChartDomain`, which
are retained in the engine for that purpose.
