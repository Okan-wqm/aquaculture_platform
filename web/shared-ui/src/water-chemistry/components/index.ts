/**
 * Water-chemistry PRESENTATION components (SSoT source).
 *
 * IMPORTANT — these are intentionally NOT re-exported from shared-ui's main
 * barrel (`web/shared-ui/src/index.ts`). They pull in recharts; folding them into
 * the federation SINGLETON would force every shared-ui consumer (shell, admin,
 * tenant-admin, …) to provide recharts in its shared scope. Instead, the two
 * recharts-sharing consumers (farm-module, sensor-module) import these from the
 * SOURCE subpath `@platform/shared-ui/water-chemistry/components`, so the code is
 * bundled per-remote (like the engine) with recharts resolved from that remote's
 * own shared scope. These components use NO shared-ui React context, so a
 * per-remote bundled copy carries none of the Provider-identity hazard the
 * singleton-imports invariant guards against.
 */
export { default as DeffeyesChart } from './DeffeyesChart';
export { default as ResultsPanel } from './ResultsPanel';
export {
  ChartCard,
  UiaVsPhChart,
  H2sVsPhChart,
  CarbonateVsPhChart,
  CalciteSaturationChart,
} from './SecondaryCharts';
