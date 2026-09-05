/**
 * One LIVE protocol assignment per unit, against a REAL PostgreSQL
 * (W0.3 / FARM-MEDIUM-256 + FARM-MEDIUM-250a).
 *
 * ## Why a real database
 *
 * The invariant is a PARTIAL UNIQUE INDEX — `("tenantId", "unitId") WHERE
 * status <> 'ended'`. Its whole value is in the predicate, and a predicate is
 * something only Postgres evaluates: a mocked repository accepts every insert,
 * so a suite built on doubles is green whether the index says `<> 'ended'`,
 * `= 'active'`, or is missing altogether.
 *
 * That distinction is exactly what shipped broken. The original index covered
 * only `status = 'active'`, so a unit could accumulate one active plus N paused
 * assignments. The reachable path: a protocol is archived → its assignments are
 * paused → the operator assigns a new protocol → reassignment ends only the
 * ACTIVE row → the paused row survives forever. Downstream, `detectUnfedUnits`
 * joins per unit and the stale paused row passes its WHERE, so a properly fed
 * unit raises `UnfedUnitDetected` every morning — a daily CRITICAL incident
 * that trains operators to ignore the one signal that says fish are not being
 * fed.
 *
 * ## What is asserted
 *
 * Both directions of the predicate, because each has its own failure mode:
 * too narrow lets duplicates accumulate (the shipped bug), too wide makes
 * reassignment impossible (a unit could never change protocol, since its
 * history of `ended` rows would block every new one).
 *
 * The last case is the one worth the file: the resume guard in
 * `protocol-assignment.handlers.ts` and the index must agree on what "live"
 * means. The guard queries `status IN (active, paused)` to raise a 409 BEFORE
 * the insert. If the index ever covered a status the guard does not, the guard
 * would wave the write through and the operator would get a raw `duplicate key`
 * 500 instead. Asserting the two agree is asserting the 409 is reachable.
 */
import 'reflect-metadata';
import { randomBytes } from 'crypto';

import {
  bootPostgresContainer,
  HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource, QueryFailedError } from 'typeorm';

import {
  FeedingUnitType,
  ProtocolAssignment,
  ProtocolAssignmentStatus,
} from '../../feeding-protocol/entities/protocol-assignment.entity';

jest.setTimeout(120_000);

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999';
const UNIT = '22222222-2222-4222-8222-222222222222';
const OTHER_UNIT = '33333333-3333-4333-8333-333333333333';
const SITE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROTOCOL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Postgres unique-violation. Asserted by code, not by message text. */
const UNIQUE_VIOLATION = '23505';

interface AssignmentSeed {
  status: ProtocolAssignmentStatus;
  tenantId?: string;
  unitId?: string;
  endedAt?: Date;
}

describe('single live protocol assignment per unit — real Postgres', () => {
  let pg: HarnessContext;
  let dataSource: DataSource;

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE SCHEMA farm');

    dataSource = new DataSource({
      type: 'postgres',
      ...pg.connectionOptions,
      name: `farm-service-assignment-single-live-${randomBytes(4).toString('hex')}`,
      entities: [ProtocolAssignment],
      synchronize: true,
      logging: false,
      extra: { options: '-c search_path=farm,public' },
    });
    await dataSource.initialize();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    await shutdownHarness(pg);
  });

  beforeEach(async () => {
    await dataSource.manager.clear(ProtocolAssignment);
  });

  /**
   * Writes through the EntityManager: bare repository access is banned by
   * CLAUDE.md (it bypasses tenant scoping) and the gate does not exempt spec
   * files. `manager.save(Entity, row)` never touches that surface.
   */
  async function seed(seedRow: AssignmentSeed): Promise<ProtocolAssignment> {
    return dataSource.manager.save(ProtocolAssignment, {
      tenantId: seedRow.tenantId ?? TENANT,
      unitId: seedRow.unitId ?? UNIT,
      unitType: FeedingUnitType.TANK,
      unitName: 'Tank 1',
      unitCode: 'T-01',
      siteId: SITE,
      protocolId: PROTOCOL,
      status: seedRow.status,
      effectiveFrom: new Date('2026-06-01'),
      endedAt: seedRow.endedAt,
      overrides: {},
      suspensions: [],
    });
  }

  /** The insert Postgres must reject, surfaced as its SQLSTATE. */
  async function sqlStateOf(row: AssignmentSeed): Promise<string | undefined> {
    try {
      await seed(row);
      return undefined;
    } catch (error) {
      if (error instanceof QueryFailedError) {
        return Reflect.get(error, 'code') as string | undefined;
      }
      throw error;
    }
  }

  it('builds the partial unique index the invariant depends on', async () => {
    const indexes: Array<{ indexdef: string }> = await dataSource.query(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'farm'
          AND tablename = 'feeding_protocol_assignments'
          AND indexdef LIKE '%UNIQUE%'`,
    );

    // A missing index would make every rejection assertion below vacuous, so
    // its existence AND predicate are checked before anything relies on them.
    const live = indexes.find((row) => /"?status"?\s*<>\s*'ended'/.test(row.indexdef));
    expect(live).toBeDefined();
    expect(live?.indexdef).toMatch(/UNIQUE/);
    expect(live?.indexdef).toMatch(/tenantId/);
    expect(live?.indexdef).toMatch(/unitId/);
  });

  it('rejects a second ACTIVE assignment on the same unit', async () => {
    await seed({ status: ProtocolAssignmentStatus.ACTIVE });

    expect(await sqlStateOf({ status: ProtocolAssignmentStatus.ACTIVE })).toBe(UNIQUE_VIOLATION);
  });

  it('rejects a PAUSED assignment alongside an ACTIVE one (the shipped defect)', async () => {
    // The pre-W0 index covered `status = 'active'` only, so this insert
    // succeeded and the stale row went on to fake `UnfedUnitDetected` daily.
    await seed({ status: ProtocolAssignmentStatus.ACTIVE });

    expect(await sqlStateOf({ status: ProtocolAssignmentStatus.PAUSED })).toBe(UNIQUE_VIOLATION);
  });

  it('rejects a second PAUSED assignment (paused is live, not archived)', async () => {
    await seed({ status: ProtocolAssignmentStatus.PAUSED });

    expect(await sqlStateOf({ status: ProtocolAssignmentStatus.PAUSED })).toBe(UNIQUE_VIOLATION);
  });

  it('lets a unit be reassigned once its previous assignment is ENDED', async () => {
    // The other direction: an over-wide predicate would freeze the unit on its
    // first protocol forever, because its history can never be discarded.
    await seed({ status: ProtocolAssignmentStatus.ENDED, endedAt: new Date('2026-06-10') });
    await seed({ status: ProtocolAssignmentStatus.ENDED, endedAt: new Date('2026-06-20') });

    const resumed = await seed({ status: ProtocolAssignmentStatus.ACTIVE });

    expect(resumed.id).toBeDefined();
    expect(
      await dataSource.manager.count(ProtocolAssignment, {
        where: { tenantId: TENANT, unitId: UNIT },
      }),
    ).toBe(3);
  });

  it('scopes the constraint per tenant and per unit', async () => {
    await seed({ status: ProtocolAssignmentStatus.ACTIVE });

    // Same unit id under another tenant is a different physical unit.
    const otherTenant = await seed({
      status: ProtocolAssignmentStatus.ACTIVE,
      tenantId: OTHER_TENANT,
    });
    const otherUnit = await seed({
      status: ProtocolAssignmentStatus.ACTIVE,
      unitId: OTHER_UNIT,
    });

    expect(otherTenant.id).toBeDefined();
    expect(otherUnit.id).toBeDefined();
  });

  it('resume guard and index agree on what counts as live', async () => {
    // The guard's own where-clause, from protocol-assignment.handlers.ts. It
    // must find a row for every status the index would reject — otherwise the
    // guard passes and the operator gets a duplicate-key 500 instead of a 409.
    const guardWhere = [
      { tenantId: TENANT, unitId: UNIT, status: ProtocolAssignmentStatus.ACTIVE },
      { tenantId: TENANT, unitId: UNIT, status: ProtocolAssignmentStatus.PAUSED },
    ];

    for (const status of [ProtocolAssignmentStatus.ACTIVE, ProtocolAssignmentStatus.PAUSED]) {
      await dataSource.manager.clear(ProtocolAssignment);
      await seed({ status });

      const found = await dataSource.manager.findOne(ProtocolAssignment, { where: guardWhere });
      expect(found).not.toBeNull();
      expect(await sqlStateOf({ status: ProtocolAssignmentStatus.ACTIVE })).toBe(UNIQUE_VIOLATION);
    }

    // …and it must NOT fire on an ended row, which the index also permits.
    await dataSource.manager.clear(ProtocolAssignment);
    await seed({ status: ProtocolAssignmentStatus.ENDED, endedAt: new Date('2026-06-10') });

    expect(await dataSource.manager.findOne(ProtocolAssignment, { where: guardWhere })).toBeNull();
  });
});
