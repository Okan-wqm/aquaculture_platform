/**
 * Regulatory-report read query handlers — fail-closed tenant boundary
 * (FARM-HIGH-112). Tenant + type scoping, optional site filter, clamped
 * list, and the per-type summary aggregation shape.
 */
import { createMockDataSource } from '@aquaculture/testing';

import { ListRegulatoryReportsHandler } from '../handlers/list-regulatory-reports.handler';
import { ListRegulatoryReportsQuery } from '../queries/list-regulatory-reports.query';
import { GetRegulatoryReportHandler } from '../handlers/get-regulatory-report.handler';
import { GetRegulatoryReportQuery } from '../queries/get-regulatory-report.query';
import { GetRegulatoryReportSummaryHandler } from '../handlers/get-regulatory-report-summary.handler';
import { GetRegulatoryReportSummaryQuery } from '../queries/get-regulatory-report-summary.query';
import { RegulatoryReportType } from '../entities/regulatory-report.entity';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('Regulatory-report read handlers (fail-closed tenant boundary)', () => {
  it('ListRegulatoryReportsHandler scopes to tenant + type, filters site, clamps limit', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([{ id: 'rr-1' }]);

    const result = await new ListRegulatoryReportsHandler(mockDataSource).execute(
      new ListRegulatoryReportsQuery(tenantId, RegulatoryReportType.SEA_LICE, 'site-1', 9999, 0),
    );

    expect(result).toHaveLength(1);
    const [, opts] = (mockManager.find as jest.Mock).mock.calls[0];
    expect(opts.where).toMatchObject({
      tenantId,
      reportType: RegulatoryReportType.SEA_LICE,
      siteId: 'site-1',
    });
    expect(opts.take).toBe(200); // clamped from 9999
    expect(opts.order).toEqual({ createdAt: 'DESC' });
  });

  it('ListRegulatoryReportsHandler omits the site filter when siteId is absent', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([]);

    await new ListRegulatoryReportsHandler(mockDataSource).execute(
      new ListRegulatoryReportsQuery(tenantId, RegulatoryReportType.ESCAPE),
    );

    const [, opts] = (mockManager.find as jest.Mock).mock.calls[0];
    expect(opts.where).toEqual({ tenantId, reportType: RegulatoryReportType.ESCAPE });
  });

  it('GetRegulatoryReportHandler reads by id scoped to the tenant (nullable)', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const result = await new GetRegulatoryReportHandler(mockDataSource).execute(
      new GetRegulatoryReportQuery(tenantId, 'rr-404'),
    );

    expect(result).toBeNull();
    expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id: 'rr-404', tenantId },
    });
  });

  it('GetRegulatoryReportSummaryHandler maps grouped counts to numbers', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb: Record<string, jest.Mock> = {};
    for (const method of ['select', 'addSelect', 'where', 'andWhere', 'groupBy']) {
      qb[method] = jest.fn(() => qb);
    }
    qb.getRawMany = jest.fn().mockResolvedValue([
      {
        reportType: RegulatoryReportType.SEA_LICE,
        pendingCount: '1',
        submittedCount: '4',
        queuedCount: '0',
        failedCount: '2',
        lastSubmittedAt: new Date('2026-06-28T10:00:00Z'),
      },
    ]);
    (mockManager.createQueryBuilder as jest.Mock).mockReturnValue(qb);

    const result = await new GetRegulatoryReportSummaryHandler(mockDataSource).execute(
      new GetRegulatoryReportSummaryQuery(tenantId),
    );

    expect(result).toEqual([
      {
        reportType: RegulatoryReportType.SEA_LICE,
        pendingCount: 1,
        submittedCount: 4,
        queuedCount: 0,
        failedCount: 2,
        lastSubmittedAt: new Date('2026-06-28T10:00:00Z'),
      },
    ]);
    expect(qb.where).toHaveBeenCalledWith('r.tenantId = :tenantId', { tenantId });
    expect(qb.andWhere).not.toHaveBeenCalled();
  });

  it('GetRegulatoryReportSummaryHandler applies the site filter when provided', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb: Record<string, jest.Mock> = {};
    for (const method of ['select', 'addSelect', 'where', 'andWhere', 'groupBy']) {
      qb[method] = jest.fn(() => qb);
    }
    qb.getRawMany = jest.fn().mockResolvedValue([]);
    (mockManager.createQueryBuilder as jest.Mock).mockReturnValue(qb);

    await new GetRegulatoryReportSummaryHandler(mockDataSource).execute(
      new GetRegulatoryReportSummaryQuery(tenantId, 'site-1'),
    );

    expect(qb.andWhere).toHaveBeenCalledWith('r.siteId = :siteId', { siteId: 'site-1' });
  });
});
