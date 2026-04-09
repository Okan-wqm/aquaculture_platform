/**
 * @module AiSafetyModule
 * @description NestJS module that provides the AI safety middleware pipeline.
 *
 * All services are independently injectable for fine-grained usage,
 * and the AiSafetyMiddleware orchestrator composes them into a pipeline.
 *
 * Usage:
 *   import { AiSafetyModule } from './safety/ai-safety.module';
 *   // In your module:
 *   @Module({ imports: [AiSafetyModule] })
 *
 * Each service can also be injected directly:
 *   constructor(private readonly inputFilter: InputFilterService) {}
 */
import { Module } from '@nestjs/common';
import { AiSafetyMiddleware } from './ai-safety.middleware';
import { InputFilterService } from './input-filter.service';
import { InstructionHierarchyService } from './instruction-hierarchy.service';
import { OutputPiiScannerService } from './output-pii-scanner.service';
import { SsrfValidatorService } from './ssrf-validator.service';
import { ToolSchemaValidatorService } from './tool-schema-validator.service';

@Module({
  providers: [
    InputFilterService,
    InstructionHierarchyService,
    OutputPiiScannerService,
    SsrfValidatorService,
    ToolSchemaValidatorService,
    AiSafetyMiddleware,
  ],
  exports: [
    InputFilterService,
    InstructionHierarchyService,
    OutputPiiScannerService,
    SsrfValidatorService,
    ToolSchemaValidatorService,
    AiSafetyMiddleware,
  ],
})
export class AiSafetyModule {}
