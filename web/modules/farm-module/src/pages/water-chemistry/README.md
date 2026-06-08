# Water Chemistry Chart Rollback

The center Deffeyes chart defaults to the DIC/pH renderer.

Rollback options:

- Build-time env: set `VITE_DEFFEYES_CHART_MODE=legacy` before building the farm module. Vite reads this from the repo root via `envDir`; Docker and prebuilt `dist/` deployments must export the env before `npm run build`.
- Per-session diagnostic rollback: add `?deffeyesMode=legacy` to the URL.
- Per-session return to the new chart while env is legacy is denied by default. It only works when the build also sets `VITE_DEFFEYES_ALLOW_DIAGNOSTIC_MODE_OVERRIDE=true`.

If DIC/pH chart generation throws, the page automatically renders the legacy
ALK/DIC Deffeyes chart and shows an inline warning.

Keep the legacy renderer and generator until these gates remain green in
production-equivalent validation:

- Engine parity tests and farm render tests pass.
- No `VITE_DEFFEYES_CHART_MODE=legacy` rollback incidents are open.
- Consumer scan confirms no external caller depends on removed ALK/DIC-only
  chart internals.
