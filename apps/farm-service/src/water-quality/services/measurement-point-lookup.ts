import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { Role, roleHasPermission } from '@aquaculture/backend-common/decorators';
import type {
  SiteAuthorizationService,
  SiteScopeCaller,
} from '@aquaculture/backend-common/security';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import {
  findTankOrEquipmentWithManager,
  resolveUnitSiteIds,
} from '../../batch/utils/tank-lookup.util';
import { Site } from '../../site/entities/site.entity';
import { System } from '../../system/entities/system.entity';

import type { MeasurementPoint } from './parameter-sources';

/** How a missing point is reported: before the write (404) or inside it (409, it vanished). */
export type PointCheck = 'lookup' | 'locked';

/**
 * Proves a measurement point is a live part of the tenant's farm. Inside a
 * write (`locked`) the point row is taken FOR SHARE, so a concurrent delete of
 * the tank or system waits for the bind — and then closes the source it made
 * (plan D8, D12).
 *
 * A tank is `tanks.id` or an equipment row flagged as a tank, the way the
 * measurement-unit classifier files measurements; non-tank water equipment is
 * an equipment point. Naming one as the other is refused, so a source and a
 * measurement of the same unit always name it in the same column.
 */
export async function assertLivePoint(
  manager: EntityManager,
  tenantId: string,
  point: MeasurementPoint,
  check: PointCheck,
): Promise<void> {
  const lock = check === 'locked' ? ({ mode: 'pessimistic_read' } as const) : undefined;
  const gone = (): Error =>
    check === 'locked'
      ? new ConflictException(`The ${point.kind} '${point.id}' was removed; nothing was bound`)
      : new NotFoundException(`No active ${point.kind} '${point.id}' in this tenant`);

  if (point.kind === 'site') {
    const site = await tenantManagerRepo(manager, Site, tenantId).findOne({
      where: { id: point.id, isActive: true, isDeleted: false },
      ...(lock ? { lock } : {}),
    });
    if (site === null) throw gone();
    return;
  }
  if (point.kind === 'system') {
    const system = await tenantManagerRepo(manager, System, tenantId).findOne({
      where: { id: point.id, isActive: true, isDeleted: false },
      ...(lock ? { lock } : {}),
    });
    if (system === null) throw gone();
    return;
  }
  const unit = await findTankOrEquipmentWithManager(manager, point.id, tenantId, lock);
  if (unit === null) throw gone();
  const isTank = unit.isFromTanksTable || unit.equipment.isTank;
  if (isTank !== (point.kind === 'tank')) {
    throw new BadRequestException(
      isTank
        ? `'${point.id}' is a tank: give it as tankId`
        : `'${point.id}' is water equipment, not a tank: give it as equipmentId`,
    );
  }
}

/**
 * The site a point belongs to — a site itself, a system's site, a unit's site
 * through its department — or null when it resolves to none (the site gate
 * treats null as a denial, never as an implicit allow).
 */
export async function siteOfPoint(
  manager: EntityManager,
  tenantId: string,
  point: MeasurementPoint,
): Promise<string | null> {
  if (point.kind === 'site') {
    return point.id;
  }
  if (point.kind === 'system') {
    const system = await tenantManagerRepo(manager, System, tenantId).findOne({
      where: { id: point.id },
      select: { id: true, siteId: true },
    });
    return system?.siteId ?? null;
  }
  const sites = await resolveUnitSiteIds(manager, [point.id], tenantId);
  return sites.get(point.id) ?? null;
}

/**
 * A read of what is at a point (its sources, its values) is live and allowed:
 * the point is a live part of the tenant's farm (else 404), and a caller below
 * MODULE_MANAGER reads only a point at a site assigned to them — the site, a
 * system's site, a unit's site (SEC-HIGH-051 / FARM-MEDIUM-274, as
 * `effectiveUnitTemperatures` does). Every point-scoped read calls this.
 */
export async function assertPointReadable(
  manager: EntityManager,
  siteAuth: SiteAuthorizationService,
  tenantId: string,
  point: MeasurementPoint,
  caller: SiteScopeCaller,
): Promise<void> {
  await assertLivePoint(manager, tenantId, point, 'lookup');
  if (!caller.roles.some((role) => roleHasPermission(role, Role.MODULE_MANAGER))) {
    siteAuth.assertSiteAssignment({
      caller,
      siteId: await siteOfPoint(manager, tenantId, point),
    });
  }
}
