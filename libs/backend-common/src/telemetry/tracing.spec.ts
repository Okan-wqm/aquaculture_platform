const mockSdkStart = jest.fn();
const mockSdkShutdown = jest.fn();
const mockTraceExporter = jest.fn();
const mockResourceFromAttributes = jest.fn();
const mockGetNodeAutoInstrumentations = jest.fn();
const mockLogger = {
  log: jest.fn(),
  error: jest.fn(),
};

jest.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: jest.fn().mockImplementation(() => ({
    start: mockSdkStart,
    shutdown: mockSdkShutdown,
  })),
}));

jest.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: jest.fn().mockImplementation((options: unknown) => {
    mockTraceExporter(options);
    return { exporter: 'otlp-http' };
  }),
}));

jest.mock('@opentelemetry/resources', () => ({
  resourceFromAttributes: jest.fn().mockImplementation((attributes: unknown) => {
    mockResourceFromAttributes(attributes);
    return { attributes };
  }),
}));

jest.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: jest.fn().mockImplementation((options: unknown) => {
    mockGetNodeAutoInstrumentations(options);
    return { instrumentation: 'node-auto' };
  }),
}));

jest.mock('@nestjs/common', () => ({
  Logger: jest.fn().mockImplementation(() => mockLogger),
}));

import { NodeSDK } from '@opentelemetry/sdk-node';

import { initTelemetry } from './tracing';

describe('initTelemetry', () => {
  const originalEnableTracing = process.env['ENABLE_TRACING'];
  const originalExporterEndpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  const originalNodeEnv = process.env['NODE_ENV'];
  let sigtermHandler: NodeJS.SignalsListener | undefined;
  let processOnSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSdkShutdown.mockResolvedValue(undefined);
    sigtermHandler = undefined;
    processOnSpy = jest.spyOn(process, 'on').mockImplementation(((event, listener) => {
      if (event === 'SIGTERM') {
        sigtermHandler = listener as NodeJS.SignalsListener;
      }
      return process;
    }) as typeof process.on);
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    delete process.env['ENABLE_TRACING'];
    delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
    process.env['NODE_ENV'] = 'test';
  });

  afterEach(() => {
    processOnSpy.mockRestore();
    processExitSpy.mockRestore();
    restoreEnv('ENABLE_TRACING', originalEnableTracing);
    restoreEnv('OTEL_EXPORTER_OTLP_ENDPOINT', originalExporterEndpoint);
    restoreEnv('NODE_ENV', originalNodeEnv);
  });

  it('does not construct telemetry components unless tracing is explicitly enabled', () => {
    initTelemetry('gateway-api');

    expect(NodeSDK).not.toHaveBeenCalled();
    expect(mockTraceExporter).not.toHaveBeenCalled();
    expect(processOnSpy).not.toHaveBeenCalled();
    expect(mockLogger.log).toHaveBeenCalledWith('Tracing disabled (ENABLE_TRACING!=true)');
  });

  it('starts the SDK with the configured OTLP endpoint and service resource', () => {
    process.env['ENABLE_TRACING'] = 'true';
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'https://otel.example.test/v1/traces';
    process.env['NODE_ENV'] = 'production';

    initTelemetry('auth-service');

    expect(mockTraceExporter).toHaveBeenCalledWith({
      url: 'https://otel.example.test/v1/traces',
    });
    expect(mockResourceFromAttributes).toHaveBeenCalledWith({
      'service.name': 'auth-service',
      'deployment.environment.name': 'production',
    });
    expect(mockGetNodeAutoInstrumentations).toHaveBeenCalledWith({
      '@opentelemetry/instrumentation-fs': { enabled: false },
    });
    expect(NodeSDK).toHaveBeenCalledWith(expect.objectContaining({
      traceExporter: { exporter: 'otlp-http' },
      resource: {
        attributes: {
          'service.name': 'auth-service',
          'deployment.environment.name': 'production',
        },
      },
      instrumentations: [{ instrumentation: 'node-auto' }],
    }));
    expect(mockSdkStart).toHaveBeenCalledTimes(1);
    expect(mockLogger.log).toHaveBeenCalledWith('Tracing initialized for auth-service');
  });

  it('shuts down the exporter before exiting on SIGTERM', async () => {
    process.env['ENABLE_TRACING'] = 'true';
    initTelemetry('farm-service');

    expect(sigtermHandler).toBeDefined();
    sigtermHandler?.('SIGTERM');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockSdkShutdown).toHaveBeenCalledTimes(1);
    expect(mockLogger.log).toHaveBeenCalledWith('Tracing terminated');
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
    return;
  }
  process.env[name] = value;
}
