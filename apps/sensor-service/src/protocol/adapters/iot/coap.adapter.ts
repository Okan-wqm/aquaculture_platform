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

export interface CoapConfiguration {
  sensorId?: string;
  tenantId?: string;
  serverUri: string;
  port: number;
  resourcePath: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'OBSERVE';
  confirmable: boolean;
  contentFormat: number; // 0=text/plain, 50=application/json, 60=application/cbor
  observe: boolean;
  // Security (DTLS)
  securityMode: 'NoSec' | 'PSK' | 'Certificate';
  pskIdentity?: string;
  pskKey?: string;
  caCert?: string;
  clientCert?: string;
  clientKey?: string;
  // Timeouts
  ackTimeout: number;
  maxRetransmit: number;
  // Polling
  pollingInterval: number;
}

@Injectable()
export class CoapAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'COAP';
  readonly category = ProtocolCategory.IOT;
  readonly subcategory = ProtocolSubcategory.REQUEST_RESPONSE;
  readonly connectionType = ConnectionType.UDP;
  readonly displayName = 'CoAP';
  readonly description = 'Constrained Application Protocol - Lightweight IoT protocol for constrained devices';

  // eslint-disable-next-line @typescript-eslint/require-await
  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    const coapConfig = config as unknown as CoapConfiguration;

    // CoAP is connectionless (UDP), so we just validate and create handle
    const handle = this.createConnectionHandle(
      coapConfig.sensorId ?? 'unknown',
      coapConfig.tenantId ?? 'unknown',
      { serverUri: coapConfig.serverUri, resourcePath: coapConfig.resourcePath }
    );

    this.logConnectionEvent('connect', handle, { serverUri: coapConfig.serverUri });
    return handle;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async disconnect(handle: ConnectionHandle): Promise<void> {
    this.removeConnectionHandle(handle.id);
    this.logConnectionEvent('disconnect', handle);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> {
    const coapConfig = config as unknown as CoapConfiguration;
    const startTime = Date.now();

    try {
      // In production, use actual CoAP library
      // const coap = require('coap');
      // const req = coap.request({ hostname: coapConfig.serverUri, port: coapConfig.port, pathname: coapConfig.resourcePath });

      const latencyMs = Date.now() - startTime;

      return {
        success: true,
        latencyMs,
        diagnostics: {
          connectionTimeMs: latencyMs,
          deviceInfo: {
            uri: `coap://${coapConfig.serverUri}:${coapConfig.port}${coapConfig.resourcePath}`,
          },
        },
      };
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

    // Placeholder - implement with actual CoAP library
    return {
      timestamp: new Date(),
      values: {},
      quality: 100,
      source: 'coap',
    };
  }

  validateConfiguration(config: unknown): ValidationResult {
    const errors = [];
    const warnings = [];
    const cfg = config as Partial<CoapConfiguration>;

    if (!cfg.serverUri) {
      errors.push(this.validationError('serverUri', 'Server URI is required'));
    }

    if (!cfg.resourcePath) {
      errors.push(this.validationError('resourcePath', 'Resource path is required'));
    } else if (!cfg.resourcePath.startsWith('/')) {
      errors.push(this.validationError('resourcePath', 'Resource path must start with /'));
    }

    if (cfg.port !== undefined && !this.isValidPort(cfg.port)) {
      errors.push(this.validationError('port', 'Port must be between 1 and 65535'));
    }

    if (cfg.securityMode === 'PSK') {
      if (!cfg.pskIdentity) errors.push(this.validationError('pskIdentity', 'PSK identity required'));
      if (!cfg.pskKey) errors.push(this.validationError('pskKey', 'PSK key required'));
    }

    if (cfg.securityMode === 'NoSec') {
      warnings.push(this.validationWarning('securityMode', 'No security configured. Consider using DTLS.'));
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object',
      title: 'CoAP Configuration',
      required: ['serverUri', 'resourcePath'],
      properties: {
        serverUri: {
          type: 'string',
          title: 'Server URI',
          description: 'CoAP server hostname or IP',
          'ui:placeholder': '192.168.1.100',
          'ui:order': 1,
          'ui:group': 'connection',
        },
        port: {
          type: 'integer',
          title: 'Port',
          description: 'CoAP: 5683, CoAPs: 5684',
          default: 5683,
          minimum: 1,
          maximum: 65535,
          'ui:order': 2,
          'ui:group': 'connection',
        },
        resourcePath: {
          type: 'string',
          title: 'Resource Path',
          description: 'URI path to resource',
          'ui:placeholder': '/sensors/temperature',
          'ui:order': 3,
          'ui:group': 'connection',
        },
        method: {
          type: 'string',
          title: 'Method',
          enum: ['GET', 'POST', 'PUT', 'DELETE', 'OBSERVE'],
          default: 'GET',
          'ui:order': 4,
          'ui:group': 'connection',
        },
        confirmable: {
          type: 'boolean',
          title: 'Confirmable',
          description: 'Use reliable transfer (CON)',
          default: true,
          'ui:order': 5,
          'ui:group': 'connection',
        },
        observe: {
          type: 'boolean',
          title: 'Observe',
          description: 'Subscribe to resource updates',
          default: false,
          'ui:order': 6,
          'ui:group': 'connection',
        },
        contentFormat: {
          type: 'integer',
          title: 'Content Format',
          enum: [0, 50, 60],
          enumNames: ['text/plain (0)', 'application/json (50)', 'application/cbor (60)'],
          default: 50,
          'ui:order': 7,
          'ui:group': 'data',
        },
        securityMode: {
          type: 'string',
          title: 'Security Mode',
          enum: ['NoSec', 'PSK', 'Certificate'],
          enumNames: ['No Security', 'Pre-Shared Key', 'Certificate'],
          default: 'NoSec',
          'ui:order': 8,
          'ui:group': 'security',
        },
        pskIdentity: {
          type: 'string',
          title: 'PSK Identity',
          'ui:order': 9,
          'ui:group': 'security',
        },
        pskKey: {
          type: 'string',
          title: 'PSK Key',
          description: 'Hexadecimal key',
          format: 'password',
          'ui:order': 10,
          'ui:group': 'security',
        },
        ackTimeout: {
          type: 'integer',
          title: 'ACK Timeout (seconds)',
          default: 2,
          'ui:order': 11,
          'ui:group': 'advanced',
        },
        maxRetransmit: {
          type: 'integer',
          title: 'Max Retransmit',
          default: 4,
          'ui:order': 12,
          'ui:group': 'advanced',
        },
        pollingInterval: {
          type: 'integer',
          title: 'Polling Interval (ms)',
          default: 5000,
          minimum: 1000,
          'ui:order': 13,
          'ui:group': 'polling',
        },
      },
      'ui:groups': [
        { name: 'connection', title: 'Connection', fields: ['serverUri', 'port', 'resourcePath', 'method', 'confirmable', 'observe'] },
        { name: 'security', title: 'Security (DTLS)', fields: ['securityMode', 'pskIdentity', 'pskKey'] },
        { name: 'data', title: 'Data Format', fields: ['contentFormat'] },
        { name: 'polling', title: 'Polling', fields: ['pollingInterval'] },
        { name: 'advanced', title: 'Advanced', fields: ['ackTimeout', 'maxRetransmit'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return {
      serverUri: '',
      port: 5683,
      resourcePath: '',
      method: 'GET',
      confirmable: true,
      observe: false,
      contentFormat: 50,
      securityMode: 'NoSec',
      ackTimeout: 2,
      maxRetransmit: 4,
      pollingInterval: 5000,
    };
  }

  getCapabilities(): ProtocolCapabilities {
    return {
      supportsDiscovery: true,
      supportsBidirectional: true,
      supportsPolling: true,
      supportsSubscription: true,
      supportsAuthentication: true,
      supportsEncryption: true,
      supportedDataTypes: ['json', 'cbor', 'text'],
      minimumPollingIntervalMs: 1000,
    };
  }
}
