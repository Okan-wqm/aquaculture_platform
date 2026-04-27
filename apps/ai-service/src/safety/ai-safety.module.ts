/**
 * @module AiSafetyModule
 * @description ai-service's AI safety pipeline — layers the service-specific
 * orchestrator + instruction-hierarchy + tool-schema-validator on top of the
 * cross-service core (SSRF / input filter / output PII scanner) that lives
 * in `libs/backend-common/src/ai-safety`.
 *
 * Historical context: before AUDIT-HIGH-007 (cold audit 2026-04-22) the
 * core services lived here too, byte-identical copies of the ones in
 * messaging-service and notification-service. The shared library now owns
 * those three; this module composes on top.
 *
 * @see docs/reviews/_audit/2026-04-22-cold-audit/03-explore-findings.md#AUDIT-HIGH-007
 */
import { Module } from '@nestjs/common';
import { AiSafetyCoreModule } from '@aquaculture/backend-common/ai-safety';

import { AiSafetyMiddleware } from './ai-safety.middleware';
import { InstructionHierarchyService } from './instruction-hierarchy.service';
import { ToolSchemaValidatorService } from './tool-schema-validator.service';

@Module({
  imports: [AiSafetyCoreModule],
  providers: [
    InstructionHierarchyService,
    ToolSchemaValidatorService,
    AiSafetyMiddleware,
  ],
  exports: [
    AiSafetyCoreModule,
    InstructionHierarchyService,
    ToolSchemaValidatorService,
    AiSafetyMiddleware,
  ],
})
export class AiSafetyModule {}
