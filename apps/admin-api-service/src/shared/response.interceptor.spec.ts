import type { CallHandler, ExecutionContext } from '@nestjs/common';
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
