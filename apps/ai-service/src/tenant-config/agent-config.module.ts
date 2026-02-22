import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TenantAgentConfig } from './agent-config.entity';
import { AgentConfigService } from './agent-config.service';

@Module({
  imports: [TypeOrmModule.forFeature([TenantAgentConfig])],
  providers: [AgentConfigService],
  exports: [AgentConfigService],
})
export class AgentConfigModule {}
