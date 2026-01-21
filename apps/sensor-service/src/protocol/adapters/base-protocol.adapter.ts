import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  ProtocolCategory,
  ProtocolSubcategory,
  ConnectionType,
  ProtocolConfigurationSchema,
} from '../../database/entities/sensor-protocol.entity';

/**
 * Connection handle representing an active connection to a sensor
 */
export interface ConnectionHandle {
  id: string;
  sensorId: string;
  tenantId: string;
  protocolCode: string;
  createdAt: Date;
  lastActivityAt: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Result of a connection test
 */
export interface ConnectionTestResult {
  success: boolean;
  latencyMs?: number;
  error?: string;
  errorCode?: string;
  sampleData?: SensorReadingData;
  diagnostics?: ConnectionDiagnostics;
}

/**
 * Detailed connection diagnostics
 */
export interface ConnectionDiagnostics {
  connectionTimeMs?: number;
  authenticationTimeMs?: number;
  firstResponseTimeMs?: number;
  totalMs?: number;
  signalStrength?: number;
  packetLoss?: number;
  firmwareVersion?: string;
  deviceInfo?: Record<string, unknown>;
  capabilities?: string[];
  warnings?: string[];
}

/**
 * Raw sensor reading data
 */
export interface SensorReadingData {
  timestamp: Date;
  values: Record<string, number | string | boolean | null>;
  quality?: number;
  source?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Configuration validation result
 */
export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings?: ValidationWarning[];
}

export interface ValidationError {
  field: string;
  message: string;
  code?: string;
}

export interface ValidationWarning {
  field: string;
  message: string;
}

/**
 * Subscription for streaming data
 */
export interface DataSubscription {
  id: string;
  unsubscribe: () => Promise<void>;
  isActive: () => boolean;
}

/**
 * Callback for receiving sensor data
 */
export type DataCallback = (data: SensorReadingData) => void;

/**
 * Error callback
 */
export type ErrorCallback = (error: Error) => void;

/**
 * Protocol adapter interface - all protocol adapters must implement this
 */
export interface ProtocolAdapter {
  /**
   * Unique protocol code (e.g., 'MQTT', 'MODBUS_TCP')
   */
  readonly protocolCode: string;

  /**
   * Protocol category
   */
  readonly category: ProtocolCategory;

  /**
   * Protocol subcategory for finer classification
   */
  readonly subcategory?: ProtocolSubcategory;

  /**
   * Connection type
   */
  readonly connectionType: ConnectionType;

  /**
   * Human-readable protocol name
   */
  readonly displayName: string;

  /**
   * Protocol description
   */
  readonly description?: string;

  /**
   * Connect to a sensor device
   * @param config Protocol-specific configuration
   * @returns Connection handle
   */
  connect(config: Record<string, unknown>): Promise<ConnectionHandle>;

  /**
   * Disconnect from a sensor device
   * @param handle Connection handle
   */
  disconnect(handle: ConnectionHandle): Promise<void>;

  /**
   * Check if a connection is still active
   * @param handle Connection handle
   */
  isConnected(handle: ConnectionHandle): boolean;

  /**
   * Test connection to a sensor device without establishing persistent connection
   * @param config Protocol-specific configuration
   * @returns Test result with diagnostics
   */
  testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult>;

  /**
   * Read data from a connected sensor
   * @param handle Connection handle
   * @returns Sensor reading data
   */
  readData(handle: ConnectionHandle): Promise<SensorReadingData>;

  /**
   * Subscribe to streaming data (if supported)
   * @param handle Connection handle
   * @param onData Callback for receiving data
   * @param onError Callback for errors
   * @returns Subscription handle
   */
  subscribeToData?(
    handle: ConnectionHandle,
    onData: DataCallback,
    onError?: ErrorCallback
  ): Promise<DataSubscription>;

  /**
   * Write data to a sensor (if supported)
   * @param handle Connection handle
   * @param data Data to write
   */
  writeData?(handle: ConnectionHandle, data: Record<string, unknown>): Promise<void>;

  /**
   * Validate protocol configuration
   * @param config Configuration to validate
   * @returns Validation result
   */
  validateConfiguration(config: unknown): ValidationResult;

  /**
   * Get the JSON Schema for protocol configuration
   * @returns JSON Schema object
   */
  getConfigurationSchema(): ProtocolConfigurationSchema;

  /**
   * Get default configuration values
   * @returns Default configuration object
   */
  getDefaultConfiguration(): Record<string, unknown>;

  /**
   * Get protocol capabilities
   */
  getCapabilities(): ProtocolCapabilities;

  /**
   * Discover available devices (if supported)
   * @param options Discovery options
   * @returns List of discovered devices
   */
  discoverDevices?(options?: DiscoveryOptions): Promise<DiscoveredDevice[]>;
}

/**
 * Protocol capabilities
 */
export interface ProtocolCapabilities {
  supportsDiscovery: boolean;
  supportsBidirectional: boolean;
  supportsPolling: boolean;
  supportsSubscription: boolean;
  supportsAuthentication: boolean;
  supportsEncryption: boolean;
  maxConnectionsPerInstance?: number;
  supportedDataTypes: string[];
  minimumPollingIntervalMs?: number;
}

/**
 * Discovery options
 */
export interface DiscoveryOptions {
  timeout?: number;
  network?: string;
  port?: number;
  broadcast?: boolean;
}

/**
 * Discovered device information
 */
export interface DiscoveredDevice {
  address: string;
  port?: number;
  name?: string;
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
  firmwareVersion?: string;
  capabilities?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Abstract base class for protocol adapters
 * Provides common functionality and utilities
 */
export abstract class BaseProtocolAdapter implements ProtocolAdapter {
  abstract readonly protocolCode: string;
  abstract readonly category: ProtocolCategory;
  abstract readonly subcategory?: ProtocolSubcategory;
  abstract readonly connectionType: ConnectionType;
  abstract readonly displayName: string;
  abstract readonly description?: string;

  protected readonly logger: Logger;
  protected readonly connections = new Map<string, ConnectionHandle>();

  constructor(protected readonly configService?: ConfigService) {
    this.logger = new Logger(this.constructor.name);
  }

  abstract connect(config: Record<string, unknown>): Promise<ConnectionHandle>;
  abstract disconnect(handle: ConnectionHandle): Promise<void>;
  abstract testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult>;
  abstract readData(handle: ConnectionHandle): Promise<SensorReadingData>;
  abstract validateConfiguration(config: unknown): ValidationResult;
  abstract getConfigurationSchema(): ProtocolConfigurationSchema;
  abstract getDefaultConfiguration(): Record<string, unknown>;
  abstract getCapabilities(): ProtocolCapabilities;

  isConnected(handle: ConnectionHandle): boolean {
    return this.connections.has(handle.id);
  }

  /**
   * Generate a unique connection ID
   */
  protected generateConnectionId(): string {
    return `${this.protocolCode}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Create a connection handle
   */
  protected createConnectionHandle(
    sensorId: string,
    tenantId: string,
    metadata?: Record<string, unknown>
  ): ConnectionHandle {
    const handle: ConnectionHandle = {
      id: this.generateConnectionId(),
      sensorId,
      tenantId,
      protocolCode: this.protocolCode,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata,
    };
    this.connections.set(handle.id, handle);
    return handle;
  }

  /**
   * Remove a connection handle
   */
  protected removeConnectionHandle(id: string): void {
    this.connections.delete(id);
  }

  /**
   * Update last activity time
   */
  protected updateLastActivity(handle: ConnectionHandle): void {
    handle.lastActivityAt = new Date();
  }

  /**
   * Execute with timeout
   */
  protected async withTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
    errorMessage: string
  ): Promise<T> {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`${errorMessage} (timeout: ${timeoutMs}ms)`)), timeoutMs);
    });
    return Promise.race([operation, timeout]);
  }

  /**
   * Measure execution time
   */
  protected async measureLatency<T>(
    operation: () => Promise<T>
  ): Promise<{ result: T; latencyMs: number }> {
    const start = Date.now();
    const result = await operation();
    const latencyMs = Date.now() - start;
    return { result, latencyMs };
  }

  /**
   * Create a validation error
   */
  protected validationError(field: string, message: string, code?: string): ValidationError {
    return { field, message, code };
  }

  /**
   * Create a validation warning
   */
  protected validationWarning(field: string, message: string): ValidationWarning {
    return { field, message };
  }

  /**
   * Validate required fields
   */
  protected validateRequiredFields(
    config: Record<string, unknown>,
    requiredFields: string[]
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    for (const field of requiredFields) {
      if (config[field] === undefined || config[field] === null || config[field] === '') {
        errors.push(this.validationError(field, `${field} is required`, 'REQUIRED'));
      }
    }
    return errors;
  }

  /**
   * Validate IP address format
   */
  protected isValidIpAddress(ip: string): boolean {
    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
    const ipv6Regex = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
    if (!ipv4Regex.test(ip) && !ipv6Regex.test(ip)) {
      return false;
    }
    if (ipv4Regex.test(ip)) {
      const parts = ip.split('.').map(Number);
      return parts.every((part) => part >= 0 && part <= 255);
    }
    return true;
  }

  /**
   * Validate port number
   */
  protected isValidPort(port: number): boolean {
    return Number.isInteger(port) && port >= 1 && port <= 65535;
  }

  /**
   * Validate URL format
   */
  protected isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Validate hex string
   */
  protected isValidHex(hex: string, length?: number): boolean {
    const hexRegex = /^[0-9a-fA-F]+$/;
    if (!hexRegex.test(hex)) {
      return false;
    }
    if (length !== undefined && hex.length !== length) {
      return false;
    }
    return true;
  }

  /**
   * Parse connection string to config
   */
  protected parseConnectionString?(connectionString: string): Record<string, unknown>;

  /**
   * Format config to connection string
   */
  protected formatConnectionString?(config: Record<string, unknown>): string;

  /**
   * Log connection event
   */
  protected logConnectionEvent(
    event: 'connect' | 'disconnect' | 'error' | 'data',
    handle: ConnectionHandle,
    details?: Record<string, unknown>
  ): void {
    this.logger.log({
      event,
      protocol: this.protocolCode,
      connectionId: handle.id,
      sensorId: handle.sensorId,
      tenantId: handle.tenantId,
      ...details,
    });
  }
}

/**
 * Decorator to mark a class as a protocol adapter
 */
export function ProtocolAdapterMetadata(metadata: {
  code: string;
  name: string;
  category: ProtocolCategory;
  subcategory?: ProtocolSubcategory;
  connectionType: ConnectionType;
  description?: string;
}): ClassDecorator {
  return (target: Function) => {
    Reflect.defineMetadata('protocol:code', metadata.code, target);
    Reflect.defineMetadata('protocol:name', metadata.name, target);
    Reflect.defineMetadata('protocol:category', metadata.category, target);
    Reflect.defineMetadata('protocol:subcategory', metadata.subcategory, target);
    Reflect.defineMetadata('protocol:connectionType', metadata.connectionType, target);
    Reflect.defineMetadata('protocol:description', metadata.description, target);
  };
}
