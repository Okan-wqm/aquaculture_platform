/**
 * @module OutputPiiScannerService
 * @description Scans AI model responses for PII (Personally Identifiable
 * Information) and optionally redacts detected instances.
 *
 * Detection categories:
 * - Email addresses
 * - Phone numbers (international formats)
 * - SSN / National ID patterns
 * - Credit card numbers (with Luhn validation)
 * - UUIDs (potential tenant/user ID leakage)
 *
 * IMPORTANT: This is a post-processing safety net. The model should be
 * instructed NOT to output PII via the system prompt. This scanner catches
 * cases where the model ignores that instruction.
 *
 * @see MSG-HIGH-032 (output PII filter finding)
 */
import { Injectable, Logger } from '@nestjs/common';

// ── Result Types ──

/** A single detected PII occurrence. */
export interface PiiDetection {
  /** Category of PII detected. */
  type: PiiType;
  /** Start index in the original string. */
  startIndex: number;
  /** End index in the original string. */
  endIndex: number;
  /** The matched text (for logging — ONLY use in audit, never expose to users). */
  matchedText: string;
}

/** Supported PII categories. */
export type PiiType = 'email' | 'phone' | 'ssn' | 'credit_card' | 'uuid';

/** Result of scanning text for PII. */
export interface PiiScanResult {
  /** Whether any PII was detected. */
  hasPii: boolean;
  /** List of detected PII instances. */
  detections: PiiDetection[];
  /** Count by type for audit logging. */
  countByType: Partial<Record<PiiType, number>>;
}

/** Result of redacting PII from text. */
export interface PiiRedactResult {
  /** The redacted text with PII replaced by [REDACTED]. */
  redactedText: string;
  /** Scan result with detection details. */
  scanResult: PiiScanResult;
}

// ── Pattern Definitions ──

interface PiiPattern {
  type: PiiType;
  regex: RegExp;
  /** Optional post-match validator (e.g., Luhn check for credit cards). */
  validate?: (match: string) => boolean;
}

/**
 * PII detection patterns. Each regex uses the global flag for findAll.
 *
 * IMPORTANT: These patterns are applied to model OUTPUT only, not user input.
 * False positives are acceptable here (safety > convenience).
 */
const PII_PATTERNS: PiiPattern[] = [
  // Email: standard RFC 5322 simplified pattern
  {
    type: 'email',
    regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  },

  // Phone: international formats with optional country code
  // Matches: +1-555-123-4567, (555) 123-4567, +90 532 123 45 67, etc.
  {
    type: 'phone',
    regex: /(?:\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{2,4}[\s.-]?\d{2,4}(?:[\s.-]?\d{2,4})?/g,
    // WHY: Post-validation filters out numbers that are too short to be phones
    validate: (match: string): boolean => {
      const digitsOnly = match.replace(/\D/g, '');
      return digitsOnly.length >= 7 && digitsOnly.length <= 15;
    },
  },

  // SSN: US Social Security Number (XXX-XX-XXXX)
  {
    type: 'ssn',
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
  },

  // Credit Card: major card formats (13-19 digits, optionally separated)
  {
    type: 'credit_card',
    regex: /\b(?:\d[ -]*?){13,19}\b/g,
    validate: (match: string): boolean => {
      const digitsOnly = match.replace(/\D/g, '');
      if (digitsOnly.length < 13 || digitsOnly.length > 19) return false;
      return luhnCheck(digitsOnly);
    },
  },

  // UUID: potential tenant/user ID leakage
  // WHY: UUIDs in AI responses may leak internal identifiers
  {
    type: 'uuid',
    regex: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  },
];

/**
 * Luhn algorithm for credit card number validation.
 * Reduces false positives by verifying the checksum digit.
 *
 * @param digits - String of digits only (no separators)
 * @returns true if the number passes the Luhn check
 */
function luhnCheck(digits: string): boolean {
  let sum = 0;
  let alternate = false;

  for (let i = digits.length - 1; i >= 0; i--) {
    const digit = digits[i];
    if (digit === undefined) {
      return false;
    }
    let n = Number.parseInt(digit, 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }

  return sum % 10 === 0;
}

@Injectable()
export class OutputPiiScannerService {
  private readonly logger = new Logger(OutputPiiScannerService.name);

  /**
   * Scan text for PII occurrences.
   *
   * @param text - Text to scan (typically AI model output)
   * @returns PiiScanResult with all detected PII instances
   */
  scan(text: string): PiiScanResult {
    const detections: PiiDetection[] = [];

    for (const pattern of PII_PATTERNS) {
      // WHY: Reset lastIndex before each scan — regex with 'g' flag is stateful
      pattern.regex.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = pattern.regex.exec(text)) !== null) {
        const matchedText = match[0];

        // Apply optional post-match validation
        if (pattern.validate && !pattern.validate(matchedText)) {
          continue;
        }

        detections.push({
          type: pattern.type,
          startIndex: match.index,
          endIndex: match.index + matchedText.length,
          matchedText,
        });
      }
    }

    // ── Build count-by-type ──
    const countByType: Partial<Record<PiiType, number>> = {};
    for (const detection of detections) {
      countByType[detection.type] = (countByType[detection.type] ?? 0) + 1;
    }

    return {
      hasPii: detections.length > 0,
      detections,
      countByType,
    };
  }

  /**
   * Scan and redact PII from text, replacing detected instances with [REDACTED].
   *
   * @param text - Text to scan and redact
   * @param tenantId - Tenant ID for audit logging
   * @returns PiiRedactResult with redacted text and scan details
   */
  redact(text: string, tenantId: string): PiiRedactResult {
    const scanResult = this.scan(text);

    if (!scanResult.hasPii) {
      return { redactedText: text, scanResult };
    }

    // SECURITY: Log PII detection counts but NEVER log the actual PII values.
    // The matchedText field exists only for internal audit — it must never
    // appear in logs.
    this.logger.warn(
      `SECURITY: PII detected in AI output for tenant ${tenantId}. ` +
        `Types: ${JSON.stringify(scanResult.countByType)}`,
    );

    // ── Redact by replacing matched ranges ──
    // Sort detections by startIndex descending so replacements don't shift indices
    const sorted = [...scanResult.detections].sort((a, b) => b.startIndex - a.startIndex);

    let redactedText = text;
    for (const detection of sorted) {
      redactedText =
        redactedText.slice(0, detection.startIndex) +
        '[REDACTED]' +
        redactedText.slice(detection.endIndex);
    }

    return { redactedText, scanResult };
  }
}
