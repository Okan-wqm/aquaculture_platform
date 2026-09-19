import React from 'react';
import { Button } from '@aquaculture/shared-ui';
import {
  VfdBrandInfo,
  VfdProtocol,
  VfdProtocolConfiguration,
  VfdConnectionTestResult,
  RegisterVfdInput,
  VFD_PROTOCOL_NAMES,
} from '../../../types/vfd.types';
import { CircleCheck, CircleX, Info, Pencil, TriangleAlert } from 'lucide-react';

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
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">Kayıt Onayı</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Aşağıdaki bilgileri gözden geçirin ve VFD cihazınızı kaydetmek için onaylayın.
        </p>
      </div>

      {/* Brand & Protocol Section */}
      <ReviewSection title="Marka ve Protokol" stepIndex={0} onEdit={onEdit}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <ReviewItem label="Marka" value={brand?.name} />
          <ReviewItem
            label="Protokol"
            value={protocol ? VFD_PROTOCOL_NAMES[protocol] : undefined}
          />
        </div>
      </ReviewSection>

      {/* Basic Information Section */}
      <ReviewSection title="Temel Bilgiler" stepIndex={2} onEdit={onEdit}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <ReviewItem label="Cihaz Adı" value={basicInfo.name} required />
          <ReviewItem label="Model Serisi" value={modelSeries} />
          <ReviewItem label="Model Numarası" value={basicInfo.model} />
          <ReviewItem label="Seri Numarası" value={basicInfo.serialNumber} />
          <ReviewItem label="Konum" value={basicInfo.location} />
          {basicInfo.tags && basicInfo.tags.length > 0 && (
            <div className="sm:col-span-2">
              <span className="text-gray-500 dark:text-gray-400 text-sm">Etiketler:</span>{' '}
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
          <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-700">
            <span className="text-gray-500 dark:text-gray-400 text-sm">Notlar:</span>
            <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">{basicInfo.notes}</p>
          </div>
        )}
      </ReviewSection>

      {/* Protocol Configuration Section */}
      <ReviewSection title="Protokol Yapılandırması" stepIndex={3} onEdit={onEdit}>
        {protocol && renderProtocolConfig(protocol, protocolConfig)}
      </ReviewSection>

      {/* Connection Test Section */}
      <ReviewSection title="Bağlantı Testi" stepIndex={4} onEdit={onEdit}>
        {connectionTestResult ? (
          <div className="flex items-center">
            {connectionTestResult.success ? (
              <>
                <div className="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center mr-3">
                  <CircleCheck className="w-5 h-5 text-green-600" aria-hidden="true" />
                </div>
                <div>
                  <span className="font-medium text-green-700">Bağlantı Başarılı</span>
                  {connectionTestResult.latencyMs && (
                    <span className="text-sm text-gray-500 dark:text-gray-400 ml-2">
                      ({connectionTestResult.latencyMs}ms)
                    </span>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="w-8 h-8 bg-red-100 rounded-full flex items-center justify-center mr-3">
                  <CircleX className="w-5 h-5 text-red-600" aria-hidden="true" />
                </div>
                <div>
                  <span className="font-medium text-red-700">Bağlantı Başarısız</span>
                  {connectionTestResult.error && (
                    <span className="text-sm text-gray-500 dark:text-gray-400 block">
                      {connectionTestResult.error}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="flex items-center">
            <div className="w-8 h-8 bg-yellow-100 rounded-full flex items-center justify-center mr-3">
              <TriangleAlert className="w-5 h-5 text-yellow-600" aria-hidden="true" />
            </div>
            <div>
              <span className="font-medium text-yellow-700">Test Yapılmadı</span>
              <span className="text-sm text-gray-500 dark:text-gray-400 block">
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
              <CircleCheck className="w-6 h-6 text-blue-600" aria-hidden="true" />
            </div>
          </div>
          <div className="ml-4 flex-1">
            <h4 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Kayda Hazır</h4>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              <strong>{basicInfo.name}</strong> adlı <strong>{brand?.name}</strong> VFD cihazı{' '}
              <strong>{protocol ? VFD_PROTOCOL_NAMES[protocol] : ''}</strong> protokolü ile
              kaydedilecektir.
            </p>
            <div className="mt-3 flex items-center text-sm text-gray-500 dark:text-gray-400">
              <Info className="w-4 h-4 mr-1" aria-hidden="true" />
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
    <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <h4 className="font-medium text-gray-900 dark:text-gray-100">{title}</h4>
        <Button variant="ghost" onClick={() => onEdit(stepIndex)}>
          <Pencil className="w-4 h-4 mr-1" aria-hidden="true" />
          Düzenle
        </Button>
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
      <span className="text-gray-500 dark:text-gray-400 text-sm">{label}:</span>{' '}
      {value ? (
        <span className="font-medium text-gray-900 dark:text-gray-100">{value}</span>
      ) : (
        <span
          className={`text-sm ${required ? 'text-red-500' : 'text-gray-500 dark:text-gray-400'}`}
        >
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
    ([key, value]) => value !== undefined && value !== null && value !== '',
  );

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
      {filteredConfig.map(([key, value]) => (
        <div key={key}>
          <span className="text-gray-500 dark:text-gray-400 text-sm">{labels[key] || key}:</span>{' '}
          <span className="font-medium text-gray-900 dark:text-gray-100">
            {typeof value === 'boolean' ? (value ? 'Evet' : 'Hayır') : String(value)}
          </span>
        </div>
      ))}
    </div>
  );
}

export default VfdReviewStep;
