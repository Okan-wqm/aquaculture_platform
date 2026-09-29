/**
 * Where a work order draws its spare parts from (FARM-HIGH-338, V-B1-9 of the
 * B1a-1 verifier round).
 *
 * WHY: work-order completion used to take every part from the part's HOME
 * location only. A purchase-order receipt or a transfer puts spare parts in
 * other locations, so a completion failed with "No inventory found" while the
 * part lay in the next store of the same site. A work order is performed at a
 * site (plan K8: physical stock is per site), so it draws from that site's
 * live locations and fails only when the SITE holds too little.
 *
 * WHAT:
 *   - `workOrderSiteId` — the site of the work order's asset: a tank's or an
 *     equipment unit's department site. Assets the farm model does not place
 *     (building, vehicle, sensor, other, legacy pond) have none, and the caller
 *     then draws at the part's home site.
 *   - `compileSparePartDraw` — the deterministic draw order over one site's
 *     inventory rows: the home location first, then the other locations by
 *     their oldest received stock (then location id); inside a location FEFO
 *     (expiry, received, lot) — the same order the ledger sink's unpinned
 *     decrement picks, so each slice lands on the row it was planned for.
 *     Arithmetic in integer hundredths.
 *
 * INVARIANT: the draw never crosses into another site; if violated → a
 * completion at site A silently empties site B's store and site B's tier
 * reads a consumption that never happened there.
 */
import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';

import { Department } from '../../department/entities/department.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { stockQuantityFromUnits, stockQuantityUnits } from '../../storage/services/stock-quantity';
import { Tank } from '../../tank/entities/tank.entity';
import { AssetType } from '../entities/work-order.entity';

/** The asset reference of a work order. */
export interface WorkOrderAssetRef {
  id: string;
  assetType?: AssetType | null;
  assetId?: string | null;
}

/** One inventory row of the part at the site (a draw candidate). */
export interface SparePartDrawCandidate {
  storageLocationId: string;
  lotNumber: string | null;
  quantity: number;
  receivedDate: Date | null;
  expiryDate: Date | null;
}

/** One OUT movement of the draw. */
export interface SparePartDrawSlice {
  storageLocationId: string;
  lotNumber?: string;
  quantity: number;
}

/** Asset types that are equipment units (their id is an `equipment` row). */
const EQUIPMENT_ASSETS: ReadonlySet<AssetType> = new Set([
  AssetType.EQUIPMENT,
  AssetType.PUMP,
  AssetType.FEEDER,
  AssetType.AERATOR,
  AssetType.GENERATOR,
]);

/**
 * WHY: the draw must stay inside the site the work is done at; WHAT: the
 * department site of a tank or equipment asset, or null when the asset has no
 * placement in the farm model.
 */
export async function workOrderSiteId(
  manager: EntityManager,
  tenantId: string,
  workOrder: WorkOrderAssetRef,
): Promise<string | null> {
  const { assetType, assetId } = workOrder;
  if (!assetType || !assetId) return null;
  let departmentId: string | null | undefined = null;
  if (assetType === AssetType.TANK) {
    const tank = await tenantManagerRepo(manager, Tank, tenantId).findOne({
      where: { id: assetId, tenantId },
      select: ['id', 'departmentId'],
    });
    departmentId = tank?.departmentId;
  } else if (EQUIPMENT_ASSETS.has(assetType)) {
    const equipment = await tenantManagerRepo(manager, Equipment, tenantId).findOne({
      where: { id: assetId, tenantId },
      select: ['id', 'departmentId'],
    });
    departmentId = equipment?.departmentId;
  }
  if (!departmentId) return null;
  const department = await tenantManagerRepo(manager, Department, tenantId).findOne({
    where: { id: departmentId, tenantId },
    select: ['id', 'siteId'],
  });
  return department?.siteId ?? null;
}

function time(date: Date | null): number {
  return date === null ? Number.POSITIVE_INFINITY : new Date(date).getTime();
}

/** FEFO inside one location: expiry, then arrival, then lot (nulls last). */
function fefo(a: SparePartDrawCandidate, b: SparePartDrawCandidate): number {
  return (
    time(a.expiryDate) - time(b.expiryDate) ||
    time(a.receivedDate) - time(b.receivedDate) ||
    (a.lotNumber ?? '￿').localeCompare(b.lotNumber ?? '￿')
  );
}

/**
 * WHY: one deterministic, site-bounded draw; WHAT: slices covering `quantity`
 * — home location first, then locations by oldest received stock — or a 400
 * naming the site's usable total when the site holds too little.
 */
export function compileSparePartDraw(
  candidates: readonly SparePartDrawCandidate[],
  quantity: number,
  homeLocationId: string | null | undefined,
  partLabel: string,
): SparePartDrawSlice[] {
  const requestedUnits = stockQuantityUnits(quantity, 'Spare-part quantity');
  const byLocation = new Map<string, SparePartDrawCandidate[]>();
  for (const candidate of candidates) {
    const rows = byLocation.get(candidate.storageLocationId);
    if (rows) rows.push(candidate);
    else byLocation.set(candidate.storageLocationId, [candidate]);
  }
  const oldest = (rows: readonly SparePartDrawCandidate[]): number =>
    Math.min(...rows.map((row) => time(row.receivedDate)));
  const locations = [...byLocation.entries()].sort(
    ([idA, rowsA], [idB, rowsB]) =>
      Number(idB === homeLocationId) - Number(idA === homeLocationId) ||
      oldest(rowsA) - oldest(rowsB) ||
      idA.localeCompare(idB),
  );

  const ordered = locations.flatMap(([, rows]) => [...rows].sort(fefo));
  const availableUnits = ordered.reduce(
    (sum, row) => sum + stockQuantityUnits(row.quantity, 'Inventory quantity', { allowZero: true }),
    0,
  );
  if (availableUnits < requestedUnits) {
    throw new BadRequestException(
      `Insufficient stock of spare part ${partLabel} at the work order's site. ` +
        `Available: ${stockQuantityFromUnits(availableUnits)}, requested: ${quantity}`,
    );
  }

  const slices: SparePartDrawSlice[] = [];
  let remainingUnits = requestedUnits;
  for (const row of ordered) {
    if (remainingUnits === 0) break;
    const rowUnits = stockQuantityUnits(row.quantity, 'Inventory quantity', { allowZero: true });
    const takeUnits = Math.min(rowUnits, remainingUnits);
    if (takeUnits === 0) continue;
    slices.push({
      storageLocationId: row.storageLocationId,
      ...(row.lotNumber !== null ? { lotNumber: row.lotNumber } : {}),
      quantity: stockQuantityFromUnits(takeUnits),
    });
    remainingUnits -= takeUnits;
  }
  return slices;
}
