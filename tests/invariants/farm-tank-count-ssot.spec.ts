import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * INVARIANT: the tank fish-COUNT is read from the batchDetails-derived SSoT
 * (tank_batches.totalQuantity), never from the redundant currentQuantity mirror.
 *
 * WHY (DB-FARMPROD-HIGH-001): the fish count was persisted in four places —
 * tank_batches.totalQuantity (the SSoT, derived from batchDetails[] by the single
 * writer TankBatchService.applyBatchDelta), the tank_batches.currentQuantity
 * mirror, tanks.currentCount, and equipment.currentCount. Several read paths
 * preferred the currentQuantity mirror (`currentQuantity ?? totalQuantity`). When
 * the mirror lagged the SSoT, the operator saw 900 on one surface and 719 on
 * another for the same tank. Collapsing every count read onto totalQuantity is
 * what makes web and mobile agree; this spec makes the mirror-preference
 * anti-pattern detectable at CI time so it cannot silently return.
 *
 * ASYMMETRY (deliberate): biomass is NOT collapsed the same way. currentBiomassKg
 * is the growth-tracked live value (daily-feeding-execution accrues weight-gain
 * into it) while totalBiomassKg is only the batchDetails baseline, so reads keep
 * the `currentBiomassKg ?? totalBiomassKg` preference on purpose. The biomass SSoT
 * unification is tracked separately; a future cleanup must not mistake it for the
 * count mirror and drop feeding growth.
 */

const REPO_ROOT = resolve(__dirname, '..', '..');
const FARM_SRC = resolve(REPO_ROOT, 'apps/farm-service/src');

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

/** Recursively collect farm-service .ts sources, excluding tests + migrations. */
function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'migrations') continue;
      out.push(...collectSources(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('INVARIANT: farm tank fish-count reads the totalQuantity SSoT (DB-FARMPROD-HIGH-001)', () => {
  const sources = collectSources(FARM_SRC);

  // The exact defect: a read that prefers the redundant tank_batches.currentQuantity
  // mirror over the totalQuantity SSoT. Anchored on `currentQuantity ??` so the
  // reconcile service's diagnostic `mirrorRaw = tankBatch?.currentQuantity` read
  // (no `?? total`) and biomass's `currentBiomassKg ?? total` read do not match.
  const COUNT_MIRROR_PREFERENCE = /currentQuantity\s*\?\?\s*[^;\n]*totalQuantity/;

  it('no farm-service read prefers the currentQuantity mirror over totalQuantity', () => {
    const offenders = sources
      .filter((file) => COUNT_MIRROR_PREFERENCE.test(readFileSync(file, 'utf8')))
      .map((file) => file.replace(`${REPO_ROOT}/`, ''));
    expect(offenders).toEqual([]);
  });

  it('the fish-count-serving read sites read totalQuantity directly', () => {
    expect(read('apps/farm-service/src/tank/resolvers/tank.resolver.ts')).toMatch(
      /pieces:\s*tankBatch\.totalQuantity/,
    );
    expect(read('apps/farm-service/src/equipment/equipment.resolver.ts')).toMatch(
      /pieces:\s*tankBatch\.totalQuantity/,
    );
    expect(
      read('apps/farm-service/src/feeding/services/daily-feeding-execution.service.ts'),
    ).toMatch(/fishCount\s*=\s*tankBatch\.totalQuantity/);
    expect(read('apps/farm-service/src/tank/handlers/get-tank-capacity.handler.ts')).toMatch(
      /currentQuantity\s*=\s*tankBatch\?\.totalQuantity/,
    );
  });

  it('the single writer derives every count mirror from the totalQuantity SSoT (never an independent source)', () => {
    const writer = read('apps/farm-service/src/batch/services/tank-batch.service.ts');
    // The tank_batches.currentQuantity mirror is written = totalQuantity here...
    expect(writer).toMatch(/currentQuantity\s*=\s*tankBatch\.totalQuantity/);
    // ...and tanks/equipment.currentCount is seeded from the same computed total,
    // so the four count columns cannot diverge as long as this is the writer.
    expect(writer).toMatch(/currentCount:\s*tankBatch\.totalQuantity/);
  });

  it('biomass deliberately keeps the growth-tracked currentBiomassKg read (NOT a count mirror)', () => {
    // Guards the intentional asymmetry: currentBiomassKg carries feeding growth and
    // must not be "cleaned up" to totalBiomassKg the way the count mirror was.
    expect(read('apps/farm-service/src/tank/resolvers/tank.resolver.ts')).toMatch(
      /currentBiomassKg\s*\?\?\s*tankBatch\.totalBiomassKg/,
    );
  });
});
