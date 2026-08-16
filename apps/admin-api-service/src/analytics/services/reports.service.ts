/**
 * Catalog-governed report definitions, executions, and qualified artifacts.
 *
 * Measurement is delegated exclusively to the adapter registry. This service
 * deliberately contains no synthetic or fallback fact generators.
 */

import * as crypto from 'crypto';

import {
  createStandardPaginatedResult,
  type IStandardPaginatedResult,
} from '@aquaculture/backend-common/pagination';
import {
  BadRequestException,
  GoneException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  adminBinaryMediaTypeForFormat,
  decodeAdminBinaryArtifactMediaType,
  type AdminBinaryArtifactMediaType,
} from '@platform/admin-http-contracts';
import {
  assertReportArtifactSizeForAuthorityGraph,
  assertReportArtifactCommitTransition,
  assertReportMeasurementProofForAuthorityGraph,
  compileReportMeasurementIntentForAuthorityGraph,
  getReportCapabilityFromAuthorityGraph,
  getReportMeasurementAuthorityFromAuthorityGraph,
  reportMeasurementIntentSha256,
  reportPreviewSha256,
  type CompiledReportAuthorityGraphV1,
  type ReportMeasurementIntentV1,
} from '@platform/reporting-contracts';
import { MinioClientService } from '@platform/storage';
import PDFDocument from 'pdfkit';
import { Repository } from 'typeorm';
import { IsNull } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import {
  ReportType,
  ReportFormat,
  ReportDefinitionStatus,
  ReportExecutionStatus,
} from '../dto/report-contract.dto';
import { ReportDefinition, ReportExecution } from '../entities/analytics-snapshot.entity';

import {
  REPORT_COMPILED_AUTHORITY_GRAPH,
  ReportMeasurementAdapterRegistry,
} from './report-measurement-adapter.registry';

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    @InjectRepository(ReportDefinition)
    private readonly definitionRepository: Repository<ReportDefinition>,
    @InjectRepository(ReportExecution)
    private readonly executionRepository: Repository<ReportExecution>,
    private readonly storageService: MinioClientService,
    private readonly measurementAdapterRegistry: ReportMeasurementAdapterRegistry,
    @Inject(REPORT_COMPILED_AUTHORITY_GRAPH)
    private readonly authorityGraph: CompiledReportAuthorityGraphV1,
  ) {}

  // ============================================================================
  // Export Formatting
  // ============================================================================

  private convertToCsv(data: Record<string, unknown>[]): string {
    if (!data || data.length === 0) return '';

    const firstRow = data[0];
    if (!firstRow) return '';

    const headers = Object.keys(firstRow);
    const csvRows = [headers.map((header) => this.escapeCsvValue(header)).join(',')];

    for (const row of data) {
      const values = headers.map((header) => {
        const value = row[header];
        return this.escapeCsvValue(value);
      });
      csvRows.push(values.join(','));
    }

    return csvRows.join('\n');
  }

  private escapeCsvValue(value: unknown): string {
    let strValue = this.formatUnknownValue(value);

    if (/^[=+\-@\t\r]/.test(strValue)) {
      strValue = `'${strValue}`;
    }

    return `"${strValue.replace(/"/g, '""')}"`;
  }

  private formatUnknownValue(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return String(value);
    }
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'symbol') return value.description ?? 'Symbol()';
    if (typeof value === 'function') return '[function]';
    try {
      return JSON.stringify(value);
    } catch {
      return '[unserializable]';
    }
  }
  /**
   * Generate PDF buffer from report data
   */
  private async generatePdfBuffer(
    reportType: ReportType,
    data: unknown,
    measuredAt: string,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Header
      doc
        .fontSize(20)
        .font('Helvetica-Bold')
        .text('Aquaculture Platform Report', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(14).font('Helvetica').text(this.getReportTitle(reportType), { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(10).text(`Measured: ${measuredAt}`, { align: 'center' });
      doc.moveDown(1.5);

      // Draw a line
      doc
        .moveTo(50, doc.y)
        .lineTo(doc.page.width - 50, doc.y)
        .stroke();
      doc.moveDown(1);

      // Content based on report type
      if (Array.isArray(data)) {
        this.renderTableData(doc, data as Record<string, unknown>[]);
      } else if (typeof data === 'object' && data !== null) {
        const reportData = data as { data?: unknown[]; summary?: Record<string, unknown> };
        if (reportData.summary) {
          doc.fontSize(12).font('Helvetica-Bold').text('Summary', { underline: true });
          doc.moveDown(0.5);
          this.renderSummary(doc, reportData.summary);
          doc.moveDown(1);
        }
        if (reportData.data && Array.isArray(reportData.data)) {
          doc.fontSize(12).font('Helvetica-Bold').text('Details', { underline: true });
          doc.moveDown(0.5);
          this.renderTableData(doc, reportData.data as Record<string, unknown>[]);
        }
      }

      // Footer
      doc.moveDown(2);
      doc
        .fontSize(8)
        .fillColor('gray')
        .text('Aquaculture Platform - Confidential', { align: 'center' });

      doc.end();
    });
  }

  private getReportTitle(type: ReportType): string {
    return getReportCapabilityFromAuthorityGraph(this.authorityGraph, type).name;
  }

  private renderSummary(doc: PDFKit.PDFDocument, summary: Record<string, unknown>): void {
    doc.fontSize(10).font('Helvetica');
    for (const [key, value] of Object.entries(summary)) {
      const formattedKey = key.replace(/([A-Z])/g, ' $1').replace(/^./, (str) => str.toUpperCase());
      doc.text(`${formattedKey}: ${this.formatUnknownValue(value)}`, { indent: 20 });
    }
  }

  private renderTableData(doc: PDFKit.PDFDocument, data: Record<string, unknown>[]): void {
    if (!data || data.length === 0) {
      doc.fontSize(10).text('No data available');
      return;
    }

    const firstRow = data[0];
    if (!firstRow) return;

    const headers = Object.keys(firstRow);
    const colWidth = (doc.page.width - 100) / Math.min(headers.length, 5);

    // Render headers
    doc.fontSize(9).font('Helvetica-Bold');
    let xPos = 50;
    headers.slice(0, 5).forEach((header) => {
      const displayHeader = header.replace(/([A-Z])/g, ' $1').slice(0, 12);
      doc.text(displayHeader, xPos, doc.y, { width: colWidth, continued: false });
      xPos += colWidth;
    });
    doc.moveDown(0.5);

    // Render rows (limit to first 50 rows for PDF)
    doc.font('Helvetica').fontSize(8);
    const maxRows = Math.min(data.length, 50);
    for (let i = 0; i < maxRows; i++) {
      const row = data[i];
      if (!row) continue;

      xPos = 50;
      const yPos = doc.y;
      headers.slice(0, 5).forEach((header) => {
        const value = this.formatUnknownValue(row[header]).slice(0, 20);
        doc.text(value, xPos, yPos, { width: colWidth });
        xPos += colWidth;
      });
      doc.moveDown(0.5);

      // Check for page break
      if (doc.y > doc.page.height - 100) {
        doc.addPage();
      }
    }

    if (data.length > 50) {
      doc.moveDown(1);
      doc
        .fontSize(9)
        .fillColor('gray')
        .text(`... and ${data.length - 50} more rows (truncated for PDF)`);
    }
  }

  /**
   * Get available report types
   */
  getReportCapabilities(): Array<{
    type: ReportType;
    name: string;
    description: string;
    category: string;
    rangePolicy: 'FORBIDDEN' | 'REQUIRED';
    schedulePolicy: 'UNSUPPORTED';
    previewMaximumRows: number;
    artifactMaximumBytes: number;
    measurementState: 'BLOCKED' | 'QUALIFIED';
    unavailableReason?: string;
    capabilityCatalogSha256: string;
    measurementCatalogSha256: string;
    authorityGraphSha256: string;
  }> {
    return this.authorityGraph.capabilityCatalog.entries.map((capability) => {
      const authority = getReportMeasurementAuthorityFromAuthorityGraph(
        this.authorityGraph,
        capability.reportType,
      );
      return {
        type: capability.reportType,
        name: capability.name,
        description: capability.description,
        category: capability.category,
        rangePolicy: capability.range.policy,
        schedulePolicy: capability.schedulePolicy,
        previewMaximumRows: capability.preview.maximumRows,
        artifactMaximumBytes: capability.artifact.maximumBytes,
        measurementState: authority.state,
        ...(authority.blocker === null ? {} : { unavailableReason: authority.blocker }),
        capabilityCatalogSha256: this.authorityGraph.capabilityCatalogSha256,
        measurementCatalogSha256: this.authorityGraph.measurementCatalogSha256,
        authorityGraphSha256: this.authorityGraph.graphSha256,
      };
    });
  }

  // ============================================================================
  // Report Definitions CRUD
  // ============================================================================

  /**
   * Get all report definitions
   */
  async getDefinitions(params?: {
    status?: ReportDefinitionStatus;
    type?: ReportType;
    page?: number;
    limit?: number;
  }): Promise<IStandardPaginatedResult<ReportDefinition>> {
    const page = params?.page || 1;
    const limit = params?.limit || 20;
    const skip = (page - 1) * limit;

    const queryBuilder = this.definitionRepository.createQueryBuilder('def');

    if (params?.status) {
      queryBuilder.andWhere('def.status = :status', { status: params.status });
    }

    if (params?.type) {
      queryBuilder.andWhere('def.type = :type', { type: params.type });
    }

    queryBuilder.orderBy('def.createdAt', 'DESC');
    queryBuilder.skip(skip).take(limit);

    const [data, total] = await queryBuilder.getManyAndCount();

    return createStandardPaginatedResult(data, total, page, limit);
  }

  /**
   * Get report definition by ID
   */
  async getDefinition(id: string): Promise<ReportDefinition> {
    const definition = await this.definitionRepository.findOne({ where: { id } });
    if (!definition) {
      throw new NotFoundException(`Report definition not found: ${id}`);
    }
    return definition;
  }

  /**
   * Create report definition
   */
  async createDefinition(data: {
    name: string;
    description?: string;
    type: ReportType;
    defaultFormat?: ReportFormat;
    defaultFilters?: Record<string, unknown>;
    createdBy?: string;
    createdByEmail?: string;
  }): Promise<ReportDefinition> {
    const definition = this.definitionRepository.create({
      name: data.name,
      description: data.description,
      type: data.type,
      defaultFormat: data.defaultFormat || 'json',
      status: 'active',
      defaultFilters: data.defaultFilters,
      createdBy: data.createdBy,
      createdByEmail: data.createdByEmail,
    });

    return this.definitionRepository.save(definition);
  }

  /**
   * Update report definition
   */
  async updateDefinition(
    id: string,
    data: Partial<{
      name: string;
      description: string;
      defaultFormat: ReportFormat;
      status: ReportDefinitionStatus;
      defaultFilters: Record<string, unknown>;
    }>,
  ): Promise<ReportDefinition> {
    const definition = await this.getDefinition(id);

    Object.assign(definition, data, { updatedAt: new Date() });

    return this.definitionRepository.save(definition);
  }

  /**
   * Delete report definition
   */
  async deleteDefinition(id: string): Promise<void> {
    const definition = await this.getDefinition(id);
    await this.definitionRepository.remove(definition);
  }

  // ============================================================================
  // Report Executions
  // ============================================================================

  /**
   * Get execution history
   */
  async getExecutions(params?: {
    definitionId?: string;
    status?: ReportExecutionStatus;
    reportType?: ReportType;
    page?: number;
    limit?: number;
  }): Promise<IStandardPaginatedResult<ReportExecution>> {
    const page = params?.page || 1;
    const limit = params?.limit || 20;
    const skip = (page - 1) * limit;

    const queryBuilder = this.executionRepository.createQueryBuilder('exec');

    if (params?.definitionId) {
      queryBuilder.andWhere('exec.definitionId = :definitionId', {
        definitionId: params.definitionId,
      });
    }

    if (params?.status) {
      queryBuilder.andWhere('exec.status = :status', { status: params.status });
    }

    if (params?.reportType) {
      queryBuilder.andWhere('exec.reportType = :reportType', { reportType: params.reportType });
    }

    queryBuilder.orderBy('exec.createdAt', 'DESC');
    queryBuilder.skip(skip).take(limit);

    const [data, total] = await queryBuilder.getManyAndCount();

    return createStandardPaginatedResult(data, total, page, limit);
  }

  /**
   * Get execution by ID
   */
  async getExecution(id: string): Promise<ReportExecution> {
    const execution = await this.executionRepository.findOne({ where: { id } });
    if (!execution) {
      throw new NotFoundException(`Report execution not found: ${id}`);
    }
    return execution;
  }

  /**
   * Execute a report (from definition or ad-hoc)
   */
  async executeReport(params: {
    definitionId?: string;
    reportType?: ReportType;
    reportName?: string;
    format: ReportFormat;
    filters?: Record<string, unknown>;
    startDate?: Date;
    endDate?: Date;
    executedBy?: string;
    executedByEmail?: string;
  }): Promise<ReportExecution> {
    const startTime = Date.now();

    // Get definition if provided
    let definition: ReportDefinition | null = null;
    if (params.definitionId) {
      definition = await this.getDefinition(params.definitionId);
    }

    const reportType = definition?.type || params.reportType;
    const reportName = definition?.name || params.reportName || `${reportType} Report`;

    if (!reportType) {
      throw new BadRequestException('Report type is required');
    }

    const capability = getReportCapabilityFromAuthorityGraph(this.authorityGraph, reportType);
    const measurementAuthority = getReportMeasurementAuthorityFromAuthorityGraph(
      this.authorityGraph,
      reportType,
    );
    const effectiveFilters = params.filters ?? definition?.defaultFilters ?? undefined;

    if (!capability.artifact.formats.includes(params.format)) {
      throw new BadRequestException(`${params.format} is not supported for ${reportType}`);
    }
    if (
      (params.startDate && Number.isNaN(params.startDate.getTime())) ||
      (params.endDate && Number.isNaN(params.endDate.getTime()))
    ) {
      throw new BadRequestException('Report range contains an invalid date');
    }
    let measurementIntent: ReportMeasurementIntentV1;
    try {
      measurementIntent = compileReportMeasurementIntentForAuthorityGraph(this.authorityGraph, {
        reportType,
        startInclusiveUtc: params.startDate?.toISOString() ?? null,
        endExclusiveUtc: params.endDate?.toISOString() ?? null,
        filters: effectiveFilters ?? null,
        currentTimeUtc: new Date().toISOString(),
      });
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Invalid report measurement intent',
      );
    }

    // Create execution record
    const execution = this.executionRepository.create({
      definitionId: params.definitionId,
      reportName,
      reportType,
      format: params.format,
      status:
        measurementAuthority.state === 'QUALIFIED'
          ? ('running' as ReportExecutionStatus)
          : ('unavailable' as ReportExecutionStatus),
      startDate: params.startDate,
      endDate: params.endDate,
      filters: measurementIntent.filters ?? undefined,
      executedBy: params.executedBy,
      executedByEmail: params.executedByEmail,
      capabilityCatalogSha256: this.authorityGraph.capabilityCatalogSha256,
      measurementCatalogSha256: this.authorityGraph.measurementCatalogSha256,
      authorityGraphSha256: this.authorityGraph.graphSha256,
      artifactMaximumBytes: capability.artifact.maximumBytes,
      previewMaximumRows: capability.preview.maximumRows,
      measurementState: measurementAuthority.state,
      errorMessage: measurementAuthority.blocker ?? undefined,
      completedAt: measurementAuthority.state === 'BLOCKED' ? new Date() : undefined,
      durationMs: measurementAuthority.state === 'BLOCKED' ? Date.now() - startTime : undefined,
    });

    await this.executionRepository.save(execution);

    if (measurementAuthority.state === 'BLOCKED') {
      return execution;
    }

    let stagedArtifact:
      | {
          readonly objectKey: string;
          readonly sha256: string;
          readonly size: number;
          readonly contentType: AdminBinaryArtifactMediaType;
        }
      | undefined;
    try {
      const qualifiedMeasurement = await this.measurementAdapterRegistry.measure(measurementIntent);
      const reportData = qualifiedMeasurement.rows;
      const reportSummary = { ...qualifiedMeasurement.summary };

      const rowCount = reportData.length;
      const previewRows = this.createPreviewRows(reportData, capability.preview.maximumRows);
      const previewSha256 = reportPreviewSha256(reportType, rowCount, previewRows);

      const artifact = await this.buildReportArtifact({
        executionId: execution.id,
        reportType,
        format: params.format,
        data: reportData,
        summary: reportSummary,
        measuredAt: qualifiedMeasurement.measuredAt,
        measurementProofSha256: qualifiedMeasurement.measurementProofSha256,
      });
      stagedArtifact = {
        objectKey: artifact.objectKey,
        sha256: artifact.sha256,
        size: artifact.size,
        contentType: artifact.contentType,
      };
      await this.compareAndSwapArtifactCommit(execution, null, 'INTENT_CREATED', {
        summary: reportSummary,
        rowCount,
        previewRows,
        previewSha256,
        measurementProof: qualifiedMeasurement.measurementProof,
        measurementProofSha256: qualifiedMeasurement.measurementProofSha256,
        fileSizeBytes: artifact.size,
        artifactContentType: artifact.contentType,
        stagedArtifactObjectKey: artifact.objectKey,
        stagedArtifactSha256: artifact.sha256,
      });

      await this.uploadReportArtifact(artifact, {
        executionId: execution.id,
        reportType,
        format: params.format,
        measurementProofSha256: qualifiedMeasurement.measurementProofSha256,
      });
      await this.compareAndSwapArtifactCommit(execution, 'INTENT_CREATED', 'BYTES_VERIFIED', {});

      await this.commitVerifiedArtifactReference(execution, startTime);

      return execution;
    } catch (error) {
      if (stagedArtifact !== undefined) {
        try {
          const persisted = await this.executionRepository.findOne({
            where: { id: execution.id },
          });
          if (
            persisted?.status === 'completed' &&
            persisted.artifactCommitState === 'REFERENCE_COMMITTED' &&
            persisted.artifactObjectKey === stagedArtifact.objectKey &&
            persisted.artifactSha256 === stagedArtifact.sha256 &&
            persisted.fileSizeBytes === stagedArtifact.size
          ) {
            return persisted;
          }
          if (
            persisted?.status === 'running' &&
            (persisted.artifactCommitState === 'INTENT_CREATED' ||
              persisted.artifactCommitState === 'BYTES_VERIFIED') &&
            persisted.stagedArtifactObjectKey === stagedArtifact.objectKey &&
            persisted.stagedArtifactSha256 === stagedArtifact.sha256
          ) {
            this.logger.warn(
              `Report artifact ${stagedArtifact.objectKey} remains in ${persisted.artifactCommitState} for idempotent reconciliation`,
            );
            throw error;
          }
        } catch (readError) {
          if (readError === error) {
            throw error;
          }
          this.logger.error(
            `Could not resolve report execution commit ambiguity for ${execution.id}: ${
              readError instanceof Error ? readError.message : String(readError)
            }`,
          );
          throw error;
        }
      }
      // Mark execution as failed
      execution.status = 'failed';
      execution.errorMessage = error instanceof Error ? error.message : 'Unknown error';
      execution.summary = null;
      execution.rowCount = null;
      execution.fileSizeBytes = null;
      execution.artifactObjectKey = null;
      execution.artifactSha256 = null;
      execution.artifactContentType = null;
      execution.downloadExpiresAt = null;
      execution.previewRows = null;
      execution.previewSha256 = null;
      execution.measurementProof = null;
      execution.measurementProofSha256 = null;
      execution.stagedArtifactObjectKey = null;
      execution.stagedArtifactSha256 = null;
      execution.artifactCommitState = null;
      execution.durationMs = Date.now() - startTime;
      execution.completedAt = new Date();

      await this.executionRepository.save(execution);

      throw error;
    }
  }

  /**
   * Reconciles a durable artifact intent after a process crash or ambiguous
   * storage/DB acknowledgement. The content-addressed object is re-read and
   * verified before the same CAS state machine may commit its reference.
   */
  async reconcileArtifactCommit(id: string): Promise<ReportExecution> {
    const execution = await this.getExecution(id);
    if (
      execution.status === 'completed' &&
      execution.artifactCommitState === 'REFERENCE_COMMITTED'
    ) {
      return execution;
    }
    if (
      execution.status !== 'running' ||
      execution.measurementState !== 'QUALIFIED' ||
      (execution.artifactCommitState !== 'INTENT_CREATED' &&
        execution.artifactCommitState !== 'BYTES_VERIFIED') ||
      execution.stagedArtifactObjectKey == null ||
      execution.stagedArtifactSha256 == null ||
      execution.fileSizeBytes == null ||
      execution.artifactContentType == null ||
      execution.measurementProof == null ||
      execution.measurementProofSha256 == null ||
      execution.summary == null ||
      execution.rowCount == null ||
      execution.previewRows == null ||
      execution.previewSha256 == null
    ) {
      throw new BadRequestException('Report execution has no reconcilable artifact commit intent');
    }
    this.assertExecutionAuthorityCut(execution);
    try {
      assertReportMeasurementProofForAuthorityGraph(
        this.authorityGraph,
        execution.measurementProof,
        {
          reportType: execution.reportType,
          intentSha256: reportMeasurementIntentSha256({
            reportType: execution.reportType,
            startInclusiveUtc: execution.startDate?.toISOString() ?? null,
            endExclusiveUtc: execution.endDate?.toISOString() ?? null,
            filters: execution.filters ?? null,
          }),
          proofSha256: execution.measurementProofSha256,
        },
      );
    } catch {
      throw new GoneException('Staged report measurement proof is stale');
    }
    if (
      execution.previewRows.length > execution.previewMaximumRows ||
      reportPreviewSha256(execution.reportType, execution.rowCount, execution.previewRows) !==
        execution.previewSha256 ||
      execution.artifactContentType !== this.getContentType(execution.format)
    ) {
      throw new GoneException('Staged report evidence coordinates are stale');
    }
    const expectedObjectKey =
      `platform-admin/report-executions/${execution.id}/` +
      `${execution.stagedArtifactSha256}.${this.getExtension(execution.format)}`;
    if (execution.stagedArtifactObjectKey !== expectedObjectKey) {
      throw new GoneException('Report artifact intent coordinates are stale');
    }
    const bytes = await this.storageService.downloadFile(execution.stagedArtifactObjectKey);
    const actualSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (
      actualSha256 !== execution.stagedArtifactSha256 ||
      bytes.length !== execution.fileSizeBytes ||
      bytes.length > execution.artifactMaximumBytes
    ) {
      throw new InternalServerErrorException('Staged report artifact integrity check failed');
    }
    if (execution.artifactCommitState === 'INTENT_CREATED') {
      await this.compareAndSwapArtifactCommit(execution, 'INTENT_CREATED', 'BYTES_VERIFIED', {});
    }
    await this.commitVerifiedArtifactReference(
      execution,
      Math.min(Date.now(), execution.createdAt.getTime()),
    );
    return execution;
  }

  private async commitVerifiedArtifactReference(
    execution: ReportExecution,
    startTime: number,
  ): Promise<void> {
    if (execution.stagedArtifactObjectKey == null || execution.stagedArtifactSha256 == null) {
      throw new InternalServerErrorException('Verified artifact has no staged coordinates');
    }
    const completedAt = new Date();
    await this.compareAndSwapArtifactCommit(execution, 'BYTES_VERIFIED', 'REFERENCE_COMMITTED', {
      status: 'completed',
      artifactObjectKey: execution.stagedArtifactObjectKey,
      artifactSha256: execution.stagedArtifactSha256,
      stagedArtifactObjectKey: null,
      stagedArtifactSha256: null,
      downloadExpiresAt: new Date(completedAt.getTime() + 7 * 24 * 60 * 60 * 1000),
      errorMessage: null,
      durationMs: Math.max(0, completedAt.getTime() - startTime),
      completedAt,
    });
  }

  private async compareAndSwapArtifactCommit(
    execution: ReportExecution,
    previous: ReportExecution['artifactCommitState'] | null,
    next: NonNullable<ReportExecution['artifactCommitState']>,
    patch: Partial<ReportExecution>,
  ): Promise<void> {
    assertReportArtifactCommitTransition(previous ?? null, next);
    const criteria = {
      id: execution.id,
      status: 'running' as ReportExecutionStatus,
      artifactCommitState: previous === null ? IsNull() : previous,
    };
    try {
      const updateProjection = {
        ...patch,
        artifactCommitState: next,
      } as QueryDeepPartialEntity<ReportExecution>;
      const result = await this.executionRepository.update(criteria, updateProjection);
      if (result.affected !== 1) {
        throw new Error(`Report artifact commit CAS rejected ${previous ?? 'NONE'} -> ${next}`);
      }
      Object.assign(execution, patch, { artifactCommitState: next });
    } catch (error) {
      const persisted = await this.executionRepository.findOne({
        where: { id: execution.id },
      });
      if (
        persisted?.artifactCommitState === next ||
        (next !== 'REFERENCE_COMMITTED' && persisted?.artifactCommitState === 'REFERENCE_COMMITTED')
      ) {
        Object.assign(execution, persisted);
        return;
      }
      throw error;
    }
  }

  private assertExecutionAuthorityCut(execution: ReportExecution): void {
    const capability = getReportCapabilityFromAuthorityGraph(
      this.authorityGraph,
      execution.reportType,
    );
    if (
      execution.capabilityCatalogSha256 !== this.authorityGraph.capabilityCatalogSha256 ||
      execution.measurementCatalogSha256 !== this.authorityGraph.measurementCatalogSha256 ||
      execution.authorityGraphSha256 !== this.authorityGraph.graphSha256 ||
      execution.artifactMaximumBytes !== capability.artifact.maximumBytes ||
      execution.previewMaximumRows !== capability.preview.maximumRows
    ) {
      throw new GoneException('Report execution authority cut is stale');
    }
  }

  private createPreviewRows(data: unknown, maximumRows: number): Array<Record<string, unknown>> {
    if (!Array.isArray(data)) {
      return [];
    }
    const preview: Array<Record<string, unknown>> = [];
    for (const row of data.slice(0, maximumRows)) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        throw new InternalServerErrorException(
          'Measured report rows must be JSON objects before preview qualification',
        );
      }
      preview.push({ ...row });
    }
    return preview;
  }

  private async buildReportArtifact(params: {
    executionId: string;
    reportType: ReportType;
    format: ReportFormat;
    data: unknown;
    summary?: Record<string, unknown>;
    measuredAt: string;
    measurementProofSha256: string;
  }): Promise<{
    buffer: Buffer;
    filename: string;
    objectKey: string;
    sha256: string;
    contentType: AdminBinaryArtifactMediaType;
    size: number;
  }> {
    const contentType = this.getContentType(params.format);
    const extension = this.getExtension(params.format);
    let buffer: Buffer;

    if (params.format === 'json') {
      buffer = Buffer.from(
        JSON.stringify({
          data: params.data,
          summary: params.summary || {},
          metadata: {
            measuredAt: params.measuredAt,
            reportType: params.reportType,
            format: params.format,
            measurementProofSha256: params.measurementProofSha256,
          },
        }),
      );
    } else if (params.format === 'csv') {
      buffer = Buffer.from(
        this.convertToCsv(
          Array.isArray(params.data) ? (params.data as Record<string, unknown>[]) : [],
        ),
      );
    } else {
      buffer = await this.generatePdfBuffer(
        params.reportType,
        {
          data: params.data,
          summary: params.summary || {},
        },
        params.measuredAt,
      );
    }

    try {
      assertReportArtifactSizeForAuthorityGraph(
        this.authorityGraph,
        params.reportType,
        buffer.length,
      );
    } catch (error) {
      throw new InternalServerErrorException(
        error instanceof Error ? error.message : 'Report artifact exceeds its catalog maximum',
      );
    }

    const artifactSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const filename = `${artifactSha256}.${extension}`;

    return {
      buffer,
      filename,
      objectKey: `platform-admin/report-executions/${params.executionId}/${filename}`,
      sha256: artifactSha256,
      contentType,
      size: buffer.length,
    };
  }

  private async uploadReportArtifact(
    artifact: {
      readonly buffer: Buffer;
      readonly filename: string;
      readonly objectKey: string;
      readonly sha256: string;
      readonly contentType: AdminBinaryArtifactMediaType;
      readonly size: number;
    },
    params: {
      readonly executionId: string;
      readonly reportType: ReportType;
      readonly format: ReportFormat;
      readonly measurementProofSha256: string;
    },
  ): Promise<void> {
    const upload = await this.storageService.uploadFile(
      'platform-admin',
      'report-executions',
      params.executionId,
      artifact.filename,
      artifact.buffer,
      {
        contentType: artifact.contentType,
        metadata: {
          reportType: params.reportType,
          reportFormat: params.format,
          sha256: artifact.sha256,
          measurementProofSha256: params.measurementProofSha256,
        },
      },
    );

    if (
      upload.path !== artifact.objectKey ||
      upload.size !== artifact.size ||
      upload.contentType !== artifact.contentType
    ) {
      throw new InternalServerErrorException(
        'Report artifact storage receipt does not match its staged coordinates',
      );
    }
  }

  private getContentType(format: ReportFormat): AdminBinaryArtifactMediaType {
    return adminBinaryMediaTypeForFormat(format);
  }

  private getExtension(format: ReportFormat): string {
    const extensions: Record<ReportFormat, string> = {
      json: 'json',
      csv: 'csv',
      pdf: 'pdf',
    };
    return extensions[format];
  }

  /**
   * Get execution download data
   */
  async getExecutionDownload(id: string): Promise<{
    execution: ReportExecution;
    data: Buffer;
    contentType: AdminBinaryArtifactMediaType;
    filename: string;
  }> {
    const execution = await this.getExecution(id);

    try {
      this.assertExecutionAuthorityCut(execution);
    } catch {
      throw new GoneException('Report artifact was qualified by a stale authority cut');
    }
    if (execution.measurementState !== 'QUALIFIED') {
      throw new GoneException('Report artifact has no qualified measurement authority');
    }
    if (
      execution.status !== 'completed' ||
      execution.artifactCommitState !== 'REFERENCE_COMMITTED'
    ) {
      throw new BadRequestException('Report execution is not completed');
    }
    if (execution.measurementProof == null || execution.measurementProofSha256 == null) {
      throw new GoneException('Report artifact measurement proof is missing or stale');
    }
    try {
      assertReportMeasurementProofForAuthorityGraph(
        this.authorityGraph,
        execution.measurementProof,
        {
          reportType: execution.reportType,
          intentSha256: reportMeasurementIntentSha256({
            reportType: execution.reportType,
            startInclusiveUtc: execution.startDate?.toISOString() ?? null,
            endExclusiveUtc: execution.endDate?.toISOString() ?? null,
            filters: execution.filters ?? null,
          }),
          proofSha256: execution.measurementProofSha256,
        },
      );
    } catch {
      throw new GoneException('Report artifact measurement proof is missing or stale');
    }

    if (execution.downloadExpiresAt == null || Date.now() > execution.downloadExpiresAt.getTime()) {
      throw new GoneException('Download link has expired');
    }

    const expectedObjectKey =
      `platform-admin/report-executions/${execution.id}/` +
      `${execution.artifactSha256}.${this.getExtension(execution.format)}`;
    if (
      !execution.artifactObjectKey ||
      !execution.artifactSha256 ||
      execution.artifactObjectKey !== expectedObjectKey ||
      execution.fileSizeBytes == null ||
      execution.fileSizeBytes > execution.artifactMaximumBytes ||
      execution.artifactContentType !== this.getContentType(execution.format)
    ) {
      throw new GoneException('Report artifact is unavailable');
    }

    const reportData = await this.storageService.downloadFile(execution.artifactObjectKey);
    const sha256 = crypto.createHash('sha256').update(reportData).digest('hex');
    if (
      execution.artifactSha256 !== sha256 ||
      reportData.length !== execution.fileSizeBytes ||
      reportData.length > execution.artifactMaximumBytes
    ) {
      this.logger.error(`Report artifact checksum mismatch for execution ${execution.id}`);
      throw new InternalServerErrorException('Report artifact integrity check failed');
    }

    return {
      execution,
      data: reportData,
      contentType: execution.artifactContentType
        ? decodeAdminBinaryArtifactMediaType(execution.artifactContentType)
        : this.getContentType(execution.format),
      filename: `${execution.reportName.replace(/\s+/g, '_')}_${execution.id}.${this.getExtension(execution.format)}`,
    };
  }

  // ============================================================================
}
