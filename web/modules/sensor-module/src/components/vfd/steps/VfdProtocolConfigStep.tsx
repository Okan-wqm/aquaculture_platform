import React, { useEffect } from 'react';
import {
  VfdProtocol,
  VfdBrand,
  VfdProtocolConfiguration,
  VFD_PROTOCOL_NAMES,
  VFD_DEFAULT_MODBUS_RTU_CONFIG,
  VFD_DEFAULT_MODBUS_TCP_CONFIG,
  VFD_DEFAULT_PROFINET_CONFIG,
  VFD_DEFAULT_ETHERNET_IP_CONFIG,
  VFD_DEFAULT_CANOPEN_CONFIG,
  VFD_DEFAULT_BACNET_IP_CONFIG,
  ModbusRtuConfig,
  ModbusTcpConfig,
} from '../../../types/vfd.types';
import { useVfdProtocols } from '../../../hooks/useVfdBrands';

interface VfdProtocolConfigStepProps {
  protocol: VfdProtocol;
  brand?: VfdBrand;
  values: Partial<VfdProtocolConfiguration>;
  onChange: (config: Partial<VfdProtocolConfiguration>) => void;
}

export function VfdProtocolConfigStep({
  protocol,
  brand,
  values,
  onChange,
}: VfdProtocolConfigStepProps) {
  const { getDefaultConfiguration } = useVfdProtocols();

  // Initialize with default configuration if empty
  useEffect(() => {
    if (Object.keys(values).length === 0) {
      const defaultConfig = getDefaultConfiguration(protocol);
      onChange(defaultConfig);
    }
  }, [protocol, getDefaultConfiguration, onChange, values]);

  const handleChange = (field: string, value: unknown) => {
    onChange({ ...values, [field]: value });
  };

  const renderProtocolFields = () => {
    switch (protocol) {
      case VfdProtocol.MODBUS_RTU:
        return <ModbusRtuFields values={values as ModbusRtuConfig} onChange={handleChange} />;
      case VfdProtocol.MODBUS_TCP:
        return <ModbusTcpFields values={values as ModbusTcpConfig} onChange={handleChange} />;
      case VfdProtocol.PROFINET:
        return <ProfinetFields values={values} onChange={handleChange} />;
      case VfdProtocol.ETHERNET_IP:
        return <EthernetIpFields values={values} onChange={handleChange} />;
      case VfdProtocol.CANOPEN:
        return <CanopenFields values={values} onChange={handleChange} />;
      case VfdProtocol.BACNET_IP:
        return <BacnetIpFields values={values} onChange={handleChange} />;
      case VfdProtocol.PROFIBUS_DP:
        return <ProfibusDpFields values={values} onChange={handleChange} />;
      case VfdProtocol.BACNET_MSTP:
        return <BacnetMstpFields values={values} onChange={handleChange} />;
      default:
        return <div className="text-gray-500">Bu protokol için yapılandırma mevcut değil.</div>;
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-gray-900 mb-2">Protokol Yapılandırması</h3>
        <p className="text-sm text-gray-500">
          <span className="font-medium text-blue-600">{VFD_PROTOCOL_NAMES[protocol]}</span>{' '}
          protokolü için bağlantı parametrelerini yapılandırın.
        </p>
      </div>

      {/* Protocol specific fields */}
      {renderProtocolFields()}

      {/* Help text */}
      <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
        <div className="flex items-start">
          <svg className="w-5 h-5 text-blue-500 mr-2 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
          </svg>
          <div className="text-sm text-blue-700">
            <p className="font-medium">İpucu</p>
            <p className="mt-1">
              Bu ayarlar VFD cihazınızın iletişim parametreleriyle eşleşmelidir.
              Emin değilseniz, cihaz kullanım kılavuzuna başvurun veya varsayılan değerleri deneyin.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// Modbus RTU Configuration Fields
interface ModbusRtuFieldsProps {
  values: Partial<ModbusRtuConfig>;
  onChange: (field: string, value: unknown) => void;
}

function ModbusRtuFields({ values, onChange }: ModbusRtuFieldsProps) {
  return (
    <div className="space-y-6">
      {/* Connection Group */}
      <fieldset className="border border-gray-200 rounded-lg p-4">
        <legend className="text-sm font-medium text-gray-700 px-2">Bağlantı Ayarları</legend>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Seri Port <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={values.serialPort || ''}
              onChange={(e) => onChange('serialPort', e.target.value)}
              placeholder="COM1 veya /dev/ttyUSB0"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Slave ID <span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              min={1}
              max={247}
              value={values.slaveId || 1}
              onChange={(e) => onChange('slaveId', parseInt(e.target.value))}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
      </fieldset>

      {/* Serial Settings Group */}
      <fieldset className="border border-gray-200 rounded-lg p-4">
        <legend className="text-sm font-medium text-gray-700 px-2">Seri İletişim Ayarları</legend>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Baud Rate</label>
            <select
              value={values.baudRate || 9600}
              onChange={(e) => onChange('baudRate', parseInt(e.target.value))}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            >
              <option value={4800}>4800</option>
              <option value={9600}>9600</option>
              <option value={19200}>19200</option>
              <option value={38400}>38400</option>
              <option value={57600}>57600</option>
              <option value={115200}>115200</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Data Bits</label>
            <select
              value={values.dataBits || 8}
              onChange={(e) => onChange('dataBits', parseInt(e.target.value))}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            >
              <option value={7}>7</option>
              <option value={8}>8</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Parity</label>
            <select
              value={values.parity || 'none'}
              onChange={(e) => onChange('parity', e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            >
              <option value="none">None</option>
              <option value="even">Even</option>
              <option value="odd">Odd</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Stop Bits</label>
            <select
              value={values.stopBits || 1}
              onChange={(e) => onChange('stopBits', parseInt(e.target.value))}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
            </select>
          </div>
        </div>
      </fieldset>

      {/* Timing Group */}
      <fieldset className="border border-gray-200 rounded-lg p-4">
        <legend className="text-sm font-medium text-gray-700 px-2">Zamanlama</legend>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Timeout (ms)</label>
            <input
              type="number"
              min={100}
              max={10000}
              value={values.timeout || 1000}
              onChange={(e) => onChange('timeout', parseInt(e.target.value))}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Retry Count</label>
            <input
              type="number"
              min={0}
              max={10}
              value={values.retryCount || 3}
              onChange={(e) => onChange('retryCount', parseInt(e.target.value))}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
      </fieldset>
    </div>
  );
}

// Modbus TCP Configuration Fields
interface ModbusTcpFieldsProps {
  values: Partial<ModbusTcpConfig>;
  onChange: (field: string, value: unknown) => void;
}

function ModbusTcpFields({ values, onChange }: ModbusTcpFieldsProps) {
  return (
    <div className="space-y-6">
      <fieldset className="border border-gray-200 rounded-lg p-4">
        <legend className="text-sm font-medium text-gray-700 px-2">Bağlantı Ayarları</legend>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-2">
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              IP Adresi <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={values.host || ''}
              onChange={(e) => onChange('host', e.target.value)}
              placeholder="192.168.1.100"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Port</label>
            <input
              type="number"
              min={1}
              max={65535}
              value={values.port || 502}
              onChange={(e) => onChange('port', parseInt(e.target.value))}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Unit ID <span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              min={1}
              max={247}
              value={values.unitId || 1}
              onChange={(e) => onChange('unitId', parseInt(e.target.value))}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="flex items-center pt-6">
            <input
              type="checkbox"
              id="keepAlive"
              checked={values.keepAlive !== false}
              onChange={(e) => onChange('keepAlive', e.target.checked)}
              className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
            />
            <label htmlFor="keepAlive" className="ml-2 text-sm text-gray-700">
              Bağlantıyı Canlı Tut
            </label>
          </div>
        </div>
      </fieldset>

      <fieldset className="border border-gray-200 rounded-lg p-4">
        <legend className="text-sm font-medium text-gray-700 px-2">Timeout Ayarları</legend>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Bağlantı Timeout (ms)
            </label>
            <input
              type="number"
              min={1000}
              max={30000}
              value={values.connectionTimeout || 5000}
              onChange={(e) => onChange('connectionTimeout', parseInt(e.target.value))}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Yanıt Timeout (ms)
            </label>
            <input
              type="number"
              min={500}
              max={10000}
              value={values.responseTimeout || 3000}
              onChange={(e) => onChange('responseTimeout', parseInt(e.target.value))}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
      </fieldset>
    </div>
  );
}

// PROFINET Configuration Fields
function ProfinetFields({ values, onChange }: { values: Record<string, unknown>; onChange: (field: string, value: unknown) => void }) {
  return (
    <div className="space-y-6">
      <fieldset className="border border-gray-200 rounded-lg p-4">
        <legend className="text-sm font-medium text-gray-700 px-2">PROFINET Ayarları</legend>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Device Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={(values.deviceName as string) || ''}
              onChange={(e) => onChange('deviceName', e.target.value)}
              placeholder="vfd-device-01"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              IP Adresi <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={(values.ipAddress as string) || ''}
              onChange={(e) => onChange('ipAddress', e.target.value)}
              placeholder="192.168.1.100"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Subnet Mask</label>
            <input
              type="text"
              value={(values.subnetMask as string) || '255.255.255.0'}
              onChange={(e) => onChange('subnetMask', e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Update Rate (ms)</label>
            <input
              type="number"
              min={1}
              max={512}
              value={(values.updateRate as number) || 32}
              onChange={(e) => onChange('updateRate', parseInt(e.target.value))}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
      </fieldset>
    </div>
  );
}

// EtherNet/IP Configuration Fields
function EthernetIpFields({ values, onChange }: { values: Record<string, unknown>; onChange: (field: string, value: unknown) => void }) {
  return (
    <div className="space-y-6">
      <fieldset className="border border-gray-200 rounded-lg p-4">
        <legend className="text-sm font-medium text-gray-700 px-2">EtherNet/IP Ayarları</legend>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              IP Adresi <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={(values.host as string) || ''}
              onChange={(e) => onChange('host', e.target.value)}
              placeholder="192.168.1.100"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Port</label>
            <input
              type="number"
              value={(values.port as number) || 44818}
              onChange={(e) => onChange('port', parseInt(e.target.value))}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">RPI (ms)</label>
            <input
              type="number"
              min={2}
              max={3200}
              value={(values.rpi as number) || 10}
              onChange={(e) => onChange('rpi', parseInt(e.target.value))}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Connection Type</label>
            <select
              value={(values.connectionType as string) || 'exclusive'}
              onChange={(e) => onChange('connectionType', e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            >
              <option value="exclusive">Exclusive Owner</option>
              <option value="inputOnly">Input Only</option>
              <option value="listenOnly">Listen Only</option>
            </select>
          </div>
        </div>
      </fieldset>
    </div>
  );
}

// CANopen Configuration Fields
function CanopenFields({ values, onChange }: { values: Record<string, unknown>; onChange: (field: string, value: unknown) => void }) {
  return (
    <div className="space-y-6">
      <fieldset className="border border-gray-200 rounded-lg p-4">
        <legend className="text-sm font-medium text-gray-700 px-2">CANopen Ayarları</legend>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Node ID <span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              min={1}
              max={127}
              value={(values.nodeId as number) || 1}
              onChange={(e) => onChange('nodeId', parseInt(e.target.value))}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Baud Rate</label>
            <select
              value={(values.baudRate as number) || 250000}
              onChange={(e) => onChange('baudRate', parseInt(e.target.value))}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            >
              <option value={10000}>10 kbit/s</option>
              <option value={20000}>20 kbit/s</option>
              <option value={50000}>50 kbit/s</option>
              <option value={125000}>125 kbit/s</option>
              <option value={250000}>250 kbit/s</option>
              <option value={500000}>500 kbit/s</option>
              <option value={800000}>800 kbit/s</option>
              <option value={1000000}>1 Mbit/s</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              CAN Interface <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={(values.interface as string) || ''}
              onChange={(e) => onChange('interface', e.target.value)}
              placeholder="can0"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Heartbeat Time (ms)</label>
            <input
              type="number"
              min={0}
              max={65535}
              value={(values.heartbeatProducerTime as number) || 1000}
              onChange={(e) => onChange('heartbeatProducerTime', parseInt(e.target.value))}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
      </fieldset>
    </div>
  );
}

// BACnet IP Configuration Fields
function BacnetIpFields({ values, onChange }: { values: Record<string, unknown>; onChange: (field: string, value: unknown) => void }) {
  return (
    <div className="space-y-6">
      <fieldset className="border border-gray-200 rounded-lg p-4">
        <legend className="text-sm font-medium text-gray-700 px-2">BACnet/IP Ayarları</legend>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              IP Adresi <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={(values.ipAddress as string) || ''}
              onChange={(e) => onChange('ipAddress', e.target.value)}
              placeholder="192.168.1.100"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Port</label>
            <input
              type="number"
              value={(values.port as number) || 47808}
              onChange={(e) => onChange('port', parseInt(e.target.value))}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Device Instance <span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              min={0}
              max={4194303}
              value={(values.deviceInstance as number) || 0}
              onChange={(e) => onChange('deviceInstance', parseInt(e.target.value))}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Max APDU Length</label>
            <input
              type="number"
              value={(values.maxApduLength as number) || 1476}
              onChange={(e) => onChange('maxApduLength', parseInt(e.target.value))}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
      </fieldset>
    </div>
  );
}

// PROFIBUS DP Configuration Fields
function ProfibusDpFields({ values, onChange }: { values: Record<string, unknown>; onChange: (field: string, value: unknown) => void }) {
  return (
    <div className="space-y-6">
      <fieldset className="border border-gray-200 rounded-lg p-4">
        <legend className="text-sm font-medium text-gray-700 px-2">PROFIBUS DP Ayarları</legend>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Station Address <span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              min={1}
              max={126}
              value={(values.stationAddress as number) || 1}
              onChange={(e) => onChange('stationAddress', parseInt(e.target.value))}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Baud Rate</label>
            <select
              value={(values.baudRate as number) || 1500000}
              onChange={(e) => onChange('baudRate', parseInt(e.target.value))}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            >
              <option value={9600}>9.6 kbit/s</option>
              <option value={19200}>19.2 kbit/s</option>
              <option value={93750}>93.75 kbit/s</option>
              <option value={187500}>187.5 kbit/s</option>
              <option value={500000}>500 kbit/s</option>
              <option value={1500000}>1.5 Mbit/s</option>
              <option value={3000000}>3 Mbit/s</option>
              <option value={6000000}>6 Mbit/s</option>
              <option value={12000000}>12 Mbit/s</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Master Address</label>
            <input
              type="number"
              min={0}
              max={125}
              value={(values.masterAddress as number) || 0}
              onChange={(e) => onChange('masterAddress', parseInt(e.target.value))}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
      </fieldset>
    </div>
  );
}

// BACnet MS/TP Configuration Fields
function BacnetMstpFields({ values, onChange }: { values: Record<string, unknown>; onChange: (field: string, value: unknown) => void }) {
  return (
    <div className="space-y-6">
      <fieldset className="border border-gray-200 rounded-lg p-4">
        <legend className="text-sm font-medium text-gray-700 px-2">BACnet MS/TP Ayarları</legend>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Seri Port <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={(values.serialPort as string) || ''}
              onChange={(e) => onChange('serialPort', e.target.value)}
              placeholder="COM1 veya /dev/ttyUSB0"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Baud Rate</label>
            <select
              value={(values.baudRate as number) || 38400}
              onChange={(e) => onChange('baudRate', parseInt(e.target.value))}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            >
              <option value={9600}>9600</option>
              <option value={19200}>19200</option>
              <option value={38400}>38400</option>
              <option value={57600}>57600</option>
              <option value={76800}>76800</option>
              <option value={115200}>115200</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              MAC Address <span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              min={0}
              max={127}
              value={(values.macAddress as number) || 1}
              onChange={(e) => onChange('macAddress', parseInt(e.target.value))}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Device Instance <span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              min={0}
              max={4194303}
              value={(values.deviceInstance as number) || 0}
              onChange={(e) => onChange('deviceInstance', parseInt(e.target.value))}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
      </fieldset>
    </div>
  );
}

export default VfdProtocolConfigStep;
