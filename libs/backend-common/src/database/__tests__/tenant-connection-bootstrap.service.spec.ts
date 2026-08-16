import { createTenantConnectionBootstrap } from '../tenant-connection-bootstrap.service';
import { requestContextStorage } from '../../logging/request-context';

describe('createTenantConnectionBootstrap', () => {
  it('fails boot closed with actionable remediation when the pg pool is absent', () => {
    const Bootstrap = createTenantConnectionBootstrap('messaging');
    const dataSource = { driver: {} } as never;

    expect(() => new Bootstrap(dataSource).onModuleInit()).toThrow(
      /TenantConnectionBootstrap\[messaging\].*REMEDIATION/,
    );
  });

  it('derives tenant search_path from tenantId when schemaName is absent', async () => {
    const { dataSource, pool, client } = createDataSourceMock();
    const Bootstrap = createTenantConnectionBootstrap('messaging');
    new Bootstrap(dataSource).onModuleInit();

    await requestContextStorage.run(
      { tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      async () => {
        await new Promise<void>((resolve, reject) => {
          pool.connect((err: Error | null) => {
            if (err) reject(err);
            else resolve();
          });
        });
      },
    );

    expect(client.query).toHaveBeenCalledWith(
      'SET search_path TO "tenant_aaaaaaaaaaaa4aaa", "messaging", public',
      expect.any(Function),
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
            if (err) reject(err);
            else resolve();
          });
        });
      },
    );

    expect(client.query).toHaveBeenCalledWith(
      'SET search_path TO "tenant_bbbbbbbbbbbb4bbb", "messaging", public',
      expect.any(Function),
    );
  });
});

function createDataSourceMock() {
  const client = {
    query: jest.fn((_sql: string, cb: (err: Error | null) => void) => cb(null)),
    release: jest.fn(),
  };
  const doneFn = jest.fn();
  const pool = {
    connect: jest.fn((callback?: (err: Error | null, pgClient: unknown, release: typeof doneFn) => void) => {
      if (typeof callback === 'function') {
        callback(null, client, doneFn);
        return undefined;
      }
      return Promise.resolve(client);
    }),
  };
  const dataSource = {
    driver: {
      master: pool,
    },
  };

  return { dataSource: dataSource as never, pool, client };
}
