import { Role } from '@aquaculture/backend-common/decorators';

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
  addTanksToProgram: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  addTankToProgram: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  allocateBatchToTank: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  applyParameterTemplate: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  approveHarvestPlan: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  approveInventoryCount: [Role.TENANT_ADMIN],
  // Finance mutations — financial data, manager-class like createHarvestRecord.
  // Category archival + tenant-wide settings (currency SSoT) are admin-only.
  archiveFinanceCategory: [Role.TENANT_ADMIN],
  createFinanceCategory: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createFinanceEntry: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  deleteFinanceEntry: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  restoreFinanceCategory: [Role.TENANT_ADMIN],
  updateFinanceCategory: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateFinanceEntry: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateFinanceSettings: [Role.TENANT_ADMIN],
  approvePurchaseOrder: [Role.TENANT_ADMIN],
  assignFeedsToBatch: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  assignTemperatureSensor: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  bulkMapParamsToEquipment: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  bulkStockIn: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  cancelFeedingProgram: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  cancelHarvestPlan: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  cancelPurchaseOrder: [Role.TENANT_ADMIN],
  cloneFeedingProgram: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  closeBatch: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  closeEscapeIncident: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  completeFeedingProgram: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  completeHarvestPlan: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  completeMaintenance: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  completeTask: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  completeWorkOrder: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  confirmTenantErasure: [Role.TENANT_ADMIN],
  createAutoRule: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createMaintenanceSchedule: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createWorkOrder: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  createBatch: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  createBatchWaterQualityMeasurements: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  createBiomassReport: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  // Biomass Altinn manual-submission state machine (RPT-001).
  markBiomassReportReady: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  revertBiomassReportToDraft: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  confirmBiomassReportSubmitted: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
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
  createSlaughterFacility: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
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
  reconcileTankCounts: [Role.TENANT_ADMIN],
  recordBulkFeeding: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  recordCleanerMortality: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  recordCull: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  // FARM-MEDIUM-117: grading moves stock across tanks — manager-class like transferBatch.
  recordGrading: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  recordDailyFeeding: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  // Regulatory field capture (Phase 2a): operator-recordable like
  // createHealthEvent/recordMortality — these rows feed report assembly.
  recordEscapeIncident: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  recordGrowthSample: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  recordLiceCount: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  recordMortality: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  recordSparePartStockMovement: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  recordTreatmentApplication: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  recordWelfareAssessment: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  // Presign step of regulatory field capture (escape/welfare/lice photo
  // upload): operator-recordable, same audience as the record* mutations
  // whose payloads carry the minted storageKey.
  requestIncidentMediaUpload: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  recordStockMovement: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  // Tenant-wide roles only: bypasses per-site authorization by role
  // hierarchy; finer-grained recording flows through the full
  // water-quality measurement path (see water-quality.resolver.ts).
  recordWaterTemperature: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  removeChemicalDocument: [Role.TENANT_ADMIN],
  removeCleanerFish: [Role.TENANT_ADMIN],
  removeFeedAssignment: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  removeTankFromProgram: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  reorderParameterConfigs: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  resolveHealthEvent: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  resumeMaintenanceSchedule: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  resumeWorkOrder: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  restoreBatchFeedAssignment: [Role.TENANT_ADMIN],
  restoreChemical: [Role.TENANT_ADMIN],
  restoreConsumable: [Role.TENANT_ADMIN],
  restoreDepartment: [Role.TENANT_ADMIN],
  restoreFeed: [Role.TENANT_ADMIN],
  restoreFeedingProgram: [Role.TENANT_ADMIN],
  restoreSite: [Role.TENANT_ADMIN],
  restoreSpecies: [Role.TENANT_ADMIN],
  restoreSupplier: [Role.TENANT_ADMIN],
  restoreSystem: [Role.TENANT_ADMIN],
  saveFeederCalibrations: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  saveSentinelHubSettings: [Role.TENANT_ADMIN],
  scheduleHarvestPlan: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  seedDefaultWaterQualityParameterConfigs: [Role.TENANT_ADMIN],
  setDefaultFeedingProtocol: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  setSupplierApprovedSites: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  upsertSiteContacts: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  skipDailyFeeding: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  startHarvestPlan: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  startHealthEventQuarantine: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  startHealthEventTreatment: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  startTask: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  startWorkOrder: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  submitCleanerFishReport: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  submitWorkOrderForApproval: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  // Legally-immediate Mattilsynet "varsling" mutations. Same authorisation
  // shape as submitSeaLiceReport / submitSmoltReport (MANAGER + ADMIN) — the
  // fail-closed PermissionMatrixGuard 403s any @Mutation not listed here, and
  // the permission-matrix invariant requires every @Mutation be classified.
  submitDiseaseOutbreak: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  submitEscapeReport: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  submitExecutedSlaughterReport: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  submitInventoryCount: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  submitPlannedSlaughterReport: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  submitSeaLiceReport: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  submitSmoltReport: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  submitWelfareEvent: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  // Retry-replay of a persisted FAILED REST submission (RPT-018) — same
  // audience as the interactive submit mutations.
  resubmitRegulatoryReport: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  // Scheduled report-draft review workflow (RPT-003). Operators review +
  // fill/dismiss; enabling automated submission is a tenant-admin decision.
  refreshReportDraft: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  saveReportDraftOverrides: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  dismissReportDraft: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  approveAndSubmitReportDraft: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  updateAutoSubmitPolicy: [Role.TENANT_ADMIN],
  syncWeatherData: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  testMaskinportenConnection: [Role.TENANT_ADMIN],
  transferBatch: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  transferCleanerFish: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  transferStock: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  toggleAutoRuleActive: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  // FARM-HIGH-057: toggleChecklistItem (blind flip) -> setChecklistItem
  // (idempotent absolute SET + idempotency envelope). Same role contract.
  setChecklistItem: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
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
  updateSlaughterFacility: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
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
  activeSpecies: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  activeTanks: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  autoRule: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  autoRules: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
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
  // Phase-6 traceability report (read-only composition) shipped with @Roles
  // but without a matrix entry — classified here to restore the invariant.
  batchTraceability: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  batches: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  biomassReport: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  biomassReports: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  biomassReportAltinnExport: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  chemical: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  chemicalSuppliers: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  chemicalTypes: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  chemicals: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  chemicalsByType: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  childSystems: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  cleanerFishBatches: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  cleanerFishSpecies: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  consumable: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  consumables: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  criticalHealthEvents: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  criticalWaterQuality: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  currentWeather: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  dailyFeedingExecution: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  dailyFeedingExecutions: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  dailyFeedingPlan: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  defaultFeedingProtocol: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  department: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  // delete-preview queries are pre-flight checks for destructive
  // mutations — same authorisation shape as the corresponding
  // delete mutation (MANAGER + ADMIN, no operator).
  departmentDeletePreview: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  departments: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  departmentsBySite: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  disinfectantChemicals: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  equipment: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  equipmentByDepartment: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  equipmentDeletePreview: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  equipmentList: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  equipmentParameters: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  equipmentSuppliers: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  equipmentType: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  equipmentTypes: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  escapeIncidents: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  estimateSGR: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  farm: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  farmAnomalies: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  farmDashboardInsights: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  farms: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  feed: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  feedConsumptionForecast: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  feedSuppliers: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  feedTypes: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  feederCalibrations: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  feedingAdvice: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  feedingProgram: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  feedingPrograms: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  feedingProtocol: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  feedingProtocols: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  feedingProtocolsBySpecies: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  feedingRecord: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  feedingRecords: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  feedingSummary: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  feeds: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  // Finance reads restricted to MANAGER + ADMIN — aggregate financial
  // signals, same authorisation shape as harvestStatistics / batchPerformance.
  financeBatchTotals: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  financeCategories: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  financeLedger: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  financeSettings: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  financeSummary: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  feedsByPelletSize: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  feedsByType: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  feedsForSpecies: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  farmStockInventory: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  generateBatchNumber: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  growthAnalysis: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  growthMeasurement: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  growthMeasurements: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  growthSimulation: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  harvest: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  harvestPlan: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  isSentinelHubConfigured: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  harvestPlanByCode: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  harvestPlans: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  harvestPlansByBatch: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  harvestPlanStats: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  // harvestStatistics restricted to MANAGER+ADMIN — aggregate
  // financial totals (revenue, cost, yield KPIs). Same shape as
  // batchPerformance / maintenanceComplianceReport.
  harvestStatistics: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  harvests: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  harvestsByBatch: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  healthEvent: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  healthEventStats: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  healthEvents: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  healthEventsByBatch: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  inventoryCount: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  inventoryCounts: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  latestGrowthMeasurement: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  latestWaterQuality: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  liceCounts: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  lowStockAlerts: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  maintenanceAlerts: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  marineObservations: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  maskinportenStatus: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  mattilsynetStatus: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  // maintenanceComplianceReport is supervisory / audit output —
  // restricted to MANAGER + ADMIN to match the shape of other
  // compliance-oriented queries.
  maintenanceComplianceReport: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  maintenanceSchedule: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  maintenanceScheduleByCode: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  maintenanceSchedules: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  myTasks: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  myWorkOrders: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  overdueHarvestPlans: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  overdueHealthFollowUps: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  overdueMaintenanceSchedules: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  overdueWorkOrders: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  parameterConfig: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  parameterConfigByCode: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  parameterConfigs: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  parameterEquipmentMappings: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  parameterTemplates: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  pendingDeliveries: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  pond: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  predefinedSpeciesTags: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  projectHarvestDate: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  purchaseOrder: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  purchaseOrders: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  recurringTemplate: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  recurringTemplates: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  regulatoryConfigurationStatus: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  regulatoryHealth: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  // Persisted submission history (FARM-HIGH-125) — read-only rows, same
  // audience as biomassReports (operators read what was reported).
  regulatoryReport: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  regulatoryReportSummary: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  reportPrefill: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  // Scheduled report-draft review + deadline views (RPT-003).
  reportDrafts: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  reportDeadlines: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  regulatoryReports: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  regulatorySettings: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  rootSystems: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  sentinelHubCredentials: [Role.TENANT_ADMIN],
  sentinelHubStatus: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  sentinelHubToken: [Role.TENANT_ADMIN],
  sentinelHubWmtsConfig: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  site: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  siteContacts: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  siteDeletePreview: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  sites: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  slaughterFacilities: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  sparePart: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  sparePartByCode: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  sparePartByPartNumber: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  spareParts: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  sparePartsByEquipmentType: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  species: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  speciesByCode: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  speciesList: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  speciesTags: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  stockEventsSummary: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  stockMovements: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  stockSummary: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  storageInventory: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  storageInventoryByCursor: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  storageLocation: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  storageLocations: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  storageOverview: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  subEquipment: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  subEquipmentByParent: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  subEquipmentList: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  subEquipmentType: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  subEquipmentTypes: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  subEquipmentTypesForEquipment: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  supplier: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  supplierSites: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
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
  task: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  taskStats: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  tasks: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  todaysFeedingPlan: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  todaysDailyOpsCounts: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  todaysTasks: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  traceLot: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  treatmentApplications: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  treatmentChemicals: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  upcomingHarvestPlans: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  upcomingMaintenanceSchedules: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  waterQuality: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  waterQualityChart: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  welfareAssessments: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  waterQualityChartBySystem: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  waterQualityMeasurements: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  waterQualityStatistics: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  waterQualityStatisticsBySystem: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  weatherForecast: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  weatherObservations: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  weatherSettings: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  warehouseSummary: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  workOrder: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  workOrderByCode: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  workOrderStatistics: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  workOrders: [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN],
  workers: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
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
export const UNGATED_OPERATIONS: ReadonlySet<string> = Object.freeze(
  new Set([
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
    // Phase 6.1.1 (feeding-growth-WQ queries) moved 37:
    // feed / feeds / feedsByType / feedsByPelletSize / feedsForSpecies /
    // feedTypes / feedingProtocol / feedingProtocols /
    // feedingProtocolsBySpecies / defaultFeedingProtocol /
    // feedingRecord / feedingRecords / dailyFeedingPlan /
    // feedingSummary / growthSimulation /
    // feedConsumptionForecast / estimateSGR / feederCalibrations /
    // feedingAdvice / growthMeasurement / growthMeasurements /
    // growthAnalysis / latestGrowthMeasurement / waterQuality /
    // waterQualityMeasurements / latestWaterQuality /
    // criticalWaterQuality / waterQualityChart /
    // waterQualityChartBySystem / waterQualityStatistics /
    // waterQualityStatisticsBySystem / parameterConfig /
    // parameterConfigByCode / parameterConfigs /
    // parameterEquipmentMappings / parameterTemplates.
    // Phase 6.1.1 (health-chemical-species-subEq queries) moved 26:
    // healthEvent / healthEvents / healthEventsByBatch /
    // healthEventStats / criticalHealthEvents /
    // overdueHealthFollowUps / chemical / chemicals /
    // chemicalsByType / chemicalTypes / disinfectantChemicals /
    // treatmentChemicals / species / speciesByCode / speciesList /
    // speciesTags / activeSpecies / predefinedSpeciesTags /
    // cleanerFishSpecies / consumable / consumables / traceLot /
    // stockMovements / subEquipment / subEquipmentByParent /
    // subEquipmentList / subEquipmentType / subEquipmentTypes /
    // subEquipmentTypesForEquipment.
    // Phase 6.1.1 (task-workOrder-maintenance-automation queries)
    // moved 22: task / tasks / taskStats / todaysTasks / myTasks /
    // workOrder / workOrders / workOrderByCode / workOrderStatistics /
    // myWorkOrders / overdueWorkOrders / maintenanceSchedule /
    // maintenanceScheduleByCode / maintenanceSchedules /
    // upcomingMaintenanceSchedules / overdueMaintenanceSchedules /
    // maintenanceAlerts / maintenanceComplianceReport / autoRule /
    // autoRules / recurringTemplate / recurringTemplates.
    // Phase 6.1.1 (sensitive-regulatory-credentials queries)
    // moved 10 with tighter gates: sentinelHubStatus /
    // isSentinelHubConfigured / sentinelHubWmtsConfig
    // (MANAGER + ADMIN), sentinelHubToken (ADMIN only —
    // deepest credential), maskinportenStatus /
    // mattilsynetStatus / regulatoryConfigurationStatus /
    // regulatoryHealth / regulatorySettings (MANAGER + ADMIN),
    // workers (MANAGER + ADMIN — HR-adjacent PII).
    // Phase 6.1.1 final — farm-legacy / harvest / weather /
    // purchase / inventory / cleaner-fish / AI queries — moved 21:
    // farm / farms / pond (legacy); harvest / harvests /
    // harvestsByBatch (MODULE_USER+MANAGER+ADMIN);
    // harvestStatistics (MANAGER+ADMIN — financial aggregate);
    // weatherObservations / marineObservations / currentWeather /
    // weatherForecast (MODULE_USER+MANAGER+ADMIN);
    // weatherSettings (MANAGER+ADMIN — sync config);
    // purchaseOrder / purchaseOrders / pendingDeliveries /
    // inventoryCount / inventoryCounts (MODULE_USER+MANAGER+ADMIN);
    // cleanerFishBatches (MODULE_USER+MANAGER+ADMIN — note:
    // cleanerFishReport was removed as a dead zero-returning stub);
    // farmAnomalies / farmDashboardInsights
    // (MODULE_USER+MANAGER+ADMIN).
    // Empty after phase 6.1.1 complete. Every @Mutation and @Query
    // surface in farm-service now appears in MUTATION_ROLES or
    // QUERY_ROLES with an explicit @Roles decorator matching the
    // matrix entry. New operations added after this point MUST
    // ship with @Roles or fail the invariant test.
  ] as const),
);

/**
 * Resolve the allowed roles for an operation. Returns `null` when
 * the operation is on the grandfather whitelist (no authorisation
 * gate declared yet). An undefined return means the operation is
 * unknown — the runtime guard / invariant test treats that as a
 * fail-closed 403 for mutations.
 */
export function resolveAllowedRoles(operation: string): readonly Role[] | null | undefined {
  if (UNGATED_OPERATIONS.has(operation)) return null;
  if (operation in MUTATION_ROLES) return MUTATION_ROLES[operation];
  if (operation in QUERY_ROLES) return QUERY_ROLES[operation];
  return undefined;
}
