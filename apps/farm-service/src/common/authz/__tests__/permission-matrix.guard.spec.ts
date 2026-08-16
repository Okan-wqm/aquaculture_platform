/**
 * PermissionMatrixGuard Unit Tests
 *
 * Covers every decision branch:
 *   - HTTP context → pass (matrix only governs GraphQL)
 *   - field-resolver context (parentType not Mutation/Query) → pass
 *   - introspection field (`__schema`, `__type`) → pass
 *   - known role-gated operation → pass
 *   - unclassified operation → ForbiddenException
 */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { GqlContextType } from '@nestjs/graphql';

import { PermissionMatrixGuard } from '../permission-matrix.guard';

function makeGqlContext(opts: {
  fieldName: string;
  parentType: 'Mutation' | 'Query' | 'Other';
}): ExecutionContext {
  return {
    getType: () => 'graphql' as GqlContextType,
    getArgs: () => [
      null,
      {},
      { req: { headers: {} } },
      {
        fieldName: opts.fieldName,
        parentType: { name: opts.parentType },
      },
    ],
    getClass: () => class {},
    getHandler: () => () => undefined,
  } as unknown as ExecutionContext;
}

function makeHttpContext(): ExecutionContext {
  return {
    getType: () => 'http',
    getClass: () => class {},
    getHandler: () => () => undefined,
  } as unknown as ExecutionContext;
}

describe('PermissionMatrixGuard', () => {
  const guard = new PermissionMatrixGuard();

  it('passes HTTP contexts unchanged — matrix governs GraphQL only', () => {
    expect(guard.canActivate(makeHttpContext())).toBe(true);
  });

  it('passes field-resolver calls (parent is not Mutation/Query)', () => {
    const ctx = makeGqlContext({
      fieldName: 'someField',
      parentType: 'Other',
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('passes introspection queries (__schema / __type)', () => {
    expect(
      guard.canActivate(
        makeGqlContext({ fieldName: '__schema', parentType: 'Query' }),
      ),
    ).toBe(true);
    expect(
      guard.canActivate(
        makeGqlContext({ fieldName: '__type', parentType: 'Query' }),
      ),
    ).toBe(true);
  });

  it('passes a known role-gated mutation', () => {
    const ctx = makeGqlContext({
      fieldName: 'closeBatch',
      parentType: 'Mutation',
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('passes another generated mutation projection', () => {
    const ctx = makeGqlContext({
      fieldName: 'createFeed',
      parentType: 'Mutation',
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('passes a known role-gated query', () => {
    const ctx = makeGqlContext({
      fieldName: 'harvestPlans',
      parentType: 'Query',
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('passes another generated query projection', () => {
    const ctx = makeGqlContext({
      fieldName: 'batches',
      parentType: 'Query',
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('throws ForbiddenException on an unclassified mutation (fail-closed)', () => {
    const ctx = makeGqlContext({
      fieldName: 'brandNewUnregisteredMutation',
      parentType: 'Mutation',
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('throws ForbiddenException on an unclassified query', () => {
    const ctx = makeGqlContext({
      fieldName: 'brandNewUnregisteredQuery',
      parentType: 'Query',
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('error message points operators to the matrix file', () => {
    const ctx = makeGqlContext({
      fieldName: 'mysteryOperation',
      parentType: 'Mutation',
    });
    try {
      guard.canActivate(ctx);
      fail('expected ForbiddenException');
    } catch (err) {
      if (!(err instanceof ForbiddenException)) throw err;
      expect(err.message).toContain('permission-matrix.ts');
    }
  });
});
