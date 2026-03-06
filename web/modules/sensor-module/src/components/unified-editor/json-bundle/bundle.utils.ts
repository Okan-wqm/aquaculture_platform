/**
 * JSON Bundle Utilities - Serialize/Deserialize/Sanitize
 *
 * SECURITY:
 *   - Deep object traversal to remove __proto__, constructor, prototype
 *   - No eval, no Function constructor, no dynamic imports in values
 *   - deployConfig field stripped (SSRF vector)
 *   - Max bundle size: 1MB
 *   - v1 -> v2 migration support
 */

import type {
  STBundle,
  STBundleProgram,
  STBundleVariable,
  STBundleStep,
  STBundleTransition,
  STBundleExportInfo,
} from '../../../types/st-editor.types';

// ============================================================================
// Constants
// ============================================================================

const MAX_BUNDLE_SIZE = 1_048_576; // 1MB
const MAX_OBJECT_DEPTH = 50;
const SCHEMA_URL = 'https://suderra.com/schemas/automation-bundle-v2.json';
const BUNDLE_VERSION = '2.0' as const;
const SCHEMA_VERSION = '2.0' as const;

/** Keys that could cause prototype pollution */
const DANGEROUS_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);

/** Fields rejected in v2 (security) */
const REJECTED_TOP_LEVEL_FIELDS = new Set([
  'deployConfig',
  'deployTarget',
  'targetPlcAddress',
  'targetPlcPort',
  'targetPlcModel',
  'targetPlcProtocol',
  'transpiledJs',
  'transpiledCondition',
]);

/** Patterns that indicate code injection attempts in string values */
const DANGEROUS_VALUE_PATTERNS = [
  /\beval\s*\(/i,
  /\bnew\s+Function\s*\(/i,
  /\bimport\s*\(/i,
  /\brequire\s*\(/i,
  /javascript\s*:/i,
  /data\s*:\s*text\/html/i,
];

// ============================================================================
// Types
// ============================================================================

export interface BundleValidationError {
  field: string;
  message: string;
}

export interface BundleValidationResult {
  valid: boolean;
  errors: BundleValidationError[];
  warnings: string[];
  bundle?: STBundle;
}

export interface BundleSecurityReport {
  strippedKeys: string[];
  strippedFields: string[];
  suspiciousValues: string[];
}

// ============================================================================
// Deep Sanitization
// ============================================================================

/**
 * Deep-sanitize an object by removing dangerous keys.
 * Returns a new object (does NOT mutate input).
 */
function deepSanitize(
  obj: unknown,
  depth = 0,
  report?: BundleSecurityReport,
  path = '',
): unknown {
  if (depth > MAX_OBJECT_DEPTH) return undefined;
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    // Check for code injection patterns
    for (const pattern of DANGEROUS_VALUE_PATTERNS) {
      if (pattern.test(obj)) {
        report?.suspiciousValues.push(`${path}: contains suspicious pattern`);
      }
    }
    return obj;
  }

  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map((item, i) =>
      deepSanitize(item, depth + 1, report, `${path}[${i}]`),
    );
  }

  const clean: Record<string, unknown> = {};
  const record = obj as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (DANGEROUS_KEYS.has(key)) {
      report?.strippedKeys.push(`${path}.${key}`);
      continue;
    }
    if (depth === 0 && REJECTED_TOP_LEVEL_FIELDS.has(key)) {
      report?.strippedFields.push(key);
      continue;
    }
    clean[key] = deepSanitize(record[key], depth + 1, report, `${path}.${key}`);
  }

  return clean;
}

// ============================================================================
// Validation Helpers
// ============================================================================

function validateProgram(
  program: unknown,
  errors: BundleValidationError[],
): program is STBundleProgram {
  if (!program || typeof program !== 'object') {
    errors.push({ field: 'program', message: 'Program field is required and must be an object' });
    return false;
  }

  const p = program as Record<string, unknown>;

  if (typeof p.programCode !== 'string' || p.programCode.length === 0 || p.programCode.length > 100) {
    errors.push({ field: 'program.programCode', message: 'programCode must be a non-empty string (max 100 chars)' });
  }

  if (typeof p.programName !== 'string' || p.programName.length === 0) {
    errors.push({ field: 'program.programName', message: 'programName is required' });
  }

  if (typeof p.programType !== 'string' || !['ST', 'SFC', 'FBD', 'LD'].includes(p.programType)) {
    errors.push({ field: 'program.programType', message: 'programType must be ST, SFC, FBD, or LD' });
  }

  if (typeof p.executionMode !== 'string' || !['CYCLIC', 'EVENT'].includes(p.executionMode)) {
    errors.push({ field: 'program.executionMode', message: 'executionMode must be CYCLIC or EVENT' });
  }

  if (typeof p.structuredTextCode !== 'string') {
    errors.push({ field: 'program.structuredTextCode', message: 'structuredTextCode is required' });
  } else if (p.structuredTextCode.length > 524_288) {
    errors.push({ field: 'program.structuredTextCode', message: 'structuredTextCode exceeds 512KB limit' });
  }

  if (p.scanCycleMs !== undefined) {
    if (typeof p.scanCycleMs !== 'number' || p.scanCycleMs < 1 || p.scanCycleMs > 60000) {
      errors.push({ field: 'program.scanCycleMs', message: 'scanCycleMs must be between 1 and 60000' });
    }
  }

  return errors.length === 0;
}

function validateVariables(
  variables: unknown,
  errors: BundleValidationError[],
): variables is STBundleVariable[] {
  if (!Array.isArray(variables)) {
    errors.push({ field: 'variables', message: 'variables must be an array' });
    return false;
  }

  if (variables.length > 500) {
    errors.push({ field: 'variables', message: 'Maximum 500 variables allowed' });
    return false;
  }

  for (let i = 0; i < variables.length; i++) {
    const v = variables[i];
    if (!v || typeof v !== 'object') {
      errors.push({ field: `variables[${i}]`, message: 'Each variable must be an object' });
      continue;
    }
    const vr = v as Record<string, unknown>;
    if (typeof vr.varName !== 'string' || vr.varName.length === 0) {
      errors.push({ field: `variables[${i}].varName`, message: 'varName is required' });
    }
    if (typeof vr.dataType !== 'string') {
      errors.push({ field: `variables[${i}].dataType`, message: 'dataType is required' });
    }
    if (typeof vr.scope !== 'string') {
      errors.push({ field: `variables[${i}].scope`, message: 'scope is required' });
    }
  }

  return errors.length === 0;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Validate that a JSON string does not exceed the 1MB size limit.
 */
export function validateBundleSize(json: string): boolean {
  return new TextEncoder().encode(json).length <= MAX_BUNDLE_SIZE;
}

/**
 * Sanitize a raw parsed object, stripping dangerous and rejected fields.
 * Returns the sanitized bundle and a security report.
 */
export function sanitizeBundle(raw: unknown): {
  sanitized: unknown;
  report: BundleSecurityReport;
} {
  const report: BundleSecurityReport = {
    strippedKeys: [],
    strippedFields: [],
    suspiciousValues: [],
  };

  const sanitized = deepSanitize(raw, 0, report);
  return { sanitized, report };
}

/**
 * Serialize program data into a JSON bundle string.
 */
export function serializeBundle(
  program: STBundleProgram,
  variables: STBundleVariable[],
  steps: STBundleStep[],
  transitions: STBundleTransition[],
  exportedBy: string,
): string {
  const bundle: STBundle = {
    $schema: SCHEMA_URL,
    bundleVersion: BUNDLE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    exportedBy,
    exportedFrom: {
      platform: 'suderra-aquaculture',
      version: '1.5.0',
    },
    program,
    variables,
    steps,
    transitions,
  };

  return JSON.stringify(bundle, null, 2);
}

/**
 * Deserialize and validate a JSON string into an STBundle.
 * Performs sanitization, size validation, and structural validation.
 */
export function deserializeBundle(json: string): BundleValidationResult {
  const errors: BundleValidationError[] = [];
  const warnings: string[] = [];

  // Size check
  if (!validateBundleSize(json)) {
    return {
      valid: false,
      errors: [{ field: '_size', message: 'Bundle exceeds maximum size of 1MB' }],
      warnings: [],
    };
  }

  // Parse JSON
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        field: '_parse',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'parse error'}`,
      }],
      warnings: [],
    };
  }

  if (!raw || typeof raw !== 'object') {
    return {
      valid: false,
      errors: [{ field: '_root', message: 'Bundle must be a JSON object' }],
      warnings: [],
    };
  }

  // Sanitize
  const { sanitized, report } = sanitizeBundle(raw);
  const obj = sanitized as Record<string, unknown>;

  // Security warnings
  if (report.strippedKeys.length > 0) {
    warnings.push(`Stripped dangerous keys: ${report.strippedKeys.join(', ')}`);
  }
  if (report.strippedFields.length > 0) {
    warnings.push(`Stripped rejected fields: ${report.strippedFields.join(', ')}`);
  }
  if (report.suspiciousValues.length > 0) {
    warnings.push(`Suspicious values detected: ${report.suspiciousValues.join(', ')}`);
  }

  // Version checks
  if (obj.bundleVersion !== '2.0') {
    // Try v1 migration
    if (obj.bundleVersion === '1.0' || !obj.bundleVersion) {
      const migrated = migrateBundleV1toV2(obj);
      if (migrated) {
        warnings.push('Bundle migrated from v1 to v2 format');
        return deserializeBundle(JSON.stringify(migrated));
      }
    }
    errors.push({ field: 'bundleVersion', message: 'bundleVersion must be "2.0"' });
  }

  if (obj.schemaVersion !== '2.0') {
    errors.push({ field: 'schemaVersion', message: 'schemaVersion must be "2.0"' });
  }

  // Validate program
  validateProgram(obj.program, errors);

  // Validate variables
  if (obj.variables !== undefined) {
    validateVariables(obj.variables, errors);
  }

  // Validate steps (optional array)
  if (obj.steps !== undefined && !Array.isArray(obj.steps)) {
    errors.push({ field: 'steps', message: 'steps must be an array' });
  }
  if (Array.isArray(obj.steps) && obj.steps.length > 200) {
    errors.push({ field: 'steps', message: 'Maximum 200 steps allowed' });
  }

  // Validate transitions (optional array)
  if (obj.transitions !== undefined && !Array.isArray(obj.transitions)) {
    errors.push({ field: 'transitions', message: 'transitions must be an array' });
  }
  if (Array.isArray(obj.transitions) && obj.transitions.length > 500) {
    errors.push({ field: 'transitions', message: 'Maximum 500 transitions allowed' });
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  const bundle: STBundle = {
    $schema: (obj.$schema as string) || SCHEMA_URL,
    bundleVersion: BUNDLE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: (obj.exportedAt as string) || new Date().toISOString(),
    exportedBy: (obj.exportedBy as string) || 'unknown',
    exportedFrom: (obj.exportedFrom as STBundleExportInfo) || {
      platform: 'unknown',
      version: 'unknown',
    },
    program: obj.program as STBundleProgram,
    variables: (obj.variables as STBundleVariable[]) || [],
    steps: (obj.steps as STBundleStep[]) || [],
    transitions: (obj.transitions as STBundleTransition[]) || [],
  };

  return { valid: true, errors: [], warnings, bundle };
}

/**
 * Migrate a v1 bundle to v2 format.
 * v1 had different field names and included deployConfig.
 */
export function migrateBundleV1toV2(v1: Record<string, unknown>): STBundle | null {
  try {
    const program = v1.program as Record<string, unknown> | undefined;
    if (!program) return null;

    // Map old execution mode names to v2
    let executionMode = (program.executionMode as string) || 'CYCLIC';
    if (executionMode === 'CONTINUOUS') executionMode = 'CYCLIC';
    if (executionMode === 'TRIGGERED') executionMode = 'EVENT';
    // SCHEDULED was removed in v2 - map to CYCLIC
    if (executionMode === 'SCHEDULED') executionMode = 'CYCLIC';

    const migratedProgram: STBundleProgram = {
      programCode: (program.programCode as string) || (program.code as string) || 'MIGRATED_001',
      programName: (program.programName as string) || (program.name as string) || 'Migrated Program',
      programType: (program.programType as string) || 'ST',
      executionMode,
      scanCycleMs: (program.scanCycleMs as number) || 100,
      structuredTextCode: (program.structuredTextCode as string) || (program.code as string) || '',
      description: program.description as string | undefined,
      category: program.category as string | undefined,
    };

    return {
      $schema: 'https://suderra.com/schemas/automation-bundle-v2.json',
      bundleVersion: '2.0',
      schemaVersion: '2.0',
      exportedAt: (v1.exportedAt as string) || new Date().toISOString(),
      exportedBy: (v1.exportedBy as string) || 'migration',
      exportedFrom: (v1.exportedFrom as STBundleExportInfo) || {
        platform: 'suderra-aquaculture',
        version: 'v1-migrated',
      },
      program: migratedProgram,
      variables: (v1.variables as STBundleVariable[]) || [],
      steps: (v1.steps as STBundleStep[]) || [],
      transitions: (v1.transitions as STBundleTransition[]) || [],
    };
  } catch {
    return null;
  }
}

/**
 * Format file size in human-readable form.
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
