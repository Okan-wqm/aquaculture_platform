/**
 * Protocol Adapters Registry
 * Extracted to avoid circular imports between protocol.module.ts and protocol-registry.service.ts
 */

import { AllenBradleyDf1Adapter } from './industrial/allen-bradley-df1.adapter';
import { AllenBradleyEthernetAdapter } from './industrial/allen-bradley-ethernet.adapter';
import { BacnetIpAdapter } from './industrial/bacnet-ip.adapter';
import { BacnetMstpAdapter } from './industrial/bacnet-mstp.adapter';
import { CanopenAdapter } from './industrial/canopen.adapter';
import { CclinkAdapter } from './industrial/cclink.adapter';
import { DeviceNetAdapter } from './industrial/devicenet.adapter';
import { EthercatAdapter } from './industrial/ethercat.adapter';
import { EthernetIpAdapter } from './industrial/ethernet-ip.adapter';
import { KnxIpAdapter } from './industrial/knx-ip.adapter';
import { MitsubishiMcAdapter } from './industrial/mitsubishi-mc.adapter';
import { ModbusAsciiAdapter } from './industrial/modbus-ascii.adapter';
import { ModbusRtuAdapter } from './industrial/modbus-rtu.adapter';
import { ModbusTcpAdapter } from './industrial/modbus-tcp.adapter';
import { OmronFinsAdapter } from './industrial/omron-fins.adapter';
import { OpcUaAdapter } from './industrial/opcua.adapter';
import { ProfibusDpAdapter } from './industrial/profibus-dp.adapter';
import { ProfinetAdapter } from './industrial/profinet.adapter';
import { SchneiderModiconAdapter } from './industrial/schneider-modicon.adapter';
import { SiemensS7Adapter } from './industrial/siemens-s7.adapter';
import { AmqpAdapter } from './iot/amqp.adapter';
import { CoapAdapter } from './iot/coap.adapter';
import { DdsAdapter } from './iot/dds.adapter';
import { HttpRestAdapter } from './iot/http-rest.adapter';
import { MqttAdapter } from './iot/mqtt.adapter';
import { WebSocketAdapter } from './iot/websocket.adapter';
import { I2cAdapter } from './serial/i2c.adapter';
import { OneWireAdapter } from './serial/one-wire.adapter';
import { Rs232Adapter } from './serial/rs232.adapter';
import { Rs485Adapter } from './serial/rs485.adapter';
import { SpiAdapter } from './serial/spi.adapter';
import { TcpSocketAdapter } from './serial/tcp-socket.adapter';
import { UdpSocketAdapter } from './serial/udp-socket.adapter';
import { BleAdapter } from './wireless/ble.adapter';
import { EspNowAdapter } from './wireless/esp-now.adapter';
import { LorawanAdapter } from './wireless/lorawan.adapter';
import { ThreadMatterAdapter } from './wireless/thread-matter.adapter';
import { ZigbeeAdapter } from './wireless/zigbee.adapter';
import { ZwaveAdapter } from './wireless/zwave.adapter';

/**
 * All protocol adapter classes
 */
export const PROTOCOL_ADAPTERS = [
  // Industrial
  ModbusTcpAdapter,
  ModbusRtuAdapter,
  ModbusAsciiAdapter,
  OpcUaAdapter,
  ProfibusDpAdapter,
  ProfinetAdapter,
  EthernetIpAdapter,
  BacnetIpAdapter,
  BacnetMstpAdapter,
  AllenBradleyDf1Adapter,
  AllenBradleyEthernetAdapter,
  OmronFinsAdapter,
  SiemensS7Adapter,
  SchneiderModiconAdapter,
  MitsubishiMcAdapter,
  KnxIpAdapter,
  DeviceNetAdapter,
  CanopenAdapter,
  EthercatAdapter,
  CclinkAdapter,

  // IoT
  MqttAdapter,
  AmqpAdapter,
  CoapAdapter,
  HttpRestAdapter,
  WebSocketAdapter,
  DdsAdapter,

  // Serial
  Rs232Adapter,
  Rs485Adapter,
  I2cAdapter,
  SpiAdapter,
  OneWireAdapter,
  TcpSocketAdapter,
  UdpSocketAdapter,

  // Wireless
  BleAdapter,
  ZigbeeAdapter,
  ZwaveAdapter,
  LorawanAdapter,
  ThreadMatterAdapter,
  EspNowAdapter,
];
