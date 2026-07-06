import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TenantAgentConfig } from './agent-config.entity';
import { AgentConfigService } from './agent-config.service';
import { AgentConfigController } from './agent-config.controller';
import { LlmProvidersModule } from '../agent/providers/providers.module';

@Module({
  // FAZ1-BYOK: the CRUD controller needs LlmProviderFactory (key-validation
  // ping). LlmProvidersModule is its own SSoT module so importing it here does
  // NOT pull in AgentModule (which imports AgentConfigModule) — no cycle.
  imports: [TypeOrmModule.forFeature([TenantAgentConfig]), LlmProvidersModule],
  controllers: [AgentConfigController],
  providers: [AgentConfigService],
  exports: [AgentConfigService],
})
export class AgentConfigModule {}
