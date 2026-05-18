import { CreateInitialSchema1700000000000 } from './1700000000000-CreateInitialSchema';
import { AddSystemHierarchy1734336000000 } from './1734336000000-AddSystemHierarchy';
import { AddBatchDocuments1734500000000 } from './1734500000000-AddBatchDocuments';
import { AddRegulatorySettings1769000000000 } from './1769000000000-AddRegulatorySettings';
import { AddSpeciesTags1769100000000 } from './1769100000000-AddSpeciesTags';
import { AddFeedMinFishWeight1770000000000 } from './1770000000000-AddFeedMinFishWeight';
import { AddStorageManagement1771000000000 } from './1771000000000-AddStorageManagement';
import { AddPurchaseOrders1772000000000 } from './1772000000000-AddPurchaseOrders';
import { AddWeatherTables1773000000000 } from './1773000000000-AddWeatherTables';
import { AddFeederCalibrations1774000000000 } from './1774000000000-AddFeederCalibrations';
import { AddFeederFieldsToExecution1775000000000 } from './1775000000000-AddFeederFieldsToExecution';
import { ConvergeTenantIdTypesAndDropPondBatch1775900000000 } from './1775900000000-ConvergeTenantIdTypesAndDropPondBatch';
import { EnableRowLevelSecurity1776000000000 } from './1776000000000-EnableRowLevelSecurity';
import { CreateFarmOutboxTable1780300000000 } from './1780300000000-CreateFarmOutboxTable';
import { RefreshTenantRlsPredicate1781000000000 } from './1781000000000-RefreshTenantRlsPredicate';
import { ConvertFarmOutboxToIdentity1781200000000 } from './1781200000000-ConvertFarmOutboxToIdentity';
import { AddTenantActivePartialIndexes1781800000000 } from './1781800000000-AddTenantActivePartialIndexes';
import { ConvertAuditColumnsToTimestamptz1781900000000 } from './1781900000000-ConvertAuditColumnsToTimestamptz';
import { AddFarmOutboxLeaseColumns1782000000000 } from './1782000000000-AddFarmOutboxLeaseColumns';
import { AddFarmOutboxNotifyTrigger1782100000000 } from './1782100000000-AddFarmOutboxNotifyTrigger';
import { MovePublicTablesToFarm1786000000000 } from './1786000000000-MovePublicTablesToFarm';
import { AddFarmOutboxModernColumns1786200000000 } from './1786200000000-AddFarmOutboxModernColumns';
import { AlignCodeSequencesSchema1786900000000 } from './1786900000000-AlignCodeSequencesSchema';
import { AddDomainRetentionFunctions1787000000000 } from './1787000000000-AddDomainRetentionFunctions';
import { AddStorageInventoryReceivedDate1787100000000 } from './1787100000000-AddStorageInventoryReceivedDate';
import { CreateStorageLotMixes1787150000000 } from './1787150000000-CreateStorageLotMixes';
import { AddStorageLotMixesGinIndex1787200000000 } from './1787200000000-AddStorageLotMixesGinIndex';
import { AddRecurringTemplateTimezone1787300000000 } from './1787300000000-AddRecurringTemplateTimezone';
import { AddDailyBatchFeedingMaterializedView1787400000000 } from './1787400000000-AddDailyBatchFeedingMaterializedView';
import { AddDailyTankWaterQualityMaterializedView1787500000000 } from './1787500000000-AddDailyTankWaterQualityMaterializedView';
import { WireSupplierSitesAndSiteContacts1788100000000 } from './1788100000000-WireSupplierSitesAndSiteContacts';
import { DedupeEquipmentTypesByCode1788200000000 } from './1788200000000-DedupeEquipmentTypesByCode';
import { AddWaterQualitySensorReadingCorrelation1788200000001 } from './1788200000001-AddWaterQualitySensorReadingCorrelation';
import { AddWaterQualitySensorReadingCorrelationIndexes1788210000000 } from './1788210000000-AddWaterQualitySensorReadingCorrelationIndexes';
import { AddBiomassReports1788300000000 } from './1788300000000-AddBiomassReports';
import { AddFarmAuditLogsImmutability1788300000001 } from './1788300000001-AddFarmAuditLogsImmutability';
import { CreateTenantErasureAudit1788500000000 } from './1788500000000-CreateTenantErasureAudit';
import { AlignFarmEntitySurface1789000000000 } from './1789000000000-AlignFarmEntitySurface';
import { AlignFarmEntitySurfaceExt1789100000000 } from './1789100000000-AlignFarmEntitySurfaceExt';
import { AddMissingFarmTables1789200000000 } from './1789200000000-AddMissingFarmTables';
import { AlignFarmReferenceDataContracts1789300000000 } from './1789300000000-AlignFarmReferenceDataContracts';
import { RepairFarmLiveSchemaDrift1789400000000 } from './1789400000000-RepairFarmLiveSchemaDrift';

/**
 * Canonical farm-service migration class list.
 *
 * Production db-migrate still discovers files by glob, but runtime AppModule,
 * TypeORM CLI data-source, E2E, and invariants import this list so a new
 * migration cannot be applied by one path and silently skipped by another.
 */
export const FARM_MIGRATIONS = [
  CreateInitialSchema1700000000000,
  AddSystemHierarchy1734336000000,
  AddBatchDocuments1734500000000,
  AddRegulatorySettings1769000000000,
  AddSpeciesTags1769100000000,
  AddFeedMinFishWeight1770000000000,
  AddStorageManagement1771000000000,
  AddPurchaseOrders1772000000000,
  AddWeatherTables1773000000000,
  AddFeederCalibrations1774000000000,
  AddFeederFieldsToExecution1775000000000,
  ConvergeTenantIdTypesAndDropPondBatch1775900000000,
  EnableRowLevelSecurity1776000000000,
  CreateFarmOutboxTable1780300000000,
  RefreshTenantRlsPredicate1781000000000,
  ConvertFarmOutboxToIdentity1781200000000,
  AddTenantActivePartialIndexes1781800000000,
  ConvertAuditColumnsToTimestamptz1781900000000,
  AddFarmOutboxLeaseColumns1782000000000,
  AddFarmOutboxNotifyTrigger1782100000000,
  MovePublicTablesToFarm1786000000000,
  AddFarmOutboxModernColumns1786200000000,
  AlignCodeSequencesSchema1786900000000,
  AddDomainRetentionFunctions1787000000000,
  AddStorageInventoryReceivedDate1787100000000,
  CreateStorageLotMixes1787150000000,
  AddStorageLotMixesGinIndex1787200000000,
  AddRecurringTemplateTimezone1787300000000,
  AddDailyBatchFeedingMaterializedView1787400000000,
  AddDailyTankWaterQualityMaterializedView1787500000000,
  WireSupplierSitesAndSiteContacts1788100000000,
  DedupeEquipmentTypesByCode1788200000000,
  AddWaterQualitySensorReadingCorrelation1788200000001,
  AddWaterQualitySensorReadingCorrelationIndexes1788210000000,
  AddBiomassReports1788300000000,
  AddFarmAuditLogsImmutability1788300000001,
  CreateTenantErasureAudit1788500000000,
  AlignFarmEntitySurface1789000000000,
  AlignFarmEntitySurfaceExt1789100000000,
  AddMissingFarmTables1789200000000,
  AlignFarmReferenceDataContracts1789300000000,
  RepairFarmLiveSchemaDrift1789400000000,
] as const;
