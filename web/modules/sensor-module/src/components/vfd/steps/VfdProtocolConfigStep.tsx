import React, { useEffect } from 'react';
import { Input, Select, type SelectOption } from '@aquaculture/shared-ui';
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
import { Info } from 'lucide-react';

/** Serial line rates a Modbus RTU drive accepts. */
const MODBUS_RTU_BAUD_RATES: readonly SelectOption[] = [
  4800, 9600, 19200, 38400, 57600, 115200,
].map((rate) => ({ value: rate, label: String(rate) }));

/** CANopen bit rates, in the kbit/s the spec names them by. */
const CANOPEN_BIT_RATES: readonly SelectOption[] = [
  { value: 10000, label: '10 kbit/s' },
  { value: 20000, label: '20 kbit/s' },
  { value: 50000, label: '50 kbit/s' },
  { value: 125000, label: '125 kbit/s' },
  { value: 250000, label: '250 kbit/s' },
  { value: 500000, label: '500 kbit/s' },
  { value: 800000, label: '800 kbit/s' },
  { value: 1000000, label: '1 Mbit/s' },
];

/** PROFIBUS DP bit rates. */
const PROFIBUS_BIT_RATES: readonly SelectOption[] = [
  { value: 9600, label: '9.6 kbit/s' },
  { value: 19200, label: '19.2 kbit/s' },
  { value: 93750, label: '93.75 kbit/s' },
  { value: 187500, label: '187.5 kbit/s' },
  { value: 500000, label: '500 kbit/s' },
  { value: 1500000, label: '1.5 Mbit/s' },
  { value: 3000000, label: '3 Mbit/s' },
  { value: 6000000, label: '6 Mbit/s' },
  { value: 12000000, label: '12 Mbit/s' },
];

/** BACnet MS/TP line rates. */
const BACNET_MSTP_BAUD_RATES: readonly SelectOption[] = [
  9600, 19200, 38400, 57600, 76800, 115200,
].map((rate) => ({ value: rate, label: String(rate) }));

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
        return (
          <div className="text-gray-500 dark:text-gray-400">
            Bu protokol için yapılandırma mevcut değil.
          </div>
        );
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
          Protokol Yapılandırması
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          <span className="font-medium text-info-600 dark:text-info-400">
            {VFD_PROTOCOL_NAMES[protocol]}
          </span>{' '}
          protokolü için bağlantı parametrelerini yapılandırın.
        </p>
      </div>

      {/* Protocol specific fields */}
      {renderProtocolFields()}

      {/* Help text */}
      <div className="p-4 bg-info-50 dark:bg-info-900/20 rounded-lg border border-info-200 dark:border-info-800">
        <div className="flex items-start">
          <Info className="w-5 h-5 text-info-500 mr-2 mt-0.5" aria-hidden="true" />
          <div className="text-sm text-info-700 dark:text-info-300">
            <p className="font-medium">İpucu</p>
            <p className="mt-1">
              Bu ayarlar VFD cihazınızın iletişim parametreleriyle eşleşmelidir. Emin değilseniz,
              cihaz kullanım kılavuzuna başvurun veya varsayılan değerleri deneyin.
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
      <fieldset className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
        <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 px-2">
          Bağlantı Ayarları
        </legend>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Seri Port <span className="text-error-500">*</span>
            </label>
            <Input
              fullWidth
              type="text"
              value={values.serialPort || ''}
              onChange={(e) => onChange('serialPort', e.target.value)}
              placeholder="COM1 veya /dev/ttyUSB0"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Slave ID <span className="text-error-500">*</span>
            </label>
            <Input
              fullWidth
              type="number"
              min={1}
              max={247}
              value={values.slaveId || 1}
              onChange={(e) => onChange('slaveId', parseInt(e.target.value))}
            />
          </div>
        </div>
      </fieldset>

      {/* Serial Settings Group */}
      <fieldset className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
        <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 px-2">
          Seri İletişim Ayarları
        </legend>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-2">
          <Select
            label="Baud Rate"
            options={[...MODBUS_RTU_BAUD_RATES]}
            value={values.baudRate || 9600}
            onChange={(e) => onChange('baudRate', parseInt(e.target.value))}
          />
          <Select
            label="Data Bits"
            options={[
              { value: 7, label: '7' },
              { value: 8, label: '8' },
            ]}
            value={values.dataBits || 8}
            onChange={(e) => onChange('dataBits', parseInt(e.target.value))}
          />
          <Select
            label="Parity"
            options={[
              { value: 'none', label: 'None' },
              { value: 'even', label: 'Even' },
              { value: 'odd', label: 'Odd' },
            ]}
            value={values.parity || 'none'}
            onChange={(e) => onChange('parity', e.target.value)}
          />
          <Select
            label="Stop Bits"
            options={[
              { value: 1, label: '1' },
              { value: 2, label: '2' },
            ]}
            value={values.stopBits || 1}
            onChange={(e) => onChange('stopBits', parseInt(e.target.value))}
          />
        </div>
      </fieldset>

      {/* Timing Group */}
      <fieldset className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
        <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 px-2">
          Zamanlama
        </legend>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Timeout (ms)
            </label>
            <Input
              fullWidth
              type="number"
              min={100}
              max={10000}
              value={values.timeout || 1000}
              onChange={(e) => onChange('timeout', parseInt(e.target.value))}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Retry Count
            </label>
            <Input
              fullWidth
              type="number"
              min={0}
              max={10}
              value={values.retryCount || 3}
              onChange={(e) => onChange('retryCount', parseInt(e.target.value))}
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
      <fieldset className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
        <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 px-2">
          Bağlantı Ayarları
        </legend>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-2">
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              IP Adresi <span className="text-error-500">*</span>
            </label>
            <Input
              fullWidth
              type="text"
              value={values.host || ''}
              onChange={(e) => onChange('host', e.target.value)}
              placeholder="192.168.1.100"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Port
            </label>
            <Input
              fullWidth
              type="number"
              min={1}
              max={65535}
              value={values.port || 502}
              onChange={(e) => onChange('port', parseInt(e.target.value))}
            />
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Unit ID <span className="text-error-500">*</span>
            </label>
            <Input
              fullWidth
              type="number"
              min={1}
              max={247}
              value={values.unitId || 1}
              onChange={(e) => onChange('unitId', parseInt(e.target.value))}
            />
          </div>
          <div className="flex items-center pt-6">
            <input
              type="checkbox"
              id="keepAlive"
              checked={values.keepAlive !== false}
              onChange={(e) => onChange('keepAlive', e.target.checked)}
              className="w-4 h-4 text-info-600 border-gray-300 dark:border-gray-600 rounded focus:ring-info-500"
            />
            <label htmlFor="keepAlive" className="ml-2 text-sm text-gray-700 dark:text-gray-300">
              Bağlantıyı Canlı Tut
            </label>
          </div>
        </div>
      </fieldset>

      <fieldset className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
        <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 px-2">
          Timeout Ayarları
        </legend>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Bağlantı Timeout (ms)
            </label>
            <Input
              fullWidth
              type="number"
              min={1000}
              max={30000}
              value={values.connectionTimeout || 5000}
              onChange={(e) => onChange('connectionTimeout', parseInt(e.target.value))}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Yanıt Timeout (ms)
            </label>
            <Input
              fullWidth
              type="number"
              min={500}
              max={10000}
              value={values.responseTimeout || 3000}
              onChange={(e) => onChange('responseTimeout', parseInt(e.target.value))}
            />
          </div>
        </div>
      </fieldset>
    </div>
  );
}

// PROFINET Configuration Fields
function ProfinetFields({
  values,
  onChange,
}: {
  values: Record<string, unknown>;
  onChange: (field: string, value: unknown) => void;
}) {
  return (
    <div className="space-y-6">
      <fieldset className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
        <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 px-2">
          PROFINET Ayarları
        </legend>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Device Name <span className="text-error-500">*</span>
            </label>
            <Input
              fullWidth
              type="text"
              value={(values.deviceName as string) || ''}
              onChange={(e) => onChange('deviceName', e.target.value)}
              placeholder="vfd-device-01"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              IP Adresi <span className="text-error-500">*</span>
            </label>
            <Input
              fullWidth
              type="text"
              value={(values.ipAddress as string) || ''}
              onChange={(e) => onChange('ipAddress', e.target.value)}
              placeholder="192.168.1.100"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Subnet Mask
            </label>
            <Input
              fullWidth
              type="text"
              value={(values.subnetMask as string) || '255.255.255.0'}
              onChange={(e) => onChange('subnetMask', e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Update Rate (ms)
            </label>
            <Input
              fullWidth
              type="number"
              min={1}
              max={512}
              value={(values.updateRate as number) || 32}
              onChange={(e) => onChange('updateRate', parseInt(e.target.value))}
            />
          </div>
        </div>
      </fieldset>
    </div>
  );
}

// EtherNet/IP Configuration Fields
function EthernetIpFields({
  values,
  onChange,
}: {
  values: Record<string, unknown>;
  onChange: (field: string, value: unknown) => void;
}) {
  return (
    <div className="space-y-6">
      <fieldset className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
        <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 px-2">
          EtherNet/IP Ayarları
        </legend>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              IP Adresi <span className="text-error-500">*</span>
            </label>
            <Input
              fullWidth
              type="text"
              value={(values.host as string) || ''}
              onChange={(e) => onChange('host', e.target.value)}
              placeholder="192.168.1.100"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Port
            </label>
            <Input
              fullWidth
              type="number"
              value={(values.port as number) || 44818}
              onChange={(e) => onChange('port', parseInt(e.target.value))}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              RPI (ms)
            </label>
            <Input
              fullWidth
              type="number"
              min={2}
              max={3200}
              value={(values.rpi as number) || 10}
              onChange={(e) => onChange('rpi', parseInt(e.target.value))}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Connection Type
            </label>
            <Select
              fullWidth
              options={[
                { value: 'exclusive', label: 'Exclusive Owner' },
                { value: 'inputOnly', label: 'Input Only' },
                { value: 'listenOnly', label: 'Listen Only' },
              ]}
              value={(values.connectionType as string) || 'exclusive'}
              onChange={(e) => onChange('connectionType', e.target.value)}
            />
          </div>
        </div>
      </fieldset>
    </div>
  );
}

// CANopen Configuration Fields
function CanopenFields({
  values,
  onChange,
}: {
  values: Record<string, unknown>;
  onChange: (field: string, value: unknown) => void;
}) {
  return (
    <div className="space-y-6">
      <fieldset className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
        <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 px-2">
          CANopen Ayarları
        </legend>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Node ID <span className="text-error-500">*</span>
            </label>
            <Input
              fullWidth
              type="number"
              min={1}
              max={127}
              value={(values.nodeId as number) || 1}
              onChange={(e) => onChange('nodeId', parseInt(e.target.value))}
            />
          </div>
          <Select
            label="Baud Rate"
            options={[...CANOPEN_BIT_RATES]}
            value={(values.baudRate as number) || 250000}
            onChange={(e) => onChange('baudRate', parseInt(e.target.value))}
          />
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              CAN Interface <span className="text-error-500">*</span>
            </label>
            <Input
              fullWidth
              type="text"
              value={(values.interface as string) || ''}
              onChange={(e) => onChange('interface', e.target.value)}
              placeholder="can0"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Heartbeat Time (ms)
            </label>
            <Input
              fullWidth
              type="number"
              min={0}
              max={65535}
              value={(values.heartbeatProducerTime as number) || 1000}
              onChange={(e) => onChange('heartbeatProducerTime', parseInt(e.target.value))}
            />
          </div>
        </div>
      </fieldset>
    </div>
  );
}

// BACnet IP Configuration Fields
function BacnetIpFields({
  values,
  onChange,
}: {
  values: Record<string, unknown>;
  onChange: (field: string, value: unknown) => void;
}) {
  return (
    <div className="space-y-6">
      <fieldset className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
        <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 px-2">
          BACnet/IP Ayarları
        </legend>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              IP Adresi <span className="text-error-500">*</span>
            </label>
            <Input
              fullWidth
              type="text"
              value={(values.ipAddress as string) || ''}
              onChange={(e) => onChange('ipAddress', e.target.value)}
              placeholder="192.168.1.100"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Port
            </label>
            <Input
              fullWidth
              type="number"
              value={(values.port as number) || 47808}
              onChange={(e) => onChange('port', parseInt(e.target.value))}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Device Instance <span className="text-error-500">*</span>
            </label>
            <Input
              fullWidth
              type="number"
              min={0}
              max={4194303}
              value={(values.deviceInstance as number) || 0}
              onChange={(e) => onChange('deviceInstance', parseInt(e.target.value))}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Max APDU Length
            </label>
            <Input
              fullWidth
              type="number"
              value={(values.maxApduLength as number) || 1476}
              onChange={(e) => onChange('maxApduLength', parseInt(e.target.value))}
            />
          </div>
        </div>
      </fieldset>
    </div>
  );
}

// PROFIBUS DP Configuration Fields
function ProfibusDpFields({
  values,
  onChange,
}: {
  values: Record<string, unknown>;
  onChange: (field: string, value: unknown) => void;
}) {
  return (
    <div className="space-y-6">
      <fieldset className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
        <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 px-2">
          PROFIBUS DP Ayarları
        </legend>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Station Address <span className="text-error-500">*</span>
            </label>
            <Input
              fullWidth
              type="number"
              min={1}
              max={126}
              value={(values.stationAddress as number) || 1}
              onChange={(e) => onChange('stationAddress', parseInt(e.target.value))}
            />
          </div>
          <Select
            label="Baud Rate"
            options={[...PROFIBUS_BIT_RATES]}
            value={(values.baudRate as number) || 1500000}
            onChange={(e) => onChange('baudRate', parseInt(e.target.value))}
          />
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Master Address
            </label>
            <Input
              fullWidth
              type="number"
              min={0}
              max={125}
              value={(values.masterAddress as number) || 0}
              onChange={(e) => onChange('masterAddress', parseInt(e.target.value))}
            />
          </div>
        </div>
      </fieldset>
    </div>
  );
}

// BACnet MS/TP Configuration Fields
function BacnetMstpFields({
  values,
  onChange,
}: {
  values: Record<string, unknown>;
  onChange: (field: string, value: unknown) => void;
}) {
  return (
    <div className="space-y-6">
      <fieldset className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
        <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 px-2">
          BACnet MS/TP Ayarları
        </legend>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Seri Port <span className="text-error-500">*</span>
            </label>
            <Input
              fullWidth
              type="text"
              value={(values.serialPort as string) || ''}
              onChange={(e) => onChange('serialPort', e.target.value)}
              placeholder="COM1 veya /dev/ttyUSB0"
            />
          </div>
          <Select
            label="Baud Rate"
            options={[...BACNET_MSTP_BAUD_RATES]}
            value={(values.baudRate as number) || 38400}
            onChange={(e) => onChange('baudRate', parseInt(e.target.value))}
          />
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              MAC Address <span className="text-error-500">*</span>
            </label>
            <Input
              fullWidth
              type="number"
              min={0}
              max={127}
              value={(values.macAddress as number) || 1}
              onChange={(e) => onChange('macAddress', parseInt(e.target.value))}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Device Instance <span className="text-error-500">*</span>
            </label>
            <Input
              fullWidth
              type="number"
              min={0}
              max={4194303}
              value={(values.deviceInstance as number) || 0}
              onChange={(e) => onChange('deviceInstance', parseInt(e.target.value))}
            />
          </div>
        </div>
      </fieldset>
    </div>
  );
}

export default VfdProtocolConfigStep;
