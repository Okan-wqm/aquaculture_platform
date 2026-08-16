import { createStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import {
  ADMIN_HTTP_CONTRACT_VERSION,
  AdminHttpContractError,
  adminManualResponse,
  adminResponse,
  decodeAdminHttpEnvelopeV1,
  type AdminResponseContract as ExecutableAdminResponseContract,
  type AdminManualResponseProfile,
} from '@platform/admin-http-contracts';
import { CallHandler, ExecutionContext, StreamableFile } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { lastValueFrom, of } from 'rxjs';

import { AdminManualResponse, AdminResponseContract } from './admin-response-contract.decorator';
import { ResponseInterceptor } from './response.interceptor';

type TestRouteHandler = (...args: never[]) => unknown;

function contextFor(type: 'http' | 'rpc', handler?: TestRouteHandler): ExecutionContext {
  const request = {
    baseUrl: '',
    headers: { 'x-request-id': 'interceptor_request_123' },
    method: 'GET',
    route: { path: '/fixture' },
  };
  const response = {
    headersSent: false,
    setHeader: jest.fn(),
    statusCode: 200,
  };
  const context = new ExecutionContextHost([request, response], null, handler);
  context.setType(type);
  return context;
}

function applyMethodDecorator(
  handler: TestRouteHandler,
  decorator: MethodDecorator,
): TestRouteHandler {
  const descriptor: PropertyDescriptor = {
    configurable: true,
    enumerable: false,
    value: handler,
    writable: true,
  };
  decorator({}, 'handler', descriptor);
  return handler;
}

function contractHandler(
  contract: ExecutableAdminResponseContract<unknown, unknown>,
): TestRouteHandler {
  return applyMethodDecorator(() => undefined, AdminResponseContract(contract));
}

function bypassHandler(profile: AdminManualResponseProfile): TestRouteHandler {
  return applyMethodDecorator(() => undefined, AdminManualResponse(profile));
}

const healthProfile = adminManualResponse.health(
  [200],
  adminResponse.object({ status: adminResponse.literal('ok') }),
);
const binaryProfile = adminManualResponse.binary([200], ['application/pdf'], 1_024);

function handlerFor<T>(value: T): CallHandler<T> {
  return { handle: () => of(value) };
}

describe('ResponseInterceptor', () => {
  const interceptor = new ResponseInterceptor<unknown>();

  it('encodes a canonical application page as the v1 page envelope', async () => {
    const page = createStandardPaginatedResult([{ id: 'tenant-1' }], 3, 1, 1);

    const result = await lastValueFrom(
      interceptor.intercept(
        contextFor(
          'http',
          contractHandler(adminResponse.page(adminResponse.object({ id: adminResponse.string() }))),
        ),
        handlerFor(page),
      ),
    );
    const envelope = decodeAdminHttpEnvelopeV1(result);

    expect(result).toMatchObject({
      contractVersion: ADMIN_HTTP_CONTRACT_VERSION,
      success: true,
      data: [{ id: 'tenant-1' }],
      meta: {
        requestId: 'interceptor_request_123',
        pagination: { total: 3, page: 1, limit: 1, totalPages: 3 },
      },
    });
    expect(envelope.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('preserves an honest empty stale page through the backend envelope boundary', async () => {
    const page = createStandardPaginatedResult<{ id: string }>([], 0, 2, 10);

    const result = await lastValueFrom(
      interceptor.intercept(
        contextFor(
          'http',
          contractHandler(adminResponse.page(adminResponse.object({ id: adminResponse.string() }))),
        ),
        handlerFor(page),
      ),
    );

    expect(result).toMatchObject({
      data: [],
      meta: {
        pagination: { total: 0, page: 2, limit: 10, totalPages: 1 },
      },
    });
  });

  it('encodes an ordinary value with an explicit data key', async () => {
    const result = await lastValueFrom(
      interceptor.intercept(
        contextFor('http', contractHandler(adminResponse.object({ id: adminResponse.string() }))),
        handlerFor({ id: 'tenant-1' }),
      ),
    );

    expect(result).toMatchObject({
      contractVersion: ADMIN_HTTP_CONTRACT_VERSION,
      success: true,
      data: { id: 'tenant-1' },
    });
  });

  it('encodes a void command as an explicit null data value', async () => {
    const result = await lastValueFrom(
      interceptor.intercept(
        contextFor('http', contractHandler(adminResponse.void())),
        handlerFor(undefined),
      ),
    );

    expect(result).toMatchObject({
      contractVersion: ADMIN_HTTP_CONTRACT_VERSION,
      success: true,
      data: null,
    });
  });

  it('does not guess a partial legacy pagination object into page metadata', async () => {
    const partial = { items: [{ id: 'tenant-1' }], total: 1 };
    const result = await lastValueFrom(
      interceptor.intercept(
        contextFor(
          'http',
          contractHandler(
            adminResponse.object({
              items: adminResponse.array(adminResponse.object({ id: adminResponse.string() })),
              total: adminResponse.number(),
            }),
          ),
        ),
        handlerFor(partial),
      ),
    );

    expect(result).toMatchObject({ data: partial, meta: { timestamp: expect.any(String) } });
    expect((result as { meta: Record<string, unknown> }).meta).not.toHaveProperty('pagination');
  });

  it('keeps an exact page-shaped ordinary object in data when the DAG root is object', async () => {
    const pageLike = {
      items: [{ id: 'ordinary-value' }],
      total: 1,
      page: 1,
      limit: 1,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false,
    };
    const result = await lastValueFrom(
      interceptor.intercept(
        contextFor(
          'http',
          contractHandler(
            adminResponse.object({
              items: adminResponse.array(adminResponse.object({ id: adminResponse.string() })),
              total: adminResponse.number(),
              page: adminResponse.number(),
              limit: adminResponse.number(),
              totalPages: adminResponse.number(),
              hasNextPage: adminResponse.boolean(),
              hasPreviousPage: adminResponse.boolean(),
            }),
          ),
        ),
        handlerFor(pageLike),
      ),
    );

    expect(result).toMatchObject({ data: pageLike, meta: { timestamp: expect.any(String) } });
    expect((result as { meta: Record<string, unknown> }).meta).not.toHaveProperty('pagination');
  });

  it.each([
    ['NATS/RPC value', contextFor('rpc'), { event: 'unchanged' }],
    ['health value', contextFor('http', bypassHandler(healthProfile)), { status: 'ok' }],
  ])('passes through an excluded %s', async (_name, context, value) => {
    const result = await lastValueFrom(interceptor.intercept(context, handlerFor(value)));
    if (context.getType() === 'rpc') {
      expect(result).toBe(value);
    } else {
      expect(result).toEqual(value);
      expect(Object.getPrototypeOf(result)).toBeNull();
      expect(Object.isFrozen(result)).toBe(true);
    }
  });

  it.each([
    ['buffer', Buffer.from('export')],
    ['stream', new StreamableFile(Buffer.from('export'))],
  ])('passes through a %s response', async (_name, value) => {
    await expect(
      lastValueFrom(
        interceptor.intercept(contextFor('http', bypassHandler(binaryProfile)), handlerFor(value)),
      ),
    ).resolves.toBe(value);
  });

  it('fails closed when an HTTP route declares no response authority', () => {
    expect(() =>
      interceptor.intercept(
        contextFor('http', () => undefined),
        handlerFor({}),
      ),
    ).toThrow(AdminHttpContractError);
  });

  it('rejects structurally plausible but fabricated contract metadata', () => {
    expect(() =>
      interceptor.intercept(
        contextFor('http', contractHandler({ kind: 'string' })),
        handlerFor('must-not-cross'),
      ),
    ).toThrow('HTTP route has neither an executable response contract nor a typed bypass');
  });

  it('rejects binary data behind a JSON response contract', async () => {
    await expect(
      lastValueFrom(
        interceptor.intercept(
          contextFor('http', contractHandler(adminResponse.object({ id: adminResponse.string() }))),
          handlerFor(Buffer.from('export')),
        ),
      ),
    ).rejects.toThrow('binary response requires an executable binary response profile');
  });
});
