/**
 * GraphQL queries and mutations for edge device management.
 */

// ============================================================================
// Queries
// ============================================================================

export const EDGE_DEVICES_QUERY = `
  query EdgeDevices($lifecycleState: DeviceLifecycleState, $isOnline: Boolean, $search: String, $page: Int, $limit: Int) {
    edgeDevices(lifecycleState: $lifecycleState, isOnline: $isOnline, search: $search, page: $page, limit: $limit) {
      items {
        id
        deviceCode
        deviceName
        deviceModel
        lifecycleState
        isOnline
        lastSeenAt
        cpuUsage
        memoryUsage
        agentVersion
        ipAddress
        sensorCount
        programCount
      }
      total
      page
      limit
    }
    edgeDeviceStats {
      total
      online
      offline
      byState { state count }
    }
  }
`;

export const EDGE_DEVICE_QUERY = `
  query EdgeDevice($id: ID!) {
    edgeDevice(id: $id) {
      id
      tenantId
      siteId
      deviceCode
      deviceName
      deviceModel
      serialNumber
      description
      lifecycleState
      mqttClientId
      agentVersion
      lastSeenAt
      isOnline
      ipAddress
      firmwareVersion
      cpuUsage
      memoryUsage
      storageUsage
      temperatureCelsius
      uptimeSeconds
      connectionQuality
      config
      capabilities
      tags
      createdAt
      updatedAt
      sensorCount
      programCount
      activeAlarmCount
      ioConfig {
        id
        tagName
        ioType
        dataType
        isActive
      }
    }
  }
`;

export const DEVICE_EVENTS_QUERY = `
  query DeviceEvents($deviceId: ID!, $page: Int, $limit: Int) {
    deviceEvents(deviceId: $deviceId, page: $page, limit: $limit) {
      items { id deviceId eventType severity message metadata createdAt }
      total page limit
    }
  }
`;

// ============================================================================
// Mutations
// ============================================================================

export const APPROVE_DEVICE_MUTATION = `
  mutation ApproveEdgeDevice($id: ID!) {
    approveEdgeDevice(id: $id) { id lifecycleState }
  }
`;

export const PING_DEVICE_MUTATION = `
  mutation PingEdgeDevice($id: ID!) {
    pingEdgeDevice(id: $id) { success latencyMs }
  }
`;

export const REBOOT_DEVICE_MUTATION = `
  mutation RebootEdgeDevice($id: ID!, $reason: String) {
    rebootEdgeDevice(id: $id, reason: $reason)
  }
`;

export const MAINTENANCE_DEVICE_MUTATION = `
  mutation SetDeviceMaintenanceMode($id: ID!, $enabled: Boolean!) {
    setDeviceMaintenanceMode(id: $id, enabled: $enabled) { id lifecycleState }
  }
`;

export const DECOMMISSION_DEVICE_MUTATION = `
  mutation DecommissionEdgeDevice($id: ID!, $reason: String!) {
    decommissionEdgeDevice(id: $id, reason: $reason) { id lifecycleState }
  }
`;

// ============================================================================
// Provisioning Key queries/mutations
// ============================================================================

export const CREATE_PROVISIONING_KEY_MUTATION = `
  mutation CreateTenantProvisioningKey($input: CreateTenantKeyInput!) {
    createTenantProvisioningKey(input: $input) {
      id
      keyToken
      installerUrl
      installerCommand
      expiresAt
      maxDevices
      autoApprove
    }
  }
`;

export const LIST_PROVISIONING_KEYS_QUERY = `
  query TenantProvisioningKeys {
    tenantProvisioningKeys {
      id
      name
      isActive
      maxDevices
      usedCount
      autoApprove
      expiresAt
      createdAt
    }
  }
`;

export const REVOKE_PROVISIONING_KEY_MUTATION = `
  mutation RevokeTenantProvisioningKey($keyId: ID!) {
    revokeTenantProvisioningKey(keyId: $keyId)
  }
`;
