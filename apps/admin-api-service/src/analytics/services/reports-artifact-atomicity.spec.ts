import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  REPORT_CAPABILITY_CATALOG,
  REPORT_MEASUREMENT_AUTHORITY_CATALOG,
  compileReportAuthorityGraph,
  compileReportMeasurementAdapterBuildAttestation,
  type CompiledReportAuthorityGraphV1,
  type ReportMeasurementAuthorityCatalogV1,
} from '@platform/reporting-contracts';
import { MinioClientService } from '@platform/storage';

import { ReportDefinition, ReportExecution } from '../entities/analytics-snapshot.entity';

import {
  REPORT_COMPILED_AUTHORITY_GRAPH,
  REPORT_MEASUREMENT_ADAPTER_BUILD_ATTESTATIONS,
  REPORT_MEASUREMENT_ADAPTERS,
  ReportMeasurementAdapterRegistry,
  type MeasuredReportDatasetV1,
  type ReportMeasurementAdapterV1,
} from './report-measurement-adapter.registry';
import { ReportsService } from './reports.service';

const EXECUTION_ID = '11111111-1111-4111-8111-111111111111';
const ADAPTER_BINDING = Object.freeze({
  adapterId: 'tenant-overview-adapter.v1',
  implementationSha256: 'a'.repeat(64),
  provenanceSha256: 'b'.repeat(64),
});

function qualifiedAuthorityGraph(): CompiledReportAuthorityGraphV1 {
  const measurementCatalog: ReportMeasurementAuthorityCatalogV1 = {
    schemaVersion: 'report-measurement-authority-catalog.v1',
    entries: REPORT_MEASUREMENT_AUTHORITY_CATALOG.entries.map((entry, index) =>
      index === 0
        ? {
            ...entry,
            state: 'QUALIFIED',
            blocker: null,
            qualifiedAdapter: ADAPTER_BINDING,
          }
        : entry,
    ),
  };
  return compileReportAuthorityGraph(REPORT_CAPABILITY_CATALOG, measurementCatalog);
}

function qualifiedAdapter(
  authorityGraph: CompiledReportAuthorityGraphV1,
): ReportMeasurementAdapterV1 {
  const authority = authorityGraph.measurementCatalog.entries[0];
  if (authority === undefined) throw new Error('qualified test authority is missing');
  return {
    adapterId: ADAPTER_BINDING.adapterId,
    reportType: 'tenant_overview',
    measurementAuthorityId: authority.authorityId,
    measure: jest.fn(
      async (intent): Promise<MeasuredReportDatasetV1> => ({
        schemaVersion: 'measured-report-dataset.v1',
        reportType: 'tenant_overview',
        measurementAuthorityId: authority.authorityId,
        measurementCatalogSha256: authorityGraph.measurementCatalogSha256,
        intentSha256: intent.intentSha256,
        generatedAt: new Date('2026-08-08T12:00:00.000Z'),
        rows: [{ tenantId: 'tenant-1', status: 'active' }],
        summary: { tenantCount: 1 },
        factEvidence: authority.requiredFacts.map((factId, index) => ({
          factId,
          sourceCutSha256: (index + 1).toString(16).padStart(64, '0'),
        })),
      }),
    ),
  };
}

function snapshotExecution(execution: ReportExecution): ReportExecution {
  return Object.assign(new ReportExecution(), {
    ...execution,
    measurementProof:
      execution.measurementProof === null || execution.measurementProof === undefined
        ? execution.measurementProof
        : { ...execution.measurementProof },
  });
}

describe('ReportsService artifact/DB commit protocol', () => {
  let service: ReportsService;
  let executionRepository: {
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let storageService: { uploadFile: jest.Mock; downloadFile: jest.Mock };
  let saveSnapshots: ReportExecution[];
  let persistedExecution: ReportExecution | null;
  let uploadedBytes: Buffer | null;

  beforeEach(async () => {
    const authorityGraph = qualifiedAuthorityGraph();
    saveSnapshots = [];
    persistedExecution = null;
    uploadedBytes = null;
    executionRepository = {
      create: jest.fn((input: Partial<ReportExecution>) =>
        Object.assign(new ReportExecution(), {
          id: EXECUTION_ID,
          createdAt: new Date('2026-08-08T12:00:00.000Z'),
          ...input,
        }),
      ),
      save: jest.fn(async (execution: ReportExecution) => {
        persistedExecution = snapshotExecution(execution);
        saveSnapshots.push(snapshotExecution(persistedExecution));
        return execution;
      }),
      update: jest.fn(async (_criteria, patch: Partial<ReportExecution>) => {
        if (persistedExecution === null) return { affected: 0 };
        Object.assign(persistedExecution, patch);
        saveSnapshots.push(snapshotExecution(persistedExecution));
        return { affected: 1 };
      }),
      findOne: jest.fn(async () =>
        persistedExecution === null ? null : snapshotExecution(persistedExecution),
      ),
      createQueryBuilder: jest.fn(),
    };
    storageService = {
      uploadFile: jest.fn(
        async (
          tenantId: string,
          entityType: string,
          entityId: string,
          filename: string,
          buffer: Buffer,
          options: { contentType: string },
        ) => {
          uploadedBytes = Buffer.from(buffer);
          return {
            internalUrl: `minio://${tenantId}/${entityType}/${entityId}/${filename}`,
            path: `${tenantId}/${entityType}/${entityId}/${filename}`,
            etag: 'etag',
            size: buffer.length,
            contentType: options.contentType,
          };
        },
      ),
      downloadFile: jest.fn(async () => {
        if (uploadedBytes === null) throw new Error('object is absent');
        return Buffer.from(uploadedBytes);
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        {
          provide: getRepositoryToken(ReportDefinition),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            remove: jest.fn(),
            createQueryBuilder: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(ReportExecution),
          useValue: executionRepository,
        },
        { provide: MinioClientService, useValue: storageService },
        {
          provide: REPORT_COMPILED_AUTHORITY_GRAPH,
          useValue: authorityGraph,
        },
        {
          provide: REPORT_MEASUREMENT_ADAPTERS,
          useValue: Object.freeze([qualifiedAdapter(authorityGraph)]),
        },
        {
          provide: REPORT_MEASUREMENT_ADAPTER_BUILD_ATTESTATIONS,
          useValue: Object.freeze([
            compileReportMeasurementAdapterBuildAttestation(authorityGraph, {
              schemaVersion: 'report-measurement-adapter-build-attestation.v1',
              issuer: 'admin-reporting-build-bootstrap.v1',
              adapterId: ADAPTER_BINDING.adapterId,
              reportType: 'tenant_overview',
              measurementAuthorityId: 'tenant-overview-facts.v1',
              implementationSha256: ADAPTER_BINDING.implementationSha256,
              provenanceSha256: ADAPTER_BINDING.provenanceSha256,
              authorityGraphSha256: authorityGraph.graphSha256,
            }),
          ]),
        },
        ReportMeasurementAdapterRegistry,
      ],
    }).compile();

    service = module.get(ReportsService);
  });

  it('persists content-addressed intent before upload and clears it only on terminal commit', async () => {
    const result = await service.executeReport({
      reportType: 'tenant_overview',
      reportName: 'Tenant Overview',
      format: 'json',
    });

    expect(result.status).toBe('completed');
    expect(saveSnapshots).toHaveLength(4);
    expect(saveSnapshots[0]).toEqual(
      expect.objectContaining({
        status: 'running',
      }),
    );
    expect(saveSnapshots[0]?.stagedArtifactObjectKey).toBeUndefined();
    expect(saveSnapshots[1]).toEqual(
      expect.objectContaining({
        status: 'running',
        artifactCommitState: 'INTENT_CREATED',
        stagedArtifactObjectKey: expect.stringMatching(
          new RegExp(`^platform-admin/report-executions/${EXECUTION_ID}/[0-9a-f]{64}\\.json$`),
        ),
        stagedArtifactSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    expect(saveSnapshots[2]).toEqual(
      expect.objectContaining({
        status: 'running',
        artifactCommitState: 'BYTES_VERIFIED',
      }),
    );
    expect(saveSnapshots[3]).toEqual(
      expect.objectContaining({
        status: 'completed',
        artifactCommitState: 'REFERENCE_COMMITTED',
        stagedArtifactObjectKey: null,
        stagedArtifactSha256: null,
        measurementProof: expect.objectContaining({
          adapterId: ADAPTER_BINDING.adapterId,
          adapterImplementationSha256: ADAPTER_BINDING.implementationSha256,
          adapterProvenanceSha256: ADAPTER_BINDING.provenanceSha256,
        }),
      }),
    );
    const stageSaveOrder = executionRepository.update.mock.invocationCallOrder[0];
    const uploadOrder = storageService.uploadFile.mock.invocationCallOrder[0];
    if (stageSaveOrder === undefined || uploadOrder === undefined) {
      throw new Error('expected stage-save and upload invocations');
    }
    expect(stageSaveOrder).toBeLessThan(uploadOrder);
  });

  it('resolves a lost terminal-commit acknowledgement without rewriting immutable evidence', async () => {
    let updateAttempt = 0;
    let terminalAttempt: ReportExecution | null = null;
    executionRepository.update.mockImplementation(
      async (_criteria, patch: Partial<ReportExecution>) => {
        updateAttempt += 1;
        if (persistedExecution === null) return { affected: 0 };
        Object.assign(persistedExecution, patch);
        const snapshot = snapshotExecution(persistedExecution);
        saveSnapshots.push(snapshot);
        if (updateAttempt === 3) {
          terminalAttempt = snapshot;
          persistedExecution = snapshot;
          throw new Error('terminal commit acknowledgement lost');
        }
        return { affected: 1 };
      },
    );
    executionRepository.findOne.mockImplementation(
      async () =>
        terminalAttempt ??
        (persistedExecution === null ? null : snapshotExecution(persistedExecution)),
    );

    const result = await service.executeReport({
      reportType: 'tenant_overview',
      reportName: 'Tenant Overview',
      format: 'json',
    });

    expect(result.status).toBe('completed');
    expect(executionRepository.save).toHaveBeenCalledTimes(1);
    expect(executionRepository.update).toHaveBeenCalledTimes(3);
    expect(saveSnapshots.some((snapshot) => snapshot.status === 'failed')).toBe(false);
  });

  it('rejects a stale artifact intent CAS before any object write', async () => {
    executionRepository.update.mockResolvedValueOnce({ affected: 0 });

    await expect(
      service.executeReport({
        reportType: 'tenant_overview',
        reportName: 'Tenant Overview',
        format: 'json',
      }),
    ).rejects.toThrow('Report artifact commit CAS rejected NONE -> INTENT_CREATED');
    expect(storageService.uploadFile).not.toHaveBeenCalled();
    expect(persistedExecution).toEqual(
      expect.objectContaining({
        status: 'failed',
        artifactCommitState: null,
      }),
    );
  });

  it('reconciles a crash after byte verification exactly once', async () => {
    let updateAttempt = 0;
    executionRepository.update.mockImplementation(
      async (_criteria, patch: Partial<ReportExecution>) => {
        updateAttempt += 1;
        if (persistedExecution === null) return { affected: 0 };
        if (updateAttempt === 3) {
          throw new Error('terminal commit acknowledgement lost');
        }
        Object.assign(persistedExecution, patch);
        saveSnapshots.push(snapshotExecution(persistedExecution));
        return { affected: 1 };
      },
    );

    await expect(
      service.executeReport({
        reportType: 'tenant_overview',
        reportName: 'Tenant Overview',
        format: 'json',
      }),
    ).rejects.toThrow('terminal commit acknowledgement lost');
    expect(persistedExecution).toEqual(
      expect.objectContaining({
        status: 'running',
        artifactCommitState: 'BYTES_VERIFIED',
      }),
    );

    const reconciled = await service.reconcileArtifactCommit(EXECUTION_ID);
    const repeated = await service.reconcileArtifactCommit(EXECUTION_ID);
    expect(reconciled.artifactCommitState).toBe('REFERENCE_COMMITTED');
    expect(repeated.artifactCommitState).toBe('REFERENCE_COMMITTED');
    expect(storageService.downloadFile).toHaveBeenCalledTimes(1);
  });

  it('retains durable staged coordinates when upload receipt verification fails', async () => {
    storageService.uploadFile.mockImplementationOnce(async () => ({
      internalUrl: 'minio://wrong/path',
      path: 'wrong/path',
      etag: 'etag',
      size: 1,
      contentType: 'application/json',
    }));

    await expect(
      service.executeReport({
        reportType: 'tenant_overview',
        reportName: 'Tenant Overview',
        format: 'json',
      }),
    ).rejects.toThrow('storage receipt does not match');

    const failed = saveSnapshots[saveSnapshots.length - 1];
    expect(failed).toEqual(
      expect.objectContaining({
        status: 'running',
        artifactCommitState: 'INTENT_CREATED',
        stagedArtifactObjectKey: expect.stringMatching(
          new RegExp(`^platform-admin/report-executions/${EXECUTION_ID}/[0-9a-f]{64}\\.json$`),
        ),
        stagedArtifactSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
  });
});
