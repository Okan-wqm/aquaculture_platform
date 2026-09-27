import { Module } from '@nestjs/common';
import { ToolRegistryModule } from '../tools/tool-registry.module';
import { AgentPersonaCatalogueService } from './agent-persona-catalogue.service';

/**
 * The composed persona catalogue as its own module so both the agent runner
 * (AgentModule) and the proposal executor (ActionsModule) resolve personas
 * from one instance without an import cycle.
 */
@Module({
  imports: [ToolRegistryModule],
  providers: [AgentPersonaCatalogueService],
  exports: [AgentPersonaCatalogueService],
})
export class AgentPersonaCatalogueModule {}
