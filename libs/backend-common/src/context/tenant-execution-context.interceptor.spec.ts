import { CallHandler, ExecutionContext, Type } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';

import { getTenantSchemaName } from '../database/tenant-schema.utils';
import { getRequestContext, requestContextStorage } from '../logging/request-context';

import { TenantExecutionContextInterceptor } from './tenant-execution-context.interceptor';

const TENANT_ID = '7f6b08ab-90e2-46d3-a260-cb985f1fd897';

interface TestRequest {
  tenantId?: string;
  user?: { tenantId?: string };
}

function createExecutionContext(options: {
  request?: TestRequest;
  graphQlContext?: { req?: TestRequest; request?: TestRequest };
}): ExecutionContext {
  const args = [undefined, undefined, options.graphQlContext] as const;
  return {
    getClass: <T = unknown>(): Type<T> => TenantExecutionContextInterceptor as unknown as Type<T>,
    getHandler: () => createExecutionContext,
    getArgs: <T extends unknown[] = unknown[]>(): T => args as unknown as T,
    getArgByIndex: <T = unknown>(index: number): T => args[index] as T,
    getType: <TContext extends string = ReturnType<ExecutionContext['getType']>>(): TContext => 'graphql' as TContext,
    switchToHttp: () => ({
      getRequest: <T = unknown>(): T => options.request as T,
      getResponse: <T = unknown>(): T => undefined as T,
      getNext: <T = unknown>(): T => undefined as T,
    }),
    switchToRpc: () => ({
      getContext: <T = unknown>(): T => undefined as T,
      getData: <T = unknown>(): T => undefined as T,
    }),
    switchToWs: () => ({
      getClient: <T = unknown>(): T => undefined as T,
      getData: <T = unknown>(): T => undefined as T,
      getPattern: (): string => '',
    }),
  };
}

describe('TenantExecutionContextInterceptor', () => {
  afterEach(() => {
    requestContextStorage.disable();
  });

  it('runs GraphQL resolver execution inside the tenant schema context', async () => {
    const interceptor = new TenantExecutionContextInterceptor();
    const context = createExecutionContext({
      graphQlContext: {
        req: {
          tenantId: TENANT_ID,
        },
      },
    });
    const next: CallHandler = {
      handle: () => of(getRequestContext()),
    };

    const result = await requestContextStorage.run(
      { correlationId: 'corr-1', userId: 'user-1' },
      () => lastValueFrom(interceptor.intercept(context, next)),
    );

    expect(result).toMatchObject({
      tenantId: TENANT_ID,
      schemaName: getTenantSchemaName(TENANT_ID),
      correlationId: 'corr-1',
      userId: 'user-1',
    });
  });

  it('passes through without tenant context when no valid tenant is present', async () => {
    const interceptor = new TenantExecutionContextInterceptor();
    const context = createExecutionContext({
      request: {
        tenantId: 'not-a-uuid',
      },
    });
    const next: CallHandler = {
      handle: () => of(getRequestContext()),
    };

    const result = await requestContextStorage.run(
      { correlationId: 'corr-2' },
      () => lastValueFrom(interceptor.intercept(context, next)),
    );

    expect(result).toEqual({ correlationId: 'corr-2' });
  });
});
