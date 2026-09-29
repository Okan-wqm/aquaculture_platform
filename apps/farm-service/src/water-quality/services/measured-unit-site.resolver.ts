import { BadRequestException, NotFoundException } from '@nestjs/common';
import { waterQualityMeasuredUnit } from '@platform/event-contracts';
import type { EntityManager } from 'typeorm';

import {
  findTankOrEquipmentWithManager,
  resolveSiteIdFromDepartment,
} from '../../batch/utils/tank-lookup.util';

/** What a water-quality write names about where it was measured. */
export interface MeasuredUnitRef {
  /** The measured equipment — required by the write contract. */
  equipmentId: string;
  /** Optional legacy tank id; when it names another unit, both must share one site. */
  tankId?: string;
  /**
   * DEPRECATED caller assertion. Never a source: when present it must equal
   * the site derived from the unit (AquaMobil's offline queue may still hold
   * payloads that carry it).
   */
  siteId?: string;
}

/**
 * The site of a unit, or null when its department has no site. An unknown
 * unit is a 404: a measurement cannot be recorded against nothing.
 */
async function siteOfUnit(
  manager: EntityManager,
  unitId: string,
  tenantId: string,
): Promise<string | null> {
  const lookup = await findTankOrEquipmentWithManager(manager, unitId, tenantId);
  if (!lookup) {
    throw new NotFoundException(`Measured unit ${unitId} not found`);
  }
  return resolveSiteIdFromDepartment(manager, lookup.equipment.departmentId, tenantId);
}

/**
 * Resolve the site a water-quality measurement belongs to — DERIVED from the
 * measured unit, never chosen by the caller (V-S1a-1 / V-S1b-1).
 *
 * WHY: the caller's `siteId` used to win. A MODULE_USER of site A could record
 * against site B's tank with `siteId = A`: the object-level site check passed
 * on A, the reading was stored under A, and the critical alarm paged A's
 * managers while B's never heard of it.
 *
 * WHAT:
 *   - the unit is picked by the contract's `waterQualityMeasuredUnit` (the same
 *     rule alert-engine keys the incident by, V-S1a-10);
 *   - unknown unit → 404; a `tankId` naming a DIFFERENT unit is resolved too,
 *     and a site mismatch between the two → 400;
 *   - a caller `siteId` is an assertion only: present and different from the
 *     unit's site (or the unit has no site) → 400.
 *
 * INVARIANT: the returned site is the one the caller is authorized on, the one
 * stored on the measurement and the one the alarm names. If violated → a reading
 * can be authorized, stored and paged under a site it does not belong to.
 *
 * `manager` must be the write transaction's manager, so the lookup serializes
 * with the write (a concurrent department re-home cannot slip in between).
 */
export async function resolveMeasuredUnitSite(
  manager: EntityManager,
  ref: MeasuredUnitRef,
  tenantId: string,
): Promise<string | null> {
  const unitId = waterQualityMeasuredUnit(ref);
  if (!unitId) {
    throw new BadRequestException('A water-quality measurement must name its measured unit');
  }
  const unitSite = await siteOfUnit(manager, unitId, tenantId);

  if (ref.tankId && ref.tankId !== unitId) {
    const tankSite = await siteOfUnit(manager, ref.tankId, tenantId);
    if (tankSite !== unitSite) {
      throw new BadRequestException('tankId and equipmentId belong to different sites');
    }
  }

  if (ref.siteId !== undefined && (unitSite === null || ref.siteId !== unitSite)) {
    throw new BadRequestException(
      'siteId does not match the site of the measured unit; the site is derived from the unit',
    );
  }
  return unitSite;
}
