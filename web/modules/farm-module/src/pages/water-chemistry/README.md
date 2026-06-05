# Water Chemistry Chart Rollback

The center Deffeyes chart defaults to the DIC/pH renderer.

Rollback options:

- Build/runtime env: set `VITE_DEFFEYES_CHART_MODE=legacy`.
- Per-session diagnostic override: add `?deffeyesMode=legacy` to the URL.
- Per-session return to the new chart when env is legacy: add `?deffeyesMode=ph`.

If DIC/pH chart generation throws, the page automatically renders the legacy
ALK/DIC Deffeyes chart and shows an inline warning.

Keep the legacy renderer and generator until these gates remain green in
production-equivalent validation:

- Engine parity tests and farm render tests pass.
- No `VITE_DEFFEYES_CHART_MODE=legacy` rollback incidents are open.
- Consumer scan confirms no external caller depends on removed ALK/DIC-only
  chart internals.
