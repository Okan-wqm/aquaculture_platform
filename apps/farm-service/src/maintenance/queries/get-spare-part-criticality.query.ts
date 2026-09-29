/**
 * Get Spare-Part Criticality Query (FARM-24 — spare-part priority input).
 *
 * WHY: a low-stock spare part is urgent only when the equipment it fits keeps
 * fish alive with nothing to fall back on. The later AutoRule maps this
 * read-only input to a task priority; farm-service owns the computation
 * because every table it reads is farm-owned.
 * WHAT: for ONE spare part at ONE site, the highest
 * `equipment_systems.criticalityLevel` among same-site, compatible-type
 * equipment serving a stocked system without an operational backup. The exact
 * rules live on `GetSparePartCriticalityHandler`.
 */
import { IQuery } from '@platform/cqrs';

export interface SparePartCriticalityResult {
  sparePartId: string;
  siteId: string;
  /** Highest qualifying criticality (1-5); null when nothing qualifies. */
  maxCriticalityLevel: number | null;
  /** Every qualifying equipment id (distinct, sorted), not only the max row's. */
  contributingEquipmentIds: string[];
  /** Every qualifying served-system id (distinct, sorted). */
  contributingSystemIds: string[];
}

export class GetSparePartCriticalityQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly sparePartId: string,
    public readonly siteId: string,
  ) {}
}
