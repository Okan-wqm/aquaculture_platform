/**
 * Code generator tenant sequence concurrency tests.
 *
 * WHY: Tank creation can enter the same tenant through multiple handlers
 * (`CreateTankHandler` and tank-like `CreateEquipmentHandler`). Code
 * generation must therefore be one tenant-local atomic sequence, not a
 * per-handler counter and not a source-schema write.
 */
import 'reflect-metadata';
import { randomBytes } from 'crypto';

import { getTenantSchemaName } from '@aquaculture/backend-common';
import { bootPostgresContainer, HarnessContext, shutdownHarness } from '@platform/migration-harness';
import { DataSource } from 'typeorm';

import { CodeSequence } from '../../database/entities/code-sequence.entity';
import { CodeGeneratorService } from '../../database/services/code-generator.service';
import { createTenantSchemaFromSource } from './helpers/tenant-schema-harness';

const TENANT_A = '4b529829-ea79-48da-982c-cd6fbec8ffb7';
const TENANT_B = '7c2f4e10-3d2a-4b4e-9f18-f8b16f0d5a10';

jest.setTimeout(120_000);

describe('CodeGeneratorService tenant-local sequence on real Postgres', () => {
  let pg: HarnessContext | undefined;
  let dataSource: DataSource | undefined;
  let service: CodeGeneratorService;

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE SCHEMA farm');

    dataSource = new DataSource({
      type: 'postgres',
      ...pg.connectionOptions,
      name: `farm-service-code-generator-${randomBytes(4).toString('hex')}`,
      entities: [CodeSequence],
      synchronize: true,
      logging: false,
      extra: {
        options: '-c search_path=farm,public',
      },
    });

    await dataSource.initialize();
    await createTenantSchemaFromSource(dataSource, getTenantSchemaName(TENANT_A), ['code_sequences']);
    await createTenantSchemaFromSource(dataSource, getTenantSchemaName(TENANT_B), ['code_sequences']);

    service = new CodeGeneratorService(dataSource.getRepository(CodeSequence), dataSource);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    await shutdownHarness(pg);
  });

  it('generates unique tenant-local tank codes under concurrent first-use calls', async () => {
    const year = new Date().getFullYear();
    const codes = await Promise.all(
      Array.from({ length: 10 }, () => service.generateTankCode(TENANT_A)),
    );

    expect(new Set(codes).size).toBe(codes.length);
    expect([...codes].sort()).toEqual(
      Array.from({ length: 10 }, (_, index) => `TNK-${year}-${String(index + 1).padStart(5, '0')}`),
    );
    expect(await sequenceRowCount('farm', TENANT_A)).toBe(0);
    expect(await sequenceRowCount(getTenantSchemaName(TENANT_A), TENANT_A)).toBe(1);
    expect(await sequenceRowCount(getTenantSchemaName(TENANT_B), TENANT_A)).toBe(0);
  });

  it('keeps identical sequence numbers isolated across tenants', async () => {
    const year = new Date().getFullYear();

    const tenantBFirstCode = await service.generateTankCode(TENANT_B);

    expect(tenantBFirstCode).toBe(`TNK-${year}-00001`);
    expect(await sequenceRowCount(getTenantSchemaName(TENANT_A), TENANT_B)).toBe(0);
    expect(await sequenceRowCount(getTenantSchemaName(TENANT_B), TENANT_B)).toBe(1);
  });

  async function sequenceRowCount(schema: string, tenantId: string): Promise<number> {
    const rows: Array<{ count: string }> = await dataSource!.query(
      `SELECT COUNT(*)::text AS count FROM "${schema}"."code_sequences" WHERE "tenantId" = $1`,
      [tenantId],
    );
    return Number(rows[0]?.count ?? 0);
  }
});
