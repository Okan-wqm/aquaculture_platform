/**
 * Shared test helpers for NATS event handler tenant isolation tests.
 *
 * These helpers standardise how we mock DataSource + QueryRunner across
 * services that handle NATS events outside the HTTP request context.
 *
 * Two handler patterns exist in the platform:
 *   1. QueryRunner pattern — explicit SET search_path (farm-service)
 *   2. AsyncLocalStorage pattern — requestContextStorage.run() (alert-engine)
 *
 * Both patterns MUST:
 *   - Reject events without tenantId
 *   - Reject events with invalid UUID format
 *   - Derive the correct 16-char hex schema name
 *   - Clean up resources on success AND failure
 *
 * @module BackendCommon/Database/TestHelpers
 */
import { DataSource, QueryRunner, EntityManager, type EntityTarget } from 'typeorm';

/**
 * Creates a mock DataSource with a mock QueryRunner for testing
 * NATS handlers that use the QueryRunner pattern.
 *
 * Returns all three mocks so tests can set up expectations on any layer.
 */
export function createMockDataSourceWithQueryRunner(): {
  mockDataSource: jest.Mocked<DataSource>;
  mockQueryRunner: jest.Mocked<QueryRunner>;
  mockManager: jest.Mocked<EntityManager>;
} {
  const mockManager = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest
      .fn()
      .mockImplementation((_entity: EntityTarget<object>, data: Record<string, unknown>) =>
        Promise.resolve({ id: 'mock-id', ...data }),
      ),
    create: jest
      .fn()
      .mockImplementation((_entity: EntityTarget<object>, data: Record<string, unknown>) => data),
    getRepository: jest.fn().mockReturnValue({
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockResolvedValue({}),
    }),
  } as unknown as jest.Mocked<EntityManager>;

  const mockQueryRunner = {
    connect: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([]),
    release: jest.fn().mockResolvedValue(undefined),
    manager: mockManager,
  } as unknown as jest.Mocked<QueryRunner>;

  const mockDataSource = {
    createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
    query: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<DataSource>;

  return { mockDataSource, mockQueryRunner, mockManager };
}

/** Standard valid UUID v4 for tests */
export const TEST_TENANT_ID = '4b529829-ea79-48da-982c-cd6fbec8ffb7';

/** Expected schema name for TEST_TENANT_ID (first 16 hex chars, no dashes) */
export const TEST_TENANT_SCHEMA = 'tenant_4b529829ea7948da';

/** A second tenant UUID for cross-tenant isolation tests */
export const TEST_TENANT_ID_2 = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';
export const TEST_TENANT_SCHEMA_2 = 'tenant_aaaabbbbccccdddd';

/** Invalid UUID strings for parameterized tests */
export const INVALID_UUIDS: [string, string][] = [
  ['empty string', ''],
  ['plain string', 'not-a-uuid'],
  ['SQL injection', "'; DROP TABLE sensors; --"],
  ['partial UUID', '4b529829-ea79'],
  ['UUID with extra chars', '4b529829-ea79-48da-982c-cd6fbec8ffb7-extra'],
  ['path traversal', '../../../etc/passwd'],
  ['numeric only', '12345678'],
];

/**
 * Asserts that a QueryRunner was properly cleaned up.
 * Checks: RESET search_path was called, release() was called.
 */
export function expectQueryRunnerCleanedUp(mockQueryRunner: jest.Mocked<QueryRunner>): void {
  const queryCalls: unknown[] = mockQueryRunner.query.mock.calls.map(
    (call: readonly unknown[]) => call[0],
  );
  expect(queryCalls).toContain('RESET search_path');
  expect(mockQueryRunner.release).toHaveBeenCalled();
}

/**
 * Asserts that SET search_path was called with the expected schema.
 *
 * @param mockQueryRunner - The mocked QueryRunner
 * @param expectedSchema  - Tenant schema name (e.g. "tenant_4b529829ea7948da")
 * @param moduleSchema    - Module schema name (e.g. "farm", "sensor")
 */
export function expectSearchPathSet(
  mockQueryRunner: jest.Mocked<QueryRunner>,
  expectedSchema: string,
  moduleSchema: string,
): void {
  expect(mockQueryRunner.query).toHaveBeenCalledWith(
    `SET search_path TO "${expectedSchema}", ${moduleSchema}, public`,
  );
}
