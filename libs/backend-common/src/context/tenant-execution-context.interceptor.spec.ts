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
    getType: <TContext extends string = ReturnType<ExecutionContext['getType']>>(): TContext =>
      'graphql' as TContext,
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

/**
 * ORPHAN-CRITICAL-573 — a NATS command frame. No request, no guard chain:
 * the tenant is in the message payload or it is nowhere.
 *
 * Built by overriding the two members that differ from the HTTP/GraphQL
 * fixture rather than by restating the whole ExecutionContext shape, which
 * would mean re-introducing its casts for no new information.
 */
function createRpcExecutionContext(payload: unknown): ExecutionContext {
  const base = createExecutionContext({});
  return {
    ...base,
    getType: <TContext extends string = ReturnType<ExecutionContext['getType']>>(): TContext =>
      'rpc' as TContext,
    switchToRpc: () => ({
      getContext: <T = unknown>(): T => undefined as T,
      getData: <T = unknown>(): T => payload as T,
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

    const result = await requestContextStorage.run({ correlationId: 'corr-2' }, () =>
      lastValueFrom(interceptor.intercept(context, next)),
    );

    expect(result).toEqual({ correlationId: 'corr-2' });
  });

  describe('NATS command payloads (ORPHAN-CRITICAL-573)', () => {
    it('runs a tenant lifecycle command inside its own tenant context', async () => {
      // Before this arm existed the GUC stayed empty on every NATS command,
      // so each write to an RLS-armed auth table was refused and tenant
      // onboarding failed at step zero - silently, for months.
      const interceptor = new TenantExecutionContextInterceptor();
      const context = createRpcExecutionContext({ tenantId: TENANT_ID });
      const next: CallHandler = { handle: () => of(getRequestContext()) };

      const observed = await lastValueFrom(interceptor.intercept(context, next));

      expect((observed as { tenantId?: string } | undefined)?.tenantId).toBe(TENANT_ID);
      expect((observed as { schemaName?: string } | undefined)?.schemaName).toBe(
        getTenantSchemaName(TENANT_ID),
      );
    });

    it('leaves a platform-wide command without a tenant context', async () => {
      // Module catalogue commands legitimately carry no tenant. Unset is
      // fail-closed under the RLS predicate, which is the safe direction.
      const interceptor = new TenantExecutionContextInterceptor();
      const context = createRpcExecutionContext({ moduleId: 'farm' });
      const next: CallHandler = { handle: () => of(getRequestContext()) };

      const observed = await lastValueFrom(interceptor.intercept(context, next));

      expect((observed as { tenantId?: string } | undefined)?.tenantId).toBeUndefined();
    });

    it('refuses a malformed tenant id rather than binding it', async () => {
      const interceptor = new TenantExecutionContextInterceptor();
      const context = createRpcExecutionContext({ tenantId: 'not-a-uuid' });
      const next: CallHandler = { handle: () => of(getRequestContext()) };

      const observed = await lastValueFrom(interceptor.intercept(context, next));

      expect((observed as { tenantId?: string } | undefined)?.tenantId).toBeUndefined();
    });

    it('does not coerce a non-string tenant id', async () => {
      const interceptor = new TenantExecutionContextInterceptor();
      const context = createRpcExecutionContext({ tenantId: 42 });
      const next: CallHandler = { handle: () => of(getRequestContext()) };

      const observed = await lastValueFrom(interceptor.intercept(context, next));

      expect((observed as { tenantId?: string } | undefined)?.tenantId).toBeUndefined();
    });

    it('survives an empty payload', async () => {
      const interceptor = new TenantExecutionContextInterceptor();
      const context = createRpcExecutionContext(undefined);
      const next: CallHandler = { handle: () => of('ok') };

      await expect(lastValueFrom(interceptor.intercept(context, next))).resolves.toBe('ok');
    });
  });
});
