import { Module } from '@nestjs/common';
import { AgentRunnerService } from './agent-runner.service';
import { AgentProfileService } from './agent-profile.service';
import { ToolRegistryModule } from '../tools/tool-registry.module';
import { ConversationModule } from '../conversation/conversation.module';
import { AgentConfigModule } from '../tenant-config/agent-config.module';
import { CostModule } from '../cost/cost.module';

@Module({
  imports: [ToolRegistryModule, ConversationModule, AgentConfigModule, CostModule],
  providers: [AgentRunnerService, AgentProfileService],
  exports: [AgentRunnerService, AgentProfileService],
})
export class AgentModule {}
