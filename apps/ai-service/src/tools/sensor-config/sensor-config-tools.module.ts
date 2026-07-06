import { Module } from '@nestjs/common';
import { AnalyzeSensorDataTool } from './analyze-sensor-data.tool';
import { SuggestChannelsTool } from './suggest-channels.tool';

const TOOLS = [AnalyzeSensorDataTool, SuggestChannelsTool];

// Tool registration is automatic: ToolRegistryService discovers every
// @Tool()-decorated provider via DiscoveryService (FAZ0-BOOT-01). Declaring
// the classes as providers is the complete registration.
@Module({
  providers: [...TOOLS],
  exports: [...TOOLS],
})
export class SensorConfigToolsModule {}
