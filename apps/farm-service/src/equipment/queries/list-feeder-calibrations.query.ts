/**
 * List Feeder Calibrations Query
 */
export class ListFeederCalibrationsQuery {
  constructor(
    public readonly equipmentId: string,
    public readonly tenantId: string,
  ) {}
}
