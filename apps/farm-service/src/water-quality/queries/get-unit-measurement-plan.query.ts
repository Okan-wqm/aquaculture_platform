/**
 * GetUnitMeasurementPlanQuery
 *
 * What to record at a unit (tank or water equipment): its plan, or every active
 * parameter when nobody mapped one — the rule the validator applies too.
 *
 * @module WaterQuality/Queries
 */
import { ITenantQuery } from '@platform/cqrs';

export class GetUnitMeasurementPlanQuery implements ITenantQuery {
  readonly queryName = 'GetUnitMeasurementPlanQuery';

  constructor(
    public readonly tenantId: string,
    public readonly unitId: string,
  ) {}
}
