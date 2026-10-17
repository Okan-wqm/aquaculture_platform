import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { SortOrder } from '@aquaculture/backend-common/pagination';
import { collaborator } from '@aquaculture/testing';
import { DataSource, type QueryRunner, type Repository } from 'typeorm';

import { OpcUaAdapter } from '../../../protocol/adapters/industrial/opcua.adapter';
import { PlcPaginationDto } from '../../dto/plc-connection.dto';
import { FeedingParameter, ParameterStatus } from '../../entities/feeding-parameter.entity';
import { PlcConnection } from '../../entities/plc-connection.entity';
import { FeedingParameterService } from '../feeding-parameter.service';

/**
 * Feeding sends read as a send log, on real Postgres (command log,
 * /sensor/commands).
 *
 * The log asks `feedingParameters` for the sets that left the draft state,
 * newest send first, one page at a time. Two properties only the database
 * can show, through the very query builder the service runs (a joined
 * relation + skip/take is TypeORM's two-query pagination path):
 *  - `sentOnly` filters on the server, so a page of sends is never emptied
 *    by drafts edited more recently than any send, and `total` counts sends;
 *  - `lastSendAttemptAt` orders by when the send happened — sentAt once the
 *    PLC write succeeded, else the failed or pending attempt (updatedAt) — so
 *    activating an older send later does not lift it above a newer one, and a
 *    failed send stays in time order instead of sinking below every success.
 */

const TENANT = '8b7a6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d';

/**
 * The feeding-parameter repository as findAll uses it: its query builder,
 * built over the real database the way TypeORM's Repository.createQueryBuilder
 * builds it (the manager's builder for the entity under the caller's alias),
 * so the SQL the spec runs is the service's own. findAll touches no other
 * repository member; reaching for one fails naming it, instead of passing
 * against a repository the service no longer uses that way.
 */
function feedingParameterRepository(dataSource: DataSource): Repository<FeedingParameter> {
  return collaborator<Repository<FeedingParameter>>(
    {
      createQueryBuilder: (alias?: string, queryRunner?: QueryRunner) =>
        dataSource.manager.createQueryBuilder(
          FeedingParameter,
          alias ?? dataSource.getMetadata(FeedingParameter).targetName,
          queryRunner,
        ),
    },
    'FeedingParameterRepository',
  );
}

jest.setTimeout(180_000);

describe('FeedingParameterService.findAll as a send log', () => {
  let harness: HarnessContext | undefined;
  let dataSource: DataSource | undefined;
  let service: FeedingParameterService;
  let connectionId: string;

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    dataSource = new DataSource({
      type: 'postgres',
      ...harness.connectionOptions,
      entities: [FeedingParameter, PlcConnection],
      synchronize: true,
    });
    await dataSource.initialize();

    // findAll reaches the connection through the join, never through its own
    // repository, and sends nothing to a PLC.
    service = new FeedingParameterService(
      feedingParameterRepository(dataSource),
      collaborator<Repository<PlcConnection>>({}, 'PlcConnectionRepository'),
      collaborator<OpcUaAdapter>({}, 'OpcUaAdapter'),
    );

    const [connection] = await dataSource.query<Array<{ id: string }>>(
      `INSERT INTO plc_connections (tenant_id, "siteId", name, "endpointUrl")
       VALUES ($1, 'site-1', 'Hall A PLC', 'opc.tcp://plc.local:4840') RETURNING id`,
      [TENANT],
    );
    if (connection === undefined) throw new Error('plc_connections insert returned no row');
    connectionId = connection.id;
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (harness) await shutdownHarness(harness);
  });

  beforeEach(async () => {
    await dataSource!.query(`DELETE FROM feeding_parameters`);
  });

  /** A page of the list, sorted as the command log asks or as the caller says. */
  function pageOf(page: number, limit: number, sortBy = 'lastSendAttemptAt'): PlcPaginationDto {
    return Object.assign(new PlcPaginationDto(), {
      page,
      limit,
      sortBy,
      sortOrder: SortOrder.DESC,
    });
  }

  /** A set as the send flow leaves it: its status, when it was sent (if it was) and last changed. */
  async function seed(
    name: string,
    status: ParameterStatus,
    sentAt: string | null,
    updatedAt: string,
  ): Promise<void> {
    await dataSource!.query(
      `INSERT INTO feeding_parameters
         (tenant_id, "plcConnectionId", name, "biomassKg", fcr, "targetDailyFeedKg",
          schedule, thresholds, "vfdSettings", status, "sentAt", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, 1200, 1.1, 24, '[]', '{}', '{}', $4, $5, $6, $6)`,
      [TENANT, connectionId, name, status, sentAt, updatedAt],
    );
  }

  it('pages over sends only: drafts newer than every send neither fill nor count a page', async () => {
    await seed('Send 1', ParameterStatus.SENT, '2026-10-12T08:00:00Z', '2026-10-12T08:00:00Z');
    await seed(
      'Send 2',
      ParameterStatus.SUPERSEDED,
      '2026-10-13T08:00:00Z',
      '2026-10-14T09:00:00Z',
    );
    await seed('Send 3', ParameterStatus.ACTIVE, '2026-10-14T08:00:00Z', '2026-10-14T09:00:00Z');
    for (let draft = 1; draft <= 5; draft += 1) {
      await seed(`Draft ${draft}`, ParameterStatus.DRAFT, null, `2026-10-16T0${draft}:00:00Z`);
    }

    const first = await service.findAll(TENANT, { sentOnly: true }, pageOf(1, 2));
    const second = await service.findAll(TENANT, { sentOnly: true }, pageOf(2, 2));

    expect(first.items.map((row) => row.name)).toEqual(['Send 3', 'Send 2']);
    expect(second.items.map((row) => row.name)).toEqual(['Send 1']);
    expect(first.total).toBe(3);
    expect(first.totalPages).toBe(2);
  });

  it('orders by when the send happened, not by the last change of the set', async () => {
    // Sent Monday, activated Wednesday: updatedAt moves, the send does not.
    await seed(
      'Monday send',
      ParameterStatus.ACTIVE,
      '2026-10-12T08:00:00Z',
      '2026-10-14T10:00:00Z',
    );
    await seed(
      'Tuesday send',
      ParameterStatus.SENT,
      '2026-10-13T08:00:00Z',
      '2026-10-13T08:00:00Z',
    );
    // Failed Thursday: no sentAt, the attempt is its last change.
    await seed('Thursday failure', ParameterStatus.ERROR, null, '2026-10-15T08:00:00Z');

    const page = await service.findAll(TENANT, { sentOnly: true }, pageOf(1, 10));

    expect(page.items.map((row) => row.name)).toEqual([
      'Thursday failure',
      'Tuesday send',
      'Monday send',
    ]);
    // Each row still carries its connection: the join survives the two-query pagination.
    expect(page.items.every((row) => row.plcConnection.name === 'Hall A PLC')).toBe(true);
  });

  it('leaves the plain list unchanged: without sentOnly every set is listed, drafts included', async () => {
    await seed('Send', ParameterStatus.SENT, '2026-10-12T08:00:00Z', '2026-10-12T08:00:00Z');
    await seed('Draft', ParameterStatus.DRAFT, null, '2026-10-16T08:00:00Z');

    const page = await service.findAll(TENANT, undefined, pageOf(1, 10, 'updatedAt'));

    expect(page.items.map((row) => row.name)).toEqual(['Draft', 'Send']);
  });
});
