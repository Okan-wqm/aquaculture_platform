import React from 'react';
import {
  VfdBrandInfo,
  VfdProtocol,
  VfdProtocolConfiguration,
  VfdConnectionTestResult,
  RegisterVfdInput,
  VFD_PROTOCOL_NAMES,
} from '../../../types/vfd.types';

interface VfdReviewStepProps {
  brand?: VfdBrandInfo;
  protocol?: VfdProtocol;
  modelSeries?: string;
  basicInfo: Partial<RegisterVfdInput>;
  protocolConfig: Partial<VfdProtocolConfiguration>;
  connectionTestResult?: VfdConnectionTestResult;
  onEdit: (step: number) => void;
}

export function VfdReviewStep({
  brand,
  protocol,
  modelSeries,
  basicInfo,
  protocolConfig,
  connectionTestResult,
  onEdit,
}: VfdReviewStepProps) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-gray-900 mb-2">Kayıt Onayı</h3>
        <p className="text-sm text-gray-500">
          Aşağıdaki bilgileri gözden geçirin ve VFD cihazınızı kaydetmek için onaylayın.
        </p>
      </div>

      {/* Brand & Protocol Section */}
      <ReviewSection
        title="Marka ve Protokol"
        stepIndex={0}
        onEdit={onEdit}
      >
        <div className="grid grid-cols-2 gap-4">
          <ReviewItem label="Marka" value={brand?.name} />
          <ReviewItem label="Protokol" value={protocol ? VFD_PROTOCOL_NAMES[protocol] : undefined} />
        </div>
      </ReviewSection>

      {/* Basic Information Section */}
      <ReviewSection
        title="Temel Bilgiler"
        stepIndex={2}
        onEdit={onEdit}
      >
        <div className="grid grid-cols-2 gap-4">
          <ReviewItem label="Cihaz Adı" value={basicInfo.name} required />
          <ReviewItem label="Model Serisi" value={modelSeries} />
          <ReviewItem label="Model Numarası" value={basicInfo.model} />
          <ReviewItem label="Seri Numarası" value={basicInfo.serialNumber} />
          <ReviewItem label="Konum" value={basicInfo.location} />
          {basicInfo.tags && basicInfo.tags.length > 0 && (
            <div className="col-span-2">
              <span className="text-gray-500 text-sm">Etiketler:</span>{' '}
              <div className="flex flex-wrap gap-1 mt-1">
                {basicInfo.tags.map((tag) => (
                  <span
                    key={tag}
                    className="px-2 py-0.5 text-xs bg-blue-100 text-blue-700 rounded-full"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
        {basicInfo.notes && (
          <div className="mt-4 pt-4 border-t border-gray-100">
            <span className="text-gray-500 text-sm">Notlar:</span>
            <p className="mt-1 text-sm text-gray-700">{basicInfo.notes}</p>
          </div>
        )}
      </ReviewSection>

      {/* Protocol Configuration Section */}
      <ReviewSection
        title="Protokol Yapılandırması"
        stepIndex={3}
        onEdit={onEdit}
      >
        {protocol && renderProtocolConfig(protocol, protocolConfig)}
      </ReviewSection>

      {/* Connection Test Section */}
      <ReviewSection
        title="Bağlantı Testi"
        stepIndex={4}
        onEdit={onEdit}
      >
        {connectionTestResult ? (
          <div className="flex items-center">
            {connectionTestResult.success ? (
              <>
                <div className="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center mr-3">
                  <svg className="w-5 h-5 text-green-600" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                      clipRule="evenodd"
                    />
                  </svg>
                </div>
                <div>
                  <span className="font-medium text-green-700">Bağlantı Başarılı</span>
                  {connectionTestResult.latencyMs && (
                    <span className="text-sm text-gray-500 ml-2">
                      ({connectionTestResult.latencyMs}ms)
                    </span>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="w-8 h-8 bg-red-100 rounded-full flex items-center justify-center mr-3">
                  <svg className="w-5 h-5 text-red-600" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                      clipRule="evenodd"
                    />
                  </svg>
                </div>
                <div>
                  <span className="font-medium text-red-700">Bağlantı Başarısız</span>
                  {connectionTestResult.error && (
                    <span className="text-sm text-gray-500 block">{connectionTestResult.error}</span>
                  )}
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="flex items-center">
            <div className="w-8 h-8 bg-yellow-100 rounded-full flex items-center justify-center mr-3">
              <svg className="w-5 h-5 text-yellow-600" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
            <div>
              <span className="font-medium text-yellow-700">Test Yapılmadı</span>
              <span className="text-sm text-gray-500 block">
                Bağlantı testi atlandı. Cihaz kayıt sonrası test edilebilir.
              </span>
            </div>
          </div>
        )}
      </ReviewSection>

      {/* Summary Card */}
      <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg p-6 border border-blue-200">
        <div className="flex items-start">
          <div className="flex-shrink-0">
            <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center">
              <svg className="w-6 h-6 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </div>
          </div>
          <div className="ml-4 flex-1">
            <h4 className="text-lg font-semibold text-gray-900">Kayda Hazır</h4>
            <p className="mt-1 text-sm text-gray-600">
              <strong>{basicInfo.name}</strong> adlı <strong>{brand?.name}</strong> VFD cihazı{' '}
              <strong>{protocol ? VFD_PROTOCOL_NAMES[protocol] : ''}</strong> protokolü ile
              kaydedilecektir.
            </p>
            <div className="mt-3 flex items-center text-sm text-gray-500">
              <svg className="w-4 h-4 mr-1" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                  clipRule="evenodd"
                />
              </svg>
              Kayıt sonrası cihaz ayarlarını düzenleyebilirsiniz.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Helper Components
interface ReviewSectionProps {
  title: string;
  stepIndex: number;
  onEdit: (step: number) => void;
  children: React.ReactNode;
}

function ReviewSection({ title, stepIndex, onEdit, children }: ReviewSectionProps) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200">
        <h4 className="font-medium text-gray-900">{title}</h4>
        <button
          onClick={() => onEdit(stepIndex)}
          className="text-sm text-blue-600 hover:text-blue-700 flex items-center"
        >
          <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
            />
          </svg>
          Düzenle
        </button>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

interface ReviewItemProps {
  label: string;
  value?: string;
  required?: boolean;
}

function ReviewItem({ label, value, required }: ReviewItemProps) {
  return (
    <div>
      <span className="text-gray-500 text-sm">{label}:</span>{' '}
      {value ? (
        <span className="font-medium text-gray-900">{value}</span>
      ) : (
        <span className={`text-sm ${required ? 'text-red-500' : 'text-gray-400'}`}>
          {required ? 'Gerekli' : 'Belirtilmedi'}
        </span>
      )}
    </div>
  );
}

// Helper to render protocol configuration
function renderProtocolConfig(protocol: VfdProtocol, config: Partial<VfdProtocolConfiguration>) {
  const configObj = config as Record<string, unknown>;

  const labels: Record<string, string> = {
    // Modbus RTU
    serialPort: 'Seri Port',
    slaveId: 'Slave ID',
    baudRate: 'Baud Rate',
    dataBits: 'Data Bits',
    parity: 'Parity',
    stopBits: 'Stop Bits',
    timeout: 'Timeout (ms)',
    retryCount: 'Retry Count',
    // Modbus TCP
    host: 'IP Adresi',
    port: 'Port',
    unitId: 'Unit ID',
    connectionTimeout: 'Bağlantı Timeout (ms)',
    responseTimeout: 'Yanıt Timeout (ms)',
    keepAlive: 'Keep Alive',
    // PROFINET
    deviceName: 'Device Name',
    ipAddress: 'IP Adresi',
    subnetMask: 'Subnet Mask',
    updateRate: 'Update Rate (ms)',
    // EtherNet/IP
    rpi: 'RPI (ms)',
    connectionType: 'Connection Type',
    // CANopen
    nodeId: 'Node ID',
    interface: 'CAN Interface',
    heartbeatProducerTime: 'Heartbeat Time (ms)',
    // BACnet
    deviceInstance: 'Device Instance',
    maxApduLength: 'Max APDU Length',
    // PROFIBUS
    stationAddress: 'Station Address',
    masterAddress: 'Master Address',
    // BACnet MS/TP
    macAddress: 'MAC Address',
  };

  const filteredConfig = Object.entries(configObj).filter(
    ([key, value]) => value !== undefined && value !== null && value !== ''
  );

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
      {filteredConfig.map(([key, value]) => (
        <div key={key}>
          <span className="text-gray-500 text-sm">{labels[key] || key}:</span>{' '}
          <span className="font-medium text-gray-900">
            {typeof value === 'boolean' ? (value ? 'Evet' : 'Hayır') : String(value)}
          </span>
        </div>
      ))}
    </div>
  );
}

export default VfdReviewStep;
