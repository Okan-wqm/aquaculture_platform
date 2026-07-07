import { Module } from '@nestjs/common';
import { ClientsModule } from '@nestjs/microservices';
import { NatsV3Client } from '@aquaculture/backend-common/nats';
import { CreateTaskTool } from './create-task.tool';
import { GetFarmTanksTool } from './get-farm-tanks.tool';
import { GetFarmBatchesTool } from './get-farm-batches.tool';
import { GetFarmWaterQualityTool } from './get-farm-water-quality.tool';

const TOOLS = [CreateTaskTool, GetFarmTanksTool, GetFarmBatchesTool, GetFarmWaterQualityTool];

/**
 * Farm actuation tools. The tools reach farm-service over NATS request-reply,
 * so this module registers a NATS_SERVICE client (shared cert-identity factory,
 * ADR-015). Tool registration itself is automatic — ToolRegistryService
 * discovers every @Tool()-decorated provider via DiscoveryService — so listing
 * the classes as providers is the complete registration.
 */
@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'NATS_SERVICE',
        customClass: NatsV3Client,
        options: { serviceName: 'ai-service' },
      },
    ]),
  ],
  providers: [...TOOLS],
  exports: [...TOOLS],
})
export class FarmToolsModule {}
