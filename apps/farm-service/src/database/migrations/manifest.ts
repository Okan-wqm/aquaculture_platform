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
import { EncryptFarmWorkerPii1801100000000 } from './1801100000000-EncryptFarmWorkerPii';
import { AddPurchaseOrderApprovalAudit1801200000000 } from './1801200000000-AddPurchaseOrderApprovalAudit';
import { AddCullMortalityAuditEnumValues1801300000000 } from './1801300000000-AddCullMortalityAuditEnumValues';
import { AddSiteContractFields1801400000000 } from './1801400000000-AddSiteContractFields';
import { EnsureFarmTenantErasureProofLedger1801500000000 } from './1801500000000-EnsureFarmTenantErasureProofLedger';
import { DropAuditLedgerSourceWriteGuard1801600000000 } from './1801600000000-DropAuditLedgerSourceWriteGuard';
import { BackfillStaleTankBatchDetails1801700000000 } from './1801700000000-BackfillStaleTankBatchDetails';
import { BackfillTankBatchCurrentQuantityMirror1801800000000 } from './1801800000000-BackfillTankBatchCurrentQuantityMirror';
import { CreateRegulatoryReports1801900000000 } from './1801900000000-CreateRegulatoryReports';
import { AddBatchProtocolId1802000000000 } from './1802000000000-AddBatchProtocolId';

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
  EncryptFarmWorkerPii1801100000000,
  AddPurchaseOrderApprovalAudit1801200000000,
  AddCullMortalityAuditEnumValues1801300000000,
  AddSiteContractFields1801400000000,
  EnsureFarmTenantErasureProofLedger1801500000000,
  DropAuditLedgerSourceWriteGuard1801600000000,
  BackfillStaleTankBatchDetails1801700000000,
  BackfillTankBatchCurrentQuantityMirror1801800000000,
  CreateRegulatoryReports1801900000000,
  AddBatchProtocolId1802000000000,
] as const;
