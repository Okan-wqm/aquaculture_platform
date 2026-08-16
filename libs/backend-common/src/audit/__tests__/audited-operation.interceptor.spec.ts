import { mockCallArgument } from '@aquaculture/testing';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, of, lastValueFrom, throwError } from 'rxjs';
import { DataSource } from 'typeorm';

import { requestContextStorage } from '../../logging/request-context';
import { AuditLogEntity, AuditMethod, AuditResult, AuditSeverity } from '../audit-log.entity';
import { AuditedOperationOptions } from '../audited-operation.decorator';
import { AuditedOperationInterceptor } from '../audited-operation.interceptor';

/**
 * AuditedOperationInterceptor — pin AUDITTRAIL-CRITICAL-004 mandatory-
 * shape population on the V2 (canonical) interceptor path.
 *
 * # Why this spec exists
 *
 * The interceptor sits between the @AuditedOperation decorator and the
 * audit-row write. It owns the responsibility of populating the four
 * context-derived mandatory-shape fields:
 *
 *   - actorHomeTenantId — actor's home tenant (from JWT)
 *   - actedOnTenantId   — target tenant (same value in non-impersonation
 *                         contexts; impersonation paths set them
 *                         distinctly via the AuditLogService directly)
 *   - method            — channel (HTTP / GRAPHQL / NATS) derived from
 *                         the Nest ExecutionContext type
 *   - mfaVerified       — boolean from JWT claim or RPC command field
 *   - result            — SUCCESS or FAILED per AuditedOperationStatus
 *
 * The other four mandatory-shape fields (preStateHash, postStateHash,
 * justification, relatedAuditIds) are caller-domain knowledge and are
 * NOT populated here — by design.
 *
 * Specs below assert that the audit row written through the canonical
 * `dataSource.manager.save(AuditLogEntity, row)` path carries the
 * five context-derived fields exactly.
 */
describe('AuditedOperationInterceptor — mandatory-shape population', () => {
  let dataSource: { manager: { save: jest.Mock } };
  let auditWriter: { save: jest.Mock };
  let interceptor: AuditedOperationInterceptor;
  let reflector: Reflector;

  const auditOptions: AuditedOperationOptions = {
    action: 'CREATE',
    resource: 'Farm',
  };

  /**
   * Synthetic handler stand-in. The interceptor reads decorator metadata
   * via `reflector.get(AUDITED_OPERATION_KEY, ctx.getHandler())` — what
   * matters is that the same identity is returned by the mock and that
   * the reflector returns auditOptions for that identity. We mock the
   * reflector below rather than dynamically decorate a real class so
   * ts-jest does not balk at the synthetic property addition.
   */
  const handlerSentinel = (): void => undefined;

  class ControllerSentinel {
    readonly marker = 'audited-operation-controller';
  }

  beforeEach(() => {
    auditWriter = { save: jest.fn().mockResolvedValue(undefined) };
    dataSource = { manager: auditWriter };
    reflector = new Reflector();
    jest.spyOn(reflector, 'get').mockImplementation((_key: unknown, target: unknown) => {
      if (target === handlerSentinel) {
        return auditOptions;
      }
      return undefined;
    });
    interceptor = new AuditedOperationInterceptor(reflector, dataSource as unknown as DataSource);
  });

  function buildHttpCtx(
    options: {
      user?: Record<string, unknown> | null;
      tenantHeader?: string | null;
    } = {},
  ): ExecutionContext {
    const request = {
      user: options.user ?? {
        sub: 'user-1',
        email: 'a@b.com',
        tenantId: 'tenant-actor',
        mfaVerified: true,
      },
      headers: {
        'x-tenant-id': options.tenantHeader ?? null,
        'user-agent': 'jest',
        'x-correlation-id': 'corr-1',
      },
      ip: '10.0.0.1',
    };
    return {
      getType: () => 'http',
      getHandler: () => handlerSentinel,
      getClass: () => ControllerSentinel,
      switchToHttp: () => ({ getRequest: () => request }),
      getArgs: () => [],
    } as unknown as ExecutionContext;
  }

  function buildGqlCtx(): ExecutionContext {
    const request = {
      user: { sub: 'user-2', email: 'g@h.com', tenantId: 'tenant-gql' },
      headers: { 'user-agent': 'apollo' },
      ip: '10.0.0.2',
    };
    // Nest's GqlExecutionContext.create() wraps the host and exposes
    // getContext() = args[2] per the GraphQL resolver contract
    // [root, args, context, info]. We must mirror that shape so the
    // interceptor's `gqlCtx.getContext().req` lookup works.
    return {
      getType: () => 'graphql',
      getHandler: () => handlerSentinel,
      getClass: () => ControllerSentinel,
      switchToHttp: () => {
        throw new Error('not http');
      },
      getArgs: () => [null, null, { req: request }, null],
      getArgByIndex: (idx: number) => ([null, null, { req: request }, null] as unknown[])[idx],
    } as unknown as ExecutionContext;
  }

  function buildRpcCtx(command: Record<string, unknown>): ExecutionContext {
    return {
      getType: () => 'rpc',
      getHandler: () => handlerSentinel,
      getClass: () => ControllerSentinel,
      switchToHttp: () => {
        throw new Error('not http');
      },
      getArgs: () => [command],
    } as unknown as ExecutionContext;
  }

  function buildNext(observable: Observable<unknown>): CallHandler {
    return { handle: () => observable };
  }

  function lastSavedAuditEntry(): Partial<AuditLogEntity> {
    expect(auditWriter.save).toHaveBeenCalled();
    return mockCallArgument<Partial<AuditLogEntity>>(auditWriter.save, 0, 1);
  }

  it('HTTP context → method=HTTP and tenant fields propagated from JWT', async () => {
    const ctx = buildHttpCtx();
    const observable = interceptor.intercept(ctx, buildNext(of({ id: 'farm-1' })));
    await lastValueFrom(observable);

    const e = lastSavedAuditEntry();
    expect(e.method).toBe(AuditMethod.HTTP);
    expect(e.actorHomeTenantId).toBe('tenant-actor');
    expect(e.actedOnTenantId).toBe('tenant-actor');
    expect(e.mfaVerified).toBe(true);
    expect(e.result).toBe(AuditResult.SUCCESS);
    expect(e.severity).toBe(AuditSeverity.INFO);
  });

  it('GraphQL context → method=GRAPHQL', async () => {
    const ctx = buildGqlCtx();
    const observable = interceptor.intercept(ctx, buildNext(of({ id: 'farm-2' })));
    await lastValueFrom(observable);

    expect(lastSavedAuditEntry().method).toBe(AuditMethod.GRAPHQL);
  });

  it('RPC/CQRS context → method=NATS, command-level tenantId carried', async () => {
    const ctx = buildRpcCtx({
      tenantId: 'tenant-cmd',
      userId: 'user-cmd',
      mfaVerified: true,
    });
    const observable = interceptor.intercept(ctx, buildNext(of({ id: 'farm-3' })));
    await lastValueFrom(observable);

    const e = lastSavedAuditEntry();
    expect(e.method).toBe(AuditMethod.NATS);
    expect(e.actorHomeTenantId).toBe('tenant-cmd');
    expect(e.actedOnTenantId).toBe('tenant-cmd');
    expect(e.mfaVerified).toBe(true);
  });

  it('handler failure → result=FAILED and audit row STILL written', async () => {
    const ctx = buildHttpCtx();
    const observable = interceptor.intercept(ctx, buildNext(throwError(() => new Error('boom'))));
    await expect(lastValueFrom(observable)).rejects.toThrow('boom');
    expect(auditWriter.save).toHaveBeenCalledTimes(1);
    expect(lastSavedAuditEntry().result).toBe(AuditResult.FAILED);
    expect(lastSavedAuditEntry().severity).toBe(AuditSeverity.ERROR);
  });

  it('mfaVerified defaults to false when JWT claim absent', async () => {
    const ctx = buildHttpCtx({
      user: { sub: 'u', email: 'e@e.com', tenantId: 't' },
    });
    const observable = interceptor.intercept(ctx, buildNext(of({ id: 'x' })));
    await lastValueFrom(observable);
    expect(lastSavedAuditEntry().mfaVerified).toBe(false);
  });

  it('RPC context: AsyncLocalStorage tenant context overrides command-level tenantId (AUDITTRAIL-MEDIUM-002)', async () => {
    const ctx = buildRpcCtx({
      tenantId: 'tenant-from-command-DTO',
      userId: 'user-from-command-DTO',
    });
    const observable = await requestContextStorage.run(
      {
        tenantId: 'tenant-from-ALS-trust-anchor',
        userId: 'user-from-ALS-trust-anchor',
        correlationId: 'corr-als',
        schemaName: 'schema_als',
      },
      () => Promise.resolve(interceptor.intercept(ctx, buildNext(of({ id: 'x' })))),
    );
    await lastValueFrom(observable);

    const e = lastSavedAuditEntry();
    // ALS wins.
    expect(e.actorHomeTenantId).toBe('tenant-from-ALS-trust-anchor');
    expect(e.actedOnTenantId).toBe('tenant-from-ALS-trust-anchor');
    expect(e.tenantId).toBe('tenant-from-ALS-trust-anchor');
    expect(e.userId).toBe('user-from-ALS-trust-anchor');
    expect(e.correlationId).toBe('corr-als');
    expect(e.schemaName).toBe('schema_als');
  });

  it('RPC context: command-level tenantId is the fallback when AsyncLocalStorage has no context', async () => {
    const ctx = buildRpcCtx({
      tenantId: 'tenant-from-command-DTO',
      userId: 'user-from-command-DTO',
    });
    // No requestContextStorage.run wrapper — the cron / worker entry-
    // point case before withTenantContext() is universal.
    const observable = interceptor.intercept(ctx, buildNext(of({ id: 'x' })));
    await lastValueFrom(observable);

    const e = lastSavedAuditEntry();
    expect(e.tenantId).toBe('tenant-from-command-DTO');
    expect(e.userId).toBe('user-from-command-DTO');
  });

  it('does NOT auto-populate the four caller-owned fields (preStateHash, postStateHash, justification, relatedAuditIds)', async () => {
    const ctx = buildHttpCtx();
    const observable = interceptor.intercept(ctx, buildNext(of({ id: 'x' })));
    await lastValueFrom(observable);
    const e = lastSavedAuditEntry();
    expect(e.preStateHash).toBeUndefined();
    expect(e.postStateHash).toBeUndefined();
    expect(e.justification).toBeUndefined();
    expect(e.relatedAuditIds).toBeUndefined();
  });
});
