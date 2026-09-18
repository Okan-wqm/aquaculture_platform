/**
 * PURE projections for the equipment farm-AI responder (PR-5, Operations
 * specialist). Covers the unified equipment list and feeder calibrations.
 *
 * Rules of the read-only namespace (see common/nats/ai-query-responder.ts):
 *  - Input = the query handler's return shape; output = wire DTO ONLY.
 *  - NO procurement PII-adjacent fields (serialNumber, purchasePrice,
 *    purchaseDate, warrantyEndDate), NO specifications blobs, NO notes and
 *    NO location.free-text — identity, type and operational state only.
 */
import { Equipment } from '../entities/equipment.entity';
import { FeederCalibration } from '../entities/feeder-calibration.entity';

/** Equipment catalogue row. */
export interface EquipmentDto {
  id: string;
  name: string;
  code: string;
  equipmentTypeId: string;
  equipmentTypeCode: string | null;
  equipmentTypeName: string | null;
  equipmentCategory: string | null;
  manufacturer: string | null;
  model: string | null;
  status: string;
  isTank: boolean;
  volumeM3: number | null;
  currentBiomassKg: number | null;
  departmentId: string | null;
  subEquipmentCount: number;
}

/**
 * Project an equipment row. serialNumber, purchasePrice, specifications,
 * notes and the location block are stripped by construction (never copied).
 */
export function projectEquipment(
  row: Equipment,
): EquipmentDto {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    equipmentTypeId: row.equipmentTypeId,
    equipmentTypeCode: row.equipmentType?.code ?? null,
    equipmentTypeName: row.equipmentType?.name ?? null,
    equipmentCategory: row.equipmentType?.category
      ? String(row.equipmentType.category)
      : null,
    manufacturer: row.manufacturer ?? null,
    model: row.model ?? null,
    status: String(row.status),
    isTank: row.isTank === true,
    volumeM3: row.volume ?? null,
    currentBiomassKg: row.currentBiomass ?? null,
    departmentId: row.departmentId ?? null,
    subEquipmentCount: row.subEquipmentCount ?? 0,
  };
}

/** Feeder calibration row (dispensing math, no free-text notes). */
export interface FeederCalibrationDto {
  id: string;
  feedSizeMm: number;
  feedSizeLabel: string | null;
  gramsPerDispensing: number;
  siloCapacityKg: number;
}

/** Project a feeder-calibration row. */
export function projectFeederCalibration(
  row: Pick<
    FeederCalibration,
    'id' | 'feedSizeMm' | 'feedSizeLabel' | 'gramsPerDispensing' | 'siloCapacityKg'
  >,
): FeederCalibrationDto {
  return {
    id: row.id,
    feedSizeMm: row.feedSizeMm,
    feedSizeLabel: row.feedSizeLabel ?? null,
    gramsPerDispensing: row.gramsPerDispensing,
    siloCapacityKg: row.siloCapacityKg,
  };
}
