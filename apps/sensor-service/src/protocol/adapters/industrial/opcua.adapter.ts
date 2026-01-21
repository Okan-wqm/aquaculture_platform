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
  DataSubscription,
  DataCallback,
  ErrorCallback,
} from '../base-protocol.adapter';

export interface OpcUaConfiguration {
  sensorId?: string;
  tenantId?: string;
  endpointUrl: string;
  securityMode: 'None' | 'Sign' | 'SignAndEncrypt';
  securityPolicy: 'None' | 'Basic256Sha256' | 'Aes128_Sha256_RsaOaep';
  authMode: 'Anonymous' | 'Username' | 'Certificate';
  username?: string;
  password?: string;
  clientCertPath?: string;
  clientKeyPath?: string;
  serverCertPath?: string;
  sessionTimeout: number;
  publishingInterval: number;
  samplingInterval: number;
  nodeIds: string[];
  // Advanced
  requestedSessionTimeout: number;
  secureChannelLifetime: number;
}

interface OpcUaSessionData {
  client: OpcUaClient;
  session: OpcUaSession;
  config: OpcUaConfiguration;
}

interface OpcUaClient {
  connect: (url: string) => Promise<void>;
  disconnect: () => Promise<void>;
  createSession: (userIdentity: OpcUaUserIdentity) => Promise<OpcUaSession>;
}

interface OpcUaSession {
  close: () => Promise<void>;
  read: (params: { nodeId: string }) => Promise<OpcUaDataValue>;
}

interface OpcUaDataValue {
  value?: { value?: unknown };
}

interface OpcUaUserIdentity {
  type: number;
  userName?: string;
  password?: string;
}

interface OpcUaMonitoredItem {
  on: (event: string, callback: (dataValue: OpcUaDataValue) => void) => void;
}

interface OpcUaSubscription {
  monitor: (
    params: { nodeId: string; attributeId: number },
    options: { samplingInterval: number; discardOldest: boolean; queueSize: number },
    timestampsToReturn: number
  ) => Promise<OpcUaMonitoredItem>;
  terminate: () => Promise<void>;
}

@Injectable()
export class OpcUaAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'OPC_UA';
  readonly category = ProtocolCategory.INDUSTRIAL;
  readonly subcategory = ProtocolSubcategory.ETHERNET_INDUSTRIAL;
  readonly connectionType = ConnectionType.TCP;
  readonly displayName = 'OPC UA';
  readonly description = 'OPC Unified Architecture - Industrial interoperability standard';

  private sessions = new Map<string, OpcUaSessionData>();

  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    const opcConfig = config as unknown as OpcUaConfiguration;

    // Dynamic import node-opcua
    const {
      OPCUAClient,
      SecurityPolicy,
      MessageSecurityMode,
      UserTokenType,
    } = await import('node-opcua');

    const securityModeMap: Record<string, unknown> = {
      'None': MessageSecurityMode.None,
      'Sign': MessageSecurityMode.Sign,
      'SignAndEncrypt': MessageSecurityMode.SignAndEncrypt,
    };

    const securityPolicyMap: Record<string, unknown> = {
      'None': SecurityPolicy.None,
      'Basic256Sha256': SecurityPolicy.Basic256Sha256,
      'Aes128_Sha256_RsaOaep': SecurityPolicy.Aes128_Sha256_RsaOaep,
    };

    const client = OPCUAClient.create({
      endpointMustExist: false,
      securityMode: securityModeMap[opcConfig.securityMode] || MessageSecurityMode.None,
      securityPolicy: securityPolicyMap[opcConfig.securityPolicy] || SecurityPolicy.None,
      requestedSessionTimeout: opcConfig.requestedSessionTimeout || 60000,
    }) as unknown as OpcUaClient;

    await client.connect(opcConfig.endpointUrl);

    let userIdentity: OpcUaUserIdentity = { type: UserTokenType.Anonymous as number };
    if (opcConfig.authMode === 'Username' && opcConfig.username) {
      userIdentity = {
        type: UserTokenType.UserName as number,
        userName: opcConfig.username,
        password: opcConfig.password,
      };
    }

    const session = await client.createSession(userIdentity);

    const handle = this.createConnectionHandle(
      opcConfig.sensorId ?? 'unknown',
      opcConfig.tenantId ?? 'unknown',
      { endpointUrl: opcConfig.endpointUrl }
    );

    this.sessions.set(handle.id, { client, session, config: opcConfig });
    this.logConnectionEvent('connect', handle);
    return handle;
  }

  async disconnect(handle: ConnectionHandle): Promise<void> {
    const sessionData = this.sessions.get(handle.id);
    if (sessionData) {
      try {
        await sessionData.session.close();
        await sessionData.client.disconnect();
      } catch (e) {
        this.logger.warn('Error closing OPC UA session', e);
      }
      this.sessions.delete(handle.id);
      this.removeConnectionHandle(handle.id);
      this.logConnectionEvent('disconnect', handle);
    }
  }

  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> {
    const startTime = Date.now();
    let handle: ConnectionHandle | null = null;

    try {
      handle = await this.withTimeout(this.connect(config), 30000, 'Connection timeout');
      const latencyMs = Date.now() - startTime;

      let sampleData: SensorReadingData | undefined;
      try {
        sampleData = await this.readData(handle);
      } catch {
        // Ignore read errors during connection test
      }

      return {
        success: true,
        latencyMs,
        sampleData,
        diagnostics: { connectionTimeMs: latencyMs },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latencyMs: Date.now() - startTime,
      };
    } finally {
      if (handle) await this.disconnect(handle);
    }
  }

  async readData(handle: ConnectionHandle): Promise<SensorReadingData> {
    const sessionData = this.sessions.get(handle.id);
    if (!sessionData) throw new Error('Session not found');

    const { session, config } = sessionData;
    const values: Record<string, number | string | boolean | null> = {};
    const timestamp = new Date();

    for (const nodeId of config.nodeIds) {
      try {
        const dataValue = await session.read({ nodeId });
        const nodeName = nodeId.split(';').pop() || nodeId;
        values[nodeName] = dataValue.value?.value ?? null;
      } catch (error) {
        this.logger.warn(`Failed to read node ${nodeId}`, error);
        values[nodeId] = null;
      }
    }

    this.updateLastActivity(handle);
    return { timestamp, values, quality: 100, source: 'opc_ua' };
  }

  async subscribeToData(
    handle: ConnectionHandle,
    onData: DataCallback,
    onError?: ErrorCallback
  ): Promise<DataSubscription> {
    const sessionData = this.sessions.get(handle.id);
    if (!sessionData) throw new Error('Session not found');

    const { session, config } = sessionData;
    const { ClientSubscription, AttributeIds } = await import('node-opcua');

    const subscription = ClientSubscription.create(session, {
      requestedPublishingInterval: config.publishingInterval || 1000,
      requestedLifetimeCount: 100,
      requestedMaxKeepAliveCount: 10,
      maxNotificationsPerPublish: 100,
      publishingEnabled: true,
      priority: 10,
    }) as unknown as OpcUaSubscription;

    let isActive = true;
    const monitoredItems: OpcUaMonitoredItem[] = [];

    for (const nodeId of config.nodeIds) {
      const item = await subscription.monitor(
        { nodeId, attributeId: AttributeIds.Value as number },
        { samplingInterval: config.samplingInterval || 500, discardOldest: true, queueSize: 10 },
        2 // TimestampsToReturn.Both
      );

      item.on('changed', (dataValue: OpcUaDataValue) => {
        try {
          const nodeName = nodeId.split(';').pop() || nodeId;
          const data: SensorReadingData = {
            timestamp: new Date(),
            values: { [nodeName]: dataValue.value?.value ?? null },
            quality: 100,
            source: 'opc_ua',
          };
          this.updateLastActivity(handle);
          onData(data);
        } catch (error) {
          onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      });

      monitoredItems.push(item);
    }

    return {
      id: `sub_${handle.id}_${Date.now()}`,
      unsubscribe: async () => {
        isActive = false;
        await subscription.terminate();
      },
      isActive: () => isActive,
    };
  }

  validateConfiguration(config: unknown): ValidationResult {
    const errors = [];
    const warnings = [];
    const cfg = config as Partial<OpcUaConfiguration>;

    if (!cfg.endpointUrl) {
      errors.push(this.validationError('endpointUrl', 'Endpoint URL is required'));
    } else if (!cfg.endpointUrl.startsWith('opc.tcp://')) {
      errors.push(this.validationError('endpointUrl', 'Endpoint URL must start with opc.tcp://'));
    }

    if (!cfg.nodeIds || cfg.nodeIds.length === 0) {
      errors.push(this.validationError('nodeIds', 'At least one Node ID is required'));
    }

    if (cfg.authMode === 'Username' && !cfg.username) {
      errors.push(this.validationError('username', 'Username required for Username authentication'));
    }

    if (cfg.securityMode === 'None') {
      warnings.push(this.validationWarning('securityMode', 'No security configured. Consider using Sign or SignAndEncrypt.'));
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object',
      title: 'OPC UA Configuration',
      required: ['endpointUrl', 'nodeIds'],
      properties: {
        endpointUrl: {
          type: 'string',
          title: 'Endpoint URL',
          description: 'OPC UA server endpoint',
          'ui:placeholder': 'opc.tcp://localhost:4840',
          'ui:order': 1,
          'ui:group': 'connection',
        },
        securityMode: {
          type: 'string',
          title: 'Security Mode',
          enum: ['None', 'Sign', 'SignAndEncrypt'],
          default: 'None',
          'ui:order': 2,
          'ui:group': 'security',
        },
        securityPolicy: {
          type: 'string',
          title: 'Security Policy',
          enum: ['None', 'Basic256Sha256', 'Aes128_Sha256_RsaOaep'],
          default: 'None',
          'ui:order': 3,
          'ui:group': 'security',
        },
        authMode: {
          type: 'string',
          title: 'Authentication',
          enum: ['Anonymous', 'Username', 'Certificate'],
          default: 'Anonymous',
          'ui:order': 4,
          'ui:group': 'authentication',
        },
        username: {
          type: 'string',
          title: 'Username',
          'ui:order': 5,
          'ui:group': 'authentication',
        },
        password: {
          type: 'string',
          title: 'Password',
          format: 'password',
          'ui:order': 6,
          'ui:group': 'authentication',
        },
        nodeIds: {
          type: 'array',
          title: 'Node IDs',
          description: 'List of node IDs to read (ns=2;s=Temperature)',
          items: { type: 'string' },
          'ui:order': 7,
          'ui:group': 'nodes',
        },
        sessionTimeout: {
          type: 'integer',
          title: 'Session Timeout (ms)',
          default: 60000,
          'ui:order': 8,
          'ui:group': 'advanced',
        },
        publishingInterval: {
          type: 'integer',
          title: 'Publishing Interval (ms)',
          default: 1000,
          'ui:order': 9,
          'ui:group': 'advanced',
        },
        samplingInterval: {
          type: 'integer',
          title: 'Sampling Interval (ms)',
          default: 500,
          'ui:order': 10,
          'ui:group': 'advanced',
        },
      },
      'ui:groups': [
        { name: 'connection', title: 'Connection', fields: ['endpointUrl'] },
        { name: 'security', title: 'Security', fields: ['securityMode', 'securityPolicy'] },
        { name: 'authentication', title: 'Authentication', fields: ['authMode', 'username', 'password'] },
        { name: 'nodes', title: 'Nodes', fields: ['nodeIds'] },
        { name: 'advanced', title: 'Advanced', fields: ['sessionTimeout', 'publishingInterval', 'samplingInterval'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return {
      endpointUrl: '',
      securityMode: 'None',
      securityPolicy: 'None',
      authMode: 'Anonymous',
      nodeIds: [],
      sessionTimeout: 60000,
      publishingInterval: 1000,
      samplingInterval: 500,
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
      supportedDataTypes: ['int16', 'int32', 'int64', 'uint16', 'uint32', 'uint64', 'float', 'double', 'boolean', 'string', 'datetime'],
    };
  }
}
