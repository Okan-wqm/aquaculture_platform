import 'reflect-metadata';
import { of } from 'rxjs';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import type { ToolExecutionContext } from '../../../core/tool.interface';
import { GetBiomassReportTool } from '../get-biomass-report.tool';

const TANK = '22222222-2222-4222-8222-222222222222';
const CTX: ToolExecutionContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  schemaName: 'tenant_1111111111111111',
  userId: 'u-1',
  userRoles: ['MODULE_USER'],
  correlationId: 'corr-1',
  persona: 'manager-farm-production-v1',
  personaTier: 'manager',
  actuationPolicy: 'confirm_required',
};

describe('GetBiomassReportTool', () => {
  let send: jest.Mock;
  let tool: GetBiomassReportTool;

  beforeEach(() => {
    send = jest.fn().mockReturnValue(
      of({
        ok: true,
        data: {
          found: false,
          siteId: TANK,
          status: null,
          totalBiomassKg: null,
          currentBiomassBySpecies: [],
        },
      }),
    );
    tool = new GetBiomassReportTool({ send });
  });

  it('is a module-scoped farm read tool', () => {
    const metadata = tool.getMetadata();
    expect(metadata.name).toBe('get_biomass_report');
    expect(metadata.category).toBe('farm_query');
    expect(metadata.requiresModule).toBe('farm');
    expect(metadata.requiresConfirmation).toBe(false);
  });

  it('applies defaults and sends the contract subject with the context tenant', async () => {
    const result = await tool.execute({ siteId: TANK, reportMonth: 8, reportYear: 2026 }, CTX);

    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.REG_BIOMASS_REPORT, {
      ...{ siteId: TANK, reportMonth: 8, reportYear: 2026 },
      tenantId: CTX.tenantId,
    });
  });

  it('forwards explicit fields (limits clamped to the contract cap)', async () => {
    await tool.execute({ siteId: TANK, reportMonth: 1, reportYear: 2025 }, CTX);

    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.REG_BIOMASS_REPORT, {
      ...{ siteId: TANK, reportMonth: 1, reportYear: 2025 },
      tenantId: CTX.tenantId,
    });
  });
});
