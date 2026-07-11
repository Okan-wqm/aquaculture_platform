/**
 * COMPLIANCE-HIGH-002 — regulatory_reports SUBMITTED-immutability trigger.
 *
 * A SUBMITTED report is the legal record of what was filed to Mattilsynet. The
 * service-layer upsert guard refuses to reset it, but the DB trigger installed
 * by 1804800000000 is the tier-1 "make it impossible" backstop: any UPDATE that
 * changes a SUBMITTED row's filing-identity fields (status, klientReferanse,
 * reportType, payload, referanse) is rejected at the database, regardless of the
 * code path that issued it. This exercises that trigger against a real Postgres.
 *
 * The table here is a MINIMAL stand-in (the columns the trigger reads) so the
 * test needs no enums / RLS / full CreateRegulatoryReports migration — the
 * trigger is attached by name and fires the same way.
 */
import 'reflect-metadata';

import { bootPostgresContainer, HarnessContext, shutdownHarness } from '@platform/migration-harness';

import { AddRegulatoryReportImmutabilityTrigger1804800000000 } from '../../database/migrations/1804800000000-AddRegulatoryReportImmutabilityTrigger';

jest.setTimeout(120_000);

describe('regulatory_reports SUBMITTED immutability trigger (COMPLIANCE-HIGH-002)', () => {
  let pg: HarnessContext | undefined;

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await pg.dataSource.query('CREATE SCHEMA farm');
    await pg.dataSource.query(`
      CREATE TABLE farm.regulatory_reports (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "status" text NOT NULL,
        "klientReferanse" text NOT NULL,
        "reportType" text NOT NULL,
        "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "referanse" text,
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);

    // Install the trigger the same way the runner does: current_schema-relative,
    // with search_path pinned to farm on THIS connection.
    const qr = pg.dataSource.createQueryRunner();
    await qr.connect();
    try {
      await qr.query('SET search_path TO farm, public');
      await new AddRegulatoryReportImmutabilityTrigger1804800000000().up(qr);
    } finally {
      await qr.release();
    }
  });

  afterAll(async () => {
    await shutdownHarness(pg);
  });

  async function insertRow(status: string, referanse: string | null): Promise<string> {
    const rows: Array<{ id: string }> = await pg!.dataSource.query(
      `INSERT INTO farm.regulatory_reports ("status", "klientReferanse", "reportType", "payload", "referanse")
       VALUES ($1, 'ref-1', 'SEA_LICE', '{"a":1}'::jsonb, $2)
       RETURNING "id"`,
      [status, referanse],
    );
    return rows[0]!.id;
  }

  it('rejects a status change away from SUBMITTED', async () => {
    const id = await insertRow('SUBMITTED', 'MT-1');
    await expect(
      pg!.dataSource.query(`UPDATE farm.regulatory_reports SET "status" = 'PENDING' WHERE "id" = $1`, [
        id,
      ]),
    ).rejects.toThrow(/immutable|COMPLIANCE-HIGH-002/i);
  });

  it('rejects nulling the Mattilsynet receipt on a SUBMITTED row', async () => {
    const id = await insertRow('SUBMITTED', 'MT-2');
    await expect(
      pg!.dataSource.query(`UPDATE farm.regulatory_reports SET "referanse" = NULL WHERE "id" = $1`, [
        id,
      ]),
    ).rejects.toThrow(/immutable|COMPLIANCE-HIGH-002/i);
  });

  it('rejects rewriting the payload of a SUBMITTED row', async () => {
    const id = await insertRow('SUBMITTED', 'MT-3');
    await expect(
      pg!.dataSource.query(
        `UPDATE farm.regulatory_reports SET "payload" = '{"a":2}'::jsonb WHERE "id" = $1`,
        [id],
      ),
    ).rejects.toThrow(/immutable|COMPLIANCE-HIGH-002/i);
  });

  it('allows a benign updatedAt-only write on a SUBMITTED row', async () => {
    const id = await insertRow('SUBMITTED', 'MT-4');
    await expect(
      pg!.dataSource.query(`UPDATE farm.regulatory_reports SET "updatedAt" = now() WHERE "id" = $1`, [
        id,
      ]),
    ).resolves.toBeDefined();
  });

  it('allows the transition INTO SUBMITTED (a non-terminal row is still mutable)', async () => {
    const id = await insertRow('PENDING', null);
    await expect(
      pg!.dataSource.query(
        `UPDATE farm.regulatory_reports SET "status" = 'SUBMITTED', "referanse" = 'MT-5' WHERE "id" = $1`,
        [id],
      ),
    ).resolves.toBeDefined();
  });

  it('does not constrain a QUEUED row (varsling insert-then-set-referanse flow)', async () => {
    const id = await insertRow('QUEUED', null);
    await expect(
      pg!.dataSource.query(
        `UPDATE farm.regulatory_reports SET "referanse" = 'EVT-1' WHERE "id" = $1`,
        [id],
      ),
    ).resolves.toBeDefined();
  });
});
