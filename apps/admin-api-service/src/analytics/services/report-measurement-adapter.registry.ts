import { Inject, Injectable } from '@nestjs/common';
import {
  assertReportMeasurementAdapterBuildAttestationForAuthorityGraph,
  assertReportMeasurementProofForAuthorityGraph,
  compileReportDatasetSnapshot,
  getReportMeasurementAuthorityFromAuthorityGraph,
  reportDatasetSha256,
  reportMeasurementIntentSha256,
  reportMeasurementProofSha256,
  type CompiledReportAuthorityGraphV1,
  type ReportFactEvidenceV1,
  type ReportMeasurementAdapterBuildAttestationV1,
  type ReportMeasurementIntentV1,
  type ReportMeasurementProofV1,
  type ReportType,
} from '@platform/reporting-contracts';

export interface MeasuredReportDatasetV1 {
  readonly schemaVersion: 'measured-report-dataset.v1';
  readonly reportType: ReportType;
  readonly measurementAuthorityId: string;
  readonly measurementCatalogSha256: string;
  readonly intentSha256: string;
  readonly generatedAt: Date;
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly summary: Readonly<Record<string, unknown>>;
  readonly factEvidence: readonly ReportFactEvidenceV1[];
}

export interface ReportMeasurementAdapterV1 {
  readonly adapterId: string;
  readonly reportType: ReportType;
  readonly measurementAuthorityId: string;
  measure(intent: ReportMeasurementIntentV1): Promise<MeasuredReportDatasetV1>;
}

export interface QualifiedMeasuredReportV1 {
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly summary: Readonly<Record<string, unknown>>;
  readonly measuredAt: string;
  readonly measurementProof: ReportMeasurementProofV1;
  readonly measurementProofSha256: string;
}

export const REPORT_MEASUREMENT_ADAPTERS = Symbol('REPORT_MEASUREMENT_ADAPTERS');
export const REPORT_MEASUREMENT_ADAPTER_BUILD_ATTESTATIONS = Symbol(
  'REPORT_MEASUREMENT_ADAPTER_BUILD_ATTESTATIONS',
);
export const REPORT_COMPILED_AUTHORITY_GRAPH = Symbol('REPORT_COMPILED_AUTHORITY_GRAPH');

function assertSha256(value: string, context: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${context} must be a lower-case SHA-256 digest`);
  }
}

function assertExactDataObject(
  value: object,
  expectedKeys: readonly string[],
  context: string,
): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${context} must be a plain data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some((key) => typeof key !== 'string')) {
    throw new Error(`${context} has a non-V1 shape`);
  }
  const actualKeys = ownKeys.filter((key): key is string => typeof key === 'string').sort();
  const canonicalKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== canonicalKeys.length ||
    actualKeys.some((key, index) => key !== canonicalKeys[index])
  ) {
    throw new Error(`${context} has a non-V1 shape`);
  }
  for (const key of canonicalKeys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      throw new Error(`${context}.${key} must be an enumerable data property`);
    }
  }
}

@Injectable()
export class ReportMeasurementAdapterRegistry {
  private readonly adaptersByReportType: ReadonlyMap<
    ReportType,
    Readonly<{
      adapter: ReportMeasurementAdapterV1;
      attestation: ReportMeasurementAdapterBuildAttestationV1;
    }>
  >;

  constructor(
    @Inject(REPORT_COMPILED_AUTHORITY_GRAPH)
    private readonly authorityGraph: CompiledReportAuthorityGraphV1,
    @Inject(REPORT_MEASUREMENT_ADAPTERS)
    adapters: readonly ReportMeasurementAdapterV1[],
    @Inject(REPORT_MEASUREMENT_ADAPTER_BUILD_ATTESTATIONS)
    attestations: readonly ReportMeasurementAdapterBuildAttestationV1[],
  ) {
    const attestationsByAdapterId = new Map<string, ReportMeasurementAdapterBuildAttestationV1>();
    const attestedReportTypes = new Set<ReportType>();
    for (const attestation of attestations) {
      if (!Object.isFrozen(attestation)) {
        throw new Error(
          'Report measurement adapter build attestations must be frozen compiler snapshots',
        );
      }
      assertReportMeasurementAdapterBuildAttestationForAuthorityGraph(
        this.authorityGraph,
        attestation,
      );
      if (
        attestationsByAdapterId.has(attestation.adapterId) ||
        attestedReportTypes.has(attestation.reportType)
      ) {
        throw new Error(
          'Report measurement adapter build attestations must have unique adapter IDs and report types',
        );
      }
      attestationsByAdapterId.set(attestation.adapterId, attestation);
      attestedReportTypes.add(attestation.reportType);
    }

    const adaptersByReportType = new Map<
      ReportType,
      Readonly<{
        adapter: ReportMeasurementAdapterV1;
        attestation: ReportMeasurementAdapterBuildAttestationV1;
      }>
    >();
    const adapterIds = new Set<string>();
    for (const adapter of adapters) {
      if (!/^[a-z][a-z0-9.-]*\.v1$/.test(adapter.adapterId)) {
        throw new Error(`Invalid report measurement adapter ID: ${adapter.adapterId}`);
      }
      if (adapterIds.has(adapter.adapterId) || adaptersByReportType.has(adapter.reportType)) {
        throw new Error('Report measurement adapter IDs and report types must be unique');
      }
      const authority = getReportMeasurementAuthorityFromAuthorityGraph(
        this.authorityGraph,
        adapter.reportType,
      );
      if (authority.state !== 'QUALIFIED') {
        throw new Error(
          `${adapter.adapterId} cannot attach to blocked authority ${authority.authorityId}`,
        );
      }
      if (authority.authorityId !== adapter.measurementAuthorityId) {
        throw new Error(`${adapter.adapterId} does not implement ${authority.authorityId}`);
      }
      const attestation = attestationsByAdapterId.get(adapter.adapterId);
      if (
        attestation === undefined ||
        attestation.reportType !== adapter.reportType ||
        attestation.measurementAuthorityId !== adapter.measurementAuthorityId
      ) {
        throw new Error(
          `${adapter.adapterId} has no independent compiler-minted build attestation`,
        );
      }
      adapterIds.add(adapter.adapterId);
      adaptersByReportType.set(adapter.reportType, Object.freeze({ adapter, attestation }));
    }

    for (const authority of this.authorityGraph.measurementCatalog.entries) {
      const binding = adaptersByReportType.get(authority.reportType);
      const attestation =
        authority.qualifiedAdapter === null
          ? undefined
          : attestationsByAdapterId.get(authority.qualifiedAdapter.adapterId);
      if (authority.state === 'QUALIFIED' && (binding === undefined || attestation === undefined)) {
        throw new Error(
          `Qualified authority ${authority.authorityId} has no exact adapter and attestation pair`,
        );
      }
      if (authority.state === 'BLOCKED' && (binding !== undefined || attestation !== undefined)) {
        throw new Error(
          `Blocked authority ${authority.authorityId} unexpectedly has an adapter or attestation`,
        );
      }
    }
    if (attestationsByAdapterId.size !== adaptersByReportType.size) {
      throw new Error('Every build attestation must bind exactly one registered adapter');
    }
    this.adaptersByReportType = adaptersByReportType;
  }

  async measure(intent: ReportMeasurementIntentV1): Promise<QualifiedMeasuredReportV1> {
    assertExactDataObject(
      intent,
      [
        'schemaVersion',
        'reportType',
        'startInclusiveUtc',
        'endExclusiveUtc',
        'filters',
        'intentSha256',
      ],
      'report measurement intent',
    );
    if (!Object.isFrozen(intent) || (intent.filters !== null && !Object.isFrozen(intent.filters))) {
      throw new Error('Report measurement intent must be a frozen compiler snapshot');
    }
    if (
      intent.intentSha256 !==
      reportMeasurementIntentSha256({
        reportType: intent.reportType,
        startInclusiveUtc: intent.startInclusiveUtc,
        endExclusiveUtc: intent.endExclusiveUtc,
        filters: intent.filters,
      })
    ) {
      throw new Error('Report measurement intent digest does not match its coordinates');
    }
    const authority = getReportMeasurementAuthorityFromAuthorityGraph(
      this.authorityGraph,
      intent.reportType,
    );
    if (authority.state !== 'QUALIFIED') {
      throw new Error(`${authority.authorityId} is not measurement-qualified`);
    }
    const registered = this.adaptersByReportType.get(intent.reportType);
    if (registered === undefined) {
      throw new Error(`${authority.authorityId} has no measurement adapter`);
    }
    const { adapter, attestation } = registered;
    const dataset = await adapter.measure(intent);
    assertExactDataObject(
      dataset,
      [
        'schemaVersion',
        'reportType',
        'measurementAuthorityId',
        'measurementCatalogSha256',
        'intentSha256',
        'generatedAt',
        'rows',
        'summary',
        'factEvidence',
      ],
      `${adapter.adapterId} dataset`,
    );
    if (
      !(dataset.generatedAt instanceof Date) ||
      !Array.isArray(dataset.rows) ||
      !Array.isArray(dataset.factEvidence)
    ) {
      throw new Error(`${adapter.adapterId} returned a non-portable dataset envelope`);
    }
    if (
      dataset.schemaVersion !== 'measured-report-dataset.v1' ||
      dataset.reportType !== intent.reportType ||
      dataset.measurementAuthorityId !== authority.authorityId ||
      dataset.measurementCatalogSha256 !== this.authorityGraph.measurementCatalogSha256 ||
      dataset.intentSha256 !== intent.intentSha256 ||
      Number.isNaN(dataset.generatedAt.getTime())
    ) {
      throw new Error(`${adapter.adapterId} returned stale measurement coordinates`);
    }
    if (dataset.factEvidence.length !== authority.requiredFacts.length) {
      throw new Error(`${adapter.adapterId} returned incomplete fact evidence`);
    }
    dataset.factEvidence.forEach((fact, index) => {
      assertExactDataObject(
        fact,
        ['factId', 'sourceCutSha256'],
        `${adapter.adapterId}.factEvidence[${index}]`,
      );
      if (fact.factId !== authority.requiredFacts[index]) {
        throw new Error(`${adapter.adapterId} returned non-canonical fact evidence`);
      }
      assertSha256(fact.sourceCutSha256, `${adapter.adapterId}.${fact.factId}`);
    });

    const snapshot = compileReportDatasetSnapshot({
      rows: dataset.rows,
      summary: dataset.summary,
    });
    const measuredAt = dataset.generatedAt.toISOString();
    const datasetSha256 = reportDatasetSha256({
      reportType: intent.reportType,
      intentSha256: intent.intentSha256,
      measuredAt,
      rows: snapshot.rows,
      summary: snapshot.summary,
    });
    const measurementProof: ReportMeasurementProofV1 = Object.freeze({
      schemaVersion: 'report-measurement-proof.v1',
      reportType: intent.reportType,
      intentSha256: intent.intentSha256,
      capabilityCatalogSha256: this.authorityGraph.capabilityCatalogSha256,
      measurementCatalogSha256: this.authorityGraph.measurementCatalogSha256,
      authorityGraphSha256: this.authorityGraph.graphSha256,
      measurementAuthorityId: authority.authorityId,
      adapterId: adapter.adapterId,
      adapterImplementationSha256: attestation.implementationSha256,
      adapterProvenanceSha256: attestation.provenanceSha256,
      measuredAt,
      datasetSha256,
      factEvidence: Object.freeze(dataset.factEvidence.map((fact) => Object.freeze({ ...fact }))),
    });
    const measurementProofSha256 = reportMeasurementProofSha256(measurementProof);
    assertReportMeasurementProofForAuthorityGraph(this.authorityGraph, measurementProof, {
      reportType: intent.reportType,
      intentSha256: intent.intentSha256,
      proofSha256: measurementProofSha256,
    });
    return Object.freeze({
      rows: Object.freeze(snapshot.rows),
      summary: Object.freeze(snapshot.summary),
      measuredAt,
      measurementProof,
      measurementProofSha256,
    });
  }
}
