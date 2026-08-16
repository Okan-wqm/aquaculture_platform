import 'reflect-metadata';

import { StructuredLoggerService } from '@aquaculture/backend-common/logging';
import { canonicalWireJsonSha256V1 } from '@aquaculture/shared-contracts';
import { NestFactory } from '@nestjs/core';

import { FarmFeedingSchedulerAppModule } from './scheduler-app.module';

async function bootstrap(): Promise<void> {
  const logger = new StructuredLoggerService('farm-feeding-scheduler');
  const application = await NestFactory.create(FarmFeedingSchedulerAppModule, {
    logger,
  });
  application.enableShutdownHooks();
  const portText = process.env.PORT ?? '3000';
  if (!/^\d+$/.test(portText)) throw new Error('PORT must be an integer between 1 and 65535');
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  await application.listen(port, '0.0.0.0');
}

void bootstrap().catch((error: unknown) => {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const logger = new StructuredLoggerService('farm-feeding-scheduler');
  logger.error(
    'Farm feeding scheduler bootstrap failed',
    {
      errorDigest: canonicalWireJsonSha256V1(
        {
          domain: 'aquaculture.farm-feeding-scheduler-bootstrap-failure',
          schemaVersion: 'farm-feeding-scheduler-bootstrap-failure/v1',
        },
        { errorName: normalized.name, errorMessage: normalized.message },
      ),
    },
    'FarmFeedingSchedulerBootstrap',
  );
  process.exitCode = 1;
});
