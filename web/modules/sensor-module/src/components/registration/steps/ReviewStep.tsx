import React from 'react';
import {
  ProtocolInfo,
  ConnectionTestResult,
  SensorType,
  ChildSensorConfig,
  ParentDeviceInfo,
} from '../../../types/registration.types';

interface ReviewStepProps {
  protocol: ProtocolInfo | null;
  basicInfo: Partial<ParentDeviceInfo>;
  protocolConfig: Record<string, unknown>;
  connectionTestResult?: ConnectionTestResult | null;
  childSensors?: ChildSensorConfig[];
  onEdit: (step: number) => void;
}

const SENSOR_TYPE_LABELS: Record<SensorType, string> = {
  [SensorType.TEMPERATURE]: 'Temperature',
  [SensorType.PH]: 'pH',
  [SensorType.DISSOLVED_OXYGEN]: 'Dissolved Oxygen',
  [SensorType.AMMONIA]: 'Ammonia',
  [SensorType.NITRITE]: 'Nitrite',
  [SensorType.NITRATE]: 'Nitrate',
  [SensorType.SALINITY]: 'Salinity',
  [SensorType.TURBIDITY]: 'Turbidity',
  [SensorType.WATER_LEVEL]: 'Water Level',
  [SensorType.FLOW_RATE]: 'Flow Rate',
  [SensorType.PRESSURE]: 'Pressure',
  [SensorType.CONDUCTIVITY]: 'Conductivity',
  [SensorType.ORP]: 'ORP',
  [SensorType.CO2]: 'CO2',
  [SensorType.CHLORINE]: 'Chlorine',
  [SensorType.MULTI_PARAMETER]: 'Multi-Parameter',
  [SensorType.CAMERA]: 'Camera',
  [SensorType.OTHER]: 'Other',
};

function Section({
  title,
  stepIndex,
  onEdit,
  children,
}: {
  title: string;
  stepIndex: number;
  onEdit: (step: number) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <div className="flex justify-between items-center bg-gray-50 px-4 py-3 border-b">
        <h3 className="font-medium text-gray-900">{title}</h3>
        <button
          onClick={() => onEdit(stepIndex)}
          className="text-sm text-blue-600 hover:text-blue-800"
        >
          Edit
        </button>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function DataRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between py-2 border-b border-gray-100 last:border-0">
      <span className="text-gray-600">{label}</span>
      <span className="text-gray-900 font-medium">{value || '-'}</span>
    </div>
  );
}

export function ReviewStep({
  protocol,
  basicInfo,
  protocolConfig,
  connectionTestResult,
  childSensors = [],
  onEdit,
}: ReviewStepProps) {
  const selectedChildSensors = childSensors.filter((c) => c.selected);

  return (
    <div className="space-y-6">
      {/* Summary header */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h3 className="text-lg font-medium text-blue-900">Review Your Registration</h3>
        <p className="text-sm text-blue-700 mt-1">
          You are about to register <strong>1 parent device</strong> with{' '}
          <strong>{selectedChildSensors.length} child sensor{selectedChildSensors.length !== 1 ? 's' : ''}</strong>.
          Please review all information before completing the registration.
        </p>
      </div>

      {/* Protocol section */}
      <Section title="Protocol" stepIndex={0} onEdit={onEdit}>
        {protocol ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-lg font-semibold text-gray-900">{protocol.displayName}</span>
              <span className="px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded">
                {protocol.category}
              </span>
            </div>
            <p className="text-sm text-gray-600">{protocol.description}</p>
            <div className="flex gap-2">
              <span className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded">
                {protocol.subcategory}
              </span>
              <span className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded">
                {protocol.connectionType}
              </span>
            </div>
          </div>
        ) : (
          <p className="text-red-600">No protocol selected</p>
        )}
      </Section>

      {/* Protocol configuration section */}
      <Section title="Protocol Configuration" stepIndex={1} onEdit={onEdit}>
        <div className="space-y-0">
          {Object.entries(protocolConfig).map(([key, value]) => (
            <DataRow
              key={key}
              label={key}
              value={
                typeof value === 'object' ? (
                  <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">
                    {JSON.stringify(value)}
                  </code>
                ) : (
                  String(value)
                )
              }
            />
          ))}
          {Object.keys(protocolConfig).length === 0 && (
            <p className="text-gray-500 italic">No configuration values set</p>
          )}
        </div>
      </Section>

      {/* Connection test section */}
      <Section title="Connection Test" stepIndex={2} onEdit={onEdit}>
        {connectionTestResult ? (
          <div className="space-y-2">
            <div className="flex items-center">
              {connectionTestResult.success ? (
                <>
                  <span className="w-3 h-3 bg-green-500 rounded-full mr-2"></span>
                  <span className="text-green-700 font-medium">Connection Successful</span>
                </>
              ) : (
                <>
                  <span className="w-3 h-3 bg-red-500 rounded-full mr-2"></span>
                  <span className="text-red-700 font-medium">Connection Failed</span>
                </>
              )}
            </div>
            {connectionTestResult.latencyMs !== undefined && (
              <p className="text-sm text-gray-600">Latency: {connectionTestResult.latencyMs} ms</p>
            )}
            {connectionTestResult.error && (
              <p className="text-sm text-red-600">Error: {connectionTestResult.error}</p>
            )}
            <p className="text-xs text-gray-500">
              Tested at: {new Date(connectionTestResult.testedAt).toLocaleString()}
            </p>
          </div>
        ) : (
          <div className="flex items-center">
            <span className="w-3 h-3 bg-yellow-500 rounded-full mr-2"></span>
            <span className="text-yellow-700">Not tested</span>
          </div>
        )}
      </Section>

      {/* Parent device info section */}
      <Section title="Parent Device Information" stepIndex={3} onEdit={onEdit}>
        <div className="space-y-0">
          <DataRow label="Device Name" value={basicInfo.name} />
          <DataRow label="Manufacturer" value={basicInfo.manufacturer} />
          <DataRow label="Model" value={basicInfo.model} />
          <DataRow label="Serial Number" value={basicInfo.serialNumber} />
          <DataRow label="Location" value={basicInfo.location} />
          {basicInfo.description && (
            <div className="py-2">
              <span className="text-gray-600">Description</span>
              <p className="text-gray-900 mt-1">{basicInfo.description}</p>
            </div>
          )}
        </div>
        {(basicInfo.farmId || basicInfo.pondId || basicInfo.tankId) && (
          <div className="mt-4 pt-4 border-t border-gray-200">
            <h4 className="text-sm font-medium text-gray-700 mb-2">Assignment</h4>
            <div className="grid grid-cols-3 gap-4">
              {basicInfo.farmId && (
                <div>
                  <span className="text-xs text-gray-500">Farm</span>
                  <p className="text-sm text-gray-900">{basicInfo.farmId}</p>
                </div>
              )}
              {basicInfo.pondId && (
                <div>
                  <span className="text-xs text-gray-500">Pond</span>
                  <p className="text-sm text-gray-900">{basicInfo.pondId}</p>
                </div>
              )}
              {basicInfo.tankId && (
                <div>
                  <span className="text-xs text-gray-500">Tank</span>
                  <p className="text-sm text-gray-900">{basicInfo.tankId}</p>
                </div>
              )}
            </div>
          </div>
        )}
      </Section>

      {/* Child sensors section */}
      <Section title="Child Sensors" stepIndex={4} onEdit={onEdit}>
        {selectedChildSensors.length > 0 ? (
          <div className="space-y-2">
            <p className="text-sm text-gray-600 mb-3">
              {selectedChildSensors.length} sensor{selectedChildSensors.length !== 1 ? 's' : ''} will be registered
            </p>
            <div className="divide-y divide-gray-100">
              {selectedChildSensors.map((sensor, index) => (
                <div key={sensor.dataPath} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center min-w-0">
                      <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-600 text-xs font-medium mr-3">
                        {index + 1}
                      </span>
                      <div>
                        <span className="font-medium text-gray-900">{sensor.name}</span>
                        <div className="flex items-center mt-0.5 space-x-2">
                          <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded text-gray-600">
                            {sensor.dataPath}
                          </code>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center space-x-2 ml-4">
                      <span className="px-2 py-0.5 bg-blue-50 text-blue-700 text-xs rounded">
                        {SENSOR_TYPE_LABELS[sensor.type] || sensor.type}
                      </span>
                      {sensor.unit && (
                        <span className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded">
                          {sensor.unit}
                        </span>
                      )}
                    </div>
                  </div>
                  {/* Configuration summary */}
                  <div className="mt-2 ml-9 flex flex-wrap gap-1.5">
                    {sensor.calibrationEnabled && (
                      <span className="px-1.5 py-0.5 bg-orange-50 text-orange-700 text-xs rounded">
                        Calibration: x{sensor.calibrationMultiplier} +{sensor.calibrationOffset}
                      </span>
                    )}
                    {sensor.alertThresholds?.warning && (
                      <span className="px-1.5 py-0.5 bg-yellow-50 text-yellow-700 text-xs rounded">
                        Warning: {sensor.alertThresholds.warning.low ?? '-'} - {sensor.alertThresholds.warning.high ?? '-'}
                      </span>
                    )}
                    {sensor.alertThresholds?.critical && (
                      <span className="px-1.5 py-0.5 bg-red-50 text-red-700 text-xs rounded">
                        Critical: {sensor.alertThresholds.critical.low ?? '-'} - {sensor.alertThresholds.critical.high ?? '-'}
                      </span>
                    )}
                    {sensor.displaySettings?.showOnDashboard && (
                      <span className="px-1.5 py-0.5 bg-purple-50 text-purple-700 text-xs rounded">
                        Dashboard
                      </span>
                    )}
                    {sensor.isConfigured ? (
                      <span className="px-1.5 py-0.5 bg-green-50 text-green-700 text-xs rounded">
                        Configured
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 bg-gray-100 text-gray-600 text-xs rounded">
                        Default settings
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="text-red-600">
            <p>No sensors selected</p>
            <p className="text-xs mt-1">
              Please go back and select at least one sensor to register.
            </p>
          </div>
        )}
      </Section>

      {/* Summary box */}
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
        <h4 className="font-medium text-gray-900 mb-2">Registration Summary</h4>
        <div className="grid grid-cols-3 gap-4 text-center">
          <div className="bg-white rounded-lg p-3">
            <div className="text-2xl font-bold text-blue-600">1</div>
            <div className="text-xs text-gray-500">Parent Device</div>
          </div>
          <div className="bg-white rounded-lg p-3">
            <div className="text-2xl font-bold text-green-600">{selectedChildSensors.length}</div>
            <div className="text-xs text-gray-500">Child Sensors</div>
          </div>
          <div className="bg-white rounded-lg p-3">
            <div className="text-2xl font-bold text-purple-600">{1 + selectedChildSensors.length}</div>
            <div className="text-xs text-gray-500">Total Records</div>
          </div>
        </div>
      </div>

      {/* Warning if test failed */}
      {connectionTestResult && !connectionTestResult.success && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <div className="flex items-start">
            <svg
              className="w-5 h-5 text-yellow-600 mt-0.5"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fillRule="evenodd"
                d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                clipRule="evenodd"
              />
            </svg>
            <div className="ml-3">
              <h4 className="text-sm font-medium text-yellow-800">Warning</h4>
              <p className="text-sm text-yellow-700 mt-1">
                The connection test failed. The device and sensors will be registered with a "Test Failed" status
                and won't start collecting data until the connection is established.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ReviewStep;
