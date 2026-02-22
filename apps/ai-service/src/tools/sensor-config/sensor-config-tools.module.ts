import { Module } from '@nestjs/common';
import { TOOL_PROVIDERS } from '../core/tool.interface';
import { AnalyzeSensorDataTool } from './analyze-sensor-data.tool';
import { SuggestChannelsTool } from './suggest-channels.tool';

const TOOLS = [AnalyzeSensorDataTool, SuggestChannelsTool];

@Module({
  providers: [
    ...TOOLS,
    // Multi-provider registration for tool registry discovery
    ...TOOLS.map((tool) => ({
      provide: TOOL_PROVIDERS,
      useExisting: tool,
    })),
  ],
  exports: [TOOL_PROVIDERS],
})
export class SensorConfigToolsModule {}
