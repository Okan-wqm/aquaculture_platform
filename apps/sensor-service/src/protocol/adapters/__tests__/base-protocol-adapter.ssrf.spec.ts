import { SsrfValidatorService } from '@aquaculture/backend-common/ai-safety';

import {
  BaseProtocolAdapter,
  ConnectionHandle,
  ConnectionTestResult,
  SensorReadingData,
  ValidationResult,
  ProtocolCapabilities,
} from '../base-protocol.adapter';
import {
  ProtocolCategory,
  ConnectionType,
  ProtocolConfigurationSchema,
} from '../../../database/entities/sensor-protocol.entity';

/**
 * Minimal concrete adapter exposing the base SSRF guard helpers.
 * SENSOR-HIGH-072/075: the base owns outbound host validation so every network
 * adapter shares one guard.
 */
class TestAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'TEST';
  readonly category = ProtocolCategory.IOT;
  readonly subcategory = undefined;
  readonly connectionType = ConnectionType.TCP;
  readonly displayName = 'Test';
  readonly description = undefined;

  connect(): Promise<ConnectionHandle> {
    throw new Error('not implemented');
  }
  disconnect(): Promise<void> {
    return Promise.resolve();
  }
  testConnection(): Promise<ConnectionTestResult> {
    return Promise.resolve({ success: true });
  }
  readData(): Promise<SensorReadingData> {
    return Promise.resolve({ timestamp: new Date(), values: {}, quality: 100 });
  }
  validateConfiguration(): ValidationResult {
    return { isValid: true, errors: [] };
  }
  getConfigurationSchema(): ProtocolConfigurationSchema {
    return { type: 'object', properties: {} };
  }
  getDefaultConfiguration(): Record<string, unknown> {
    return {};
  }
  getCapabilities(): ProtocolCapabilities {
    return {
      supportsDiscovery: false,
      supportsBidirectional: false,
      supportsPolling: true,
      supportsSubscription: false,
      supportsAuthentication: false,
      supportsEncryption: false,
      supportedDataTypes: [],
    };
  }

  // Expose the protected guards for testing.
  resolveHost(host: string, port: number): Promise<string> {
    return this.resolveAndValidateHost(host, port);
  }
  assertHost(host: string, port: number): Promise<void> {
    return this.assertOutboundHostAllowed(host, port);
  }
}

describe('BaseProtocolAdapter outbound host guard', () => {
  let adapter: TestAdapter;
  let validateHost: jest.SpyInstance;

  beforeEach(() => {
    adapter = new TestAdapter();
    validateHost = jest.spyOn(SsrfValidatorService.prototype, 'validateHost');
  });

  afterEach(() => jest.restoreAllMocks());

  describe('resolveAndValidateHost (pinning)', () => {
    it('returns the resolved IP for a safe host', async () => {
      validateHost.mockResolvedValue({ safe: true, resolvedIp: '93.184.216.34' });
      await expect(adapter.resolveHost('example.com', 502)).resolves.toBe('93.184.216.34');
      expect(validateHost).toHaveBeenCalledWith('example.com', 502);
    });

    it('throws an opaque error for an unsafe host', async () => {
      validateHost.mockResolvedValue({
        safe: false,
        reason: 'DNS resolved to private IP: 169.254.169.254',
      });
      await expect(adapter.resolveHost('metadata.internal', 502)).rejects.toThrow(
        'Connection failed',
      );
    });

    it('throws when the verdict is safe but carries no resolved IP to pin', async () => {
      validateHost.mockResolvedValue({ safe: true });
      await expect(adapter.resolveHost('example.com', 502)).rejects.toThrow('Connection failed');
    });
  });

  describe('assertOutboundHostAllowed (validate only)', () => {
    it('resolves for a safe host without requiring a pinned IP', async () => {
      validateHost.mockResolvedValue({ safe: true });
      await expect(adapter.assertHost('broker.example.com', 8883)).resolves.toBeUndefined();
      expect(validateHost).toHaveBeenCalledWith('broker.example.com', 8883);
    });

    it('throws an opaque error for an unsafe host', async () => {
      validateHost.mockResolvedValue({
        safe: false,
        reason: 'Localhost addresses are not allowed.',
      });
      await expect(adapter.assertHost('127.0.0.1', 8883)).rejects.toThrow('Connection failed');
    });
  });
});
