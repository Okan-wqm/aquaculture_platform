/**
 * GraphQL queries and mutations for PLC Control
 * Maps to sensor-service PlcControlResolver
 */

// ============================================================================
// PLC Connection Fragments
// ============================================================================

const PLC_CONNECTION_FIELDS = `
  id
  name
  description
  endpointUrl
  siteId
  tankId
  securityMode
  securityPolicy
  authMode
  username
  status
  lastConnectedAt
  lastError
  publishingIntervalMs
  samplingIntervalMs
  sessionTimeoutMs
  parametersNodeId
  telemetryNodeId
  alarmsNodeId
  statusNodeId
  isActive
  createdAt
  updatedAt
  activeAlarmCount
  connectTimeoutMs
  requestTimeoutMs
  autoReconnect
  maxReconnectAttempts
  reconnectDelayMs
  maxReconnectDelayMs
  keepAliveIntervalMs
  failoverEndpointUrl
`;

const PLC_CONNECTION_WITH_TELEMETRY = `
  ${PLC_CONNECTION_FIELDS}
  latestTelemetry {
    plcConnectionId
    timestamp
    oxygen
    temperature
    ph
    flowRate
    blowerSpeed
    doserSpeed
    aerationOn
    feedingInProgress
    plcMode
    activeAlarmCount
  }
`;

const FEEDING_PARAMETER_FIELDS = `
  id
  plcConnectionId
  tankId
  name
  description
  version
  biomassKg
  fcr
  targetDailyFeedKg
  schedule
  thresholds
  vfdSettings
  status
  sentAt
  acknowledgedAt
  activatedAt
  errorMessage
  checksum
  createdAt
  updatedAt
  createdBy
`;

const PLC_ALARM_FIELDS = `
  id
  plcConnectionId
  tankId
  alarmCode
  severity
  source
  message
  value
  threshold
  action
  timestamp
  acknowledged
  acknowledgedAt
  acknowledgedBy
  clearedAt
  notes
  createdAt
`;

// ============================================================================
// PLC Connection Queries
// ============================================================================

export const PLC_CONNECTION_QUERY = `
  query PlcConnection($id: ID!) {
    plcConnection(id: $id) {
      ${PLC_CONNECTION_WITH_TELEMETRY}
    }
  }
`;

export const PLC_CONNECTIONS_QUERY = `
  query PlcConnections($filter: PlcConnectionFilterInput, $pagination: PlcPaginationInput) {
    plcConnections(filter: $filter, pagination: $pagination) {
      items { ${PLC_CONNECTION_WITH_TELEMETRY} }
      total page limit totalPages hasNextPage hasPreviousPage
    }
  }
`;

export const PLC_CONNECTIONS_BY_SITE_QUERY = `
  query PlcConnectionsBySite($siteId: ID!) {
    plcConnectionsBySite(siteId: $siteId) {
      ${PLC_CONNECTION_FIELDS}
    }
  }
`;

export const PLC_CONNECTION_COUNT_BY_STATUS_QUERY = `
  query PlcConnectionCountByStatus {
    plcConnectionCountByStatus {
      online
      offline
      connecting
      error
    }
  }
`;

export const ONLINE_PLC_CONNECTIONS_QUERY = `
  query OnlinePlcConnections {
    onlinePlcConnections {
      ${PLC_CONNECTION_FIELDS}
    }
  }
`;

// ============================================================================
// PLC Connection Mutations
// ============================================================================

export const CREATE_PLC_CONNECTION_MUTATION = `
  mutation CreatePlcConnection($input: CreatePlcConnectionInput!) {
    createPlcConnection(input: $input) {
      ${PLC_CONNECTION_FIELDS}
    }
  }
`;

export const UPDATE_PLC_CONNECTION_MUTATION = `
  mutation UpdatePlcConnection($id: ID!, $input: UpdatePlcConnectionInput!) {
    updatePlcConnection(id: $id, input: $input) {
      ${PLC_CONNECTION_FIELDS}
    }
  }
`;

export const DELETE_PLC_CONNECTION_MUTATION = `
  mutation DeletePlcConnection($id: ID!) {
    deletePlcConnection(id: $id)
  }
`;

export const TEST_PLC_CONNECTION_MUTATION = `
  mutation TestPlcConnection($id: ID!) {
    testPlcConnection(id: $id) {
      success
      latencyMs
      error
      errorCode
      serverInfo
      testedAt
    }
  }
`;

export const ACTIVATE_PLC_CONNECTION_MUTATION = `
  mutation ActivatePlcConnection($id: ID!) {
    activatePlcConnection(id: $id) {
      ${PLC_CONNECTION_FIELDS}
    }
  }
`;

export const DEACTIVATE_PLC_CONNECTION_MUTATION = `
  mutation DeactivatePlcConnection($id: ID!) {
    deactivatePlcConnection(id: $id) {
      ${PLC_CONNECTION_FIELDS}
    }
  }
`;

export const DISCOVER_OPCUA_ENDPOINTS_QUERY = `
  query DiscoverOpcUaEndpoints($endpointUrl: String!) {
    discoverOpcUaEndpoints(endpointUrl: $endpointUrl) {
      endpointUrl
      securityMode
      securityPolicy
      securityLevel
      serverCertificate
      transportProfileUri
    }
  }
`;

export const BROWSE_OPCUA_NODES_QUERY = `
  query BrowseOpcUaNodes($plcConnectionId: ID!, $parentNodeId: String) {
    browseOpcUaNodes(plcConnectionId: $plcConnectionId, parentNodeId: $parentNodeId) {
      nodeId
      browseName
      displayName
      nodeClass
      dataType
      hasChildren
      description
      value
    }
  }
`;

// ============================================================================
// Feeding Parameter Queries
// ============================================================================

export const FEEDING_PARAMETER_QUERY = `
  query FeedingParameter($id: ID!) {
    feedingParameter(id: $id) {
      ${FEEDING_PARAMETER_FIELDS}
      connection {
        id
        name
        status
      }
    }
  }
`;

export const FEEDING_PARAMETERS_QUERY = `
  query FeedingParameters($filter: FeedingParameterFilterInput, $pagination: PlcPaginationInput) {
    feedingParameters(filter: $filter, pagination: $pagination) {
      items {
        ${FEEDING_PARAMETER_FIELDS}
        connection {
          id
          name
          status
        }
      }
      total page limit totalPages hasNextPage hasPreviousPage
    }
  }
`;

export const ACTIVE_FEEDING_PARAMETER_QUERY = `
  query ActiveFeedingParameter($plcConnectionId: ID!) {
    activeFeedingParameter(plcConnectionId: $plcConnectionId) {
      ${FEEDING_PARAMETER_FIELDS}
    }
  }
`;

export const FEEDING_PARAMETER_HISTORY_QUERY = `
  query FeedingParameterHistory($plcConnectionId: ID!, $limit: Int) {
    feedingParameterHistory(plcConnectionId: $plcConnectionId, limit: $limit) {
      ${FEEDING_PARAMETER_FIELDS}
    }
  }
`;

// ============================================================================
// Feeding Parameter Mutations
// ============================================================================

export const CREATE_FEEDING_PARAMETER_MUTATION = `
  mutation CreateFeedingParameter($input: CreateFeedingParameterInput!) {
    createFeedingParameter(input: $input) {
      ${FEEDING_PARAMETER_FIELDS}
    }
  }
`;

export const UPDATE_FEEDING_PARAMETER_MUTATION = `
  mutation UpdateFeedingParameter($id: ID!, $input: UpdateFeedingParameterInput!) {
    updateFeedingParameter(id: $id, input: $input) {
      ${FEEDING_PARAMETER_FIELDS}
    }
  }
`;

export const DELETE_FEEDING_PARAMETER_MUTATION = `
  mutation DeleteFeedingParameter($id: ID!) {
    deleteFeedingParameter(id: $id)
  }
`;

export const SEND_FEEDING_PARAMETER_TO_PLC_MUTATION = `
  mutation SendFeedingParameterToPlc($id: ID!) {
    sendFeedingParameterToPlc(id: $id) {
      success
      checksum
      error
      sentAt
    }
  }
`;

export const ACTIVATE_FEEDING_PARAMETER_MUTATION = `
  mutation ActivateFeedingParameter($id: ID!) {
    activateFeedingParameter(id: $id) {
      ${FEEDING_PARAMETER_FIELDS}
    }
  }
`;

export const CLONE_FEEDING_PARAMETER_MUTATION = `
  mutation CloneFeedingParameter($id: ID!, $newName: String) {
    cloneFeedingParameter(id: $id, newName: $newName) {
      ${FEEDING_PARAMETER_FIELDS}
    }
  }
`;

// ============================================================================
// PLC Alarm Queries
// ============================================================================

export const PLC_ALARMS_QUERY = `
  query PlcAlarms($filter: PlcAlarmFilterInput, $pagination: PlcPaginationInput) {
    plcAlarms(filter: $filter, pagination: $pagination) {
      items { ${PLC_ALARM_FIELDS} }
      total page limit totalPages hasNextPage hasPreviousPage
    }
  }
`;

export const ACTIVE_PLC_ALARMS_QUERY = `
  query ActivePlcAlarms($plcConnectionId: ID) {
    activePlcAlarms(plcConnectionId: $plcConnectionId) {
      ${PLC_ALARM_FIELDS}
    }
  }
`;

export const UNACKNOWLEDGED_PLC_ALARMS_QUERY = `
  query UnacknowledgedPlcAlarms($plcConnectionId: ID) {
    unacknowledgedPlcAlarms(plcConnectionId: $plcConnectionId) {
      ${PLC_ALARM_FIELDS}
    }
  }
`;

export const RECENT_PLC_ALARMS_QUERY = `
  query RecentPlcAlarms($limit: Int, $plcConnectionId: ID) {
    recentPlcAlarms(limit: $limit, plcConnectionId: $plcConnectionId) {
      ${PLC_ALARM_FIELDS}
    }
  }
`;

export const PLC_ALARM_STATS_QUERY = `
  query PlcAlarmStats($plcConnectionId: ID) {
    plcAlarmStats(plcConnectionId: $plcConnectionId) {
      totalActive
      totalUnacknowledged
      criticalCount
      emergencyCount
      warningCount
      infoCount
      last24HoursCount
      last7DaysCount
    }
  }
`;

export const ALARM_COUNT_BY_SEVERITY_QUERY = `
  query AlarmCountBySeverity($plcConnectionId: ID) {
    alarmCountBySeverity(plcConnectionId: $plcConnectionId) {
      info
      warning
      critical
      emergency
    }
  }
`;

// ============================================================================
// PLC Alarm Mutations
// ============================================================================

export const ACKNOWLEDGE_PLC_ALARM_MUTATION = `
  mutation AcknowledgePlcAlarm($id: ID!, $input: AcknowledgeAlarmInput) {
    acknowledgePlcAlarm(id: $id, input: $input) {
      ${PLC_ALARM_FIELDS}
    }
  }
`;

export const BULK_ACKNOWLEDGE_PLC_ALARMS_MUTATION = `
  mutation BulkAcknowledgePlcAlarms($input: BulkAcknowledgeAlarmsInput!) {
    bulkAcknowledgePlcAlarms(input: $input)
  }
`;

export const ACKNOWLEDGE_ALL_ALARMS_FOR_CONNECTION_MUTATION = `
  mutation AcknowledgeAllAlarmsForConnection($plcConnectionId: ID!, $notes: String) {
    acknowledgeAllAlarmsForConnection(plcConnectionId: $plcConnectionId, notes: $notes)
  }
`;

// ============================================================================
// PLC Telemetry Queries
// ============================================================================

export const LATEST_PLC_TELEMETRY_QUERY = `
  query LatestPlcTelemetry($plcConnectionId: ID!) {
    latestPlcTelemetry(plcConnectionId: $plcConnectionId) {
      id
      plcConnectionId
      tankId
      timestamp
      sensors
      actuators
      feeding
      plcStatus
      activeParameterId
      createdAt
    }
  }
`;

export const LATEST_TELEMETRY_SUMMARY_QUERY = `
  query LatestTelemetrySummary($plcConnectionId: ID!) {
    latestTelemetrySummary(plcConnectionId: $plcConnectionId) {
      plcConnectionId
      timestamp
      oxygen
      temperature
      ph
      flowRate
      blowerSpeed
      doserSpeed
      aerationOn
      feedingInProgress
      plcMode
      activeAlarmCount
    }
  }
`;

export const ALL_CONNECTIONS_TELEMETRY_SUMMARY_QUERY = `
  query AllConnectionsTelemetrySummary {
    allConnectionsTelemetrySummary {
      plcConnectionId
      timestamp
      oxygen
      temperature
      ph
      flowRate
      blowerSpeed
      doserSpeed
      aerationOn
      feedingInProgress
      plcMode
      activeAlarmCount
    }
  }
`;

export const PLC_TELEMETRY_STATS_QUERY = `
  query PlcTelemetryStats($plcConnectionId: ID!, $timeRange: TelemetryTimeRangeInput!) {
    plcTelemetryStats(plcConnectionId: $plcConnectionId, timeRange: $timeRange) {
      plcConnectionId
      from
      to
      totalRecords
      oxygen { min max avg stdDev count }
      temperature { min max avg stdDev count }
      ph { min max avg stdDev count }
      flowRate { min max avg stdDev count }
    }
  }
`;

export const FEEDING_STATS_QUERY = `
  query FeedingStats($plcConnectionId: ID!, $timeRange: TelemetryTimeRangeInput!) {
    feedingStats(plcConnectionId: $plcConnectionId, timeRange: $timeRange) {
      totalFeedKg
      totalFeedings
      avgFeedingAmountKg
      lastFeedingTime
      lastFeedingAmountKg
    }
  }
`;

export const ACTUATOR_USAGE_STATS_QUERY = `
  query ActuatorUsageStats($plcConnectionId: ID!, $timeRange: TelemetryTimeRangeInput!) {
    actuatorUsageStats(plcConnectionId: $plcConnectionId, timeRange: $timeRange) {
      avgBlowerSpeed
      avgDoserSpeed
      aerationOnTimePercent
      feedingTimePercent
    }
  }
`;
