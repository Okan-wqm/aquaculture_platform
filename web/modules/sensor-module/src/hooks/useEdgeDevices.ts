/**
 * Edge Device hooks for Industrial IoT Fleet Management
 * IEC 62443 compliant device lifecycle management
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@aquaculture/shared-ui';
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
  CREATE_PROVISIONED_DEVICE_MUTATION,
  REGENERATE_DEVICE_TOKEN_MUTATION,
} from '../graphql/edge-device.queries';

// ==================== Types ====================

export enum DeviceLifecycleState {
  REGISTERED = 'registered',
  PROVISIONING = 'provisioning',
  PENDING_APPROVAL = 'pending_approval',
  ACTIVE = 'active',
  OFFLINE = 'offline',
  MAINTENANCE = 'maintenance',
  ERROR = 'error',
  REVOKED = 'revoked',
  DECOMMISSIONED = 'decommissioned',
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
  DI = 'digital_input',
  DO = 'digital_output',
  AI = 'analog_input',
  AO = 'analog_output',
}

export enum IoDataType {
  BOOL = 'bool',
  INT16 = 'int16',
  INT32 = 'int32',
  FLOAT32 = 'float32',
  FLOAT64 = 'float64',
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
  message?: string;
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

// ==================== GraphQL Fetch Helper ====================

async function graphqlFetch<T>(
  query: string,
  variables: Record<string, unknown>,
  token?: string
): Promise<T> {
  const response = await fetch('/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });

  const result = await response.json();

  if (result.errors) {
    throw new Error(result.errors[0]?.message || 'GraphQL Error');
  }

  return result.data;
}

// ==================== Query Hooks ====================

/**
 * Hook to fetch paginated edge device list
 */
export function useEdgeDevices(filter?: EdgeDeviceFilter) {
  const { token } = useAuth();

  return useQuery({
    queryKey: ['edgeDevices', filter],
    queryFn: async () => {
      const data = await graphqlFetch<{ edgeDevices: EdgeDeviceConnection }>(
        EDGE_DEVICES_QUERY,
        filter || {},
        token
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
  const { token } = useAuth();

  return useQuery({
    queryKey: ['edgeDevice', id],
    queryFn: async () => {
      const data = await graphqlFetch<{ edgeDevice: EdgeDevice | null }>(
        EDGE_DEVICE_QUERY,
        { id },
        token
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

  return useQuery({
    queryKey: ['edgeDeviceStats'],
    queryFn: async () => {
      const data = await graphqlFetch<{ edgeDeviceStats: EdgeDeviceStats }>(
        EDGE_DEVICE_STATS_QUERY,
        {},
        token
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

  return useMutation({
    mutationFn: async (input: RegisterEdgeDeviceInput) => {
      const data = await graphqlFetch<{ registerEdgeDevice: EdgeDevice }>(
        REGISTER_EDGE_DEVICE_MUTATION,
        { input },
        token
      );
      return data.registerEdgeDevice;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['edgeDevices'] });
      queryClient.invalidateQueries({ queryKey: ['edgeDeviceStats'] });
    },
  });
}

/**
 * Hook to update an edge device
 */
export function useUpdateEdgeDevice() {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdateEdgeDeviceInput }) => {
      const data = await graphqlFetch<{ updateEdgeDevice: EdgeDevice }>(
        UPDATE_EDGE_DEVICE_MUTATION,
        { id, input },
        token
      );
      return data.updateEdgeDevice;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['edgeDevices'] });
      queryClient.invalidateQueries({ queryKey: ['edgeDevice', data.id] });
    },
  });
}

/**
 * Hook to approve a registered edge device
 */
export function useApproveEdgeDevice() {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const data = await graphqlFetch<{ approveEdgeDevice: EdgeDevice }>(
        APPROVE_EDGE_DEVICE_MUTATION,
        { id },
        token
      );
      return data.approveEdgeDevice;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['edgeDevices'] });
      queryClient.invalidateQueries({ queryKey: ['edgeDevice', data.id] });
      queryClient.invalidateQueries({ queryKey: ['edgeDeviceStats'] });
    },
  });
}

/**
 * Hook to set device maintenance mode
 */
export function useSetDeviceMaintenanceMode() {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const data = await graphqlFetch<{ setDeviceMaintenanceMode: EdgeDevice }>(
        SET_DEVICE_MAINTENANCE_MODE_MUTATION,
        { id, enabled },
        token
      );
      return data.setDeviceMaintenanceMode;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['edgeDevices'] });
      queryClient.invalidateQueries({ queryKey: ['edgeDevice', data.id] });
      queryClient.invalidateQueries({ queryKey: ['edgeDeviceStats'] });
    },
  });
}

/**
 * Hook to decommission an edge device
 */
export function useDecommissionEdgeDevice() {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const data = await graphqlFetch<{ decommissionEdgeDevice: EdgeDevice }>(
        DECOMMISSION_EDGE_DEVICE_MUTATION,
        { id, reason },
        token
      );
      return data.decommissionEdgeDevice;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['edgeDevices'] });
      queryClient.invalidateQueries({ queryKey: ['edgeDevice', data.id] });
      queryClient.invalidateQueries({ queryKey: ['edgeDeviceStats'] });
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
        token
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

  return useMutation({
    mutationFn: async ({ deviceId, input }: { deviceId: string; input: AddIoConfigInput }) => {
      const data = await graphqlFetch<{ addDeviceIoConfig: DeviceIoConfig }>(
        ADD_DEVICE_IO_CONFIG_MUTATION,
        { deviceId, input },
        token
      );
      return data.addDeviceIoConfig;
    },
    onSuccess: (_, { deviceId }) => {
      queryClient.invalidateQueries({ queryKey: ['edgeDevice', deviceId] });
    },
  });
}

/**
 * Hook to update I/O configuration
 */
export function useUpdateDeviceIoConfig() {
  const { token } = useAuth();
  const queryClient = useQueryClient();

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
        token
      );
      return data.updateDeviceIoConfig;
    },
    onSuccess: (_, { deviceId }) => {
      queryClient.invalidateQueries({ queryKey: ['edgeDevice', deviceId] });
    },
  });
}

/**
 * Hook to remove I/O configuration
 */
export function useRemoveDeviceIoConfig() {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, deviceId }: { id: string; deviceId: string }) => {
      const data = await graphqlFetch<{ removeDeviceIoConfig: boolean }>(
        REMOVE_DEVICE_IO_CONFIG_MUTATION,
        { id, deviceId },
        token
      );
      return data.removeDeviceIoConfig;
    },
    onSuccess: (_, { deviceId }) => {
      queryClient.invalidateQueries({ queryKey: ['edgeDevice', deviceId] });
    },
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

  return useMutation({
    mutationFn: async (input: CreateProvisionedDeviceInput) => {
      const data = await graphqlFetch<{ createProvisionedDevice: ProvisionedDeviceResponse }>(
        CREATE_PROVISIONED_DEVICE_MUTATION,
        { input },
        token
      );
      return data.createProvisionedDevice;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['edgeDevices'] });
      queryClient.invalidateQueries({ queryKey: ['edgeDeviceStats'] });
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

  return useMutation({
    mutationFn: async (deviceId: string) => {
      const data = await graphqlFetch<{ regenerateDeviceToken: RegenerateTokenResponse }>(
        REGENERATE_DEVICE_TOKEN_MUTATION,
        { deviceId },
        token
      );
      return data.regenerateDeviceToken;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['edgeDevice', data.deviceId] });
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
