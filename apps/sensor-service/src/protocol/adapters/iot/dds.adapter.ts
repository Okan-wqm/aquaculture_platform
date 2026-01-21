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

export interface DdsConfiguration {
  sensorId?: string;
  tenantId?: string;
  domainId: number;
  participantName: string;
  topicName: string;
  typeName: string;
  reliabilityKind: 'BEST_EFFORT' | 'RELIABLE';
  durabilityKind: 'VOLATILE' | 'TRANSIENT_LOCAL' | 'PERSISTENT';
  historyKind: 'KEEP_LAST' | 'KEEP_ALL';
  historyDepth: number;
  partitions?: string[];
  transport: 'UDP' | 'TCP' | 'SHARED_MEMORY';
}

@Injectable()
export class DdsAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'DDS';
  readonly category = ProtocolCategory.IOT;
  readonly subcategory = ProtocolSubcategory.REALTIME;
  readonly connectionType = ConnectionType.HYBRID;
  readonly displayName = 'DDS';
  readonly description = 'Data Distribution Service - Real-time publish-subscribe middleware';

  // eslint-disable-next-line @typescript-eslint/require-await
  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    const ddsConfig = config as unknown as DdsConfiguration;

    // DDS requires specific vendor library (RTI, OpenDDS, etc.)
    // This is a placeholder implementation
    const handle = this.createConnectionHandle(
      ddsConfig.sensorId ?? 'unknown',
      ddsConfig.tenantId ?? 'unknown',
      { domainId: ddsConfig.domainId, topicName: ddsConfig.topicName }
    );

    this.logConnectionEvent('connect', handle, { domainId: ddsConfig.domainId });
    return handle;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async disconnect(handle: ConnectionHandle): Promise<void> {
    this.removeConnectionHandle(handle.id);
    this.logConnectionEvent('disconnect', handle);
  }

  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async testConnection(_config: Record<string, unknown>): Promise<ConnectionTestResult> {
    const startTime = Date.now();
    const latencyMs = Date.now() - startTime;

    // Placeholder - implement with actual DDS library
    return {
      success: true,
      latencyMs,
      diagnostics: { connectionTimeMs: latencyMs },
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async readData(handle: ConnectionHandle): Promise<SensorReadingData> {
    this.updateLastActivity(handle);

    return {
      timestamp: new Date(),
      values: {},
      quality: 100,
      source: 'dds',
    };
  }

  validateConfiguration(config: unknown): ValidationResult {
    const errors = [];
    const cfg = config as Partial<DdsConfiguration>;

    if (cfg.domainId === undefined || cfg.domainId < 0 || cfg.domainId > 232) {
      errors.push(this.validationError('domainId', 'Domain ID must be between 0 and 232'));
    }

    if (!cfg.topicName) {
      errors.push(this.validationError('topicName', 'Topic name is required'));
    }

    if (!cfg.typeName) {
      errors.push(this.validationError('typeName', 'Type name is required'));
    }

    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object',
      title: 'DDS Configuration',
      required: ['domainId', 'topicName', 'typeName'],
      properties: {
        domainId: {
          type: 'integer',
          title: 'Domain ID',
          default: 0,
          minimum: 0,
          maximum: 232,
          'ui:order': 1,
          'ui:group': 'connection',
        },
        participantName: {
          type: 'string',
          title: 'Participant Name',
          'ui:order': 2,
          'ui:group': 'connection',
        },
        topicName: {
          type: 'string',
          title: 'Topic Name',
          'ui:order': 3,
          'ui:group': 'connection',
        },
        typeName: {
          type: 'string',
          title: 'Type Name',
          description: 'IDL-defined data type',
          'ui:order': 4,
          'ui:group': 'connection',
        },
        reliabilityKind: {
          type: 'string',
          title: 'Reliability',
          enum: ['BEST_EFFORT', 'RELIABLE'],
          default: 'BEST_EFFORT',
          'ui:order': 5,
          'ui:group': 'qos',
        },
        durabilityKind: {
          type: 'string',
          title: 'Durability',
          enum: ['VOLATILE', 'TRANSIENT_LOCAL', 'PERSISTENT'],
          default: 'VOLATILE',
          'ui:order': 6,
          'ui:group': 'qos',
        },
        historyKind: {
          type: 'string',
          title: 'History',
          enum: ['KEEP_LAST', 'KEEP_ALL'],
          default: 'KEEP_LAST',
          'ui:order': 7,
          'ui:group': 'qos',
        },
        historyDepth: {
          type: 'integer',
          title: 'History Depth',
          default: 1,
          minimum: 1,
          'ui:order': 8,
          'ui:group': 'qos',
        },
        transport: {
          type: 'string',
          title: 'Transport',
          enum: ['UDP', 'TCP', 'SHARED_MEMORY'],
          default: 'UDP',
          'ui:order': 9,
          'ui:group': 'advanced',
        },
      },
      'ui:groups': [
        { name: 'connection', title: 'Connection', fields: ['domainId', 'participantName', 'topicName', 'typeName'] },
        { name: 'qos', title: 'Quality of Service', fields: ['reliabilityKind', 'durabilityKind', 'historyKind', 'historyDepth'] },
        { name: 'advanced', title: 'Advanced', fields: ['transport'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return {
      domainId: 0,
      participantName: '',
      topicName: '',
      typeName: '',
      reliabilityKind: 'BEST_EFFORT',
      durabilityKind: 'VOLATILE',
      historyKind: 'KEEP_LAST',
      historyDepth: 1,
      transport: 'UDP',
    };
  }

  getCapabilities(): ProtocolCapabilities {
    return {
      supportsDiscovery: true,
      supportsBidirectional: true,
      supportsPolling: false,
      supportsSubscription: true,
      supportsAuthentication: true,
      supportsEncryption: true,
      supportedDataTypes: ['idl'],
    };
  }
}
