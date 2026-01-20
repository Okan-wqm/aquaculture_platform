import React, { useState } from 'react';
import { useProtocolConnectionTest } from '../../../hooks/useConnectionTest';
import { ConnectionTestResult } from '../../../types/registration.types';

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
          <button
            onClick={handleTest}
            disabled={loading}
            className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? (
              <span className="flex items-center">
                <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Testing Connection...
              </span>
            ) : (
              'Start Connection Test'
            )}
          </button>
        </div>
      )}

      {/* Test in progress */}
      {loading && !currentResult && (
        <div className="text-center py-8">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Testing connection to sensor...</p>
          <p className="text-sm text-gray-500 mt-2">This may take up to 15 seconds</p>
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
              <span className="text-sm font-medium text-gray-500">Protocol</span>
              <p className="text-gray-900">{protocolCode}</p>
            </div>
            <div>
              <span className="text-sm font-medium text-gray-500">Tested At</span>
              <p className="text-gray-900">{new Date(currentResult.testedAt).toLocaleString()}</p>
            </div>
            {currentResult.latencyMs !== undefined && (
              <div>
                <span className="text-sm font-medium text-gray-500">Latency</span>
                <p className="text-gray-900">{currentResult.latencyMs} ms</p>
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
            <div className="bg-white rounded-md p-3 border border-gray-200">
              <h4 className="text-sm font-medium text-gray-700 mb-2">Sample Data Received</h4>
              <pre className="text-xs text-gray-600 overflow-auto max-h-32">
                {JSON.stringify(currentResult.sampleData, null, 2)}
              </pre>
            </div>
          )}

          {/* Retry button */}
          <div className="mt-4 flex justify-center">
            <button
              onClick={handleRetry}
              disabled={loading || isRetrying}
              className={`px-4 py-2 rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2 ${
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
