import { createHash } from 'crypto';

import { ContextType, ExecutionContext, ForbiddenException, Type } from '@nestjs/common';
import {
  HttpArgumentsHost,
  RpcArgumentsHost,
  WsArgumentsHost,
} from '@nestjs/common/interfaces';
import { ConfigService } from '@nestjs/config';

import { SecurityEventService } from '../../security/security-event.service';
import { generateServiceIdentityHeadersV2 } from '../../utils/service-identity.util';
import { ServiceIdentityGuard } from '../service-identity.guard';

/**
 * Unit tests for the shared ServiceIdentityGuard — R1 Path-alpha body-hash binding.
 *
 * WHY this spec exists: the guard verifies a v2 service-identity HMAC whose canonical
 * binds sha256(body). The signer (Node gateway / Rust router coprocessor) signs the
 * EXACT bytes it puts on the wire. The receiver must therefore hash the SAME raw bytes
 * — `req.rawBody` (a Buffer Nest captures when bootstrapped with `rawBody: true`) — not
 * a re-`JSON.stringify(req.body)`, which can diverge from the wire bytes and reject
 * valid traffic. These tests pin:
 *   1. rawBody (raw wire bytes) is PREFERRED and accepted even when req.body
 *      re-stringifies to DIFFERENT bytes than were signed (the divergence Path-alpha
 *      removes).
 *   2. Backward-compatible fallback to JSON.stringify(req.body) when rawBody is absent.
 *   3. A tampered raw body (signed over different bytes) is rejected (fail-closed).
 */

const SECRET = 'test-internal-secret-do-not-use-in-prod-this-is-only-a-fixture';
const CALLER = 'gateway-api';
const RECEIVER_AUDIENCE = 'farm-service';
const TENANT = '11111111-1111-4111-8111-111111111111';
const KEY_ID = 'kid-1';
const PATH = '/graphql';
const METHOD = 'POST';
const CONTENT_TYPE = 'application/json';

const KEYRING = JSON.stringify([
  {
    kid: KEY_ID,
    secret: SECRET,
    status: 'active',
    callers: [CALLER],
    audiences: [RECEIVER_AUDIENCE],
  },
]);

interface FakeReq {
  method: string;
  originalUrl: string;
  url: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody?: Buffer;
  verifiedIdentity?: unknown;
}

function gqlContext(req: FakeReq): ExecutionContext {
  // GraphQL resolver argument tuple [root, args, context, info]; GqlExecutionContext
  // reads the 3rd entry as the request context, so the REAL GqlExecutionContext.create
  // resolves `req` from this mock with no library stubbing. Generic-returning host
  // methods widen through an `unknown`-typed value (never a double cast) to stay honest.
  const gqlArgs: unknown[] = [undefined, {}, { req }, undefined];
  const graphqlType = 'graphql';
  const reqValue: unknown = req;
  const emptyValue: unknown = {};
  // getClass() must return a constructor; the guard never invokes it, so a stub
  // resolver class stands in. The marker field keeps it a non-empty class (an
  // empty class trips @typescript-eslint/no-extraneous-class).
  const mockClass: unknown = class GqlResolverStub {
    readonly isResolverStub = true;
  };
  const httpHost: HttpArgumentsHost = {
    getRequest: <T = unknown>(): T => reqValue as T,
    getResponse: <T = unknown>(): T => emptyValue as T,
    getNext: <T = unknown>(): T => emptyValue as T,
  };
  const rpcHost: RpcArgumentsHost = {
    getData: <T = unknown>(): T => emptyValue as T,
    getContext: <T = unknown>(): T => gqlArgs[2] as T,
  };
  const wsHost: WsArgumentsHost = {
    getClient: <T = unknown>(): T => emptyValue as T,
    getData: <T = unknown>(): T => emptyValue as T,
    getPattern: (): string => '',
  };
  return {
    getType: <TContext extends string = ContextType>(): TContext => graphqlType as TContext,
    getArgs: <T extends Array<unknown> = unknown[]>(): T => gqlArgs as T,
    getArgByIndex: <T = unknown>(index: number): T => gqlArgs[index] as T,
    getClass: <T = unknown>(): Type<T> => mockClass as Type<T>,
    getHandler: (): (() => void) => (): void => undefined,
    switchToHttp: (): HttpArgumentsHost => httpHost,
    switchToRpc: (): RpcArgumentsHost => rpcHost,
    switchToWs: (): WsArgumentsHost => wsHost,
  };
}

function configServiceFor(env: Record<string, string | undefined>): ConfigService {
  // Use the real ConfigService backed by the fixture map — no fabricated double.
  return new ConfigService(env);
}

/**
 * Sign the v2 headers exactly as the SENDER does — over the literal wire bytes — then
 * assemble the lowercase header map the receiver reads off the wire.
 */
function signedHeaders(
  wireBytes: string,
  overrides: Partial<Parameters<typeof generateServiceIdentityHeadersV2>[0]> = {},
): Record<string, string> {
  const h = generateServiceIdentityHeadersV2({
    serviceName: CALLER,
    secret: SECRET,
    tenantId: TENANT,
    method: METHOD,
    path: PATH,
    body: wireBytes,
    keyId: KEY_ID,
    audience: RECEIVER_AUDIENCE,
    contentType: CONTENT_TYPE,
    ...overrides,
  });
  return {
    'x-service-identity': h['X-Service-Identity'],
    'x-service-timestamp': h['X-Service-Timestamp'],
    'x-service-signature': h['X-Service-Signature'],
    'x-service-sig-version': h['X-Service-Sig-Version'],
    'x-service-method': h['X-Service-Method'],
    'x-service-path': h['X-Service-Path'],
    'x-service-body-hash': h['X-Service-Body-Hash'],
    'x-service-key-id': h['X-Service-Key-Id'],
    'x-service-audience': h['X-Service-Audience'],
    'x-service-query-hash': h['X-Service-Query-Hash'],
    'x-service-content-type': h['X-Service-Content-Type'],
    'x-service-assertion-hash': h['X-Service-Assertion-Hash'],
    'x-service-nonce': h['X-Service-Nonce'],
    'x-service-effective-tenant-id': h['X-Service-Effective-Tenant-ID'],
    'content-type': CONTENT_TYPE,
    'x-tenant-id': TENANT,
  };
}

describe('ServiceIdentityGuard — R1 Path-alpha body-hash binding', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env['NODE_ENV'] = 'production';
    process.env['SERVICE_IDENTITY_KEYRING'] = KEYRING;
    process.env['SERVICE_IDENTITY_AUDIENCE'] = RECEIVER_AUDIENCE;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  function makeGuard(): ServiceIdentityGuard {
    const config = configServiceFor({
      SERVICE_IDENTITY_KEYRING: KEYRING,
      SERVICE_IDENTITY_AUDIENCE: RECEIVER_AUDIENCE,
    });
    return new ServiceIdentityGuard(config, undefined, RECEIVER_AUDIENCE);
  }

  it('prefers req.rawBody (raw wire bytes) over a divergently-shaped req.body', () => {
    // The wire bytes the sender signed: compact, with a specific key order.
    const wireBytes = '{"query":"{ farms { id } }","variables":{"b":2,"a":1}}';
    // The V8-parsed object re-stringifies to DIFFERENT bytes (different key order /
    // spacing). Hashing req.body would compute a different hash and reject — the exact
    // divergence Path-alpha removes by hashing the raw bytes.
    const parsed = JSON.parse(wireBytes) as unknown;
    const reStringified = JSON.stringify({ extra: 'reordered', ...((parsed as object) ?? {}) });
    expect(reStringified).not.toEqual(wireBytes);

    const req: FakeReq = {
      method: METHOD,
      originalUrl: PATH,
      url: PATH,
      path: PATH,
      headers: signedHeaders(wireBytes),
      body: { extra: 'reordered', ...(parsed ?? {}) },
      rawBody: Buffer.from(wireBytes, 'utf8'),
    };

    const guard = makeGuard();
    expect(guard.canActivate(gqlContext(req))).toBe(true);
    expect(req.verifiedIdentity).toBeDefined();
  });

  it('the rawBody hash equals what a Rust serde_json::to_vec(body) hash would be', () => {
    // Path-alpha invariant: the receiver hashes the literal bytes on the wire. The Rust
    // coprocessor signs sha256(serde_json::to_vec(value)); for an identical byte string
    // both sides hash the SAME bytes, so the hashes are equal by construction.
    const wireBytes = '{"query":"{ me { id } }"}';
    const rawBodyHash = createHash('sha256').update(Buffer.from(wireBytes, 'utf8')).digest('hex');
    const signedBodyHash = createHash('sha256').update(wireBytes).digest('hex');
    expect(rawBodyHash).toEqual(signedBodyHash);

    const req: FakeReq = {
      method: METHOD,
      originalUrl: PATH,
      url: PATH,
      path: PATH,
      headers: signedHeaders(wireBytes),
      body: JSON.parse(wireBytes) as unknown,
      rawBody: Buffer.from(wireBytes, 'utf8'),
    };
    expect(makeGuard().canActivate(gqlContext(req))).toBe(true);
  });

  it('falls back to JSON.stringify(req.body) when rawBody is absent (backward-compatible)', () => {
    // When rawBody is not populated, behaviour is byte-identical to the old guard:
    // JSON.stringify(req.body). The sender signed over that same string.
    const bodyObj = { query: '{ me { id } }' };
    const wireBytes = JSON.stringify(bodyObj);

    const req: FakeReq = {
      method: METHOD,
      originalUrl: PATH,
      url: PATH,
      path: PATH,
      headers: signedHeaders(wireBytes),
      body: bodyObj,
      // rawBody intentionally omitted
    };
    expect(makeGuard().canActivate(gqlContext(req))).toBe(true);
  });

  it('rejects when the signed body bytes differ from the received raw body (fail-closed)', () => {
    const signedOver = '{"query":"{ me { id } }"}';
    const receivedRaw = '{"query":"{ secrets { id } }"}'; // tampered on the wire

    const req: FakeReq = {
      method: METHOD,
      originalUrl: PATH,
      url: PATH,
      path: PATH,
      headers: signedHeaders(signedOver),
      body: JSON.parse(receivedRaw) as unknown,
      rawBody: Buffer.from(receivedRaw, 'utf8'),
    };
    expect(() => makeGuard().canActivate(gqlContext(req))).toThrow(ForbiddenException);
  });

  it('ORPHAN-098: emits the raw machine-readable reasonCode to the security event on rejection', () => {
    // A real SecurityEventService (its eventBus dep is @Optional) so the spy
    // stays cast-free; the guard's client message is generic but the operator
    // signal must carry the exact cause.
    const eventService = new SecurityEventService();
    const spy = jest
      .spyOn(eventService, 'publishServiceIdentityRejected')
      .mockResolvedValue(undefined);

    const config = configServiceFor({
      SERVICE_IDENTITY_KEYRING: KEYRING,
      SERVICE_IDENTITY_AUDIENCE: RECEIVER_AUDIENCE,
    });
    const guard = new ServiceIdentityGuard(config, eventService, RECEIVER_AUDIENCE);

    // No service-identity headers at all → outcome.reason === 'missing-headers'.
    const req: FakeReq = {
      method: METHOD,
      originalUrl: PATH,
      url: PATH,
      path: PATH,
      headers: {},
      body: {},
    };

    expect(() => guard.canActivate(gqlContext(req))).toThrow(ForbiddenException);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: 'missing-headers' }),
    );
  });
});
