/**
 * @module safety
 * @description Barrel export for the AI safety middleware pipeline.
 *
 * @see MSG-CRITICAL-029 (SSRF)
 * @see MSG-CRITICAL-030 (jailbreak)
 * @see MSG-HIGH-031 (instruction hierarchy)
 * @see MSG-HIGH-032 (output PII filter)
 * @see MSG-HIGH-033 (JSON schema validation)
 */

// ── Module ──
export { AiSafetyModule } from './ai-safety.module';

// ── Pipeline Orchestrator ──
export {
  AiSafetyMiddleware,
  AiSafetyConfig,
  PreProcessResult,
  PostProcessResult,
  ToolCallValidationResult,
} from './ai-safety.middleware';

// ── Individual Services ──
// Cross-service core (SSRF / input filter / output PII scanner) now lives
// in libs/backend-common/src/ai-safety per AUDIT-HIGH-007 / ADR-028.
// Re-exported here so existing consumers that import from this barrel
// keep resolving without rewiring.
export {
  InputFilterService,
  InputFilterResult,
  OutputPiiScannerService,
  PiiDetection,
  PiiType,
  PiiScanResult,
  PiiRedactResult,
  SsrfValidatorService,
  SsrfValidationResult,
} from '@aquaculture/backend-common/ai-safety';

export {
  InstructionHierarchyService,
} from './instruction-hierarchy.service';

export {
  ToolSchemaValidatorService,
  ToolValidationResult,
} from './tool-schema-validator.service';
