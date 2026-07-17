import { Logger } from '@nestjs/common';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';

export const initTelemetry = (serviceName: string): void => {
  const logger = new Logger('OpenTelemetry');

  // Only enable if explicitly configured
  if (process.env['ENABLE_TRACING'] !== 'true') {
    logger.log('Tracing disabled (ENABLE_TRACING!=true)');
    return;
  }

  const traceExporter = new OTLPTraceExporter({
    url: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] || 'http://localhost:4318/v1/traces',
  });

  // Use the installed OpenTelemetry resource factory API; Resource is exposed
  // as a type-only interface in this package line.
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': serviceName,
      'deployment.environment.name': process.env['NODE_ENV'] || 'development',
    }),
    traceExporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Disable potentially noisy instrumentations by default
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    sdk.shutdown()
      .then(() => logger.log('Tracing terminated'))
      .catch((error) => logger.error('Error terminating tracing', error))
      .finally(() => process.exit(0));
  });

  try {
    sdk.start();
    logger.log(`Tracing initialized for ${serviceName}`);
  } catch (error) {
    logger.error('Failed to initialize tracing', error);
  }
};
