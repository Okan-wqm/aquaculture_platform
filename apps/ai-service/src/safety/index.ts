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
export {
  InputFilterService,
  InputFilterResult,
} from './input-filter.service';

export {
  InstructionHierarchyService,
} from './instruction-hierarchy.service';

export {
  OutputPiiScannerService,
  PiiDetection,
  PiiType,
  PiiScanResult,
  PiiRedactResult,
} from './output-pii-scanner.service';

export {
  SsrfValidatorService,
  SsrfValidationResult,
} from './ssrf-validator.service';

export {
  ToolSchemaValidatorService,
  ToolValidationResult,
} from './tool-schema-validator.service';
