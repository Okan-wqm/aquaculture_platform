import { Injectable } from '@nestjs/common';

import {
  ProtocolCategory,
  ProtocolSubcategory,
  ConnectionType,
  ProtocolConfigurationSchema,
} from '../../../database/entities/sensor-protocol.entity';
import {
  BaseProtocolAdapter,
  ConnectionHandle,
  ConnectionTestResult,
  SensorReadingData,
  ValidationResult,
  ProtocolCapabilities,
} from '../base-protocol.adapter';

export interface ModbusAsciiConfiguration {
  sensorId?: string;
  tenantId?: string;
  comPort: string;
  baudRate: number;
  dataBits: 7 | 8;
  parity: 'none' | 'even' | 'odd';
  stopBits: 1 | 2;
  slaveId: number;
  registerAddress: number;
  registerCount: number;
  functionCode: 1 | 2 | 3 | 4;
  dataType: string;
  timeout: number;
  pollingInterval: number;
}

@Injectable()
export class ModbusAsciiAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'MODBUS_ASCII';
  readonly category = ProtocolCategory.INDUSTRIAL;
  readonly subcategory = ProtocolSubcategory.MODBUS;
  readonly connectionType = ConnectionType.SERIAL;
  readonly displayName = 'Modbus ASCII';
  readonly description = 'Modbus ASCII mode over serial connection';

  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    const asciiConfig = config as Partial<ModbusAsciiConfiguration>;

    const ModbusRTU = (await import('modbus-serial')).default;
    const client = new ModbusRTU();

    await client.connectAsciiSerial(asciiConfig.comPort, {
      baudRate: asciiConfig.baudRate,
      dataBits: asciiConfig.dataBits,
      parity: asciiConfig.parity,
      stopBits: asciiConfig.stopBits,
    });

    client.setID(asciiConfig.slaveId);
    client.setTimeout(asciiConfig.timeout);

    const handle = this.createConnectionHandle(
      asciiConfig.sensorId ?? 'unknown',
      asciiConfig.tenantId ?? 'unknown',
      { comPort: asciiConfig.comPort }
    );

    return handle;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async disconnect(handle: ConnectionHandle): Promise<void> {
    this.removeConnectionHandle(handle.id);
    this.logConnectionEvent('disconnect', handle);
  }

  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> {
    const startTime = Date.now();
    try {
      const handle = await this.connect(config);
      await this.disconnect(handle);
      return { success: true, latencyMs: Date.now() - startTime };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latencyMs: Date.now() - startTime,
      };
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async readData(handle: ConnectionHandle): Promise<SensorReadingData> {
    this.updateLastActivity(handle);
    return { timestamp: new Date(), values: {}, quality: 100, source: 'modbus_ascii' };
  }

  validateConfiguration(config: unknown): ValidationResult {
    const errors = [];
    const cfg = config as Partial<ModbusAsciiConfiguration>;

    if (!cfg.comPort) errors.push(this.validationError('comPort', 'COM Port is required'));
    if (cfg.slaveId === undefined || cfg.slaveId < 1 || cfg.slaveId > 247) {
      errors.push(this.validationError('slaveId', 'Slave ID must be 1-247'));
    }

    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object',
      title: 'Modbus ASCII Configuration',
      required: ['comPort', 'slaveId'],
      properties: {
        comPort: { type: 'string', title: 'COM Port', 'ui:order': 1, 'ui:group': 'serial' },
        baudRate: { type: 'integer', title: 'Baud Rate', enum: [4800, 9600, 19200, 38400], default: 9600, 'ui:order': 2, 'ui:group': 'serial' },
        dataBits: { type: 'integer', title: 'Data Bits', enum: [7, 8], default: 7, 'ui:order': 3, 'ui:group': 'serial' },
        parity: { type: 'string', title: 'Parity', enum: ['none', 'even', 'odd'], default: 'even', 'ui:order': 4, 'ui:group': 'serial' },
        stopBits: { type: 'integer', title: 'Stop Bits', enum: [1, 2], default: 1, 'ui:order': 5, 'ui:group': 'serial' },
        slaveId: { type: 'integer', title: 'Slave ID', default: 1, minimum: 1, maximum: 247, 'ui:order': 6, 'ui:group': 'modbus' },
        functionCode: { type: 'integer', title: 'Function Code', enum: [1, 2, 3, 4], default: 3, 'ui:order': 7, 'ui:group': 'modbus' },
        registerAddress: { type: 'integer', title: 'Register Address', default: 0, 'ui:order': 8, 'ui:group': 'modbus' },
        registerCount: { type: 'integer', title: 'Register Count', default: 1, 'ui:order': 9, 'ui:group': 'modbus' },
        timeout: { type: 'integer', title: 'Timeout (ms)', default: 1000, 'ui:order': 10, 'ui:group': 'advanced' },
        pollingInterval: { type: 'integer', title: 'Polling Interval (ms)', default: 1000, 'ui:order': 11, 'ui:group': 'advanced' },
      },
      'ui:groups': [
        { name: 'serial', title: 'Serial Port', fields: ['comPort', 'baudRate', 'dataBits', 'parity', 'stopBits'] },
        { name: 'modbus', title: 'Modbus', fields: ['slaveId', 'functionCode', 'registerAddress', 'registerCount'] },
        { name: 'advanced', title: 'Advanced', fields: ['timeout', 'pollingInterval'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return {
      comPort: '',
      baudRate: 9600,
      dataBits: 7,
      parity: 'even',
      stopBits: 1,
      slaveId: 1,
      functionCode: 3,
      registerAddress: 0,
      registerCount: 1,
      timeout: 1000,
      pollingInterval: 1000,
    };
  }

  getCapabilities(): ProtocolCapabilities {
    return {
      supportsDiscovery: false,
      supportsBidirectional: true,
      supportsPolling: true,
      supportsSubscription: false,
      supportsAuthentication: false,
      supportsEncryption: false,
      supportedDataTypes: ['int16', 'uint16', 'int32', 'float32'],
    };
  }
}
