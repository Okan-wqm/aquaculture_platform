/**
 * Farm Module Hooks
 *
 * NOTE: Some modules export identically-named symbols.  We use explicit
 * re-exports (omitting the duplicate names) for the *later* module in each
 * conflict pair so that the first exporter "wins".  This avoids TS2308.
 */
export * from './useSites';
export * from './useDepartments';
export * from './useSystems';
export * from './useEquipment';
export * from './useSuppliers';
export * from './useChemicals';
export * from './useFeeds';
export * from './useSpecies';
export * from './useBatches';
export * from './useCleanerFish';
export * from './useFileUpload';
export * from './useSentinelHub';
export * from './useMapPointQuery';
export * from './useMaintenance';
export * from './useHealthEvents';
export * from './useTasks';
export * from './useRecurringTemplates';
export * from './useAutoRules';
export * from './useGrowth';
export * from './useHarvestPlans';
export * from './useFeedingRecords';


// useFeeding: GrowthProjection already exported by useGrowth
export {
  type GrowthSimulationSummary,
  type FeedRequirement,
  type GrowthSimulationResult,
  type GrowthSimulationInput,
  type ActiveTank,
  useGrowthSimulation,
  useProjectHarvestDate,
  useEstimateSGR,
  useActiveTanks,
  calculateSGR,
  projectWeight,
  daysToTargetWeight,
  formatDate,
} from './useFeeding';

export * from './useFeederCalibration';

// useTanks: CleanerFishDetail (useCleanerFish), EquipmentType (useEquipment),
//           PaginationInput (useFeedingRecords) already exported
export {
  type TankBatchMetrics,
  type Tank,
  type TankFilterInput,
  useTanksList,
  tankStatusColors,
  tankTypeLabels,
  tankMaterialLabels,
  waterTypeLabels,
} from './useTanks';

export * from './useTankFeeders';
export * from './useConsumables';
export * from './usePurchaseOrders';
export * from './useRegulatory';
export * from './useSentinelTiles';

// useStorageInventory: useRecordStockMovement already exported by useMaintenance
export {
  StorageItemType,
  MovementType,
  type StorageInventoryItem,
  type ConditionWarning,
  type StockMovement,
  type CategoryTotal,
  type LocationFillRate,
  type LowStockAlert,
  type StorageOverview,
  type RecordStockMovementInput,
  type TransferStockInput,
  useStorageInventory,
  useStorageOverview,
  useStockMovements,
  useTransferStock,
} from './useStorageInventory';

// useStorageLocations: StorageLocation already exported by useMaintenance
export {
  StorageLocationType,
  type CreateStorageLocationInput,
  type UpdateStorageLocationInput,
  useStorageLocationList,
  useStorageLocation,
  useCreateStorageLocation,
  useUpdateStorageLocation,
  useDeleteStorageLocation,
} from './useStorageLocations';

export * from './useTenantUsers';

// useWaterQuality: getStatusColor/getStatusLabel bilinçli olarak index'ten
// export EDİLMEZ — hiçbir tüketicisi yok (onları export eden v1 execution
// hook'u Faz 8'de silindi; ölü export üretmek yasak, ihtiyaç doğarsa
// doğrudan './useWaterQuality'den import edilir).
export {
  type WaterQualityStatus,
  type MeasurementSource,
  type WaterParameters,
  type ParameterEvaluation,
  type WaterQualitySummary,
  type WaterQualityMeasurement,
  type WaterQualityStatistics,
  type WaterQualityFilters,
  type CreateWaterQualityInput,
  type UpdateWaterQualityInput,
  useWaterQualityList,
  useWaterQuality,
  useLatestWaterQuality,
  useCriticalWaterQuality,
  useWaterQualityChart,
  useWaterQualityStatistics,
  useCreateWaterQuality,
  useUpdateWaterQuality,
  useDeleteWaterQuality,
  getSourceLabel,
  formatParameterValue,
} from './useWaterQuality';

export * from './useWeather';
export * from './useWorkers';
export * from './useAOIDrawing';
export * from './useParameterConfigs';
export * from './useParamEquipmentMapping';
export * from './useEquipmentParameters';
