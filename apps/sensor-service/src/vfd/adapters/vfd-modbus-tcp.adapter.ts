import * as net from 'net';
import * as tls from 'tls';
import { Injectable } from '@nestjs/common';
import { SsrfValidatorService } from '@aquaculture/backend-common/ai-safety';

import { VfdParameters, VfdStatusBits } from '../entities/vfd-reading.entity';
import { VfdRegisterMapping } from '../entities/vfd-register-mapping.entity';
import { VfdProtocol, VfdDataType, ByteOrder } from '../entities/vfd.enums';

import {
  BaseVfdAdapter,
  VfdConnectionHandle,
  VfdReadResult,
  VfdCommandResult,
  ConnectionTestResult,
  ValidationResult,
} from './base-vfd.adapter';

/**
 * Modbus TCP Configuration
 */
export interface ModbusTcpConfig {
  host: string;
  port: number;
  unitId: number;
  connectionTimeout: number;
  responseTimeout: number;
  keepAlive: boolean;
  reconnectInterval: number;
  /**
   * SVD-HIGH-003: when true, the Modbus-TCP link is tunneled over TLS
   * (Modbus/TCP Security, port 802) instead of plaintext. Required in
   * environments where the OT segment is not physically isolated per
   * IEC 62443 FR5. `tlsRejectUnauthorized` defaults to true; `tlsCaCert`
   * supplies a private-CA bundle for the drive/gateway certificate.
   */
  tls?: boolean;
  tlsRejectUnauthorized?: boolean;
  tlsCaCert?: string;
}

/**
 * Modbus TCP Connection Handle
 */
interface ModbusTcpConnectionHandle extends VfdConnectionHandle {
  config: ModbusTcpConfig;
  socket: net.Socket | null;
  transactionId: number;
}

/**
 * VFD Modbus TCP Protocol Adapter
 *
 * Implements real Modbus TCP communication using Node.js `net` module.
 * Builds MBAP-framed PDUs, sends them over a persistent TCP socket,
 * and parses the response. Each readRegister / writeRegister call
 * uses the shared socket stored in the connection handle.
 */
@Injectable()
export class VfdModbusTcpAdapter extends BaseVfdAdapter {
  readonly protocolCode = VfdProtocol.MODBUS_TCP;
  readonly protocolName = 'Modbus TCP';

  // Active connections map
  private connections: Map<string, ModbusTcpConnectionHandle> = new Map();

  /**
   * SVD-HIGH-001: instantiated directly (not injected) — VFD adapters are
   * created via `new AdapterClass()` outside the Nest DI container
   * (see createVfdAdapter), and SsrfValidatorService is dependency-free, so a
   * field initializer keeps the pre-connect host guard present unconditionally.
   */
  private readonly ssrfValidator = new SsrfValidatorService();

  constructor() {
    super('VfdModbusTcpAdapter');
  }

  async connect(config: Record<string, unknown>): Promise<VfdConnectionHandle> {
    const validatedConfig = this.validateAndCastConfig(config);
    const connectionId = this.generateConnectionId();

    try {
      this.logger.log(`Connecting to VFD via Modbus TCP at ${validatedConfig.host}:${validatedConfig.port}`);

      const socket = await this.openSocket(
        validatedConfig.host,
        validatedConfig.port,
        validatedConfig.connectionTimeout,
        validatedConfig.keepAlive,
        validatedConfig,
      );

      const handle: ModbusTcpConnectionHandle = {
        id: connectionId,
        protocol: VfdProtocol.MODBUS_TCP,
        isConnected: true,
        lastActivity: new Date(),
        config: validatedConfig,
        socket,
        transactionId: 0,
        metadata: {
          host: validatedConfig.host,
          port: validatedConfig.port,
          unitId: validatedConfig.unitId,
        },
      };

      // Mark connection as closed when the socket disconnects
      socket.once('close', () => {
        handle.isConnected = false;
        this.logger.warn(`Socket closed for VFD connection ${connectionId}`);
      });
      socket.once('error', (err) => {
        handle.isConnected = false;
        this.logError(`Socket error on VFD connection ${connectionId}`, err);
      });

      this.connections.set(connectionId, handle);
      this.logger.log(`Connected to VFD at ${validatedConfig.host}:${validatedConfig.port}, ID: ${connectionId}`);

      return handle;
    } catch (error) {
      this.logError('Failed to connect via Modbus TCP', error as Error);
      throw error;
    }
  }

  async disconnect(handle: VfdConnectionHandle): Promise<void> {
    const connection = this.connections.get(handle.id);
    if (!connection) {
      this.logger.warn(`Connection ${handle.id} not found`);
      return;
    }

    try {
      if (connection.socket) {
        await new Promise<void>((resolve) => {
          connection.socket!.end(() => resolve());
        });
        connection.socket.destroy();
      }
      connection.isConnected = false;
      this.connections.delete(handle.id);
      this.logger.log(`Disconnected from VFD, ID: ${handle.id}`);
    } catch (error) {
      this.logError('Error disconnecting', error as Error);
      throw error;
    }
  }

  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> {
    const startTime = Date.now();
    let handle: VfdConnectionHandle | null = null;

    try {
      this.validateAndCastConfig(config);
      handle = await this.connect(config);

      // Try to read a basic status register
      const testBuffer = await this.readRegister(handle, 0, 1, 3);
      const latencyMs = Date.now() - startTime;

      return {
        success: true,
        latencyMs,
        sampleData: {
          statusWord: testBuffer.readUInt16BE(0),
        },
      };
    } catch (error) {
      return {
        success: false,
        latencyMs: Date.now() - startTime,
        error: (error as Error).message,
      };
    } finally {
      // LOW-005: Always clean up the test connection, even on error,
      // to prevent stale handles accumulating in this.connections.
      if (handle) {
        try {
          await this.disconnect(handle);
        } catch {
          // Force-remove from map even if disconnect() throws
          this.connections.delete(handle.id);
        }
      }
    }
  }

  async readParameters(
    handle: VfdConnectionHandle,
    registerMappings: VfdRegisterMapping[]
  ): Promise<VfdReadResult> {
    const startTime = Date.now();
    const connection = this.connections.get(handle.id) as ModbusTcpConnectionHandle;

    if (!connection?.isConnected) {
      throw new Error('Connection not established');
    }

    const parameters: VfdParameters = {};
    const rawValues: Record<string, number> = {};
    let statusBits: VfdStatusBits = {};
    const errors: string[] = [];

    // Group registers for efficient batch reading
    const batches = this.groupRegistersForBatchRead(registerMappings);

    for (const batch of batches) {
      try {
        const buffer = await this.readRegister(
          handle,
          batch.startAddress,
          batch.count,
          batch.functionCode
        );

        // Extract individual values from batch buffer
        for (const mapping of registerMappings) {
          if (
            mapping.registerAddress >= batch.startAddress &&
            mapping.registerAddress < batch.startAddress + batch.count
          ) {
            try {
              const valueBuffer = this.extractValueFromBuffer(
                buffer,
                batch.startAddress,
                mapping
              );

              const rawValue = this.parseRawValue(
                valueBuffer,
                mapping.dataType as VfdDataType,
                mapping.byteOrder as ByteOrder,
                mapping.wordOrder as ByteOrder
              );

              rawValues[mapping.parameterName] = rawValue;

              const scaledValue = this.applyScaling(
                rawValue,
                mapping.scalingFactor,
                mapping.offset
              );

              const stdParamName = this.mapParameterName(mapping.parameterName);
              if (stdParamName) {
                parameters[stdParamName] = scaledValue;
              } else {
                parameters[mapping.parameterName] = scaledValue;
              }

              if (
                mapping.dataType === VfdDataType.STATUS_WORD ||
                mapping.parameterName.includes('status')
              ) {
                statusBits = this.parseStatusWord(rawValue, mapping.bitDefinitions ?? undefined);
              }
            } catch (err) {
              errors.push(`Failed to parse ${mapping.parameterName}: ${(err as Error).message}`);
            }
          }
        }
      } catch (err) {
        errors.push(`Batch read failed at ${batch.startAddress}: ${(err as Error).message}`);
      }
    }

    connection.lastActivity = new Date();

    return {
      parameters,
      statusBits,
      rawValues,
      timestamp: new Date(),
      latencyMs: Date.now() - startTime,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  async readRegister(
    handle: VfdConnectionHandle,
    address: number,
    count: number,
    functionCode: number
  ): Promise<Buffer> {
    const connection = this.connections.get(handle.id) as ModbusTcpConnectionHandle;

    if (!connection?.isConnected || !connection.socket) {
      throw new Error('Connection not established');
    }

    // Increment transaction ID
    connection.transactionId = (connection.transactionId + 1) & 0xffff;
    const txId = connection.transactionId;

    const request = this.buildModbusTcpRequest(
      txId,
      connection.config.unitId,
      functionCode,
      address,
      count
    );

    this.logDebug(`Reading ${count} registers from address ${address}`, {
      transactionId: txId,
      unitId: connection.config.unitId,
    });

    // Send request and await response
    const responseData = await this.sendAndReceive(
      connection.socket,
      request,
      txId,
      connection.config.responseTimeout,
    );

    connection.lastActivity = new Date();
    return responseData;
  }

  async writeControlWord(
    handle: VfdConnectionHandle,
    controlWord: number,
    registerAddress: number
  ): Promise<VfdCommandResult> {
    return this.writeRegister(handle, registerAddress, controlWord);
  }

  async writeSpeedReference(
    handle: VfdConnectionHandle,
    value: number,
    registerAddress: number,
    scalingFactor: number
  ): Promise<VfdCommandResult> {
    const rawValue = this.reverseScaling(value, scalingFactor);
    return this.writeRegister(handle, registerAddress, rawValue);
  }

  async writeRegister(
    handle: VfdConnectionHandle,
    address: number,
    value: number
  ): Promise<VfdCommandResult> {
    const startTime = Date.now();
    const connection = this.connections.get(handle.id) as ModbusTcpConnectionHandle;

    if (!connection?.isConnected || !connection.socket) {
      return {
        success: false,
        error: 'Connection not established',
      };
    }

    try {
      connection.transactionId = (connection.transactionId + 1) & 0xffff;
      const txId = connection.transactionId;

      const request = this.buildModbusTcpWriteRequest(
        txId,
        connection.config.unitId,
        6, // FC06: Write Single Register
        address,
        value
      );

      this.logDebug(`Writing value ${value} to address ${address}`, {
        transactionId: txId,
        unitId: connection.config.unitId,
      });

      // Send write request and await acknowledgement
      await this.sendAndReceive(
        connection.socket,
        request,
        txId,
        connection.config.responseTimeout,
      );

      connection.lastActivity = new Date();

      return {
        success: true,
        acknowledgedAt: new Date(),
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
        latencyMs: Date.now() - startTime,
      };
    }
  }

  validateConfiguration(config: unknown): ValidationResult {
    const errors: string[] = [];

    if (!config || typeof config !== 'object') {
      return { valid: false, errors: ['Configuration must be an object'] };
    }

    const cfg = config as Record<string, unknown>;

    // Required fields
    if (!cfg['host'] || typeof cfg['host'] !== 'string') {
      errors.push('host is required and must be a string');
    } else {
      // Basic IP/hostname validation
      const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
      const hostnameRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9](?:\.[a-zA-Z]{2,})+$/;
      if (!ipRegex.test(cfg['host']) && !hostnameRegex.test(cfg['host']) && cfg['host'] !== 'localhost') {
        errors.push('host must be a valid IP address or hostname');
      }
    }

    if (cfg['port'] !== undefined) {
      if (typeof cfg['port'] !== 'number' || cfg['port'] < 1 || cfg['port'] > 65535) {
        errors.push('port must be between 1 and 65535');
      }
    }

    if (cfg['unitId'] !== undefined) {
      if (typeof cfg['unitId'] !== 'number' || cfg['unitId'] < 0 || cfg['unitId'] > 255) {
        errors.push('unitId must be between 0 and 255');
      }
    }

    if (cfg['connectionTimeout'] !== undefined) {
      if (typeof cfg['connectionTimeout'] !== 'number' || cfg['connectionTimeout'] < 100 || cfg['connectionTimeout'] > 60000) {
        errors.push('connectionTimeout must be between 100 and 60000 ms');
      }
    }

    if (cfg['responseTimeout'] !== undefined) {
      if (typeof cfg['responseTimeout'] !== 'number' || cfg['responseTimeout'] < 100 || cfg['responseTimeout'] > 30000) {
        errors.push('responseTimeout must be between 100 and 30000 ms');
      }
    }

    return { valid: errors.length === 0, errors };
  }

  getConfigurationSchema(): Record<string, unknown> {
    return {
      type: 'object',
      required: ['host'],
      properties: {
        host: {
          type: 'string',
          title: 'Host',
          description: 'IP address or hostname of the VFD',
          examples: ['192.168.1.100', 'vfd-1.local'],
        },
        port: {
          type: 'integer',
          title: 'Port',
          description: 'Modbus TCP port',
          minimum: 1,
          maximum: 65535,
          default: 502,
        },
        unitId: {
          type: 'integer',
          title: 'Unit ID',
          description: 'Modbus unit identifier (0-255)',
          minimum: 0,
          maximum: 255,
          default: 1,
        },
        connectionTimeout: {
          type: 'integer',
          title: 'Connection Timeout (ms)',
          description: 'TCP connection timeout',
          minimum: 100,
          maximum: 60000,
          default: 5000,
        },
        responseTimeout: {
          type: 'integer',
          title: 'Response Timeout (ms)',
          description: 'Response timeout for each request',
          minimum: 100,
          maximum: 30000,
          default: 1000,
        },
        keepAlive: {
          type: 'boolean',
          title: 'Keep Alive',
          description: 'Enable TCP keep-alive',
          default: true,
        },
        reconnectInterval: {
          type: 'integer',
          title: 'Reconnect Interval (ms)',
          description: 'Interval between reconnection attempts',
          minimum: 1000,
          maximum: 300000,
          default: 5000,
        },
      },
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return {
      host: '',
      port: 502,
      unitId: 1,
      connectionTimeout: 5000,
      responseTimeout: 1000,
      keepAlive: true,
      reconnectInterval: 5000,
    };
  }

  // ============ PRIVATE METHODS ============

  private validateAndCastConfig(config: Record<string, unknown>): ModbusTcpConfig {
    const validation = this.validateConfiguration(config);
    if (!validation.valid) {
      throw new Error(`Invalid configuration: ${validation.errors.join(', ')}`);
    }

    return {
      host: config['host'] as string,
      port: (config['port'] as number) || 502,
      unitId: (config['unitId'] as number) ?? 1,
      connectionTimeout: (config['connectionTimeout'] as number) || 5000,
      responseTimeout: (config['responseTimeout'] as number) || 1000,
      keepAlive: (config['keepAlive'] as boolean) ?? true,
      reconnectInterval: (config['reconnectInterval'] as number) || 5000,
    };
  }

  private buildModbusTcpRequest(
    transactionId: number,
    unitId: number,
    functionCode: number,
    startAddress: number,
    quantity: number
  ): Buffer {
    // MBAP Header (7 bytes) + PDU (5 bytes)
    const request = Buffer.alloc(12);

    // MBAP Header
    request.writeUInt16BE(transactionId, 0);  // Transaction ID
    request.writeUInt16BE(0x0000, 2);          // Protocol ID (Modbus = 0)
    request.writeUInt16BE(6, 4);               // Length (remaining bytes)
    request.writeUInt8(unitId, 6);             // Unit ID

    // PDU
    request.writeUInt8(functionCode, 7);
    request.writeUInt16BE(startAddress, 8);
    request.writeUInt16BE(quantity, 10);

    return request;
  }

  private buildModbusTcpWriteRequest(
    transactionId: number,
    unitId: number,
    functionCode: number,
    address: number,
    value: number
  ): Buffer {
    const request = Buffer.alloc(12);

    // MBAP Header
    request.writeUInt16BE(transactionId, 0);
    request.writeUInt16BE(0x0000, 2);
    request.writeUInt16BE(6, 4);
    request.writeUInt8(unitId, 6);

    // PDU
    request.writeUInt8(functionCode, 7);
    request.writeUInt16BE(address, 8);
    request.writeUInt16BE(value, 10);

    return request;
  }

  /**
   * Open a TCP socket to the VFD and return it once connected.
   */
  private async openSocket(
    host: string,
    port: number,
    connectionTimeout: number,
    keepAlive: boolean,
    config?: ModbusTcpConfig,
  ): Promise<net.Socket> {
    // SVD-HIGH-001: `host` is operator-supplied at VFD registration. Resolve
    // and validate BEFORE opening the socket so it cannot target loopback,
    // RFC-1918, link-local, or cloud-metadata addresses (internal port-scan /
    // SSRF). DNS is pinned pre-connect and we connect to the resolved IP, not
    // the hostname, to close the rebinding window. Industrial ports are
    // allowed — the control is the IP denylist, not a port allowlist.
    const verdict = await this.ssrfValidator.validateHost(host, port);
    if (!verdict.safe || !verdict.resolvedIp) {
      // Oracle-suppression: return a single opaque failure regardless of the
      // specific reason so a caller cannot use error text to map the network.
      this.logger.warn(
        `Blocked unsafe VFD Modbus target ${host}:${port} — ${verdict.reason ?? 'unresolved'}`,
      );
      throw new Error('Connection failed');
    }
    const targetIp = verdict.resolvedIp;

    return new Promise((resolve, reject) => {
      // SVD-HIGH-003: use a TLS-tunneled socket when configured. The TLS
      // handshake validates the drive/gateway certificate (servername is the
      // original hostname for SNI/verification, while the connection targets
      // the pre-resolved IP to keep the SSRF pin).
      const socket = config?.tls
        ? tls.connect({
            host: targetIp,
            port,
            servername: host,
            rejectUnauthorized: config.tlsRejectUnauthorized ?? true,
            ca: config.tlsCaCert ? [config.tlsCaCert] : undefined,
          })
        : new net.Socket();

      socket.setNoDelay(true);
      if (keepAlive) {
        socket.setKeepAlive(true, 10000);
      }

      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('Connection failed'));
      }, connectionTimeout);

      socket.once('error', () => {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error('Connection failed'));
      });

      if (config?.tls) {
        // tls.connect already initiates the connection; wait for the
        // secure handshake to complete.
        (socket as tls.TLSSocket).once('secureConnect', () => {
          clearTimeout(timer);
          resolve(socket);
        });
      } else {
        (socket as net.Socket).connect(port, targetIp, () => {
          clearTimeout(timer);
          resolve(socket);
        });
      }
    });
  }

  /**
   * Send a Modbus TCP request frame and wait for the matching response.
   * Validates the MBAP transaction ID and returns only the register data bytes.
   */
  private sendAndReceive(
    socket: net.Socket,
    request: Buffer,
    txId: number,
    responseTimeout: number,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Response timeout after ${responseTimeout}ms (txId=${txId})`));
      }, responseTimeout);

      const onData = (data: Buffer) => {
        // A valid Modbus TCP response has at least 9 bytes:
        // 2 (txId) + 2 (proto) + 2 (length) + 1 (unitId) + 1 (fc) + 1 (byte count) + N*2 (data)
        if (data.length < 9) {
          cleanup();
          return reject(new Error('Modbus TCP response too short'));
        }

        const responseTxId = data.readUInt16BE(0);
        if (responseTxId !== txId) {
          // Not our frame — ignore and keep waiting
          return;
        }

        const functionCode = data[7];
        // Check for Modbus exception response (fc | 0x80)
        if (functionCode !== undefined && functionCode & 0x80) {
          const exceptionCode = data[8] ?? 0;
          cleanup();
          return reject(new Error(`Modbus exception response: fc=0x${(functionCode & 0x7f).toString(16)}, code=${exceptionCode}`));
        }

        // For read responses (FC01-FC04): byte 8 is data byte count, bytes 9..N are register values
        // For write responses (FC05, FC06): bytes 8-11 are echo of address+value
        const pduLength = data.readUInt16BE(4) - 1; // subtract unit ID byte
        if (data.length < 7 + pduLength) {
          cleanup();
          return reject(new Error('Modbus TCP response incomplete'));
        }

        // FC01/FC02: coil/discrete input — return raw PDU data starting after byte-count byte
        // FC03/FC04: holding/input registers — same
        // FC05/FC06: write echo — return empty buffer (success)
        const fc = functionCode ?? 0;
        if (fc === 0x05 || fc === 0x06) {
          cleanup();
          return resolve(Buffer.alloc(0));
        }

        // Read responses: byte index 8 = byte count, followed by register data
        const byteCount = data[8] ?? 0;
        const registerData = data.subarray(9, 9 + byteCount);
        cleanup();
        resolve(registerData);
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const cleanup = () => {
        clearTimeout(timer);
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);
      };

      socket.on('data', onData);
      socket.once('error', onError);
      socket.write(request);
    });
  }
}
