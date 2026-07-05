import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ToolRegistryService } from './tool-registry.service';
import { ToolExecutorService } from './core/tool-executor.service';

/**
 * Tool Registry Module
 *
 * Provides the central tool registry and executor. Tools are discovered
 * automatically at startup: ToolRegistryService scans every instantiated
 * provider (DiscoveryService) and registers the ones decorated with @Tool().
 *
 * Registering a new tool in any category module:
 * ```
 * @Module({
 *   providers: [MyTool1, MyTool2], // nothing else — discovery is automatic
 * })
 * ```
 *
 * WHY (FAZ0-BOOT-01): the previous TOOL_PROVIDERS multi-provider token relied
 * on Angular semantics NestJS does not implement, so the registry always
 * received the empty default and no tool was ever callable by the agent.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [ToolRegistryService, ToolExecutorService],
  exports: [ToolRegistryService, ToolExecutorService],
})
export class ToolRegistryModule {}
