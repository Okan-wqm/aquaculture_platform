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
import { AddEquipmentTemperatureSensorId1802100000000 } from './1802100000000-AddEquipmentTemperatureSensorId';
import { CreateSensorTemperatureLatest1802200000000 } from './1802200000000-CreateSensorTemperatureLatest';
import { AddTankTemperatureSensorId1802300000000 } from './1802300000000-AddTankTemperatureSensorId';
import { AddExecutionGrowthAppliedAt1802400000000 } from './1802400000000-AddExecutionGrowthAppliedAt';
import { AddSpeciesOfficialCode1802500000000 } from './1802500000000-AddSpeciesOfficialCode';
import { AddSiteRegulatoryIdentity1802600000000 } from './1802600000000-AddSiteRegulatoryIdentity';
import { CreateLiceCounts1802700000000 } from './1802700000000-CreateLiceCounts';
import { CreateTreatmentApplications1802800000000 } from './1802800000000-CreateTreatmentApplications';
import { CreateWelfareAssessments1802900000000 } from './1802900000000-CreateWelfareAssessments';
import { CreateEscapeIncidents1803000000000 } from './1803000000000-CreateEscapeIncidents';
import { AddHarvestNorwegianQualityClass1803100000000 } from './1803100000000-AddHarvestNorwegianQualityClass';
import { AddTankRegulatoryUnitId1803200000000 } from './1803200000000-AddTankRegulatoryUnitId';
import { AddBatchInputTypeSmolt1803300000000 } from './1803300000000-AddBatchInputTypeSmolt';
import { AddWorkerVeterinaryFields1803400000000 } from './1803400000000-AddWorkerVeterinaryFields';
import { CreateSlaughterFacilities1803450000000 } from './1803450000000-CreateSlaughterFacilities';
import { CreateSensorTemperatureDaily1803500000000 } from './1803500000000-CreateSensorTemperatureDaily';
import { CreateRegulatoryReportDrafts1803600000000 } from './1803600000000-CreateRegulatoryReportDrafts';
import { AddRegulatoryReportRetryColumns1803700000000 } from './1803700000000-AddRegulatoryReportRetryColumns';
import { AddReportDraftDeadlineNotifiedBucket1803750000000 } from './1803750000000-AddReportDraftDeadlineNotifiedBucket';
import { ExtendBiomassReportStatusAltinnManual1804000000000 } from './1804000000000-ExtendBiomassReportStatusAltinnManual';
import { DropRegulatorySettingsSlaughterApprovalNumber1804100000000 } from './1804100000000-DropRegulatorySettingsSlaughterApprovalNumber';
import { DropSiteLocalityMappingsJsonb1804200000000 } from './1804200000000-DropSiteLocalityMappingsJsonb';
import { DropHarvestQualityGrade1804300000000 } from './1804300000000-DropHarvestQualityGrade';
import { DropOrphanQualityGradeEnum1804400000000 } from './1804400000000-DropOrphanQualityGradeEnum';
// From main: heal-behind-tenant quality grade + finance tables (finance was
// renumbered on main's own merge from 1802500000000 → 1804600000000).
import { HealBehindTenantQualityGrade1804500000000 } from './1804500000000-HealBehindTenantQualityGrade';
import { CreateFinanceTables1804600000000 } from './1804600000000-CreateFinanceTables';
import { AddRegulatoryAuditEnumValues1804700000000 } from './1804700000000-AddRegulatoryAuditEnumValues';
import { AddRegulatoryReportImmutabilityTrigger1804800000000 } from './1804800000000-AddRegulatoryReportImmutabilityTrigger';
import { AddWelfareLiceCheckConstraints1804900000000 } from './1804900000000-AddWelfareLiceCheckConstraints';
// Renumbered from 1804500000000/1804600000000 → 1805000000000/1805100000000 on
// this main merge to resolve a timestamp collision with main's
// HealBehindTenantQualityGrade1804500000000 + CreateFinanceTables1804600000000
// (migrations are append-only + ordered).
import { ApplyRlsToRegulatoryReportDrafts1805000000000 } from './1805000000000-ApplyRlsToRegulatoryReportDrafts';
import { AddTenantErasureRetainedColumns1805100000000 } from './1805100000000-AddTenantErasureRetainedColumns';
import { AddFarmStockBatchSnapshotSpecies1805200000000 } from './1805200000000-AddFarmStockBatchSnapshotSpecies';
import { DropFarmDocuments1805300000000 } from './1805300000000-DropFarmDocuments';
import { DropTankBatchCurrentQuantityMirror1805400000000 } from './1805400000000-DropTankBatchCurrentQuantityMirror';
import { DropFarmWorkerPlaceholderPii1805500000000 } from './1805500000000-DropFarmWorkerPlaceholderPii';
// Renumbered from 1804700000000/1804800000000/1804900000000 →
// 1805300000000/1805400000000/1805500000000 → 1805600000000/1805700000000/1805800000000
// across successive main merges to resolve timestamp collisions: first with
// main's AddRegulatoryAuditEnumValues1804700000000 group, then with main's
// DropFarmDocuments1805300000000 / DropTankBatchCurrentQuantityMirror1805400000000 /
// DropFarmWorkerPlaceholderPii1805500000000. Migrations are append-only + ordered;
// this branch's migrations never merged, so no deployed DB ran the old numbers.
import { AddFinanceEntryDeletedBy1805600000000 } from './1805600000000-AddFinanceEntryDeletedBy';
import { AddWorkOrderEffectiveCostDateIndex1805700000000 } from './1805700000000-AddWorkOrderEffectiveCostDateIndex';
import { FinanceEntrySoftDeletePartialIndexes1805800000000 } from './1805800000000-FinanceEntrySoftDeletePartialIndexes';
import { AddChemicalTherapeuticTypes1805900000000 } from './1805900000000-AddChemicalTherapeuticTypes';
// Renumbered 1805900000000 → 1806000000000 to resolve a timestamp collision with
// AddChemicalTherapeuticTypes1805900000000 landed on main; migrations are append-only + ordered.
import { BackfillFeedInventoryToStorageLedger1806100000000 } from './1806100000000-BackfillFeedInventoryToStorageLedger';
import { CreateFeedingProtocolV2Tables1806200000000 } from './1806200000000-CreateFeedingProtocolV2Tables';
import { MigrateFeedingProgramsToProtocolV21806300000000 } from './1806300000000-MigrateFeedingProgramsToProtocolV2';
import { CreateFeedingDayPlanAndMeals1806400000000 } from './1806400000000-CreateFeedingDayPlanAndMeals';
import { FeedingCutoverActivateAssignments1806500000000 } from './1806500000000-FeedingCutoverActivateAssignments';
import { BackfillExecutionsToFeedingRecords1806600000000 } from './1806600000000-BackfillExecutionsToFeedingRecords';
import { FeedingForecastFoundation1806700000000 } from './1806700000000-FeedingForecastFoundation';
import { CreateIncidentMedia1806000000000 } from './1806000000000-CreateIncidentMedia';
import { WidenRelatedSensorReadingIdToFederationId1806800000000 } from './1806800000000-WidenRelatedSensorReadingIdToFederationId';

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
  AddEquipmentTemperatureSensorId1802100000000,
  CreateSensorTemperatureLatest1802200000000,
  AddTankTemperatureSensorId1802300000000,
  AddExecutionGrowthAppliedAt1802400000000,
  AddSpeciesOfficialCode1802500000000,
  AddSiteRegulatoryIdentity1802600000000,
  CreateLiceCounts1802700000000,
  CreateTreatmentApplications1802800000000,
  CreateWelfareAssessments1802900000000,
  CreateEscapeIncidents1803000000000,
  AddHarvestNorwegianQualityClass1803100000000,
  AddTankRegulatoryUnitId1803200000000,
  AddBatchInputTypeSmolt1803300000000,
  AddWorkerVeterinaryFields1803400000000,
  CreateSlaughterFacilities1803450000000,
  CreateSensorTemperatureDaily1803500000000,
  CreateRegulatoryReportDrafts1803600000000,
  AddRegulatoryReportRetryColumns1803700000000,
  AddReportDraftDeadlineNotifiedBucket1803750000000,
  ExtendBiomassReportStatusAltinnManual1804000000000,
  DropRegulatorySettingsSlaughterApprovalNumber1804100000000,
  DropSiteLocalityMappingsJsonb1804200000000,
  DropHarvestQualityGrade1804300000000,
  DropOrphanQualityGradeEnum1804400000000,
  HealBehindTenantQualityGrade1804500000000,
  CreateFinanceTables1804600000000,
  AddRegulatoryAuditEnumValues1804700000000,
  AddRegulatoryReportImmutabilityTrigger1804800000000,
  AddWelfareLiceCheckConstraints1804900000000,
  ApplyRlsToRegulatoryReportDrafts1805000000000,
  AddTenantErasureRetainedColumns1805100000000,
  AddFarmStockBatchSnapshotSpecies1805200000000,
  DropFarmDocuments1805300000000,
  DropTankBatchCurrentQuantityMirror1805400000000,
  DropFarmWorkerPlaceholderPii1805500000000,
  AddFinanceEntryDeletedBy1805600000000,
  AddWorkOrderEffectiveCostDateIndex1805700000000,
  FinanceEntrySoftDeletePartialIndexes1805800000000,
  AddChemicalTherapeuticTypes1805900000000,
  CreateIncidentMedia1806000000000,
  BackfillFeedInventoryToStorageLedger1806100000000,
  CreateFeedingProtocolV2Tables1806200000000,
  MigrateFeedingProgramsToProtocolV21806300000000,
  CreateFeedingDayPlanAndMeals1806400000000,
  FeedingCutoverActivateAssignments1806500000000,
  BackfillExecutionsToFeedingRecords1806600000000,
  FeedingForecastFoundation1806700000000,
  WidenRelatedSensorReadingIdToFederationId1806800000000,
] as const;
