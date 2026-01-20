/**
 * GraphQL queries and mutations for Edge Device management
 * Industrial IoT Fleet Management - IEC 62443 compliant
 */

// ==================== Queries ====================

export const EDGE_DEVICES_QUERY = `
  query EdgeDevices(
    $siteId: ID
    $lifecycleState: DeviceLifecycleState
    $isOnline: Boolean
    $search: String
    $page: Int
    $limit: Int
  ) {
    edgeDevices(
      siteId: $siteId
      lifecycleState: $lifecycleState
      isOnline: $isOnline
      search: $search
      page: $page
      limit: $limit
    ) {
      items {
        id
        deviceCode
        deviceName
        deviceModel
        serialNumber
        lifecycleState
        isOnline
        connectionQuality
        ipAddress
        lastSeenAt
        firmwareVersion
        targetFirmwareVersion
        cpuUsage
        memoryUsage
        storageUsage
        temperatureCelsius
        siteId
        createdAt
        updatedAt
      }
      total
      page
      limit
    }
  }
`;

export const EDGE_DEVICE_QUERY = `
  query EdgeDevice($id: ID!) {
    edgeDevice(id: $id) {
      id
      deviceCode
      deviceName
      deviceModel
      serialNumber
      description
      lifecycleState
      isOnline
      connectionQuality
      ipAddress
      lastSeenAt
      mqttClientId
      certificateThumbprint
      certificateExpiresAt
      securityLevel
      firmwareVersion
      firmwareUpdatedAt
      targetFirmwareVersion
      cpuUsage
      memoryUsage
      storageUsage
      temperatureCelsius
      timezone
      scanRateMs
      config
      capabilities
      tags
      siteId
      commissionedAt
      commissionedBy
      createdAt
      updatedAt
      ioConfig {
        id
        tagName
        description
        ioType
        dataType
        moduleAddress
        channel
        rawMin
        rawMax
        engMin
        engMax
        engUnit
        modbusFunction
        modbusSlaveId
        modbusRegister
        gpioPin
        gpioMode
        invertValue
        alarmHH
        alarmH
        alarmL
        alarmLL
        deadband
        isActive
      }
      sensorCount
      programCount
      activeAlarmCount
    }
  }
`;

export const EDGE_DEVICE_STATS_QUERY = `
  query EdgeDeviceStats {
    edgeDeviceStats {
      total
      online
      offline
      byState {
        state
        count
      }
      byModel {
        model
        count
      }
    }
  }
`;

// ==================== Mutations ====================

export const REGISTER_EDGE_DEVICE_MUTATION = `
  mutation RegisterEdgeDevice($input: RegisterEdgeDeviceInput!) {
    registerEdgeDevice(input: $input) {
      id
      deviceCode
      deviceName
      deviceModel
      serialNumber
      lifecycleState
      createdAt
    }
  }
`;

export const UPDATE_EDGE_DEVICE_MUTATION = `
  mutation UpdateEdgeDevice($id: ID!, $input: UpdateEdgeDeviceInput!) {
    updateEdgeDevice(id: $id, input: $input) {
      id
      deviceCode
      deviceName
      description
      siteId
      timezone
      scanRateMs
      config
      capabilities
      tags
      updatedAt
    }
  }
`;

export const APPROVE_EDGE_DEVICE_MUTATION = `
  mutation ApproveEdgeDevice($id: ID!) {
    approveEdgeDevice(id: $id) {
      id
      deviceCode
      lifecycleState
      commissionedAt
      commissionedBy
    }
  }
`;

export const SET_DEVICE_MAINTENANCE_MODE_MUTATION = `
  mutation SetDeviceMaintenanceMode($id: ID!, $enabled: Boolean!) {
    setDeviceMaintenanceMode(id: $id, enabled: $enabled) {
      id
      deviceCode
      lifecycleState
      updatedAt
    }
  }
`;

export const DECOMMISSION_EDGE_DEVICE_MUTATION = `
  mutation DecommissionEdgeDevice($id: ID!, $reason: String!) {
    decommissionEdgeDevice(id: $id, reason: $reason) {
      id
      deviceCode
      lifecycleState
      updatedAt
    }
  }
`;

export const PING_EDGE_DEVICE_MUTATION = `
  mutation PingEdgeDevice($id: ID!) {
    pingEdgeDevice(id: $id) {
      success
      latencyMs
      message
    }
  }
`;

// ==================== I/O Config Mutations ====================

export const ADD_DEVICE_IO_CONFIG_MUTATION = `
  mutation AddDeviceIoConfig($deviceId: ID!, $input: AddIoConfigInput!) {
    addDeviceIoConfig(deviceId: $deviceId, input: $input) {
      id
      tagName
      description
      ioType
      dataType
      moduleAddress
      channel
      engUnit
      isActive
    }
  }
`;

export const UPDATE_DEVICE_IO_CONFIG_MUTATION = `
  mutation UpdateDeviceIoConfig($id: ID!, $deviceId: ID!, $input: UpdateIoConfigInput!) {
    updateDeviceIoConfig(id: $id, deviceId: $deviceId, input: $input) {
      id
      tagName
      description
      engUnit
      alarmHH
      alarmH
      alarmL
      alarmLL
      deadband
      isActive
    }
  }
`;

export const REMOVE_DEVICE_IO_CONFIG_MUTATION = `
  mutation RemoveDeviceIoConfig($id: ID!, $deviceId: ID!) {
    removeDeviceIoConfig(id: $id, deviceId: $deviceId)
  }
`;

// ==================== Provisioning Mutations ====================

/**
 * Create a provisioned device with installer URL
 * This is the zero-touch provisioning entry point
 */
export const CREATE_PROVISIONED_DEVICE_MUTATION = `
  mutation CreateProvisionedDevice($input: CreateProvisionedDeviceInput!) {
    createProvisionedDevice(input: $input) {
      deviceId
      deviceCode
      installerUrl
      installerCommand
      tokenExpiresAt
      status
    }
  }
`;

/**
 * Regenerate provisioning token for a device
 * Used when the original token expires before activation
 */
export const REGENERATE_DEVICE_TOKEN_MUTATION = `
  mutation RegenerateDeviceToken($deviceId: ID!) {
    regenerateDeviceToken(deviceId: $deviceId) {
      deviceId
      deviceCode
      installerUrl
      installerCommand
      tokenExpiresAt
    }
  }
`;
