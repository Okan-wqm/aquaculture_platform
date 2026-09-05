import {
  dropSchemaCreatedByFailedProvision,
  tenantSchemaExists,
} from '../tenant-provision-failure-cleanup';

/**
 * INFRA-HIGH-150 — a failed PROVISION drops the schema it created, and only
 * that one. The executor is scripted so the decision is pinned without a live
 * database; processJob feeds it the pre-CREATE probe's answer.
 */

const TENANT = 'tenant_7f6b08ab90e246d3';

function scriptedExecutor(options: { exists?: boolean; failDrop?: boolean } = {}): {
  executor: { query(sql: string, params?: readonly unknown[]): Promise<unknown> };
  issued: string[];
} {
  const issued: string[] = [];
  const executor = {
    query(sql: string): Promise<unknown> {
      issued.push(sql);
      if (sql.includes('information_schema.schemata')) {
        return Promise.resolve([{ exists: options.exists ?? false }]);
      }
      if (options.failDrop === true && sql.includes('DROP SCHEMA')) {
        return Promise.reject(new Error('cannot drop: other session holds a lock'));
      }
      return Promise.resolve([]);
    },
  };
  return { executor, issued };
}

const drops = (issued: string[]): string[] => issued.filter((sql) => sql.includes('DROP SCHEMA'));

describe('tenantSchemaExists', () => {
  it('reports the catalog answer for the tenant namespace', async () => {
    const { executor } = scriptedExecutor({ exists: true });
    await expect(tenantSchemaExists(executor, TENANT)).resolves.toBe(true);
    const absent = scriptedExecutor({ exists: false });
    await expect(tenantSchemaExists(absent.executor, TENANT)).resolves.toBe(false);
  });

  it('refuses a name outside the tenant namespace before querying', async () => {
    const { executor, issued } = scriptedExecutor();
    await expect(tenantSchemaExists(executor, 'farm')).rejects.toThrow(
      /outside the tenant namespace/,
    );
    expect(issued).toHaveLength(0);
  });
});

describe('dropSchemaCreatedByFailedProvision (INFRA-HIGH-150)', () => {
  it('drops the schema when this run created it', async () => {
    const { executor, issued } = scriptedExecutor();

    const outcome = await dropSchemaCreatedByFailedProvision(executor, {
      schemaName: TENANT,
      createdByThisRun: true,
    });

    expect(outcome).toEqual({ schemaName: TENANT, createdByThisRun: true, dropped: true });
    expect(drops(issued)).toEqual([`DROP SCHEMA IF EXISTS "${TENANT}" CASCADE`]);
  });

  it('leaves a schema that pre-existed this run untouched', async () => {
    // A retry after ADMIN-HIGH-009 meets the schema its first attempt left;
    // the ledger-driven fan-out resumes it, so it must not be dropped.
    const { executor, issued } = scriptedExecutor();

    const outcome = await dropSchemaCreatedByFailedProvision(executor, {
      schemaName: TENANT,
      createdByThisRun: false,
    });

    expect(outcome).toEqual({ schemaName: TENANT, createdByThisRun: false, dropped: false });
    expect(drops(issued)).toEqual([]);
  });

  it('records a drop failure instead of masking the provisioning error', async () => {
    const { executor } = scriptedExecutor({ failDrop: true });

    const outcome = await dropSchemaCreatedByFailedProvision(executor, {
      schemaName: TENANT,
      createdByThisRun: true,
    });

    expect(outcome).toEqual({
      schemaName: TENANT,
      createdByThisRun: true,
      dropped: false,
      dropError: 'cannot drop: other session holds a lock',
    });
  });

  it('refuses a name outside the tenant namespace before issuing any DDL', async () => {
    const { executor, issued } = scriptedExecutor();
    await expect(
      dropSchemaCreatedByFailedProvision(executor, {
        schemaName: 'public',
        createdByThisRun: true,
      }),
    ).rejects.toThrow(/outside the tenant namespace/);
    expect(issued).toHaveLength(0);
  });
});
