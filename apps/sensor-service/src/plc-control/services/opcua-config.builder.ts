import { PlcConnection } from '../entities/plc-connection.entity';
import { OpcUaConfiguration } from '../../protocol/adapters/industrial/opcua.adapter';

/**
 * Build OPC UA configuration from a PlcConnection entity.
 *
 * Shared between PlcConnectionService and FeedingParameterService
 * to avoid duplication.
 */
export function buildOpcUaConfig(connection: PlcConnection): OpcUaConfiguration {
  return {
    endpointUrl: connection.endpointUrl,
    securityMode: connection.securityMode as OpcUaConfiguration['securityMode'],
    securityPolicy: (connection.securityPolicy || 'None') as OpcUaConfiguration['securityPolicy'],
    authMode: connection.authMode as OpcUaConfiguration['authMode'],
    username: connection.username,
    password: connection.password,
    clientCertificate: connection.clientCertificate ?? undefined,
    clientPrivateKey: connection.clientPrivateKey ?? undefined,
    serverCertificate: connection.serverCertificate ?? undefined,
    sessionTimeout: connection.sessionTimeoutMs,
    publishingInterval: connection.publishingIntervalMs,
    samplingInterval: connection.samplingIntervalMs,
    nodeIds: [
      connection.telemetryNodeId,
      connection.parametersNodeId,
      connection.alarmsNodeId,
      connection.statusNodeId,
    ].filter((id): id is string => !!id),
    requestedSessionTimeout: connection.sessionTimeoutMs,
    secureChannelLifetime: 300000,
    connectTimeoutMs: connection.connectTimeoutMs,
    requestTimeoutMs: connection.requestTimeoutMs,
    autoReconnect: connection.autoReconnect,
    maxReconnectAttempts: connection.maxReconnectAttempts,
    reconnectDelayMs: connection.reconnectDelayMs,
    maxReconnectDelayMs: connection.maxReconnectDelayMs,
    keepAliveIntervalMs: connection.keepAliveIntervalMs,
    failoverEndpointUrl: connection.failoverEndpointUrl ?? undefined,
  };
}
