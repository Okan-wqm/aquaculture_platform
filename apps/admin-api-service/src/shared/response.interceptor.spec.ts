import { StreamableFile } from '@nestjs/common';
import type { CallHandler, ContextType } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { createStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import { firstValueFrom, of } from 'rxjs';

import { ResponseInterceptor } from './response.interceptor';

function handler<T>(value: T): CallHandler<T> {
  return { handle: () => of(value) };
}

function context(type: ContextType, url = '/v1/tenants'): ExecutionContextHost {
  const host = new ExecutionContextHost([{ url }]);
  host.setType(type);
  return host;
}

describe('ResponseInterceptor transport boundary', () => {
  it('applies the API envelope only to HTTP delivery', async () => {
    const payload = { operationId: 'op-1', acknowledged: true };
    const result = await firstValueFrom(
      new ResponseInterceptor<unknown>().intercept(context('rpc'), handler(payload)),
    );

    expect(result).toBe(payload);
  });

  it('wraps a plain HTTP result', async () => {
    const result = await firstValueFrom(
      new ResponseInterceptor<unknown>().intercept(context('http'), handler({ id: 'tenant-1' })),
    );

    expect(result).toMatchObject({
      success: true,
      data: { id: 'tenant-1' },
      meta: { timestamp: expect.any(String) },
    });
  });
});

describe('ResponseInterceptor pagination authority', () => {
  it('projects a factory-issued page into the one REST envelope', async () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    const page = createStandardPaginatedResult(rows, 5, 2, 2);
    const result = await firstValueFrom(
      new ResponseInterceptor<unknown>().intercept(context('http'), handler(page)),
    );

    expect(result).toMatchObject({
      success: true,
      data: rows,
      meta: {
        total: 5,
        page: 2,
        limit: 2,
        totalPages: 3,
        hasNextPage: true,
        hasPreviousPage: true,
        timestamp: expect.any(String),
      },
    });
  });

  it('rejects structural and legacy lookalikes at the transport boundary', async () => {
    const structuralDuplicate = {
      items: [{ id: 'structural' }],
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false,
    };
    const legacyDuplicate = {
      data: [{ id: 'legacy' }],
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
    };

    for (const duplicate of [structuralDuplicate, legacyDuplicate]) {
      await expect(
        firstValueFrom(
          new ResponseInterceptor<unknown>().intercept(context('http'), handler(duplicate)),
        ),
      ).rejects.toMatchObject({
        response: {
          code: 'UNISSUED_PAGINATION_RESULT',
        },
        status: 500,
      });
    }
  });

  it.each([new StreamableFile(Buffer.from('id,name\n1,a')), Buffer.from('binary-data')])(
    'passes binary payloads through without JSON wrapping',
    async (payload) => {
      const result = await firstValueFrom(
        new ResponseInterceptor<unknown>().intercept(context('http'), handler(payload)),
      );

      expect(result).toBe(payload);
    },
  );
});

describe('ResponseInterceptor route exclusions', () => {
  it('uses path-segment matching instead of prefix matching', async () => {
    const interceptor = new ResponseInterceptor<unknown>();
    const health = { status: 'ok' };

    await expect(
      firstValueFrom(interceptor.intercept(context('http', '/v1/health'), handler(health))),
    ).resolves.toBe(health);
    await expect(
      firstValueFrom(interceptor.intercept(context('http', '/v1/health-evil'), handler(health))),
    ).resolves.toMatchObject({ success: true, data: health });
  });
});
