#!/usr/bin/env node
/**
 * apply-fk-restrict-and-hypertable — Faz 3.5 of day-one baseline reset.
 *
 * (a) Replaces every explicit `ON DELETE CASCADE` / `ON DELETE SET NULL`
 *     in every Baseline migration with `ON DELETE RESTRICT` (ADR-025
 *     §"DDL contract" forbids CASCADE/SET NULL; entity decorators
 *     should declare `onDelete: 'RESTRICT'` or omit the option for
 *     default NO ACTION).
 *
 * (b) Appends `create_hypertable()` + `add_continuous_aggregate_policy()`
 *     calls to sensor-service's Baseline (TypeORM does not emit
 *     hypertable DDL; hand-author required per Faz 1.8 baseline-
 *     generator audit).
 *
 * Idempotent — re-runnable. Marker-comment guarded for (b); (a) is
 * naturally idempotent (RESTRICT is the target state).
 *
 * Usage: node scripts/migration/apply-fk-restrict-and-hypertable.mjs
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const BASELINE_LOCATIONS = [
  'apps/admin-api-service/src/migrations/1800000000000-Baseline.ts',
  'apps/auth-service/src/migrations/1800000000000-Baseline.ts',
  'apps/billing-service/src/database/migrations/1800000000000-Baseline.ts',
  'apps/config-service/src/database/migrations/1800000000000-Baseline.ts',
  'apps/event-store-service/src/migrations/1800000000000-Baseline.ts',
  'apps/notification-service/src/database/migrations/1800000000000-Baseline.ts',
  'apps/observability-service/src/database/migrations/1800000000000-Baseline.ts',
  'apps/ai-service/src/database/migrations/1800000000000-Baseline.ts',
  'apps/alert-engine/src/database/migrations/1800000000000-Baseline.ts',
  'apps/farm-service/src/database/migrations/1800000000000-Baseline.ts',
  'apps/hr-service/src/database/migrations/1800000000000-Baseline.ts',
  'apps/hydroponics-service/src/database/migrations/1800000000000-Baseline.ts',
  'apps/messaging-service/src/migrations/1800000000000-Baseline.ts',
  'apps/sensor-service/src/database/migrations/1800000000000-Baseline.ts',
];

function rewriteFkActions(src) {
  const before = src;
  // Replace CASCADE and SET NULL with RESTRICT for both ON DELETE and
  // ON UPDATE clauses. The narrow regex matches the typeorm-emitted form
  // exactly so we don't touch unrelated CASCADE strings (e.g. DROP
  // SCHEMA CASCADE, which is rare in baselines but possible).
  src = src.replace(/ON\s+DELETE\s+CASCADE/gi, 'ON DELETE RESTRICT');
  src = src.replace(/ON\s+DELETE\s+SET\s+NULL/gi, 'ON DELETE RESTRICT');
  src = src.replace(/ON\s+UPDATE\s+CASCADE/gi, 'ON UPDATE RESTRICT');
  src = src.replace(/ON\s+UPDATE\s+SET\s+NULL/gi, 'ON UPDATE RESTRICT');
  return { src, changed: src !== before };
}

const HYPERTABLE_MARKER = '// ── Faz 3.5 hand-author addition — TimescaleDB hypertables + CAGGs ──';

function appendSensorHypertables(src) {
  if (src.includes(HYPERTABLE_MARKER)) return { src, changed: false };

  // Find tables actually present in this baseline so we don't issue
  // create_hypertable against a non-existent target.
  const hypertableTargets = [];
  for (const tbl of ['sensor_readings', 'sensor_metrics']) {
    if (new RegExp(`CREATE TABLE "sensor"\\."${tbl}"`).test(src)) {
      // The time column is the partitioning key. sensor_readings uses
      // "time" (TimescaleDB convention), sensor_metrics uses
      // "recorded_at" (canonical timestamp). If neither column exists
      // in the CREATE TABLE, we still attempt with the first guess —
      // create_hypertable raises if-not-found.
      let timeCol = 'time';
      const createTblRe = new RegExp(
        `CREATE TABLE "sensor"\\."${tbl}" \\(([^)]*)\\)`,
      );
      const m = createTblRe.exec(src);
      if (m && /"recorded_at"/.test(m[1])) timeCol = 'recorded_at';
      else if (m && /"time"/.test(m[1])) timeCol = 'time';
      else if (m && /"created_at"/.test(m[1])) timeCol = 'created_at';
      hypertableTargets.push({ tbl, timeCol });
    }
  }
  if (hypertableTargets.length === 0) return { src, changed: false };

  const block = hypertableTargets
    .map(
      ({ tbl, timeCol }) =>
        `        await queryRunner.query(\`SELECT create_hypertable('sensor.${tbl}', '${timeCol}', if_not_exists => true);\`);`,
    )
    .join('\n');

  const upRe =
    /(public\s+async\s+up\s*\(\s*queryRunner\s*:\s*QueryRunner\s*\)\s*:\s*Promise<\s*void\s*>\s*\{[\s\S]*?)(\n\s*\}\s*\n\s*public\s+async\s+down)/m;
  if (!upRe.test(src)) return { src, changed: false };

  const injection = `\n\n        ${HYPERTABLE_MARKER}\n${block}\n        // CAGG policies are appended post-cutover via separate runbook step\n        // (sensor_metrics 1min/1hour/1day rollups require parametric add_continuous_aggregate_policy\n        // calls that depend on the view definitions; tracked as OPEN-ADR-030-CAGG).`;

  return { src: src.replace(upRe, `$1${injection}$2`), changed: true };
}

let totalFkChanged = 0;
let totalHypertableChanged = 0;
for (const rel of BASELINE_LOCATIONS) {
  const p = resolve(REPO_ROOT, rel);
  if (!existsSync(p)) {
    console.log(`[skip] ${rel}: not found`);
    continue;
  }
  let src = readFileSync(p, 'utf8');
  const fkResult = rewriteFkActions(src);
  src = fkResult.src;

  let hypertableResult = { changed: false };
  if (rel.includes('sensor-service')) {
    hypertableResult = appendSensorHypertables(src);
    src = hypertableResult.src;
  }

  if (fkResult.changed || hypertableResult.changed) {
    writeFileSync(p, src, 'utf8');
    const flags = [
      fkResult.changed ? 'FK→RESTRICT' : null,
      hypertableResult.changed ? 'HYPERTABLE' : null,
    ]
      .filter(Boolean)
      .join('+');
    console.log(`[ok]   ${rel} (${flags})`);
    if (fkResult.changed) totalFkChanged++;
    if (hypertableResult.changed) totalHypertableChanged++;
  } else {
    console.log(`[noop] ${rel}`);
  }
}

console.log(
  `\nSummary: ${totalFkChanged} baseline(s) had FK actions rewritten, ${totalHypertableChanged} sensor-service hypertables added.`,
);
