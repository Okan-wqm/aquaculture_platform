import { StreamableFile } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { createStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import { firstValueFrom, of } from 'rxjs';

import { ResponseInterceptor } from './response.interceptor';

/**
 * Regression guard for APA-030: the {success,data,meta} envelope is an HTTP
 * response contract. In the hybrid app the same APP_INTERCEPTOR wraps NATS
 * (rpc) message handlers, whose return value must not be reshaped. Before the
 * fix the interceptor called switchToHttp().getRequest().url unconditionally
 * and would have thrown on every event.
 */
describe('ResponseInterceptor — hybrid-app RPC passthrough (APA-030)', () => {
  function callHandler<T>(value: T): CallHandler<T> {
    return { handle: () => of(value) };
  }

  // Fully-typed ExecutionContext double: every method is a jest.fn() (assignable
  // to the framework interface, including its generic getType), so no cast is
  // needed. Only the two methods under test carry behaviour.
  function executionContext(type: 'http' | 'rpc', requestUrl?: string): ExecutionContext {
    const context: ExecutionContext = {
      getType: jest.fn(),
      getClass: jest.fn(),
      getHandler: jest.fn(),
      getArgs: jest.fn(),
      getArgByIndex: jest.fn(),
      switchToRpc: jest.fn(),
      switchToWs: jest.fn(),
      switchToHttp: jest.fn(),
    };
    (context.getType as jest.Mock).mockReturnValue(type);
    (context.switchToHttp as jest.Mock).mockImplementation(() => {
      if (requestUrl === undefined) {
        throw new Error('switchToHttp() must not be called for an rpc context');
      }
      return { getRequest: () => ({ url: requestUrl }), getResponse: () => ({}), getNext: () => ({}) };
    });
    return context;
  }

  it('passes an rpc result through untouched (no envelope, no switchToHttp)', async () => {
    const interceptor = new ResponseInterceptor<unknown>();
    const payload = { operationId: 'op-1', ack: true };

    const result = await firstValueFrom(
      interceptor.intercept(executionContext('rpc'), callHandler(payload)),
    );

    expect(result).toBe(payload);
  });

  it('wraps an HTTP result in the {success,data,meta} envelope', async () => {
    const interceptor = new ResponseInterceptor<unknown>();

    const result = await firstValueFrom(
      interceptor.intercept(executionContext('http', '/v1/tenants'), callHandler({ id: 't-1' })),
    );

    const envelope = result as { success: boolean; data: unknown; meta: { timestamp: string } };
    expect(envelope.success).toBe(true);
    expect(envelope.data).toEqual({ id: 't-1' });
    expect(typeof envelope.meta.timestamp).toBe('string');
  });
});

/**
 * RC-1 canonical paginated-response envelope. The interceptor recognises the
 * ONE canonical shape (createStandardPaginatedResult) and lifts the items array
 * into `data` with pagination numerics in `meta`; binary downloads pass through.
 * RC-1b (ADMIN-CRITICAL-007) removed the legacy {data,total} duck-typed branch:
 * every admin-api list producer now emits the canonical shape, so a hand-rolled
 * {data,total} literal is NOT recognised and falls to the default object wrap.
 */
describe('ResponseInterceptor — RC-1 canonical pagination envelope', () => {
  function httpContext(): ExecutionContext {
    const context: ExecutionContext = {
      getType: jest.fn(),
      getClass: jest.fn(),
      getHandler: jest.fn(),
      getArgs: jest.fn(),
      getArgByIndex: jest.fn(),
      switchToRpc: jest.fn(),
      switchToWs: jest.fn(),
      switchToHttp: jest.fn(),
    };
    (context.getType as jest.Mock).mockReturnValue('http');
    (context.switchToHttp as jest.Mock).mockReturnValue({
      getRequest: () => ({ url: '/v1/system/settings/feature-toggles' }),
      getResponse: () => ({}),
      getNext: () => ({}),
    });
    return context;
  }
  function handler<T>(value: T): CallHandler<T> {
    return { handle: () => of(value) };
  }

  it('lifts the canonical shape: items -> data, numerics -> meta', async () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    const produced = createStandardPaginatedResult(rows, 5, 2, 2);
    const result = (await firstValueFrom(
      new ResponseInterceptor<unknown>().intercept(httpContext(), handler(produced)),
    )) as { success: boolean; data: unknown; meta: Record<string, unknown> };

    expect(result.success).toBe(true);
    expect(result.data).toEqual(rows); // the array, not the {items,...} object
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.meta.total).toBe(5);
    expect(result.meta.page).toBe(2);
    expect(result.meta.limit).toBe(2);
    expect(result.meta.totalPages).toBe(3);
  });

  it('passes a StreamableFile through untouched (no JSON envelope)', async () => {
    const file = new StreamableFile(Buffer.from('col1,col2\n1,2'));
    const result = await firstValueFrom(
      new ResponseInterceptor<unknown>().intercept(httpContext(), handler(file)),
    );
    expect(result).toBe(file);
  });

  it('does NOT lift a legacy {data,total} literal (RC-1b removed the branch)', async () => {
    // A hand-rolled {data,total} object is no longer duck-typed into the
    // paginated envelope. It falls to the default wrap, so the whole object
    // lands under `data` and `meta` carries only a timestamp. This is what
    // makes a missed producer LOUD (the FE list breaks) instead of silently
    // half-working — the admin-api-paginated-canonical invariant then fails
    // the build on any such literal in source.
    const legacy = { data: [{ id: 'x' }], total: 1, page: 1, limit: 20, totalPages: 1 };
    const result = (await firstValueFrom(
      new ResponseInterceptor<unknown>().intercept(httpContext(), handler(legacy)),
    )) as { success: boolean; data: unknown; meta: Record<string, unknown> };
    expect(result.data).toEqual(legacy); // NOT lifted — wrapped whole
    expect(result.meta.total).toBeUndefined();
    expect(typeof result.meta.timestamp).toBe('string');
  });

  it('generic-wraps a plain non-paginated object', async () => {
    const result = (await firstValueFrom(
      new ResponseInterceptor<unknown>().intercept(httpContext(), handler({ ok: true })),
    )) as { success: boolean; data: unknown; meta: Record<string, unknown> };
    expect(result.data).toEqual({ ok: true });
    expect(result.meta.page).toBeUndefined();
  });
});
