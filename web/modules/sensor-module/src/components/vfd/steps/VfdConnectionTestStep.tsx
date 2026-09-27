import React from 'react';
import {
  VfdProtocol,
  VfdBrand,
  VfdProtocolConfiguration,
  VfdConnectionTestResult,
  VFD_PROTOCOL_NAMES,
  VFD_PARAMETER_UNITS,
} from '../../../types/vfd.types';
import { Spinner } from '@aquaculture/shared-ui';
import { CircleCheck, CircleX, RefreshCw, Zap } from 'lucide-react';

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
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
          Bağlantı Testi
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          VFD cihazınızla bağlantıyı test edin. Başarılı bir test, cihazın doğru yapılandırıldığını
          doğrular.
        </p>
      </div>

      {/* Configuration Summary */}
      <div className="p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
        <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
          Yapılandırma Özeti
        </h4>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
          <div>
            <span className="text-gray-500 dark:text-gray-400">Protokol:</span>{' '}
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
                ? 'bg-success-600 hover:bg-success-700'
                : testResult?.success === false
                  ? 'bg-error-600 hover:bg-error-700'
                  : 'bg-info-600 hover:bg-info-700'
          }`}
        >
          {isTestingConnection ? (
            <span className="flex items-center">
              <Spinner size="md" color="white" className="-ml-1 mr-3" />
              Bağlantı Test Ediliyor...
            </span>
          ) : testResult?.success ? (
            <span className="flex items-center">
              <CircleCheck className="w-5 h-5 mr-2" aria-hidden="true" />
              Tekrar Test Et
            </span>
          ) : testResult?.success === false ? (
            <span className="flex items-center">
              <RefreshCw className="w-5 h-5 mr-2" aria-hidden="true" />
              Tekrar Dene
            </span>
          ) : (
            <span className="flex items-center">
              <Zap className="w-5 h-5 mr-2" aria-hidden="true" />
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
              ? 'bg-success-50 dark:bg-success-900/20 border-success-200 dark:border-success-800'
              : 'bg-error-50 dark:bg-error-900/20 border-error-200 dark:border-error-800'
          }`}
        >
          {testResult.success ? (
            <div className="space-y-4">
              {/* Success Header */}
              <div className="flex items-center">
                <div className="w-12 h-12 bg-success-100 dark:bg-success-900/40 rounded-full flex items-center justify-center mr-4">
                  <CircleCheck
                    className="w-6 h-6 text-success-600 dark:text-success-400"
                    aria-hidden="true"
                  />
                </div>
                <div>
                  <h4 className="text-lg font-semibold text-success-800 dark:text-success-200">
                    Bağlantı Başarılı!
                  </h4>
                  <p className="text-sm text-success-600 dark:text-success-400">
                    VFD cihazı ile iletişim kuruldu.
                    {testResult.latencyMs && ` Gecikme: ${testResult.latencyMs}ms`}
                  </p>
                </div>
              </div>

              {/* Device Info */}
              {testResult.deviceInfo && (
                <div className="bg-white dark:bg-gray-900 rounded-lg p-4 border border-success-200">
                  <h5 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Cihaz Bilgileri
                  </h5>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                    {testResult.deviceInfo.manufacturer && (
                      <div>
                        <span className="text-gray-500 dark:text-gray-400">Üretici:</span>{' '}
                        <span className="font-medium">{testResult.deviceInfo.manufacturer}</span>
                      </div>
                    )}
                    {testResult.deviceInfo.model && (
                      <div>
                        <span className="text-gray-500 dark:text-gray-400">Model:</span>{' '}
                        <span className="font-medium">{testResult.deviceInfo.model}</span>
                      </div>
                    )}
                    {testResult.firmwareVersion && (
                      <div>
                        <span className="text-gray-500 dark:text-gray-400">Firmware:</span>{' '}
                        <span className="font-medium">{testResult.firmwareVersion}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Sample Data */}
              {testResult.sampleData && Object.keys(testResult.sampleData).length > 0 && (
                <div className="bg-white dark:bg-gray-900 rounded-lg p-4 border border-success-200">
                  <h5 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Anlık Parametreler
                  </h5>
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
                <div className="bg-white dark:bg-gray-900 rounded-lg p-4 border border-success-200">
                  <h5 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Durum Bilgileri
                  </h5>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(testResult.statusBits).map(([key, value]) => (
                      <StatusBit key={key} name={key} active={value as boolean} />
                    ))}
                  </div>
                </div>
              )}

              {/* Diagnostics */}
              {testResult.diagnostics && (
                <div className="bg-white dark:bg-gray-900 rounded-lg p-4 border border-success-200">
                  <h5 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    İletişim İstatistikleri
                  </h5>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                    <div>
                      <span className="text-gray-500 dark:text-gray-400">Gönderilen:</span>{' '}
                      <span className="font-medium">{testResult.diagnostics.packetsSent}</span>
                    </div>
                    <div>
                      <span className="text-gray-500 dark:text-gray-400">Alınan:</span>{' '}
                      <span className="font-medium">{testResult.diagnostics.packetsReceived}</span>
                    </div>
                    <div>
                      <span className="text-gray-500 dark:text-gray-400">Ort. Gecikme:</span>{' '}
                      <span className="font-medium">{testResult.diagnostics.averageLatency}ms</span>
                    </div>
                    <div>
                      <span className="text-gray-500 dark:text-gray-400">Hatalar:</span>{' '}
                      <span
                        className={`font-medium ${testResult.diagnostics.communicationErrors > 0 ? 'text-error-600 dark:text-error-400' : 'text-success-600 dark:text-success-400'}`}
                      >
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
                <div className="w-12 h-12 bg-error-100 dark:bg-error-900/40 rounded-full flex items-center justify-center mr-4">
                  <CircleX
                    className="w-6 h-6 text-error-600 dark:text-error-400"
                    aria-hidden="true"
                  />
                </div>
                <div>
                  <h4 className="text-lg font-semibold text-error-800 dark:text-error-200">
                    Bağlantı Başarısız
                  </h4>
                  <p className="text-sm text-error-600 dark:text-error-400">
                    {testResult.error || 'VFD cihazı ile bağlantı kurulamadı.'}
                  </p>
                </div>
              </div>

              {/* Error Code */}
              {testResult.errorCode && (
                <div className="bg-white dark:bg-gray-900 rounded-lg p-4 border border-error-200">
                  <p className="text-sm">
                    <span className="text-gray-500 dark:text-gray-400">Hata Kodu:</span>{' '}
                    <span className="font-mono font-medium text-error-600 dark:text-error-400">
                      {testResult.errorCode}
                    </span>
                  </p>
                </div>
              )}

              {/* Troubleshooting Tips */}
              <div className="bg-white dark:bg-gray-900 rounded-lg p-4 border border-error-200">
                <h5 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Kontrol Edilecekler:
                </h5>
                <ul className="space-y-1 text-sm text-gray-600 dark:text-gray-400">
                  <li className="flex items-center">
                    <CircleCheck
                      className="w-4 h-4 mr-2 text-gray-500 dark:text-gray-400"
                      aria-hidden="true"
                    />
                    Kablo bağlantılarını kontrol edin
                  </li>
                  <li className="flex items-center">
                    <CircleCheck
                      className="w-4 h-4 mr-2 text-gray-500 dark:text-gray-400"
                      aria-hidden="true"
                    />
                    VFD cihazının iletişim ayarlarını doğrulayın
                  </li>
                  <li className="flex items-center">
                    <CircleCheck
                      className="w-4 h-4 mr-2 text-gray-500 dark:text-gray-400"
                      aria-hidden="true"
                    />
                    Slave ID / Unit ID değerini kontrol edin
                  </li>
                  <li className="flex items-center">
                    <CircleCheck
                      className="w-4 h-4 mr-2 text-gray-500 dark:text-gray-400"
                      aria-hidden="true"
                    />
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
        <div className="text-center text-sm text-gray-500 dark:text-gray-400">
          <p>
            Bağlantı testini atlayabilirsiniz, ancak cihazın doğru çalıştığını doğrulamak için test
            yapmanızı öneririz.
          </p>
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
    <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-center">
      <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
        {displayNames[name] || name}
      </div>
      <div className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        {value?.toFixed(1) || '-'}
        {unit && (
          <span className="text-sm font-normal text-gray-500 dark:text-gray-400 ml-1">{unit}</span>
        )}
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
            ? 'bg-error-100 dark:bg-error-900/40 text-error-700 dark:text-error-300'
            : name === 'warning'
              ? 'bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300'
              : 'bg-success-100 dark:bg-success-900/40 text-success-700 dark:text-success-300'
          : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400'
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
            <span className="text-gray-500 dark:text-gray-400">Port:</span>{' '}
            <span className="font-medium">{rtuConfig.serialPort}</span>
          </div>,
        );
      }
      if (rtuConfig.slaveId) {
        items.push(
          <div key="slaveId">
            <span className="text-gray-500 dark:text-gray-400">Slave ID:</span>{' '}
            <span className="font-medium">{rtuConfig.slaveId}</span>
          </div>,
        );
      }
      if (rtuConfig.baudRate) {
        items.push(
          <div key="baudRate">
            <span className="text-gray-500 dark:text-gray-400">Baud Rate:</span>{' '}
            <span className="font-medium">{rtuConfig.baudRate}</span>
          </div>,
        );
      }
      break;
    }
    case VfdProtocol.MODBUS_TCP: {
      const tcpConfig = config as any;
      if (tcpConfig.host) {
        items.push(
          <div key="host">
            <span className="text-gray-500 dark:text-gray-400">IP:</span>{' '}
            <span className="font-medium">{tcpConfig.host}</span>
          </div>,
        );
      }
      if (tcpConfig.port) {
        items.push(
          <div key="port">
            <span className="text-gray-500 dark:text-gray-400">Port:</span>{' '}
            <span className="font-medium">{tcpConfig.port}</span>
          </div>,
        );
      }
      if (tcpConfig.unitId) {
        items.push(
          <div key="unitId">
            <span className="text-gray-500 dark:text-gray-400">Unit ID:</span>{' '}
            <span className="font-medium">{tcpConfig.unitId}</span>
          </div>,
        );
      }
      break;
    }
    default: {
      const genericConfig = config as unknown as Record<string, unknown>;
      const firstThreeKeys = Object.keys(genericConfig).slice(0, 3);
      firstThreeKeys.forEach((key) => {
        items.push(
          <div key={key}>
            <span className="text-gray-500 dark:text-gray-400">{key}:</span>{' '}
            <span className="font-medium">{String(genericConfig[key])}</span>
          </div>,
        );
      });
    }
  }

  return items;
}

export default VfdConnectionTestStep;
