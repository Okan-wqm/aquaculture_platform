import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import cmemsResolvedSelectionLock from '../../catalog/cmems-resolved-selection-lock.v2.generated.json';
import {
  MARINE_EVENT_SCHEMAS,
  MARINE_WORKER_CONTROL_REPLY_SCHEMAS,
  MARINE_WORKER_CONTROL_REQUEST_SCHEMAS,
  validateMarineEvent,
  validateMarineWorkerControlExchange,
  validateMarineWorkerControlReply,
  validateMarineWorkerControlReplyAt,
  validateMarineWorkerControlRequest,
} from '../';
import {
  MARINE_DATA_ROLES,
  MARINE_MAX_CLOCK_SKEW_SECONDS,
  MARINE_MAX_SAFE_INTEGER,
  MARINE_WORKER_CONTROL_SUBJECTS,
  type MarineWorkerControlSubject,
} from '../../marine-worker-control';
import { sha256Utf8Hex } from '../../portable-sha256';

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadFixture(name: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    readFileSync(resolve(process.cwd(), 'libs/event-contracts/fixtures', name), 'utf8'),
  );
  if (!isJsonObject(parsed)) {
    throw new TypeError(`fixture ${name} must contain one JSON object`);
  }
  return parsed;
}

function objectProperty(
  source: Record<string, unknown>,
  propertyName: string,
): Record<string, unknown> {
  const value = source[propertyName];
  if (!isJsonObject(value)) {
    throw new TypeError(`${propertyName} must contain one JSON object`);
  }
  return value;
}

function resolvedSelectionProvenance(catalogEntryId: string): Record<string, unknown> {
  const resolvedSelection = cmemsResolvedSelectionLock.resolvedSelections.find(
    (candidate) => candidate.selectionProvenance.catalogEntryId === catalogEntryId,
  );
  if (!resolvedSelection) {
    throw new TypeError(`missing resolved CMEMS selection ${catalogEntryId}`);
  }
  return resolvedSelection.selectionProvenance;
}

function utf8Sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const CONTROL_FIXTURES: Record<MarineWorkerControlSubject, { request: string; reply: string }> = {
  [MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_LEASE]: {
    request: 'marine-execution-lease-request.json',
    reply: 'marine-execution-lease-reply.json',
  },
  [MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_RENEW]: {
    request: 'marine-execution-renew-request.json',
    reply: 'marine-execution-renew-reply.json',
  },
  [MARINE_WORKER_CONTROL_SUBJECTS.CREDENTIAL_LEASE]: {
    request: 'marine-credential-lease-request.json',
    reply: 'marine-credential-lease-reply.json',
  },
  [MARINE_WORKER_CONTROL_SUBJECTS.USAGE_RESERVE]: {
    request: 'marine-usage-reserve-request.json',
    reply: 'marine-usage-reserve-reply.json',
  },
  [MARINE_WORKER_CONTROL_SUBJECTS.USAGE_FINALIZE]: {
    request: 'marine-usage-finalize-request.json',
    reply: 'marine-usage-finalize-reply.json',
  },
  [MARINE_WORKER_CONTROL_SUBJECTS.ARTIFACT_LEASE]: {
    request: 'marine-artifact-lease-request.json',
    reply: 'marine-artifact-lease-reply.json',
  },
  [MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_FINALIZE]: {
    request: 'marine-execution-finalize-request.json',
    reply: 'marine-execution-finalize-reply.json',
  },
};

describe('MarineAnalysisRequested trust-boundary schema', () => {
  const fixture = loadFixture('marine-analysis-requested.json');

  it('accepts the golden v1 fixture', () => {
    expect(validateMarineEvent('MarineAnalysisRequested', fixture)).toEqual({
      valid: true,
    });
    expect(Object.keys(MARINE_EVENT_SCHEMAS)).toEqual(['MarineAnalysisRequested']);
  });

  it.each([
    ['unknown field', { ...fixture, payload: {} }],
    ['wrong version', { ...fixture, version: 2 }],
    ['CDSE worker provider', { ...fixture, provider: 'CDSE' }],
    ['malformed fingerprint', { ...fixture, requestFingerprint: 'short' }],
    ['zero credential generation', { ...fixture, credentialGeneration: 0 }],
    ['wrong aggregate type', { ...fixture, aggregateType: 'Job' }],
    [
      'mismatched aggregate identity',
      {
        ...fixture,
        aggregateId: '99999999-9999-4999-8999-999999999999',
      },
    ],
    [
      'uppercase UUID',
      {
        ...fixture,
        tenantId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      },
    ],
    [
      'sub-millisecond event timestamp',
      { ...fixture, timestamp: String(fixture.timestamp).replace(/Z$/, '0001Z') },
    ],
    [
      'offset requested timestamp',
      { ...fixture, requestedAt: String(fixture.requestedAt).replace(/Z$/, '+00:00') },
    ],
    ['secret material', { ...fixture, clientSecret: 'must-not-cross-event' }],
  ])('rejects %s', (_caseName, payload) => {
    expect(validateMarineEvent('MarineAnalysisRequested', payload).valid).toBe(false);
  });

  it('rejects an unknown event type and non-object payload', () => {
    expect(validateMarineEvent('MarineAnalysisRequestedV2', fixture).valid).toBe(false);
    expect(validateMarineEvent('MarineAnalysisRequested', []).valid).toBe(false);
  });
});

describe('marine worker subject-indexed schemas', () => {
  const subjects = Object.values(MARINE_WORKER_CONTROL_SUBJECTS);

  it('has one request and reply schema plus valid golden fixtures for every subject', () => {
    expect(Object.keys(MARINE_WORKER_CONTROL_REQUEST_SCHEMAS).sort()).toEqual([...subjects].sort());
    expect(Object.keys(MARINE_WORKER_CONTROL_REPLY_SCHEMAS).sort()).toEqual([...subjects].sort());

    for (const subject of subjects) {
      const fixtureNames = CONTROL_FIXTURES[subject];
      const request = loadFixture(fixtureNames.request);
      const reply = loadFixture(fixtureNames.reply);
      expect(validateMarineWorkerControlRequest(subject, request)).toEqual({ valid: true });
      expect(validateMarineWorkerControlReply(subject, reply)).toEqual({ valid: true });
      expect(validateMarineWorkerControlExchange(subject, request, reply)).toEqual({ valid: true });
    }
  });

  it('rejects an unknown subject, arrays, and additional fields', () => {
    const request = loadFixture('marine-execution-lease-request.json');
    expect(validateMarineWorkerControlRequest('request.farm.unknown', request).valid).toBe(false);
    expect(
      validateMarineWorkerControlRequest(MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_LEASE, []).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlRequest(MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_LEASE, {
        ...request,
        arbitraryPayload: {},
      }).valid,
    ).toBe(false);
  });

  it('rejects additional fields on every request and reply root', () => {
    for (const subject of subjects) {
      const fixtureNames = CONTROL_FIXTURES[subject];
      expect(
        validateMarineWorkerControlRequest(subject, {
          ...loadFixture(fixtureNames.request),
          unexpected: true,
        }).valid,
      ).toBe(false);
      expect(
        validateMarineWorkerControlReply(subject, {
          ...loadFixture(fixtureNames.reply),
          unexpected: true,
        }).valid,
      ).toBe(false);
    }
  });

  it('requires canonical UTC millisecond precision on every Marine control timestamp', () => {
    const timestampFields = [
      [MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_LEASE, 'request', ['requestedAt']],
      [
        MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_LEASE,
        'reply',
        [
          'issuedAt',
          'expiresAt',
          'requestedAt',
          'temporalPartitionBoundaryAt',
          'providerCoverageStart',
          'providerCoverageEnd',
          'timeStart',
          'timeEnd',
          'deadlineAt',
        ],
      ],
      [MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_RENEW, 'reply', ['issuedAt', 'expiresAt']],
      [MARINE_WORKER_CONTROL_SUBJECTS.CREDENTIAL_LEASE, 'reply', ['issuedAt', 'expiresAt']],
      [MARINE_WORKER_CONTROL_SUBJECTS.USAGE_RESERVE, 'reply', ['reservedAt']],
      [MARINE_WORKER_CONTROL_SUBJECTS.USAGE_FINALIZE, 'request', ['finishedAt']],
      [MARINE_WORKER_CONTROL_SUBJECTS.USAGE_FINALIZE, 'reply', ['finalizedAt']],
      [MARINE_WORKER_CONTROL_SUBJECTS.ARTIFACT_LEASE, 'reply', ['issuedAt', 'expiresAt']],
      [MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_FINALIZE, 'request', ['finishedAt']],
      [MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_FINALIZE, 'reply', ['finalizedAt']],
    ] as const;

    for (const [subject, side, fields] of timestampFields) {
      const fixtureName = CONTROL_FIXTURES[subject][side];
      const payload = loadFixture(fixtureName);
      const validate =
        side === 'request' ? validateMarineWorkerControlRequest : validateMarineWorkerControlReply;
      for (const field of fields) {
        const timestamp = payload[field];
        if (typeof timestamp !== 'string') {
          throw new TypeError(`${fixtureName}.${field} must be a timestamp string`);
        }
        expect(
          validate(subject, {
            ...payload,
            [field]: timestamp.replace(/Z$/, '0001Z'),
          }).valid,
        ).toBe(false);
        expect(
          validate(subject, {
            ...payload,
            [field]: timestamp.replace(/Z$/, '+00:00'),
          }).valid,
        ).toBe(false);
      }
    }
  });

  it('binds the execution lease to nonce, request fingerprint, and requestedAt', () => {
    const request = loadFixture('marine-execution-lease-request.json');
    const subject = MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_LEASE;
    expect(
      validateMarineWorkerControlRequest(subject, {
        ...request,
        nonce: 'short',
      }).valid,
    ).toBe(false);
    const { requestFingerprint: _omitted, ...withoutFingerprint } = request;
    expect(validateMarineWorkerControlRequest(subject, withoutFingerprint).valid).toBe(false);
    const { requestedAt: _requestedAt, ...withoutRequestedAt } = request;
    expect(validateMarineWorkerControlRequest(subject, withoutRequestedAt).valid).toBe(false);
  });

  it.each([
    ['tenantId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    ['jobId', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
    ['executionId', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
    ['requestFingerprint', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    ['requestedAt', '2026-07-19T12:00:00.001Z'],
  ])('rejects an execution lease reply with mismatched %s', (field, replacement) => {
    const request = loadFixture('marine-execution-lease-request.json');
    const reply = loadFixture('marine-execution-lease-reply.json');
    expect(
      validateMarineWorkerControlExchange(MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_LEASE, request, {
        ...reply,
        [field]: replacement,
      }).valid,
    ).toBe(false);
  });

  it('keeps credential leases CMEMS-only and binds the selected generation', () => {
    const request = loadFixture('marine-credential-lease-request.json');
    const reply = loadFixture('marine-credential-lease-reply.json');
    expect(
      validateMarineWorkerControlRequest(MARINE_WORKER_CONTROL_SUBJECTS.CREDENTIAL_LEASE, {
        ...request,
        provider: 'CDSE',
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlReply(MARINE_WORKER_CONTROL_SUBJECTS.CREDENTIAL_LEASE, {
        ...reply,
        kind: 'CDSE_CLIENT_CREDENTIALS',
        value: {
          clientId: 'fixture-client-not-a-real-account',
          clientSecret: 'fixture-value-not-a-real-secret',
        },
      }).valid,
    ).toBe(false);
    const { credentialGeneration: _credentialGeneration, ...withoutGeneration } = request;
    expect(
      validateMarineWorkerControlRequest(
        MARINE_WORKER_CONTROL_SUBJECTS.CREDENTIAL_LEASE,
        withoutGeneration,
      ).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlExchange(
        MARINE_WORKER_CONTROL_SUBJECTS.CREDENTIAL_LEASE,
        { ...request, credentialGeneration: 4 },
        reply,
      ).valid,
    ).toBe(false);
  });

  it('rejects usage replies from a different operation or terminal outcome', () => {
    const reserveRequest = loadFixture('marine-usage-reserve-request.json');
    const reserveReply = loadFixture('marine-usage-reserve-reply.json');
    expect(
      validateMarineWorkerControlExchange(
        MARINE_WORKER_CONTROL_SUBJECTS.USAGE_RESERVE,
        reserveRequest,
        {
          ...reserveReply,
          operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        },
      ).valid,
    ).toBe(false);

    const finalizeRequest = loadFixture('marine-usage-finalize-request.json');
    const finalizeReply = loadFixture('marine-usage-finalize-reply.json');
    expect(
      validateMarineWorkerControlExchange(
        MARINE_WORKER_CONTROL_SUBJECTS.USAGE_FINALIZE,
        finalizeRequest,
        {
          ...finalizeReply,
          operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        },
      ).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlExchange(
        MARINE_WORKER_CONTROL_SUBJECTS.USAGE_FINALIZE,
        finalizeRequest,
        {
          ...finalizeReply,
          state: 'FAILED',
        },
      ).valid,
    ).toBe(false);
  });

  it('enforces the execution resource ceilings in the wire contract', () => {
    const reply = loadFixture('marine-execution-lease-reply.json');
    const subject = MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_LEASE;
    expect(
      validateMarineWorkerControlReply(subject, {
        ...reply,
        maxCells: 1000001,
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlReply(subject, {
        ...reply,
        maxOutputBytes: 268435457,
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlReply(subject, {
        ...reply,
        renewAfterSeconds: 21,
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlReply(subject, {
        ...reply,
        expiresAt: '2026-07-19T12:00:20.000Z',
        renewAfterSeconds: 20,
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlReply(subject, {
        ...reply,
        expiresAt: '2026-07-19T12:00:01.000Z',
        renewAfterSeconds: 20,
      }).valid,
    ).toBe(false);
    expect(reply).not.toHaveProperty('resultObjectPrefix');
  });

  it('accepts only canonical two-dimensional Polygon or MultiPolygon marine areas', () => {
    const reply = loadFixture('marine-execution-lease-reply.json');
    const subject = MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_LEASE;
    const validMultiPolygon = JSON.stringify({
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [10, 60],
            [11, 60],
            [11, 61],
            [10, 60],
          ],
        ],
        [
          [
            [-2, -2],
            [-1, -2],
            [-1, -1],
            [-2, -2],
          ],
        ],
      ],
    });
    expect(
      validateMarineWorkerControlReply(subject, {
        ...reply,
        marineAreaGeoJson: validMultiPolygon,
        marineAreaSha256: utf8Sha256(validMultiPolygon),
      }),
    ).toEqual({ valid: true });

    expect(
      validateMarineWorkerControlReply(subject, {
        ...reply,
        marineAreaSha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      }).valid,
    ).toBe(false);

    const invalidMarineAreas = [
      'xx',
      '{"type":"Polygon","coordinates":',
      JSON.stringify({ type: 'Point', coordinates: [10, 60] }),
      JSON.stringify({
        type: 'Polygon',
        coordinates: [
          [
            [10, 60],
            [11, 60],
            [11, 61],
            [10, 60],
          ],
        ],
        unexpected: true,
      }),
      JSON.stringify({ type: 'Polygon', coordinates: [] }),
      JSON.stringify({ type: 'Polygon', coordinates: [[]] }),
      JSON.stringify({
        type: 'Polygon',
        coordinates: [
          [
            [10, 60],
            [11, 60],
            [10, 60],
          ],
        ],
      }),
      JSON.stringify({
        type: 'Polygon',
        coordinates: [
          [
            [10, 60],
            [11, 60],
            [11, 61],
            [10, 61],
          ],
        ],
      }),
      JSON.stringify({
        type: 'Polygon',
        coordinates: [[[[10, 60]], [[11, 60]], [[11, 61]], [[10, 60]]]],
      }),
      JSON.stringify({
        type: 'Polygon',
        coordinates: [
          [
            [10, 60, 2],
            [11, 60],
            [11, 61],
            [10, 60, 2],
          ],
        ],
      }),
      JSON.stringify({
        type: 'Polygon',
        coordinates: [
          [
            ['10', 60],
            [11, 60],
            [11, 61],
            ['10', 60],
          ],
        ],
      }),
      JSON.stringify({
        type: 'Polygon',
        coordinates: [
          [
            [181, 0],
            [0, 0],
            [0, 1],
            [181, 0],
          ],
        ],
      }),
      JSON.stringify({
        type: 'Polygon',
        coordinates: [
          [
            [0, 91],
            [1, 0],
            [1, 1],
            [0, 91],
          ],
        ],
      }),
      '{"type":"Polygon","coordinates":[[[1e309,0],[0,0],[0,1],[1e309,0]]]}',
      '{"type":"Polygon","coordinates":[[[NaN,0],[0,0],[0,1],[NaN,0]]]}',
      '{"type":"Polygon","type":"Polygon","coordinates":[[[10,60],[11,60],[11,61],[10,60]]]}',
      '{"type":"Point","t\\u0079pe":"Polygon","coordinates":[[[10,60],[11,60],[11,61],[10,60]]]}',
      '{ "type": "Polygon", "coordinates": [[[10,60],[11,60],[11,61],[10,60]]] }',
      `${String(reply.marineAreaGeoJson)}${'é'.repeat(140_000)}`,
    ];
    for (const marineAreaGeoJson of invalidMarineAreas) {
      expect(
        validateMarineWorkerControlReply(subject, {
          ...reply,
          marineAreaGeoJson,
          marineAreaSha256: utf8Sha256(marineAreaGeoJson),
        }).valid,
      ).toBe(false);
    }
  });

  it('hashes the exact UTF-8 marine-area bytes without a Node-only runtime dependency', () => {
    const values = [
      '',
      'marine-area',
      'deniz-çiftliği-🌊',
      'a'.repeat(55),
      'a'.repeat(56),
      'a'.repeat(63),
      'a'.repeat(64),
      'a'.repeat(65),
      `${'é'.repeat(31)}a`,
      `${'é'.repeat(32)}a`,
      'z'.repeat(262_144),
    ];
    for (const value of values) {
      expect(sha256Utf8Hex(value)).toBe(utf8Sha256(value));
    }
    const reply = loadFixture('marine-execution-lease-reply.json');
    expect(sha256Utf8Hex(String(reply.marineAreaGeoJson))).toBe(reply.marineAreaSha256);
  });

  it('keeps the worker CMEMS-only with catalogue-correlated temporal roles', () => {
    expect(MARINE_DATA_ROLES).toEqual(['ANALYSIS', 'FORECAST', 'REANALYSIS', 'HINDCAST']);
    const reply = loadFixture('marine-execution-lease-reply.json');
    const subject = MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_LEASE;
    expect(
      validateMarineWorkerControlReply(subject, {
        ...reply,
        provider: 'CDSE',
        dataRole: 'ANALYSIS',
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlReply(subject, {
        ...reply,
        provider: 'CMEMS',
        dataRole: 'OBSERVATION',
        temporalPartitionBoundaryAt: null,
      }).valid,
    ).toBe(false);
    const validCmemsRoles = [
      { dataRole: 'ANALYSIS' },
      {
        dataRole: 'FORECAST',
        selectionProvenance: resolvedSelectionProvenance('cmems.operational.currents.forecast'),
        timeStart: '2026-07-19T12:00:00.001Z',
        timeEnd: '2026-07-20T00:00:00.000Z',
        providerCoverageEnd: '2026-07-20T00:00:00.000Z',
      },
      {
        dataRole: 'REANALYSIS',
        selectionProvenance: resolvedSelectionProvenance('cmems.reanalysis.currents.reanalysis'),
        temporalPartitionBoundaryAt: null,
      },
      {
        dataRole: 'HINDCAST',
        selectionProvenance: resolvedSelectionProvenance('cmems.hindcast.oxygen.hindcast'),
        temporalPartitionBoundaryAt: null,
      },
    ];
    for (const temporalRole of validCmemsRoles) {
      expect(
        validateMarineWorkerControlReply(subject, {
          ...reply,
          provider: 'CMEMS',
          ...temporalRole,
        }),
      ).toEqual({ valid: true });
    }
  });

  it('rejects every cross-spliced CMEMS selection field against the resolved catalogue lock', () => {
    const reply = loadFixture('marine-execution-lease-reply.json');
    const provenance = objectProperty(reply, 'selectionProvenance');
    const spatialResolution = objectProperty(provenance, 'spatialResolution');
    const depthSelection = objectProperty(provenance, 'depthSelection');
    const processing = objectProperty(provenance, 'processing');
    const noData = objectProperty(provenance, 'noData');
    const display = objectProperty(provenance, 'display');
    const displayArtifact = objectProperty(display, 'artifact');
    const attribution = objectProperty(provenance, 'attribution');
    const toolbox = objectProperty(provenance, 'toolbox');
    const toolboxArtifact = objectProperty(toolbox, 'artifact');
    const subject = MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_LEASE;

    const mutations: ReadonlyArray<[string, Record<string, unknown>]> = [
      [
        'catalog entry',
        { ...provenance, catalogEntryId: 'cmems.operational.temperature.analysis' },
      ],
      ['provider', { ...provenance, provider: 'CDSE' }],
      ['data kind', { ...provenance, dataKind: 'SCALAR' }],
      ['product', { ...provenance, productId: 'GLOBAL_ANALYSISFORECAST_BGC_001_028' }],
      ['dataset', { ...provenance, datasetId: 'cmems_mod_glo_phy-thetao_anfc_0.083deg_P1D-m' }],
      ['dataset version', { ...provenance, datasetVersionPart: '202311' }],
      [
        'variable unit',
        {
          ...provenance,
          variables: [
            { id: 'uo', unit: 'degrees_C' },
            { id: 'vo', unit: 'm s-1' },
          ],
        },
      ],
      [
        'duplicate variable id',
        {
          ...provenance,
          variables: [
            { id: 'uo', unit: 'm s-1' },
            { id: 'uo', unit: 'different-unit' },
          ],
        },
      ],
      [
        'variable order',
        {
          ...provenance,
          variables: [
            { id: 'vo', unit: 'm s-1' },
            { id: 'uo', unit: 'm s-1' },
          ],
        },
      ],
      [
        'resolution',
        {
          ...provenance,
          spatialResolution: { ...spatialResolution, x: 0.25, y: 0.25 },
        },
      ],
      [
        'depth axis',
        {
          ...provenance,
          depthSelection: { ...depthSelection, levelCount: 75 },
        },
      ],
      [
        'selection method',
        {
          ...provenance,
          selectionMethodId: 'cmems.toolbox.strict-inside.depth.v2',
        },
      ],
      [
        'processing derivation',
        {
          ...provenance,
          processing: {
            ...processing,
            derivationId: 'marine.cmems.raw-scalar',
            vectorDerivation: null,
          },
        },
      ],
      [
        'no-data metadata order',
        {
          ...provenance,
          noData: {
            ...noData,
            metadataKeysInPriorityOrder: ['missing_value', '_FillValue'],
          },
        },
      ],
      ['recipe nullability', { ...provenance, recipeSha256: 'f'.repeat(64) }],
      [
        'WMTS capabilities URL',
        {
          ...provenance,
          display: {
            ...display,
            wmtsCapabilitiesUrl:
              'https://wmts.marine.copernicus.eu/teroWmts/GLOBAL_ANALYSISFORECAST_PHY_001_024/cmems_mod_glo_phy-thetao_anfc_0.083deg_P1D-m_202406?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetCapabilities',
          },
        },
      ],
      ['display variable', { ...provenance, display: { ...display, variable: 'thetao' } }],
      ['style', { ...provenance, display: { ...display, style: 'cmap:thermal' } }],
      [
        'legend',
        {
          ...provenance,
          display: {
            ...display,
            legendId: 'legend.cmems.operational.temperature.202406.thermal',
          },
        },
      ],
      [
        'display authority',
        {
          ...provenance,
          display: {
            ...display,
            artifact: { ...displayArtifact, authority: 'NUMERIC' },
          },
        },
      ],
      [
        'attribution',
        {
          ...provenance,
          attribution: {
            ...attribution,
            id: 'attribution.cmems.global-analysisforecast-bgc-001-028.v1',
          },
        },
      ],
      [
        'attribution credit',
        {
          ...provenance,
          attribution: {
            ...attribution,
            creditTemplate: 'Generated from an uncorrelated product',
          },
        },
      ],
      [
        'toolbox artifact',
        {
          ...provenance,
          toolbox: {
            ...toolbox,
            artifact: { ...toolboxArtifact, sizeBytes: 154166191 },
          },
        },
      ],
      ['catalog revision', { ...provenance, catalogRevision: 'f'.repeat(64) }],
    ];

    for (const [_caseName, selectionProvenance] of mutations) {
      expect(
        validateMarineWorkerControlReply(subject, {
          ...reply,
          selectionProvenance,
        }).valid,
      ).toBe(false);
    }

    const { recipeSha256: _recipeSha256, ...withoutRequiredNullableRecipe } = provenance;
    expect(
      validateMarineWorkerControlReply(subject, {
        ...reply,
        selectionProvenance: withoutRequiredNullableRecipe,
      }).valid,
    ).toBe(false);
    expect(provenance.recipeSha256).toBeNull();
    expect(validateMarineWorkerControlReply(subject, reply)).toEqual({ valid: true });

    for (const legacyField of [
      'catalogRevision',
      'datasetId',
      'datasetVersion',
      'variableIds',
      'recipeId',
      'recipeSha256',
    ]) {
      expect(
        validateMarineWorkerControlReply(subject, {
          ...reply,
          [legacyField]: 'legacy-top-level-value',
        }).valid,
      ).toBe(false);
    }
  });

  it('pins immutable temporal selection provenance and observed provider coverage', () => {
    const request = loadFixture('marine-execution-lease-request.json');
    const reply = loadFixture('marine-execution-lease-reply.json');
    const subject = MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_LEASE;

    for (const field of [
      'requestedAt',
      'temporalPartitionBoundaryAt',
      'providerCoverageStart',
      'providerCoverageEnd',
    ]) {
      const withoutField = Object.fromEntries(
        Object.entries(reply).filter(([propertyName]) => propertyName !== field),
      );
      expect(validateMarineWorkerControlReply(subject, withoutField).valid).toBe(false);
    }

    for (const field of [
      'requestedAt',
      'temporalPartitionBoundaryAt',
      'providerCoverageStart',
      'providerCoverageEnd',
    ]) {
      expect(
        validateMarineWorkerControlReply(subject, {
          ...reply,
          [field]: 'not-a-date-time',
        }).valid,
      ).toBe(false);
    }

    expect(
      validateMarineWorkerControlReply(subject, {
        ...reply,
        providerCoverageStart: '2026-07-19T00:00:00.001Z',
        providerCoverageEnd: '2026-07-19T00:00:00.000Z',
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlReply(subject, {
        ...reply,
        providerCoverageStart: '2026-07-18T00:00:00.001Z',
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlReply(subject, {
        ...reply,
        providerCoverageEnd: '2026-07-17T23:59:59.999Z',
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlReply(subject, {
        ...reply,
        temporalPartitionBoundaryAt: '2026-07-19T12:00:00.001Z',
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlReply(subject, {
        ...reply,
        temporalPartitionBoundaryAt: null,
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlReply(subject, {
        ...reply,
        timeEnd: '2026-07-19T12:00:00.001Z',
        providerCoverageEnd: '2026-07-20T00:00:00.000Z',
      }).valid,
    ).toBe(false);

    const forecastReply = {
      ...reply,
      dataRole: 'FORECAST',
      selectionProvenance: resolvedSelectionProvenance('cmems.operational.currents.forecast'),
      timeStart: '2026-07-19T12:00:00.001Z',
      timeEnd: '2026-07-20T00:00:00.000Z',
      providerCoverageEnd: '2026-07-20T00:00:00.000Z',
    };
    expect(validateMarineWorkerControlReply(subject, forecastReply)).toEqual({ valid: true });
    expect(
      validateMarineWorkerControlReply(subject, {
        ...forecastReply,
        timeStart: reply.requestedAt,
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlReply(subject, {
        ...forecastReply,
        temporalPartitionBoundaryAt: null,
      }).valid,
    ).toBe(false);

    const unpartitionedRoles: ReadonlyArray<[string, string]> = [
      ['REANALYSIS', 'cmems.reanalysis.currents.reanalysis'],
      ['HINDCAST', 'cmems.hindcast.oxygen.hindcast'],
    ];
    for (const [dataRole, catalogEntryId] of unpartitionedRoles) {
      const unpartitionedReply = {
        ...reply,
        dataRole,
        selectionProvenance: resolvedSelectionProvenance(catalogEntryId),
        temporalPartitionBoundaryAt: null,
      };
      expect(validateMarineWorkerControlReply(subject, unpartitionedReply)).toEqual({
        valid: true,
      });
      expect(
        validateMarineWorkerControlReply(subject, {
          ...unpartitionedReply,
          temporalPartitionBoundaryAt: reply.requestedAt,
        }).valid,
      ).toBe(false);
    }

    expect(validateMarineWorkerControlExchange(subject, request, reply)).toEqual({ valid: true });
  });

  it('enforces bounded issuance windows without evaluating wall-clock freshness', () => {
    const expiringReplies = [
      [MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_LEASE, 'marine-execution-lease-reply.json'],
      [MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_RENEW, 'marine-execution-renew-reply.json'],
      [MARINE_WORKER_CONTROL_SUBJECTS.CREDENTIAL_LEASE, 'marine-credential-lease-reply.json'],
      [MARINE_WORKER_CONTROL_SUBJECTS.ARTIFACT_LEASE, 'marine-artifact-lease-reply.json'],
    ] as const;

    for (const [subject, fixtureName] of expiringReplies) {
      const reply = loadFixture(fixtureName);
      if (typeof reply.issuedAt !== 'string') {
        throw new TypeError(`${fixtureName} must contain issuedAt`);
      }
      const overlongExpiresAt = new Date(Date.parse(reply.issuedAt) + 60_001).toISOString();
      const withoutIssuedAt = Object.fromEntries(
        Object.entries(reply).filter(([propertyName]) => propertyName !== 'issuedAt'),
      );
      expect(validateMarineWorkerControlReply(subject, withoutIssuedAt).valid).toBe(false);
      expect(
        validateMarineWorkerControlReply(subject, {
          ...reply,
          issuedAt: '2026-07-19T12:02:00.000Z',
          expiresAt: '2026-07-19T12:01:00.000Z',
        }).valid,
      ).toBe(false);
      expect(
        validateMarineWorkerControlReply(subject, {
          ...reply,
          expiresAt: overlongExpiresAt,
        }).valid,
      ).toBe(false);

      const pastReply: Record<string, unknown> = {
        ...reply,
        issuedAt: '2000-01-01T00:00:00.000Z',
        expiresAt: '2000-01-01T00:01:00.000Z',
      };
      if (subject === MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_LEASE) {
        pastReply.deadlineAt = '2000-01-01T00:10:00.000Z';
      }
      expect(validateMarineWorkerControlReply(subject, pastReply)).toEqual({ valid: true });
    }
  });

  it('evaluates lease freshness deterministically with a five-second clock skew', () => {
    expect(MARINE_MAX_CLOCK_SKEW_SECONDS).toBe(5);
    const expiringReplies = [
      [MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_LEASE, 'marine-execution-lease-reply.json'],
      [MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_RENEW, 'marine-execution-renew-reply.json'],
      [MARINE_WORKER_CONTROL_SUBJECTS.CREDENTIAL_LEASE, 'marine-credential-lease-reply.json'],
      [MARINE_WORKER_CONTROL_SUBJECTS.ARTIFACT_LEASE, 'marine-artifact-lease-reply.json'],
    ] as const;
    for (const [subject, fixtureName] of expiringReplies) {
      const reply = loadFixture(fixtureName);
      if (typeof reply.issuedAt !== 'string') {
        throw new TypeError(`${fixtureName} must contain issuedAt`);
      }
      expect(validateMarineWorkerControlReplyAt(subject, reply, new Date(reply.issuedAt))).toEqual({
        valid: true,
      });
    }

    const credentialReply = loadFixture('marine-credential-lease-reply.json');
    expect(
      validateMarineWorkerControlReplyAt(
        MARINE_WORKER_CONTROL_SUBJECTS.CREDENTIAL_LEASE,
        {
          ...credentialReply,
          issuedAt: '2000-01-01T00:00:00.000Z',
          expiresAt: '2000-01-01T00:01:00.000Z',
        },
        '2026-07-19T12:00:00.000Z',
      ).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlReplyAt(
        MARINE_WORKER_CONTROL_SUBJECTS.CREDENTIAL_LEASE,
        {
          ...credentialReply,
          issuedAt: '2026-07-19T11:59:30.000Z',
          expiresAt: '2026-07-19T12:00:00.000Z',
        },
        '2026-07-19T12:00:00.000Z',
      ).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlReplyAt(
        MARINE_WORKER_CONTROL_SUBJECTS.CREDENTIAL_LEASE,
        {
          ...credentialReply,
          issuedAt: '2026-07-19T12:00:05.000Z',
          expiresAt: '2026-07-19T12:01:05.000Z',
        },
        '2026-07-19T12:00:00.000Z',
      ),
    ).toEqual({ valid: true });
    expect(
      validateMarineWorkerControlReplyAt(
        MARINE_WORKER_CONTROL_SUBJECTS.CREDENTIAL_LEASE,
        {
          ...credentialReply,
          issuedAt: '2026-07-19T12:00:05.001Z',
          expiresAt: '2026-07-19T12:01:05.001Z',
        },
        '2026-07-19T12:00:00.000Z',
      ).valid,
    ).toBe(false);

    const renewRequest = loadFixture('marine-execution-renew-request.json');
    expect(
      validateMarineWorkerControlReplyAt(
        MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_RENEW,
        {
          decision: 'STOP',
          executionLeaseId: renewRequest.executionLeaseId,
          leaseVersion: renewRequest.leaseVersion,
          reason: 'DEADLINE_EXCEEDED',
        },
        'not-a-timestamp',
      ),
    ).toEqual({ valid: true });
    expect(
      validateMarineWorkerControlReplyAt(
        MARINE_WORKER_CONTROL_SUBJECTS.USAGE_RESERVE,
        loadFixture('marine-usage-reserve-reply.json'),
        'not-a-timestamp',
      ),
    ).toEqual({ valid: true });
  });

  it('enforces snapshot lineage, ordered depth/time ranges, and bounded deadline', () => {
    const reply = loadFixture('marine-execution-lease-reply.json');
    const subject = MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_LEASE;
    expect(
      validateMarineWorkerControlReply(subject, {
        ...reply,
        sourceSnapshotJobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }).valid,
    ).toBe(false);
    for (const jobKind of ['AOI_STATS', 'TIME_SERIES']) {
      expect(
        validateMarineWorkerControlReply(subject, {
          ...reply,
          jobKind,
          sourceSnapshotJobId: null,
        }).valid,
      ).toBe(false);
      expect(
        validateMarineWorkerControlReply(subject, {
          ...reply,
          jobKind,
          sourceSnapshotJobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        }),
      ).toEqual({ valid: true });
    }
    for (const [depthMinMeters, depthMaxMeters] of [
      [null, 1],
      [0, null],
      [2, 1],
    ]) {
      expect(
        validateMarineWorkerControlReply(subject, {
          ...reply,
          depthMinMeters,
          depthMaxMeters,
        }).valid,
      ).toBe(false);
    }
    expect(
      validateMarineWorkerControlReply(subject, {
        ...reply,
        depthMinMeters: null,
        depthMaxMeters: null,
      }),
    ).toEqual({ valid: true });
    expect(
      validateMarineWorkerControlReply(subject, {
        ...reply,
        timeStart: '2026-07-19T00:00:00.000Z',
        timeEnd: '2026-07-18T00:00:00.000Z',
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlReply(subject, {
        ...reply,
        deadlineAt: reply.issuedAt,
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlReply(subject, {
        ...reply,
        deadlineAt: '2026-07-19T12:10:00.001Z',
      }).valid,
    ).toBe(false);
  });

  it('pins lossless TypeScript/Rust fencing epochs to MAX_SAFE_INTEGER', () => {
    expect(MARINE_MAX_SAFE_INTEGER).toBe(Number.MAX_SAFE_INTEGER);
    const reply = loadFixture('marine-execution-lease-reply.json');
    const subject = MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_LEASE;
    expect(
      validateMarineWorkerControlReply(subject, {
        ...reply,
        leaseVersion: MARINE_MAX_SAFE_INTEGER,
      }),
    ).toEqual({ valid: true });
    expect(
      validateMarineWorkerControlReply(subject, {
        ...reply,
        leaseVersion: MARINE_MAX_SAFE_INTEGER + 1,
      }).valid,
    ).toBe(false);
  });

  it.each([
    ['marine-execution-lease-reply.json', 'reply', 'leaseVersion'],
    ['marine-execution-renew-request.json', 'request', 'executionLeaseId'],
    ['marine-execution-renew-request.json', 'request', 'leaseVersion'],
    ['marine-credential-lease-request.json', 'request', 'executionLeaseId'],
    ['marine-credential-lease-request.json', 'request', 'leaseVersion'],
    ['marine-usage-reserve-request.json', 'request', 'leaseVersion'],
    ['marine-usage-finalize-request.json', 'request', 'leaseVersion'],
    ['marine-artifact-lease-request.json', 'request', 'executionLeaseId'],
    ['marine-artifact-lease-request.json', 'request', 'leaseVersion'],
    ['marine-execution-finalize-request.json', 'request', 'leaseVersion'],
  ] as const)('requires fenced field %s %s.%s', (fixtureName, direction, field) => {
    const fixture = loadFixture(fixtureName);
    const withoutField = Object.fromEntries(
      Object.entries(fixture).filter(([propertyName]) => propertyName !== field),
    );
    const subject = Object.entries(CONTROL_FIXTURES).find(
      ([, fixtureNames]) => fixtureNames[direction] === fixtureName,
    )?.[0];
    if (!subject) {
      throw new Error(`missing subject for ${fixtureName}`);
    }
    const result =
      direction === 'request'
        ? validateMarineWorkerControlRequest(subject, withoutField)
        : validateMarineWorkerControlReply(subject, withoutField);
    expect(result.valid).toBe(false);
  });

  it('keeps a renewal on the same fencing epoch and closes both reply decisions', () => {
    const request = loadFixture('marine-execution-renew-request.json');
    const reply = loadFixture('marine-execution-renew-reply.json');
    const subject = MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_RENEW;
    expect(validateMarineWorkerControlExchange(subject, request, reply)).toEqual({ valid: true });
    expect(
      validateMarineWorkerControlReply(subject, {
        decision: 'STOP',
        executionLeaseId: request.executionLeaseId,
        leaseVersion: request.leaseVersion,
        reason: 'CANCEL_REQUESTED',
      }),
    ).toEqual({ valid: true });
    expect(
      validateMarineWorkerControlExchange(subject, request, {
        ...reply,
        leaseVersion: 2,
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlReply(subject, {
        decision: 'STOP',
        executionLeaseId: request.executionLeaseId,
        leaseVersion: request.leaseVersion,
        reason: 'LEASE_FENCED',
        expiresAt: '2026-07-19T12:01:10.000Z',
      }).valid,
    ).toBe(false);
  });

  it('accepts only the mode-specific artifact request fields and byte cap', () => {
    const request = loadFixture('marine-artifact-lease-request.json');
    const subject = MARINE_WORKER_CONTROL_SUBJECTS.ARTIFACT_LEASE;
    expect(
      validateMarineWorkerControlRequest(subject, {
        ...request,
        mode: 'READ',
      }).valid,
    ).toBe(false);
    const { siteId: _siteId, ...withoutSiteId } = request;
    expect(validateMarineWorkerControlRequest(subject, withoutSiteId).valid).toBe(false);
    expect(
      validateMarineWorkerControlRequest(subject, {
        ...request,
        byteLength: 268435457,
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlRequest(subject, {
        ...request,
        objectKey: 'marine/caller-controlled',
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlRequest(subject, {
        ...request,
        resultObjectPrefix: 'marine/caller-controlled/',
      }).valid,
    ).toBe(false);
  });

  it('couples WRITE to PUT and authoritative content metadata', () => {
    const request = loadFixture('marine-artifact-lease-request.json');
    const reply = loadFixture('marine-artifact-lease-reply.json');
    const requiredHeaders = objectProperty(reply, 'requiredHeaders');
    const subject = MARINE_WORKER_CONTROL_SUBJECTS.ARTIFACT_LEASE;
    expect(validateMarineWorkerControlExchange(subject, request, reply)).toEqual({ valid: true });
    expect(
      validateMarineWorkerControlExchange(subject, request, {
        ...reply,
        method: 'GET',
        requiredHeaders: {},
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlExchange(subject, request, {
        ...reply,
        requiredHeaders: {
          ...requiredHeaders,
          'content-length': '4095',
        },
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlExchange(subject, request, {
        ...reply,
        objectKey: String(reply.objectKey).replace(
          '55555555-5555-4555-8555-555555555555',
          '66666666-6666-4666-8666-666666666666',
        ),
      }).valid,
    ).toBe(false);
  });

  it('couples READ to GET and the source snapshot content-addressed key', () => {
    const writeRequest = loadFixture('marine-artifact-lease-request.json');
    const writeReply = loadFixture('marine-artifact-lease-reply.json');
    const request = {
      tenantId: writeRequest.tenantId,
      siteId: writeRequest.siteId,
      jobId: writeRequest.jobId,
      executionId: writeRequest.executionId,
      executionLeaseId: writeRequest.executionLeaseId,
      leaseVersion: writeRequest.leaseVersion,
      nonce: writeRequest.nonce,
      artifactKind: 'SOURCE_ZARR',
      mode: 'READ',
      sourceSnapshotJobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      artifactSha256: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    };
    const reply = {
      leaseId: writeReply.leaseId,
      method: 'GET',
      issuedAt: writeReply.issuedAt,
      url: writeReply.url,
      objectKey:
        'marine/22222222-2222-4222-8222-222222222222/55555555-5555-4555-8555-555555555555/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee/source.zarr.zip',
      expiresAt: writeReply.expiresAt,
      requiredHeaders: {},
    };
    const subject = MARINE_WORKER_CONTROL_SUBJECTS.ARTIFACT_LEASE;
    expect(validateMarineWorkerControlExchange(subject, request, reply)).toEqual({ valid: true });
    expect(
      validateMarineWorkerControlExchange(subject, request, {
        ...reply,
        method: 'PUT',
        requiredHeaders: writeReply.requiredHeaders,
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlExchange(subject, request, {
        ...reply,
        objectKey: String(reply.objectKey).replace(
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          '33333333-3333-4333-8333-333333333333',
        ),
      }).valid,
    ).toBe(false);
  });

  it('rejects insecure URLs, traversal, header smuggling, and unbounded capabilities', () => {
    const reply = loadFixture('marine-artifact-lease-reply.json');
    const requiredHeaders = objectProperty(reply, 'requiredHeaders');
    const subject = MARINE_WORKER_CONTROL_SUBJECTS.ARTIFACT_LEASE;
    const capabilityPrefix = 'https://minio.example.invalid/';
    expect(
      validateMarineWorkerControlReply(subject, {
        ...reply,
        url: capabilityPrefix.padEnd(4096, 'a'),
      }),
    ).toEqual({ valid: true });
    for (const url of [
      'http://minio.example.invalid/capability',
      'HTTPS://minio.example.invalid/capability',
      'https://',
      'https:///path',
      'https:/path',
      'https://münich.example/capability',
      'https://minio.example.invalid/a b',
      'https://minio.example.invalid/a\nb',
      'https://minio.example.invalid/a\tb',
      'https://minio.example.invalid/\u007f',
      capabilityPrefix.padEnd(4097, 'a'),
    ]) {
      expect(
        validateMarineWorkerControlReply(subject, {
          ...reply,
          url,
        }).valid,
      ).toBe(false);
    }
    expect(
      validateMarineWorkerControlReply(subject, {
        ...reply,
        objectKey:
          'marine/22222222-2222-4222-8222-222222222222/55555555-5555-4555-8555-555555555555/33333333-3333-4333-8333-333333333333/../../statistics.json',
      }).valid,
    ).toBe(false);
    for (const forbiddenHeader of [
      'authorization',
      'Authorization',
      'proxy-authorization',
      'cookie',
      'Cookie',
      'set-cookie',
    ]) {
      expect(
        validateMarineWorkerControlReply(subject, {
          ...reply,
          requiredHeaders: {
            ...requiredHeaders,
            [forbiddenHeader]: 'smuggled',
          },
        }).valid,
      ).toBe(false);
    }
    expect(
      validateMarineWorkerControlReply(subject, {
        ...reply,
        requiredHeaders: {
          ...requiredHeaders,
          'content-type': 'application/json\r\nx-smuggled: true',
        },
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlReply(subject, {
        ...reply,
        requiredHeaders: {
          ...requiredHeaders,
          'if-none-match': 'existing-object-is-allowed',
        },
      }).valid,
    ).toBe(false);
  });

  it('keeps credential reply variants closed and discriminated', () => {
    const reply = loadFixture('marine-credential-lease-reply.json');
    const subject = MARINE_WORKER_CONTROL_SUBJECTS.CREDENTIAL_LEASE;
    expect(
      validateMarineWorkerControlReply(subject, {
        ...reply,
        value: { clientId: 'id', clientSecret: 'secret' },
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlReply(subject, {
        ...reply,
        value: {
          username: 'fixture-user',
          password: 'fixture-value',
          token: 'smuggled-field',
        },
      }).valid,
    ).toBe(false);
  });

  it('enforces provider status and failure-code semantics on usage finalization', () => {
    const request = loadFixture('marine-usage-finalize-request.json');
    const subject = MARINE_WORKER_CONTROL_SUBJECTS.USAGE_FINALIZE;
    expect(
      validateMarineWorkerControlRequest(subject, {
        ...request,
        providerStatusKind: 'HTTP',
        providerStatusCode: 0,
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlRequest(subject, {
        ...request,
        outcome: 'FAILED',
        failureCode: null,
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlRequest(subject, {
        ...request,
        outcome: 'SUCCEEDED',
        failureCode: 'UPSTREAM_FAILED',
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlRequest(subject, {
        ...request,
        providerStatusKind: 'TOOL_EXIT',
        providerStatusCode: 255,
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlRequest(subject, {
        ...request,
        providerStatusKind: 'HTTP',
        providerStatusCode: 500,
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlRequest(subject, {
        ...request,
        providerStatusKind: 'NOT_AVAILABLE',
        providerStatusCode: null,
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlRequest(subject, {
        ...request,
        providerStatusKind: 'HTTP',
        providerStatusCode: 204,
      }),
    ).toEqual({ valid: true });
  });

  it('keeps farm-owned CMEMS WMTS outside the Toolbox worker usage boundary', () => {
    const request = loadFixture('marine-usage-reserve-request.json');
    const subject = MARINE_WORKER_CONTROL_SUBJECTS.USAGE_RESERVE;
    expect(
      validateMarineWorkerControlRequest(subject, {
        ...request,
        operationType: 'CMEMS_WMTS',
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlRequest(subject, {
        ...request,
        provider: 'CDSE',
        operationType: 'CMEMS_WMTS',
      }).valid,
    ).toBe(false);
  });

  it('requires a verified manifest only for successful execution finalization', () => {
    const request = loadFixture('marine-execution-finalize-request.json');
    const reply = loadFixture('marine-execution-finalize-reply.json');
    const subject = MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_FINALIZE;
    expect(
      validateMarineWorkerControlRequest(subject, {
        ...request,
        resultManifestKey: null,
        resultManifestSha256: null,
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlRequest(subject, {
        ...request,
        resultManifestKey: String(request.resultManifestKey).replace(
          '22222222-2222-4222-8222-222222222222',
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        ),
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlRequest(subject, {
        ...request,
        resultManifestKey: String(request.resultManifestKey).replace(
          '33333333-3333-4333-8333-333333333333',
          'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        ),
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlRequest(subject, {
        ...request,
        resultManifestSha256: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlRequest(subject, {
        ...request,
        resultManifestKey:
          'marine/22222222-2222-4222-8222-222222222222/55555555-5555-4555-8555-555555555555/33333333-3333-4333-8333-333333333333/manifest.json',
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlRequest(subject, {
        ...request,
        terminalState: 'FAILED',
        failureCode: 'TOOL_FAILED',
      }).valid,
    ).toBe(false);
    const cancelled = {
      ...request,
      terminalState: 'CANCELLED',
      resultManifestKey: null,
      resultManifestSha256: null,
      failureCode: 'CANCELLED_BY_USER',
      retryable: false,
    };
    expect(validateMarineWorkerControlRequest(subject, cancelled)).toEqual({ valid: true });
    expect(
      validateMarineWorkerControlRequest(subject, {
        ...cancelled,
        retryable: true,
      }).valid,
    ).toBe(false);
    expect(
      validateMarineWorkerControlReply(subject, {
        ...reply,
        manifestVerified: false,
      }).valid,
    ).toBe(false);
    for (const [field, replacement] of [
      ['jobId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      ['executionId', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
    ] as const) {
      expect(
        validateMarineWorkerControlExchange(subject, request, {
          ...reply,
          [field]: replacement,
        }).valid,
      ).toBe(false);
    }
    expect(
      validateMarineWorkerControlExchange(subject, request, {
        ...reply,
        state: 'FAILED',
        manifestVerified: false,
      }).valid,
    ).toBe(false);
  });
});
