import { Module, Global, DynamicModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entity
import { SensorProtocol } from '../database/entities/sensor-protocol.entity';

// Services

// Industrial Protocol Adapters
import { AllenBradleyDf1Adapter } from './adapters/industrial/allen-bradley-df1.adapter';
import { AllenBradleyEthernetAdapter } from './adapters/industrial/allen-bradley-ethernet.adapter';
import { BacnetIpAdapter } from './adapters/industrial/bacnet-ip.adapter';
import { BacnetMstpAdapter } from './adapters/industrial/bacnet-mstp.adapter';
import { EthernetIpAdapter } from './adapters/industrial/ethernet-ip.adapter';
import { ModbusAsciiAdapter } from './adapters/industrial/modbus-ascii.adapter';
import { ModbusRtuAdapter } from './adapters/industrial/modbus-rtu.adapter';
import { ModbusTcpAdapter } from './adapters/industrial/modbus-tcp.adapter';
import { OmronFinsAdapter } from './adapters/industrial/omron-fins.adapter';
import { OpcUaAdapter } from './adapters/industrial/opcua.adapter';
import { ProfibusDpAdapter } from './adapters/industrial/profibus-dp.adapter';
import { ProfinetAdapter } from './adapters/industrial/profinet.adapter';
import { KnxIpAdapter } from './adapters/industrial/knx-ip.adapter';
import { DeviceNetAdapter } from './adapters/industrial/devicenet.adapter';
import { CanopenAdapter } from './adapters/industrial/canopen.adapter';
import { EthercatAdapter } from './adapters/industrial/ethercat.adapter';
import { CclinkAdapter } from './adapters/industrial/cclink.adapter';
import { SchneiderModiconAdapter } from './adapters/industrial/schneider-modicon.adapter';
import { SiemensS7Adapter } from './adapters/industrial/siemens-s7.adapter';
import { MitsubishiMcAdapter } from './adapters/industrial/mitsubishi-mc.adapter';

// IoT Protocol Adapters
import { AmqpAdapter } from './adapters/iot/amqp.adapter';
import { CoapAdapter } from './adapters/iot/coap.adapter';
import { DdsAdapter } from './adapters/iot/dds.adapter';
import { HttpRestAdapter } from './adapters/iot/http-rest.adapter';
import { MqttAdapter } from './adapters/iot/mqtt.adapter';
import { WebSocketAdapter } from './adapters/iot/websocket.adapter';

// Serial Protocol Adapters
import { I2cAdapter } from './adapters/serial/i2c.adapter';
import { OneWireAdapter } from './adapters/serial/one-wire.adapter';
import { Rs232Adapter } from './adapters/serial/rs232.adapter';
import { Rs485Adapter } from './adapters/serial/rs485.adapter';
import { SpiAdapter } from './adapters/serial/spi.adapter';
import { TcpSocketAdapter } from './adapters/serial/tcp-socket.adapter';
import { UdpSocketAdapter } from './adapters/serial/udp-socket.adapter';

// Wireless Protocol Adapters
import { BleAdapter } from './adapters/wireless/ble.adapter';
import { EspNowAdapter } from './adapters/wireless/esp-now.adapter';
import { LorawanAdapter } from './adapters/wireless/lorawan.adapter';
import { ThreadMatterAdapter } from './adapters/wireless/thread-matter.adapter';
import { ZigbeeAdapter } from './adapters/wireless/zigbee.adapter';
import { ZwaveAdapter } from './adapters/wireless/zwave.adapter';

// Resolver
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
  EthernetIpAdapter,
  ProfinetAdapter,
  BacnetIpAdapter,
  BacnetMstpAdapter,
  KnxIpAdapter,
  ProfibusDpAdapter,
  DeviceNetAdapter,
  CanopenAdapter,
  EthercatAdapter,
  CclinkAdapter,
  SiemensS7Adapter,
  AllenBradleyEthernetAdapter,
  AllenBradleyDf1Adapter,
  MitsubishiMcAdapter,
  OmronFinsAdapter,
  SchneiderModiconAdapter,
  // IoT
  MqttAdapter,
  CoapAdapter,
  AmqpAdapter,
  HttpRestAdapter,
  WebSocketAdapter,
  DdsAdapter,
  // Serial
  TcpSocketAdapter,
  UdpSocketAdapter,
  Rs232Adapter,
  Rs485Adapter,
  I2cAdapter,
  SpiAdapter,
  OneWireAdapter,
  // Wireless
  LorawanAdapter,
  ZigbeeAdapter,
  BleAdapter,
  ZwaveAdapter,
  EspNowAdapter,
  ThreadMatterAdapter,
];

@Global()
@Module({})
export class ProtocolModule {
  static forRoot(): DynamicModule {
    return {
      module: ProtocolModule,
      imports: [
        TypeOrmModule.forFeature([SensorProtocol]),
        ConfigModule,
      ],
      providers: [
        // Services
        ProtocolRegistryService,
        ProtocolValidatorService,
        ConnectionTesterService,
        // Resolver
        ProtocolResolver,
        // All adapters as providers
        ...PROTOCOL_ADAPTERS,
        // Provide adapters as a token for injection
        {
          provide: 'PROTOCOL_ADAPTERS',
          useFactory: (...adapters) => adapters,
          inject: PROTOCOL_ADAPTERS,
        },
      ],
      exports: [
        ProtocolRegistryService,
        ProtocolValidatorService,
        ConnectionTesterService,
        TypeOrmModule,
        'PROTOCOL_ADAPTERS',
      ],
    };
  }
}
