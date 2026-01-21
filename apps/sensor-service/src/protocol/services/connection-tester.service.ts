import { Injectable, Logger } from '@nestjs/common';

import { ConnectionTestResult, SensorReadingData, ConnectionDiagnostics } from '../adapters/base-protocol.adapter';

import { ProtocolRegistryService } from './protocol-registry.service';
import { ProtocolValidatorService } from './protocol-validator.service';

export interface ExtendedTestResult extends ConnectionTestResult {
  protocolCode: string;
  testedAt: Date;
  configUsed: Record<string, unknown>;
  sampleData?: SensorReadingData;
  extendedDiagnostics?: ExtendedConnectionDiagnostics;
}

export interface ExtendedConnectionDiagnostics extends ConnectionDiagnostics {
  dnsResolutionMs?: number;
  tcpConnectMs?: number;
  sslHandshakeMs?: number;
  authenticationMs?: number;
  firstByteMs?: number;
  totalMs?: number;
}

export interface BatchTestResult {
  total: number;
  successful: number;
  failed: number;
  results: ExtendedTestResult[];
}

@Injectable()
export class ConnectionTesterService {
  private readonly logger = new Logger(ConnectionTesterService.name);

  constructor(
    private protocolRegistry: ProtocolRegistryService,
    private protocolValidator: ProtocolValidatorService,
  ) {}

  /**
   * Test connection to a sensor with given protocol and configuration
   */
  async testConnection(
    protocolCode: string,
    config: Record<string, unknown>,
    options: { timeout?: number; fetchSampleData?: boolean } = {},
  ): Promise<ExtendedTestResult> {
    const { timeout = 10000, fetchSampleData = true } = options;
    const testedAt = new Date();

    // Validate configuration first
    const validationResult = this.protocolValidator.validate(protocolCode, config);
    if (!validationResult.isValid) {
      return {
        success: false,
        protocolCode,
        testedAt,
        configUsed: config,
        error: `Configuration validation failed: ${validationResult.errors.map((e) => e.message).join(', ')}`,
      };
    }

    // Get adapter
    const adapter = this.protocolRegistry.getAdapter(protocolCode);
    if (!adapter) {
      return {
        success: false,
        protocolCode,
        testedAt,
        configUsed: config,
        error: `Unknown protocol: ${protocolCode}`,
      };
    }

    const startTime = Date.now();

    try {
      // Test connection with timeout
      const testResult = await Promise.race([
        adapter.testConnection(config),
        new Promise<ConnectionTestResult>((_, reject) =>
          setTimeout(() => reject(new Error('Connection timeout')), timeout),
        ),
      ]);

      if (!testResult.success) {
        return {
          ...testResult,
          protocolCode,
          testedAt,
          configUsed: config,
          diagnostics: {
            totalMs: Date.now() - startTime,
          },
        };
      }

      // If connection successful and sample data requested, try to read data
      let sampleData: SensorReadingData | undefined;
      if (fetchSampleData) {
        try {
          const handle = await adapter.connect(config);
          try {
            sampleData = await Promise.race([
              adapter.readData(handle),
              new Promise<SensorReadingData>((_, reject) =>
                setTimeout(() => reject(new Error('Read timeout')), timeout),
              ),
            ]);
          } finally {
            await adapter.disconnect(handle);
          }
        } catch (readError) {
          this.logger.warn(
            `Sample data read failed for ${protocolCode}: ${(readError as Error).message}`,
          );
        }
      }

      return {
        success: true,
        protocolCode,
        testedAt,
        configUsed: config,
        latencyMs: testResult.latencyMs,
        sampleData,
        diagnostics: {
          totalMs: Date.now() - startTime,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Connection test failed for ${protocolCode}: ${errorMessage}`);

      return {
        success: false,
        protocolCode,
        testedAt,
        configUsed: config,
        error: errorMessage,
        diagnostics: {
          totalMs: Date.now() - startTime,
        },
      };
    }
  }

  /**
   * Quick connectivity check (no sample data)
   */
  async quickTest(protocolCode: string, config: Record<string, unknown>): Promise<boolean> {
    const result = await this.testConnection(protocolCode, config, {
      timeout: 5000,
      fetchSampleData: false,
    });
    return result.success;
  }

  /**
   * Test multiple configurations in batch
   */
  async batchTest(
    tests: Array<{ protocolCode: string; config: Record<string, unknown> }>,
    options: { concurrency?: number; timeout?: number } = {},
  ): Promise<BatchTestResult> {
    const { concurrency = 5, timeout = 10000 } = options;
    const results: ExtendedTestResult[] = [];

    // Process in batches
    for (let i = 0; i < tests.length; i += concurrency) {
      const batch = tests.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map((test) =>
          this.testConnection(test.protocolCode, test.config, { timeout, fetchSampleData: false }),
        ),
      );
      results.push(...batchResults);
    }

    return {
      total: results.length,
      successful: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      results,
    };
  }

  /**
   * Ping test for network-based protocols
   */
  async pingTest(
    protocolCode: string,
    config: Record<string, unknown>,
    count = 3,
  ): Promise<{ avgLatencyMs: number; minLatencyMs: number; maxLatencyMs: number; loss: number }> {
    const latencies: number[] = [];
    let failures = 0;

    for (let i = 0; i < count; i++) {
      const result = await this.testConnection(protocolCode, config, {
        timeout: 5000,
        fetchSampleData: false,
      });

      if (result.success && result.latencyMs !== undefined) {
        latencies.push(result.latencyMs);
      } else {
        failures++;
      }

      // Small delay between pings
      if (i < count - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    if (latencies.length === 0) {
      return {
        avgLatencyMs: -1,
        minLatencyMs: -1,
        maxLatencyMs: -1,
        loss: 100,
      };
    }

    return {
      avgLatencyMs: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
      minLatencyMs: Math.min(...latencies),
      maxLatencyMs: Math.max(...latencies),
      loss: Math.round((failures / count) * 100),
    };
  }

  /**
   * Discover available devices/endpoints for protocols that support discovery
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async discoverDevices(
    protocolCode: string,
    _config: Record<string, unknown>,
  ): Promise<{ discovered: unknown[]; error?: string }> {
    const adapter = this.protocolRegistry.getAdapter(protocolCode);
    if (!adapter) {
      return { discovered: [], error: `Unknown protocol: ${protocolCode}` };
    }

    const capabilities = adapter.getCapabilities();
    if (!capabilities.supportsDiscovery) {
      return { discovered: [], error: `Protocol ${protocolCode} does not support discovery` };
    }

    // For now, return empty - actual discovery would be protocol-specific
    // This is a placeholder for future implementation
    return { discovered: [] };
  }

  /**
   * Get connection statistics for a sensor
   */
  async getConnectionStats(
    protocolCode: string,
    config: Record<string, unknown>,
    sampleCount = 10,
  ): Promise<{
    successRate: number;
    avgLatencyMs: number;
    stdDevLatencyMs: number;
    samples: ExtendedTestResult[];
  }> {
    const samples: ExtendedTestResult[] = [];

    for (let i = 0; i < sampleCount; i++) {
      const result = await this.testConnection(protocolCode, config, {
        timeout: 5000,
        fetchSampleData: false,
      });
      samples.push(result);

      // Delay between samples
      if (i < sampleCount - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    const successes = samples.filter((s) => s.success);
    const latencies = successes
      .map((s) => s.latencyMs)
      .filter((latency): latency is number => latency !== undefined);

    let avgLatencyMs = 0;
    let stdDevLatencyMs = 0;

    if (latencies.length > 0) {
      avgLatencyMs = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      const squaredDiffs = latencies.map((l) => Math.pow(l - avgLatencyMs, 2));
      stdDevLatencyMs = Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / latencies.length);
    }

    return {
      successRate: (successes.length / samples.length) * 100,
      avgLatencyMs: Math.round(avgLatencyMs),
      stdDevLatencyMs: Math.round(stdDevLatencyMs),
      samples,
    };
  }
}
