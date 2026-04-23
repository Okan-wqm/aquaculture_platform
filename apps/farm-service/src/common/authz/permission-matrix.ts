/**
 * Farm-Service Permission Matrix
 *
 * SINGLE SOURCE OF TRUTH for the authorisation intent of every
 * root-level @Mutation / @Query in farm-service. The matrix is
 * paired with an invariant test (`permission-matrix.spec.ts`) that
 * scans every resolver file, extracts the @Roles decorator call,
 * and asserts it matches the entry here. Any drift fails CI.
 *
 * Rationale: before phase 6.1 the 198 mutations + 193 queries had
 * their authorisation decorators scattered across 36 resolver
 * files. There was no single place to audit who could call what.
 * A surprise change to a single @Roles decorator — or forgetting
 * to add one entirely — escaped review. A scan at PR time showed
 * 227 operations with NO @Roles decorator at all (the bare
 * @Mutation falls through to TenantGuard's default, which is
 * tenant-scoped but not role-scoped — i.e. any authenticated user
 * in the tenant can call it). That is the real gap Girdi 15-C2
 * surfaced.
 *
 * This phase CAPTURES the current state as the baseline. Phase
 * 6.1.1 (follow-up) will add @Roles to the grandfathered
 * operations one module at a time. Any NEW mutation / query added
 * after this phase MUST appear in this matrix or the invariant
 * test rejects the PR.
 *
 * Three maps:
 *
 *   MUTATION_ROLES  — operation → Role[] (ordered alphabetically,
 *                     roles sorted alphabetically) for every
 *                     @Mutation that carries a @Roles decorator
 *   QUERY_ROLES     — same, for @Query
 *   UNGATED_OPERATIONS — grandfather whitelist of operations that
 *                        deliberately carry NO @Roles decorator.
 *                        Every entry is a known authorisation debt
 *                        scheduled for phase 6.1.1.
 *
 * Phase 6.1 of the "Farm modülü kalan kör noktalar" plan. Closes
 * Girdi 15-C2.
 */
import { Role } from '@aquaculture/backend-common';

/**
 * All @Mutation operations that carry an explicit @Roles decorator.
 * Role lists are sorted alphabetically so the invariant test can
 * compare without ordering noise.
 */
export const MUTATION_ROLES: Readonly<Record<string, readonly Role[]>> = Object.freeze({
  activateFeedingProgram: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  addChemicalDocument: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  addTaskNote: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  approveWorkOrder: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  cancelWorkOrder: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  addFeedAssignment: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  addFeedInventory: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  addTanksToProgram: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  addTankToProgram: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  adjustFeedInventory: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  allocateBatchToTank: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  applyParameterTemplate: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  approveHarvestPlan: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  approveInventoryCount: [Role.TENANT_ADMIN],
  assignFeedsToBatch: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  assignTemperatureSensor: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  bulkMapParamsToEquipment: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  bulkStockIn: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  cancelFeedingProgram: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  cancelHarvestPlan: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  cancelPurchaseOrder: [Role.TENANT_ADMIN],
  cloneFeedingProgram: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  closeBatch: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  completeFeedingProgram: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  completeHarvestPlan: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  completeMaintenance: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  completeTask: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  completeWorkOrder: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  confirmTenantErasure: [Role.TENANT_ADMIN],
  consumeFeedInventory: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createAutoRule: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createMaintenanceSchedule: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createWorkOrder: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createBatch: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  createBatchWaterQualityMeasurements: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  createBiomassReport: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createChemical: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createCleanerFishBatch: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createConsumable: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createDepartment: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createEquipment: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createFarm: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createFeedingProgram: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createFeedingProtocol: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createFeed: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createFeedingRecord: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createHarvestPlan: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createHealthEvent: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  createHarvestRecord: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createInventoryCount: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createParamEquipmentMapping: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createParameterConfig: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createPond: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createPurchaseOrder: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createRecurringTemplate: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createSite: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createSparePart: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createSpecies: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createStorageLocation: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createSubEquipment: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  createSupplier: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createSystem: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createTank: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createTask: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  createWaterQualityMeasurement: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  createWorker: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  deleteAutoRule: [Role.TENANT_ADMIN],
  deleteBatchFeedAssignment: [Role.TENANT_ADMIN],
  deleteChemical: [Role.TENANT_ADMIN],
  deleteConsumable: [Role.TENANT_ADMIN],
  deleteDepartment: [Role.TENANT_ADMIN],
  deleteEquipment: [Role.TENANT_ADMIN],
  deleteFeed: [Role.TENANT_ADMIN],
  deleteFeedingProgram: [Role.TENANT_ADMIN],
  deleteFeedingProtocol: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  deleteHarvestPlan: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  deleteHarvestRecord: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  deleteHealthEvent: [Role.TENANT_ADMIN],
  deleteParamEquipmentMapping: [Role.TENANT_ADMIN],
  deleteParameterConfig: [Role.TENANT_ADMIN],
  deleteMaintenanceSchedule: [Role.TENANT_ADMIN],
  deleteRecurringTemplate: [Role.TENANT_ADMIN],
  deleteSentinelHubSettings: [Role.TENANT_ADMIN],
  deleteSite: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  deleteSparePart: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  deleteSpecies: [Role.TENANT_ADMIN],
  deleteStorageLocation: [Role.TENANT_ADMIN],
  deleteSubEquipment: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  deleteSupplier: [Role.TENANT_ADMIN],
  deleteSystem: [Role.TENANT_ADMIN],
  deleteTank: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  deleteTask: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  deleteWorkOrder: [Role.TENANT_ADMIN],
  deleteWaterQualityMeasurement: [Role.TENANT_ADMIN],
  deleteWorker: [Role.TENANT_ADMIN],
  deployCleanerFish: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  endHealthEventQuarantine: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  endHealthEventTreatment: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  exportTenantData: [Role.TENANT_ADMIN],
  generateDailyPlan: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  generateWorkOrderFromSchedule: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  initiateTenantErasure: [Role.TENANT_ADMIN],
  pauseFeedingProgram: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  pauseMaintenanceSchedule: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  postponeHarvestPlan: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  processAutoGenerateWorkOrders: [Role.TENANT_ADMIN],
  putWorkOrderOnHold: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  reactivateTankInProgram: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  recalculateDailyPlan: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  receiveDelivery: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  recordBulkFeeding: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  recordCleanerMortality: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  recordCull: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  recordDailyFeeding: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  recordGrowthSample: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  recordMortality: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  recordSparePartStockMovement: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  recordStockMovement: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  removeChemicalDocument: [Role.TENANT_ADMIN],
  removeCleanerFish: [Role.TENANT_ADMIN],
  removeFeedAssignment: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  removeTankFromProgram: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  reorderParameterConfigs: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  resolveHealthEvent: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  resumeMaintenanceSchedule: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  resumeWorkOrder: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  restoreChemical: [Role.TENANT_ADMIN],
  restoreConsumable: [Role.TENANT_ADMIN],
  restoreFeed: [Role.TENANT_ADMIN],
  restoreSpecies: [Role.TENANT_ADMIN],
  restoreSupplier: [Role.TENANT_ADMIN],
  saveFeederCalibrations: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  saveSentinelHubSettings: [Role.TENANT_ADMIN],
  scheduleHarvestPlan: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  seedDefaultWaterQualityParameterConfigs: [Role.TENANT_ADMIN],
  setDefaultFeedingProtocol: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  skipDailyFeeding: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  startHarvestPlan: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  startHealthEventQuarantine: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  startHealthEventTreatment: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  startTask: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  startWorkOrder: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  submitCleanerFishReport: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  submitWorkOrderForApproval: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  submitExecutedSlaughterReport: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  submitInventoryCount: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  submitPlannedSlaughterReport: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  submitSeaLiceReport: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  submitSmoltReport: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  syncWeatherData: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  testMaskinportenConnection: [Role.TENANT_ADMIN],
  transferBatch: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  transferCleanerFish: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  transferStock: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  toggleAutoRuleActive: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  toggleChecklistItem: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  toggleRecurringTemplateActive: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  transitionTankFeed: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateAutoRule: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateBatch: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  updateBatchFeedAssignment: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateBatchStatus: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  updateBatchWeightFromSample: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateChemical: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateConsumable: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateDepartment: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateEquipment: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateFCRTable: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateFeed: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateFeedAssignment: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateFeedingProgram: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateFeedingProtocol: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateFeedingRecord: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateHarvestPlan: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateHarvestRecord: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateHealthEvent: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  updateInventoryCountItems: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  updateMaintenanceSchedule: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateMeterReading: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  updateParamEquipmentMapping: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateParameterConfig: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateProgramSettings: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updatePurchaseOrderStatus: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateRecurringTemplate: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateRegulatorySettings: [Role.TENANT_ADMIN],
  updateSentinelHubInstanceId: [Role.TENANT_ADMIN],
  updateSite: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateSparePart: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateSpecies: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateStorageLocation: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateSubEquipment: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  updateSupplier: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateSystem: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateTank: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateTankStatus: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateTask: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  updateWaterQualityMeasurement: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateWeatherSettings: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateWorker: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateWorkOrder: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  verifyMeasurement: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  verifyWorkOrder: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
});

/**
 * All @Query operations that carry an explicit @Roles decorator.
 * Role lists are sorted alphabetically.
 */
export const QUERY_ROLES: Readonly<Record<string, readonly Role[]>> = Object.freeze({
  activeFeedingPrograms: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  activeSites: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  activeTanks: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  availableTanks: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  batch: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  batchFeedAssignment: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  batchGrowthHistory: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  batchGrowthPrediction: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  batchHarvestEligibility: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  batchHistory: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  // batchPerformance restricted to MANAGER + ADMIN — the query
  // exposes cost-per-kg, treatment totals, and labour costs which
  // are financial signals beyond the operator's scope.
  batchPerformance: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  batches: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  biomassReport: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  biomassReports: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  chemicalSuppliers: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  childSystems: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  dailyFeedingExecution: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  dailyFeedingExecutions: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  department: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  // delete-preview queries are pre-flight checks for destructive
  // mutations — same authorisation shape as the corresponding
  // delete mutation (MANAGER + ADMIN, no operator).
  departmentDeletePreview: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  departments: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  departmentsBySite: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  equipment: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  equipmentByDepartment: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  equipmentDeletePreview: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  equipmentList: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  equipmentParameters: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  equipmentSuppliers: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  equipmentType: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  equipmentTypes: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  feedSuppliers: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  feedingProgram: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  feedingPrograms: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  generateBatchNumber: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  harvestPlan: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  harvestPlanByCode: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  harvestPlans: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  harvestPlansByBatch: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  harvestPlanStats: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  lowStockAlerts: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  overdueHarvestPlans: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  projectHarvestDate: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  rootSystems: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  site: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  siteDeletePreview: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  sites: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  sparePart: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  sparePartByCode: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  sparePartByPartNumber: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  spareParts: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  sparePartsByEquipmentType: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  stockSummary: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  storageInventory: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  storageLocation: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  storageLocations: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  storageOverview: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  supplier: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  supplierTypes: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  suppliers: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  suppliersByType: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  system: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  systemDeletePreview: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  systems: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  systemsByDepartment: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  systemsBySite: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  tank: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  tankCleanerFish: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  tankRiskAssessment: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  tanks: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  tanksByDepartment: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  todaysFeedingPlan: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  upcomingHarvestPlans: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
});

/**
 * Grandfather whitelist — operations that deliberately carry NO
 * @Roles decorator at the phase-6.1 baseline. Every entry here is
 * known authorisation debt: the operation falls through to
 * TenantGuard's default (tenant-scoped, not role-scoped), which
 * means any authenticated user in the tenant can invoke it.
 *
 * Phase 6.1.1 walks this list module by module and adds the right
 * @Roles decorator; as each operation gets a role list it leaves
 * this set and joins MUTATION_ROLES / QUERY_ROLES. New operations
 * added after phase 6.1 MUST come with @Roles or fail the
 * invariant test — the set is frozen to the baseline.
 */
export const UNGATED_OPERATIONS: ReadonlySet<string> = Object.freeze(new Set([
  // All mutations have now been classified (phase 6.1.1 complete
  // through health-event + system + feed batches). Remaining
  // entries are queries only. Phase 6.1.1 (batch-queries) moved
  // 11 batch-related reads out: batch / batches / batchFeedAssignment
  // / batchGrowthHistory / batchGrowthPrediction / batchHarvestEligibility
  // / batchHistory / batchPerformance / availableTanks /
  // generateBatchNumber / projectHarvestDate. Phase 6.1.1
  // (site-dept-system-tank queries) moved 20 more: activeSites /
  // activeTanks / site / sites / siteDeletePreview / department /
  // departments / departmentsBySite / departmentDeletePreview /
  // system / systems / systemsBySite / systemsByDepartment /
  // systemDeletePreview / rootSystems / childSystems / tank /
  // tanks / tanksByDepartment / tankCleanerFish / tankRiskAssessment.
  // Phase 6.1.1 (equipment-supplier-storage queries) moved 23:
  // equipment / equipmentByDepartment / equipmentDeletePreview /
  // equipmentList / equipmentParameters / equipmentSuppliers /
  // equipmentType / equipmentTypes / sparePart / sparePartByCode /
  // sparePartByPartNumber / spareParts / sparePartsByEquipmentType /
  // storageInventory / storageLocation / storageLocations /
  // storageOverview / supplier / suppliers / suppliersByType /
  // supplierTypes / feedSuppliers / chemicalSuppliers /
  // lowStockAlerts / stockSummary.
  // Queries
  'activeSpecies',
  'autoRule',
  'autoRules',
  'chemical',
  'chemicals',
  'chemicalsByType',
  'chemicalTypes',
  'cleanerFishBatches',
  'cleanerFishReport',
  'cleanerFishSpecies',
  'consumable',
  'consumables',
  'criticalHealthEvents',
  'criticalWaterQuality',
  'currentWeather',
  'dailyFeedingPlan',
  'defaultFeedingProtocol',
  'disinfectantChemicals',
  'estimateSGR',
  'farm',
  'farmAnomalies',
  'farmDashboardInsights',
  'farms',
  'feed',
  'feedConsumptionForecast',
  'feederCalibrations',
  'feedingAdvice',
  'feedingProtocol',
  'feedingProtocols',
  'feedingProtocolsBySpecies',
  'feedingRecord',
  'feedingRecords',
  'feedingSummary',
  'feedInventory',
  'feeds',
  'feedsByPelletSize',
  'feedsByType',
  'feedsForSpecies',
  'feedTypes',
  'getCredentials',
  'growthAnalysis',
  'growthMeasurement',
  'growthMeasurements',
  'growthSimulation',
  'harvest',
  'harvests',
  'harvestsByBatch',
  'harvestStatistics',
  'healthEvent',
  'healthEvents',
  'healthEventsByBatch',
  'healthEventStats',
  'inventoryCount',
  'inventoryCounts',
  'isSentinelHubConfigured',
  'latestGrowthMeasurement',
  'latestWaterQuality',
  'maintenanceAlerts',
  'maintenanceComplianceReport',
  'maintenanceSchedule',
  'maintenanceScheduleByCode',
  'maintenanceSchedules',
  'marineObservations',
  'maskinportenStatus',
  'mattilsynetStatus',
  'myTasks',
  'myWorkOrders',
  'overdueHealthFollowUps',
  'overdueMaintenanceSchedules',
  'overdueWorkOrders',
  'parameterConfig',
  'parameterConfigByCode',
  'parameterConfigs',
  'parameterEquipmentMappings',
  'parameterTemplates',
  'pendingDeliveries',
  'pond',
  'predefinedSpeciesTags',
  'purchaseOrder',
  'purchaseOrders',
  'recurringTemplate',
  'recurringTemplates',
  'regulatoryConfigurationStatus',
  'regulatoryHealth',
  'regulatorySettings',
  'sentinelHubStatus',
  'sentinelHubToken',
  'sentinelHubWmtsConfig',
  'species',
  'speciesByCode',
  'speciesList',
  'speciesTags',
  'stockMovements',
  'subEquipment',
  'subEquipmentByParent',
  'subEquipmentList',
  'subEquipmentType',
  'subEquipmentTypes',
  'subEquipmentTypesForEquipment',
  'task',
  'tasks',
  'taskStats',
  'todaysTasks',
  'traceLot',
  'treatmentChemicals',
  'upcomingMaintenanceSchedules',
  'waterQuality',
  'waterQualityChart',
  'waterQualityChartBySystem',
  'waterQualityMeasurements',
  'waterQualityStatistics',
  'waterQualityStatisticsBySystem',
  'weatherForecast',
  'weatherObservations',
  'weatherSettings',
  'workers',
  'workOrder',
  'workOrderByCode',
  'workOrders',
  'workOrderStatistics',
] as const));

/**
 * Resolve the allowed roles for an operation. Returns `null` when
 * the operation is on the grandfather whitelist (no authorisation
 * gate declared yet). An undefined return means the operation is
 * unknown — the runtime guard / invariant test treats that as a
 * fail-closed 403 for mutations.
 */
export function resolveAllowedRoles(
  operation: string,
): readonly Role[] | null | undefined {
  if (UNGATED_OPERATIONS.has(operation)) return null;
  if (operation in MUTATION_ROLES) return MUTATION_ROLES[operation];
  if (operation in QUERY_ROLES) return QUERY_ROLES[operation];
  return undefined;
}
