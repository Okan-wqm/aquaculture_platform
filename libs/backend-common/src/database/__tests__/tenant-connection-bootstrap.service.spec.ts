import { requestContextStorage } from '../../logging/request-context';
import { createTenantConnectionBootstrap } from '../tenant-connection-bootstrap.service';

describe('createTenantConnectionBootstrap', () => {
  it('derives tenant search_path from tenantId when schemaName is absent', async () => {
    const { dataSource, pool, client } = createDataSourceMock();
    const Bootstrap = createTenantConnectionBootstrap('messaging');
    new Bootstrap(dataSource).onModuleInit();

    await requestContextStorage.run(
      { tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      async () => {
        await new Promise<void>((resolve, reject) => {
          pool.connect((err: Error | null) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          });
        });
      },
    );

    expect(client.query).toHaveBeenCalledWith(
      'SET search_path TO "tenant_aaaaaaaaaaaa4aaa", "messaging", public',
    );
  });

  it('uses explicit schemaName before deriving from tenantId', async () => {
    const { dataSource, pool, client } = createDataSourceMock();
    const Bootstrap = createTenantConnectionBootstrap('messaging');
    new Bootstrap(dataSource).onModuleInit();

    await requestContextStorage.run(
      {
        tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        schemaName: 'tenant_bbbbbbbbbbbb4bbb',
      },
      async () => {
        await new Promise<void>((resolve, reject) => {
          pool.connect((err: Error | null) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          });
        });
      },
    );

    expect(client.query).toHaveBeenCalledWith(
      'SET search_path TO "tenant_bbbbbbbbbbbb4bbb", "messaging", public',
    );
  });
});

function createDataSourceMock(): {
  dataSource: never;
  pool: {
    connect: jest.Mock;
  };
  client: {
    query: jest.Mock;
    release: jest.Mock;
  };
} {
  const client = {
    query: jest.fn((_sql: string) => Promise.resolve()),
    release: jest.fn(),
  };
  const doneFn = jest.fn();
  const pool = {
    connect: jest.fn(
      (callback?: (err: Error | null, pgClient: unknown, release: typeof doneFn) => void) => {
        if (typeof callback === 'function') {
          callback(null, client, doneFn);
          return undefined;
        }
        return Promise.resolve(client);
      },
    ),
  };
  const dataSource = {
    driver: {
      master: pool,
    },
  };

  return { dataSource: dataSource as never, pool, client };
}
