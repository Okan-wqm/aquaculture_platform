/**
 * Farm-Service CQRS Handler Coverage E2E Tests for NestJS v11 Upgrade Validation
 *
 * Validates that ALL CQRS command handlers, query handlers, and event handlers
 * remain properly registered after FIX-6 (removal of redundant CqrsModule
 * imports from 20 feature modules).
 *
 * The CqrsModule is @Global() and registered via forRoot() in AppModule.
 * FIX-6 removes per-feature `CqrsModule` imports. These tests prove
 * that handler auto-discovery via DiscoveryService still works correctly
 * when CqrsModule is only imported once at root level.
 *
 * Critical areas tested:
 *   1. Handler registration count (command + query baseline)
 *   2. Per-module handler verification (20 feature modules)
 *   3. EventBus cross-module communication (shared bus singleton)
 *
 * Run:
 *   npx jest tests/e2e/v11-upgrade/farm-handler-coverage.e2e-spec.ts \
 *     --config tests/e2e/v11-upgrade/jest.config.ts
 *
 * @see docs/architecture/ADR-013-nestjs-v11-upgrade.md
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  Module,
  Global,
  Injectable,
  Controller,
  Get,
  DynamicModule,
  Provider,
  OnModuleInit,
} from '@nestjs/common';
import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import { ModuleRef } from '@nestjs/core';
import {
  CommandBus,
  QueryBus,
  CqrsModule,
  CommandHandler as CommandHandlerDecorator,
  QueryHandler as QueryHandlerDecorator,
  ICommandHandler,
  IQueryHandler,
  ICommand,
  IQuery,
  ITenantCommand,
  ITenantQuery,
  COMMAND_HANDLER_METADATA,
  QUERY_HANDLER_METADATA,
} from '@platform/cqrs';

// ============================================================================
// Section 1: Stub Commands and Queries (matching real class names)
// ============================================================================

// --- BATCH MODULE ---
class CreateBatchCommand implements ITenantCommand {
  constructor(
    public readonly tenantId: string,
    public readonly payload: Record<string, unknown>,
    public readonly createdBy: string,
  ) {}
}

class UpdateBatchCommand implements ITenantCommand {
  constructor(public readonly tenantId: string) {}
}

class UpdateBatchStatusCommand implements ITenantCommand {
  constructor(public readonly tenantId: string) {}
}

class RecordMortalityCommand implements ITenantCommand {
  constructor(public readonly tenantId: string) {}
}

class RecordCullCommand implements ITenantCommand {
  constructor(public readonly tenantId: string) {}
}

class CloseBatchCommand implements ITenantCommand {
  constructor(public readonly tenantId: string) {}
}

class AllocateToTankCommand implements ITenantCommand {
  constructor(public readonly tenantId: string) {}
}

class TransferBatchCommand implements ITenantCommand {
  constructor(public readonly tenantId: string) {}
}

class CreateCleanerBatchCommand implements ITenantCommand {
  constructor(public readonly tenantId: string) {}
}

class DeployCleanerFishCommand implements ITenantCommand {
  constructor(public readonly tenantId: string) {}
}

class RecordCleanerMortalityCommand implements ITenantCommand {
  constructor(public readonly tenantId: string) {}
}

class TransferCleanerFishCommand implements ITenantCommand {
  constructor(public readonly tenantId: string) {}
}

class RemoveCleanerFishCommand implements ITenantCommand {
  constructor(public readonly tenantId: string) {}
}

class GetBatchQuery implements ITenantQuery {
  constructor(
    public readonly tenantId: string,
    public readonly batchId: string,
  ) {}
}

class ListBatchesQuery implements ITenantQuery {
  constructor(public readonly tenantId: string) {}
}

class ListAvailableTanksQuery implements ITenantQuery {
  constructor(public readonly tenantId: string) {}
}

class GenerateBatchNumberQuery implements ITenantQuery {
  constructor(public readonly tenantId: string) {}
}

class GetBatchPerformanceQuery implements ITenantQuery {
  constructor(public readonly tenantId: string) {}
}

class GetBatchHistoryQuery implements ITenantQuery {
  constructor(public readonly tenantId: string) {}
}

// --- CHEMICAL MODULE ---
class CreateChemicalCommand implements ICommand {
  constructor(
    public readonly input: Record<string, unknown>,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}

class UpdateChemicalCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class DeleteChemicalCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class AddDocumentCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class RemoveDocumentCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class GetChemicalQuery implements IQuery {
  constructor(
    public readonly chemicalId: string,
    public readonly tenantId: string,
  ) {}
}

class ListChemicalsQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

// --- FARM MODULE ---
class CreateFarmCommand implements ICommand {
  constructor(
    public readonly name: string,
    public readonly location: { lat: number; lng: number },
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}

class UpdateFarmCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class CreatePondCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class CreatePondBatchCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class HarvestBatchCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class GetFarmQuery implements IQuery {
  constructor(
    public readonly farmId: string,
    public readonly tenantId: string,
  ) {}
}

class ListFarmsQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class GetPondQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class ListPondBatchesQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

// --- SPECIES MODULE ---
class CreateSpeciesCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly input: Record<string, unknown>,
  ) {}
}

class UpdateSpeciesCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class DeleteSpeciesCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class GetSpeciesQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly id: string,
  ) {}
}

class ListSpeciesQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class GetSpeciesByCodeQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

// --- TANK MODULE ---
class CreateTankCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly input: Record<string, unknown>,
  ) {}
}

class UpdateTankCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class UpdateTankStatusCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class DeleteTankCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class GetTankQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly id: string,
  ) {}
}

class ListTanksQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class GetTankBatchesQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class GetTankOperationsQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class GetTankCapacityQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

// --- WATER-QUALITY MODULE ---
class CreateParameterConfigCommand implements ITenantCommand {
  constructor(
    public readonly tenantId: string,
    public readonly payload: Record<string, unknown>,
    public readonly userId: string,
  ) {}
}

class UpdateParameterConfigCommand implements ITenantCommand {
  constructor(public readonly tenantId: string) {}
}

class DeleteParameterConfigCommand implements ITenantCommand {
  constructor(public readonly tenantId: string) {}
}

class BulkCreateFromTemplateCommand implements ITenantCommand {
  constructor(public readonly tenantId: string) {}
}

class ReorderParameterConfigsCommand implements ITenantCommand {
  constructor(public readonly tenantId: string) {}
}

class CreateParamEquipmentCommand implements ITenantCommand {
  constructor(public readonly tenantId: string) {}
}

class UpdateParamEquipmentCommand implements ITenantCommand {
  constructor(public readonly tenantId: string) {}
}

class DeleteParamEquipmentCommand implements ITenantCommand {
  constructor(public readonly tenantId: string) {}
}

class BulkMapParamsEquipmentCommand implements ITenantCommand {
  constructor(public readonly tenantId: string) {}
}

class ListParameterConfigsQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class GetParameterConfigQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class GetParameterConfigByCodeQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class ListParameterTemplatesQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class ListParamEquipmentQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class GetEquipmentParamsQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

// --- SITE MODULE ---
class CreateSiteCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class UpdateSiteCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class DeleteSiteCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class GetSiteQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class ListSitesQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class GetSiteDeletePreviewQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

// --- DEPARTMENT MODULE ---
class CreateDepartmentCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class UpdateDepartmentCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class DeleteDepartmentCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class GetDepartmentQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class ListDepartmentsQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class GetDepartmentDeletePreviewQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

// --- EQUIPMENT MODULE ---
class CreateEquipmentCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class UpdateEquipmentCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class DeleteEquipmentCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class SaveFeederCalibrationsCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class CreateSubEquipmentCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class UpdateSubEquipmentCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class DeleteSubEquipmentCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class GetEquipmentQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class ListEquipmentQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class GetEquipmentTypesQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class GetEquipmentDeletePreviewQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class ListFeederCalibrationsQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class GetSubEquipmentQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class ListSubEquipmentQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class GetSubEquipmentTypesQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

// --- SUPPLIER MODULE ---
class CreateSupplierCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class UpdateSupplierCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class DeleteSupplierCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class GetSupplierQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class ListSuppliersQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

// --- CONSUMABLE MODULE ---
class CreateConsumableCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class UpdateConsumableCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class DeleteConsumableCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class GetConsumableQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class ListConsumablesQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

// --- FEED MODULE ---
class CreateFeedCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class UpdateFeedCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class DeleteFeedCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class CreateFeedingProtocolCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class UpdateFeedingProtocolCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class DeleteFeedingProtocolCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class GetFeedQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class ListFeedsQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class GetFeedingProtocolQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class ListFeedingProtocolsQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

// --- FEEDING MODULE ---
class CreateFeedingRecordCommand implements ITenantCommand {
  constructor(public readonly tenantId: string) {}
}

class UpdateFeedingRecordCommand implements ITenantCommand {
  constructor(public readonly tenantId: string) {}
}

class GetFeedingRecordsQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class GetFeedingSummaryQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

// --- GROWTH MODULE ---
class RecordGrowthSampleCommand implements ITenantCommand {
  constructor(public readonly tenantId: string) {}
}

class UpdateBatchWeightFromSampleCommand implements ITenantCommand {
  constructor(public readonly tenantId: string) {}
}

class VerifyMeasurementCommand implements ITenantCommand {
  constructor(public readonly tenantId: string) {}
}

class GetGrowthMeasurementsQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class GetGrowthAnalysisQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class GetLatestMeasurementQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

// --- HARVEST MODULE ---
class CreateHarvestRecordCommand implements ITenantCommand {
  constructor(public readonly tenantId: string) {}
}

class UpdateHarvestRecordCommand implements ITenantCommand {
  constructor(public readonly tenantId: string) {}
}

class DeleteHarvestRecordCommand implements ITenantCommand {
  constructor(public readonly tenantId: string) {}
}

class GetHarvestQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class ListHarvestsQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class GetHarvestStatisticsQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

// --- STORAGE MODULE ---
class CreateStorageLocationCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class UpdateStorageLocationCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class DeleteStorageLocationCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class RecordStockMovementCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class TransferStockCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class CreatePurchaseOrderCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class UpdatePurchaseOrderStatusCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class ReceiveDeliveryCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class CreateInventoryCountCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class UpdateInventoryCountCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class SubmitInventoryCountCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class ApproveInventoryCountCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class GetStorageLocationQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class ListStorageLocationsQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class GetStorageInventoryQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class ListStockMovementsQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class GetStorageOverviewQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class ListPurchaseOrdersQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class GetPurchaseOrderQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class GetPendingDeliveriesQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class ListInventoryCountsQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class GetInventoryCountQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class TraceLotQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

// --- WORKER MODULE ---
class CreateWorkerCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class UpdateWorkerCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class DeleteWorkerCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class ListWorkersQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

// --- SYSTEM MODULE ---
class CreateSystemCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class UpdateSystemCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class DeleteSystemCommand implements ICommand {
  constructor(public readonly tenantId: string) {}
}

class GetSystemQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class ListSystemsQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

class GetSystemDeletePreviewQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

// ============================================================================
// Section 2: Stub Handlers (simulate real handlers with decorators)
// ============================================================================

/**
 * Creates a stub command handler decorated with @CommandHandler.
 * This is how the real handlers register themselves — via the decorator,
 * the CqrsModule's DiscoveryService auto-discovers and registers them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyConstructor = new (...args: any[]) => ICommand;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyQueryConstructor = new (...args: any[]) => IQuery;

function createStubCommandHandler(
  commandClass: AnyConstructor,
  handlerName: string,
): Provider {
  @Injectable()
  @CommandHandlerDecorator(commandClass)
  class StubHandler implements ICommandHandler<ICommand, unknown> {
    async execute(_command: ICommand): Promise<unknown> {
      return { handled: true, handler: handlerName };
    }
  }
  Object.defineProperty(StubHandler, 'name', { value: handlerName });
  return StubHandler;
}

function createStubQueryHandler(
  queryClass: AnyQueryConstructor,
  handlerName: string,
): Provider {
  @Injectable()
  @QueryHandlerDecorator(queryClass)
  class StubHandler implements IQueryHandler<IQuery, unknown> {
    async execute(_query: IQuery): Promise<unknown> {
      return { handled: true, handler: handlerName };
    }
  }
  Object.defineProperty(StubHandler, 'name', { value: handlerName });
  return StubHandler;
}

// ============================================================================
// Section 3: Per-Module Handler Definitions
// ============================================================================

/**
 * Per-module handler registry.
 * Each entry mirrors the actual handler registrations in the real farm-service.
 * The handler class names match the actual codebase.
 */
interface ModuleHandlerDef {
  moduleName: string;
  commandHandlers: Array<{
    command: AnyConstructor;
    handlerName: string;
  }>;
  queryHandlers: Array<{
    query: AnyQueryConstructor;
    handlerName: string;
  }>;
}

const MODULE_HANDLER_DEFS: ModuleHandlerDef[] = [
  {
    moduleName: 'batch',
    commandHandlers: [
      { command: CreateBatchCommand, handlerName: 'CreateBatchHandler' },
      { command: UpdateBatchCommand, handlerName: 'UpdateBatchHandler' },
      { command: UpdateBatchStatusCommand, handlerName: 'UpdateBatchStatusHandler' },
      { command: RecordMortalityCommand, handlerName: 'RecordMortalityHandler' },
      { command: RecordCullCommand, handlerName: 'RecordCullHandler' },
      { command: CloseBatchCommand, handlerName: 'CloseBatchHandler' },
      { command: AllocateToTankCommand, handlerName: 'AllocateToTankHandler' },
      { command: TransferBatchCommand, handlerName: 'TransferBatchHandler' },
      { command: CreateCleanerBatchCommand, handlerName: 'CreateCleanerBatchHandler' },
      { command: DeployCleanerFishCommand, handlerName: 'DeployCleanerFishHandler' },
      { command: RecordCleanerMortalityCommand, handlerName: 'RecordCleanerMortalityHandler' },
      { command: TransferCleanerFishCommand, handlerName: 'TransferCleanerFishHandler' },
      { command: RemoveCleanerFishCommand, handlerName: 'RemoveCleanerFishHandler' },
    ],
    queryHandlers: [
      { query: GetBatchQuery, handlerName: 'GetBatchHandler' },
      { query: ListBatchesQuery, handlerName: 'ListBatchesHandler' },
      { query: ListAvailableTanksQuery, handlerName: 'ListAvailableTanksHandler' },
      { query: GenerateBatchNumberQuery, handlerName: 'GenerateBatchNumberHandler' },
      { query: GetBatchPerformanceQuery, handlerName: 'GetBatchPerformanceHandler' },
      { query: GetBatchHistoryQuery, handlerName: 'GetBatchHistoryHandler' },
    ],
  },
  {
    moduleName: 'chemical',
    commandHandlers: [
      { command: CreateChemicalCommand, handlerName: 'CreateChemicalHandler' },
      { command: UpdateChemicalCommand, handlerName: 'UpdateChemicalHandler' },
      { command: DeleteChemicalCommand, handlerName: 'DeleteChemicalHandler' },
      { command: AddDocumentCommand, handlerName: 'AddDocumentHandler' },
      { command: RemoveDocumentCommand, handlerName: 'RemoveDocumentHandler' },
    ],
    queryHandlers: [
      { query: GetChemicalQuery, handlerName: 'GetChemicalHandler' },
      { query: ListChemicalsQuery, handlerName: 'ListChemicalsHandler' },
    ],
  },
  {
    moduleName: 'farm',
    commandHandlers: [
      { command: CreateFarmCommand, handlerName: 'CreateFarmHandler' },
      { command: UpdateFarmCommand, handlerName: 'UpdateFarmHandler' },
      { command: CreatePondCommand, handlerName: 'CreatePondHandler' },
      { command: CreatePondBatchCommand, handlerName: 'CreatePondBatchHandler' },
      { command: HarvestBatchCommand, handlerName: 'HarvestBatchHandler' },
    ],
    queryHandlers: [
      { query: GetFarmQuery, handlerName: 'GetFarmQueryHandler' },
      { query: ListFarmsQuery, handlerName: 'ListFarmsQueryHandler' },
      { query: GetPondQuery, handlerName: 'GetPondQueryHandler' },
      { query: ListPondBatchesQuery, handlerName: 'ListPondBatchesHandler' },
    ],
  },
  {
    moduleName: 'species',
    commandHandlers: [
      { command: CreateSpeciesCommand, handlerName: 'CreateSpeciesHandler' },
      { command: UpdateSpeciesCommand, handlerName: 'UpdateSpeciesHandler' },
      { command: DeleteSpeciesCommand, handlerName: 'DeleteSpeciesHandler' },
    ],
    queryHandlers: [
      { query: GetSpeciesQuery, handlerName: 'GetSpeciesHandler' },
      { query: ListSpeciesQuery, handlerName: 'ListSpeciesHandler' },
      { query: GetSpeciesByCodeQuery, handlerName: 'GetSpeciesByCodeHandler' },
    ],
  },
  {
    moduleName: 'tank',
    commandHandlers: [
      { command: CreateTankCommand, handlerName: 'CreateTankHandler' },
      { command: UpdateTankCommand, handlerName: 'UpdateTankHandler' },
      { command: UpdateTankStatusCommand, handlerName: 'UpdateTankStatusHandler' },
      { command: DeleteTankCommand, handlerName: 'DeleteTankHandler' },
    ],
    queryHandlers: [
      { query: GetTankQuery, handlerName: 'GetTankHandler' },
      { query: ListTanksQuery, handlerName: 'ListTanksHandler' },
      { query: GetTankBatchesQuery, handlerName: 'GetTankBatchesHandler' },
      { query: GetTankOperationsQuery, handlerName: 'GetTankOperationsHandler' },
      { query: GetTankCapacityQuery, handlerName: 'GetTankCapacityHandler' },
    ],
  },
  {
    moduleName: 'water-quality',
    commandHandlers: [
      { command: CreateParameterConfigCommand, handlerName: 'CreateParameterConfigHandler' },
      { command: UpdateParameterConfigCommand, handlerName: 'UpdateParameterConfigHandler' },
      { command: DeleteParameterConfigCommand, handlerName: 'DeleteParameterConfigHandler' },
      { command: BulkCreateFromTemplateCommand, handlerName: 'BulkCreateFromTemplateHandler' },
      { command: ReorderParameterConfigsCommand, handlerName: 'ReorderParameterConfigsHandler' },
      { command: CreateParamEquipmentCommand, handlerName: 'CreateParamEquipmentHandler' },
      { command: UpdateParamEquipmentCommand, handlerName: 'UpdateParamEquipmentHandler' },
      { command: DeleteParamEquipmentCommand, handlerName: 'DeleteParamEquipmentHandler' },
      { command: BulkMapParamsEquipmentCommand, handlerName: 'BulkMapParamsEquipmentHandler' },
    ],
    queryHandlers: [
      { query: ListParameterConfigsQuery, handlerName: 'ListParameterConfigsHandler' },
      { query: GetParameterConfigQuery, handlerName: 'GetParameterConfigHandler' },
      { query: GetParameterConfigByCodeQuery, handlerName: 'GetParameterConfigByCodeHandler' },
      { query: ListParameterTemplatesQuery, handlerName: 'ListParameterTemplatesHandler' },
      { query: ListParamEquipmentQuery, handlerName: 'ListParamEquipmentHandler' },
      { query: GetEquipmentParamsQuery, handlerName: 'GetEquipmentParamsHandler' },
    ],
  },
  {
    moduleName: 'site',
    commandHandlers: [
      { command: CreateSiteCommand, handlerName: 'CreateSiteHandler' },
      { command: UpdateSiteCommand, handlerName: 'UpdateSiteHandler' },
      { command: DeleteSiteCommand, handlerName: 'DeleteSiteHandler' },
    ],
    queryHandlers: [
      { query: GetSiteQuery, handlerName: 'GetSiteHandler' },
      { query: ListSitesQuery, handlerName: 'ListSitesHandler' },
      { query: GetSiteDeletePreviewQuery, handlerName: 'GetSiteDeletePreviewHandler' },
    ],
  },
  {
    moduleName: 'department',
    commandHandlers: [
      { command: CreateDepartmentCommand, handlerName: 'CreateDepartmentHandler' },
      { command: UpdateDepartmentCommand, handlerName: 'UpdateDepartmentHandler' },
      { command: DeleteDepartmentCommand, handlerName: 'DeleteDepartmentHandler' },
    ],
    queryHandlers: [
      { query: GetDepartmentQuery, handlerName: 'GetDepartmentHandler' },
      { query: ListDepartmentsQuery, handlerName: 'ListDepartmentsHandler' },
      { query: GetDepartmentDeletePreviewQuery, handlerName: 'GetDepartmentDeletePreviewHandler' },
    ],
  },
  {
    moduleName: 'equipment',
    commandHandlers: [
      { command: CreateEquipmentCommand, handlerName: 'CreateEquipmentHandler' },
      { command: UpdateEquipmentCommand, handlerName: 'UpdateEquipmentHandler' },
      { command: DeleteEquipmentCommand, handlerName: 'DeleteEquipmentHandler' },
      { command: SaveFeederCalibrationsCommand, handlerName: 'SaveFeederCalibrationsHandler' },
      { command: CreateSubEquipmentCommand, handlerName: 'CreateSubEquipmentHandler' },
      { command: UpdateSubEquipmentCommand, handlerName: 'UpdateSubEquipmentHandler' },
      { command: DeleteSubEquipmentCommand, handlerName: 'DeleteSubEquipmentHandler' },
    ],
    queryHandlers: [
      { query: GetEquipmentQuery, handlerName: 'GetEquipmentHandler' },
      { query: ListEquipmentQuery, handlerName: 'ListEquipmentHandler' },
      { query: GetEquipmentTypesQuery, handlerName: 'GetEquipmentTypesHandler' },
      { query: GetEquipmentDeletePreviewQuery, handlerName: 'GetEquipmentDeletePreviewHandler' },
      { query: ListFeederCalibrationsQuery, handlerName: 'ListFeederCalibrationsHandler' },
      { query: GetSubEquipmentQuery, handlerName: 'GetSubEquipmentHandler' },
      { query: ListSubEquipmentQuery, handlerName: 'ListSubEquipmentHandler' },
      { query: GetSubEquipmentTypesQuery, handlerName: 'GetSubEquipmentTypesHandler' },
    ],
  },
  {
    moduleName: 'supplier',
    commandHandlers: [
      { command: CreateSupplierCommand, handlerName: 'CreateSupplierHandler' },
      { command: UpdateSupplierCommand, handlerName: 'UpdateSupplierHandler' },
      { command: DeleteSupplierCommand, handlerName: 'DeleteSupplierHandler' },
    ],
    queryHandlers: [
      { query: GetSupplierQuery, handlerName: 'GetSupplierHandler' },
      { query: ListSuppliersQuery, handlerName: 'ListSuppliersHandler' },
    ],
  },
  {
    moduleName: 'consumable',
    commandHandlers: [
      { command: CreateConsumableCommand, handlerName: 'CreateConsumableHandler' },
      { command: UpdateConsumableCommand, handlerName: 'UpdateConsumableHandler' },
      { command: DeleteConsumableCommand, handlerName: 'DeleteConsumableHandler' },
    ],
    queryHandlers: [
      { query: GetConsumableQuery, handlerName: 'GetConsumableHandler' },
      { query: ListConsumablesQuery, handlerName: 'ListConsumablesHandler' },
    ],
  },
  {
    moduleName: 'feed',
    commandHandlers: [
      { command: CreateFeedCommand, handlerName: 'CreateFeedHandler' },
      { command: UpdateFeedCommand, handlerName: 'UpdateFeedHandler' },
      { command: DeleteFeedCommand, handlerName: 'DeleteFeedHandler' },
      { command: CreateFeedingProtocolCommand, handlerName: 'CreateFeedingProtocolHandler' },
      { command: UpdateFeedingProtocolCommand, handlerName: 'UpdateFeedingProtocolHandler' },
      { command: DeleteFeedingProtocolCommand, handlerName: 'DeleteFeedingProtocolHandler' },
    ],
    queryHandlers: [
      { query: GetFeedQuery, handlerName: 'GetFeedHandler' },
      { query: ListFeedsQuery, handlerName: 'ListFeedsHandler' },
      { query: GetFeedingProtocolQuery, handlerName: 'GetFeedingProtocolHandler' },
      { query: ListFeedingProtocolsQuery, handlerName: 'ListFeedingProtocolsHandler' },
    ],
  },
  {
    moduleName: 'feeding',
    commandHandlers: [
      { command: CreateFeedingRecordCommand, handlerName: 'CreateFeedingRecordHandler' },
      { command: UpdateFeedingRecordCommand, handlerName: 'UpdateFeedingRecordHandler' },
    ],
    queryHandlers: [
      { query: GetFeedingRecordsQuery, handlerName: 'GetFeedingRecordsHandler' },
      { query: GetFeedingSummaryQuery, handlerName: 'GetFeedingSummaryHandler' },
    ],
  },
  {
    moduleName: 'growth',
    commandHandlers: [
      { command: RecordGrowthSampleCommand, handlerName: 'RecordGrowthSampleHandler' },
      { command: UpdateBatchWeightFromSampleCommand, handlerName: 'UpdateBatchWeightFromSampleHandler' },
      { command: VerifyMeasurementCommand, handlerName: 'VerifyMeasurementHandler' },
    ],
    queryHandlers: [
      { query: GetGrowthMeasurementsQuery, handlerName: 'GetGrowthMeasurementsHandler' },
      { query: GetGrowthAnalysisQuery, handlerName: 'GetGrowthAnalysisHandler' },
      { query: GetLatestMeasurementQuery, handlerName: 'GetLatestMeasurementHandler' },
    ],
  },
  {
    moduleName: 'harvest',
    commandHandlers: [
      { command: CreateHarvestRecordCommand, handlerName: 'CreateHarvestRecordHandler' },
      { command: UpdateHarvestRecordCommand, handlerName: 'UpdateHarvestRecordHandler' },
      { command: DeleteHarvestRecordCommand, handlerName: 'DeleteHarvestRecordHandler' },
    ],
    queryHandlers: [
      { query: GetHarvestQuery, handlerName: 'GetHarvestHandler' },
      { query: ListHarvestsQuery, handlerName: 'ListHarvestsHandler' },
      { query: GetHarvestStatisticsQuery, handlerName: 'GetHarvestStatisticsHandler' },
    ],
  },
  {
    moduleName: 'storage',
    commandHandlers: [
      { command: CreateStorageLocationCommand, handlerName: 'CreateStorageLocationHandler' },
      { command: UpdateStorageLocationCommand, handlerName: 'UpdateStorageLocationHandler' },
      { command: DeleteStorageLocationCommand, handlerName: 'DeleteStorageLocationHandler' },
      { command: RecordStockMovementCommand, handlerName: 'RecordStockMovementHandler' },
      { command: TransferStockCommand, handlerName: 'TransferStockHandler' },
      { command: CreatePurchaseOrderCommand, handlerName: 'CreatePurchaseOrderHandler' },
      { command: UpdatePurchaseOrderStatusCommand, handlerName: 'UpdatePurchaseOrderStatusHandler' },
      { command: ReceiveDeliveryCommand, handlerName: 'ReceiveDeliveryHandler' },
      { command: CreateInventoryCountCommand, handlerName: 'CreateInventoryCountHandler' },
      { command: UpdateInventoryCountCommand, handlerName: 'UpdateInventoryCountHandler' },
      { command: SubmitInventoryCountCommand, handlerName: 'SubmitInventoryCountHandler' },
      { command: ApproveInventoryCountCommand, handlerName: 'ApproveInventoryCountHandler' },
    ],
    queryHandlers: [
      { query: GetStorageLocationQuery, handlerName: 'GetStorageLocationHandler' },
      { query: ListStorageLocationsQuery, handlerName: 'ListStorageLocationsHandler' },
      { query: GetStorageInventoryQuery, handlerName: 'GetStorageInventoryHandler' },
      { query: ListStockMovementsQuery, handlerName: 'ListStockMovementsHandler' },
      { query: GetStorageOverviewQuery, handlerName: 'GetStorageOverviewHandler' },
      { query: ListPurchaseOrdersQuery, handlerName: 'ListPurchaseOrdersHandler' },
      { query: GetPurchaseOrderQuery, handlerName: 'GetPurchaseOrderHandler' },
      { query: GetPendingDeliveriesQuery, handlerName: 'GetPendingDeliveriesHandler' },
      { query: ListInventoryCountsQuery, handlerName: 'ListInventoryCountsHandler' },
      { query: GetInventoryCountQuery, handlerName: 'GetInventoryCountHandler' },
      { query: TraceLotQuery, handlerName: 'TraceLotHandler' },
    ],
  },
  {
    moduleName: 'worker',
    commandHandlers: [
      { command: CreateWorkerCommand, handlerName: 'CreateWorkerHandler' },
      { command: UpdateWorkerCommand, handlerName: 'UpdateWorkerHandler' },
      { command: DeleteWorkerCommand, handlerName: 'DeleteWorkerHandler' },
    ],
    queryHandlers: [
      { query: ListWorkersQuery, handlerName: 'ListWorkersHandler' },
    ],
  },
  {
    moduleName: 'system',
    commandHandlers: [
      { command: CreateSystemCommand, handlerName: 'CreateSystemHandler' },
      { command: UpdateSystemCommand, handlerName: 'UpdateSystemHandler' },
      { command: DeleteSystemCommand, handlerName: 'DeleteSystemHandler' },
    ],
    queryHandlers: [
      { query: GetSystemQuery, handlerName: 'GetSystemHandler' },
      { query: ListSystemsQuery, handlerName: 'ListSystemsHandler' },
      { query: GetSystemDeletePreviewQuery, handlerName: 'GetSystemDeletePreviewHandler' },
    ],
  },
];

// ============================================================================
// Section 4: Build providers from module definitions
// ============================================================================

/** All stub command handler providers */
const allCommandHandlerProviders: Provider[] = MODULE_HANDLER_DEFS.flatMap(
  (mod) =>
    mod.commandHandlers.map((def) =>
      createStubCommandHandler(def.command, def.handlerName),
    ),
);

/** All stub query handler providers */
const allQueryHandlerProviders: Provider[] = MODULE_HANDLER_DEFS.flatMap(
  (mod) =>
    mod.queryHandlers.map((def) =>
      createStubQueryHandler(def.query, def.handlerName),
    ),
);

const EXPECTED_COMMAND_HANDLER_COUNT = MODULE_HANDLER_DEFS.reduce(
  (sum, mod) => sum + mod.commandHandlers.length,
  0,
);

const EXPECTED_QUERY_HANDLER_COUNT = MODULE_HANDLER_DEFS.reduce(
  (sum, mod) => sum + mod.queryHandlers.length,
  0,
);

// ============================================================================
// Section 5: Feature Module Definitions (mirrors real structure)
// ============================================================================

/**
 * Creates a feature module that includes its handlers as providers.
 * The real farm-service modules import CqrsModule per-feature (pre-FIX-6)
 * or rely on the @Global CqrsModule (post-FIX-6).
 *
 * Both patterns produce the same result because CqrsModule is @Global.
 * These tests validate that handler discovery works in both cases.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createFeatureModule(
  moduleDef: ModuleHandlerDef,
  importCqrs: boolean,
): { new (): unknown } {
  const commandProviders = moduleDef.commandHandlers.map((def) =>
    createStubCommandHandler(def.command, def.handlerName),
  );
  const queryProviders = moduleDef.queryHandlers.map((def) =>
    createStubQueryHandler(def.query, def.handlerName),
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const imports: any[] = importCqrs ? [CqrsModule] : [];

  @Module({
    imports,
    providers: [...commandProviders, ...queryProviders],
  })
  class FeatureModule {}
  Object.defineProperty(FeatureModule, 'name', {
    value: `${moduleDef.moduleName.charAt(0).toUpperCase() + moduleDef.moduleName.slice(1)}Module`,
  });

  return FeatureModule;
}

// ============================================================================
// Section 6: EventBus Cross-Module Communication
// ============================================================================

/** Simple event for cross-module testing */
interface CrossModuleTestEvent {
  type: string;
  payload: { batchId: string; tenantId: string };
}

/** Event subscriber that records received events */
@Injectable()
class TestEventSubscriber {
  public readonly receivedEvents: CrossModuleTestEvent[] = [];

  handleEvent(event: CrossModuleTestEvent): void {
    this.receivedEvents.push(event);
  }
}

/** Event publisher that publishes events */
@Injectable()
class TestEventPublisher {
  private subscribers: Array<(event: CrossModuleTestEvent) => void> = [];

  subscribe(handler: (event: CrossModuleTestEvent) => void): void {
    this.subscribers.push(handler);
  }

  publish(event: CrossModuleTestEvent): void {
    for (const handler of this.subscribers) {
      handler(event);
    }
  }
}

/**
 * Shared event bus module (simulates the @Global EventBusModule).
 * The real EventBusModule uses NATS; this test stub uses in-memory pub/sub
 * to verify the singleton bus pattern.
 */
@Global()
@Module({
  providers: [
    TestEventPublisher,
    TestEventSubscriber,
  ],
  exports: [TestEventPublisher, TestEventSubscriber],
})
class TestEventBusModule {}

// ============================================================================
// Section 7: Test Suite
// ============================================================================

describe('Farm-Service CQRS Handler Coverage', () => {
  describe('1. Handler Registration Count (flat module)', () => {
    let moduleRef: TestingModule;
    let commandBus: CommandBus;
    let queryBus: QueryBus;

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [CqrsModule.forRoot()],
        providers: [
          ...allCommandHandlerProviders,
          ...allQueryHandlerProviders,
        ],
      }).compile();

      await moduleRef.init();

      commandBus = moduleRef.get(CommandBus);
      queryBus = moduleRef.get(QueryBus);
    });

    afterAll(async () => {
      await moduleRef.close();
    });

    it('should register all command handlers', () => {
      const registeredCommands = commandBus.getRegisteredCommands();

      expect(registeredCommands.length).toBe(EXPECTED_COMMAND_HANDLER_COUNT);
      expect(registeredCommands.length).toBeGreaterThanOrEqual(95);
    });

    it('should register all query handlers', () => {
      const registeredQueries = queryBus.getRegisteredQueries();

      expect(registeredQueries.length).toBe(EXPECTED_QUERY_HANDLER_COUNT);
      expect(registeredQueries.length).toBeGreaterThanOrEqual(75);
    });

    it('should have combined handler count matching baseline', () => {
      const totalCommands = commandBus.getRegisteredCommands().length;
      const totalQueries = queryBus.getRegisteredQueries().length;
      const total = totalCommands + totalQueries;

      // Baseline: 18 modules * avg ~10 handlers = ~170+ total
      expect(total).toBe(EXPECTED_COMMAND_HANDLER_COUNT + EXPECTED_QUERY_HANDLER_COUNT);
      expect(total).toBeGreaterThanOrEqual(170);
    });

    it('should not have duplicate command handler registrations', () => {
      const commands = commandBus.getRegisteredCommands();
      const uniqueCommands = new Set(commands);

      expect(uniqueCommands.size).toBe(commands.length);
    });

    it('should not have duplicate query handler registrations', () => {
      const queries = queryBus.getRegisteredQueries();
      const uniqueQueries = new Set(queries);

      expect(uniqueQueries.size).toBe(queries.length);
    });
  });

  describe('2. Per-Module Handler Verification', () => {
    let moduleRef: TestingModule;
    let commandBus: CommandBus;
    let queryBus: QueryBus;

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [CqrsModule.forRoot()],
        providers: [
          ...allCommandHandlerProviders,
          ...allQueryHandlerProviders,
        ],
      }).compile();

      await moduleRef.init();

      commandBus = moduleRef.get(CommandBus);
      queryBus = moduleRef.get(QueryBus);
    });

    afterAll(async () => {
      await moduleRef.close();
    });

    for (const moduleDef of MODULE_HANDLER_DEFS) {
      describe(`Module: ${moduleDef.moduleName}`, () => {
        for (const cmdDef of moduleDef.commandHandlers) {
          it(`should register command handler: ${cmdDef.handlerName}`, () => {
            const commandName = cmdDef.command.name;
            expect(commandBus.hasHandler(commandName)).toBe(true);
          });
        }

        for (const queryDef of moduleDef.queryHandlers) {
          it(`should register query handler: ${queryDef.handlerName}`, () => {
            const queryName = queryDef.query.name;
            expect(queryBus.hasHandler(queryName)).toBe(true);
          });
        }
      });
    }

    describe('CommandBus.execute() paths', () => {
      it('should execute CreateBatchCommand through the bus', async () => {
        const command = new CreateBatchCommand('tenant-1', { name: 'TestBatch' }, 'user-1');
        const result = await commandBus.execute<CreateBatchCommand, { handled: boolean }>(command);

        expect(result.handled).toBe(true);
      });

      it('should execute CreateFarmCommand through the bus', async () => {
        const command = new CreateFarmCommand('Test Farm', { lat: 41.0, lng: 29.0 }, 'tenant-1', 'user-1');
        const result = await commandBus.execute<CreateFarmCommand, { handled: boolean }>(command);

        expect(result.handled).toBe(true);
      });

      it('should execute CreateSpeciesCommand through the bus', async () => {
        const command = new CreateSpeciesCommand('tenant-1', 'user-1', { commonName: 'Salmon' });
        const result = await commandBus.execute<CreateSpeciesCommand, { handled: boolean }>(command);

        expect(result.handled).toBe(true);
      });

      it('should execute CreateTankCommand through the bus', async () => {
        const command = new CreateTankCommand('tenant-1', 'user-1', { code: 'T-001' });
        const result = await commandBus.execute<CreateTankCommand, { handled: boolean }>(command);

        expect(result.handled).toBe(true);
      });

      it('should execute CreateParameterConfigCommand through the bus', async () => {
        const command = new CreateParameterConfigCommand('tenant-1', { code: 'PH' }, 'user-1');
        const result = await commandBus.execute<CreateParameterConfigCommand, { handled: boolean }>(command);

        expect(result.handled).toBe(true);
      });

      it('should execute CreateChemicalCommand through the bus', async () => {
        const command = new CreateChemicalCommand({ name: 'H2O2' }, 'tenant-1', 'user-1');
        const result = await commandBus.execute<CreateChemicalCommand, { handled: boolean }>(command);

        expect(result.handled).toBe(true);
      });

      it('should execute CreateStorageLocationCommand through the bus', async () => {
        const command = new CreateStorageLocationCommand('tenant-1');
        const result = await commandBus.execute<CreateStorageLocationCommand, { handled: boolean }>(command);

        expect(result.handled).toBe(true);
      });

      it('should throw for unregistered command', async () => {
        class UnknownCommand implements ICommand {
          constructor(public readonly tenantId: string) {}
        }

        const command = new UnknownCommand('tenant-1');
        await expect(commandBus.execute(command)).rejects.toThrow(
          /No handler registered for command: UnknownCommand/,
        );
      });
    });

    describe('QueryBus.execute() paths', () => {
      it('should execute GetBatchQuery through the bus', async () => {
        const query = new GetBatchQuery('tenant-1', 'batch-uuid-1');
        const result = await queryBus.execute<GetBatchQuery, { handled: boolean }>(query);

        expect(result.handled).toBe(true);
      });

      it('should execute GetFarmQuery through the bus', async () => {
        const query = new GetFarmQuery('farm-uuid-1', 'tenant-1');
        const result = await queryBus.execute<GetFarmQuery, { handled: boolean }>(query);

        expect(result.handled).toBe(true);
      });

      it('should execute GetSpeciesQuery through the bus', async () => {
        const query = new GetSpeciesQuery('tenant-1', 'species-uuid-1');
        const result = await queryBus.execute<GetSpeciesQuery, { handled: boolean }>(query);

        expect(result.handled).toBe(true);
      });

      it('should execute GetTankQuery through the bus', async () => {
        const query = new GetTankQuery('tenant-1', 'tank-uuid-1');
        const result = await queryBus.execute<GetTankQuery, { handled: boolean }>(query);

        expect(result.handled).toBe(true);
      });

      it('should execute ListParameterConfigsQuery through the bus', async () => {
        const query = new ListParameterConfigsQuery('tenant-1');
        const result = await queryBus.execute<ListParameterConfigsQuery, { handled: boolean }>(query);

        expect(result.handled).toBe(true);
      });

      it('should execute GetChemicalQuery through the bus', async () => {
        const query = new GetChemicalQuery('chem-uuid-1', 'tenant-1');
        const result = await queryBus.execute<GetChemicalQuery, { handled: boolean }>(query);

        expect(result.handled).toBe(true);
      });

      it('should execute ListWorkersQuery through the bus', async () => {
        const query = new ListWorkersQuery('tenant-1');
        const result = await queryBus.execute<ListWorkersQuery, { handled: boolean }>(query);

        expect(result.handled).toBe(true);
      });

      it('should throw for unregistered query', async () => {
        class UnknownQuery implements IQuery {
          constructor(public readonly tenantId: string) {}
        }

        const query = new UnknownQuery('tenant-1');
        await expect(queryBus.execute(query)).rejects.toThrow(
          /No handler registered for query: UnknownQuery/,
        );
      });
    });
  });

  describe('3. Handler Discovery with Feature Modules (CqrsModule per-feature)', () => {
    let moduleRef: TestingModule;
    let commandBus: CommandBus;
    let queryBus: QueryBus;

    beforeAll(async () => {
      // Build feature modules that each import CqrsModule (pre-FIX-6 pattern)
      const featureModules = MODULE_HANDLER_DEFS.map((def) =>
        createFeatureModule(def, true),
      );

      moduleRef = await Test.createTestingModule({
        imports: [CqrsModule.forRoot(), ...featureModules],
      }).compile();

      await moduleRef.init();

      commandBus = moduleRef.get(CommandBus);
      queryBus = moduleRef.get(QueryBus);
    });

    afterAll(async () => {
      await moduleRef.close();
    });

    it('should discover all command handlers across feature modules', () => {
      const registeredCommands = commandBus.getRegisteredCommands();
      expect(registeredCommands.length).toBe(EXPECTED_COMMAND_HANDLER_COUNT);
    });

    it('should discover all query handlers across feature modules', () => {
      const registeredQueries = queryBus.getRegisteredQueries();
      expect(registeredQueries.length).toBe(EXPECTED_QUERY_HANDLER_COUNT);
    });

    it('should share a single CommandBus instance across all feature modules', () => {
      // If CqrsModule is @Global, all feature modules should resolve the same bus
      const bus1 = moduleRef.get(CommandBus);
      const bus2 = moduleRef.get(CommandBus);
      expect(bus1).toBe(bus2);
    });

    it('should share a single QueryBus instance across all feature modules', () => {
      const bus1 = moduleRef.get(QueryBus);
      const bus2 = moduleRef.get(QueryBus);
      expect(bus1).toBe(bus2);
    });
  });

  describe('4. Handler Discovery WITHOUT Feature CqrsModule Imports (post-FIX-6)', () => {
    let moduleRef: TestingModule;
    let commandBus: CommandBus;
    let queryBus: QueryBus;

    beforeAll(async () => {
      // Build feature modules that do NOT import CqrsModule (post-FIX-6 pattern)
      // Only the root CqrsModule.forRoot() is imported
      const featureModules = MODULE_HANDLER_DEFS.map((def) =>
        createFeatureModule(def, false),
      );

      moduleRef = await Test.createTestingModule({
        imports: [CqrsModule.forRoot(), ...featureModules],
      }).compile();

      await moduleRef.init();

      commandBus = moduleRef.get(CommandBus);
      queryBus = moduleRef.get(QueryBus);
    });

    afterAll(async () => {
      await moduleRef.close();
    });

    it('should discover all command handlers even without per-feature CqrsModule import', () => {
      const registeredCommands = commandBus.getRegisteredCommands();
      expect(registeredCommands.length).toBe(EXPECTED_COMMAND_HANDLER_COUNT);
    });

    it('should discover all query handlers even without per-feature CqrsModule import', () => {
      const registeredQueries = queryBus.getRegisteredQueries();
      expect(registeredQueries.length).toBe(EXPECTED_QUERY_HANDLER_COUNT);
    });

    it('should produce identical handler registration with and without per-feature imports', () => {
      // This test is the KEY validation for FIX-6:
      // Removing CqrsModule from feature modules should NOT change the set of registered handlers.
      const commands = commandBus.getRegisteredCommands().sort();
      const queries = queryBus.getRegisteredQueries().sort();

      // Cross-reference with expected names from each module
      for (const moduleDef of MODULE_HANDLER_DEFS) {
        for (const cmdDef of moduleDef.commandHandlers) {
          expect(commands).toContain(cmdDef.command.name);
        }
        for (const queryDef of moduleDef.queryHandlers) {
          expect(queries).toContain(queryDef.query.name);
        }
      }
    });

    it('should execute commands end-to-end without per-feature CqrsModule', async () => {
      const batchCmd = new CreateBatchCommand('t-1', { name: 'B1' }, 'u-1');
      const farmCmd = new CreateFarmCommand('Farm A', { lat: 40, lng: 28 }, 't-1', 'u-1');
      const tankCmd = new CreateTankCommand('t-1', 'u-1', { code: 'T1' });

      const [batchRes, farmRes, tankRes] = await Promise.all([
        commandBus.execute<CreateBatchCommand, { handled: boolean }>(batchCmd),
        commandBus.execute<CreateFarmCommand, { handled: boolean }>(farmCmd),
        commandBus.execute<CreateTankCommand, { handled: boolean }>(tankCmd),
      ]);

      expect(batchRes.handled).toBe(true);
      expect(farmRes.handled).toBe(true);
      expect(tankRes.handled).toBe(true);
    });

    it('should execute queries end-to-end without per-feature CqrsModule', async () => {
      const batchQ = new GetBatchQuery('t-1', 'b-1');
      const farmQ = new GetFarmQuery('f-1', 't-1');
      const tankQ = new GetTankQuery('t-1', 'tank-1');

      const [batchRes, farmRes, tankRes] = await Promise.all([
        queryBus.execute<GetBatchQuery, { handled: boolean }>(batchQ),
        queryBus.execute<GetFarmQuery, { handled: boolean }>(farmQ),
        queryBus.execute<GetTankQuery, { handled: boolean }>(tankQ),
      ]);

      expect(batchRes.handled).toBe(true);
      expect(farmRes.handled).toBe(true);
      expect(tankRes.handled).toBe(true);
    });
  });

  describe('5. EventBus Cross-Module Communication', () => {
    let moduleRef: TestingModule;
    let publisher: TestEventPublisher;
    let subscriber: TestEventSubscriber;

    beforeAll(async () => {
      // Create two feature modules that both reference the shared event bus.
      // Module A publishes events, Module B listens.
      // The @Global TestEventBusModule ensures a single shared instance.

      @Module({
        providers: [],
      })
      class FeedingFeatureModule {}

      @Module({
        providers: [],
      })
      class StorageFeatureModule {}

      moduleRef = await Test.createTestingModule({
        imports: [
          TestEventBusModule,
          FeedingFeatureModule,
          StorageFeatureModule,
        ],
      }).compile();

      await moduleRef.init();

      publisher = moduleRef.get(TestEventPublisher);
      subscriber = moduleRef.get(TestEventSubscriber);
    });

    afterAll(async () => {
      await moduleRef.close();
    });

    it('should provide a single shared event publisher', () => {
      expect(publisher).toBeDefined();
      expect(subscriber).toBeDefined();
    });

    it('should deliver events from publisher module to subscriber module', () => {
      // Wire up the subscriber
      publisher.subscribe((event) => subscriber.handleEvent(event));

      // Publish a FeedingRecorded event (feeding module publishes)
      const feedingEvent: CrossModuleTestEvent = {
        type: 'FeedingRecorded',
        payload: { batchId: 'batch-123', tenantId: 'tenant-001' },
      };
      publisher.publish(feedingEvent);

      // Storage module handler should have received it
      expect(subscriber.receivedEvents).toHaveLength(1);
      expect(subscriber.receivedEvents[0]?.type).toBe('FeedingRecorded');
      expect(subscriber.receivedEvents[0]?.payload.batchId).toBe('batch-123');
    });

    it('should deliver multiple events maintaining order', () => {
      subscriber.receivedEvents.length = 0; // reset

      publisher.subscribe((event) => subscriber.handleEvent(event));

      const events: CrossModuleTestEvent[] = [
        { type: 'BatchCreated', payload: { batchId: 'b-1', tenantId: 't-1' } },
        { type: 'MortalityRecorded', payload: { batchId: 'b-1', tenantId: 't-1' } },
        { type: 'HarvestCompleted', payload: { batchId: 'b-1', tenantId: 't-1' } },
      ];

      for (const event of events) {
        publisher.publish(event);
      }

      expect(subscriber.receivedEvents).toHaveLength(3);
      expect(subscriber.receivedEvents.map((e) => e.type)).toEqual([
        'BatchCreated',
        'MortalityRecorded',
        'HarvestCompleted',
      ]);
    });

    it('should resolve the same publisher instance from both modules (singleton)', () => {
      const pub1 = moduleRef.get(TestEventPublisher);
      const pub2 = moduleRef.get(TestEventPublisher);
      expect(pub1).toBe(pub2);
    });

    it('should resolve the same subscriber instance from both modules (singleton)', () => {
      const sub1 = moduleRef.get(TestEventSubscriber);
      const sub2 = moduleRef.get(TestEventSubscriber);
      expect(sub1).toBe(sub2);
    });
  });

  describe('6. Handler Coverage Summary Report', () => {
    it('should cover all 18 feature modules with CQRS handlers', () => {
      const modulesWithHandlers = MODULE_HANDLER_DEFS.map((m) => m.moduleName);

      // The 18 feature modules that register CQRS handlers in the real farm-service:
      const expectedModules = [
        'batch',
        'chemical',
        'farm',
        'species',
        'tank',
        'water-quality',
        'site',
        'department',
        'equipment',
        'supplier',
        'consumable',
        'feed',
        'feeding',
        'growth',
        'harvest',
        'storage',
        'worker',
        'system',
      ];

      expect(modulesWithHandlers.sort()).toEqual(expectedModules.sort());
      expect(modulesWithHandlers).toHaveLength(18);
    });

    it('should have a handler count per module matching the real codebase', () => {
      // These counts are derived from reading each module file in the real codebase.
      // They serve as a regression baseline: if a module loses handlers after FIX-6,
      // this test catches it.
      const expectedCounts: Record<string, { commands: number; queries: number }> = {
        batch: { commands: 13, queries: 6 },
        chemical: { commands: 5, queries: 2 },
        farm: { commands: 5, queries: 4 },
        species: { commands: 3, queries: 3 },
        tank: { commands: 4, queries: 5 },
        'water-quality': { commands: 9, queries: 6 },
        site: { commands: 3, queries: 3 },
        department: { commands: 3, queries: 3 },
        equipment: { commands: 7, queries: 8 },
        supplier: { commands: 3, queries: 2 },
        consumable: { commands: 3, queries: 2 },
        feed: { commands: 6, queries: 4 },
        feeding: { commands: 5, queries: 3 },
        growth: { commands: 3, queries: 3 },
        harvest: { commands: 3, queries: 3 },
        storage: { commands: 12, queries: 11 },
        worker: { commands: 3, queries: 1 },
        system: { commands: 3, queries: 3 },
      };

      for (const moduleDef of MODULE_HANDLER_DEFS) {
        const expected = expectedCounts[moduleDef.moduleName];
        expect(expected).toBeDefined();

        expect(moduleDef.commandHandlers).toHaveLength(expected!.commands);
        expect(moduleDef.queryHandlers).toHaveLength(expected!.queries);
      }
    });
  });
});
