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
  /**
   * Whether a match can contain a whitespace character, and around which
   * text: `left` is tested on the text before the whitespace character,
   * `right` on the text from that character to the end of what has arrived.
   * `right` must also match a prefix of such a continuation (end it with
   * `$`), because the rest of a streamed text is not known yet. `null`: a
   * match never contains whitespace.
   *
   * Required, so a new pattern states it: {@link OutputPiiScannerService.redactStream}
   * releases text only at whitespace no match can cross, and an understated
   * pattern would release a number before it is complete.
   */
  crossesWhitespace: { left: RegExp; right: RegExp } | null;
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
    crossesWhitespace: null,
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
    // Its one separator `[\s.-]?` follows a digit or `)` and precedes a digit or `(`.
    crossesWhitespace: { left: /[\d)]$/, right: /^\s(?:[\d(]|$)/ },
  },

  // SSN: US Social Security Number (XXX-XX-XXXX)
  {
    type: 'ssn',
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    crossesWhitespace: null,
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
    // Digits separated by any run of spaces and dashes.
    crossesWhitespace: { left: /\d[ -]*$/, right: /^ [ -]*(?:\d|$)/ },
  },

  // UUID: potential tenant/user ID leakage
  // WHY: UUIDs in AI responses may leak internal identifiers
  {
    type: 'uuid',
    regex: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    crossesWhitespace: null,
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
    let n = parseInt(digits.charAt(i), 10);
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

    return summarize(detections);
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
    this.logDetections(scanResult, tenantId);
    return { redactedText: replaceDetections(text, scanResult.detections), scanResult };
  }

  /**
   * Redact a text that arrives in pieces — a model turn as it streams.
   * Each `push` returns the redacted text that no later piece can change,
   * so it can be shown at once; `end` returns the rest. Everything the
   * stream returns, joined, equals `redact` of the whole text.
   *
   * Text is released only at a whitespace character no PII match can cross
   * (each pattern's `crossesWhitespace`), so a half-written address or
   * phone number is held until it is complete and redacted whole. Matches
   * do not cross a released boundary, so each released segment is scanned
   * on its own.
   *
   * @param tenantId - Tenant ID for audit logging, once, at `end`
   */
  redactStream(tenantId: string): PiiRedactionStream {
    let pending = '';
    // The released raw text's tail: left context for the next boundary.
    let releasedTail = '';
    let releasedLength = 0;
    const detections: PiiDetection[] = [];

    const release = (length: number): string => {
      const segment = pending.slice(0, length);
      pending = pending.slice(length);
      const found = this.scan(segment).detections;
      detections.push(
        ...found.map((d) => ({
          ...d,
          startIndex: d.startIndex + releasedLength,
          endIndex: d.endIndex + releasedLength,
        })),
      );
      releasedLength += length;
      releasedTail = (releasedTail + segment).slice(-RELEASED_TAIL_LENGTH);
      return replaceDetections(segment, found);
    };

    return {
      push: (text: string): string => {
        pending += text;
        const settled = settledLength(releasedTail, pending);
        return settled === 0 ? '' : release(settled);
      },
      end: (): { text: string; scanResult: PiiScanResult } => {
        const text = release(pending.length);
        const scanResult = summarize(detections);
        this.logDetections(scanResult, tenantId);
        return { text, scanResult };
      },
    };
  }

  private logDetections(scanResult: PiiScanResult, tenantId: string): void {
    if (!scanResult.hasPii) {
      return;
    }
    // SECURITY: Log PII detection counts but NEVER log the actual PII values.
    // The matchedText field exists only for internal audit — it must never
    // appear in logs.
    this.logger.warn(
      `SECURITY: PII detected in AI output for tenant ${tenantId}. ` +
        `Types: ${JSON.stringify(scanResult.countByType)}`,
    );
  }
}

/** Incremental redaction of one text; see {@link OutputPiiScannerService.redactStream}. */
export interface PiiRedactionStream {
  /** Append raw text; returns the redacted text that is now settled. */
  push(text: string): string;
  /** No more text: returns the rest, redacted, and the scan of the whole text. */
  end(): { text: string; scanResult: PiiScanResult };
}

/**
 * Left context a boundary check sees from text already released. The
 * longest look-behind is the card pattern's separator run; a run this long
 * between two digits is not a card number anyone writes.
 */
const RELEASED_TAIL_LENGTH = 256;

const WHITESPACE = /\s/;

/**
 * Length of the prefix of `pending` that no further text can change: up to
 * and including the last whitespace character that no pattern's match can
 * cross. 0 when there is none (the whole of `pending` may still change).
 */
function settledLength(releasedTail: string, pending: string): number {
  for (let i = pending.length - 1; i >= 0; i--) {
    if (!WHITESPACE.test(pending.charAt(i))) {
      continue;
    }
    const left = releasedTail + pending.slice(0, i);
    const right = pending.slice(i);
    const crossable = PII_PATTERNS.some(
      ({ crossesWhitespace }) =>
        crossesWhitespace !== null &&
        crossesWhitespace.left.test(left) &&
        crossesWhitespace.right.test(right),
    );
    if (!crossable) {
      return i + 1;
    }
  }
  return 0;
}

/**
 * Replace every detected range with one `[REDACTED]`. Detections of
 * different patterns can overlap (13 Luhn-valid digits are a phone number
 * and a card number); overlapping ranges are merged first, so each stretch
 * of PII is replaced once and the text after it is kept.
 */
function replaceDetections(text: string, detections: readonly PiiDetection[]): string {
  const ranges = [...detections].sort((a, b) => a.startIndex - b.startIndex);
  let out = '';
  // End of the text already copied or replaced.
  let at = 0;
  for (const { startIndex, endIndex } of ranges) {
    if (startIndex < at) {
      // Overlaps the stretch just replaced: that replacement covers it too.
      at = Math.max(at, endIndex);
      continue;
    }
    out += text.slice(at, startIndex) + '[REDACTED]';
    at = endIndex;
  }
  return out + text.slice(at);
}

function summarize(detections: PiiDetection[]): PiiScanResult {
  const countByType: Partial<Record<PiiType, number>> = {};
  for (const detection of detections) {
    countByType[detection.type] = (countByType[detection.type] ?? 0) + 1;
  }
  return { hasPii: detections.length > 0, detections, countByType };
}
