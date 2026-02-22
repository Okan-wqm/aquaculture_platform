import { Module } from '@nestjs/common';
import { ToolRegistryService } from './tool-registry.service';
import { ToolExecutorService } from './core/tool-executor.service';
import { TOOL_PROVIDERS } from './core/tool.interface';

/**
 * Tool Registry Module
 *
 * Provides the central tool registry and executor.
 * Tool category modules register their tools via the TOOL_PROVIDERS multi-provider token.
 *
 * Usage in category modules:
 * ```
 * @Module({
 *   providers: [
 *     MyTool1,
 *     MyTool2,
 *     { provide: TOOL_PROVIDERS, useExisting: MyTool1, multi: true },
 *     { provide: TOOL_PROVIDERS, useExisting: MyTool2, multi: true },
 *   ],
 * })
 * ```
 */
@Module({
  providers: [
    ToolRegistryService,
    ToolExecutorService,
    // Default empty array for TOOL_PROVIDERS if no tools are registered
    {
      provide: TOOL_PROVIDERS,
      useValue: [],
    },
  ],
  exports: [ToolRegistryService, ToolExecutorService],
})
export class ToolRegistryModule {}
