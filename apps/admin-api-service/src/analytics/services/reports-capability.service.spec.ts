import { BadRequestException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  COMPILED_REPORT_AUTHORITY_GRAPH,
  REPORT_CAPABILITY_CATALOG_SHA256,
  REPORT_AUTHORITY_GRAPH_SHA256,
  REPORT_MAX_ARTIFACT_BYTES,
  REPORT_MEASUREMENT_AUTHORITY_CATALOG_SHA256,
  REPORT_TYPES,
} from '@platform/reporting-contracts';
import { MinioClientService } from '@platform/storage';

import {
  REPORT_COMPILED_AUTHORITY_GRAPH,
  REPORT_MEASUREMENT_ADAPTER_BUILD_ATTESTATIONS,
  REPORT_MEASUREMENT_ADAPTERS,
  ReportMeasurementAdapterRegistry,
} from './report-measurement-adapter.registry';
import { ReportDefinition, ReportExecution } from '../entities/analytics-snapshot.entity';
import { ReportsService } from './reports.service';

describe('ReportsService capability authority', () => {
  let service: ReportsService;
  let executionRepository: {
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
    findOne: jest.Mock;
  };
  let storageService: {
    uploadFile: jest.Mock;
    downloadFile: jest.Mock;
  };

  beforeEach(async () => {
    executionRepository = {
      create: jest.fn((input: Record<string, unknown>) => ({
        id: '11111111-1111-4111-8111-111111111111',
        createdAt: new Date('2026-08-08T00:00:00.000Z'),
        ...input,
      })),
      save: jest.fn(async (execution: ReportExecution) => execution),
      createQueryBuilder: jest.fn(),
      findOne: jest.fn(),
    };
    storageService = {
      uploadFile: jest.fn(),
      downloadFile: jest.fn(),
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
          useValue: COMPILED_REPORT_AUTHORITY_GRAPH,
        },
        {
          provide: REPORT_MEASUREMENT_ADAPTERS,
          useValue: Object.freeze([]),
        },
        {
          provide: REPORT_MEASUREMENT_ADAPTER_BUILD_ATTESTATIONS,
          useValue: Object.freeze([]),
        },
        ReportMeasurementAdapterRegistry,
      ],
    }).compile();

    service = module.get(ReportsService);
  });

  it('persists a blocked evidence record and never creates an artifact', async () => {
    const execution = await service.executeReport({
      reportType: 'tenant_overview',
      reportName: 'Tenant Overview',
      format: 'json',
    });

    expect(execution).toEqual(
      expect.objectContaining({
        status: 'unavailable',
        measurementState: 'BLOCKED',
        capabilityCatalogSha256: REPORT_CAPABILITY_CATALOG_SHA256,
        measurementCatalogSha256: REPORT_MEASUREMENT_AUTHORITY_CATALOG_SHA256,
        authorityGraphSha256: REPORT_AUTHORITY_GRAPH_SHA256,
        artifactMaximumBytes: REPORT_MAX_ARTIFACT_BYTES,
        previewMaximumRows: 10,
      }),
    );
    expect(execution.errorMessage).toContain('not wired');
    expect(executionRepository.save).toHaveBeenCalledTimes(1);
    expect(storageService.uploadFile).not.toHaveBeenCalled();

    executionRepository.findOne.mockResolvedValue(execution);
    await expect(service.getExecutionDownload(execution.id)).rejects.toThrow(
      'no qualified measurement authority',
    );
    expect(storageService.downloadFile).not.toHaveBeenCalled();
  });

  it('enforces the catalog range policy before persistence', async () => {
    await expect(
      service.executeReport({
        reportType: 'tenant_overview',
        reportName: 'Tenant Overview',
        format: 'json',
        startDate: new Date('2026-08-01T00:00:00.000Z'),
        endDate: new Date('2026-08-08T00:00:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.executeReport({
        reportType: 'financial_revenue',
        reportName: 'Revenue',
        format: 'csv',
      }),
    ).rejects.toThrow('requires an exact startDate and endDate');

    await expect(
      service.executeReport({
        reportType: 'financial_revenue',
        reportName: 'Revenue',
        format: 'csv',
        startDate: new Date('2026-08-01T00:00:00.000Z'),
        endDate: new Date('2026-08-01T00:00:00.000Z'),
      }),
    ).rejects.toThrow('non-empty UTC half-open interval');

    await expect(
      service.executeReport({
        reportType: 'financial_revenue',
        reportName: 'Revenue',
        format: 'csv',
        startDate: new Date('2099-01-01T00:00:00.000Z'),
        endDate: new Date('2100-01-01T00:00:00.000Z'),
      }),
    ).rejects.toThrow('cannot end in the future');

    expect(executionRepository.save).not.toHaveBeenCalled();
  });

  it('projects every report from the catalogs without claiming availability', () => {
    const capabilities = service.getReportCapabilities();

    expect(capabilities.map((entry) => entry.type)).toEqual(REPORT_TYPES);
    expect(capabilities).toHaveLength(REPORT_TYPES.length);
    expect(capabilities.every((entry) => entry.measurementState === 'BLOCKED')).toBe(true);
    expect(capabilities.every((entry) => entry.unavailableReason !== undefined)).toBe(true);
    expect(
      capabilities.every(
        (entry) =>
          entry.authorityGraphSha256 === REPORT_AUTHORITY_GRAPH_SHA256 &&
          entry.artifactMaximumBytes === REPORT_MAX_ARTIFACT_BYTES,
      ),
    ).toBe(true);
  });
});
