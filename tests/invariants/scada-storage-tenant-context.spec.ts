/**
 * SCADA storage tenant-context completeness invariant (ORPHAN-411e / ORPHAN-414).
 *
 * The three SCADA persistence tables (`scada_alarms`, `scada_alarm_chronicle`,
 * `scada_tag_history`) live in the shared `sensor` schema and carry a FORCED
 * `tenant_isolation_policy` (`app.bypass_rls='on' OR tenant_id = current_tenant`).
 * A raw pooled `dataSource.query` with no GUC is REJECTED by Postgres once the
 * runtime activates.
 *
 * The prior test (`scada-storage-tenant-isolation.spec.ts`) proves the tenant_id
 * COLUMN fence. This invariant proves the missing half — that the WRITER
 * establishes DB-level tenant context — so a future edit that reintroduces an
 * unwrapped `this.dataSource.query('… scada_… …')` is caught at test time:
 *
 *   - per-tenant writes/reads MUST run through a query-runner obtained from
 *     `runInTenantTransaction` / `runInTenantRead` (i.e. `qr.query(…)`), so the
 *     policy ENFORCES the row (Tier-1); and
 *   - the ONLY raw `this.dataSource.query(…)` calls hitting a SCADA DATA table
 *     are the declared, audited cross-tenant maintenance sweeps wrapped in
 *     `BypassRlsService.withBypass(…)` (the outbox-worker class).
 *
 * Catalog reads (`information_schema`, `pg_class`) are not RLS-protected and are
 * exempt.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const STORAGE_FILES = [
  'apps/sensor-service/src/scada-runtime/services/alarm-storage.service.ts',
  'apps/sensor-service/src/scada-runtime/services/daq-storage.service.ts',
];

const SCADA_DATA_TABLES = /scada_alarms|scada_alarm_chronicle|scada_tag_history/;
const CATALOG_TABLES = /information_schema|pg_class|pg_catalog/;

/** Byte ranges of every `withBypass( … )` block, via brace matching. */
function bypassBlockRanges(src: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const marker = 'withBypass(';
  let from = 0;
  for (;;) {
    const start = src.indexOf(marker, from);
    if (start === -1) break;
    // Walk forward to the matching close paren of withBypass( … ).
    let depth = 0;
    let i = src.indexOf('(', start + marker.length - 1);
    let end = i;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    ranges.push([start, end]);
    from = end + 1;
  }
  return ranges;
}

function isInsideBypass(idx: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([a, b]) => idx >= a && idx <= b);
}

describe('ORPHAN-411e — SCADA storage writers establish tenant context or an audited bypass', () => {
  for (const rel of STORAGE_FILES) {
    describe(rel, () => {
      const src = readFileSync(join(REPO_ROOT, rel), 'utf8');

      it('imports the tenant-context + bypass primitives from backend-common', () => {
        expect(src).toMatch(/runInTenantTransaction/);
        expect(src).toMatch(/runInTenantRead/);
        expect(src).toMatch(/BypassRlsService/);
      });

      it('every raw this.dataSource.query hitting a SCADA data table is inside an audited withBypass', () => {
        const bypass = bypassBlockRanges(src);
        const rawQueryRe = /this\.dataSource\.query\(/g;

        const offenders: string[] = [];
        for (let m = rawQueryRe.exec(src); m !== null; m = rawQueryRe.exec(src)) {
          const callIdx = m.index;
          if (isInsideBypass(callIdx, bypass)) continue; // audited maintenance sweep — allowed

          // Look back to the enclosing method body for the SQL this call runs.
          const windowStart = Math.max(0, callIdx - 1600);
          const window = src.slice(windowStart, callIdx);
          const method = window.slice(window.lastIndexOf('\n  async ') + 1 || 0);

          if (CATALOG_TABLES.test(method)) continue; // catalog read — not RLS-protected

          if (SCADA_DATA_TABLES.test(method)) {
            const line = src.slice(0, callIdx).split('\n').length;
            offenders.push(
              `${rel}:${line} — raw dataSource.query on a SCADA data table without tenant context/bypass`,
            );
          }
        }

        expect(offenders).toEqual([]);
      });
    });
  }

  it('the ONLY audited bypass labels are the declared cross-tenant maintenance sweeps', () => {
    const labels = new Set<string>();
    for (const rel of STORAGE_FILES) {
      const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
      const re = /withBypass\(\s*'([^']+)'/g;
      for (let m = re.exec(src); m !== null; m = re.exec(src)) {
        labels.add(m[1]!);
      }
    }
    // A NEW bypass label must be justified here — this list is the SSoT for the
    // genuinely-cross-tenant SCADA maintenance operations (retention + bounds).
    expect([...labels].sort()).toEqual(
      [
        'scada:cleanup-alarm-chronicle',
        'scada:cleanup-tag-history',
        'scada:tag-history-data-bounds',
      ].sort(),
    );
  });
});
