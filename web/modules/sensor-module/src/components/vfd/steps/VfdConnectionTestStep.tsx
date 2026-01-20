import React from 'react';
import {
  VfdProtocol,
  VfdBrand,
  VfdProtocolConfiguration,
  VfdConnectionTestResult,
  VFD_PROTOCOL_NAMES,
  VFD_PARAMETER_UNITS,
} from '../../../types/vfd.types';

interface VfdConnectionTestStepProps {
  protocol: VfdProtocol;
  config: VfdProtocolConfiguration;
  brand?: VfdBrand;
  testResult?: VfdConnectionTestResult;
  isTestingConnection: boolean;
  onTest: () => void;
}

export function VfdConnectionTestStep({
  protocol,
  config,
  brand,
  testResult,
  isTestingConnection,
  onTest,
}: VfdConnectionTestStepProps) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-gray-900 mb-2">Bağlantı Testi</h3>
        <p className="text-sm text-gray-500">
          VFD cihazınızla bağlantıyı test edin. Başarılı bir test, cihazın doğru yapılandırıldığını
          doğrular.
        </p>
      </div>

      {/* Configuration Summary */}
      <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
        <h4 className="text-sm font-medium text-gray-700 mb-3">Yapılandırma Özeti</h4>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
          <div>
            <span className="text-gray-500">Protokol:</span>{' '}
            <span className="font-medium">{VFD_PROTOCOL_NAMES[protocol]}</span>
          </div>
          {renderConfigSummary(protocol, config)}
        </div>
      </div>

      {/* Test Button */}
      <div className="flex justify-center">
        <button
          onClick={onTest}
          disabled={isTestingConnection}
          className={`px-8 py-4 rounded-lg font-medium text-white transition-all ${
            isTestingConnection
              ? 'bg-gray-400 cursor-not-allowed'
              : testResult?.success
              ? 'bg-green-600 hover:bg-green-700'
              : testResult?.success === false
              ? 'bg-red-600 hover:bg-red-700'
              : 'bg-blue-600 hover:bg-blue-700'
          }`}
        >
          {isTestingConnection ? (
            <span className="flex items-center">
              <svg
                className="animate-spin -ml-1 mr-3 h-5 w-5 text-white"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              Bağlantı Test Ediliyor...
            </span>
          ) : testResult?.success ? (
            <span className="flex items-center">
              <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                  clipRule="evenodd"
                />
              </svg>
              Tekrar Test Et
            </span>
          ) : testResult?.success === false ? (
            <span className="flex items-center">
              <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z"
                  clipRule="evenodd"
                />
              </svg>
              Tekrar Dene
            </span>
          ) : (
            <span className="flex items-center">
              <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z"
                  clipRule="evenodd"
                />
              </svg>
              Bağlantıyı Test Et
            </span>
          )}
        </button>
      </div>

      {/* Test Result */}
      {testResult && (
        <div
          className={`p-6 rounded-lg border ${
            testResult.success
              ? 'bg-green-50 border-green-200'
              : 'bg-red-50 border-red-200'
          }`}
        >
          {testResult.success ? (
            <div className="space-y-4">
              {/* Success Header */}
              <div className="flex items-center">
                <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mr-4">
                  <svg className="w-6 h-6 text-green-600" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                      clipRule="evenodd"
                    />
                  </svg>
                </div>
                <div>
                  <h4 className="text-lg font-semibold text-green-800">Bağlantı Başarılı!</h4>
                  <p className="text-sm text-green-600">
                    VFD cihazı ile iletişim kuruldu.
                    {testResult.latencyMs && ` Gecikme: ${testResult.latencyMs}ms`}
                  </p>
                </div>
              </div>

              {/* Device Info */}
              {testResult.deviceInfo && (
                <div className="bg-white rounded-lg p-4 border border-green-200">
                  <h5 className="text-sm font-medium text-gray-700 mb-2">Cihaz Bilgileri</h5>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                    {testResult.deviceInfo.manufacturer && (
                      <div>
                        <span className="text-gray-500">Üretici:</span>{' '}
                        <span className="font-medium">{testResult.deviceInfo.manufacturer}</span>
                      </div>
                    )}
                    {testResult.deviceInfo.model && (
                      <div>
                        <span className="text-gray-500">Model:</span>{' '}
                        <span className="font-medium">{testResult.deviceInfo.model}</span>
                      </div>
                    )}
                    {testResult.firmwareVersion && (
                      <div>
                        <span className="text-gray-500">Firmware:</span>{' '}
                        <span className="font-medium">{testResult.firmwareVersion}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Sample Data */}
              {testResult.sampleData && Object.keys(testResult.sampleData).length > 0 && (
                <div className="bg-white rounded-lg p-4 border border-green-200">
                  <h5 className="text-sm font-medium text-gray-700 mb-2">Anlık Parametreler</h5>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {Object.entries(testResult.sampleData).map(([key, value]) => (
                      <ParameterCard
                        key={key}
                        name={key}
                        value={value as number}
                        unit={VFD_PARAMETER_UNITS[key]}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Status Bits */}
              {testResult.statusBits && Object.keys(testResult.statusBits).length > 0 && (
                <div className="bg-white rounded-lg p-4 border border-green-200">
                  <h5 className="text-sm font-medium text-gray-700 mb-2">Durum Bilgileri</h5>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(testResult.statusBits).map(([key, value]) => (
                      <StatusBit key={key} name={key} active={value as boolean} />
                    ))}
                  </div>
                </div>
              )}

              {/* Diagnostics */}
              {testResult.diagnostics && (
                <div className="bg-white rounded-lg p-4 border border-green-200">
                  <h5 className="text-sm font-medium text-gray-700 mb-2">İletişim İstatistikleri</h5>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                    <div>
                      <span className="text-gray-500">Gönderilen:</span>{' '}
                      <span className="font-medium">{testResult.diagnostics.packetsSent}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Alınan:</span>{' '}
                      <span className="font-medium">{testResult.diagnostics.packetsReceived}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Ort. Gecikme:</span>{' '}
                      <span className="font-medium">{testResult.diagnostics.averageLatency}ms</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Hatalar:</span>{' '}
                      <span className={`font-medium ${testResult.diagnostics.communicationErrors > 0 ? 'text-red-600' : 'text-green-600'}`}>
                        {testResult.diagnostics.communicationErrors}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {/* Error Header */}
              <div className="flex items-center">
                <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center mr-4">
                  <svg className="w-6 h-6 text-red-600" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                      clipRule="evenodd"
                    />
                  </svg>
                </div>
                <div>
                  <h4 className="text-lg font-semibold text-red-800">Bağlantı Başarısız</h4>
                  <p className="text-sm text-red-600">
                    {testResult.error || 'VFD cihazı ile bağlantı kurulamadı.'}
                  </p>
                </div>
              </div>

              {/* Error Code */}
              {testResult.errorCode && (
                <div className="bg-white rounded-lg p-4 border border-red-200">
                  <p className="text-sm">
                    <span className="text-gray-500">Hata Kodu:</span>{' '}
                    <span className="font-mono font-medium text-red-600">{testResult.errorCode}</span>
                  </p>
                </div>
              )}

              {/* Troubleshooting Tips */}
              <div className="bg-white rounded-lg p-4 border border-red-200">
                <h5 className="text-sm font-medium text-gray-700 mb-2">Kontrol Edilecekler:</h5>
                <ul className="space-y-1 text-sm text-gray-600">
                  <li className="flex items-center">
                    <svg className="w-4 h-4 mr-2 text-gray-400" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                    Kablo bağlantılarını kontrol edin
                  </li>
                  <li className="flex items-center">
                    <svg className="w-4 h-4 mr-2 text-gray-400" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                    VFD cihazının iletişim ayarlarını doğrulayın
                  </li>
                  <li className="flex items-center">
                    <svg className="w-4 h-4 mr-2 text-gray-400" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                    Slave ID / Unit ID değerini kontrol edin
                  </li>
                  <li className="flex items-center">
                    <svg className="w-4 h-4 mr-2 text-gray-400" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                    Baud rate ve parity ayarlarını eşleştirin
                  </li>
                </ul>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Skip Info */}
      {!testResult && (
        <div className="text-center text-sm text-gray-500">
          <p>Bağlantı testini atlayabilirsiniz, ancak cihazın doğru çalıştığını doğrulamak için test yapmanızı öneririz.</p>
        </div>
      )}
    </div>
  );
}

// Helper component for parameter display
function ParameterCard({ name, value, unit }: { name: string; value: number; unit?: string }) {
  const displayNames: Record<string, string> = {
    outputFrequency: 'Frekans',
    motorSpeed: 'Hız',
    motorCurrent: 'Akım',
    motorVoltage: 'Gerilim',
    dcBusVoltage: 'DC Bus',
    outputPower: 'Güç',
    driveTemperature: 'Sıcaklık',
    motorTorque: 'Tork',
  };

  return (
    <div className="bg-gray-50 rounded-lg p-3 text-center">
      <div className="text-xs text-gray-500 mb-1">{displayNames[name] || name}</div>
      <div className="text-lg font-semibold text-gray-900">
        {value?.toFixed(1) || '-'}
        {unit && <span className="text-sm font-normal text-gray-500 ml-1">{unit}</span>}
      </div>
    </div>
  );
}

// Helper component for status bits
function StatusBit({ name, active }: { name: string; active: boolean }) {
  const displayNames: Record<string, string> = {
    ready: 'Hazır',
    running: 'Çalışıyor',
    fault: 'Arıza',
    warning: 'Uyarı',
    atSetpoint: 'Referansta',
    direction: 'Yön',
    remoteControl: 'Uzaktan',
    enabled: 'Aktif',
  };

  return (
    <span
      className={`px-2 py-1 text-xs rounded-full ${
        active
          ? name === 'fault'
            ? 'bg-red-100 text-red-700'
            : name === 'warning'
            ? 'bg-yellow-100 text-yellow-700'
            : 'bg-green-100 text-green-700'
          : 'bg-gray-100 text-gray-500'
      }`}
    >
      {displayNames[name] || name}: {active ? 'Evet' : 'Hayır'}
    </span>
  );
}

// Helper to render config summary based on protocol
function renderConfigSummary(protocol: VfdProtocol, config: VfdProtocolConfiguration) {
  const items: React.ReactNode[] = [];

  switch (protocol) {
    case VfdProtocol.MODBUS_RTU: {
      const rtuConfig = config as any;
      if (rtuConfig.serialPort) {
        items.push(
          <div key="port">
            <span className="text-gray-500">Port:</span>{' '}
            <span className="font-medium">{rtuConfig.serialPort}</span>
          </div>
        );
      }
      if (rtuConfig.slaveId) {
        items.push(
          <div key="slaveId">
            <span className="text-gray-500">Slave ID:</span>{' '}
            <span className="font-medium">{rtuConfig.slaveId}</span>
          </div>
        );
      }
      if (rtuConfig.baudRate) {
        items.push(
          <div key="baudRate">
            <span className="text-gray-500">Baud Rate:</span>{' '}
            <span className="font-medium">{rtuConfig.baudRate}</span>
          </div>
        );
      }
      break;
    }
    case VfdProtocol.MODBUS_TCP: {
      const tcpConfig = config as any;
      if (tcpConfig.host) {
        items.push(
          <div key="host">
            <span className="text-gray-500">IP:</span>{' '}
            <span className="font-medium">{tcpConfig.host}</span>
          </div>
        );
      }
      if (tcpConfig.port) {
        items.push(
          <div key="port">
            <span className="text-gray-500">Port:</span>{' '}
            <span className="font-medium">{tcpConfig.port}</span>
          </div>
        );
      }
      if (tcpConfig.unitId) {
        items.push(
          <div key="unitId">
            <span className="text-gray-500">Unit ID:</span>{' '}
            <span className="font-medium">{tcpConfig.unitId}</span>
          </div>
        );
      }
      break;
    }
    default: {
      const genericConfig = config as Record<string, unknown>;
      const firstThreeKeys = Object.keys(genericConfig).slice(0, 3);
      firstThreeKeys.forEach((key) => {
        items.push(
          <div key={key}>
            <span className="text-gray-500">{key}:</span>{' '}
            <span className="font-medium">{String(genericConfig[key])}</span>
          </div>
        );
      });
    }
  }

  return items;
}

export default VfdConnectionTestStep;
