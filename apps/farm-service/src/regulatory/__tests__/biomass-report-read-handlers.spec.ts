/**
 * Biomass-report read query handlers — fail-closed tenant boundary
 * (FARM-HIGH-060). Tenant scoping + nullable by-period + clamped list.
 */
import { createMockDataSource } from '@aquaculture/testing';

import { GetBiomassReportByPeriodHandler } from '../handlers/get-biomass-report-by-period.handler';
import { GetBiomassReportByPeriodQuery } from '../queries/get-biomass-report-by-period.query';
import { ListBiomassReportsForSiteHandler } from '../handlers/list-biomass-reports-for-site.handler';
import { ListBiomassReportsForSiteQuery } from '../queries/list-biomass-reports-for-site.query';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('Biomass-report read handlers (fail-closed tenant boundary)', () => {
  it('GetBiomassReportByPeriodHandler reads the period scoped to the tenant', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ id: 'br-1' });

    const result = await new GetBiomassReportByPeriodHandler(mockDataSource).execute(
      new GetBiomassReportByPeriodQuery(tenantId, 'site-1', 6, 2026),
    );

    expect(result).toEqual({ id: 'br-1' });
    expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { tenantId, siteId: 'site-1', reportMonth: 6, reportYear: 2026 },
    });
  });

  it('GetBiomassReportByPeriodHandler returns null when absent (nullable field)', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const result = await new GetBiomassReportByPeriodHandler(mockDataSource).execute(
      new GetBiomassReportByPeriodQuery(tenantId, 'site-1', 1, 2026),
    );

    expect(result).toBeNull();
  });

  it('ListBiomassReportsForSiteHandler scopes to tenant + site and clamps limit', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([{ id: 'br-2' }]);

    const result = await new ListBiomassReportsForSiteHandler(mockDataSource).execute(
      new ListBiomassReportsForSiteQuery(tenantId, 'site-1', 999),
    );

    expect(result).toHaveLength(1);
    const [, opts] = (mockManager.find as jest.Mock).mock.calls[0];
    expect(opts.where).toMatchObject({ tenantId, siteId: 'site-1' });
    expect(opts.take).toBe(120); // clamped from 999
  });
});
