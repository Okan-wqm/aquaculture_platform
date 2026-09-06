/**
 * @module AiSafetyMiddleware
 * @description Pipeline orchestrator that enforces safety checks on ALL AI
 * interactions. Composes the individual safety services into a configurable
 * pipeline with well-defined execution order.
 *
 * Pipeline order:
 * 1. INPUT FILTER:       Block known jailbreak patterns before they reach the model
 * 2. INSTRUCTION HIERARCHY: Inject system-level instruction that user input cannot override
 * 3. EXECUTE:            (Caller invokes the AI model — this middleware does NOT call the model)
 * 4. OUTPUT PII SCAN:    Detect and redact PII in model response
 * 5. TOOL VALIDATION:    Validate tool call parameters against JSON schema
 * 6. URL VALIDATION:     Validate URLs in tool calls for SSRF prevention
 *
 * IMPORTANT: This middleware is composable. Individual checks can be enabled
 * or disabled via AiSafetyConfig. The pipeline does NOT call the model itself —
 * it processes inputs/outputs around the model call.
 *
 * @see MSG-CRITICAL-029 (SSRF)
 * @see MSG-CRITICAL-030 (jailbreak)
 * @see MSG-HIGH-031 (instruction hierarchy)
 * @see MSG-HIGH-032 (output PII filter)
 * @see MSG-HIGH-033 (JSON schema validation)
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  InputFilterService,
  InputFilterResult,
  OutputPiiScannerService,
  PiiRedactResult,
  PiiScanResult,
  SsrfValidatorService,
  SsrfValidationResult,
} from '@aquaculture/backend-common/ai-safety';
import { InstructionHierarchyService } from './instruction-hierarchy.service';
import { ToolSchemaValidatorService, ToolValidationResult } from './tool-schema-validator.service';

// ── Configuration ──

/** Configuration for enabling/disabling individual pipeline stages. */
export interface AiSafetyConfig {
  /** Enable jailbreak pattern detection on input. Default: true. */
  inputFilterEnabled: boolean;
  /** Enable instruction hierarchy hardening. Default: true. */
  instructionHierarchyEnabled: boolean;
  /** Enable PII scanning on model output. Default: true. */
  outputPiiScanEnabled: boolean;
  /** Auto-redact PII (vs. detect-only). Default: true. */
  outputPiiAutoRedact: boolean;
  /** Enable tool parameter schema validation. Default: true. */
  toolSchemaValidationEnabled: boolean;
  /** Enable SSRF validation for URLs in tool calls. Default: true. */
  ssrfValidationEnabled: boolean;
}

/** Default configuration — all safety checks enabled. */
const DEFAULT_CONFIG: AiSafetyConfig = {
  inputFilterEnabled: true,
  instructionHierarchyEnabled: true,
  outputPiiScanEnabled: true,
  outputPiiAutoRedact: true,
  toolSchemaValidationEnabled: true,
  ssrfValidationEnabled: true,
};

// ── Pipeline Result Types ──

/** Result of pre-processing user input through the safety pipeline. */
export interface PreProcessResult {
  /** Whether the input passed all safety checks. */
  allowed: boolean;
  /** If not allowed, the reason for rejection. */
  rejectionReason?: string;
  /** Input filter result (if enabled). */
  inputFilter?: InputFilterResult;
  /** The hardened system prompt (if instruction hierarchy is enabled). */
  hardenedSystemPrompt?: string;
}

/** Result of post-processing model output through the safety pipeline. */
export interface PostProcessResult {
  /** The (possibly redacted) output text. */
  outputText: string;
  /** PII scan result (if enabled). */
  piiScan?: PiiScanResult;
  /** Whether PII was auto-redacted. */
  piiRedacted: boolean;
}

/** Result of validating a tool call. */
export interface ToolCallValidationResult {
  /** Whether the tool call passed all safety checks. */
  allowed: boolean;
  /** Tool schema validation result (if enabled). */
  schemaValidation?: ToolValidationResult;
  /** SSRF validation result for any URLs (if enabled). */
  ssrfValidation?: SsrfValidationResult;
  /** Rejection reason if not allowed. */
  rejectionReason?: string;
}

@Injectable()
export class AiSafetyMiddleware {
  private readonly logger = new Logger(AiSafetyMiddleware.name);
  private config: AiSafetyConfig = { ...DEFAULT_CONFIG };

  constructor(
    private readonly inputFilter: InputFilterService,
    private readonly instructionHierarchy: InstructionHierarchyService,
    private readonly outputPiiScanner: OutputPiiScannerService,
    private readonly ssrfValidator: SsrfValidatorService,
    private readonly toolSchemaValidator: ToolSchemaValidatorService,
  ) {}

  /**
   * Override the default safety configuration.
   * Typically called during module initialization based on environment config.
   *
   * @param partial - Partial config to merge with defaults
   */
  configure(partial: Partial<AiSafetyConfig>): void {
    this.config = { ...this.config, ...partial };
    this.logger.log(`AI Safety pipeline configured: ${JSON.stringify(this.config)}`);
  }

  /**
   * Get the current safety configuration.
   *
   * @returns Current AiSafetyConfig
   */
  getConfig(): Readonly<AiSafetyConfig> {
    return { ...this.config };
  }

  /**
   * PRE-PROCESS: Run safety checks on user input BEFORE sending to the model.
   *
   * Pipeline stages:
   * 1. Input filter (jailbreak detection)
   * 2. Instruction hierarchy (system prompt hardening)
   *
   * @param input - User message text
   * @param tenantId - Tenant identifier for audit
   * @param personaName - Display name of the persona
   * @param baseSystemPrompt - The persona's original system prompt
   * @param tenantCustomPrompt - Optional tenant-specific prompt
   * @returns PreProcessResult with safety verdict and hardened prompt
   */
  preProcess(
    input: string,
    tenantId: string,
    personaName: string,
    baseSystemPrompt: string,
    tenantCustomPrompt?: string,
  ): PreProcessResult {
    const result: PreProcessResult = { allowed: true };

    // ── Stage 1: Input filter ──
    if (this.config.inputFilterEnabled) {
      const filterResult = this.inputFilter.scanInput(input, tenantId);
      result.inputFilter = filterResult;

      if (!filterResult.safe) {
        result.allowed = false;
        result.rejectionReason = filterResult.reason;
        // SECURITY: Return immediately — do not proceed with prompt hardening
        // for blocked input.
        return result;
      }
    }

    // ── Stage 2: Instruction hierarchy ──
    if (this.config.instructionHierarchyEnabled) {
      result.hardenedSystemPrompt = this.instructionHierarchy.buildHardenedSystemPrompt(
        personaName,
        baseSystemPrompt,
        tenantCustomPrompt,
      );
    }

    return result;
  }

  /**
   * POST-PROCESS: Run safety checks on model output BEFORE returning to user.
   *
   * Pipeline stages:
   * 1. PII scan (detect and optionally redact)
   *
   * @param outputText - Raw model output text
   * @param tenantId - Tenant identifier for audit
   * @returns PostProcessResult with (possibly redacted) text
   */
  /**
   * SEC-LOW-088 (2026-08-23 scan №33): scan-only gate for UNTRUSTED CONTEXT
   * strings bound for the model — replayed conversation history and tool
   * results. preProcess runs the full pipeline on the USER message only;
   * these surfaces previously entered the prompt unfiltered, an indirect
   * prompt-injection lane (tenant-editable strings like tank names riding
   * stored data). Scanning is non-destructive: the CALLER decides the
   * containment (drop the history entry / replace the tool payload).
   */
  scanUntrustedContext(text: string, tenantId: string): boolean {
    if (!this.config.inputFilterEnabled) {
      return true;
    }
    return this.inputFilter.scanInput(text, tenantId).safe;
  }

  postProcess(outputText: string, tenantId: string): PostProcessResult {
    const result: PostProcessResult = {
      outputText,
      piiRedacted: false,
    };

    // ── Stage 1: PII scan ──
    if (this.config.outputPiiScanEnabled) {
      if (this.config.outputPiiAutoRedact) {
        const redactResult: PiiRedactResult = this.outputPiiScanner.redact(outputText, tenantId);
        result.outputText = redactResult.redactedText;
        result.piiScan = redactResult.scanResult;
        result.piiRedacted = redactResult.scanResult.hasPii;
      } else {
        result.piiScan = this.outputPiiScanner.scan(outputText);
      }
    }

    return result;
  }

  /**
   * TOOL VALIDATION: Validate tool call parameters and URLs before execution.
   *
   * Pipeline stages:
   * 1. JSON schema validation
   * 2. SSRF validation for any URL parameters
   *
   * @param toolName - Name of the tool being called
   * @param params - Tool call parameters from the LLM
   * @param schema - The tool's registered JSON Schema
   * @param urls - Optional list of URLs found in tool parameters
   * @returns ToolCallValidationResult with safety verdict
   */
  async validateToolCall(
    toolName: string,
    params: unknown,
    schema: Record<string, unknown>,
    urls?: string[],
  ): Promise<ToolCallValidationResult> {
    const result: ToolCallValidationResult = { allowed: true };

    // ── Stage 1: Schema validation ──
    if (this.config.toolSchemaValidationEnabled) {
      const schemaResult = this.toolSchemaValidator.validate(toolName, params, schema);
      result.schemaValidation = schemaResult;

      if (!schemaResult.valid) {
        result.allowed = false;
        result.rejectionReason = `Schema validation failed: ${schemaResult.errors.join('; ')}`;
        return result;
      }
    }

    // ── Stage 2: SSRF validation ──
    if (this.config.ssrfValidationEnabled && urls && urls.length > 0) {
      for (const url of urls) {
        const ssrfResult = await this.ssrfValidator.validateUrl(url);
        if (!ssrfResult.safe) {
          result.allowed = false;
          result.ssrfValidation = ssrfResult;
          result.rejectionReason = `SSRF validation failed for URL: ${ssrfResult.reason}`;
          return result;
        }
        // Store last successful validation result
        result.ssrfValidation = ssrfResult;
      }
    }

    return result;
  }
}
