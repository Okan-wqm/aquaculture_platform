import {
  CircuitBreakerService,
  DEFAULT_BREAKER_OPTIONS,
} from '@aquaculture/backend-common/resilience';
import { Injectable, Logger } from '@nestjs/common';

import { ProtocolImplementationStatus } from '../../protocol/adapters/protocol-implementation-status';
import { VfdParameters } from '../entities/vfd-reading.entity';
import { VfdProtocol, VfdBrand, VfdDeviceStatus } from '../entities/vfd.enums';
import { VfdDevice } from '../entities/vfd-device.entity';
import {
  getVfdProtocolImplementationStatus,
  getVfdProtocolSchema,
  getVfdProtocolDefaults,
  getSelectableVfdProtocolInfo,
  validateVfdProtocolConfig,
  ValidationResult,
  VfdProtocolInfo,
} from '../protocol-config';

import { VfdDeviceService } from './vfd-device.service';
import { VfdEdgeReadService, VfdEdgeReadAllResult } from './vfd-edge-read.service';
import { VfdRegisterMappingService } from './vfd-register-mapping.service';
import { buildVfdReadResult } from './vfd-reading-codec';

/**
 * Test connection input (pre-registration).
 */
export interface TestConnectionInput {
  protocol: VfdProtocol;
  configuration: Record<string, unknown>;
  brand?: VfdBrand;
}

/**
 * Result of a connection test. A successful result means the drive was actually
 * reached through its edge gateway — never a fabricated in-process success.
 */
export interface ConnectionTestResult {
  success: boolean;
  latencyMs?: number;
  error?: string;
  sampleData?: VfdParameters;
  firmwareVersion?: string;
  serialNumber?: string;
}

/**
 * Extended test result with the protocol/config echoed back and a decoded sample.
 */
export interface ExtendedTestResult extends ConnectionTestResult {
  protocol: VfdProtocol;
  configuration: Record<string, unknown>;
  testedAt: Date;
  parameters?: Record<string, number>;
}

/**
 * VFD Connection Tester Service
 *
 * SENSOR-CRITICAL-007 / SENSOR-CRITICAL-009 (Faz 2C/3): the connection test is
 * edge-delegated and honest. VFD I/O runs on the edge gateway (`read_modbus` /
 * `write_modbus`), so this service opens no sockets and instantiates no in-process
 * adapters. Reachability is verified by a live edge read on a device already bound
 * to its gateway; a pre-registration test, an unbound device, or an unsupported
 * protocol fails honestly rather than reporting a fabricated success. Per-protocol
 * configuration schema, defaults and validation come from the `protocol-config`
 * SSoT.
 */
@Injectable()
export class VfdConnectionTesterService {
  private readonly logger = new Logger(VfdConnectionTesterService.name);

  constructor(
    private readonly vfdDeviceService: VfdDeviceService,
    private readonly registerMappingService: VfdRegisterMappingService,
    private readonly edgeReadService: VfdEdgeReadService,
    private readonly circuitBreaker: CircuitBreakerService,
  ) {}

  /**
   * Test a protocol configuration before a device exists (wizard pre-check).
   *
   * A VFD drive is reached only through its owning edge gateway, so a cloud test
   * cannot contact the drive and must not fabricate success (SENSOR-CRITICAL-009).
   * Structural config errors are surfaced first; then the result is an honest
   * "verified at the edge after binding" for edge-delegated protocols, or an honest
   * "not supported" for the rest. Real reachability is verified by
   * `testDeviceConnection` once the device is bound + provisioned.
   */
  async testConnection(input: TestConnectionInput): Promise<ExtendedTestResult> {
    const testedAt = new Date();
    this.logger.log(`Validating ${input.protocol} configuration (pre-registration)`);

    const validation = validateVfdProtocolConfig(input.protocol, input.configuration);
    if (!validation.valid) {
      return {
        success: false,
        error: `Configuration validation failed: ${validation.errors.join(', ')}`,
        protocol: input.protocol,
        configuration: input.configuration,
        testedAt,
      };
    }

    const status = getVfdProtocolImplementationStatus(input.protocol);
    const error =
      status === ProtocolImplementationStatus.EDGE_DELEGATED
        ? `Protocol ${input.protocol} is edge-delegated: the drive is reached through its edge gateway, ` +
          `so it cannot be contacted directly from the cloud. Register the device with its edge binding ` +
          `(or run a device connection test) to verify reachability.`
        : `Protocol ${input.protocol} is not supported: no edge-serviceable implementation exists.`;

    return {
      success: false,
      error,
      protocol: input.protocol,
      configuration: input.configuration,
      testedAt,
    };
  }

  /**
   * Test connection for an existing device by issuing a live edge read through its
   * owning gateway. This is the authoritative reachability check.
   */
  async testDeviceConnection(deviceId: string, tenantId: string): Promise<ExtendedTestResult> {
    const device = await this.vfdDeviceService.findById(deviceId, tenantId);
    const testedAt = new Date();
    const base = {
      protocol: device.protocol,
      configuration: device.protocolConfiguration,
      testedAt,
    };

    const status = getVfdProtocolImplementationStatus(device.protocol);
    if (status !== ProtocolImplementationStatus.EDGE_DELEGATED) {
      const error = `Protocol ${device.protocol} is not supported for edge connectivity.`;
      await this.applyTestOutcome(device, tenantId, { success: false, error, testedAt });
      return { success: false, error, ...base };
    }

    if (!device.edgeDeviceId || !device.edgeModbusDeviceName) {
      const error =
        'VFD is not attached to an edge gateway; bind it to an edge gateway before testing connectivity.';
      await this.applyTestOutcome(device, tenantId, { success: false, error, testedAt });
      return { success: false, error, ...base };
    }

    const edgeResult = await this.readViaBreaker(device, tenantId);

    if (!edgeResult.success) {
      const error = edgeResult.error ?? 'Edge read failed';
      await this.applyTestOutcome(device, tenantId, {
        success: false,
        error,
        latencyMs: edgeResult.latencyMs,
        testedAt,
      });
      return { success: false, error, latencyMs: edgeResult.latencyMs, ...base };
    }

    const parameters = await this.decodeSample(device, edgeResult);
    await this.applyTestOutcome(device, tenantId, {
      success: true,
      latencyMs: edgeResult.latencyMs,
      testedAt,
    });
    return { success: true, latencyMs: edgeResult.latencyMs, parameters, ...base };
  }

  /**
   * Validate protocol configuration without contacting the drive.
   */
  validateConfiguration(protocol: VfdProtocol, configuration: unknown): ValidationResult {
    return validateVfdProtocolConfig(protocol, configuration);
  }

  /**
   * Configuration JSON schema for a protocol, or `null` when unsupported.
   */
  getProtocolSchema(protocol: VfdProtocol): Record<string, unknown> | null {
    return getVfdProtocolSchema(protocol);
  }

  /**
   * Default configuration for a protocol, or `null` when unsupported.
   */
  getDefaultConfiguration(protocol: VfdProtocol): Record<string, unknown> | null {
    return getVfdProtocolDefaults(protocol);
  }

  /**
   * Selectable protocols with client-facing metadata. Unsupported protocols are
   * omitted so the UI never offers a drive path that cannot be honoured.
   */
  getSupportedProtocols(): VfdProtocolInfo[] {
    return getSelectableVfdProtocolInfo();
  }

  // ============ PRIVATE METHODS ============

  /**
   * Run the edge read behind the canonical per-drive circuit breaker so a
   * chronically unreachable drive sheds load (SVD-HIGH-003). fail-closed: a tripped
   * breaker, a failed read, or an unexpected throw all resolve to `success:false`
   * — never a fabricated success.
   */
  private async readViaBreaker(device: VfdDevice, tenantId: string): Promise<VfdEdgeReadAllResult> {
    try {
      return await this.circuitBreaker.execute<VfdEdgeReadAllResult>({
        serviceName: `vfd-link:${device.protocol}:${device.edgeModbusDeviceName}`,
        tenantId,
        options: { ...DEFAULT_BREAKER_OPTIONS, failureMode: 'fail-closed' },
        fn: async () => {
          const result = await this.edgeReadService.readAllRegisters(device, 'connection test');
          // Throw so the breaker counts an unreachable drive as a failure; the
          // caller reconstructs the honest failure from the returned result.
          if (!result.success) {
            throw new Error(result.error ?? 'Edge read failed');
          }
          return result;
        },
        fallback: () => ({
          success: false,
          commandId: '',
          values: [],
          error: 'VFD link circuit open — drive repeatedly unreachable',
        }),
      });
    } catch (error) {
      return {
        success: false,
        commandId: '',
        values: [],
        error: (error as Error).message,
      };
    }
  }

  /**
   * Persist the connection outcome and advance the device lifecycle: a successful
   * test moves a DRAFT device to TESTING; a failed test moves a TESTING device to
   * TEST_FAILED. Mirrors the truthful post-write status contract.
   */
  private async applyTestOutcome(
    device: VfdDevice,
    tenantId: string,
    outcome: { success: boolean; latencyMs?: number; error?: string; testedAt: Date },
  ): Promise<void> {
    await this.vfdDeviceService.updateConnectionStatus(device.id, tenantId, {
      isConnected: outcome.success,
      lastTestedAt: outcome.testedAt,
      lastError: outcome.error,
      latencyMs: outcome.latencyMs,
    });

    if (outcome.success && device.status === VfdDeviceStatus.DRAFT) {
      await this.vfdDeviceService.updateStatus(device.id, tenantId, VfdDeviceStatus.TESTING);
    } else if (!outcome.success && device.status === VfdDeviceStatus.TESTING) {
      await this.vfdDeviceService.updateStatus(device.id, tenantId, VfdDeviceStatus.TEST_FAILED);
    }
  }

  /**
   * Decode a small engineering-unit sample from the edge read, reusing the shared
   * VFD reading codec. Best-effort: a decode failure yields no sample rather than
   * failing the (already successful) reachability test.
   */
  private async decodeSample(
    device: VfdDevice,
    edgeResult: VfdEdgeReadAllResult,
  ): Promise<Record<string, number> | undefined> {
    if (edgeResult.values.length === 0) {
      return undefined;
    }
    try {
      const mappings = await this.registerMappingService.getMappingsForBrand(device.brand);
      const decoded = buildVfdReadResult(
        mappings,
        edgeResult.values,
        edgeResult.latencyMs ?? 0,
        new Date(),
      );
      const parameters: Record<string, number> = {};
      for (const [key, value] of Object.entries(decoded.parameters)) {
        if (typeof value === 'number') {
          parameters[key] = value;
        }
      }
      return Object.keys(parameters).length > 0 ? parameters : undefined;
    } catch (error) {
      this.logger.warn(`Failed to decode connection-test sample for ${device.id}`, error as Error);
      return undefined;
    }
  }
}
