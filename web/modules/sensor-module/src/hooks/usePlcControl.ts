/**
 * PLC Control Hooks
 *
 * React hooks for PLC connection management, feeding parameters,
 * alarm monitoring, and telemetry data access.
 * Uses sensor-service PlcControlResolver via GraphQL.
 */

import { useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, createTenantQueryKey, createTenantInvalidationKey } from '@aquaculture/shared-ui';
import { graphqlFetch } from '../config/api';
import {
  // Connection queries
  PLC_CONNECTIONS_QUERY,
  PLC_CONNECTION_QUERY,
  PLC_CONNECTION_COUNT_BY_STATUS_QUERY,
  ONLINE_PLC_CONNECTIONS_QUERY,
  // Connection mutations
  CREATE_PLC_CONNECTION_MUTATION,
  UPDATE_PLC_CONNECTION_MUTATION,
  DELETE_PLC_CONNECTION_MUTATION,
  TEST_PLC_CONNECTION_MUTATION,
  ACTIVATE_PLC_CONNECTION_MUTATION,
  DEACTIVATE_PLC_CONNECTION_MUTATION,
  // Feeding parameter queries
  FEEDING_PARAMETERS_QUERY,
  FEEDING_PARAMETER_QUERY,
  ACTIVE_FEEDING_PARAMETER_QUERY,
  FEEDING_PARAMETER_HISTORY_QUERY,
  // Feeding parameter mutations
  CREATE_FEEDING_PARAMETER_MUTATION,
  UPDATE_FEEDING_PARAMETER_MUTATION,
  DELETE_FEEDING_PARAMETER_MUTATION,
  SEND_FEEDING_PARAMETER_TO_PLC_MUTATION,
  ACTIVATE_FEEDING_PARAMETER_MUTATION,
  CLONE_FEEDING_PARAMETER_MUTATION,
  // Alarm queries
  PLC_ALARMS_QUERY,
  ACTIVE_PLC_ALARMS_QUERY,
  UNACKNOWLEDGED_PLC_ALARMS_QUERY,
  PLC_ALARM_STATS_QUERY,
  // Alarm mutations
  ACKNOWLEDGE_PLC_ALARM_MUTATION,
  BULK_ACKNOWLEDGE_PLC_ALARMS_MUTATION,
  ACKNOWLEDGE_ALL_ALARMS_FOR_CONNECTION_MUTATION,
  // Telemetry queries
  LATEST_TELEMETRY_SUMMARY_QUERY,
  ALL_CONNECTIONS_TELEMETRY_SUMMARY_QUERY,
  PLC_TELEMETRY_STATS_QUERY,
  FEEDING_STATS_QUERY,
  ACTUATOR_USAGE_STATS_QUERY,
  DISCOVER_OPCUA_ENDPOINTS_QUERY,
  BROWSE_OPCUA_NODES_QUERY,
} from '../graphql/plc.operations';

// ============================================================================
// Types
// ============================================================================

export type PlcConnectionStatus = 'ONLINE' | 'OFFLINE' | 'CONNECTING' | 'ERROR';
export type PlcSecurityMode = 'None' | 'Sign' | 'SignAndEncrypt';
export type PlcAuthMode = 'Anonymous' | 'Username' | 'Certificate';
export type ParameterStatus = 'DRAFT' | 'PENDING' | 'SENT' | 'ACKNOWLEDGED' | 'ACTIVE' | 'SUPERSEDED' | 'ERROR';
export type AlarmSeverity = 'INFO' | 'WARNING' | 'CRITICAL' | 'EMERGENCY';
export type AlarmSource = 'OXYGEN_SENSOR' | 'TEMPERATURE_SENSOR' | 'PH_SENSOR' | 'FLOW_SENSOR' | 'BLOWER_VFD' | 'DOSER_VFD' | 'FEEDING_SYSTEM' | 'PLC_SYSTEM' | 'COMMUNICATION';

export interface TelemetrySummary {
  plcConnectionId: string;
  timestamp: string;
  oxygen?: number;
  temperature?: number;
  ph?: number;
  flowRate?: number;
  blowerSpeed?: number;
  doserSpeed?: number;
  aerationOn?: boolean;
  feedingInProgress?: boolean;
  plcMode?: string;
  activeAlarmCount?: number;
}

export interface PlcConnection {
  id: string;
  name: string;
  description?: string;
  endpointUrl: string;
  siteId: string;
  tankId?: string;
  securityMode: PlcSecurityMode;
  securityPolicy?: string;
  authMode: PlcAuthMode;
  username?: string;
  status: PlcConnectionStatus;
  lastConnectedAt?: string;
  lastError?: string;
  publishingIntervalMs: number;
  samplingIntervalMs: number;
  sessionTimeoutMs: number;
  parametersNodeId?: string;
  telemetryNodeId?: string;
  alarmsNodeId?: string;
  statusNodeId?: string;
  clientCertificate?: string;
  clientPrivateKey?: string;
  serverCertificate?: string;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  autoReconnect: boolean;
  maxReconnectAttempts: number;
  reconnectDelayMs: number;
  maxReconnectDelayMs: number;
  keepAliveIntervalMs: number;
  failoverEndpointUrl?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  activeAlarmCount?: number;
  latestTelemetry?: TelemetrySummary;
}

export interface PlcConnectionCountByStatus {
  online: number;
  offline: number;
  connecting: number;
  error: number;
}

export interface PlcConnectionTestResult {
  success: boolean;
  latencyMs?: number;
  error?: string;
  errorCode?: string;
  serverInfo?: string;
  testedAt: string;
}

export interface DiscoveredEndpoint {
  endpointUrl: string;
  securityMode: string;
  securityPolicy: string;
  securityLevel: number;
  serverCertificate?: string;
  transportProfileUri?: string;
}

export interface NodeBrowseResult {
  nodeId: string;
  browseName: string;
  displayName: string;
  nodeClass: string;
  dataType?: string;
  hasChildren: boolean;
  description?: string;
  value?: string;
}

export interface CreatePlcConnectionInput {
  name: string;
  description?: string;
  endpointUrl: string;
  siteId: string;
  tankId?: string;
  securityMode?: PlcSecurityMode;
  securityPolicy?: string;
  authMode?: PlcAuthMode;
  username?: string;
  password?: string;
  publishingIntervalMs?: number;
  samplingIntervalMs?: number;
  sessionTimeoutMs?: number;
  parametersNodeId?: string;
  telemetryNodeId?: string;
  alarmsNodeId?: string;
  statusNodeId?: string;
  clientCertificate?: string;
  clientPrivateKey?: string;
  serverCertificate?: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  autoReconnect?: boolean;
  maxReconnectAttempts?: number;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  keepAliveIntervalMs?: number;
  failoverEndpointUrl?: string;
}

export interface UpdatePlcConnectionInput {
  name?: string;
  description?: string;
  endpointUrl?: string;
  tankId?: string;
  securityMode?: PlcSecurityMode;
  securityPolicy?: string;
  authMode?: PlcAuthMode;
  username?: string;
  password?: string;
  publishingIntervalMs?: number;
  samplingIntervalMs?: number;
  sessionTimeoutMs?: number;
  parametersNodeId?: string;
  telemetryNodeId?: string;
  alarmsNodeId?: string;
  statusNodeId?: string;
  clientCertificate?: string;
  clientPrivateKey?: string;
  serverCertificate?: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  autoReconnect?: boolean;
  maxReconnectAttempts?: number;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  keepAliveIntervalMs?: number;
  failoverEndpointUrl?: string;
  isActive?: boolean;
}

export interface FeedingScheduleEntry {
  time: string;
  feedType?: string;
  amountKg: number;
  durationSeconds?: number;
  blowerSpeedPercent?: number;
  doserSpeedPercent?: number;
}

export interface ThresholdConfig {
  oxygenMin: number;
  oxygenCritical: number;
  tempMax: number;
  tempCritical: number;
  phMin?: number;
  phMax?: number;
}

export interface VfdSettings {
  blowerMinSpeed: number;
  blowerMaxSpeed: number;
  doserMinSpeed: number;
  doserMaxSpeed: number;
}

export interface FeedingParameter {
  id: string;
  plcConnectionId: string;
  tankId?: string;
  name: string;
  description?: string;
  version: string;
  biomassKg: number;
  fcr: number;
  targetDailyFeedKg: number;
  schedule: FeedingScheduleEntry[];
  thresholds: ThresholdConfig;
  vfdSettings: VfdSettings;
  status: ParameterStatus;
  sentAt?: string;
  acknowledgedAt?: string;
  activatedAt?: string;
  errorMessage?: string;
  checksum?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  connection?: { id: string; name: string; status: PlcConnectionStatus };
}

export interface CreateFeedingParameterInput {
  plcConnectionId: string;
  tankId?: string;
  name: string;
  description?: string;
  version?: string;
  biomassKg: number;
  fcr: number;
  targetDailyFeedKg: number;
  schedule: FeedingScheduleEntry[];
  thresholds: ThresholdConfig;
  vfdSettings: VfdSettings;
}

export interface UpdateFeedingParameterInput {
  tankId?: string;
  name?: string;
  description?: string;
  version?: string;
  biomassKg?: number;
  fcr?: number;
  targetDailyFeedKg?: number;
  schedule?: FeedingScheduleEntry[];
  thresholds?: ThresholdConfig;
  vfdSettings?: VfdSettings;
}

export interface ParameterSendResult {
  success: boolean;
  checksum?: string;
  error?: string;
  sentAt: string;
}

export interface PlcAlarm {
  id: string;
  plcConnectionId: string;
  tankId?: string;
  alarmCode: string;
  severity: AlarmSeverity;
  source: AlarmSource;
  message: string;
  value?: number;
  threshold?: number;
  action?: string;
  timestamp: string;
  acknowledged: boolean;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  clearedAt?: string;
  notes?: string;
  createdAt: string;
}

export interface PlcAlarmStats {
  totalActive: number;
  totalUnacknowledged: number;
  criticalCount: number;
  emergencyCount: number;
  warningCount: number;
  infoCount: number;
  last24HoursCount: number;
  last7DaysCount: number;
}

export interface AlarmCountBySeverity {
  info: number;
  warning: number;
  critical: number;
  emergency: number;
}

export interface SensorStats {
  min?: number;
  max?: number;
  avg?: number;
  stdDev?: number;
  count: number;
}

export interface PlcTelemetryStats {
  plcConnectionId: string;
  from: string;
  to: string;
  totalRecords: number;
  oxygen: SensorStats;
  temperature: SensorStats;
  ph?: SensorStats;
  flowRate?: SensorStats;
}

export interface FeedingStats {
  totalFeedKg: number;
  totalFeedings: number;
  avgFeedingAmountKg: number;
  lastFeedingTime?: string;
  lastFeedingAmountKg?: number;
}

export interface ActuatorUsageStats {
  avgBlowerSpeed: number;
  avgDoserSpeed: number;
  aerationOnTimePercent: number;
  feedingTimePercent: number;
}

export interface PlcConnectionFilter {
  status?: PlcConnectionStatus;
  siteId?: string;
  tankId?: string;
  search?: string;
  isActive?: boolean;
}

export interface FeedingParameterFilter {
  plcConnectionId?: string;
  tankId?: string;
  status?: ParameterStatus;
  search?: string;
}

export interface PlcAlarmFilter {
  plcConnectionId?: string;
  tankId?: string;
  severity?: AlarmSeverity;
  source?: AlarmSource;
  acknowledged?: boolean;
  fromDate?: string;
  toDate?: string;
  search?: string;
}

export interface PlcPagination {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
}

// ============================================================================
// PLC Connection Hooks
// ============================================================================

export function usePlcConnections(
  filter?: PlcConnectionFilter,
  pagination?: PlcPagination,
) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'plcConnections', filter, pagination),
    queryFn: async () => {
      const data = await graphqlFetch<{ plcConnections: { items: PlcConnection[] } }>(
        PLC_CONNECTIONS_QUERY,
        { filter, pagination },
      );
      return data.plcConnections.items;
    },
    staleTime: 15000,
    enabled: !!tenantId,
  });
}

export function usePlcConnection(id: string) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'plcConnection', id),
    queryFn: async () => {
      const data = await graphqlFetch<{ plcConnection: PlcConnection | null }>(
        PLC_CONNECTION_QUERY,
        { id },
      );
      return data.plcConnection;
    },
    staleTime: 15000,
    enabled: !!id && !!tenantId,
  });
}

export function usePlcConnectionCountByStatus() {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'plcConnectionCountByStatus'),
    queryFn: async () => {
      const data = await graphqlFetch<{ plcConnectionCountByStatus: PlcConnectionCountByStatus }>(
        PLC_CONNECTION_COUNT_BY_STATUS_QUERY,
        {},
      );
      return data.plcConnectionCountByStatus;
    },
    staleTime: 15000,
    enabled: !!tenantId,
  });
}

export function useOnlinePlcConnections() {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'onlinePlcConnections'),
    queryFn: async () => {
      const data = await graphqlFetch<{ onlinePlcConnections: PlcConnection[] }>(
        ONLINE_PLC_CONNECTIONS_QUERY,
        {},
      );
      return data.onlinePlcConnections;
    },
    staleTime: 15000,
    enabled: !!tenantId,
  });
}

export function usePlcConnectionMutations() {
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'plcConnections') });
    queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'plcConnectionCountByStatus') });
    queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'onlinePlcConnections') });
  }, [queryClient]);

  const createMutation = useMutation({
    mutationFn: async (input: CreatePlcConnectionInput) => {
      const data = await graphqlFetch<{ createPlcConnection: PlcConnection }>(
        CREATE_PLC_CONNECTION_MUTATION,
        { input },
      );
      return data.createPlcConnection;
    },
    onSuccess: invalidate,
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdatePlcConnectionInput }) => {
      const data = await graphqlFetch<{ updatePlcConnection: PlcConnection }>(
        UPDATE_PLC_CONNECTION_MUTATION,
        { id, input },
      );
      return data.updatePlcConnection;
    },
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const data = await graphqlFetch<{ deletePlcConnection: boolean }>(
        DELETE_PLC_CONNECTION_MUTATION,
        { id },
      );
      return data.deletePlcConnection;
    },
    onSuccess: invalidate,
  });

  const testMutation = useMutation({
    mutationFn: async (id: string) => {
      const data = await graphqlFetch<{ testPlcConnection: PlcConnectionTestResult }>(
        TEST_PLC_CONNECTION_MUTATION,
        { id },
      );
      return data.testPlcConnection;
    },
  });

  const activateMutation = useMutation({
    mutationFn: async (id: string) => {
      const data = await graphqlFetch<{ activatePlcConnection: PlcConnection }>(
        ACTIVATE_PLC_CONNECTION_MUTATION,
        { id },
      );
      return data.activatePlcConnection;
    },
    onSuccess: invalidate,
  });

  const deactivateMutation = useMutation({
    mutationFn: async (id: string) => {
      const data = await graphqlFetch<{ deactivatePlcConnection: PlcConnection }>(
        DEACTIVATE_PLC_CONNECTION_MUTATION,
        { id },
      );
      return data.deactivatePlcConnection;
    },
    onSuccess: invalidate,
  });

  return {
    create: createMutation,
    update: updateMutation,
    remove: deleteMutation,
    test: testMutation,
    activate: activateMutation,
    deactivate: deactivateMutation,
  };
}

export function useDiscoverEndpoints(endpointUrl: string) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'discoverEndpoints', endpointUrl),
    queryFn: async () => {
      const data = await graphqlFetch<{ discoverOpcUaEndpoints: DiscoveredEndpoint[] }>(
        DISCOVER_OPCUA_ENDPOINTS_QUERY,
        { endpointUrl },
      );
      return data.discoverOpcUaEndpoints;
    },
    enabled: false, // Manual trigger only
    staleTime: 30000,
  });
}

export function useBrowseOpcUaNodes(plcConnectionId: string, parentNodeId?: string) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'browseOpcUaNodes', plcConnectionId, parentNodeId),
    queryFn: async () => {
      const data = await graphqlFetch<{ browseOpcUaNodes: NodeBrowseResult[] }>(
        BROWSE_OPCUA_NODES_QUERY,
        { plcConnectionId, parentNodeId },
      );
      return data.browseOpcUaNodes;
    },
    enabled: false, // Manual trigger only
    staleTime: 30000,
  });
}

// ============================================================================
// Feeding Parameter Hooks
// ============================================================================

export function useFeedingParameters(
  filter?: FeedingParameterFilter,
  pagination?: PlcPagination,
) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'feedingParameters', filter, pagination),
    queryFn: async () => {
      const data = await graphqlFetch<{ feedingParameters: { items: FeedingParameter[] } }>(
        FEEDING_PARAMETERS_QUERY,
        { filter, pagination },
      );
      return data.feedingParameters.items;
    },
    staleTime: 15000,
    enabled: !!tenantId,
  });
}

export function useFeedingParameter(id: string) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'feedingParameter', id),
    queryFn: async () => {
      const data = await graphqlFetch<{ feedingParameter: FeedingParameter | null }>(
        FEEDING_PARAMETER_QUERY,
        { id },
      );
      return data.feedingParameter;
    },
    staleTime: 15000,
    enabled: !!id && !!tenantId,
  });
}

export function useActiveFeedingParameter(plcConnectionId: string) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'activeFeedingParameter', plcConnectionId),
    queryFn: async () => {
      const data = await graphqlFetch<{ activeFeedingParameter: FeedingParameter | null }>(
        ACTIVE_FEEDING_PARAMETER_QUERY,
        { plcConnectionId },
      );
      return data.activeFeedingParameter;
    },
    staleTime: 15000,
    enabled: !!plcConnectionId,
  });
}

export function useFeedingParameterHistory(plcConnectionId: string, limit = 10) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'feedingParameterHistory', plcConnectionId, limit),
    queryFn: async () => {
      const data = await graphqlFetch<{ feedingParameterHistory: FeedingParameter[] }>(
        FEEDING_PARAMETER_HISTORY_QUERY,
        { plcConnectionId, limit },
      );
      return data.feedingParameterHistory;
    },
    staleTime: 15000,
    enabled: !!plcConnectionId,
  });
}

export function useFeedingParameterMutations() {
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'feedingParameters') });
    queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'feedingParameter') });
    queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'activeFeedingParameter') });
    queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'feedingParameterHistory') });
  }, [queryClient]);

  const createMutation = useMutation({
    mutationFn: async (input: CreateFeedingParameterInput) => {
      const data = await graphqlFetch<{ createFeedingParameter: FeedingParameter }>(
        CREATE_FEEDING_PARAMETER_MUTATION,
        { input },
      );
      return data.createFeedingParameter;
    },
    onSuccess: invalidate,
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdateFeedingParameterInput }) => {
      const data = await graphqlFetch<{ updateFeedingParameter: FeedingParameter }>(
        UPDATE_FEEDING_PARAMETER_MUTATION,
        { id, input },
      );
      return data.updateFeedingParameter;
    },
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const data = await graphqlFetch<{ deleteFeedingParameter: boolean }>(
        DELETE_FEEDING_PARAMETER_MUTATION,
        { id },
      );
      return data.deleteFeedingParameter;
    },
    onSuccess: invalidate,
  });

  const sendToPlcMutation = useMutation({
    mutationFn: async (id: string) => {
      const data = await graphqlFetch<{ sendFeedingParameterToPlc: ParameterSendResult }>(
        SEND_FEEDING_PARAMETER_TO_PLC_MUTATION,
        { id },
      );
      return data.sendFeedingParameterToPlc;
    },
    onSuccess: invalidate,
  });

  const activateMutation = useMutation({
    mutationFn: async (id: string) => {
      const data = await graphqlFetch<{ activateFeedingParameter: FeedingParameter }>(
        ACTIVATE_FEEDING_PARAMETER_MUTATION,
        { id },
      );
      return data.activateFeedingParameter;
    },
    onSuccess: invalidate,
  });

  const cloneMutation = useMutation({
    mutationFn: async ({ id, newName }: { id: string; newName?: string }) => {
      const data = await graphqlFetch<{ cloneFeedingParameter: FeedingParameter }>(
        CLONE_FEEDING_PARAMETER_MUTATION,
        { id, newName },
      );
      return data.cloneFeedingParameter;
    },
    onSuccess: invalidate,
  });

  return {
    create: createMutation,
    update: updateMutation,
    remove: deleteMutation,
    sendToPlc: sendToPlcMutation,
    activate: activateMutation,
    clone: cloneMutation,
  };
}

// ============================================================================
// PLC Alarm Hooks
// ============================================================================

export function usePlcAlarms(
  filter?: PlcAlarmFilter,
  pagination?: PlcPagination,
) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'plcAlarms', filter, pagination),
    queryFn: async () => {
      const data = await graphqlFetch<{ plcAlarms: { items: PlcAlarm[] } }>(
        PLC_ALARMS_QUERY,
        { filter, pagination },
      );
      return data.plcAlarms.items;
    },
    staleTime: 10000,
    refetchInterval: 30000,
    enabled: !!tenantId,
  });
}

export function useActivePlcAlarms(plcConnectionId?: string) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'activePlcAlarms', plcConnectionId),
    queryFn: async () => {
      const data = await graphqlFetch<{ activePlcAlarms: PlcAlarm[] }>(
        ACTIVE_PLC_ALARMS_QUERY,
        { plcConnectionId },
      );
      return data.activePlcAlarms;
    },
    staleTime: 10000,
    refetchInterval: 15000,
    enabled: !!tenantId,
  });
}

export function useUnacknowledgedPlcAlarms(plcConnectionId?: string) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'unacknowledgedPlcAlarms', plcConnectionId),
    queryFn: async () => {
      const data = await graphqlFetch<{ unacknowledgedPlcAlarms: PlcAlarm[] }>(
        UNACKNOWLEDGED_PLC_ALARMS_QUERY,
        { plcConnectionId },
      );
      return data.unacknowledgedPlcAlarms;
    },
    staleTime: 10000,
    refetchInterval: 15000,
    enabled: !!tenantId,
  });
}

export function usePlcAlarmStats(plcConnectionId?: string) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'plcAlarmStats', plcConnectionId),
    queryFn: async () => {
      const data = await graphqlFetch<{ plcAlarmStats: PlcAlarmStats }>(
        PLC_ALARM_STATS_QUERY,
        { plcConnectionId },
      );
      return data.plcAlarmStats;
    },
    staleTime: 10000,
    refetchInterval: 30000,
    enabled: !!tenantId,
  });
}

export function usePlcAlarmMutations() {
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'plcAlarms') });
    queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'activePlcAlarms') });
    queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'unacknowledgedPlcAlarms') });
    queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'plcAlarmStats') });
  }, [queryClient]);

  const acknowledgeMutation = useMutation({
    mutationFn: async ({ id, notes }: { id: string; notes?: string }) => {
      const data = await graphqlFetch<{ acknowledgePlcAlarm: PlcAlarm }>(
        ACKNOWLEDGE_PLC_ALARM_MUTATION,
        { id, input: notes ? { notes } : undefined },
      );
      return data.acknowledgePlcAlarm;
    },
    onSuccess: invalidate,
  });

  const bulkAcknowledgeMutation = useMutation({
    mutationFn: async ({ alarmIds, notes }: { alarmIds: string[]; notes?: string }) => {
      const data = await graphqlFetch<{ bulkAcknowledgePlcAlarms: number }>(
        BULK_ACKNOWLEDGE_PLC_ALARMS_MUTATION,
        { input: { alarmIds, notes } },
      );
      return data.bulkAcknowledgePlcAlarms;
    },
    onSuccess: invalidate,
  });

  const acknowledgeAllForConnectionMutation = useMutation({
    mutationFn: async ({ plcConnectionId, notes }: { plcConnectionId: string; notes?: string }) => {
      const data = await graphqlFetch<{ acknowledgeAllAlarmsForConnection: number }>(
        ACKNOWLEDGE_ALL_ALARMS_FOR_CONNECTION_MUTATION,
        { plcConnectionId, notes },
      );
      return data.acknowledgeAllAlarmsForConnection;
    },
    onSuccess: invalidate,
  });

  return {
    acknowledge: acknowledgeMutation,
    bulkAcknowledge: bulkAcknowledgeMutation,
    acknowledgeAllForConnection: acknowledgeAllForConnectionMutation,
  };
}

// ============================================================================
// PLC Telemetry Hooks
// ============================================================================

export function useLatestTelemetrySummary(plcConnectionId: string) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'latestTelemetrySummary', plcConnectionId),
    queryFn: async () => {
      const data = await graphqlFetch<{ latestTelemetrySummary: TelemetrySummary | null }>(
        LATEST_TELEMETRY_SUMMARY_QUERY,
        { plcConnectionId },
      );
      return data.latestTelemetrySummary;
    },
    staleTime: 10000,
    refetchInterval: 15000,
    enabled: !!plcConnectionId,
  });
}

export function useAllConnectionsTelemetrySummary() {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'allConnectionsTelemetrySummary'),
    queryFn: async () => {
      const data = await graphqlFetch<{ allConnectionsTelemetrySummary: TelemetrySummary[] }>(
        ALL_CONNECTIONS_TELEMETRY_SUMMARY_QUERY,
        {},
      );
      return data.allConnectionsTelemetrySummary;
    },
    staleTime: 10000,
    refetchInterval: 15000,
    enabled: !!tenantId,
  });
}

export function usePlcTelemetryStats(
  plcConnectionId: string,
  timeRange: { from: string; to: string },
) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'plcTelemetryStats', plcConnectionId, timeRange),
    queryFn: async () => {
      const data = await graphqlFetch<{ plcTelemetryStats: PlcTelemetryStats }>(
        PLC_TELEMETRY_STATS_QUERY,
        { plcConnectionId, timeRange },
      );
      return data.plcTelemetryStats;
    },
    staleTime: 30000,
    enabled: !!plcConnectionId && !!timeRange.from && !!timeRange.to,
  });
}

export function useFeedingStatsQuery(
  plcConnectionId: string,
  timeRange: { from: string; to: string },
) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'feedingStats', plcConnectionId, timeRange),
    queryFn: async () => {
      const data = await graphqlFetch<{ feedingStats: FeedingStats }>(
        FEEDING_STATS_QUERY,
        { plcConnectionId, timeRange },
      );
      return data.feedingStats;
    },
    staleTime: 30000,
    enabled: !!plcConnectionId && !!timeRange.from && !!timeRange.to,
  });
}

export function useActuatorUsageStats(
  plcConnectionId: string,
  timeRange: { from: string; to: string },
) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'actuatorUsageStats', plcConnectionId, timeRange),
    queryFn: async () => {
      const data = await graphqlFetch<{ actuatorUsageStats: ActuatorUsageStats }>(
        ACTUATOR_USAGE_STATS_QUERY,
        { plcConnectionId, timeRange },
      );
      return data.actuatorUsageStats;
    },
    staleTime: 30000,
    enabled: !!plcConnectionId && !!timeRange.from && !!timeRange.to,
  });
}
