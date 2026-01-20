/**
 * VFD Protocol Adapters Index
 * Exports all VFD protocol adapters and related types
 */

// Base adapter and types
export {
  BaseVfdAdapter,
  VfdConnectionHandle,
  VfdReadResult,
  VfdCommandResult,
  ConnectionTestResult,
  ValidationResult,
  BatchReadRequest,
} from './base-vfd.adapter';

// Protocol adapters
export { VfdModbusRtuAdapter, ModbusRtuConfig } from './vfd-modbus-rtu.adapter';
export { VfdModbusTcpAdapter, ModbusTcpConfig } from './vfd-modbus-tcp.adapter';
export { VfdProfibusAdapter, ProfibusConfig } from './vfd-profibus-dp.adapter';
export { VfdProfinetAdapter, ProfinetConfig } from './vfd-profinet.adapter';
export { VfdEthernetIpAdapter, EthernetIpConfig } from './vfd-ethernet-ip.adapter';
export { VfdCanopenAdapter, CanopenConfig } from './vfd-canopen.adapter';
export { VfdBacnetAdapter, BacnetConfig } from './vfd-bacnet.adapter';

import { VfdProtocol } from '../entities/vfd.enums';
import { BaseVfdAdapter } from './base-vfd.adapter';
import { VfdModbusRtuAdapter } from './vfd-modbus-rtu.adapter';
import { VfdModbusTcpAdapter } from './vfd-modbus-tcp.adapter';
import { VfdProfibusAdapter } from './vfd-profibus-dp.adapter';
import { VfdProfinetAdapter } from './vfd-profinet.adapter';
import { VfdEthernetIpAdapter } from './vfd-ethernet-ip.adapter';
import { VfdCanopenAdapter } from './vfd-canopen.adapter';
import { VfdBacnetAdapter } from './vfd-bacnet.adapter';

/**
 * Map of protocol codes to adapter classes
 */
export const VFD_PROTOCOL_ADAPTERS: Record<VfdProtocol, new () => BaseVfdAdapter> = {
  [VfdProtocol.MODBUS_RTU]: VfdModbusRtuAdapter,
  [VfdProtocol.MODBUS_TCP]: VfdModbusTcpAdapter,
  [VfdProtocol.PROFIBUS_DP]: VfdProfibusAdapter,
  [VfdProtocol.PROFINET]: VfdProfinetAdapter,
  [VfdProtocol.ETHERNET_IP]: VfdEthernetIpAdapter,
  [VfdProtocol.CANOPEN]: VfdCanopenAdapter,
  [VfdProtocol.BACNET_IP]: VfdBacnetAdapter,
  [VfdProtocol.BACNET_MSTP]: VfdBacnetAdapter, // Same adapter handles both
};

/**
 * Get adapter class for a specific protocol
 */
export function getVfdAdapterClass(protocol: VfdProtocol): new () => BaseVfdAdapter {
  const AdapterClass = VFD_PROTOCOL_ADAPTERS[protocol];
  if (!AdapterClass) {
    throw new Error(`No adapter found for protocol: ${protocol}`);
  }
  return AdapterClass;
}

/**
 * Create adapter instance for a specific protocol
 */
export function createVfdAdapter(protocol: VfdProtocol): BaseVfdAdapter {
  const AdapterClass = getVfdAdapterClass(protocol);
  return new AdapterClass();
}

/**
 * Get all supported protocols
 */
export function getSupportedProtocols(): VfdProtocol[] {
  return Object.keys(VFD_PROTOCOL_ADAPTERS) as VfdProtocol[];
}

/**
 * Check if a protocol is supported
 */
export function isProtocolSupported(protocol: VfdProtocol): boolean {
  return protocol in VFD_PROTOCOL_ADAPTERS;
}

/**
 * Protocol information for frontend display
 */
export interface ProtocolInfo {
  code: VfdProtocol;
  name: string;
  description: string;
  connectionType: 'serial' | 'ethernet' | 'fieldbus';
  configurationSchema: Record<string, unknown>;
  defaultConfiguration: Record<string, unknown>;
}

/**
 * Get protocol information for all supported protocols
 */
export function getProtocolInfoList(): ProtocolInfo[] {
  return [
    {
      code: VfdProtocol.MODBUS_RTU,
      name: 'Modbus RTU',
      description: 'Serial communication using Modbus RTU protocol',
      connectionType: 'serial',
      configurationSchema: new VfdModbusRtuAdapter().getConfigurationSchema(),
      defaultConfiguration: new VfdModbusRtuAdapter().getDefaultConfiguration(),
    },
    {
      code: VfdProtocol.MODBUS_TCP,
      name: 'Modbus TCP',
      description: 'Ethernet communication using Modbus TCP/IP protocol',
      connectionType: 'ethernet',
      configurationSchema: new VfdModbusTcpAdapter().getConfigurationSchema(),
      defaultConfiguration: new VfdModbusTcpAdapter().getDefaultConfiguration(),
    },
    {
      code: VfdProtocol.PROFIBUS_DP,
      name: 'PROFIBUS DP',
      description: 'Fieldbus communication using PROFIBUS DP protocol',
      connectionType: 'fieldbus',
      configurationSchema: new VfdProfibusAdapter().getConfigurationSchema(),
      defaultConfiguration: new VfdProfibusAdapter().getDefaultConfiguration(),
    },
    {
      code: VfdProtocol.PROFINET,
      name: 'PROFINET IO',
      description: 'Industrial Ethernet using PROFINET IO protocol',
      connectionType: 'ethernet',
      configurationSchema: new VfdProfinetAdapter().getConfigurationSchema(),
      defaultConfiguration: new VfdProfinetAdapter().getDefaultConfiguration(),
    },
    {
      code: VfdProtocol.ETHERNET_IP,
      name: 'EtherNet/IP',
      description: 'Industrial Ethernet using CIP over EtherNet/IP',
      connectionType: 'ethernet',
      configurationSchema: new VfdEthernetIpAdapter().getConfigurationSchema(),
      defaultConfiguration: new VfdEthernetIpAdapter().getDefaultConfiguration(),
    },
    {
      code: VfdProtocol.CANOPEN,
      name: 'CANopen',
      description: 'CAN-based communication using CANopen (CiA 402)',
      connectionType: 'fieldbus',
      configurationSchema: new VfdCanopenAdapter().getConfigurationSchema(),
      defaultConfiguration: new VfdCanopenAdapter().getDefaultConfiguration(),
    },
    {
      code: VfdProtocol.BACNET_IP,
      name: 'BACnet/IP',
      description: 'Building automation using BACnet over IP',
      connectionType: 'ethernet',
      configurationSchema: new VfdBacnetAdapter().getConfigurationSchema(),
      defaultConfiguration: new VfdBacnetAdapter().getDefaultConfiguration(),
    },
    {
      code: VfdProtocol.BACNET_MSTP,
      name: 'BACnet MS/TP',
      description: 'Building automation using BACnet over RS-485',
      connectionType: 'serial',
      configurationSchema: new VfdBacnetAdapter().getConfigurationSchema(),
      defaultConfiguration: new VfdBacnetAdapter().getDefaultConfiguration(),
    },
  ];
}
