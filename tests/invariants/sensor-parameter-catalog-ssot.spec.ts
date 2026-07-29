import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * INVARIANT (SENSOR-MEDIUM-065): the aquaculture parameter/channel catalog
 * (unit + operational range + SensorType per channel key) has exactly ONE owner —
 * `apps/sensor-service/src/common/sensor-parameter-catalog.ts`. It used to be
 * triplicated (backend channel discovery, the FE registration.types map, and a
 * fourth copy in DataChannelsStep) and the copies DISAGREED on units and ranges
 * that feed alarm thresholds. The backend now imports the SSoT and the frontend
 * consumes it via the `sensorParameterCatalog` query.
 *
 * This invariant fails if a divergent `KNOWN_PARAMETERS` map (the historical name
 * of every copy) is re-introduced anywhere in the sensor backend or frontend, or
 * if the single catalog module goes missing.
 */
const REPO_ROOT = resolve(__dirname, '..', '..');
const CATALOG_MODULE = resolve(
  REPO_ROOT,
  'apps/sensor-service/src/common/sensor-parameter-catalog.ts',
);
const SCAN_ROOTS = [
  resolve(REPO_ROOT, 'apps/sensor-service/src'),
  resolve(REPO_ROOT, 'web/modules/sensor-module/src'),
];

/** A DECLARATION of the historical divergent map, not a comment/prose mention. */
const KNOWN_PARAMETERS_DECL = /\bKNOWN_PARAMETERS\s*[:=]/;

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsFilesUnder(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Strip block + line comments so prose mentions of the old name never trip the scan. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('INVARIANT: single sensor parameter catalog (SENSOR-MEDIUM-065)', () => {
  it('the SSoT catalog module exists and exports the catalog + lookup', () => {
    expect(existsSync(CATALOG_MODULE)).toBe(true);
    const src = readFileSync(CATALOG_MODULE, 'utf8');
    expect(src).toMatch(/export const SENSOR_PARAMETER_CATALOG/);
    expect(src).toMatch(/export function lookupParameter/);
    expect(src).toMatch(/export function listParameterCatalog/);
  });

  it('no divergent KNOWN_PARAMETERS map is declared in the sensor backend or frontend', () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of tsFilesUnder(root)) {
        const raw = readFileSync(file, 'utf8');
        if (!raw.includes('KNOWN_PARAMETERS')) continue;
        if (KNOWN_PARAMETERS_DECL.test(stripComments(raw))) {
          offenders.push(file.replace(`${REPO_ROOT}/`, ''));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
