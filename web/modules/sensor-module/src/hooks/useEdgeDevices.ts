/**
 * Edge Device hooks for Industrial IoT Fleet Management
 * IEC 62443 compliant device lifecycle management
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, createTenantQueryKey, createTenantInvalidationKey } from '@aquaculture/shared-ui';
import { graphqlFetch } from '../config/api';
import {
  EDGE_DEVICES_QUERY,
  EDGE_DEVICE_QUERY,
  EDGE_DEVICE_STATS_QUERY,
  REGISTER_EDGE_DEVICE_MUTATION,
  UPDATE_EDGE_DEVICE_MUTATION,
  APPROVE_EDGE_DEVICE_MUTATION,
  SET_DEVICE_MAINTENANCE_MODE_MUTATION,
  DECOMMISSION_EDGE_DEVICE_MUTATION,
  PING_EDGE_DEVICE_MUTATION,
  ADD_DEVICE_IO_CONFIG_MUTATION,
  UPDATE_DEVICE_IO_CONFIG_MUTATION,
  REMOVE_DEVICE_IO_CONFIG_MUTATION,
  PUSH_IO_CONFIG_MUTATION,
  CREATE_PROVISIONED_DEVICE_MUTATION,
  REGENERATE_DEVICE_TOKEN_MUTATION,
  SET_DIGITAL_OUTPUT_MUTATION,
  SCAN_HARDWARE_MUTATION,
  BULK_ADD_IO_CONFIG_MUTATION,
  DEVICE_INSTALL_COMMANDS_QUERY,
  AVAILABLE_FIRMWARE_VERSIONS_QUERY,
  UPDATE_EDGE_DEVICE_FIRMWARE_MUTATION,
  BULK_UPDATE_EDGE_DEVICE_FIRMWARE_MUTATION,
} from '../graphql/edge-device.queries';

// ==================== Types ====================

export enum DeviceLifecycleState {
  REGISTERED = 'REGISTERED',
  PROVISIONING = 'PROVISIONING',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  ACTIVE = 'ACTIVE',
  OFFLINE = 'OFFLINE',
  MAINTENANCE = 'MAINTENANCE',
  ERROR = 'ERROR',
  REVOKED = 'REVOKED',
  DECOMMISSIONED = 'DECOMMISSIONED',
}

export enum DeviceModel {
  REVOLUTION_PI_CONNECT_4 = 'REVOLUTION_PI_CONNECT_4',
  REVOLUTION_PI_COMPACT = 'REVOLUTION_PI_COMPACT',
  RASPBERRY_PI_4 = 'RASPBERRY_PI_4',
  RASPBERRY_PI_5 = 'RASPBERRY_PI_5',
  INDUSTRIAL_PC = 'INDUSTRIAL_PC',
  CUSTOM = 'CUSTOM',
}

export enum IoType {
  DI = 'DI',
  DO = 'DO',
  AI = 'AI',
  AO = 'AO',
}

export enum IoDataType {
  BOOL = 'BOOL',
  INT16 = 'INT16',
  INT32 = 'INT32',
  UINT16 = 'UINT16',
  UINT32 = 'UINT32',
  FLOAT32 = 'FLOAT32',
  FLOAT64 = 'FLOAT64',
}

export interface DeviceIoConfig {
  id: string;
  tagName: string;
  description?: string;
  ioType: IoType;
  dataType: IoDataType;
  moduleAddress: number;
  channel: number;
  rawMin?: number;
  rawMax?: number;
  engMin?: number;
  engMax?: number;
  engUnit?: string;
  modbusFunction?: number;
  modbusSlaveId?: number;
  modbusRegister?: number;
  gpioPin?: number;
  gpioMode?: string;
  invertValue?: boolean;
  alarmHH?: number;
  alarmH?: number;
  alarmL?: number;
  alarmLL?: number;
  deadband?: number;
  isActive: boolean;
}

export interface EdgeDevice {
  id: string;
  deviceCode: string;
  deviceName: string;
  deviceModel: DeviceModel;
  serialNumber?: string;
  description?: string;
  lifecycleState: DeviceLifecycleState;
  isOnline: boolean;
  connectionQuality?: number;
  ipAddress?: string;
  lastSeenAt?: string;
  mqttClientId?: string;
  certificateThumbprint?: string;
  certificateExpiresAt?: string;
  securityLevel?: number;
  firmwareVersion?: string;
  firmwareUpdatedAt?: string;
  targetFirmwareVersion?: string;
  cpuUsage?: number;
  memoryUsage?: number;
  storageUsage?: number;
  temperatureCelsius?: number;
  timezone?: string;
  scanRateMs?: number;
  config?: Record<string, unknown>;
  capabilities?: Record<string, boolean>;
  tags?: string[];
  siteId?: string;
  commissionedAt?: string;
  commissionedBy?: string;
  createdAt: string;
  updatedAt: string;
  ioConfig?: DeviceIoConfig[];
  sensorCount?: number;
  programCount?: number;
  activeAlarmCount?: number;
}

export interface EdgeDeviceConnection {
  items: EdgeDevice[];
  total: number;
  page: number;
  limit: number;
}

export interface StateCount {
  state: DeviceLifecycleState;
  count: number;
}

export interface ModelCount {
  model: DeviceModel;
  count: number;
}

export interface EdgeDeviceStats {
  total: number;
  online: number;
  offline: number;
  byState: StateCount[];
  byModel: ModelCount[];
}

export interface PingResult {
  success: boolean;
  latencyMs?: number;
  error?: string;
}

/** Response from pushIoConfigToDevice mutation — cihaza I/O konfigürasyonu gönderme sonucu.
 *  Backend PushIoConfigResult ile senkronize: { success, error? }
 */
export interface PushIoConfigResult {
  success: boolean;
  error?: string;
}

export interface EdgeDeviceFilter {
  siteId?: string;
  lifecycleState?: DeviceLifecycleState;
  isOnline?: boolean;
  search?: string;
  page?: number;
  limit?: number;
}

export interface RegisterEdgeDeviceInput {
  siteId?: string;
  deviceCode: string;
  deviceName: string;
  deviceModel: DeviceModel;
  serialNumber?: string;
  description?: string;
  timezone?: string;
}

export interface UpdateEdgeDeviceInput {
  deviceName?: string;
  description?: string;
  siteId?: string;
  timezone?: string;
  scanRateMs?: number;
  config?: Record<string, unknown>;
  capabilities?: Record<string, boolean>;
  tags?: string[];
}

export interface AddIoConfigInput {
  tagName: string;
  description?: string;
  ioType: IoType;
  dataType: IoDataType;
  moduleAddress: number;
  channel: number;
  rawMin?: number;
  rawMax?: number;
  engMin?: number;
  engMax?: number;
  engUnit?: string;
  modbusFunction?: number;
  modbusSlaveId?: number;
  modbusRegister?: number;
  gpioPin?: number;
  gpioMode?: string;
  busType?: string;
  i2cBus?: number;
  i2cAddress?: number;
  spiBus?: number;
  spiCs?: number;
  uartPort?: string;
  invertValue?: boolean;
  alarmHH?: number;
  alarmH?: number;
  alarmL?: number;
  alarmLL?: number;
  deadband?: number;
}

export interface UpdateIoConfigInput {
  description?: string;
  rawMin?: number;
  rawMax?: number;
  engMin?: number;
  engMax?: number;
  engUnit?: string;
  invertValue?: boolean;
  alarmHH?: number;
  alarmH?: number;
  alarmL?: number;
  alarmLL?: number;
  deadband?: number;
  isActive?: boolean;
}

// ==================== Install Commands Types ====================

export interface DeviceInstallCommands {
  installCommand: string;
  uninstallCommand: string;
  installUrl: string;
  uninstallUrl: string;
}

// ==================== Provisioning Types ====================

export interface CreateProvisionedDeviceInput {
  deviceName?: string;
  description?: string;
  deviceModel?: DeviceModel;
  siteId?: string;
  serialNumber?: string;
}

export interface ProvisionedDeviceResponse {
  deviceId: string;
  deviceCode: string;
  installerUrl: string;
  installerCommand: string;
  tokenExpiresAt: string;
  status: string;
}

export interface RegenerateTokenResponse {
  deviceId: string;
  deviceCode: string;
  installerUrl: string;
  installerCommand: string;
  tokenExpiresAt: string;
}

// ==================== Query Hooks ====================

/**
 * Hook to fetch paginated edge device list
 */
export function useEdgeDevices(filter?: EdgeDeviceFilter) {
  const { token } = useAuth();

  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'edgeDevices', filter),
    queryFn: async () => {
      const data = await graphqlFetch<{ edgeDevices: EdgeDeviceConnection }>(
        EDGE_DEVICES_QUERY,
        (filter || {}) as Record<string, unknown>,
      );
      return data.edgeDevices;
    },
    staleTime: 10000, // 10 seconds - devices can change status frequently
    refetchInterval: 30000, // Auto-refresh every 30 seconds for online status
    enabled: !!token,
  });
}

/**
 * Hook to fetch single edge device by ID
 */
export function useEdgeDevice(id: string) {
  const { tenantId } = useAuth();
  const { token } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'edgeDevice', id),
    queryFn: async () => {
      const data = await graphqlFetch<{ edgeDevice: EdgeDevice | null }>(
        EDGE_DEVICE_QUERY,
        { id },
      );
      return data.edgeDevice;
    },
    staleTime: 10000,
    enabled: !!token && !!id,
  });
}

/**
 * Hook to fetch edge device statistics for dashboard
 */
export function useEdgeDeviceStats() {
  const { token } = useAuth();

  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'edgeDeviceStats'),
    queryFn: async () => {
      const data = await graphqlFetch<{ edgeDeviceStats: EdgeDeviceStats }>(
        EDGE_DEVICE_STATS_QUERY,
        {},
      );
      return data.edgeDeviceStats;
    },
    staleTime: 15000, // 15 seconds
    refetchInterval: 60000, // Auto-refresh every minute
    enabled: !!token,
  });
}

// ==================== Mutation Hooks ====================

/**
 * Hook to register a new edge device
 */
export function useRegisterEdgeDevice() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useMutation({
    mutationFn: async (input: RegisterEdgeDeviceInput) => {
      const data = await graphqlFetch<{ registerEdgeDevice: EdgeDevice }>(
        REGISTER_EDGE_DEVICE_MUTATION,
        { input },
      );
      return data.registerEdgeDevice;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'edgeDevices') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'edgeDeviceStats') });
    },
  });
}

/**
 * Hook to update an edge device
 */
export function useUpdateEdgeDevice() {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdateEdgeDeviceInput }) => {
      const data = await graphqlFetch<{ updateEdgeDevice: EdgeDevice }>(
        UPDATE_EDGE_DEVICE_MUTATION,
        { id, input },
      );
      return data.updateEdgeDevice;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'edgeDevices') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'edgeDevice', data.id) });
    },
  });
}

/**
 * Hook to approve a registered edge device
 */
export function useApproveEdgeDevice() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useMutation({
    mutationFn: async (id: string) => {
      const data = await graphqlFetch<{ approveEdgeDevice: EdgeDevice }>(
        APPROVE_EDGE_DEVICE_MUTATION,
        { id },
      );
      return data.approveEdgeDevice;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'edgeDevices') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'edgeDevice', data.id) });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'edgeDeviceStats') });
    },
  });
}

/**
 * Hook to set device maintenance mode
 */
export function useSetDeviceMaintenanceMode() {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const data = await graphqlFetch<{ setDeviceMaintenanceMode: EdgeDevice }>(
        SET_DEVICE_MAINTENANCE_MODE_MUTATION,
        { id, enabled },
      );
      return data.setDeviceMaintenanceMode;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'edgeDevices') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'edgeDevice', data.id) });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'edgeDeviceStats') });
    },
  });
}

/**
 * Hook to decommission an edge device
 */
export function useDecommissionEdgeDevice() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const data = await graphqlFetch<{ decommissionEdgeDevice: EdgeDevice }>(
        DECOMMISSION_EDGE_DEVICE_MUTATION,
        { id, reason },
      );
      return data.decommissionEdgeDevice;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'edgeDevices') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'edgeDevice', data.id) });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'edgeDeviceStats') });
    },
  });
}

/**
 * Hook to ping an edge device
 */
export function usePingEdgeDevice() {
  const { token } = useAuth();
  return useMutation({
    mutationFn: async (id: string) => {
      const data = await graphqlFetch<{ pingEdgeDevice: PingResult }>(
        PING_EDGE_DEVICE_MUTATION,
        { id },
      );
      return data.pingEdgeDevice;
    },
  });
}

// ==================== I/O Config Mutation Hooks ====================

/**
 * Hook to add I/O configuration to a device
 */
export function useAddDeviceIoConfig() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useMutation({
    mutationFn: async ({ deviceId, input }: { deviceId: string; input: AddIoConfigInput }) => {
      const data = await graphqlFetch<{ addDeviceIoConfig: DeviceIoConfig }>(
        ADD_DEVICE_IO_CONFIG_MUTATION,
        { deviceId, input },
      );
      return data.addDeviceIoConfig;
    },
    onSuccess: (_, { deviceId }) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'edgeDevice', deviceId) });
    },
  });
}

/**
 * Hook to update I/O configuration
 */
export function useUpdateDeviceIoConfig() {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async ({
      id,
      deviceId,
      input,
    }: {
      id: string;
      deviceId: string;
      input: UpdateIoConfigInput;
    }) => {
      const data = await graphqlFetch<{ updateDeviceIoConfig: DeviceIoConfig }>(
        UPDATE_DEVICE_IO_CONFIG_MUTATION,
        { id, deviceId, input },
      );
      return data.updateDeviceIoConfig;
    },
    onSuccess: (_, { deviceId }) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'edgeDevice', deviceId) });
    },
  });
}

/**
 * Hook to remove I/O configuration
 */
export function useRemoveDeviceIoConfig() {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async ({ id, deviceId }: { id: string; deviceId: string }) => {
      const data = await graphqlFetch<{ removeDeviceIoConfig: boolean }>(
        REMOVE_DEVICE_IO_CONFIG_MUTATION,
        { id, deviceId },
      );
      return data.removeDeviceIoConfig;
    },
    onSuccess: (_, { deviceId }) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'edgeDevice', deviceId) });
    },
  });
}

/**
 * Hook to push I/O configuration to a physical device
 */
export function usePushIoConfig() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useMutation({
    mutationFn: async (deviceId: string) => {
      const data = await graphqlFetch<{
        pushIoConfigToDevice: PushIoConfigResult;
      }>(PUSH_IO_CONFIG_MUTATION, { deviceId });
      return data.pushIoConfigToDevice;
    },
    onSuccess: (_, deviceId) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'edgeDevice', deviceId) });
    },
  });
}

/**
 * setDigitalOutput mutation sonucu — backend SetDigitalOutputResult ile senkronize.
 * Process editor'dan DO tag'i ON/OFF yapıldığında bu sonuç döner.
 */
export interface SetDigitalOutputResult {
  success: boolean;
  error?: string;
  tagName?: string;
  value?: boolean;
}

/**
 * Hook to set a digital output on an edge device.
 * Process editor'daki Output Controls bölümünden kullanılır.
 * Backend'de @Roles(TENANT_ADMIN, MODULE_MANAGER) gerektirir.
 *
 * Kullanım:
 *   const { mutateAsync, isPending } = useSetDigitalOutput();
 *   await mutateAsync({ deviceId, ioConfigId, value: true });
 */
export function useSetDigitalOutput() {
  const { token } = useAuth();
  return useMutation({
    mutationFn: async (input: { deviceId: string; ioConfigId: string; value: boolean }) => {
      const data = await graphqlFetch<{ setDigitalOutput: SetDigitalOutputResult }>(
        SET_DIGITAL_OUTPUT_MUTATION,
        { input },
      );
      return data.setDigitalOutput;
    },
  });
}

// ==================== I/O Auto-Detection Hooks (v2.3) ====================

/**
 * A single I/O channel discovered via hardware scan.
 * Mirrors the backend's DiscoveredIoChannel ObjectType.
 */
export interface DiscoveredIoChannel {
  tagName: string;
  ioType: string;
  dataType: string;
  moduleAddress: number;
  channel: number;
  description?: string;
  gpioPin?: number;
  source: string;
  busType?: string;
  i2cBus?: number;
  i2cAddress?: number;
  i2cDeviceName?: string;
  spiBus?: number;
  spiCs?: number;
  uartPort?: string;
}

export interface I2cDeviceInfo {
  address: number;
  addressHex: string;
  deviceName?: string;
  deviceDescription?: string;
}

export interface I2cBusScanInfo {
  bus: number;
  deviceCount: number;
  devices: I2cDeviceInfo[];
}

export interface SpiBusInfo {
  devicePath: string;
  bus: number;
  chipSelect: number;
}

export interface UartPortInfo {
  devicePath: string;
  portType: string;
}

/**
 * Result of a hardware scan mutation.
 */
export interface HardwareScanResult {
  success: boolean;
  error?: string;
  platform: string;
  discoveredChannels: DiscoveredIoChannel[];
  totalFound: number;
  i2cBuses?: I2cBusScanInfo[];
  spiBuses?: SpiBusInfo[];
  uartPorts?: UartPortInfo[];
}

/**
 * Result of bulk I/O config import.
 */
export interface BulkAddIoConfigResult {
  created: DeviceIoConfig[];
  skipped: string[];
  createdCount: number;
  skippedCount: number;
}

/**
 * Hook to scan edge device hardware for available I/O channels.
 *
 * Sends a scan_hardware command to the agent via MQTT (15s timeout).
 * Returns platform info and discovered I/O channels for import.
 *
 * Usage:
 *   const scan = useScanHardware();
 *   const result = await scan.mutateAsync(deviceId);
 *   if (result.success) console.log(result.discoveredChannels);
 */
export function useScanHardware() {
  const { token } = useAuth();
  return useMutation({
    mutationFn: async (deviceId: string) => {
      const data = await graphqlFetch<{
        scanEdgeDeviceHardware: HardwareScanResult;
      }>(SCAN_HARDWARE_MUTATION, { deviceId });
      return data.scanEdgeDeviceHardware;
    },
  });
}

/**
 * Hook to bulk add I/O configurations from auto-detection results.
 *
 * Skips channels whose tagName already exists on the device (no duplicates).
 * Invalidates the device query to refresh the I/O config list.
 *
 * Usage:
 *   const { mutateAsync, isPending } = useBulkAddIoConfig();
 *   const result = await mutateAsync({ deviceId, inputs: selectedChannels });
 */
export function useBulkAddIoConfig() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useMutation({
    mutationFn: async ({
      deviceId,
      inputs,
    }: {
      deviceId: string;
      inputs: AddIoConfigInput[];
    }) => {
      const data = await graphqlFetch<{
        bulkAddDeviceIoConfigs: BulkAddIoConfigResult;
      }>(BULK_ADD_IO_CONFIG_MUTATION, { deviceId, inputs });
      return data.bulkAddDeviceIoConfigs;
    },
    onSuccess: (_, { deviceId }) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'edgeDevice', deviceId) });
    },
  });
}

// ==================== Install Commands Hook ====================

/**
 * Hook to fetch install/uninstall commands for a device
 * Used in device settings tab
 */
export function useDeviceInstallCommands(deviceId: string) {
  const { token } = useAuth();

  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'deviceInstallCommands', deviceId),
    queryFn: async () => {
      const data = await graphqlFetch<{ deviceInstallCommands: DeviceInstallCommands }>(
        DEVICE_INSTALL_COMMANDS_QUERY,
        { deviceId },
      );
      return data.deviceInstallCommands;
    },
    staleTime: 60000, // 1 minute — commands don't change often
    enabled: !!token && !!deviceId,
  });
}

// ==================== Provisioning Mutation Hooks ====================

/**
 * Hook to create a provisioned edge device
 * Returns installer URL and command for zero-touch setup
 */
export function useCreateProvisionedDevice() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useMutation({
    mutationFn: async (input: CreateProvisionedDeviceInput) => {
      const data = await graphqlFetch<{ createProvisionedDevice: ProvisionedDeviceResponse }>(
        CREATE_PROVISIONED_DEVICE_MUTATION,
        { input },
      );
      return data.createProvisionedDevice;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'edgeDevices') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'edgeDeviceStats') });
    },
  });
}

/**
 * Hook to regenerate provisioning token for a device
 * Used when the original token expires before activation
 */
export function useRegenerateDeviceToken() {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async (deviceId: string) => {
      const data = await graphqlFetch<{ regenerateDeviceToken: RegenerateTokenResponse }>(
        REGENERATE_DEVICE_TOKEN_MUTATION,
        { deviceId },
      );
      return data.regenerateDeviceToken;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'edgeDevice', data.deviceId) });
    },
  });
}

// ==================== Firmware Management Hooks ====================

export interface FirmwareVersionInfo {
  tag: string;
  name: string;
  publishedAt: string;
  prerelease: boolean;
}

export interface BulkFirmwareUpdateResult {
  success: string[];
  failed: { id: string; error: string }[];
}

/**
 * Hook to fetch available firmware versions from GitHub releases
 */
export function useAvailableFirmwareVersions() {
  const { token } = useAuth();

  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'availableFirmwareVersions'),
    queryFn: async () => {
      const data = await graphqlFetch<{ availableFirmwareVersions: FirmwareVersionInfo[] }>(
        AVAILABLE_FIRMWARE_VERSIONS_QUERY,
        {},
      );
      return data.availableFirmwareVersions;
    },
    staleTime: 60000, // 1 minute — releases don't change often
    enabled: !!token,
  });
}

/**
 * Hook to trigger firmware update on a single edge device
 */
export function useUpdateEdgeDeviceFirmware() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useMutation({
    mutationFn: async ({ id, targetVersion }: { id: string; targetVersion?: string }) => {
      const data = await graphqlFetch<{ updateEdgeDeviceFirmware: boolean }>(
        UPDATE_EDGE_DEVICE_FIRMWARE_MUTATION,
        { id, targetVersion },
      );
      return data.updateEdgeDeviceFirmware;
    },
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'edgeDevices') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'edgeDevice', id) });
    },
  });
}

/**
 * Hook to trigger firmware update on multiple edge devices
 */
export function useBulkUpdateEdgeDeviceFirmware() {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async ({ deviceIds, targetVersion }: { deviceIds: string[]; targetVersion?: string }) => {
      const data = await graphqlFetch<{ bulkUpdateEdgeDeviceFirmware: BulkFirmwareUpdateResult }>(
        BULK_UPDATE_EDGE_DEVICE_FIRMWARE_MUTATION,
        { deviceIds, targetVersion },
      );
      return data.bulkUpdateEdgeDeviceFirmware;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'edgeDevices') });
    },
  });
}

// ==================== Utility Functions ====================

/**
 * Get device status color based on lifecycle state
 */
export function getDeviceStatusColor(state: DeviceLifecycleState): string {
  switch (state) {
    case DeviceLifecycleState.ACTIVE:
      return 'green';
    case DeviceLifecycleState.OFFLINE:
      return 'gray';
    case DeviceLifecycleState.MAINTENANCE:
      return 'yellow';
    case DeviceLifecycleState.ERROR:
      return 'red';
    case DeviceLifecycleState.REGISTERED:
    case DeviceLifecycleState.PROVISIONING:
    case DeviceLifecycleState.PENDING_APPROVAL:
      return 'blue';
    case DeviceLifecycleState.REVOKED:
    case DeviceLifecycleState.DECOMMISSIONED:
      return 'gray';
    default:
      return 'gray';
  }
}

/**
 * Get device status display text
 */
export function getDeviceStatusText(state: DeviceLifecycleState): string {
  switch (state) {
    case DeviceLifecycleState.REGISTERED:
      return 'Registered';
    case DeviceLifecycleState.PROVISIONING:
      return 'Provisioning';
    case DeviceLifecycleState.PENDING_APPROVAL:
      return 'Pending Approval';
    case DeviceLifecycleState.ACTIVE:
      return 'Active';
    case DeviceLifecycleState.OFFLINE:
      return 'Offline';
    case DeviceLifecycleState.MAINTENANCE:
      return 'Maintenance';
    case DeviceLifecycleState.ERROR:
      return 'Error';
    case DeviceLifecycleState.REVOKED:
      return 'Revoked';
    case DeviceLifecycleState.DECOMMISSIONED:
      return 'Decommissioned';
    default:
      return 'Unknown';
  }
}

/**
 * Get device model display text
 */
export function getDeviceModelText(model: DeviceModel): string {
  switch (model) {
    case DeviceModel.REVOLUTION_PI_CONNECT_4:
      return 'RevPi Connect 4';
    case DeviceModel.REVOLUTION_PI_COMPACT:
      return 'RevPi Compact';
    case DeviceModel.RASPBERRY_PI_4:
      return 'Raspberry Pi 4';
    case DeviceModel.RASPBERRY_PI_5:
      return 'Raspberry Pi 5';
    case DeviceModel.INDUSTRIAL_PC:
      return 'Industrial PC';
    case DeviceModel.CUSTOM:
      return 'Custom';
    default:
      return 'Unknown';
  }
}

/**
 * Format last seen time as relative time
 */
export function formatLastSeen(lastSeenAt: string | undefined): string {
  if (!lastSeenAt) return 'Never';

  const lastSeen = new Date(lastSeenAt);
  const now = new Date();
  const diffMs = now.getTime() - lastSeen.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'Just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffHour < 24) return `${diffHour} hour${diffHour > 1 ? 's' : ''} ago`;
  if (diffDay < 7) return `${diffDay} day${diffDay > 1 ? 's' : ''} ago`;

  return lastSeen.toLocaleDateString();
}

/**
 * Get health status based on metrics
 */
export function getHealthStatus(device: EdgeDevice): 'good' | 'warning' | 'critical' {
  const { cpuUsage, memoryUsage, storageUsage, temperatureCelsius } = device;

  // Critical thresholds
  if (
    (cpuUsage && cpuUsage > 90) ||
    (memoryUsage && memoryUsage > 95) ||
    (storageUsage && storageUsage > 95) ||
    (temperatureCelsius && temperatureCelsius > 80)
  ) {
    return 'critical';
  }

  // Warning thresholds
  if (
    (cpuUsage && cpuUsage > 70) ||
    (memoryUsage && memoryUsage > 80) ||
    (storageUsage && storageUsage > 80) ||
    (temperatureCelsius && temperatureCelsius > 65)
  ) {
    return 'warning';
  }

  return 'good';
}

/**
 * Get I/O type display text
 */
export function getIoTypeText(type: IoType): string {
  switch (type) {
    case IoType.DI:
      return 'Digital Input';
    case IoType.DO:
      return 'Digital Output';
    case IoType.AI:
      return 'Analog Input';
    case IoType.AO:
      return 'Analog Output';
    default:
      return 'Unknown';
  }
}
