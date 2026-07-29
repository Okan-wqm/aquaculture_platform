/**
 * Connection-event log redaction (SENSOR-MEDIUM-059).
 *
 * `logConnectionEvent` spreads adapter-supplied `details` into a structured log
 * line. Some adapters log connection context that can carry credentials; the
 * base must mask secret-named fields by name so no adapter — present or future —
 * can leak a device credential through the shared connection-event logger.
 */
import { Logger } from '@nestjs/common';

import {
  BaseProtocolAdapter,
  ConnectionHandle,
  ConnectionTestResult,
  SensorReadingData,
  ValidationResult,
  ProtocolCapabilities,
} from '../base-protocol.adapter';
import { REDACTED_PLACEHOLDER } from '../../../common/redact-protocol-secrets';
import {
  ProtocolCategory,
  ConnectionType,
  ProtocolConfigurationSchema,
} from '../../../database/entities/sensor-protocol.entity';

/** Minimal concrete adapter exposing the protected connection-event logger. */
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

  // Expose the protected connection-event logger for testing.
  emit(handle: ConnectionHandle, details: Record<string, unknown>): void {
    this.logConnectionEvent('connect', handle, details);
  }
}

const handle: ConnectionHandle = {
  id: 'c1',
  sensorId: 's1',
  tenantId: 't1',
  protocolCode: 'TEST',
  createdAt: new Date(),
  lastActivityAt: new Date(),
};

describe('BaseProtocolAdapter.logConnectionEvent redaction (SENSOR-MEDIUM-059)', () => {
  let log: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('masks secret-named detail fields and preserves diagnostics', () => {
    new TestAdapter().emit(handle, {
      host: 'broker.example.com',
      password: 'hunter2',
      apiKey: 'k-abc-123',
      pskKey: 'deadbeef',
    });

    expect(log).toHaveBeenCalledTimes(1);
    const payload = log.mock.calls[0][0] as Record<string, unknown>;

    // Non-secret diagnostics pass through unchanged.
    expect(payload.host).toBe('broker.example.com');
    expect(payload.tenantId).toBe('t1');
    expect(payload.sensorId).toBe('s1');
    // Secret-named fields are masked before reaching the sink.
    expect(payload.password).toBe(REDACTED_PLACEHOLDER);
    expect(payload.apiKey).toBe(REDACTED_PLACEHOLDER);
    expect(payload.pskKey).toBe(REDACTED_PLACEHOLDER);
  });

  it('logs the core connection context when no details are supplied', () => {
    new TestAdapter().emit(handle, {});

    const payload = log.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.event).toBe('connect');
    expect(payload.protocol).toBe('TEST');
    expect(payload.connectionId).toBe('c1');
  });
});
