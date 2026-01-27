import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Logger } from '@nestjs/common';

export const initTelemetry = (serviceName: string) => {
  const logger = new Logger('OpenTelemetry');

  // Only enable if explicitly configured
  if (process.env.ENABLE_TRACING !== 'true') {
    logger.log('Tracing disabled (ENABLE_TRACING!=true)');
    return;
  }

  const traceExporter = new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces',
  });

  const sdk = new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
      [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || 'development',
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
