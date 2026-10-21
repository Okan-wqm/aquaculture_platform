/**
 * Tank-by-tank growth projection under a temperature scenario — the
 * production plan's simulation. For every tank holding stock with an ACTIVE
 * protocol assignment, walks the horizon day by day: scenario temperature →
 * protocol band by average weight → daily feed = biomass × rate% × temp
 * multiplier → growth = feed ÷ expected FCR → next day's biomass/average.
 */
import { IQuery } from '@platform/cqrs';

export class GetTankGrowthProjectionQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly input: {
      siteId?: string;
      departmentId?: string;
      horizonDays: number;
      scenarioId?: string;
    },
  ) {}
}
