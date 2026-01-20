import { useState, useCallback } from 'react';
import {
  VfdDevice,
  VfdFilter,
  VfdStats,
  VfdDeviceStatus,
  RegisterVfdInput,
  UpdateVfdInput,
  VfdRegistrationResult,
  VfdConnectionTestInput,
  VfdConnectionTestResult,
  VfdBrand,
  VfdProtocol,
  VfdProtocolConfiguration,
  VfdBrandInfo,
  VfdRegistrationWizardState,
  VfdWizardStep,
} from '../types/vfd.types';

// API base URL
const API_URL = 'http://localhost:3000/graphql';

// GraphQL fetch helper
async function graphqlFetch<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const token = localStorage.getItem('access_token');

  const response = await fetch(API_URL, {
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

// GraphQL Queries
const GET_VFD_DEVICE_QUERY = `
  query GetVfdDevice($id: ID!) {
    vfdDevice(id: $id) {
      id
      name
      brand
      model
      modelSeries
      serialNumber
      firmwareVersion
      protocol
      protocolConfiguration
      connectionStatus {
        isConnected
        lastConnectedAt
        lastTestedAt
        lastError
        latencyMs
        connectionQuality
      }
      status
      installationDate
      notes
      tags
      tenantId
      farmId
      tankId
      pumpId
      location
      createdAt
      updatedAt
      latestReading {
        id
        timestamp
        parameters
        statusBits
      }
    }
  }
`;

const GET_VFD_DEVICES_QUERY = `
  query GetVfdDevices($filter: VfdFilterInput, $pagination: PaginationInput) {
    vfdDevices(filter: $filter, pagination: $pagination) {
      items {
        id
        name
        brand
        model
        protocol
        connectionStatus {
          isConnected
          lastTestedAt
          latencyMs
          connectionQuality
        }
        status
        location
        createdAt
        latestReading {
          timestamp
          parameters
          statusBits
        }
      }
      total
      page
      pageSize
      totalPages
    }
  }
`;

const GET_VFD_STATS_QUERY = `
  query GetVfdStats {
    vfdStats {
      total
      active
      inactive
      faulted
      maintenance
      byBrand
      byProtocol
      byStatus
    }
  }
`;

// GraphQL Mutations
const REGISTER_VFD_MUTATION = `
  mutation RegisterVfdDevice($input: RegisterVfdInput!) {
    registerVfdDevice(input: $input) {
      success
      vfdDevice {
        id
        name
        brand
        model
        protocol
        status
        connectionStatus {
          isConnected
          latencyMs
        }
      }
      error
      connectionTestPassed
      latencyMs
    }
  }
`;

const UPDATE_VFD_MUTATION = `
  mutation UpdateVfdDevice($id: ID!, $input: UpdateVfdInput!) {
    updateVfdDevice(id: $id, input: $input) {
      id
      name
      model
      serialNumber
      protocolConfiguration
      status
      location
      notes
      tags
      updatedAt
    }
  }
`;

const DELETE_VFD_MUTATION = `
  mutation DeleteVfdDevice($id: ID!) {
    deleteVfdDevice(id: $id)
  }
`;

const TEST_VFD_CONNECTION_MUTATION = `
  mutation TestVfdConnection($input: TestVfdConnectionInput!) {
    testVfdConnection(input: $input) {
      success
      latencyMs
      error
      errorCode
      sampleData
      statusBits
      firmwareVersion
      deviceInfo {
        manufacturer
        model
        serialNumber
      }
      testedAt
      diagnostics {
        communicationErrors
        retries
        packetsSent
        packetsReceived
        averageLatency
        maxLatency
      }
    }
  }
`;

const ACTIVATE_VFD_MUTATION = `
  mutation ActivateVfdDevice($id: ID!) {
    activateVfdDevice(id: $id) {
      id
      status
    }
  }
`;

const DEACTIVATE_VFD_MUTATION = `
  mutation DeactivateVfdDevice($id: ID!) {
    deactivateVfdDevice(id: $id) {
      id
      status
    }
  }
`;

// Pagination interface
interface Pagination {
  page: number;
  pageSize: number;
}

/**
 * Hook to fetch a single VFD device
 */
export function useVfdDevice(id: string | undefined) {
  const [device, setDevice] = useState<VfdDevice | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    if (!id) return;

    setLoading(true);
    setError(null);

    try {
      const data = await graphqlFetch<{ vfdDevice: VfdDevice }>(GET_VFD_DEVICE_QUERY, { id });
      setDevice(data.vfdDevice);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [id]);

  return {
    device,
    loading,
    error,
    refetch,
  };
}

/**
 * Hook to fetch VFD devices list
 */
export function useVfdDevices(filter?: VfdFilter, pagination?: Pagination) {
  const [devices, setDevices] = useState<VfdDevice[]>([]);
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
      const data = await graphqlFetch<{
        vfdDevices: {
          items: VfdDevice[];
          total: number;
          page: number;
          pageSize: number;
          totalPages: number;
        };
      }>(GET_VFD_DEVICES_QUERY, { filter, pagination });

      setDevices(data.vfdDevices.items);
      setTotal(data.vfdDevices.total);
      setPage(data.vfdDevices.page);
      setPageSize(data.vfdDevices.pageSize);
      setTotalPages(data.vfdDevices.totalPages);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [filter, pagination]);

  return {
    devices,
    total,
    page,
    pageSize,
    totalPages,
    loading,
    error,
    refetch,
  };
}

/**
 * Hook to fetch VFD statistics
 */
export function useVfdStats() {
  const [stats, setStats] = useState<VfdStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await graphqlFetch<{ vfdStats: VfdStats }>(GET_VFD_STATS_QUERY);
      setStats(data.vfdStats);
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

/**
 * Hook for VFD device registration and management
 */
export function useVfdRegistration() {
  const [loading, setLoading] = useState(false);

  const registerDevice = useCallback(
    async (input: RegisterVfdInput): Promise<VfdRegistrationResult> => {
      setLoading(true);
      try {
        const data = await graphqlFetch<{ registerVfdDevice: VfdRegistrationResult }>(
          REGISTER_VFD_MUTATION,
          { input }
        );
        return data.registerVfdDevice;
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

  const updateDevice = useCallback(
    async (id: string, input: UpdateVfdInput): Promise<VfdDevice | null> => {
      setLoading(true);
      try {
        const data = await graphqlFetch<{ updateVfdDevice: VfdDevice }>(
          UPDATE_VFD_MUTATION,
          { id, input }
        );
        return data.updateVfdDevice;
      } catch {
        return null;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const deleteDevice = useCallback(
    async (id: string): Promise<boolean> => {
      setLoading(true);
      try {
        const data = await graphqlFetch<{ deleteVfdDevice: boolean }>(
          DELETE_VFD_MUTATION,
          { id }
        );
        return data.deleteVfdDevice;
      } catch {
        return false;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const testConnection = useCallback(
    async (input: VfdConnectionTestInput): Promise<VfdConnectionTestResult> => {
      setLoading(true);
      try {
        const data = await graphqlFetch<{ testVfdConnection: VfdConnectionTestResult }>(
          TEST_VFD_CONNECTION_MUTATION,
          { input }
        );
        return data.testVfdConnection;
      } catch (err) {
        return {
          success: false,
          error: (err as Error).message,
          testedAt: new Date().toISOString(),
        };
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const activateDevice = useCallback(
    async (id: string): Promise<VfdDevice | null> => {
      setLoading(true);
      try {
        const data = await graphqlFetch<{ activateVfdDevice: VfdDevice }>(
          ACTIVATE_VFD_MUTATION,
          { id }
        );
        return data.activateVfdDevice;
      } catch {
        return null;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const deactivateDevice = useCallback(
    async (id: string): Promise<VfdDevice | null> => {
      setLoading(true);
      try {
        const data = await graphqlFetch<{ deactivateVfdDevice: VfdDevice }>(
          DEACTIVATE_VFD_MUTATION,
          { id }
        );
        return data.deactivateVfdDevice;
      } catch {
        return null;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  return {
    registerDevice,
    updateDevice,
    deleteDevice,
    testConnection,
    activateDevice,
    deactivateDevice,
    loading,
  };
}

/**
 * Default wizard steps
 */
const DEFAULT_WIZARD_STEPS: VfdWizardStep[] = [
  {
    id: 'brand',
    title: 'Marka Seçimi',
    description: 'VFD cihaz markasını seçin',
    isComplete: false,
    isActive: true,
  },
  {
    id: 'protocol',
    title: 'Protokol Seçimi',
    description: 'İletişim protokolünü seçin',
    isComplete: false,
    isActive: false,
  },
  {
    id: 'basicInfo',
    title: 'Temel Bilgiler',
    description: 'Cihaz adı ve model bilgileri',
    isComplete: false,
    isActive: false,
  },
  {
    id: 'protocolConfig',
    title: 'Protokol Ayarları',
    description: 'Bağlantı parametrelerini yapılandırın',
    isComplete: false,
    isActive: false,
  },
  {
    id: 'registerConfig',
    title: 'Register Yapılandırması',
    description: 'Register mapping ayarları (opsiyonel)',
    isComplete: false,
    isActive: false,
    isOptional: true,
  },
  {
    id: 'connectionTest',
    title: 'Bağlantı Testi',
    description: 'VFD bağlantısını test edin',
    isComplete: false,
    isActive: false,
  },
  {
    id: 'review',
    title: 'Onay',
    description: 'Ayarları gözden geçirin ve kaydedin',
    isComplete: false,
    isActive: false,
  },
];

/**
 * Hook for VFD registration wizard state management
 */
export function useVfdRegistrationWizard() {
  const [state, setState] = useState<VfdRegistrationWizardState>({
    currentStep: 0,
    steps: [...DEFAULT_WIZARD_STEPS],
    selectedBrand: undefined,
    selectedProtocol: undefined,
    selectedModelSeries: undefined,
    basicInfo: {},
    protocolConfig: {},
    customRegisterMappings: undefined,
    connectionTestResult: undefined,
    isSubmitting: false,
    isTestingConnection: false,
    error: undefined,
  });

  const nextStep = useCallback(() => {
    setState((prev) => {
      const newSteps = [...prev.steps];
      if (prev.currentStep < newSteps.length - 1) {
        newSteps[prev.currentStep] = { ...newSteps[prev.currentStep], isComplete: true, isActive: false };
        newSteps[prev.currentStep + 1] = { ...newSteps[prev.currentStep + 1], isActive: true };
        return {
          ...prev,
          currentStep: prev.currentStep + 1,
          steps: newSteps,
          error: undefined,
        };
      }
      return prev;
    });
  }, []);

  const prevStep = useCallback(() => {
    setState((prev) => {
      const newSteps = [...prev.steps];
      if (prev.currentStep > 0) {
        newSteps[prev.currentStep] = { ...newSteps[prev.currentStep], isActive: false };
        newSteps[prev.currentStep - 1] = { ...newSteps[prev.currentStep - 1], isActive: true, isComplete: false };
        return {
          ...prev,
          currentStep: prev.currentStep - 1,
          steps: newSteps,
          error: undefined,
        };
      }
      return prev;
    });
  }, []);

  const goToStep = useCallback((step: number) => {
    setState((prev) => {
      if (step >= 0 && step < prev.steps.length) {
        const newSteps = prev.steps.map((s, i) => ({
          ...s,
          isActive: i === step,
        }));
        return {
          ...prev,
          currentStep: step,
          steps: newSteps,
          error: undefined,
        };
      }
      return prev;
    });
  }, []);

  const reset = useCallback(() => {
    setState({
      currentStep: 0,
      steps: DEFAULT_WIZARD_STEPS.map((s, i) => ({
        ...s,
        isComplete: false,
        isActive: i === 0,
      })),
      selectedBrand: undefined,
      selectedProtocol: undefined,
      selectedModelSeries: undefined,
      basicInfo: {},
      protocolConfig: {},
      customRegisterMappings: undefined,
      connectionTestResult: undefined,
      isSubmitting: false,
      isTestingConnection: false,
      error: undefined,
    });
  }, []);

  const setSelectedBrand = useCallback((brand: VfdBrandInfo | undefined) => {
    setState((prev) => ({
      ...prev,
      selectedBrand: brand,
      // Reset protocol when brand changes
      selectedProtocol: undefined,
      protocolConfig: {},
    }));
  }, []);

  const setSelectedProtocol = useCallback((protocol: VfdProtocol | undefined) => {
    setState((prev) => ({
      ...prev,
      selectedProtocol: protocol,
      // Reset protocol config when protocol changes
      protocolConfig: {},
    }));
  }, []);

  const setSelectedModelSeries = useCallback((modelSeries: string | undefined) => {
    setState((prev) => ({
      ...prev,
      selectedModelSeries: modelSeries,
    }));
  }, []);

  const updateBasicInfo = useCallback((updates: Partial<RegisterVfdInput>) => {
    setState((prev) => ({
      ...prev,
      basicInfo: { ...prev.basicInfo, ...updates },
    }));
  }, []);

  const updateProtocolConfig = useCallback((updates: Partial<VfdProtocolConfiguration>) => {
    setState((prev) => ({
      ...prev,
      protocolConfig: { ...prev.protocolConfig, ...updates },
    }));
  }, []);

  const setConnectionTestResult = useCallback((result: VfdConnectionTestResult | undefined) => {
    setState((prev) => ({
      ...prev,
      connectionTestResult: result,
    }));
  }, []);

  const setIsSubmitting = useCallback((isSubmitting: boolean) => {
    setState((prev) => ({ ...prev, isSubmitting }));
  }, []);

  const setIsTestingConnection = useCallback((isTestingConnection: boolean) => {
    setState((prev) => ({ ...prev, isTestingConnection }));
  }, []);

  const setError = useCallback((error: string | undefined) => {
    setState((prev) => ({ ...prev, error }));
  }, []);

  // Build the final registration input from wizard state
  const buildRegistrationInput = useCallback((): RegisterVfdInput | null => {
    if (!state.selectedBrand || !state.selectedProtocol || !state.basicInfo.name) {
      return null;
    }

    return {
      name: state.basicInfo.name,
      brand: state.selectedBrand.code,
      model: state.basicInfo.model,
      modelSeries: state.selectedModelSeries,
      serialNumber: state.basicInfo.serialNumber,
      protocol: state.selectedProtocol,
      protocolConfiguration: state.protocolConfig as VfdProtocolConfiguration,
      farmId: state.basicInfo.farmId,
      tankId: state.basicInfo.tankId,
      pumpId: state.basicInfo.pumpId,
      location: state.basicInfo.location,
      notes: state.basicInfo.notes,
      tags: state.basicInfo.tags,
      skipConnectionTest: false,
    };
  }, [state]);

  // Check if current step is valid
  const isCurrentStepValid = useCallback((): boolean => {
    const stepId = state.steps[state.currentStep]?.id;

    switch (stepId) {
      case 'brand':
        return !!state.selectedBrand;
      case 'protocol':
        return !!state.selectedProtocol;
      case 'basicInfo':
        return !!state.basicInfo.name && state.basicInfo.name.length >= 2;
      case 'protocolConfig':
        return Object.keys(state.protocolConfig).length > 0;
      case 'registerConfig':
        return true; // Optional step
      case 'connectionTest':
        return state.connectionTestResult?.success === true;
      case 'review':
        return true;
      default:
        return false;
    }
  }, [state]);

  return {
    ...state,
    nextStep,
    prevStep,
    goToStep,
    reset,
    setSelectedBrand,
    setSelectedProtocol,
    setSelectedModelSeries,
    updateBasicInfo,
    updateProtocolConfig,
    setConnectionTestResult,
    setIsSubmitting,
    setIsTestingConnection,
    setError,
    buildRegistrationInput,
    isCurrentStepValid,
  };
}
