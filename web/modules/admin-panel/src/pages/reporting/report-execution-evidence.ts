import {
  REPORT_CAPABILITY_CATALOG_SHA256,
  REPORT_AUTHORITY_GRAPH_SHA256,
  REPORT_MEASUREMENT_AUTHORITY_CATALOG_SHA256,
  assertCurrentReportMeasurementProof,
  getReportCapability,
  getReportMeasurementAuthority,
  reportMeasurementIntentSha256,
  reportPreviewSha256,
  type ReportFormat,
  type ReportType,
} from '@platform/reporting-contracts';
import {
  createStandardPaginatedResult,
  type StandardPaginatedResult,
} from '@platform/pagination-contracts';

import type { ReportExecutionDto } from '../../services/adminApi';

export interface GeneratedReport {
  id: string;
  type: ReportType;
  format: ReportFormat;
  title: string;
  generatedAt: string;
  status: 'pending' | 'ready' | 'failed' | 'unavailable';
  data?: unknown;
  summary?: Record<string, unknown>;
  rowCount?: number;
  fileSizeBytes?: number;
  errorMessage?: string;
}

function mapExecutionStatus(status: ReportExecutionDto['status']): GeneratedReport['status'] {
  if (status === 'completed') return 'ready';
  if (status === 'failed') return 'failed';
  if (status === 'unavailable') return 'unavailable';
  return 'pending';
}

export function decodeReportExecutionEvidence(execution: ReportExecutionDto): GeneratedReport {
  if (
    execution.capabilityCatalogSha256 !== REPORT_CAPABILITY_CATALOG_SHA256 ||
    execution.measurementCatalogSha256 !== REPORT_MEASUREMENT_AUTHORITY_CATALOG_SHA256 ||
    execution.authorityGraphSha256 !== REPORT_AUTHORITY_GRAPH_SHA256
  ) {
    throw new Error('Report evidence was produced by a stale authority catalog');
  }
  if (execution.status === 'completed' && execution.measurementState !== 'QUALIFIED') {
    throw new Error('An unqualified report cannot be projected as completed');
  }
  const measurementAuthority = getReportMeasurementAuthority(execution.reportType);
  const capability = getReportCapability(execution.reportType);
  if (
    execution.artifactMaximumBytes !== capability.artifact.maximumBytes ||
    execution.previewMaximumRows !== capability.preview.maximumRows
  ) {
    throw new Error('Report evidence resource bounds do not match its authority cut');
  }
  if (measurementAuthority.state !== execution.measurementState) {
    throw new Error('Report evidence measurement state is stale');
  }
  if (
    execution.measurementState === 'BLOCKED' &&
    (execution.status !== 'unavailable' ||
      execution.artifactSha256 !== undefined ||
      execution.previewRows !== undefined ||
      execution.previewSha256 !== undefined ||
      execution.measurementProof !== undefined ||
      execution.measurementProofSha256 !== undefined ||
      execution.stagedArtifactObjectKey !== undefined ||
      execution.stagedArtifactSha256 !== undefined ||
      execution.artifactCommitState !== undefined ||
      !execution.errorMessage)
  ) {
    throw new Error('Blocked report evidence contains a forbidden result or artifact');
  }
  if (
    execution.status === 'completed' &&
    (execution.previewRows === undefined ||
      execution.previewSha256 === undefined ||
      execution.artifactObjectKey === undefined ||
      execution.artifactSha256 === undefined ||
      execution.artifactContentType === undefined ||
      execution.fileSizeBytes === undefined ||
      execution.downloadExpiresAt === undefined ||
      execution.measurementProof === undefined ||
      execution.measurementProofSha256 === undefined ||
      execution.artifactCommitState !== 'REFERENCE_COMMITTED')
  ) {
    throw new Error('Completed report evidence has no persisted preview proof');
  }
  if (
    (execution.measurementProof === undefined) !==
    (execution.measurementProofSha256 === undefined)
  ) {
    throw new Error('Report measurement proof and digest must be present together');
  }
  if (
    (execution.stagedArtifactObjectKey === undefined) !==
    (execution.stagedArtifactSha256 === undefined)
  ) {
    throw new Error('Staged report artifact coordinates must be present together');
  }
  if (execution.stagedArtifactObjectKey !== undefined) {
    const expectedStagedObjectKey =
      `platform-admin/report-executions/${execution.id}/` +
      `${execution.stagedArtifactSha256}.${execution.format}`;
    if (
      execution.status !== 'running' ||
      (execution.artifactCommitState !== 'INTENT_CREATED' &&
        execution.artifactCommitState !== 'BYTES_VERIFIED') ||
      !/^[0-9a-f]{64}$/.test(execution.stagedArtifactSha256 ?? '') ||
      execution.stagedArtifactObjectKey !== expectedStagedObjectKey
    ) {
      throw new Error('Staged report artifact coordinates are invalid');
    }
  }
  if (
    execution.status === 'completed' &&
    (execution.stagedArtifactObjectKey !== undefined ||
      execution.stagedArtifactSha256 !== undefined ||
      execution.artifactCommitState !== 'REFERENCE_COMMITTED')
  ) {
    throw new Error('Completed report evidence cannot retain staged artifact coordinates');
  }
  if (execution.measurementProof !== undefined) {
    const measurementProofSha256 = execution.measurementProofSha256;
    if (measurementProofSha256 === undefined) {
      throw new Error('Report measurement proof and digest must be present together');
    }
    try {
      assertCurrentReportMeasurementProof(execution.measurementProof, {
        reportType: execution.reportType,
        intentSha256: reportMeasurementIntentSha256({
          reportType: execution.reportType,
          startInclusiveUtc: execution.startDate ?? null,
          endExclusiveUtc: execution.endDate ?? null,
          filters: execution.filters ?? null,
        }),
        proofSha256: measurementProofSha256,
      });
    } catch {
      throw new Error('Report measurement proof coordinates do not match');
    }
  }
  if ((execution.previewRows === undefined) !== (execution.previewSha256 === undefined)) {
    throw new Error('Report preview rows and digest must be present together');
  }
  if (execution.previewRows !== undefined) {
    if (execution.rowCount === undefined || execution.previewSha256 === undefined) {
      throw new Error('Report preview evidence is incomplete');
    }
    const expectedDigest = reportPreviewSha256(
      execution.reportType,
      execution.rowCount,
      execution.previewRows,
    );
    if (expectedDigest !== execution.previewSha256) {
      throw new Error('Report preview evidence digest does not match');
    }
    if (execution.previewRows.length > execution.previewMaximumRows) {
      throw new Error('Report preview exceeds its catalog resource bound');
    }
  }
  if (
    execution.fileSizeBytes !== undefined &&
    execution.fileSizeBytes > execution.artifactMaximumBytes
  ) {
    throw new Error('Report artifact exceeds its execution-pinned resource bound');
  }

  return {
    id: execution.id,
    type: execution.reportType,
    format: execution.format,
    title: execution.reportName,
    generatedAt: execution.measurementProof?.measuredAt ?? execution.createdAt,
    status: mapExecutionStatus(execution.status),
    data: execution.previewRows,
    summary: execution.summary,
    rowCount: execution.rowCount,
    fileSizeBytes: execution.fileSizeBytes,
    errorMessage: execution.errorMessage,
  };
}

export function decodeReportExecutionEvidencePage(input: {
  readonly items: readonly ReportExecutionDto[];
  readonly total: number;
  readonly page: number;
  readonly limit: number;
  readonly totalPages: number;
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
}): StandardPaginatedResult<GeneratedReport> {
  const compiled = createStandardPaginatedResult(
    input.items.map(decodeReportExecutionEvidence),
    input.total,
    input.page,
    input.limit,
  );
  if (
    compiled.totalPages !== input.totalPages ||
    compiled.hasNextPage !== input.hasNextPage ||
    compiled.hasPreviousPage !== input.hasPreviousPage
  ) {
    throw new Error('Report execution pagination metadata is non-canonical');
  }
  return compiled;
}
