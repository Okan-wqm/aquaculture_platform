import { useState, useCallback } from 'react';
import { ConnectionTestResult } from '../types/registration.types';

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

// GraphQL Mutations
const TEST_SENSOR_CONNECTION_MUTATION = `
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

const TEST_PROTOCOL_CONNECTION_MUTATION = `
  mutation TestProtocolConnection($input: TestConnectionInput!) {
    testProtocolConnection(input: $input) {
      success
      protocolCode
      latencyMs
      error
      testedAt
      sampleData {
        timestamp
        values
        quality
        source
      }
    }
  }
`;

export interface ConnectionTestOptions {
  timeout?: number;
  fetchSampleData?: boolean;
}

export interface ProtocolConnectionTestInput {
  protocolCode: string;
  config: Record<string, unknown>;
  timeout?: number;
  fetchSampleData?: boolean;
}

// Hook for testing sensor connection (existing sensor)
export function useSensorConnectionTest() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ConnectionTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const testConnection = useCallback(
    async (sensorId: string): Promise<ConnectionTestResult> => {
      setLoading(true);
      setError(null);

      try {
        const data = await graphqlFetch<{
          testSensorConnection: ConnectionTestResult;
        }>(TEST_SENSOR_CONNECTION_MUTATION, { sensorId });

        const testResult = data.testSensorConnection || {
          success: false,
          error: 'Test failed',
          testedAt: new Date().toISOString(),
        };

        setResult(testResult);
        return testResult;
      } catch (err) {
        const errorResult: ConnectionTestResult = {
          success: false,
          error: (err as Error).message,
          testedAt: new Date().toISOString(),
        };
        setResult(errorResult);
        setError((err as Error).message);
        return errorResult;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return {
    testConnection,
    result,
    loading,
    error,
    reset,
  };
}

// Hook for testing protocol connection (before registration)
export function useProtocolConnectionTest() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ConnectionTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);

  const testConnection = useCallback(
    async (input: ProtocolConnectionTestInput): Promise<ConnectionTestResult> => {
      setLoading(true);
      setError(null);

      try {
        const data = await graphqlFetch<{
          testProtocolConnection: {
            success: boolean;
            protocolCode: string;
            latencyMs?: number;
            error?: string;
            sampleData?: {
              timestamp: string;
              values: Record<string, unknown>;
              quality: number;
              source: string;
            };
            testedAt: string;
          };
        }>(TEST_PROTOCOL_CONNECTION_MUTATION, {
          input: {
            protocolCode: input.protocolCode,
            config: input.config,
            timeout: input.timeout || 10000,
            fetchSampleData: input.fetchSampleData ?? true,
          },
        });

        const testResult: ConnectionTestResult = {
          success: data.testProtocolConnection.success || false,
          latencyMs: data.testProtocolConnection.latencyMs,
          error: data.testProtocolConnection.error,
          sampleData: data.testProtocolConnection.sampleData?.values as Record<string, unknown>,
          testedAt: data.testProtocolConnection.testedAt || new Date().toISOString(),
        };

        setResult(testResult);
        return testResult;
      } catch (err) {
        const errorResult: ConnectionTestResult = {
          success: false,
          error: (err as Error).message,
          testedAt: new Date().toISOString(),
        };
        setResult(errorResult);
        setError((err as Error).message);
        return errorResult;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const retryConnection = useCallback(
    async (input: ProtocolConnectionTestInput): Promise<ConnectionTestResult> => {
      setIsRetrying(true);
      const result = await testConnection(input);
      setIsRetrying(false);
      return result;
    },
    [testConnection]
  );

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
    setIsRetrying(false);
  }, []);

  return {
    testConnection,
    retryConnection,
    result,
    loading,
    isRetrying,
    error,
    reset,
  };
}

// Hook for batch connection testing
export function useBatchConnectionTest() {
  const [results, setResults] = useState<Map<string, ConnectionTestResult>>(new Map());
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });

  const { testConnection } = useProtocolConnectionTest();

  const testBatch = useCallback(
    async (
      tests: Array<{ id: string; protocolCode: string; config: Record<string, unknown> }>
    ): Promise<Map<string, ConnectionTestResult>> => {
      setLoading(true);
      setProgress({ current: 0, total: tests.length });

      const newResults = new Map<string, ConnectionTestResult>();

      for (let i = 0; i < tests.length; i++) {
        const test = tests[i];
        const result = await testConnection({
          protocolCode: test.protocolCode,
          config: test.config,
          timeout: 5000,
          fetchSampleData: false,
        });
        newResults.set(test.id, result);
        setProgress({ current: i + 1, total: tests.length });
      }

      setResults(newResults);
      setLoading(false);
      return newResults;
    },
    [testConnection]
  );

  const reset = useCallback(() => {
    setResults(new Map());
    setProgress({ current: 0, total: 0 });
  }, []);

  return {
    testBatch,
    results,
    loading,
    progress,
    reset,
  };
}

// Hook for connection health monitoring
export function useConnectionHealth(
  sensorId: string | undefined,
  _intervalMs: number = 30000,
  _enabled: boolean = true
) {
  const { testConnection, result, loading } = useSensorConnectionTest();
  const [history, setHistory] = useState<ConnectionTestResult[]>([]);

  const checkHealth = useCallback(async () => {
    if (!sensorId) return null;
    const result = await testConnection(sensorId);
    setHistory((prev) => [...prev.slice(-9), result]); // Keep last 10 results
    return result;
  }, [sensorId, testConnection]);

  const getSuccessRate = useCallback(() => {
    if (history.length === 0) return 100;
    const successful = history.filter((r) => r.success).length;
    return Math.round((successful / history.length) * 100);
  }, [history]);

  const getAverageLatency = useCallback(() => {
    const latencies = history.filter((r) => r.latencyMs !== undefined).map((r) => r.latencyMs!);
    if (latencies.length === 0) return 0;
    return Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
  }, [history]);

  const reset = useCallback(() => {
    setHistory([]);
  }, []);

  return {
    checkHealth,
    lastResult: result,
    history,
    loading,
    successRate: getSuccessRate(),
    averageLatency: getAverageLatency(),
    reset,
  };
}
