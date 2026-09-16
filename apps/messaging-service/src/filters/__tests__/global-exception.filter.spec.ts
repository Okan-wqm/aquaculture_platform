/**
 * MSGFIX-FAZ0 — GraphQL error-code contract tests for the messaging-service
 * global exception filter.
 *
 * Before the filter existed, a resolver throwing NestJS NotFoundException
 * surfaced through Apollo (and then gateway-api's parseException GraphQLError
 * branch) as INTERNAL_SERVER_ERROR, because nothing ever set
 * `extensions.code` / `extensions.statusCode`. These tests pin the contract:
 *
 *   NotFoundError/NotFoundException  → extensions.code NOT_FOUND (404)
 *   UnauthorizedException (401)      → extensions.code UNAUTHENTICATED
 *   ForbiddenException (403)         → extensions.code FORBIDDEN
 *   GraphQLError with existing code  → passed through UNCHANGED
 */
import {
  NotFoundException,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  ArgumentsHost,
  ContextType,
} from '@nestjs/common';
import { GraphQLError } from 'graphql';

import { GlobalExceptionFilter } from '../global-exception.filter';

const CORRELATION_ID = 'corr-test-123';

/**
 * Class-based ArgumentsHost stand-in (repo gate bans `as unknown as` and the
 * interface's generic signatures reject plain object literals). Implements the
 * real interface member-for-member; the constructor fixes the context type and
 * the argument array. GqlArgumentsHost.create() reads getArgByIndex(2) as the
 * GraphQL context, so the req lives there.
 */
class FakeArgumentsHost implements ArgumentsHost {
  constructor(
    private readonly type: 'http' | 'graphql',
    private readonly args: unknown[],
  ) {}

  getType<TContext extends string = ContextType>(): TContext {
    return this.type as TContext;
  }

  getArgs<T extends Array<unknown>>(): T {
    return this.args as T;
  }

  getArgByIndex<T = unknown>(index: number): T {
    return this.args[index] as T;
  }

  getClass<T = unknown>(): T {
    return Object as T;
  }

  getHandler<T = unknown>(): T {
    return (() => undefined) as T;
  }

  switchToHttp<T = unknown>(): T {
    if (this.type !== 'http') throw new Error('GraphQL context must not switch to HTTP');
    // HttpArgumentsHost has generic members too; go through unknown for the
    // single legal assertion (same trick the interface's own defaults allow).
    const httpAdapter: unknown = {
      getResponse: () => this.args[1],
      getRequest: () => this.args[0],
      getNext: () => undefined,
    };
    return httpAdapter as T;
  }

  switchToRpc<T = unknown>(): T {
    throw new Error('unexpected rpc');
  }

  switchToWs<T = unknown>(): T {
    throw new Error('unexpected ws');
  }
}

/** GraphQL-style ArgumentsHost: getType() → 'graphql', context.req with headers. */
function createGqlHost(): ArgumentsHost {
  const ctx = { req: { url: '/graphql', headers: { 'x-correlation-id': CORRELATION_ID } } };
  return new FakeArgumentsHost('graphql', [{}, {}, ctx, {}]);
}

describe('GlobalExceptionFilter — GraphQL error-code contract (MSGFIX-FAZ0)', () => {
  let filter: GlobalExceptionFilter;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
  });

  it('maps NotFoundException → code NOT_FOUND with statusCode 404', () => {
    const result = filter.catch(new NotFoundException('Message not found'), createGqlHost());

    expect(result).toBeInstanceOf(GraphQLError);
    const gqlError = result as GraphQLError;
    expect(gqlError.message).toBe('Message not found');
    expect(gqlError.extensions?.['code']).toBe('NOT_FOUND');
    expect(gqlError.extensions?.['statusCode']).toBe(404);
    // Correlation propagation survives for tracing.
    expect(gqlError.extensions?.['correlationId']).toBe(CORRELATION_ID);
  });

  it('maps UnauthorizedException → code UNAUTHENTICATED with statusCode 401', () => {
    const result = filter.catch(new UnauthorizedException('No user context'), createGqlHost());

    const gqlError = result as GraphQLError;
    expect(gqlError.extensions?.['code']).toBe('UNAUTHENTICATED');
    expect(gqlError.extensions?.['statusCode']).toBe(401);
  });

  it('maps ForbiddenException → code FORBIDDEN with statusCode 403', () => {
    const result = filter.catch(new ForbiddenException('Not a channel member'), createGqlHost());

    const gqlError = result as GraphQLError;
    expect(gqlError.extensions?.['code']).toBe('FORBIDDEN');
    expect(gqlError.extensions?.['statusCode']).toBe(403);
  });

  it('maps 400/409 → BAD_REQUEST/CONFLICT (full status table)', () => {
    const bad = filter.catch(new BadRequestException('bad input'), createGqlHost()) as GraphQLError;
    const conflict = filter.catch(new ConflictException('dup'), createGqlHost()) as GraphQLError;

    expect(bad.extensions?.['code']).toBe('BAD_REQUEST');
    expect(conflict.extensions?.['code']).toBe('CONFLICT');
  });

  it('passes a GraphQLError that already carries a code through UNCHANGED', () => {
    // e.g. the query-complexity plugin throws GraphQLError directly.
    const original = new GraphQLError('Query too complex: 1200. Maximum allowed: 1000', {
      extensions: { code: 'BAD_USER_INPUT' },
    });

    const result = filter.catch(original, createGqlHost());

    expect(result).toBe(original);
    expect((result as GraphQLError).extensions?.['code']).toBe('BAD_USER_INPUT');
  });

  it('maps a plain Error → INTERNAL_SERVER_ERROR (500) without leaking in production', () => {
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      const prodFilter = new GlobalExceptionFilter();
      const leaking = prodFilter.catch(
        new Error('database query failed: relation "messages" does not exist'),
        createGqlHost(),
      ) as GraphQLError;
      const benign = prodFilter.catch(new Error('job timed out'), createGqlHost()) as GraphQLError;

      expect(leaking.extensions?.['code']).toBe('INTERNAL_SERVER_ERROR');
      expect(leaking.extensions?.['statusCode']).toBe(500);
      // The sanitizer masks database/SQL-shaped internals...
      expect(leaking.message).not.toContain('relation');
      expect(leaking.message).toBe('An error occurred while processing your request');
      // ...while a non-sensitive 5xx message still reaches the client.
      expect(benign.message).toBe('job timed out');
      expect(benign.extensions?.['code']).toBe('INTERNAL_SERVER_ERROR');
    } finally {
      if (previous === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous;
    }
  });
});

describe('GlobalExceptionFilter — REST contexts keep the platform envelope', () => {
  it('answers an HTTP context with a JSON status response, not a GraphQLError', () => {
    const filter = new GlobalExceptionFilter();
    const json = jest.fn();
    const status = jest.fn().mockReturnThis();
    const req = {
      url: '/health',
      method: 'GET',
      headers: { 'x-correlation-id': CORRELATION_ID },
    };
    const host = new FakeArgumentsHost('http', [req, { status, json }]);

    const result = filter.catch(new NotFoundException('nope'), host);

    expect(result).toBeUndefined();
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 404, message: 'nope', path: '/health' }),
    );
  });

  it('sanitizes the REST envelope message in production (MSGFIX-FAZ0 M-1)', () => {
    const json = jest.fn();
    const status = jest.fn().mockReturnThis();
    const host = new FakeArgumentsHost('http', [{ url: '/health', method: 'GET', headers: {} }, { status, json }]);
    const previous = process.env['NODE_ENV'];
    try {
      process.env['NODE_ENV'] = 'production';
      // isProduction is captured at construction — build the filter AFTER the
      // env flip, mirroring the GraphQL-side production test.
      const filter = new GlobalExceptionFilter();
      // A raw Error leaking connection/SQL details must never reach the JSON
      // envelope ('database' trips the sanitizer's sensitive-pattern list).
      filter.catch(
        new Error('database connect ECONNREFUSED 10.0.0.4:5432 users table'),
        host,
      );
      const payload = String(json.mock.calls[0]?.[0]?.['message']);
      expect(payload).toBe('An error occurred while processing your request');
      expect(payload).not.toContain('ECONNREFUSED');
      expect(payload).not.toContain('10.0.0.4');
    } finally {
      if (previous === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous;
    }
  });
});
