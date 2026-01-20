import { useState, useCallback, useMemo, useEffect } from 'react';
import {
  ProtocolInfo,
  ProtocolCategory,
  ProtocolDetails,
  JSONSchema,
  CategoryStats,
  ValidationResult,
} from '../types/registration.types';

// =============================================================================
// GraphQL API
// =============================================================================

const API_URL = 'http://localhost:3000/graphql';

async function fetchGraphQL<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const token = localStorage.getItem('access_token');
  const tenantId = localStorage.getItem('tenant_id');

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(tenantId && { 'X-Tenant-Id': tenantId }),
    },
    body: JSON.stringify({ query, variables }),
  });

  const result = await response.json();
  if (result.errors) {
    throw new Error(result.errors[0]?.message || 'GraphQL error');
  }
  return result.data;
}

// GraphQL Queries
const GET_PROTOCOLS_QUERY = `
  query Protocols($category: ProtocolCategory) {
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

const GET_PROTOCOL_DETAILS_QUERY = `
  query ProtocolDetails($code: String!) {
    protocolDetails(code: $code) {
      id
      code
      name
      description
      category
      subcategory
      connectionType
      configurationSchema
      defaultConfiguration
      isActive
    }
  }
`;

const GET_PROTOCOL_SCHEMA_QUERY = `
  query ProtocolSchema($code: String!) {
    protocolSchema(code: $code)
  }
`;

const GET_PROTOCOL_DEFAULTS_QUERY = `
  query ProtocolDefaults($code: String!) {
    protocolDefaults(code: $code)
  }
`;

const GET_CATEGORY_STATS_QUERY = `
  query ProtocolCategoryStats {
    protocolCategoryStats {
      category
      totalProtocols
      activeProtocols
      subcategories
    }
  }
`;

const VALIDATE_PROTOCOL_CONFIG_MUTATION = `
  mutation ValidateProtocolConfig($input: ValidateProtocolConfigInput!) {
    validateProtocolConfig(input: $input) {
      isValid
      errors {
        field
        message
        code
      }
    }
  }
`;

const APPLY_PROTOCOL_DEFAULTS_MUTATION = `
  mutation ApplyProtocolDefaults($code: String!, $config: JSON!) {
    applyProtocolDefaults(code: $code, config: $config)
  }
`;

// =============================================================================
// Hooks Implementation
// =============================================================================

// Hook to fetch all protocols or by category
export function useProtocols(category?: ProtocolCategory) {
  const [protocols, setProtocols] = useState<ProtocolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await fetchGraphQL<{ protocols: ProtocolInfo[] }>(
        GET_PROTOCOLS_QUERY,
        { category: category || null }
      );
      setProtocols(data.protocols || []);
    } catch (err) {
      setError(err as Error);
      setProtocols([]);
    } finally {
      setLoading(false);
    }
  }, [category]);

  // Auto-fetch on mount
  useEffect(() => {
    refetch();
  }, [refetch]);

  // Group protocols by category
  const protocolsByCategory = useMemo(() => {
    const grouped: Record<ProtocolCategory, ProtocolInfo[]> = {
      [ProtocolCategory.INDUSTRIAL]: [],
      [ProtocolCategory.IOT]: [],
      [ProtocolCategory.SERIAL]: [],
      [ProtocolCategory.WIRELESS]: [],
    };

    protocols.forEach((protocol) => {
      // Backend returns uppercase enum values (INDUSTRIAL), frontend uses lowercase (industrial)
      const normalizedCategory = (typeof protocol.category === 'string'
        ? protocol.category.toLowerCase()
        : protocol.category) as ProtocolCategory;

      if (grouped[normalizedCategory]) {
        grouped[normalizedCategory].push(protocol);
      }
    });

    return grouped;
  }, [protocols]);

  // Group protocols by subcategory within each category
  const protocolsBySubcategory = useMemo(() => {
    const grouped: Record<string, ProtocolInfo[]> = {};

    protocols.forEach((protocol) => {
      const key = `${protocol.category}:${protocol.subcategory}`;
      if (!grouped[key]) {
        grouped[key] = [];
      }
      grouped[key].push(protocol);
    });

    return grouped;
  }, [protocols]);

  return {
    protocols,
    protocolsByCategory,
    protocolsBySubcategory,
    loading,
    error,
    refetch,
  };
}

// Hook to fetch protocol details
export function useProtocolDetails(code: string | undefined) {
  const [protocol, setProtocol] = useState<ProtocolDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    if (!code) return;

    setLoading(true);
    setError(null);

    try {
      const data = await fetchGraphQL<{ protocolDetails: ProtocolDetails }>(
        GET_PROTOCOL_DETAILS_QUERY,
        { code }
      );
      if (data.protocolDetails) {
        setProtocol(data.protocolDetails);
      } else {
        setError(new Error('Protocol not found'));
      }
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [code]);

  useEffect(() => {
    if (code) {
      refetch();
    }
  }, [code, refetch]);

  return {
    protocol,
    loading,
    error,
    refetch,
  };
}

// Hook to fetch protocol schema
export function useProtocolSchema(code: string | undefined) {
  const [schema, setSchema] = useState<JSONSchema | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!code) return;

    setLoading(true);
    setError(null);

    const fetchSchema = async () => {
      try {
        const data = await fetchGraphQL<{ protocolSchema: JSONSchema }>(
          GET_PROTOCOL_SCHEMA_QUERY,
          { code }
        );
        setSchema(data.protocolSchema || { type: 'object', properties: {} });
      } catch (err) {
        setError(err as Error);
        setSchema({ type: 'object', properties: {} });
      } finally {
        setLoading(false);
      }
    };

    fetchSchema();
  }, [code]);

  return {
    schema,
    loading,
    error,
  };
}

// Hook to fetch protocol defaults
export function useProtocolDefaults(code: string | undefined) {
  const [defaults, setDefaults] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!code) return;

    setLoading(true);
    setError(null);

    const fetchDefaults = async () => {
      try {
        const data = await fetchGraphQL<{ protocolDefaults: Record<string, unknown> }>(
          GET_PROTOCOL_DEFAULTS_QUERY,
          { code }
        );
        setDefaults(data.protocolDefaults || {});
      } catch (err) {
        setError(err as Error);
        setDefaults({});
      } finally {
        setLoading(false);
      }
    };

    fetchDefaults();
  }, [code]);

  return {
    defaults,
    loading,
    error,
  };
}

// Hook to fetch category stats
export function useCategoryStats() {
  const [stats, setStats] = useState<CategoryStats[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await fetchGraphQL<{ protocolCategoryStats: CategoryStats[] }>(
        GET_CATEGORY_STATS_QUERY,
        {}
      );
      setStats(data.protocolCategoryStats || []);
    } catch (err) {
      setError(err as Error);
      setStats([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return {
    stats,
    loading,
    error,
    refetch,
  };
}

// Hook for protocol configuration validation
export function useProtocolValidation() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const validate = useCallback(async (
    protocolCode: string,
    config: Record<string, unknown>
  ): Promise<ValidationResult> => {
    setLoading(true);
    setError(null);

    try {
      const data = await fetchGraphQL<{ validateProtocolConfig: ValidationResult }>(
        VALIDATE_PROTOCOL_CONFIG_MUTATION,
        { input: { protocolCode, config } }
      );
      return data.validateProtocolConfig || { isValid: true, errors: [] };
    } catch (err) {
      setError(err as Error);
      return {
        isValid: false,
        errors: [{ field: 'unknown', message: (err as Error).message }],
      };
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    validate,
    loading,
    error,
  };
}

// Hook to apply defaults to config
export function useApplyDefaults() {
  const [loading, setLoading] = useState(false);

  const applyDefaults = useCallback(async (
    protocolCode: string,
    config: Record<string, unknown>
  ): Promise<Record<string, unknown>> => {
    setLoading(true);

    try {
      const data = await fetchGraphQL<{ applyProtocolDefaults: Record<string, unknown> }>(
        APPLY_PROTOCOL_DEFAULTS_MUTATION,
        { code: protocolCode, config }
      );
      return data.applyProtocolDefaults || config;
    } catch {
      return config;
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    applyDefaults,
    loading,
  };
}

// Helper hook to get category display info
export function useCategoryInfo() {
  const categoryInfo: Record<
    ProtocolCategory,
    { title: string; description: string; icon: string }
  > = {
    [ProtocolCategory.INDUSTRIAL]: {
      title: 'Industrial',
      description: 'Modbus, OPC UA, PLCs, SCADA systems',
      icon: 'factory',
    },
    [ProtocolCategory.IOT]: {
      title: 'IoT',
      description: 'MQTT, HTTP/REST, WebSocket, CoAP',
      icon: 'wifi',
    },
    [ProtocolCategory.SERIAL]: {
      title: 'Serial/Network',
      description: 'RS-232, RS-485, TCP/UDP, I2C, SPI',
      icon: 'cable',
    },
    [ProtocolCategory.WIRELESS]: {
      title: 'Wireless',
      description: 'LoRaWAN, Zigbee, BLE, Z-Wave',
      icon: 'antenna',
    },
  };

  return categoryInfo;
}
