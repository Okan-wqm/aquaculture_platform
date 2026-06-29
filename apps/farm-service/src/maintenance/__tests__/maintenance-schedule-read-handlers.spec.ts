/**
 * Maintenance-schedule read query handlers — fail-closed tenant boundary
 * (FARM-HIGH-060). Tenant scoping + fail-closed NotFound + empty aggregates.
 */
import { NotFoundException } from '@nestjs/common';
import { createMockDataSource } from '@aquaculture/testing';

import { GetMaintenanceScheduleHandler } from '../handlers/get-maintenance-schedule.handler';
import { GetMaintenanceScheduleQuery } from '../queries/get-maintenance-schedule.query';
import { GetMaintenanceScheduleByCodeHandler } from '../handlers/get-maintenance-schedule-by-code.handler';
import { GetMaintenanceScheduleByCodeQuery } from '../queries/get-maintenance-schedule-by-code.query';
import { ListUpcomingMaintenanceSchedulesHandler } from '../handlers/list-upcoming-maintenance-schedules.handler';
import { ListUpcomingMaintenanceSchedulesQuery } from '../queries/list-upcoming-maintenance-schedules.query';
import { ListMaintenanceScheduleAlertsHandler } from '../handlers/list-maintenance-schedule-alerts.handler';
import { ListMaintenanceScheduleAlertsQuery } from '../queries/list-maintenance-schedule-alerts.query';
import { GetMaintenanceComplianceReportHandler } from '../handlers/get-maintenance-compliance-report.handler';
import { GetMaintenanceComplianceReportQuery } from '../queries/get-maintenance-compliance-report.query';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('Maintenance-schedule read handlers (fail-closed tenant boundary)', () => {
  it('GetMaintenanceScheduleHandler reads by id scoped to the tenant', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ id: 'ms-1' });

    const result = await new GetMaintenanceScheduleHandler(mockDataSource).execute(
      new GetMaintenanceScheduleQuery(tenantId, 'ms-1'),
    );

    expect(result).toEqual({ id: 'ms-1' });
    expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id: 'ms-1', tenantId },
    });
  });

  it('GetMaintenanceScheduleByCodeHandler throws NotFoundException when absent', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    await expect(
      new GetMaintenanceScheduleByCodeHandler(mockDataSource).execute(
        new GetMaintenanceScheduleByCodeQuery(tenantId, 'MS-X'),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('ListUpcomingMaintenanceSchedulesHandler scopes to tenant + active', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([{ id: 'ms-2' }]);

    const result = await new ListUpcomingMaintenanceSchedulesHandler(mockDataSource).execute(
      new ListUpcomingMaintenanceSchedulesQuery(tenantId, 7),
    );

    expect(result).toHaveLength(1);
    const [, opts] = (mockManager.find as jest.Mock).mock.calls[0];
    expect(opts.where).toMatchObject({ tenantId });
  });

  it('ListMaintenanceScheduleAlertsHandler returns [] when no active schedules', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([]);

    const result = await new ListMaintenanceScheduleAlertsHandler(mockDataSource).execute(
      new ListMaintenanceScheduleAlertsQuery(tenantId),
    );

    expect(result).toEqual([]);
  });

  it('GetMaintenanceComplianceReportHandler aggregates tenant-scoped schedules', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([]); // no schedules → zeroed report

    const result = await new GetMaintenanceComplianceReportHandler(mockDataSource).execute(
      new GetMaintenanceComplianceReportQuery(tenantId),
    );

    expect(result.totalSchedules).toBe(0);
    expect(result.activeSchedules).toBe(0);
    expect(mockManager.find).toHaveBeenCalledWith(expect.anything(), { where: { tenantId } });
  });
});
