# handlebars advisories of 2026-10-09

The required `security-audit` job turned red on main on 2026-10-09. The npm audit gate
gates `build-development-images`, so every development deploy stopped with it, including
the first deploy after the operator set `DEVELOPMENT_DEPLOY_MODE=auto`.

## SUPPLY-HIGH-021 — handlebars 4.7.9 carries three critical advisories

- `handlebars` 4.7.9 sits in the root and e2e trees as a development dependency of
  `ts-jest` (`^4.7.8` and `^4.7.9`).
- The advisory feed added GHSA-xw65-4hp5-5hc7, GHSA-8r5x-fm3f-whwj and
  GHSA-p8wg-vrv2-v86f, all critical. The gate's legs `root-full` and `e2e-full` failed;
  the production legs were clean, because no runtime image installs it.
- Rated HIGH rather than CRITICAL for that reason: the exposure is the test toolchain.

### Fix

- `handlebars` moves to 4.7.10 in both lockfiles (`npm update handlebars
--package-lock-only`). It is a patch inside both declared ranges, so no manifest
  changes and no exception is needed.
- `npm audit --package-lock-only` reports no handlebars advisory in either tree after the
  change.
