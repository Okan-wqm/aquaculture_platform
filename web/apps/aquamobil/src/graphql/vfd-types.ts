/**
 * VFD/feeder operation types — LOCAL, not codegen-emitted.
 *
 * WHY: the MobileVfd-family and feederSetup operations target the aquamobil-v4 BACKEND
 * schema (feeder assignments, VFD calibration reshape) which is NOT in this
 * PR's subgraph set; codegen therefore cannot emit their types (they are
 * excluded in codegen.ts). These definitions were lifted verbatim from the
 * v4 lineage's generated client and are the contract the drives surfaces
 * compile against until that backend lands — then codegen re-emits them and
 * this module shrinks to a re-export.
 */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };

export type MobileVfdFleetQuery = { vfdStats: { total: number, active: number, inactive: number, faulted: number, maintenance: number }, vfdDevices: { total: number, page: number, totalPages: number, hasNextPage: boolean, items: Array<{ id: string, name: string, brand: string, protocol: string, status: string, location: string | null, connectionStatus: { isConnected: boolean, lastError: string | null, lastSuccessAt: string | null } | null }> } };

export type MobileVfdFleetQueryVariables = Exact<{
  pagination?: VfdPaginationInput | null | undefined;
}>;

export type MobileVfdFleetSummaryQuery = { vfdStats: { total: number, active: number, inactive: number, faulted: number, maintenance: number } };

export type MobileVfdFleetSummaryQueryVariables = Exact<{ [key: string]: never; }>;

export type MobileVfdDriveQuery = { vfdDevice: { id: string, name: string, brand: VfdBrand, status: VfdDeviceStatus, location: string | null, connectionStatus: Record<string, unknown> | null, driveBinding: { drivenEquipmentId: string, state: VfdDriveBindingState, equipmentCategory: string | null, equipmentCode: string | null, equipmentName: string | null, attestedAt: string | null } | null, drivenUnit: { outcome: VfdDrivenUnitOutcome, drivenEquipmentId: string | null, equipmentCategory: string | null, units: Array<{ unitId: string, unitCode: string, unitType: string, doseSharePercent: number }> }, latestReading: { timestamp: string, isValid: boolean, errorMessage: string | null, parameters: Record<string, unknown>, statusBits: Record<string, unknown> | null } | null } | null };

export type MobileVfdDriveQueryVariables = Exact<{
  id: string | number;
}>;

export type MobileUnitDrivesQuery = { vfdDevicesByTank: Array<{ id: string, name: string, brand: VfdBrand, status: VfdDeviceStatus, location: string | null, connectionStatus: Record<string, unknown> | null, driveBinding: { drivenEquipmentId: string, state: VfdDriveBindingState, equipmentCategory: string | null, equipmentCode: string | null, equipmentName: string | null, attestedAt: string | null } | null, drivenUnit: { outcome: VfdDrivenUnitOutcome, drivenEquipmentId: string | null, equipmentCategory: string | null, units: Array<{ unitId: string, unitCode: string, unitType: string, doseSharePercent: number }> }, latestReading: { timestamp: string, isValid: boolean, errorMessage: string | null, parameters: Record<string, unknown>, statusBits: Record<string, unknown> | null } | null }> };

export type MobileUnitDrivesQueryVariables = Exact<{
  tankId: string | number;
}>;

export type MobileFeederSetupQuery = { feederSetup: { capability: { equipmentId: string, dosingMode: FeederDosingMode, dispenseControl: FeederDispenseControl, siloCapacityKg: number | null, minSpeedHz: number | null, maxSpeedHz: number | null } | null, calibrations: Array<{ id: string, feedId: string, dosingMode: FeederDosingMode, gramsPerDispensing: number | null, gramsPerMinute: number | null, referenceSpeedHz: number | null }> } };

export type MobileFeederSetupQueryVariables = Exact<{
  equipmentId: string | number;
}>;

export type MobileStartVfdMutation = { startVfd: { success: boolean, error: string | null, acknowledgedAt: string | null, commandSent: string | null } };

export type MobileStartVfdMutationVariables = Exact<{
  vfdDeviceId: string | number;
}>;

export type MobileStopVfdMutation = { stopVfd: { success: boolean, error: string | null, acknowledgedAt: string | null, commandSent: string | null } };

export type MobileStopVfdMutationVariables = Exact<{
  vfdDeviceId: string | number;
}>;


export type VfdBrand =
  | 'ABB'
  | 'DANFOSS'
  | 'DELTA'
  | 'MITSUBISHI'
  | 'ROCKWELL'
  | 'SCHNEIDER'
  | 'SIEMENS'
  | 'YASKAWA';

export type VfdDeviceStatus =
  | 'ACTIVE'
  | 'DRAFT'
  | 'OFFLINE'
  | 'PENDING_TEST'
  | 'SUSPENDED'
  | 'TESTING'
  | 'TEST_FAILED';

export type VfdDriveBindingState =
  | 'ATTESTED'
  | 'INACTIVE_EQUIPMENT'
  | 'PENDING'
  | 'UNKNOWN_EQUIPMENT';

export type VfdDrivenUnitOutcome =
  | 'EXPIRED'
  | 'FEEDER_AMBIGUOUS'
  | 'FEEDER_UNIT'
  | 'FEEDER_WITHOUT_UNIT'
  | 'NOT_A_FEEDER'
  | 'UNATTESTED'
  | 'UNBOUND';

export type VfdPaginationInput = {
  /** Items per page (max 100) */
  limit?: number | null | undefined;
  /** Page number (1-based) */
  page?: number | null | undefined;
  /** Field to sort by (name, brand, status, createdAt, updatedAt) */
  sortBy?: string | null | undefined;
  /** Sort direction */
  sortOrder?: SortOrder | null | undefined;
};

export type FeederDosingMode =
  | 'CONTINUOUS'
  | 'DISCRETE';

export type FeederDispenseControl =
  | 'TIME_BASED'
  | 'WEIGHT_BASED';

export type SortOrder =
  | 'ASC'
  | 'DESC';

export type MobileDriveFieldsFragment = { id: string, name: string, brand: VfdBrand, status: VfdDeviceStatus, location: string | null, connectionStatus: Record<string, unknown> | null, driveBinding: { drivenEquipmentId: string, state: VfdDriveBindingState, equipmentCategory: string | null, equipmentCode: string | null, equipmentName: string | null, attestedAt: string | null } | null, drivenUnit: { outcome: VfdDrivenUnitOutcome, drivenEquipmentId: string | null, equipmentCategory: string | null, units: Array<{ unitId: string, unitCode: string, unitType: string, doseSharePercent: number }> }, latestReading: { timestamp: string, isValid: boolean, errorMessage: string | null, parameters: Record<string, unknown>, statusBits: Record<string, unknown> | null } | null };