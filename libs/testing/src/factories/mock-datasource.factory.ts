/**
 * Mock DataSource factory for CQRS handler tests.
 *
 * Provides a complete DataSource → QueryRunner → EntityManager mock chain
 * for handlers that use the transaction pattern:
 *   const qr = dataSource.createQueryRunner();
 *   await qr.connect(); await qr.startTransaction();
 *   ... qr.manager.findOne / qr.manager.save ...
 *   await qr.commitTransaction(); qr.release();
 *
 * WHY: Every CQRS handler in the platform uses this pattern.
 * Without a shared factory, each test file duplicates 30+ lines
 * of mock setup that must be kept in sync as the QueryRunner API evolves.
 */
import { DataSource, QueryRunner, EntityManager, ObjectLiteral, Repository } from 'typeorm';

export interface MockDataSourceResult {
  mockDataSource: jest.Mocked<DataSource>;
  mockQueryRunner: jest.Mocked<QueryRunner>;
  mockManager: jest.Mocked<EntityManager>;
}

export function createMockDataSource(): MockDataSourceResult {
  const mockManager = {
    find: jest.fn().mockResolvedValue([]),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockImplementation((_entityClassOrEntity: unknown, maybeData?: unknown) =>
      Promise.resolve(maybeData ?? _entityClassOrEntity),
    ),
    create: jest.fn().mockImplementation((_entityClassOrData: unknown, maybeData?: unknown) =>
      maybeData ?? _entityClassOrData,
    ),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    // Chainable no-op query builder — handlers use `.createQueryBuilder().update()
    // .set().where().execute()` for column-scoped writes (e.g. biomass-only updates
    // that must not clobber a sibling column). Returns a self-referencing chain so
    // any `.update/.set/.where/...` sequence resolves.
    createQueryBuilder: jest.fn(() => {
      const qb: Record<string, jest.Mock> = {};
      for (const method of ['update', 'set', 'where', 'andWhere', 'from', 'values', 'returning', 'select', 'leftJoin', 'orderBy']) {
        qb[method] = jest.fn(() => qb);
      }
      qb.execute = jest.fn().mockResolvedValue({ affected: 1, raw: [] });
      qb.getMany = jest.fn().mockResolvedValue([]);
      qb.getOne = jest.fn().mockResolvedValue(null);
      return qb;
    }),
    getRepository: jest.fn().mockReturnValue({
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockImplementation((data: unknown) => Promise.resolve(data)),
    create: jest.fn().mockImplementation((data: unknown) => data),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    count: jest.fn().mockResolvedValue(0),
    } as unknown as jest.Mocked<Repository<ObjectLiteral>>),
  } as unknown as jest.Mocked<EntityManager>;

  const mockQueryRunner = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([]),
    manager: mockManager,
  } as unknown as jest.Mocked<QueryRunner>;

  const mockDataSource = {
    createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
    query: jest.fn().mockResolvedValue([]),
    getRepository: jest.fn().mockReturnValue({
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockResolvedValue({}),
    }),
  } as unknown as jest.Mocked<DataSource>;

  return { mockDataSource, mockQueryRunner, mockManager };
}
