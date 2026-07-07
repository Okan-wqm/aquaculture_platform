import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TenantAgentConfig } from './agent-config.entity';
import { AgentConfigService } from './agent-config.service';
import { AgentConfigResolver } from './agent-config.resolver';
import { AiEnablementResponder } from './ai-enablement.responder';
import { LlmProvidersModule } from '../agent/providers/providers.module';

@Module({
  // FAZ1-BYOK: the settings CRUD is a federated GraphQL subgraph surface
  // (AgentConfigResolver), consistent with every other service — no hand-rolled
  // REST proxy. It needs LlmProviderFactory (key-validation ping);
  // LlmProvidersModule is its own SSoT module so importing it here does NOT pull
  // in AgentModule (which imports AgentConfigModule) — no cycle.
  // AiEnablementResponder answers request.ai.isEnabled — the SSoT for tenant AI
  // enablement that messaging now consumes instead of a duplicate local flag.
  imports: [TypeOrmModule.forFeature([TenantAgentConfig]), LlmProvidersModule],
  controllers: [AiEnablementResponder],
  providers: [AgentConfigService, AgentConfigResolver],
  exports: [AgentConfigService],
})
export class AgentConfigModule {}
