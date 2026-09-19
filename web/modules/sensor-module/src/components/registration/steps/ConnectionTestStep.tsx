import React, { useState } from 'react';
import { useProtocolConnectionTest } from '../../../hooks/useConnectionTest';
import { ConnectionTestResult } from '../../../types/registration.types';
import { Spinner, Button } from '@aquaculture/shared-ui';
import { Check, TriangleAlert, X } from 'lucide-react';

interface ConnectionTestStepProps {
  protocolCode: string;
  config: Record<string, unknown>;
  onTestComplete: (result: ConnectionTestResult) => void;
  testResult?: ConnectionTestResult | null;
}

export function ConnectionTestStep({
  protocolCode,
  config,
  onTestComplete,
  testResult: initialResult,
}: ConnectionTestStepProps) {
  const { testConnection, retryConnection, result, loading, isRetrying, error, reset } =
    useProtocolConnectionTest();
  const [hasTestedOnce, setHasTestedOnce] = useState(!!initialResult);

  const currentResult = result || initialResult;

  const handleTest = async () => {
    const testResult = await testConnection({
      protocolCode,
      config,
      timeout: 15000,
      fetchSampleData: true,
    });
    setHasTestedOnce(true);
    onTestComplete(testResult);
  };

  const handleRetry = async () => {
    const testResult = await retryConnection({
      protocolCode,
      config,
      timeout: 15000,
      fetchSampleData: true,
    });
    onTestComplete(testResult);
  };

  return (
    <div className="space-y-6">
      {/* Test info */}
      <div className="bg-info-50 dark:bg-info-900/20 border border-info-200 dark:border-info-800 rounded-lg p-4">
        <h3 className="text-lg font-medium text-info-900 dark:text-info-100">Connection Test</h3>
        <p className="text-sm text-info-700 dark:text-info-300 mt-1">
          Test the connection to your sensor before completing registration. This ensures the
          configuration is correct and the sensor is reachable.
        </p>
      </div>

      {/* Test button */}
      {!hasTestedOnce && (
        <div className="text-center py-8">
          <Button variant="primary" onClick={handleTest} disabled={loading}>
            {loading ? (
              <span className="flex items-center">
                <Spinner size="md" color="white" className="-ml-1 mr-3" />
                Testing Connection...
              </span>
            ) : (
              'Start Connection Test'
            )}
          </Button>
        </div>
      )}

      {/* Test in progress */}
      {loading && !currentResult && (
        <div className="text-center py-8">
          <Spinner size="xl" block />
          <p className="mt-4 text-gray-600 dark:text-gray-400">Testing connection to sensor...</p>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
            This may take up to 15 seconds
          </p>
        </div>
      )}

      {/* Test result */}
      {currentResult && (
        <div
          className={`border rounded-lg p-6 ${
            currentResult.success
              ? 'bg-success-50 dark:bg-success-900/20 border-success-200 dark:border-success-800'
              : 'bg-error-50 dark:bg-error-900/20 border-error-200 dark:border-error-800'
          }`}
        >
          {/* Status header */}
          <div className="flex items-center mb-4">
            {currentResult.success ? (
              <>
                <div className="w-12 h-12 bg-success-100 dark:bg-success-900/40 rounded-full flex items-center justify-center">
                  <Check
                    className="w-8 h-8 text-success-600 dark:text-success-400"
                    aria-hidden="true"
                  />
                </div>
                <div className="ml-4">
                  <h3 className="text-lg font-semibold text-success-900 dark:text-success-100">
                    Connection Successful
                  </h3>
                  <p className="text-sm text-success-700 dark:text-success-300">
                    The sensor is reachable and responding
                  </p>
                </div>
              </>
            ) : (
              <>
                <div className="w-12 h-12 bg-error-100 dark:bg-error-900/40 rounded-full flex items-center justify-center">
                  <X className="w-8 h-8 text-error-600 dark:text-error-400" aria-hidden="true" />
                </div>
                <div className="ml-4">
                  <h3 className="text-lg font-semibold text-error-900 dark:text-error-100">
                    Connection Failed
                  </h3>
                  <p className="text-sm text-error-700 dark:text-error-300">
                    Unable to connect to the sensor
                  </p>
                </div>
              </>
            )}
          </div>

          {/* Details */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            <div>
              <span className="text-sm font-medium text-gray-500 dark:text-gray-400">Protocol</span>
              <p className="text-gray-900 dark:text-gray-100">{protocolCode}</p>
            </div>
            <div>
              <span className="text-sm font-medium text-gray-500 dark:text-gray-400">
                Tested At
              </span>
              <p className="text-gray-900 dark:text-gray-100">
                {new Date(currentResult.testedAt).toLocaleString()}
              </p>
            </div>
            {currentResult.latencyMs !== undefined && (
              <div>
                <span className="text-sm font-medium text-gray-500 dark:text-gray-400">
                  Latency
                </span>
                <p className="text-gray-900 dark:text-gray-100">{currentResult.latencyMs} ms</p>
              </div>
            )}
          </div>

          {/* Error message */}
          {currentResult.error && (
            <div className="bg-error-100 dark:bg-error-900/40 border border-error-300 dark:border-error-700 rounded-md p-3 mb-4">
              <p className="text-sm text-error-800 dark:text-error-200">
                <strong>Error:</strong> {currentResult.error}
              </p>
            </div>
          )}

          {/* Sample data */}
          {currentResult.sampleData && Object.keys(currentResult.sampleData).length > 0 && (
            <div className="bg-white dark:bg-gray-900 rounded-md p-3 border border-gray-200 dark:border-gray-700">
              <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Sample Data Received
              </h4>
              <pre className="text-xs text-gray-600 dark:text-gray-400 overflow-auto max-h-32">
                {JSON.stringify(currentResult.sampleData, null, 2)}
              </pre>
            </div>
          )}

          {/* Retry button */}
          <div className="mt-4 flex justify-center">
            <button
              onClick={handleRetry}
              disabled={loading || isRetrying}
              className={`px-4 py-2 rounded-md focus:outline-hidden focus:ring-2 focus:ring-offset-2 ${
                currentResult.success
                  ? 'bg-success-600 text-white hover:bg-success-700 focus:ring-success-500'
                  : 'bg-error-600 text-white hover:bg-error-700 focus:ring-error-500'
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {isRetrying ? 'Retrying...' : 'Retry Test'}
            </button>
          </div>
        </div>
      )}

      {/* Skip test option */}
      {!currentResult?.success && hasTestedOnce && (
        <div className="bg-warning-50 dark:bg-warning-900/20 border border-warning-200 dark:border-warning-800 rounded-lg p-4">
          <div className="flex items-start">
            <TriangleAlert
              className="w-5 h-5 text-warning-600 dark:text-warning-400 mt-0.5"
              aria-hidden="true"
            />
            <div className="ml-3">
              <h4 className="text-sm font-medium text-warning-800 dark:text-warning-200">
                Connection test failed
              </h4>
              <p className="text-sm text-warning-700 dark:text-warning-300 mt-1">
                You can still proceed with registration, but the sensor will be marked as "Test
                Failed" and won't start collecting data until the connection is established.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ConnectionTestStep;
