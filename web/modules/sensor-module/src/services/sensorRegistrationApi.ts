import { gql } from '@apollo/client';
import {
  ProtocolInfo,
  ProtocolCategory,
  ProtocolDetails,
  JSONSchema,
  ProtocolCapabilities,
  CategoryStats,
  RegisterSensorInput,
  UpdateSensorProtocolInput,
  UpdateSensorInfoInput,
  SensorFilter,
  Pagination,
  SensorRegistrationResult,
  ConnectionTestResult,
  ValidationResult,
  SensorList,
  RegisteredSensor,
  SensorStats,
} from '../types/registration.types';

// GraphQL Queries
export const GET_PROTOCOLS = gql`
  query GetProtocols($category: ProtocolCategory) {
    protocols(category: $category) {
      code
      displayName
      description
      category
      subcategory
      connectionType
      capabilities {
        supportsDiscovery
        supportsBidirectional
        supportsPolling
        supportsSubscription
        supportsAuthentication
        supportsEncryption
        supportedDataTypes
      }
    }
  }
`;

export const GET_PROTOCOL_SUMMARIES = gql`
  query GetProtocolSummaries {
    protocolSummaries {
      code
      name
      category
      subcategory
    }
  }
`;

export const GET_PROTOCOL_DETAILS = gql`
  query GetProtocolDetails($code: String!) {
    protocolDetails(code: $code) {
      id
      code
      name
      category
      subcategory
      connectionType
      description
      configurationSchema
      defaultConfiguration
      isActive
    }
  }
`;

export const GET_PROTOCOL_SCHEMA = gql`
  query GetProtocolSchema($code: String!) {
    protocolSchema(code: $code)
  }
`;

export const GET_PROTOCOL_DEFAULTS = gql`
  query GetProtocolDefaults($code: String!) {
    protocolDefaults(code: $code)
  }
`;

export const GET_PROTOCOL_CAPABILITIES = gql`
  query GetProtocolCapabilities($code: String!) {
    protocolCapabilities(code: $code) {
      supportsDiscovery
      supportsBidirectional
      supportsPolling
      supportsSubscription
      supportsAuthentication
      supportsEncryption
      supportedDataTypes
    }
  }
`;

export const GET_CATEGORY_STATS = gql`
  query GetCategoryStats {
    protocolCategoryStats {
      industrial
      iot
      serial
      wireless
    }
  }
`;

export const GET_SENSOR = gql`
  query GetSensor($id: ID!) {
    sensor(id: $id) {
      id
      name
      type
      protocolCode
      protocolConfiguration
      connectionStatus {
        isConnected
        lastTestedAt
        lastError
        latency
      }
      registrationStatus
      manufacturer
      model
      serialNumber
      description
      farmId
      pondId
      tankId
      location
      metadata
      tenantId
      createdAt
      updatedAt
    }
  }
`;

export const GET_SENSORS = gql`
  query GetSensors($filter: SensorFilterInput, $pagination: PaginationInput) {
    sensors(filter: $filter, pagination: $pagination) {
      items {
        id
        name
        type
        protocolCode
        protocolConfiguration
        connectionStatus {
          isConnected
          lastTestedAt
          lastError
          latency
        }
        registrationStatus
        manufacturer
        model
        serialNumber
        description
        farmId
        pondId
        tankId
        location
        tenantId
        createdAt
        updatedAt
      }
      total
      page
      pageSize
      totalPages
    }
  }
`;

export const GET_SENSOR_STATS = gql`
  query GetSensorStats {
    sensorStats {
      total
      active
      inactive
      testing
      failed
      byType
      byProtocol
    }
  }
`;

// GraphQL Mutations
export const REGISTER_SENSOR = gql`
  mutation RegisterSensor($input: RegisterSensorInput!) {
    registerSensor(input: $input) {
      success
      sensor {
        id
        name
        type
        protocolCode
        protocolConfiguration
        connectionStatus {
          isConnected
          lastTestedAt
          lastError
          latency
        }
        registrationStatus
        manufacturer
        model
        serialNumber
        description
        farmId
        pondId
        tankId
        location
        tenantId
        createdAt
        updatedAt
      }
      error
      connectionTestPassed
      latencyMs
    }
  }
`;

export const TEST_SENSOR_CONNECTION = gql`
  mutation TestSensorConnection($sensorId: ID!) {
    testSensorConnection(sensorId: $sensorId) {
      success
      latencyMs
      error
      sampleData
      testedAt
    }
  }
`;

export const TEST_PROTOCOL_CONNECTION = gql`
  mutation TestProtocolConnection($input: TestConnectionInput!) {
    testProtocolConnection(input: $input) {
      success
      protocolCode
      testedAt
      configUsed
      latencyMs
      error
      sampleData {
        timestamp
        values
        quality
        source
      }
      diagnostics {
        totalMs
      }
    }
  }
`;

export const VALIDATE_PROTOCOL_CONFIG = gql`
  mutation ValidateProtocolConfig($input: ValidateConfigInput!) {
    validateProtocolConfig(input: $input) {
      isValid
      errors {
        field
        message
      }
    }
  }
`;

export const ACTIVATE_SENSOR = gql`
  mutation ActivateSensor($sensorId: ID!) {
    activateSensor(sensorId: $sensorId) {
      id
      name
      registrationStatus
      connectionStatus {
        isConnected
        lastTestedAt
        latency
      }
    }
  }
`;

export const SUSPEND_SENSOR = gql`
  mutation SuspendSensor($sensorId: ID!, $reason: String) {
    suspendSensor(sensorId: $sensorId, reason: $reason) {
      id
      name
      registrationStatus
      connectionStatus {
        isConnected
        lastError
      }
    }
  }
`;

export const REACTIVATE_SENSOR = gql`
  mutation ReactivateSensor($sensorId: ID!) {
    reactivateSensor(sensorId: $sensorId) {
      id
      name
      registrationStatus
      connectionStatus {
        isConnected
        lastTestedAt
        latency
      }
    }
  }
`;

export const UPDATE_SENSOR_PROTOCOL = gql`
  mutation UpdateSensorProtocol($input: UpdateSensorProtocolInput!) {
    updateSensorProtocol(input: $input) {
      success
      sensor {
        id
        name
        protocolCode
        protocolConfiguration
        registrationStatus
      }
      error
    }
  }
`;

export const UPDATE_SENSOR_INFO = gql`
  mutation UpdateSensorInfo($input: UpdateSensorInfoInput!) {
    updateSensorInfo(input: $input) {
      id
      name
      type
      manufacturer
      model
      serialNumber
      description
      farmId
      pondId
      tankId
      location
      metadata
      updatedAt
    }
  }
`;

export const DELETE_SENSOR = gql`
  mutation DeleteSensor($sensorId: ID!) {
    deleteSensor(sensorId: $sensorId)
  }
`;

export const REGISTER_PARENT_WITH_CHILDREN = gql`
  mutation RegisterParentWithChildren($input: RegisterParentWithChildrenInput!) {
    registerParentWithChildren(input: $input) {
      success
      parent {
        id
        name
        protocolCode
        protocolConfiguration
        connectionStatus {
          isConnected
          lastTestedAt
          lastError
          latency
        }
        registrationStatus
        manufacturer
        model
        serialNumber
        description
        farmId
        pondId
        tankId
        location
        tenantId
        createdAt
        updatedAt
      }
      children {
        id
        name
        type
        dataPath
        unit
        minValue
        maxValue
        registrationStatus
        tenantId
        createdAt
      }
      error
      connectionTestPassed
      latencyMs
    }
  }
`;

export const APPLY_PROTOCOL_DEFAULTS = gql`
  mutation ApplyProtocolDefaults($protocolCode: String!, $config: JSON!) {
    applyProtocolDefaults(protocolCode: $protocolCode, config: $config)
  }
`;

// Type exports for use with Apollo hooks
export interface GetProtocolsResult {
  protocols: ProtocolInfo[];
}

export interface GetProtocolDetailsResult {
  protocolDetails: ProtocolDetails | null;
}

export interface GetProtocolSchemaResult {
  protocolSchema: JSONSchema | null;
}

export interface GetProtocolDefaultsResult {
  protocolDefaults: Record<string, unknown> | null;
}

export interface GetCategoryStatsResult {
  protocolCategoryStats: CategoryStats;
}

export interface GetSensorResult {
  sensor: RegisteredSensor | null;
}

export interface GetSensorsResult {
  sensors: SensorList;
}

export interface GetSensorStatsResult {
  sensorStats: SensorStats;
}

export interface RegisterSensorResult {
  registerSensor: SensorRegistrationResult;
}

export interface TestSensorConnectionResult {
  testSensorConnection: ConnectionTestResult;
}

export interface TestProtocolConnectionResult {
  testProtocolConnection: ConnectionTestResult & {
    protocolCode: string;
    configUsed: Record<string, unknown>;
  };
}

export interface ValidateProtocolConfigResult {
  validateProtocolConfig: ValidationResult;
}

export interface ActivateSensorResult {
  activateSensor: RegisteredSensor;
}

export interface SuspendSensorResult {
  suspendSensor: RegisteredSensor;
}

export interface UpdateSensorProtocolResult {
  updateSensorProtocol: SensorRegistrationResult;
}

export interface UpdateSensorInfoResult {
  updateSensorInfo: RegisteredSensor;
}

export interface DeleteSensorResult {
  deleteSensor: boolean;
}
