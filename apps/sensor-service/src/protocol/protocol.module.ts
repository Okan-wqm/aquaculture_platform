import { Module, Global, DynamicModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SensorProtocol } from '../database/entities/sensor-protocol.entity';

import { AllenBradleyDf1Adapter } from './adapters/industrial/allen-bradley-df1.adapter';
import { AllenBradleyEthernetAdapter } from './adapters/industrial/allen-bradley-ethernet.adapter';
import { BacnetIpAdapter } from './adapters/industrial/bacnet-ip.adapter';
import { BacnetMstpAdapter } from './adapters/industrial/bacnet-mstp.adapter';
import { CanopenAdapter } from './adapters/industrial/canopen.adapter';
import { CclinkAdapter } from './adapters/industrial/cclink.adapter';
import { DeviceNetAdapter } from './adapters/industrial/devicenet.adapter';
import { EthercatAdapter } from './adapters/industrial/ethercat.adapter';
import { EthernetIpAdapter } from './adapters/industrial/ethernet-ip.adapter';
import { KnxIpAdapter } from './adapters/industrial/knx-ip.adapter';
import { MitsubishiMcAdapter } from './adapters/industrial/mitsubishi-mc.adapter';
import { ModbusAsciiAdapter } from './adapters/industrial/modbus-ascii.adapter';
import { ModbusRtuAdapter } from './adapters/industrial/modbus-rtu.adapter';
import { ModbusTcpAdapter } from './adapters/industrial/modbus-tcp.adapter';
import { OmronFinsAdapter } from './adapters/industrial/omron-fins.adapter';
import { OpcUaAdapter } from './adapters/industrial/opcua.adapter';
import { ProfibusDpAdapter } from './adapters/industrial/profibus-dp.adapter';
import { ProfinetAdapter } from './adapters/industrial/profinet.adapter';
import { SchneiderModiconAdapter } from './adapters/industrial/schneider-modicon.adapter';
import { SiemensS7Adapter } from './adapters/industrial/siemens-s7.adapter';
import { AmqpAdapter } from './adapters/iot/amqp.adapter';
import { CoapAdapter } from './adapters/iot/coap.adapter';
import { DdsAdapter } from './adapters/iot/dds.adapter';
import { HttpRestAdapter } from './adapters/iot/http-rest.adapter';
import { MqttAdapter } from './adapters/iot/mqtt.adapter';
import { WebSocketAdapter } from './adapters/iot/websocket.adapter';
import { I2cAdapter } from './adapters/serial/i2c.adapter';
import { OneWireAdapter } from './adapters/serial/one-wire.adapter';
import { Rs232Adapter } from './adapters/serial/rs232.adapter';
import { Rs485Adapter } from './adapters/serial/rs485.adapter';
import { SpiAdapter } from './adapters/serial/spi.adapter';
import { TcpSocketAdapter } from './adapters/serial/tcp-socket.adapter';
import { UdpSocketAdapter } from './adapters/serial/udp-socket.adapter';
import { BleAdapter } from './adapters/wireless/ble.adapter';
import { EspNowAdapter } from './adapters/wireless/esp-now.adapter';
import { LorawanAdapter } from './adapters/wireless/lorawan.adapter';
import { ThreadMatterAdapter } from './adapters/wireless/thread-matter.adapter';
import { ZigbeeAdapter } from './adapters/wireless/zigbee.adapter';
import { ZwaveAdapter } from './adapters/wireless/zwave.adapter';
import { ProtocolResolver } from './resolvers/protocol.resolver';
import { ConnectionTesterService } from './services/connection-tester.service';
import { ProtocolRegistryService } from './services/protocol-registry.service';
import { ProtocolValidatorService } from './services/protocol-validator.service';

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

/**
 * Protocol Module
 * Provides protocol adapters for connecting to various sensor devices
 */
@Global()
@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([SensorProtocol]),
  ],
  providers: [
    // Services
    ProtocolRegistryService,
    ProtocolValidatorService,
    ConnectionTesterService,

    // Resolver
    ProtocolResolver,

    // All protocol adapters
    ...PROTOCOL_ADAPTERS,
  ],
  exports: [
    ProtocolRegistryService,
    ProtocolValidatorService,
    ConnectionTesterService,
    ...PROTOCOL_ADAPTERS,
  ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class ProtocolModule {
  /**
   * Static forRoot method for module registration
   * Required for dynamic module pattern used in app.module.ts
   */
  static forRoot(): DynamicModule {
    return {
      module: ProtocolModule,
      global: true,
    };
  }

  /**
   * Get all available adapter types
   */
  static getAdapterTypes(): typeof PROTOCOL_ADAPTERS {
    return PROTOCOL_ADAPTERS;
  }
}
