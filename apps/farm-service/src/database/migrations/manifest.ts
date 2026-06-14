import { Baseline1800000000000 } from './1800000000000-Baseline';
import { BackfillTenantFarmOperationalTables1800100000000 } from './1800100000000-BackfillTenantFarmOperationalTables';
import { CreateFarmOutboxTable1800200000000 } from './1800200000000-CreateFarmOutboxTable';
import { AlignEquipmentTypesRuntimeContract1800300000000 } from './1800300000000-AlignEquipmentTypesRuntimeContract';
import { CreateFarmStockReadModel1800400000000 } from './1800400000000-CreateFarmStockReadModel';
import { AssertFarmStockBatchSnapshotMetadata1800500000000 } from './1800500000000-AssertFarmStockBatchSnapshotMetadata';
import { ExtendFarmStockReadModelFanout1800600000000 } from './1800600000000-ExtendFarmStockReadModelFanout';
import { CreateCanonicalOutboxInbox1800700000000 } from './1800700000000-CreateCanonicalOutboxInbox';
import { CreateFarmDocuments1800800000000 } from './1800800000000-CreateFarmDocuments';
import { AddTankSetupMetadata1800900000000 } from './1800900000000-AddTankSetupMetadata';
import { ReEncryptSecretsCbcToGcm1801000000000 } from './1801000000000-ReEncryptSecretsCbcToGcm';

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
  CreateFarmStockReadModel1800400000000,
  AssertFarmStockBatchSnapshotMetadata1800500000000,
  ExtendFarmStockReadModelFanout1800600000000,
  CreateCanonicalOutboxInbox1800700000000,
  CreateFarmDocuments1800800000000,
  AddTankSetupMetadata1800900000000,
  ReEncryptSecretsCbcToGcm1801000000000,
] as const;
