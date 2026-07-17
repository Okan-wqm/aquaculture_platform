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

export interface DiscoveredEndpoint {
  endpointUrl: string;
  securityMode: string;
  securityPolicy: string;
  securityLevel: number;
  serverCertificate?: string;
  transportProfileUri?: string;
}

export interface NodeBrowseResult {
  nodeId: string;
  browseName: string;
  displayName: string;
  nodeClass: string;
  dataType?: string;
  hasChildren: boolean;
  description?: string;
  value?: string;
}

export interface OpcUaConfiguration {
  sensorId?: string;
  tenantId?: string;
  endpointUrl: string;
  securityMode: 'None' | 'Sign' | 'SignAndEncrypt';
  securityPolicy: 'None' | 'Basic256Sha256' | 'Aes128_Sha256_RsaOaep' | 'Aes256_Sha256_RsPss';
  authMode: 'Anonymous' | 'Username' | 'Certificate';
  username?: string;
  password?: string;
  clientCertPath?: string;
  clientKeyPath?: string;
  serverCertPath?: string;
  clientCertificate?: string;  // PEM string
  clientPrivateKey?: string;   // PEM string
  serverCertificate?: string;  // PEM string
  sessionTimeout: number;
  publishingInterval: number;
  samplingInterval: number;
  nodeIds: string[];
  // Advanced
  requestedSessionTimeout: number;
  secureChannelLifetime: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  autoReconnect?: boolean;
  maxReconnectAttempts?: number;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  keepAliveIntervalMs?: number;
  failoverEndpointUrl?: string;
}

interface OpcUaSessionData {
  client: OpcUaClient;
  session: OpcUaSession;
  config: OpcUaConfiguration;
}

interface OpcUaClient {
  [key: string]: unknown;
  connect: (url: string) => Promise<void>;
  disconnect: () => Promise<void>;
  createSession: (userIdentity: OpcUaUserIdentity) => Promise<OpcUaSession>;
  getEndpoints: () => Promise<OpcUaEndpointDescription[]>;
}

interface OpcUaEndpointDescription {
  endpointUrl?: string;
  securityMode?: number;
  securityPolicyUri?: string;
  securityLevel?: number;
  serverCertificate?: Buffer;
  transportProfileUri?: string;
}

interface OpcUaSession {
  [key: string]: unknown;
  close: () => Promise<void>;
  read: (params: { nodeId: string }) => Promise<OpcUaDataValue>;
  browse: (params: {
    nodeId: string;
    referenceTypeId: unknown;
    includeSubtypes: boolean;
    resultMask: number;
  }) => Promise<{ references: OpcUaBrowseReference[] }>;
  write: (params: {
    nodeId: string;
    attributeId: number;
    value: { value: unknown };
  }) => Promise<{ value: number; toString: () => string }>;
  performMessageTransaction: (request: unknown) => Promise<{
    results?: Array<{ historyData?: { dataValues?: OpcUaHistoricalDataValue[] } }>;
  }>;
  call: (params: {
    objectId: string;
    methodId: string;
    inputArguments: unknown[];
  }) => Promise<{ statusCode?: { value: number }; outputArguments?: Array<{ value: unknown }> }>;
}

interface OpcUaBrowseReference {
  nodeId: { toString: () => string };
  browseName: { toString: () => string };
  displayName?: { text?: string };
  nodeClass: number;
  description?: { text?: string };
}

interface OpcUaHistoricalDataValue {
  sourceTimestamp?: Date;
  serverTimestamp?: Date;
  value?: { value?: unknown };
}

interface OpcUaDataValue {
  [key: string]: unknown;
  value?: { value?: unknown; dataType?: unknown };
}

interface OpcUaUserIdentity {
  type: number;
  userName?: string;
  password?: string;
  certificateData?: Buffer;
  privateKey?: Buffer;
}

interface OpcUaMonitoredItem {
  on: (event: string, callback: (dataValue: OpcUaDataValue) => void) => void;
}

interface OpcUaSubscription {
  [key: string]: unknown;
  monitor: (
    params: { nodeId: string; attributeId: number },
    options: { samplingInterval: number; discardOldest: boolean; queueSize: number },
    timestampsToReturn: number
  ) => Promise<OpcUaMonitoredItem>;
  terminate: () => Promise<void>;
}

@Injectable()
export class OpcUaAdapter extends BaseProtocolAdapter<OpcUaConfiguration> {
  readonly protocolCode = 'OPC_UA';
  readonly category = ProtocolCategory.INDUSTRIAL;
  readonly subcategory = ProtocolSubcategory.ETHERNET_INDUSTRIAL;
  readonly connectionType = ConnectionType.TCP;
  readonly displayName = 'OPC UA';
  readonly description = 'OPC Unified Architecture - Industrial interoperability standard';

  private sessions = new Map<string, OpcUaSessionData>();

  async connect(config: OpcUaConfiguration): Promise<ConnectionHandle> {
    const opcConfig = config;

    // Dynamic import node-opcua
    const {
      OPCUAClient,
      SecurityPolicy,
      MessageSecurityMode,
      UserTokenType,
    } = await import('node-opcua');

    const securityModeMap = {
      'None': MessageSecurityMode.None,
      'Sign': MessageSecurityMode.Sign,
      'SignAndEncrypt': MessageSecurityMode.SignAndEncrypt,
    } as const;

    const securityPolicyMap = {
      'None': SecurityPolicy.None,
      'Basic256Sha256': SecurityPolicy.Basic256Sha256,
      'Aes128_Sha256_RsaOaep': SecurityPolicy.Aes128_Sha256_RsaOaep,
      'Aes256_Sha256_RsPss': SecurityPolicy.Aes256_Sha256_RsaPss,
    } as const;

    const client = OPCUAClient.create({
      endpointMustExist: false,
      securityMode: securityModeMap[opcConfig.securityMode] ?? MessageSecurityMode.None,
      securityPolicy: securityPolicyMap[opcConfig.securityPolicy] ?? SecurityPolicy.None,
      requestedSessionTimeout: opcConfig.requestedSessionTimeout || 60000,
      connectionStrategy: {
        maxRetry: opcConfig.maxReconnectAttempts ?? -1,
        initialDelay: opcConfig.reconnectDelayMs ?? 1000,
        maxDelay: opcConfig.maxReconnectDelayMs ?? 30000,
      },
      keepAliveInterval: opcConfig.keepAliveIntervalMs ?? 5000,
      ...(opcConfig.clientCertificate ? {
        certificateFile: undefined,
        certificatePEM: opcConfig.clientCertificate,
        privateKeyPEM: opcConfig.clientPrivateKey,
      } : {}),
    } as Parameters<typeof OPCUAClient.create>[0]) as unknown as OpcUaClient;

    // SENSOR-HIGH-075: the endpoint URL is operator-supplied. Extract and
    // validate its host before connecting (dial the original endpoint to
    // preserve OPC UA endpoint/security semantics) so it cannot target
    // metadata/loopback/RFC-1918 internal hosts.
    const endpointMatch = /^opc\.tcp:\/\/([^:/]+)(?::(\d+))?/i.exec(opcConfig.endpointUrl ?? '');
    const opcHost = endpointMatch?.[1];
    if (!opcHost) {
      throw new Error('Connection failed');
    }
    const opcPort = endpointMatch?.[2] ? Number(endpointMatch[2]) : 4840;
    await this.assertOutboundHostAllowed(opcHost, opcPort);

    await client.connect(opcConfig.endpointUrl);

    let userIdentity: OpcUaUserIdentity = { type: UserTokenType.Anonymous as number };
    if (opcConfig.authMode === 'Username' && opcConfig.username) {
      userIdentity = {
        type: UserTokenType.UserName as number,
        userName: opcConfig.username,
        password: opcConfig.password,
      };
    } else if (opcConfig.authMode === 'Certificate' && opcConfig.clientCertificate) {
      userIdentity = {
        type: UserTokenType.Certificate as number,
        certificateData: Buffer.from(opcConfig.clientCertificate, 'utf-8'),
        privateKey: Buffer.from(opcConfig.clientPrivateKey || '', 'utf-8'),
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

  async testConnection(config: OpcUaConfiguration): Promise<ConnectionTestResult> {
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
        values[nodeName] = (dataValue.value?.value ?? null) as number | string | boolean | null;
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

    const subscription = ClientSubscription.create(session as unknown as Parameters<typeof ClientSubscription.create>[0], {
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
            values: { [nodeName]: (dataValue.value?.value ?? null) as number | string | boolean | null },
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

  async discoverEndpoints(endpointUrl: string): Promise<DiscoveredEndpoint[]> {
    const { OPCUAClient } = await import('node-opcua');

    const client = OPCUAClient.create({
      endpointMustExist: false,
    } as Parameters<typeof OPCUAClient.create>[0]) as unknown as OpcUaClient;

    try {
      await client.connect(endpointUrl);
      const endpoints = await client.getEndpoints();

      return (endpoints || []).map((ep: OpcUaEndpointDescription) => ({
        endpointUrl: ep.endpointUrl || endpointUrl,
        securityMode: this.reverseSecurityMode(ep.securityMode ?? 0),
        securityPolicy: this.reverseSecurityPolicy(ep.securityPolicyUri ?? ''),
        securityLevel: ep.securityLevel || 0,
        serverCertificate: ep.serverCertificate ? Buffer.from(ep.serverCertificate).toString('base64') : undefined,
        transportProfileUri: ep.transportProfileUri,
      }));
    } finally {
      try { await client.disconnect(); } catch { /* ignore */ }
    }
  }

  async browseNodes(handle: ConnectionHandle, parentNodeId?: string): Promise<NodeBrowseResult[]> {
    const sessionData = this.sessions.get(handle.id);
    if (!sessionData) throw new Error('Session not found');

    const { ReferenceTypeIds, NodeClass } = await import('node-opcua');
    const { session } = sessionData;

    const nodeId = parentNodeId || 'RootFolder';
    const browseResult = await session.browse({
      nodeId,
      referenceTypeId: ReferenceTypeIds.HierarchicalReferences,
      includeSubtypes: true,
      resultMask: 63, // all fields
    });

    const results: NodeBrowseResult[] = [];
    for (const ref of (browseResult.references || [])) {
      const nodeClassStr = this.nodeClassToString(ref.nodeClass);
      let dataType: string | undefined;
      let value: string | undefined;

      // Read data type for Variable nodes
      if (ref.nodeClass === NodeClass.Variable) {
        try {
          const dv = await session.read({ nodeId: ref.nodeId.toString() });
          value = dv.value?.value !== undefined ? String(dv.value.value) : undefined;
          dataType = dv.value?.dataType !== undefined ? String(dv.value.dataType) : undefined;
        } catch { /* ignore read errors */ }
      }

      results.push({
        nodeId: ref.nodeId.toString(),
        browseName: ref.browseName.toString(),
        displayName: ref.displayName?.text || ref.browseName.toString(),
        nodeClass: nodeClassStr,
        dataType,
        hasChildren: ref.nodeClass === NodeClass.Object || ref.nodeClass === 1,
        description: ref.description?.text,
        value,
      });
    }

    return results;
  }

  async writeData(handle: ConnectionHandle, nodeId: string, value: unknown, dataType?: string): Promise<void> {
    const sessionData = this.sessions.get(handle.id);
    if (!sessionData) throw new Error('Session not found');

    const { DataType, Variant } = await import('node-opcua');
    const { session } = sessionData;

    const dataTypeEnum = dataType && dataType in DataType
      ? DataType[dataType as keyof typeof DataType]
      : DataType.Float;

    const statusCode = await session.write({
      nodeId,
      attributeId: 13, // AttributeIds.Value
      value: {
        value: new Variant({ dataType: dataTypeEnum, value }),
      },
    });

    if (statusCode && statusCode.value !== 0) {
      throw new Error(`Write failed with status: ${statusCode.toString()}`);
    }
  }

  async readHistoricalData(
    handle: ConnectionHandle,
    nodeId: string,
    startTime: Date,
    endTime: Date,
    maxValues?: number
  ): Promise<{ timestamp: Date; value: unknown }[]> {
    const sessionData = this.sessions.get(handle.id);
    if (!sessionData) throw new Error('Session not found');

    const { ReadRawModifiedDetails, HistoryReadRequest, TimestampsToReturn } = await import('node-opcua');
    const { session } = sessionData;

    const details = new ReadRawModifiedDetails({
      startTime,
      endTime,
      numValuesPerNode: maxValues || 1000,
      isReadModified: false,
      returnBounds: false,
    });

    const result = await session.performMessageTransaction(
      new HistoryReadRequest({
        historyReadDetails: details,
        timestampsToReturn: TimestampsToReturn.Both,
        nodesToRead: [{ nodeId }],
      })
    );

    const historyData = result?.results?.[0]?.historyData?.dataValues || [];
    return historyData.map((dv: OpcUaHistoricalDataValue) => ({
      timestamp: dv.sourceTimestamp || dv.serverTimestamp || new Date(),
      value: dv.value?.value,
    }));
  }

  async callMethod(
    handle: ConnectionHandle,
    objectId: string,
    methodId: string,
    inputArguments?: { dataType: string; value: unknown }[]
  ): Promise<{ statusCode: number; outputArguments: unknown[] }> {
    const sessionData = this.sessions.get(handle.id);
    if (!sessionData) throw new Error('Session not found');

    const { DataType, Variant } = await import('node-opcua');
    const { session } = sessionData;

    const args = (inputArguments || []).map(arg => {
      const dt = arg.dataType in DataType
        ? DataType[arg.dataType as keyof typeof DataType]
        : DataType.String;
      return new Variant({ dataType: dt, value: arg.value });
    });

    const result = await session.call({
      objectId,
      methodId,
      inputArguments: args,
    });

    return {
      statusCode: result.statusCode?.value || 0,
      outputArguments: (result.outputArguments || []).map((v: { value: unknown }) => v.value),
    };
  }

  private reverseSecurityMode(mode: number): string {
    switch (mode) {
      case 1: return 'None';
      case 2: return 'Sign';
      case 3: return 'SignAndEncrypt';
      default: return 'None';
    }
  }

  private reverseSecurityPolicy(uri?: string): string {
    if (!uri) return 'None';
    if (uri.includes('Basic256Sha256')) return 'Basic256Sha256';
    if (uri.includes('Aes128_Sha256_RsaOaep')) return 'Aes128_Sha256_RsaOaep';
    if (uri.includes('Aes256_Sha256_RsPss')) return 'Aes256_Sha256_RsPss';
    return 'None';
  }

  private nodeClassToString(nodeClass: number): string {
    const map: Record<number, string> = {
      1: 'Object', 2: 'Variable', 4: 'Method', 8: 'ObjectType',
      16: 'VariableType', 32: 'ReferenceType', 64: 'DataType', 128: 'View',
    };
    return map[nodeClass] || 'Unknown';
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
          enum: ['None', 'Basic256Sha256', 'Aes128_Sha256_RsaOaep', 'Aes256_Sha256_RsPss'],
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
        clientCertificate: {
          type: 'string',
          title: 'Client Certificate (PEM)',
          description: 'PEM-encoded client certificate for Certificate authentication',
          'ui:widget': 'textarea',
          'ui:order': 11,
          'ui:group': 'certificates',
        },
        clientPrivateKey: {
          type: 'string',
          title: 'Client Private Key (PEM)',
          description: 'PEM-encoded private key for Certificate authentication',
          'ui:widget': 'textarea',
          'ui:order': 12,
          'ui:group': 'certificates',
        },
        serverCertificate: {
          type: 'string',
          title: 'Server Certificate (PEM)',
          description: 'PEM-encoded server certificate for trust validation',
          'ui:widget': 'textarea',
          'ui:order': 13,
          'ui:group': 'certificates',
        },
        connectTimeoutMs: {
          type: 'integer',
          title: 'Connect Timeout (ms)',
          default: 10000,
          'ui:order': 14,
          'ui:group': 'reconnection',
        },
        requestTimeoutMs: {
          type: 'integer',
          title: 'Request Timeout (ms)',
          default: 60000,
          'ui:order': 15,
          'ui:group': 'reconnection',
        },
        autoReconnect: {
          type: 'boolean',
          title: 'Auto Reconnect',
          default: true,
          'ui:order': 16,
          'ui:group': 'reconnection',
        },
        maxReconnectAttempts: {
          type: 'integer',
          title: 'Max Reconnect Attempts',
          description: '-1 for unlimited',
          default: -1,
          'ui:order': 17,
          'ui:group': 'reconnection',
        },
        reconnectDelayMs: {
          type: 'integer',
          title: 'Reconnect Delay (ms)',
          default: 1000,
          'ui:order': 18,
          'ui:group': 'reconnection',
        },
        maxReconnectDelayMs: {
          type: 'integer',
          title: 'Max Reconnect Delay (ms)',
          default: 30000,
          'ui:order': 19,
          'ui:group': 'reconnection',
        },
        keepAliveIntervalMs: {
          type: 'integer',
          title: 'Keep Alive Interval (ms)',
          default: 5000,
          'ui:order': 20,
          'ui:group': 'reconnection',
        },
        failoverEndpointUrl: {
          type: 'string',
          title: 'Failover Endpoint URL',
          description: 'Secondary OPC UA server endpoint for failover',
          'ui:placeholder': 'opc.tcp://backup-server:4840',
          'ui:order': 21,
          'ui:group': 'reconnection',
        },
      },
      'ui:groups': [
        { name: 'connection', title: 'Connection', fields: ['endpointUrl'] },
        { name: 'security', title: 'Security', fields: ['securityMode', 'securityPolicy'] },
        { name: 'authentication', title: 'Authentication', fields: ['authMode', 'username', 'password'] },
        { name: 'certificates', title: 'Certificates', fields: ['clientCertificate', 'clientPrivateKey', 'serverCertificate'] },
        { name: 'nodes', title: 'Nodes', fields: ['nodeIds'] },
        { name: 'advanced', title: 'Advanced', fields: ['sessionTimeout', 'publishingInterval', 'samplingInterval'] },
        { name: 'reconnection', title: 'Reconnection', fields: ['connectTimeoutMs', 'requestTimeoutMs', 'autoReconnect', 'maxReconnectAttempts', 'reconnectDelayMs', 'maxReconnectDelayMs', 'keepAliveIntervalMs', 'failoverEndpointUrl'] },
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
      supportsHistoricalData: true,
      supportsMethodCall: true,
      supportsWriting: true,
      supportedDataTypes: ['int16', 'int32', 'int64', 'uint16', 'uint32', 'uint64', 'float', 'double', 'boolean', 'string', 'datetime'],
    };
  }
}
