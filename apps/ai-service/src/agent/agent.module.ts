import { Module } from '@nestjs/common';
import { AgentRunnerService } from './agent-runner.service';
import { AgentProfileService } from './agent-profile.service';
import { AgentPersonaCatalogueModule } from './agent-persona-catalogue.module';
import { ActionsModule } from '../actions/actions.module';
import { ToolRegistryModule } from '../tools/tool-registry.module';
import { ConversationModule } from '../conversation/conversation.module';
import { AgentConfigModule } from '../tenant-config/agent-config.module';
import { CostModule } from '../cost/cost.module';
import { AiSafetyModule } from '../safety/ai-safety.module';
import { LlmProvidersModule } from './providers/providers.module';

@Module({
  // FAZ1-BYOK: LlmProvidersModule is the SSoT for provider wiring (stateless
  // per-tenant; credential passed per call). Imported rather than declared
  // inline so the tenant-config CRUD can share the same factory without a cycle.
  imports: [
    ToolRegistryModule,
    AgentPersonaCatalogueModule,
    // MOB-HIGH-001: held actuations persist as confirmable proposals.
    ActionsModule,
    ConversationModule,
    AgentConfigModule,
    CostModule,
    AiSafetyModule,
    LlmProvidersModule,
  ],
  providers: [AgentRunnerService, AgentProfileService],
  exports: [AgentRunnerService, AgentProfileService, AgentPersonaCatalogueModule],
})
export class AgentModule {}
