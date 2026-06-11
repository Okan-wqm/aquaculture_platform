/**
 * Platform-wide invariant — DATA-HIGH-006:
 *
 * `PartitionManagerService` MUST NOT issue raw partition DDL — its entire
 * DDL surface is `SELECT platform.create_messaging_partition(...)`, the
 * Stage-010 SECURITY DEFINER primitive owned by `messaging_schema_owner`.
 *
 * # Why
 *
 * Two pg16 behaviours were proven empirically on the pinned production
 * image (2026-06-11, recorded in
 * docs/reviews/data-expert/2026-06-11-messaging-partition-definer.md):
 *
 *   1. `CREATE TABLE IF NOT EXISTS ... PARTITION OF` checks schema CREATE
 *      BEFORE the existence short-circuit — a USAGE-only runtime role
 *      crash-loops at boot (the 2026-06-11 production outage class).
 *   2. Genuinely creating a partition requires OWNERSHIP of the parent
 *      table; schema CREATE alone fails with "must be owner of table".
 *      The interim DATA-HIGH-005 schema-CREATE grant therefore only
 *      unblocked the no-op path — the first new monthly partition (cron,
 *      1st of month) would have crashed production again.
 *
 * Raw runtime partition DDL is thus wrong under EVERY privilege model the
 * platform allows. The definer primitive carries the authority; the
 * runtime role holds EXECUTE only.
 *
 * # Why this lives in tests/invariants/
 *
 * `dataSource.query()` accepts any string, so nothing in the type system
 * stops a future refactor from re-inlining `CREATE TABLE ... PARTITION
 * OF`. Same Tier-3 source-text hedge as
 * no-boot-time-tenant-schema-ddl.spec.ts (DATA-CRITICAL-002).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SERVICE_PATH = resolve(
  REPO_ROOT,
  'apps/messaging-service/src/partition/partition-manager.service.ts',
);

describe('INVARIANT — messaging partition DDL authority (DATA-HIGH-006)', () => {
  const source = readFileSync(SERVICE_PATH, 'utf8');
  // Strip comments so the WHY docblocks may name the forbidden statements
  // without tripping the gate on documentation.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('issues no raw DDL from the messaging runtime', () => {
    for (const forbidden of [
      'CREATE TABLE',
      'ALTER TABLE',
      'DROP TABLE',
      'PARTITION OF',
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });

  it('delegates to the platform SECURITY DEFINER primitive', () => {
    expect(code).toContain(
      'SELECT platform.create_messaging_partition($1, $2, $3, $4)',
    );
  });
});
