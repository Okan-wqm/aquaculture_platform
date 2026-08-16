import {
  ADMIN_JSON_CODEC_POLICY,
  ADMIN_HTTP_CONTRACT_VERSION,
  AdminHttpContractError,
  adminManualResponse,
  adminResponse,
  createAdminAttachmentFilename,
  createAdminRequestContract,
  createAdminRouteAuthorizationV1,
  createAdminRouteDefinition,
  createStandardPaginatedResult,
  decodeStandardPaginatedResultCandidate,
  decodeAdminHttpPageV1,
  decodeAdminHttpErrorEnvelopeV1,
  decodeAdminHttpValueV1,
  decodeAdminAttachmentDisposition,
  decodeAdminAttachmentFilename,
  decodeAdminInboundRequestV1,
  decodeJsonValue,
  encodeAdminAttachmentDisposition,
  encodeAdminHttpPageV1,
  encodeAdminHttpErrorEnvelopeV1,
  encodeAdminHttpValueV1,
  isExecutableAdminResponseContract,
  isExecutableAdminManualResponseProfile,
  adminSqlIdentifierKeys,
  resolveAdminSqlIdentifier,
  parseJsonValue,
  projectAdminResponse,
  toJsonValue,
  type JsonValue,
  type WireDecoder,
} from './index';
import { Role } from '@platform/identity';

const stringDecoder: WireDecoder<string> = {
  contractName: 'string',
  decode(value: JsonValue, path = '$'): string {
    if (typeof value !== 'string') {
      throw new AdminHttpContractError(path, 'expected a string');
    }
    return value;
  },
};

describe('admin HTTP contract v1', () => {
  const requestId = 'request_12345678';

  it('round-trips a nominal page while deriving navigation flags', () => {
    const page = createStandardPaginatedResult(['a', 'b'], 3, 1, 2);
    const wire = encodeAdminHttpPageV1(page, '2026-08-05T12:00:00.000Z', requestId);

    expect(wire).toEqual({
      contractVersion: ADMIN_HTTP_CONTRACT_VERSION,
      success: true,
      data: ['a', 'b'],
      meta: {
        timestamp: '2026-08-05T12:00:00.000Z',
        requestId,
        pagination: { total: 3, page: 1, limit: 2, totalPages: 2 },
      },
    });
    expect(decodeAdminHttpPageV1(wire, stringDecoder)).toMatchObject({
      items: ['a', 'b'],
      total: 3,
      page: 1,
      limit: 2,
      totalPages: 2,
      hasNextPage: true,
      hasPreviousPage: false,
    });
  });

  it('round-trips a non-paginated value through a caller-owned domain decoder', () => {
    const wire = encodeAdminHttpValueV1('ok', '2026-08-05T12:00:00.000Z', requestId);
    expect(decodeAdminHttpValueV1(wire, stringDecoder)).toBe('ok');
  });

  it('normalizes JSON objects into immutable null-prototype records', () => {
    const input = Object.assign(Object.create(null) as Record<string, unknown>, {
      nested: { enabled: true },
    });
    const decoded = decodeJsonValue(input) as Readonly<Record<string, JsonValue>>;

    expect(decoded).toEqual({ nested: { enabled: true } });
    expect(Object.getPrototypeOf(decoded)).toBeNull();
    expect(Object.getPrototypeOf(decoded.nested as object)).toBeNull();
    expect(Object.isFrozen(decoded)).toBe(true);
  });

  it('bounds UTF-8 input bytes before parsing', () => {
    const oversized = `"${'x'.repeat(ADMIN_JSON_CODEC_POLICY.maxWireBytes)}"`;
    expect(() => parseJsonValue(oversized)).toThrow(
      `JSON input exceeds ${ADMIN_JSON_CODEC_POLICY.maxWireBytes} UTF-8 wire bytes`,
    );
    expect(() => parseJsonValue('{not-json')).toThrow('malformed JSON input');
  });

  it.each([
    ['non-finite number', Number.POSITIVE_INFINITY],
    ['BigInt', BigInt(1)],
    [
      'class instance',
      new (class ProviderValue {
        readonly provider = true;
      })(),
    ],
    ['Date instance', new Date('2026-08-05T12:00:00.000Z')],
    ['sparse array', Array(1)],
  ])('rejects unsafe JSON representation: %s', (_name, candidate) => {
    expect(() => toJsonValue(candidate)).toThrow(AdminHttpContractError);
  });

  it('rejects cyclic values and accessor execution', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => decodeJsonValue(cyclic)).toThrow('cyclic JSON values are forbidden');

    let getterCalled = false;
    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get() {
        getterCalled = true;
        return 'leaked';
      },
    });
    expect(() => decodeJsonValue(accessor)).toThrow(
      'JSON fields must be enumerable own data properties',
    );
    expect(getterCalled).toBe(false);
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects prototype-mutating JSON key %s without pollution',
    (key) => {
      const candidate = JSON.parse(`{"${key}":{"polluted":true}}`) as unknown;
      expect(() => decodeJsonValue(candidate)).toThrow('prototype-mutating JSON key is forbidden');
      expect(Reflect.get(Object.prototype, 'polluted')).toBeUndefined();
    },
  );

  it.each(['"\\ud800"', '"\\udc00"', '{"\\ud800":true}'])(
    'rejects a lone UTF-16 surrogate in JSON wire text %s',
    (wire) => {
      expect(() => parseJsonValue(wire)).toThrow('lone UTF-16 surrogates');
    },
  );

  it('enforces depth, node, object-key, array and string limits from one policy', () => {
    let deep: unknown = null;
    for (let depth = 0; depth <= ADMIN_JSON_CODEC_POLICY.maxDepth; depth++) {
      deep = [deep];
    }
    expect(() => decodeJsonValue(deep)).toThrow(
      `JSON value exceeds depth ${ADMIN_JSON_CODEC_POLICY.maxDepth}`,
    );

    const nodeHeavy = Array.from({ length: 3 }, () =>
      Array.from({ length: ADMIN_JSON_CODEC_POLICY.maxArrayItems }, () => null),
    );
    expect(() => decodeJsonValue(nodeHeavy)).toThrow(
      `JSON value exceeds ${ADMIN_JSON_CODEC_POLICY.maxNodes} nodes`,
    );

    const keyHeavy = Object.fromEntries(
      Array.from({ length: ADMIN_JSON_CODEC_POLICY.maxObjectKeys + 1 }, (_, index) => [
        `key${index}`,
        null,
      ]),
    );
    expect(() => decodeJsonValue(keyHeavy)).toThrow(
      `JSON object exceeds ${ADMIN_JSON_CODEC_POLICY.maxObjectKeys} keys`,
    );

    expect(() =>
      decodeJsonValue(Array(ADMIN_JSON_CODEC_POLICY.maxArrayItems + 1).fill(null)),
    ).toThrow(`JSON array exceeds ${ADMIN_JSON_CODEC_POLICY.maxArrayItems} entries`);

    expect(() => decodeJsonValue('x'.repeat(ADMIN_JSON_CODEC_POLICY.maxStringBytes + 1))).toThrow(
      `JSON string exceeds ${ADMIN_JSON_CODEC_POLICY.maxStringBytes} UTF-8 bytes`,
    );

    const oversizedKey = 'k'.repeat(ADMIN_JSON_CODEC_POLICY.maxKeyBytes + 1);
    expect(() => decodeJsonValue({ [oversizedKey]: null })).toThrow(
      `JSON key exceeds ${ADMIN_JSON_CODEC_POLICY.maxKeyBytes} UTF-8 bytes`,
    );
  });

  it('round-trips the strict versioned error envelope', () => {
    const wire = encodeAdminHttpErrorEnvelopeV1({
      status: 400,
      code: 'VALIDATION_FAILED',
      message: 'name must not be empty',
      timestamp: '2026-08-05T12:00:00.000Z',
      path: '/api/users',
      requestId: 'request_12345678',
      details: { validationMessages: ['name must not be empty'] },
    });
    expect(decodeAdminHttpErrorEnvelopeV1(wire)).toEqual(wire);
  });

  it.each([
    {
      contractVersion: 'admin-http-error.v2',
      success: false,
      error: {
        status: 400,
        code: 'BAD_REQUEST',
        message: 'bad',
        timestamp: '2026-08-05T12:00:00.000Z',
        path: '/api/users',
      },
    },
    {
      contractVersion: 'admin-http-error.v1',
      success: false,
      extra: true,
      error: {
        status: 400,
        code: 'BAD_REQUEST',
        message: 'bad',
        timestamp: '2026-08-05T12:00:00.000Z',
        path: '/api/users',
      },
    },
  ])('rejects malformed error envelope %#', (wire) => {
    expect(() => decodeAdminHttpErrorEnvelopeV1(wire)).toThrow(AdminHttpContractError);
  });

  it.each([
    {
      name: 'unknown envelope field',
      mutate: (wire: Record<string, unknown>) => ({ ...wire, compatibility: true }),
    },
    {
      name: 'wrong version',
      mutate: (wire: Record<string, unknown>) => ({ ...wire, contractVersion: 'admin-http.v2' }),
    },
    {
      name: 'pagination arithmetic drift',
      mutate: (wire: Record<string, unknown>) => ({
        ...wire,
        meta: {
          timestamp: '2026-08-05T12:00:00.000Z',
          requestId,
          pagination: { total: 3, page: 1, limit: 2, totalPages: 99 },
        },
      }),
    },
  ])('fails closed on $name', ({ mutate }) => {
    const wire = encodeAdminHttpValueV1('ok', '2026-08-05T12:00:00.000Z', requestId);
    expect(() => decodeAdminHttpValueV1(mutate(wire), stringDecoder)).toThrow(
      AdminHttpContractError,
    );
  });

  it('rejects impossible application pagination before it reaches the wire', () => {
    expect(() => createStandardPaginatedResult(['a', 'b'], 1, 1, 2)).toThrow('above total');
  });

  it('recognizes only the complete canonical backend page shape', () => {
    expect(
      decodeStandardPaginatedResultCandidate({
        items: ['a'],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      }),
    ).toMatchObject({ items: ['a'], totalPages: 1 });
    expect(decodeStandardPaginatedResultCandidate({ items: ['a'], total: 1 })).toBeNull();
  });

  it('projects only contract-owned fields and materializes dates', () => {
    const contract = adminResponse.object({
      id: adminResponse.string(),
      createdAt: adminResponse.dateString(),
      note: adminResponse.optional(adminResponse.string()),
    });

    expect(
      projectAdminResponse(contract, {
        id: 'tenant-1',
        createdAt: new Date('2026-08-05T12:00:00.000Z'),
        passwordHash: 'must-not-cross-the-boundary',
      }),
    ).toEqual({
      id: 'tenant-1',
      createdAt: '2026-08-05T12:00:00.000Z',
    });
  });

  it('fails closed when a required projection field is absent', () => {
    const contract = adminResponse.object({ id: adminResponse.string() });
    expect(() => projectAdminResponse(contract, {})).toThrow('$.id: required field is missing');
  });

  it('models void commands as an explicit null wire value', () => {
    expect(projectAdminResponse(adminResponse.void(), undefined)).toBeNull();
    expect(() => projectAdminResponse(adminResponse.void(), { leaked: true })).toThrow(
      '$: expected no response value',
    );
  });

  it('fails closed if a terminal-error route unexpectedly returns', () => {
    expect(() => projectAdminResponse(adminResponse.never(), undefined)).toThrow(
      'unreachable route produced a response value',
    );
  });

  it('accepts only immutable contracts created by the closed builders', () => {
    const item = adminResponse.object({ id: adminResponse.string() });
    const contract = adminResponse.page(item);

    expect(isExecutableAdminResponseContract(contract)).toBe(true);
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(item)).toBe(true);
    expect(Object.isFrozen(item.fields)).toBe(true);
    expect(isExecutableAdminResponseContract({ kind: 'string' })).toBe(false);
    expect(isExecutableAdminResponseContract({ kind: 'unknown' })).toBe(false);
    expect(() => Object.defineProperty(contract, 'kind', { value: 'json' })).toThrow();
  });

  it('rejects fabricated children and cyclic contract-like objects', () => {
    expect(() => adminResponse.array({ kind: 'string' })).toThrow(
      'response contract child must come from the closed adminResponse builders',
    );

    const cyclic: Record<string, unknown> = { kind: 'object' };
    cyclic.fields = Object.freeze({ self: cyclic });
    Object.freeze(cyclic);
    expect(isExecutableAdminResponseContract(cyclic)).toBe(false);
  });

  it('requires projected fields to be own properties', () => {
    const inherited: Record<string, unknown> = {};
    Object.setPrototypeOf(inherited, { id: 'prototype-value' });
    expect(() =>
      projectAdminResponse(adminResponse.object({ id: adminResponse.string() }), inherited),
    ).toThrow('$.id: required field is missing');
  });

  it('does not swallow non-contract failures while trying union variants', () => {
    const value = Object.defineProperty({}, 'id', {
      enumerable: true,
      get(): string {
        throw new Error('getter exploded');
      },
    });
    const contract = adminResponse.union([
      adminResponse.object({ id: adminResponse.string() }),
      adminResponse.object({ id: adminResponse.number() }),
    ]);

    expect(() => projectAdminResponse(contract, value)).toThrow('getter exploded');
  });

  it('projects an immutable literal authority without hand-written union copies', () => {
    const reportTypes = ['tenant_overview', 'financial_revenue'] as const;
    const contract = adminResponse.literalSet(reportTypes);

    expect(projectAdminResponse(contract, 'tenant_overview')).toBe('tenant_overview');
    expect(() => projectAdminResponse(contract, 'synthetic_report')).toThrow();
    expect(Object.isFrozen(contract.variants)).toBe(true);
    expect(() => adminResponse.literalSet(['duplicate', 'duplicate'] as const)).toThrow(
      'literalSet requires at least one unique JSON primitive',
    );
  });

  it('rejects non-finite or non-JSON literal values at the runtime boundary', () => {
    expect(() => Reflect.apply(adminResponse.literal, adminResponse, [Number.NaN])).toThrow(
      'literal requires a finite JSON primitive',
    );
    expect(() =>
      Reflect.apply(adminResponse.literalSet, adminResponse, [[Number.POSITIVE_INFINITY]]),
    ).toThrow('literal requires a finite JSON primitive');
    expect(() => {
      Reflect.apply(adminResponse.literal, adminResponse, [undefined]);
    }).toThrow('literal requires a finite JSON primitive');
  });

  it('validates every item and the complete canonical page metadata', () => {
    const contract = adminResponse.page(adminResponse.object({ id: adminResponse.string() }));
    expect(
      projectAdminResponse(contract, {
        items: [{ id: 'tenant-1', internal: true }],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      }),
    ).toEqual({
      items: [{ id: 'tenant-1' }],
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false,
    });
  });

  it('uses one ASCII-safe attachment filename and disposition authority', () => {
    const filename = createAdminAttachmentFilename('../Gelir raporu % Ağustos.csv');
    expect(filename).toBe('Gelir_raporu_Agustos.csv');
    const disposition = encodeAdminAttachmentDisposition(filename);
    expect(disposition).toBe('attachment; filename="Gelir_raporu_Agustos.csv"');
    expect(decodeAdminAttachmentDisposition(disposition)).toBe(filename);
  });

  it.each([
    '../report.csv',
    'report;admin.csv',
    'report%20admin.csv',
    'rapor admin.csv',
    'rapor‮fdp.csv',
    'report\u0000.csv',
    'report\\admin.csv',
    'report/admin.csv',
  ])('rejects unsafe attachment basename %j', (filename) => {
    expect(() => decodeAdminAttachmentFilename(filename)).toThrow(AdminHttpContractError);
  });

  it.each([
    'attachment; filename=report.csv',
    'attachment; filename="report.csv"; size=1',
    'inline; filename="report.csv"',
    'attachment; filename="../report.csv"',
  ])('rejects non-canonical disposition %j', (disposition) => {
    expect(() => decodeAdminAttachmentDisposition(disposition)).toThrow(AdminHttpContractError);
  });

  it('accepts only sealed manual response profiles', () => {
    const binary = adminManualResponse.binary([200], ['application/pdf'], 1_024);
    const health = adminManualResponse.health(
      [200, 503],
      adminResponse.object({ status: adminResponse.string() }),
    );
    expect(isExecutableAdminManualResponseProfile(binary)).toBe(true);
    expect(isExecutableAdminManualResponseProfile(health)).toBe(true);
    expect(
      isExecutableAdminManualResponseProfile({
        kind: 'binary-download',
        transport: 'binary-download',
        statusCodes: [200],
        mediaTypes: ['application/pdf'],
        maxBytes: 1_024,
        disposition: 'attachment-with-filename',
      }),
    ).toBe(false);
  });

  it('derives route policy internally and encodes explicit per-field query codecs', () => {
    const request = createAdminRequestContract(
      adminResponse.object({ id: adminResponse.string() }),
      adminResponse.object({
        levels: adminResponse.optional(adminResponse.string()),
        tag: adminResponse.optional(adminResponse.array(adminResponse.string())),
      }),
      { levels: 'comma-separated', tag: 'repeated' },
      adminResponse.object({ 'idempotency-key': adminResponse.optional(adminResponse.string()) }),
      adminResponse.void(),
      null,
    );
    const route = createAdminRouteDefinition(
      'GET',
      '/events/:id',
      request,
      createAdminRouteAuthorizationV1('bearer-session', [Role.SUPER_ADMIN], []),
      200,
      adminResponse.object({ ok: adminResponse.boolean() }),
    );

    expect(
      route.encode({
        path: { id: 'event 1' },
        query: { levels: ['high', 'critical'], tag: ['a', 'b'] },
        headers: { 'idempotency-key': 'idem-1' },
      }),
    ).toMatchObject({
      endpoint: '/events/event%201?levels=high%2Ccritical&tag=a&tag=b',
      method: 'GET',
      headers: { 'idempotency-key': 'idem-1' },
    });
    expect(route.policy).toMatchObject({
      authentication: 'bearer-session',
      retry: { mode: 'safe-exponential' },
      successStatusCodes: [200],
      successMediaType: 'application/json',
    });
  });

  it('rejects reserved header contracts and route/path schema drift', () => {
    expect(() =>
      createAdminRequestContract(
        adminResponse.object({}),
        adminResponse.object({}),
        {},
        adminResponse.object({ authorization: adminResponse.string() }),
        adminResponse.void(),
        null,
      ),
    ).toThrow('request header is reserved by the transport kernel');

    const request = createAdminRequestContract(
      adminResponse.object({ tenantId: adminResponse.string() }),
      adminResponse.object({}),
      {},
      adminResponse.object({}),
      adminResponse.void(),
      null,
    );
    expect(() =>
      createAdminRouteDefinition(
        'GET',
        '/tenants/:id',
        request,
        createAdminRouteAuthorizationV1('bearer-session', [Role.SUPER_ADMIN], []),
        200,
        adminResponse.void(),
      ),
    ).toThrow('route parameter names must exactly equal');
  });

  it('decodes every inbound request section through one exact recursive contract', () => {
    const request = createAdminRequestContract(
      adminResponse.object({ id: adminResponse.string() }),
      adminResponse.object({
        active: adminResponse.optional(adminResponse.boolean()),
        limit: adminResponse.number(),
      }),
      { active: 'scalar', limit: 'scalar' },
      adminResponse.object({ 'idempotency-key': adminResponse.string() }),
      adminResponse.object({
        occurredAt: adminResponse.dateString(),
        state: adminResponse.literalSet(['OPEN', 'CLOSED'] as const),
        nested: adminResponse.object({
          entries: adminResponse.array(adminResponse.object({ enabled: adminResponse.boolean() })),
        }),
      }),
      'application/json',
    );

    expect(
      decodeAdminInboundRequestV1(request, {
        path: { id: 'tenant-1' },
        query: { active: 'false', limit: '25' },
        headers: { 'idempotency-key': 'idem-1' },
        body: {
          occurredAt: '2026-08-09T00:00:00.000Z',
          state: 'OPEN',
          nested: { entries: [{ enabled: true }] },
        },
      }),
    ).toEqual({
      path: { id: 'tenant-1' },
      query: { active: false, limit: 25 },
      headers: { 'idempotency-key': 'idem-1' },
      body: {
        occurredAt: '2026-08-09T00:00:00.000Z',
        state: 'OPEN',
        nested: { entries: [{ enabled: true }] },
      },
    });
  });

  it.each([
    {
      name: 'unknown path field',
      candidate: { path: { id: 'one', injected: 'two' }, query: {}, headers: {} },
      message: '$.request.path.injected',
    },
    {
      name: 'unknown query field',
      candidate: { path: { id: 'one' }, query: { injected: 'two' }, headers: {} },
      message: '$.request.query.injected',
    },
    {
      name: 'unknown header field',
      candidate: { path: { id: 'one' }, query: {}, headers: { injected: 'two' } },
      message: '$.request.headers.injected',
    },
  ])('rejects $name rather than projecting it away', ({ candidate, message }) => {
    const request = createAdminRequestContract(
      adminResponse.object({ id: adminResponse.string() }),
      adminResponse.object({}),
      {},
      adminResponse.object({}),
      adminResponse.void(),
      null,
    );
    expect(() => decodeAdminInboundRequestV1(request, candidate)).toThrow(message);
  });

  it.each([
    {
      body: { at: '2026-02-30T00:00:00.000Z', state: 'OPEN', nested: { enabled: true } },
      message: 'real calendar timestamp',
    },
    {
      body: { at: '2026-08-09T00:00:00.000Z', state: 'INJECTED', nested: { enabled: true } },
      message: 'did not match any request variant',
    },
    {
      body: {
        at: '2026-08-09T00:00:00.000Z',
        state: 'OPEN',
        nested: { enabled: true, injected: true },
      },
      message: '$.request.body.nested.injected',
    },
  ])('rejects invalid nested enum/date/object request %#', ({ body, message }) => {
    const request = createAdminRequestContract(
      adminResponse.object({}),
      adminResponse.object({}),
      {},
      adminResponse.object({}),
      adminResponse.object({
        at: adminResponse.dateString(),
        state: adminResponse.literalSet(['OPEN', 'CLOSED'] as const),
        nested: adminResponse.object({ enabled: adminResponse.boolean() }),
      }),
      'application/json',
    );
    expect(() =>
      decodeAdminInboundRequestV1(request, { path: {}, query: {}, headers: {}, body }),
    ).toThrow(message);
  });

  it('resolves public sort keys only through immutable SqlIdentifierCatalogV1', () => {
    expect(adminSqlIdentifierKeys('GET /system/errors/groups')).toEqual([
      'firstSeenAt',
      'lastSeenAt',
      'occurrenceCount',
      'userCount',
    ]);
    expect(resolveAdminSqlIdentifier('GET /system/errors/groups')).toBe('g.lastSeenAt');
    expect(() => {
      Reflect.apply(resolveAdminSqlIdentifier, undefined, [
        'GET /system/errors/groups',
        'lastSeenAt; DROP TABLE admin.error_groups',
      ]);
    }).toThrow('outside SqlIdentifierCatalogV1');
  });
});
