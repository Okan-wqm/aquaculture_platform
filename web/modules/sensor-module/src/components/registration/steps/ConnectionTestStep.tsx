import React, { useState } from 'react';
import { useProtocolConnectionTest } from '../../../hooks/useConnectionTest';
import { ConnectionTestResult } from '../../../types/registration.types';
import { Spinner, Button } from '@aquaculture/shared-ui';

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
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h3 className="text-lg font-medium text-blue-900">Connection Test</h3>
        <p className="text-sm text-blue-700 mt-1">
          Test the connection to your sensor before completing registration. This ensures
          the configuration is correct and the sensor is reachable.
        </p>
      </div>

      {/* Test button */}
      {!hasTestedOnce && (
        <div className="text-center py-8">
          <Button variant="primary" onClick={handleTest} disabled={loading}>{loading ? (
              <span className="flex items-center">
                <Spinner size="md" color="white" className="-ml-1 mr-3" />
                Testing Connection...
              </span>
            ) : (
              'Start Connection Test'
            )}</Button>
        </div>
      )}

      {/* Test in progress */}
      {loading && !currentResult && (
        <div className="text-center py-8">
          <Spinner size="xl" block />
          <p className="mt-4 text-gray-600 dark:text-gray-400">Testing connection to sensor...</p>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">This may take up to 15 seconds</p>
        </div>
      )}

      {/* Test result */}
      {currentResult && (
        <div
          className={`border rounded-lg p-6 ${
            currentResult.success
              ? 'bg-green-50 border-green-200'
              : 'bg-red-50 border-red-200'
          }`}
        >
          {/* Status header */}
          <div className="flex items-center mb-4">
            {currentResult.success ? (
              <>
                <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center">
                  <svg className="w-8 h-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <div className="ml-4">
                  <h3 className="text-lg font-semibold text-green-900">Connection Successful</h3>
                  <p className="text-sm text-green-700">The sensor is reachable and responding</p>
                </div>
              </>
            ) : (
              <>
                <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center">
                  <svg className="w-8 h-8 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </div>
                <div className="ml-4">
                  <h3 className="text-lg font-semibold text-red-900">Connection Failed</h3>
                  <p className="text-sm text-red-700">Unable to connect to the sensor</p>
                </div>
              </>
            )}
          </div>

          {/* Details */}
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <span className="text-sm font-medium text-gray-500 dark:text-gray-400">Protocol</span>
              <p className="text-gray-900 dark:text-gray-100">{protocolCode}</p>
            </div>
            <div>
              <span className="text-sm font-medium text-gray-500 dark:text-gray-400">Tested At</span>
              <p className="text-gray-900 dark:text-gray-100">{new Date(currentResult.testedAt).toLocaleString()}</p>
            </div>
            {currentResult.latencyMs !== undefined && (
              <div>
                <span className="text-sm font-medium text-gray-500 dark:text-gray-400">Latency</span>
                <p className="text-gray-900 dark:text-gray-100">{currentResult.latencyMs} ms</p>
              </div>
            )}
          </div>

          {/* Error message */}
          {currentResult.error && (
            <div className="bg-red-100 border border-red-300 rounded-md p-3 mb-4">
              <p className="text-sm text-red-800">
                <strong>Error:</strong> {currentResult.error}
              </p>
            </div>
          )}

          {/* Sample data */}
          {currentResult.sampleData && Object.keys(currentResult.sampleData).length > 0 && (
            <div className="bg-white dark:bg-gray-900 rounded-md p-3 border border-gray-200 dark:border-gray-700">
              <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Sample Data Received</h4>
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
                  ? 'bg-green-600 text-white hover:bg-green-700 focus:ring-green-500'
                  : 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500'
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {isRetrying ? 'Retrying...' : 'Retry Test'}
            </button>
          </div>
        </div>
      )}

      {/* Skip test option */}
      {!currentResult?.success && hasTestedOnce && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <div className="flex items-start">
            <svg className="w-5 h-5 text-yellow-600 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            <div className="ml-3">
              <h4 className="text-sm font-medium text-yellow-800">Connection test failed</h4>
              <p className="text-sm text-yellow-700 mt-1">
                You can still proceed with registration, but the sensor will be marked as "Test Failed"
                and won't start collecting data until the connection is established.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ConnectionTestStep;
