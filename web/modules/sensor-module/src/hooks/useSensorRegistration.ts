import { useState, useCallback } from 'react';
import {
  RegisterSensorInput,
  UpdateSensorProtocolInput,
  UpdateSensorInfoInput,
  SensorFilter,
  Pagination,
  RegisteredSensor,
  SensorRegistrationResult,
  SensorStats,
  RegisterParentWithChildrenInput,
  ParentWithChildrenResult,
} from '../types/registration.types';

// API base URL
const API_URL = 'http://localhost:3000/graphql';

// Simple GraphQL fetch helper
async function graphqlFetch<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const token = localStorage.getItem('access_token');
  const tenantId = localStorage.getItem('tenant_id');

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });

  const result = await response.json();

  if (result.errors) {
    throw new Error(result.errors[0]?.message || 'GraphQL Error');
  }

  return result.data;
}

// GraphQL Queries
const GET_SENSOR_QUERY = `
  query GetSensor($id: ID!) {
    sensor(id: $id) {
      id
      name
      type
      status
      registrationStatus
      protocolCode
      protocolConfiguration
      connectionStatus
      manufacturer
      model
      serialNumber
      description
      farmId
      pondId
      tankId
      location
      metadata
      createdAt
      updatedAt
    }
  }
`;

const GET_SENSORS_QUERY = `
  query GetSensors($filter: SensorFilter, $pagination: Pagination) {
    sensors(filter: $filter, pagination: $pagination) {
      items {
        id
        name
        type
        status
        registrationStatus
        protocolCode
        connectionStatus
        location
        createdAt
      }
      total
      page
      pageSize
      totalPages
    }
  }
`;

const GET_SENSOR_STATS_QUERY = `
  query GetSensorStats {
    sensorStats {
      total
      active
      inactive
      testing
      failed
      byType {
        type
        count
      }
      byProtocol {
        protocol
        count
      }
    }
  }
`;

// GraphQL Mutations
const REGISTER_SENSOR_MUTATION = `
  mutation RegisterSensor($input: RegisterSensorInput!) {
    registerSensor(input: $input) {
      success
      sensor {
        id
        name
        type
        status
        registrationStatus
        protocolCode
      }
      error
    }
  }
`;

const ACTIVATE_SENSOR_MUTATION = `
  mutation ActivateSensor($sensorId: ID!) {
    activateSensor(sensorId: $sensorId) {
      id
      status
      registrationStatus
    }
  }
`;

const SUSPEND_SENSOR_MUTATION = `
  mutation SuspendSensor($sensorId: ID!, $reason: String) {
    suspendSensor(sensorId: $sensorId, reason: $reason) {
      id
      status
      registrationStatus
    }
  }
`;

const REACTIVATE_SENSOR_MUTATION = `
  mutation ReactivateSensor($sensorId: ID!) {
    reactivateSensor(sensorId: $sensorId) {
      id
      status
      registrationStatus
    }
  }
`;

const UPDATE_SENSOR_PROTOCOL_MUTATION = `
  mutation UpdateSensorProtocol($input: UpdateSensorProtocolInput!) {
    updateSensorProtocol(input: $input) {
      success
      sensor {
        id
        protocolCode
        protocolConfiguration
      }
      error
    }
  }
`;

const UPDATE_SENSOR_INFO_MUTATION = `
  mutation UpdateSensorInfo($input: UpdateSensorInfoInput!) {
    updateSensorInfo(input: $input) {
      id
      name
      description
      location
      metadata
    }
  }
`;

const DELETE_SENSOR_MUTATION = `
  mutation DeleteSensor($sensorId: ID!) {
    deleteSensor(sensorId: $sensorId)
  }
`;

const REGISTER_PARENT_WITH_CHILDREN_MUTATION = `
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

// Hook to fetch a single sensor
export function useSensor(id: string | undefined) {
  const [sensor, setSensor] = useState<RegisteredSensor | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    if (!id) return;

    setLoading(true);
    setError(null);

    try {
      const data = await graphqlFetch<{ sensor: RegisteredSensor }>(GET_SENSOR_QUERY, { id });
      setSensor(data.sensor);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [id]);

  return {
    sensor,
    loading,
    error,
    refetch,
  };
}

// Hook to fetch sensors list
export function useSensors(filter?: SensorFilter, pagination?: Pagination) {
  const [sensors, setSensors] = useState<RegisteredSensor[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await graphqlFetch<{ sensors: { items: RegisteredSensor[]; total: number; page: number; pageSize: number; totalPages: number } }>(
        GET_SENSORS_QUERY,
        { filter, pagination }
      );
      setSensors(data.sensors.items);
      setTotal(data.sensors.total);
      setPage(data.sensors.page);
      setPageSize(data.sensors.pageSize);
      setTotalPages(data.sensors.totalPages);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [filter, pagination]);

  return {
    sensors,
    total,
    page,
    pageSize,
    totalPages,
    loading,
    error,
    refetch,
  };
}

// Hook to fetch sensor stats
export function useSensorStats() {
  const [stats, setStats] = useState<SensorStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await graphqlFetch<{ sensorStats: SensorStats }>(GET_SENSOR_STATS_QUERY);
      setStats(data.sensorStats);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    stats,
    loading,
    error,
    refetch,
  };
}

// Hook for sensor registration
export function useSensorRegistration() {
  const [loading, setLoading] = useState(false);

  const registerSensor = useCallback(
    async (input: RegisterSensorInput): Promise<SensorRegistrationResult> => {
      setLoading(true);
      try {
        const data = await graphqlFetch<{ registerSensor: SensorRegistrationResult }>(
          REGISTER_SENSOR_MUTATION,
          { input }
        );
        return data.registerSensor;
      } catch (err) {
        return {
          success: false,
          error: (err as Error).message,
        };
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const activateSensor = useCallback(
    async (sensorId: string): Promise<RegisteredSensor | null> => {
      setLoading(true);
      try {
        const data = await graphqlFetch<{ activateSensor: RegisteredSensor }>(
          ACTIVATE_SENSOR_MUTATION,
          { sensorId }
        );
        return data.activateSensor;
      } catch {
        return null;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const suspendSensor = useCallback(
    async (sensorId: string, reason?: string): Promise<RegisteredSensor | null> => {
      setLoading(true);
      try {
        const data = await graphqlFetch<{ suspendSensor: RegisteredSensor }>(
          SUSPEND_SENSOR_MUTATION,
          { sensorId, reason }
        );
        return data.suspendSensor;
      } catch {
        return null;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const reactivateSensor = useCallback(
    async (sensorId: string): Promise<RegisteredSensor | null> => {
      setLoading(true);
      try {
        const data = await graphqlFetch<{ reactivateSensor: RegisteredSensor }>(
          REACTIVATE_SENSOR_MUTATION,
          { sensorId }
        );
        return data.reactivateSensor;
      } catch {
        return null;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const updateProtocol = useCallback(
    async (input: UpdateSensorProtocolInput): Promise<SensorRegistrationResult> => {
      setLoading(true);
      try {
        const data = await graphqlFetch<{ updateSensorProtocol: SensorRegistrationResult }>(
          UPDATE_SENSOR_PROTOCOL_MUTATION,
          { input }
        );
        return data.updateSensorProtocol;
      } catch (err) {
        return {
          success: false,
          error: (err as Error).message,
        };
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const updateInfo = useCallback(
    async (input: UpdateSensorInfoInput): Promise<RegisteredSensor | null> => {
      setLoading(true);
      try {
        const data = await graphqlFetch<{ updateSensorInfo: RegisteredSensor }>(
          UPDATE_SENSOR_INFO_MUTATION,
          { input }
        );
        return data.updateSensorInfo;
      } catch {
        return null;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const deleteSensor = useCallback(
    async (sensorId: string): Promise<boolean> => {
      setLoading(true);
      try {
        const data = await graphqlFetch<{ deleteSensor: boolean }>(
          DELETE_SENSOR_MUTATION,
          { sensorId }
        );
        return data.deleteSensor;
      } catch {
        return false;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const registerParentWithChildren = useCallback(
    async (input: RegisterParentWithChildrenInput): Promise<ParentWithChildrenResult> => {
      setLoading(true);
      try {
        const data = await graphqlFetch<{ registerParentWithChildren: ParentWithChildrenResult }>(
          REGISTER_PARENT_WITH_CHILDREN_MUTATION,
          { input }
        );
        return data.registerParentWithChildren;
      } catch (err) {
        return {
          success: false,
          error: (err as Error).message,
        };
      } finally {
        setLoading(false);
      }
    },
    []
  );

  return {
    registerSensor,
    registerParentWithChildren,
    activateSensor,
    suspendSensor,
    reactivateSensor,
    updateProtocol,
    updateInfo,
    deleteSensor,
    loading,
  };
}

// Hook for wizard state management
export function useRegistrationWizard() {
  const [currentStep, setCurrentStep] = useState(0);
  const [selectedProtocol, setSelectedProtocol] = useState<string | null>(null);
  const [basicInfo, setBasicInfo] = useState<Partial<RegisterSensorInput>>({});
  const [protocolConfig, setProtocolConfig] = useState<Record<string, unknown>>({});
  const [connectionTestResult, setConnectionTestResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const nextStep = useCallback(() => {
    setCurrentStep((prev) => prev + 1);
    setError(null);
  }, []);

  const prevStep = useCallback(() => {
    setCurrentStep((prev) => Math.max(0, prev - 1));
    setError(null);
  }, []);

  const goToStep = useCallback((step: number) => {
    setCurrentStep(step);
    setError(null);
  }, []);

  const reset = useCallback(() => {
    setCurrentStep(0);
    setSelectedProtocol(null);
    setBasicInfo({});
    setProtocolConfig({});
    setConnectionTestResult(null);
    setError(null);
  }, []);

  const updateBasicInfo = useCallback((updates: Partial<RegisterSensorInput>) => {
    setBasicInfo((prev) => ({ ...prev, ...updates }));
  }, []);

  const updateProtocolConfig = useCallback((updates: Record<string, unknown>) => {
    setProtocolConfig((prev) => ({ ...prev, ...updates }));
  }, []);

  return {
    currentStep,
    selectedProtocol,
    basicInfo,
    protocolConfig,
    connectionTestResult,
    error,
    setSelectedProtocol,
    setBasicInfo,
    setProtocolConfig,
    setConnectionTestResult,
    setError,
    nextStep,
    prevStep,
    goToStep,
    reset,
    updateBasicInfo,
    updateProtocolConfig,
  };
}
