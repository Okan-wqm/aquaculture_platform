import { Baseline1800000000000 } from './1800000000000-Baseline';
import { BackfillTenantFarmOperationalTables1800100000000 } from './1800100000000-BackfillTenantFarmOperationalTables';
import { CreateFarmOutboxTable1800200000000 } from './1800200000000-CreateFarmOutboxTable';
import { AlignEquipmentTypesRuntimeContract1800300000000 } from './1800300000000-AlignEquipmentTypesRuntimeContract';

/**
 * Canonical farm-service migration class list.
 *
 * Faz 3 of the day-one baseline reset: pre-reset chain (~45 migrations)
 * archived to .archive/<timestamp>/. A single consolidated baseline now
 * represents the complete farm schema. Forward-only migration discipline
 * resumes from this point.
 */
export const FARM_MIGRATIONS = [
  Baseline1800000000000,
  BackfillTenantFarmOperationalTables1800100000000,
  CreateFarmOutboxTable1800200000000,
  AlignEquipmentTypesRuntimeContract1800300000000,
] as const;
