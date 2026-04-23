/**
 * Mock Repository factory for service-layer tests.
 *
 * Creates a jest.Mocked<Repository<T>> with all standard TypeORM methods.
 * Use with NestJS testing module:
 *   { provide: getRepositoryToken(Entity), useValue: createMockRepository() }
 */
import { ObjectLiteral, Repository } from 'typeorm';

export function createMockRepository<
  T extends ObjectLiteral = ObjectLiteral,
>(): jest.Mocked<Repository<T>> {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    findOneBy: jest.fn().mockResolvedValue(null),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
    save: jest.fn().mockImplementation((entity: unknown) => Promise.resolve(entity)),
    create: jest.fn().mockImplementation((data: unknown) => data),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    remove: jest.fn().mockResolvedValue({}),
    count: jest.fn().mockResolvedValue(0),
    exist: jest.fn().mockResolvedValue(false),
    createQueryBuilder: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      getOne: jest.fn().mockResolvedValue(null),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    }),
    metadata: {
      tableName: 'mock_table',
      columns: [],
    },
  } as unknown as jest.Mocked<Repository<T>>;
}
