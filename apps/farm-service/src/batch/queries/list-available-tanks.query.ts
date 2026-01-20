/**
 * ListAvailableTanksQuery
 *
 * Lists available tanks for batch allocation with capacity information.
 * Filters by equipment where isTank=true and status is operational.
 *
 * @module Batch/Queries
 */
import { ITenantQuery } from '@platform/cqrs';

/**
 * Tank information with capacity details
 */
export interface AvailableTank {
  id: string;
  code: string;
  name: string;
  volume: number;           // m³
  maxBiomass: number;       // kg
  currentBiomass: number;   // kg
  availableCapacity: number; // kg (maxBiomass - currentBiomass)
  currentCount: number;     // Current fish count
  maxDensity: number;       // kg/m³
  currentDensity: number;   // kg/m³ (currentBiomass / volume)
  status: string;
  departmentId: string;
  departmentName: string;
  siteId?: string;
  siteName?: string;
}

export class ListAvailableTanksQuery implements ITenantQuery {
  constructor(
    public readonly tenantId: string,
    public readonly siteId?: string,
    public readonly departmentId?: string,
    public readonly excludeFullTanks: boolean = false, // Exclude tanks at capacity
  ) {}
}
