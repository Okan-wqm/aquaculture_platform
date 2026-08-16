import {
  canonicalJsonSha256,
  canonicalJsonStringify,
  createCanonicalJsonDocumentV1,
} from '@aquaculture/shared-contracts';

import { freezeAuthorityGraphV1 } from './authority-immutability';

export const FEEDING_HISTORICAL_PROVENANCE_CATALOG_HASH_AUTHORITY_V1 = freezeAuthorityGraphV1({
  domain: 'aquaculture.feeding-historical-provenance-catalog',
  schemaVersion: 'feeding-historical-provenance-catalog/v1',
} as const);

const FEEDING_HISTORICAL_PROVENANCE_CATALOG_SOURCE_V1 = {
  schemaVersion: 'feeding-historical-provenance/v1',
  journal: {
    relation: 'feeding_historical_provenance_events',
    columns: [
      {
        name: 'eventId',
        type: 'uuid',
        nullable: false,
        defaultExpression: 'gen_random_uuid()',
      },
      { name: 'tenantId', type: 'uuid', nullable: false },
      { name: 'subjectKind', type: 'varchar(32)', nullable: false },
      { name: 'subjectId', type: 'uuid', nullable: false },
      { name: 'sequence', type: 'bigint', nullable: false },
      { name: 'prevDigest', type: 'varchar(64)', nullable: false },
      { name: 'eventKind', type: 'varchar(48)', nullable: false },
      { name: 'payload', type: 'jsonb', nullable: false },
      { name: 'payloadCanonical', type: 'text', nullable: false },
      { name: 'operationId', type: 'varchar(200)', nullable: false },
      { name: 'idempotencyKey', type: 'varchar(240)', nullable: false },
      { name: 'recordedAt', type: 'timestamptz', nullable: false },
      { name: 'recordedBy', type: 'varchar(200)', nullable: false },
      { name: 'schemaVersion', type: 'varchar(80)', nullable: false },
      { name: 'catalogDigest', type: 'varchar(64)', nullable: false },
      { name: 'eventDigest', type: 'varchar(64)', nullable: false },
    ],
    appendFunction: 'append_feeding_historical_provenance_v1',
    digestFunction: 'feeding_historical_event_digest_v1',
    tenantIsolation: {
      contextGuc: 'app.current_tenant',
      policyName: 'feeding_historical_provenance_tenant_v1',
      forceRowLevelSecurity: true,
      securityInvokerProjections: true,
    },
    hashDomain: 'aquaculture.feeding-historical-provenance-event',
    digestAlgorithm: 'sha256',
    rootDigest: '0000000000000000000000000000000000000000000000000000000000000000',
    maxPayloadBytes: 65_536,
  },
  projections: {
    currentEvent: 'feeding_historical_current_events_v1',
    recordAttribution: 'feeding_historical_record_attribution_v1',
    qualifiedRecords: 'feeding_historical_qualified_records_v1',
    dayPlanGrowth: 'feeding_historical_day_plan_growth_v1',
  },
  /**
   * Physical read-model contract consumed by SQL compilers. Relation names
   * remain owned by `projections`; matching keys prevent a second name
   * registry. A passthrough projection references its entity relation instead
   * of copying that relation's column vocabulary.
   */
  projectionSchemas: {
    currentEvent: {
      columns: [
        'tenantId',
        'subjectKind',
        'subjectId',
        'sequence',
        'eventKind',
        'payload',
        'eventDigest',
        'recordedAt',
      ],
    },
    recordAttribution: {
      columns: [
        'tenantId',
        'feedingRecordId',
        'sequence',
        'eventDigest',
        'recordedAt',
        'status',
        'reasonCode',
        'batchId',
        'batchLocationId',
        'equipmentId',
        'locationType',
        'sourceExecutionId',
        'payload',
      ],
    },
    qualifiedRecords: { columnSourceRelation: 'feeding_records' },
    dayPlanGrowth: {
      columns: [
        'tenantId',
        'dayPlanId',
        'status',
        'policyEventDigest',
        'reasonCode',
        'policyVersion',
        'growthApplicationMode',
        'expectedFcr',
        'totalAppliedFeedKg',
        'totalAppliedGrowthKg',
        'dailyAppliedFeedKg',
        'dailyAppliedGrowthKg',
        'lastAppliedAt',
      ],
    },
  },
  subjectKinds: ['FEEDING_RECORD', 'DAY_PLAN'],
  eventDefinitions: [
    {
      eventKind: 'ATTRIBUTION_ASSERTED',
      subjectKind: 'FEEDING_RECORD',
      payloadKeys: [
        'batchId',
        'batchLocationId',
        'completedAt',
        'equipmentId',
        'locationType',
        'originalRecordDigest',
        'schemaVersion',
        'sourceExecutionId',
        'sourceKind',
      ],
    },
    {
      eventKind: 'ATTRIBUTION_QUARANTINED',
      subjectKind: 'FEEDING_RECORD',
      payloadKeys: [
        'candidateSnapshot',
        'observedAt',
        'originalRecordDigest',
        'originalSnapshot',
        'reasonCode',
        'schemaVersion',
        'sourceExecutionId',
        'sourceKind',
      ],
    },
    {
      eventKind: 'ATTRIBUTION_RESOLVED',
      subjectKind: 'FEEDING_RECORD',
      payloadKeys: [
        'batchId',
        'batchLocationId',
        'completedAt',
        'equipmentId',
        'locationType',
        'originalRecordDigest',
        'resolutionNote',
        'resolvesEventDigest',
        'schemaVersion',
        'sourceExecutionId',
        'sourceKind',
      ],
    },
    {
      eventKind: 'GROWTH_POLICY_ASSERTED',
      subjectKind: 'DAY_PLAN',
      payloadKeys: [
        'expectedFcr',
        'growthApplicationMode',
        'policyVersion',
        'proofAt',
        'proofKind',
        'resolutionNote',
        'resolvesEventDigest',
        'schemaVersion',
      ],
    },
    {
      eventKind: 'GROWTH_POLICY_QUARANTINED',
      subjectKind: 'DAY_PLAN',
      payloadKeys: [
        'observedAt',
        'originalSnapshot',
        'protocolId',
        'reasonCode',
        'rollupAppliedAt',
        'schemaVersion',
      ],
    },
    {
      eventKind: 'GROWTH_POLICY_RESOLVED',
      subjectKind: 'DAY_PLAN',
      payloadKeys: [
        'expectedFcr',
        'growthApplicationMode',
        'policyVersion',
        'proofAt',
        'proofKind',
        'resolutionNote',
        'resolvesEventDigest',
        'schemaVersion',
      ],
    },
    {
      eventKind: 'GROWTH_APPLIED',
      subjectKind: 'DAY_PLAN',
      payloadKeys: [
        'applicationMode',
        'appliedAt',
        'expectedFcr',
        'feedDeltaKg',
        'growthDeltaKg',
        'schemaVersion',
        'sourceRef',
      ],
    },
  ],
  transitionGraph: {
    rootState: 'ROOT',
    subjects: [
      {
        subjectKind: 'FEEDING_RECORD',
        transitions: [
          {
            predecessorEventKind: null,
            eventKind: 'ATTRIBUTION_ASSERTED',
            predecessorDigestPayloadKey: null,
            continuityPayloadKeys: [],
          },
          {
            predecessorEventKind: null,
            eventKind: 'ATTRIBUTION_QUARANTINED',
            predecessorDigestPayloadKey: null,
            continuityPayloadKeys: [],
          },
          {
            predecessorEventKind: 'ATTRIBUTION_QUARANTINED',
            eventKind: 'ATTRIBUTION_RESOLVED',
            predecessorDigestPayloadKey: 'resolvesEventDigest',
            continuityPayloadKeys: ['originalRecordDigest'],
          },
        ],
      },
      {
        subjectKind: 'DAY_PLAN',
        transitions: [
          {
            predecessorEventKind: null,
            eventKind: 'GROWTH_POLICY_ASSERTED',
            predecessorDigestPayloadKey: null,
            continuityPayloadKeys: [],
          },
          {
            predecessorEventKind: null,
            eventKind: 'GROWTH_POLICY_QUARANTINED',
            predecessorDigestPayloadKey: null,
            continuityPayloadKeys: [],
          },
          {
            predecessorEventKind: 'GROWTH_POLICY_QUARANTINED',
            eventKind: 'GROWTH_POLICY_RESOLVED',
            predecessorDigestPayloadKey: 'resolvesEventDigest',
            continuityPayloadKeys: [],
          },
          {
            predecessorEventKind: 'GROWTH_POLICY_ASSERTED',
            eventKind: 'GROWTH_APPLIED',
            predecessorDigestPayloadKey: null,
            continuityPayloadKeys: [],
          },
          {
            predecessorEventKind: 'GROWTH_POLICY_RESOLVED',
            eventKind: 'GROWTH_APPLIED',
            predecessorDigestPayloadKey: null,
            continuityPayloadKeys: [],
          },
          {
            predecessorEventKind: 'GROWTH_APPLIED',
            eventKind: 'GROWTH_APPLIED',
            predecessorDigestPayloadKey: null,
            continuityPayloadKeys: [],
          },
        ],
      },
    ],
  },
  vocabularies: {
    sourceKinds: ['LEGACY_EXECUTION'],
    locationTypes: ['tank', 'pond'],
    growthApplicationModes: ['daily', 'per_meal'],
    growthEventApplicationModes: [
      'DAILY_ROLLUP',
      'MEAL_FINALIZATION',
      'MEAL_CORRECTION',
      'UNPLANNED_FEED',
      'UNPLANNED_CORRECTION',
    ],
    attributionQuarantineReasons: [
      'MISSING_SOURCE_EXECUTION',
      'NULL_COMPLETION_TIME',
      'UNSUPPORTED_EQUIPMENT_TYPE',
      'MISSING_OCCUPANCY_INTERVAL',
      'OVERLAPPING_OCCUPANCY_INTERVALS',
    ],
    growthQuarantineReasons: [
      'UNSTAMPED_HISTORICAL_PLAN',
      'INVALID_EXPECTED_FCR',
      'MALFORMED_POUR_LEDGER',
      'POUR_ACTUAL_MISMATCH',
      'MULTIPLE_POST_STAMP_CORRECTIONS',
    ],
    growthPolicyProofKinds: ['LEGACY_ROLLUP_STAMP', 'LIVE_PROTOCOL_RESOLUTION'],
  },
  decimalScales: {
    feedKg: 3,
    growthKg: 3,
    expectedFcr: 6,
  },
} as const;

function assertCatalog(): void {
  const journalColumns = FEEDING_HISTORICAL_PROVENANCE_CATALOG_SOURCE_V1.journal.columns;
  const columnNames = journalColumns.map((column) => column.name);
  if (
    columnNames.length !== new Set(columnNames).size ||
    journalColumns.some(
      (column) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column.name) ||
        !/^(?:bigint|jsonb|text|timestamptz|uuid|varchar\([1-9][0-9]*\))$/.test(column.type) ||
        column.nullable,
    ) ||
    journalColumns.some(
      (column) =>
        'defaultExpression' in column &&
        (column.name !== 'eventId' || column.defaultExpression !== 'gen_random_uuid()'),
    )
  ) {
    throw new Error('Feeding provenance journal columns must remain unique and fail-closed');
  }
  const isolation = FEEDING_HISTORICAL_PROVENANCE_CATALOG_SOURCE_V1.journal.tenantIsolation;
  if (
    !/^[a-z_][a-z0-9_]*$/.test(isolation.policyName) ||
    !/^[a-z][a-z0-9_.]*$/.test(isolation.contextGuc) ||
    !isolation.forceRowLevelSecurity ||
    !isolation.securityInvokerProjections
  ) {
    throw new Error('Feeding provenance tenant isolation must remain fail-closed');
  }
  const projectionNames = Object.keys(
    FEEDING_HISTORICAL_PROVENANCE_CATALOG_SOURCE_V1.projections,
  ).sort();
  const projectionSchemaNames = Object.keys(
    FEEDING_HISTORICAL_PROVENANCE_CATALOG_SOURCE_V1.projectionSchemas,
  ).sort();
  if (
    projectionNames.length !== projectionSchemaNames.length ||
    projectionNames.some((name, index) => name !== projectionSchemaNames[index])
  ) {
    throw new Error('Feeding provenance projection schemas must close the projection registry');
  }
  for (const [name, schema] of Object.entries(
    FEEDING_HISTORICAL_PROVENANCE_CATALOG_SOURCE_V1.projectionSchemas,
  )) {
    const columns = 'columns' in schema ? (schema.columns as readonly string[]) : undefined;
    const columnSource = 'columnSourceRelation' in schema ? schema.columnSourceRelation : undefined;
    if (
      (columns === undefined) === (columnSource === undefined) ||
      (columns !== undefined &&
        (columns.length === 0 ||
          columns.length !== new Set(columns).size ||
          columns.some((column) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) ||
          !columns.includes('tenantId'))) ||
      (columnSource !== undefined && !/^[a-z_][a-z0-9_]*$/.test(columnSource))
    ) {
      throw new Error(`Invalid feeding provenance projection schema: ${name}`);
    }
  }
  const eventKinds = new Set<string>();
  const subjectKinds = new Set<string>(
    FEEDING_HISTORICAL_PROVENANCE_CATALOG_SOURCE_V1.subjectKinds,
  );
  const definitionsByKind = new Map<
    string,
    (typeof FEEDING_HISTORICAL_PROVENANCE_CATALOG_SOURCE_V1.eventDefinitions)[number]
  >();
  for (const definition of FEEDING_HISTORICAL_PROVENANCE_CATALOG_SOURCE_V1.eventDefinitions) {
    if (eventKinds.has(definition.eventKind)) {
      throw new Error(`Duplicate feeding provenance event kind: ${definition.eventKind}`);
    }
    eventKinds.add(definition.eventKind);
    definitionsByKind.set(definition.eventKind, definition);
    if (!subjectKinds.has(definition.subjectKind)) {
      throw new Error(`Unknown feeding provenance subject kind: ${definition.subjectKind}`);
    }
    const sortedKeys = [...definition.payloadKeys].sort();
    if (
      sortedKeys.length !== new Set(sortedKeys).size ||
      sortedKeys.some((key, index) => key !== definition.payloadKeys[index])
    ) {
      throw new Error(`Feeding provenance payload keys are not a unique canonical set`);
    }
  }

  const transitionSubjects = new Set<string>();
  for (const graph of FEEDING_HISTORICAL_PROVENANCE_CATALOG_SOURCE_V1.transitionGraph.subjects) {
    if (!subjectKinds.has(graph.subjectKind) || transitionSubjects.has(graph.subjectKind)) {
      throw new Error(
        `Duplicate or unknown feeding provenance transition subject: ${graph.subjectKind}`,
      );
    }
    transitionSubjects.add(graph.subjectKind);
    const edges = new Set<string>();
    const reachableEventKinds = new Set<string>();
    for (const transition of graph.transitions) {
      const eventDefinition = definitionsByKind.get(transition.eventKind);
      const predecessorDefinition = transition.predecessorEventKind
        ? definitionsByKind.get(transition.predecessorEventKind)
        : undefined;
      if (
        !eventDefinition ||
        eventDefinition.subjectKind !== graph.subjectKind ||
        (transition.predecessorEventKind !== null &&
          (!predecessorDefinition || predecessorDefinition.subjectKind !== graph.subjectKind))
      ) {
        throw new Error(`Feeding provenance transition crosses an event authority boundary`);
      }
      const edge = `${transition.predecessorEventKind ?? FEEDING_HISTORICAL_PROVENANCE_CATALOG_SOURCE_V1.transitionGraph.rootState}->${transition.eventKind}`;
      if (edges.has(edge)) {
        throw new Error(`Duplicate feeding provenance transition: ${graph.subjectKind}:${edge}`);
      }
      edges.add(edge);
      reachableEventKinds.add(transition.eventKind);

      if (
        transition.predecessorDigestPayloadKey !== null &&
        (transition.predecessorEventKind === null ||
          !(eventDefinition.payloadKeys as readonly string[]).includes(
            transition.predecessorDigestPayloadKey,
          ))
      ) {
        throw new Error(`Invalid feeding provenance predecessor-digest binding: ${edge}`);
      }
      if (
        transition.continuityPayloadKeys.some(
          (key) =>
            transition.predecessorEventKind === null ||
            !(predecessorDefinition?.payloadKeys as readonly string[] | undefined)?.includes(key) ||
            !(eventDefinition.payloadKeys as readonly string[]).includes(key),
        )
      ) {
        throw new Error(`Invalid feeding provenance continuity binding: ${edge}`);
      }
    }
    const ownedEventKinds = FEEDING_HISTORICAL_PROVENANCE_CATALOG_SOURCE_V1.eventDefinitions
      .filter((definition) => definition.subjectKind === graph.subjectKind)
      .map((definition) => definition.eventKind);
    if (
      ownedEventKinds.length !== reachableEventKinds.size ||
      ownedEventKinds.some((eventKind) => !reachableEventKinds.has(eventKind))
    ) {
      throw new Error(`Feeding provenance transition graph is incomplete: ${graph.subjectKind}`);
    }
  }
  if (
    transitionSubjects.size !== subjectKinds.size ||
    [...subjectKinds].some((subjectKind) => !transitionSubjects.has(subjectKind))
  ) {
    throw new Error('Feeding provenance transition graph does not cover every subject authority');
  }
}

assertCatalog();

export const FEEDING_HISTORICAL_PROVENANCE_CATALOG_V1 = freezeAuthorityGraphV1(
  FEEDING_HISTORICAL_PROVENANCE_CATALOG_SOURCE_V1,
);

const CATALOG_DOCUMENT = createCanonicalJsonDocumentV1(FEEDING_HISTORICAL_PROVENANCE_CATALOG_V1);

export const FEEDING_HISTORICAL_PROVENANCE_CATALOG_CANONICAL_JSON_V1 =
  canonicalJsonStringify(CATALOG_DOCUMENT);

export const FEEDING_HISTORICAL_PROVENANCE_CATALOG_DIGEST_V1 = canonicalJsonSha256(
  FEEDING_HISTORICAL_PROVENANCE_CATALOG_HASH_AUTHORITY_V1,
  CATALOG_DOCUMENT,
);

export type FeedingHistoricalProvenanceSubjectKindV1 =
  (typeof FEEDING_HISTORICAL_PROVENANCE_CATALOG_V1.subjectKinds)[number];

export type FeedingHistoricalProvenanceEventKindV1 =
  (typeof FEEDING_HISTORICAL_PROVENANCE_CATALOG_V1.eventDefinitions)[number]['eventKind'];

export type FeedingGrowthEventApplicationModeV1 =
  (typeof FEEDING_HISTORICAL_PROVENANCE_CATALOG_V1.vocabularies.growthEventApplicationModes)[number];

function fixedDecimal(value: number, scale: number, name: string): string {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  const normalized = value.toFixed(scale);
  if (Number(normalized) !== value && Math.abs(Number(normalized) - value) >= 10 ** -scale / 2) {
    throw new TypeError(`${name} exceeds provenance precision`);
  }
  return normalized;
}

export function feedingProvenanceFeedKgV1(value: number): string {
  return fixedDecimal(
    value,
    FEEDING_HISTORICAL_PROVENANCE_CATALOG_V1.decimalScales.feedKg,
    'feedKg',
  );
}

export function feedingProvenanceGrowthKgV1(value: number): string {
  return fixedDecimal(
    value,
    FEEDING_HISTORICAL_PROVENANCE_CATALOG_V1.decimalScales.growthKg,
    'growthKg',
  );
}

export function feedingProvenanceExpectedFcrV1(value: number): string {
  if (value <= 0) throw new TypeError('expectedFcr must be positive');
  return fixedDecimal(
    value,
    FEEDING_HISTORICAL_PROVENANCE_CATALOG_V1.decimalScales.expectedFcr,
    'expectedFcr',
  );
}

export function createGrowthPolicyAssertedPayloadV1(input: {
  readonly expectedFcr: number;
  readonly growthApplicationMode: 'daily' | 'per_meal';
  readonly proofAt: Date;
  readonly proofKind: 'LEGACY_ROLLUP_STAMP' | 'LIVE_PROTOCOL_RESOLUTION';
  readonly resolutionNote?: string | null;
  readonly resolvesEventDigest?: string | null;
}): Readonly<Record<string, string | null>> {
  if (!Number.isFinite(input.proofAt.getTime())) throw new TypeError('proofAt must be valid');
  return Object.freeze({
    expectedFcr: feedingProvenanceExpectedFcrV1(input.expectedFcr),
    growthApplicationMode: input.growthApplicationMode,
    policyVersion: '1',
    proofAt: input.proofAt.toISOString(),
    proofKind: input.proofKind,
    resolutionNote: input.resolutionNote ?? null,
    resolvesEventDigest: input.resolvesEventDigest ?? null,
    schemaVersion: FEEDING_HISTORICAL_PROVENANCE_CATALOG_V1.schemaVersion,
  });
}

export function createGrowthAppliedPayloadV1(input: {
  readonly applicationMode: FeedingGrowthEventApplicationModeV1;
  readonly appliedAt: Date;
  readonly expectedFcr: number;
  readonly feedDeltaKg: number;
  readonly growthDeltaKg: number;
  readonly sourceRef: string;
}): Readonly<Record<string, string>> {
  if (!Number.isFinite(input.appliedAt.getTime())) throw new TypeError('appliedAt must be valid');
  if (!input.sourceRef || input.sourceRef !== input.sourceRef.trim()) {
    throw new TypeError('sourceRef must be a canonical non-empty identifier');
  }
  return Object.freeze({
    applicationMode: input.applicationMode,
    appliedAt: input.appliedAt.toISOString(),
    expectedFcr: feedingProvenanceExpectedFcrV1(input.expectedFcr),
    feedDeltaKg: feedingProvenanceFeedKgV1(input.feedDeltaKg),
    growthDeltaKg: feedingProvenanceGrowthKgV1(input.growthDeltaKg),
    schemaVersion: FEEDING_HISTORICAL_PROVENANCE_CATALOG_V1.schemaVersion,
    sourceRef: input.sourceRef,
  });
}
