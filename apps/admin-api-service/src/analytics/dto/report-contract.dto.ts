import type { ReportDefinition, ReportExecution } from '../entities/analytics-snapshot.entity';
import type {
  ReportFormat,
  ReportArtifactCommitState,
  ReportMeasurementProofV1,
  ReportMeasurementState,
  ReportType,
} from '@platform/reporting-contracts';

export type { ReportFormat, ReportType } from '@platform/reporting-contracts';
export type ReportDefinitionStatus = 'active' | 'inactive' | 'draft';
export type ReportExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'unavailable';

export interface ReportDefinitionDto {
  id: string;
  name: string;
  description?: string;
  type: ReportType;
  defaultFormat: ReportFormat;
  status: ReportDefinitionStatus;
  defaultFilters?: Record<string, unknown>;
  createdBy?: string;
  createdByEmail?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReportExecutionDto {
  id: string;
  definitionId?: string;
  reportName: string;
  reportType: ReportType;
  format: ReportFormat;
  status: ReportExecutionStatus;
  startDate?: Date;
  endDate?: Date;
  filters?: Record<string, unknown>;
  summary?: Record<string, unknown>;
  rowCount?: number;
  fileSizeBytes?: number;
  artifactObjectKey?: string;
  artifactSha256?: string;
  artifactContentType?: string;
  downloadExpiresAt?: Date;
  previewRows?: Array<Record<string, unknown>>;
  previewSha256?: string;
  measurementProof?: ReportMeasurementProofV1;
  measurementProofSha256?: string;
  stagedArtifactObjectKey?: string;
  stagedArtifactSha256?: string;
  artifactCommitState?: ReportArtifactCommitState;
  capabilityCatalogSha256: string;
  measurementCatalogSha256: string;
  authorityGraphSha256: string;
  artifactMaximumBytes: number;
  previewMaximumRows: number;
  measurementState: ReportMeasurementState;
  errorMessage?: string;
  durationMs?: number;
  executedBy?: string;
  executedByEmail?: string;
  createdAt: Date;
  completedAt?: Date;
}

export function toReportDefinitionDto(definition: ReportDefinition): ReportDefinitionDto {
  return {
    id: definition.id,
    name: definition.name,
    ...(definition.description == null ? {} : { description: definition.description }),
    type: definition.type,
    defaultFormat: definition.defaultFormat,
    status: definition.status,
    ...(definition.defaultFilters == null ? {} : { defaultFilters: definition.defaultFilters }),
    ...(definition.createdBy == null ? {} : { createdBy: definition.createdBy }),
    ...(definition.createdByEmail == null ? {} : { createdByEmail: definition.createdByEmail }),
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
  };
}

export function toReportExecutionDto(execution: ReportExecution): ReportExecutionDto {
  return {
    id: execution.id,
    ...(execution.definitionId == null ? {} : { definitionId: execution.definitionId }),
    reportName: execution.reportName,
    reportType: execution.reportType,
    format: execution.format,
    status: execution.status,
    ...(execution.startDate == null ? {} : { startDate: execution.startDate }),
    ...(execution.endDate == null ? {} : { endDate: execution.endDate }),
    ...(execution.filters == null ? {} : { filters: execution.filters }),
    ...(execution.summary == null ? {} : { summary: execution.summary }),
    ...(execution.rowCount == null ? {} : { rowCount: execution.rowCount }),
    ...(execution.fileSizeBytes == null ? {} : { fileSizeBytes: execution.fileSizeBytes }),
    ...(execution.artifactObjectKey == null
      ? {}
      : { artifactObjectKey: execution.artifactObjectKey }),
    ...(execution.artifactSha256 == null ? {} : { artifactSha256: execution.artifactSha256 }),
    ...(execution.artifactContentType == null
      ? {}
      : { artifactContentType: execution.artifactContentType }),
    ...(execution.downloadExpiresAt == null
      ? {}
      : { downloadExpiresAt: execution.downloadExpiresAt }),
    ...(execution.previewRows == null ? {} : { previewRows: execution.previewRows }),
    ...(execution.previewSha256 == null ? {} : { previewSha256: execution.previewSha256 }),
    ...(execution.measurementProof == null ? {} : { measurementProof: execution.measurementProof }),
    ...(execution.measurementProofSha256 == null
      ? {}
      : { measurementProofSha256: execution.measurementProofSha256 }),
    ...(execution.stagedArtifactObjectKey == null
      ? {}
      : { stagedArtifactObjectKey: execution.stagedArtifactObjectKey }),
    ...(execution.stagedArtifactSha256 == null
      ? {}
      : { stagedArtifactSha256: execution.stagedArtifactSha256 }),
    ...(execution.artifactCommitState == null
      ? {}
      : { artifactCommitState: execution.artifactCommitState }),
    capabilityCatalogSha256: execution.capabilityCatalogSha256,
    measurementCatalogSha256: execution.measurementCatalogSha256,
    authorityGraphSha256: execution.authorityGraphSha256,
    artifactMaximumBytes: execution.artifactMaximumBytes,
    previewMaximumRows: execution.previewMaximumRows,
    measurementState: execution.measurementState,
    ...(execution.errorMessage == null ? {} : { errorMessage: execution.errorMessage }),
    ...(execution.durationMs == null ? {} : { durationMs: execution.durationMs }),
    ...(execution.executedBy == null ? {} : { executedBy: execution.executedBy }),
    ...(execution.executedByEmail == null ? {} : { executedByEmail: execution.executedByEmail }),
    createdAt: execution.createdAt,
    ...(execution.completedAt == null ? {} : { completedAt: execution.completedAt }),
  };
}
