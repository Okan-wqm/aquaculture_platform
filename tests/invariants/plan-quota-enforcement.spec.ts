/**
 * Platform-wide invariant — SSOT-C-13 (quota enforcement):
 *
 * Every metered-resource create path MUST enforce the per-plan quota via the
 * canonical `assertWithinQuota` guard (@aquaculture/backend-common/quota), which
 * reads the limit from the PLAN_CATALOG SSoT. A plan limit that is never
 * enforced is decoration — this invariant fails the build if any of the known
 * create paths drops its guard.
 *
 * # Why a fixed list rather than static analysis
 *
 * The create paths are a small, stable set (farm site, farm tank/pond, sensor
 * registration). Pinning them explicitly makes the contract auditable and the
 * failure message actionable. When a new metered resource gains a create path,
 * add it here in the same change that wires its guard.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const METERED_CREATE_PATHS = [
  'apps/farm-service/src/site/handlers/create-site.handler.ts',
  'apps/farm-service/src/tank/handlers/create-tank.handler.ts',
  'apps/sensor-service/src/registration/services/sensor-registration.service.ts',
];

describe('INVARIANT (SSOT-C-13): metered-resource create paths enforce the plan quota', () => {
  it.each(METERED_CREATE_PATHS)(
    '%s imports and calls assertWithinQuota',
    (rel) => {
      const src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      // Imported from the canonical quota module …
      expect(src).toMatch(
        /from\s+['"]@aquaculture\/backend-common\/quota['"]/,
      );
      // … and actually invoked (not merely imported).
      expect(src).toMatch(/\bassertWithinQuota\s*\(/);
      // … with the limit resolved from the PLAN_CATALOG SSoT.
      expect(src).toMatch(/\bresolvePlanLimits\s*\(/);
    },
  );
});
