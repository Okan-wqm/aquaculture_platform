/**
 * @module InputFilterService
 * @description Detects jailbreak attempts and prompt injection patterns
 * in user messages before they reach the LLM.
 *
 * Detection layers:
 * 1. Known jailbreak string patterns (case-insensitive, Unicode-normalized)
 * 2. Base64-encoded payload smuggling
 * 3. Unicode homoglyph normalization (prevents bypasses via look-alike chars)
 *
 * IMPORTANT: Critical patterns throw; suspicious patterns log and flag.
 * The service does NOT silently drop messages — callers decide the policy.
 *
 * @see MSG-CRITICAL-030 (jailbreak detection finding)
 */
import { Injectable, Logger } from '@nestjs/common';

// ── Result Types ──

/** Result of scanning a single input string. */
export interface InputFilterResult {
  /** Whether the input passed all safety checks. */
  safe: boolean;
  /** Human-readable reason if not safe. */
  reason?: string;
  /** List of pattern names that matched. */
  flaggedPatterns: string[];
  /** Severity: 'critical' triggers immediate block, 'suspicious' is warn-only. */
  severity: 'clean' | 'suspicious' | 'critical';
}

// ── Pattern Definitions ──

interface PatternDef {
  /** Pattern name for logging/audit. */
  name: string;
  /** Regex applied after normalization. MUST use 'i' flag. */
  regex: RegExp;
  /** Severity level. */
  severity: 'suspicious' | 'critical';
}

/**
 * SECURITY: All patterns are applied AFTER Unicode normalization and
 * whitespace collapsing so homoglyph and spacing bypasses are ineffective.
 */
const JAILBREAK_PATTERNS: PatternDef[] = [
  // ── Critical: Direct override attempts ──
  {
    name: 'ignore_previous_instructions',
    regex: /ignore\s+(all\s+)?(previous|prior|above|system)\s+instructions/i,
    severity: 'critical',
  },
  {
    name: 'ignore_all_instructions',
    regex: /ignore\s+all\s+instructions/i,
    severity: 'critical',
  },
  {
    name: 'developer_mode',
    regex: /\bdeveloper\s+mode\s+(enabled|activated|on)\b/i,
    severity: 'critical',
  },
  {
    name: 'dan_jailbreak',
    regex: /\bDAN\b.*\b(do\s+anything\s+now|jailbreak)\b/i,
    severity: 'critical',
  },
  {
    name: 'you_are_now',
    regex: /\byou\s+are\s+now\b.*\b(unrestricted|unfiltered|evil|DAN|jailbroken)\b/i,
    severity: 'critical',
  },
  {
    name: 'system_prompt_extraction',
    regex: /\b(reveal|show|print|output|repeat|display)\b.*\b(system\s+prompt|instructions|rules)\b/i,
    severity: 'critical',
  },

  // ── Suspicious: Probing attempts ──
  {
    name: 'system_prompt_mention',
    regex: /\bsystem\s+prompt\b/i,
    severity: 'suspicious',
  },
  {
    name: 'pretend_roleplay',
    regex: /\b(pretend|act\s+as\s+if)\b.*\b(no\s+rules|no\s+restrictions|no\s+limits)\b/i,
    severity: 'suspicious',
  },
  {
    name: 'override_instruction',
    regex: /\b(override|bypass|disable)\b.*\b(safety|filter|guard|restriction|moderation)\b/i,
    severity: 'suspicious',
  },
  {
    name: 'prompt_injection_delimiters',
    regex: /\[\/?(SYSTEM|INST|SYS)\]/i,
    severity: 'suspicious',
  },
];

/**
 * Unicode homoglyph map: maps visually similar characters to their ASCII
 * equivalents. This prevents attackers from using Cyrillic 'а' instead of
 * Latin 'a' to bypass pattern matching.
 *
 * SECURITY: This is a defense-in-depth layer. The map covers the most
 * common homoglyphs; it is not exhaustive. Full NFKC normalization is
 * applied first, which handles many combining character attacks.
 */
const HOMOGLYPH_MAP: Record<string, string> = {
  '\u0430': 'a', // Cyrillic а
  '\u0435': 'e', // Cyrillic е
  '\u043E': 'o', // Cyrillic о
  '\u0440': 'p', // Cyrillic р
  '\u0441': 'c', // Cyrillic с
  '\u0443': 'y', // Cyrillic у
  '\u0445': 'x', // Cyrillic х
  '\u0456': 'i', // Cyrillic і
  '\u0455': 's', // Cyrillic ѕ
  '\u04BB': 'h', // Cyrillic һ
  '\u0501': 'd', // Cyrillic ԁ
  '\u051B': 'q', // Cyrillic ԛ
  '\u0261': 'g', // Latin Small Letter Script G
  '\uFF41': 'a', // Fullwidth a
  '\uFF45': 'e', // Fullwidth e
  '\uFF49': 'i', // Fullwidth i
  '\uFF4F': 'o', // Fullwidth o
  '\uFF55': 'u', // Fullwidth u
};

@Injectable()
export class InputFilterService {
  private readonly logger = new Logger(InputFilterService.name);

  /**
   * Scan user input for jailbreak patterns and prompt injection attempts.
   *
   * @param input - Raw user message text
   * @param tenantId - Tenant ID for audit logging
   * @returns InputFilterResult with safety verdict and matched patterns
   */
  scanInput(input: string, tenantId: string): InputFilterResult {
    const normalized = this.normalize(input);
    const flaggedPatterns: string[] = [];
    let maxSeverity: 'clean' | 'suspicious' | 'critical' = 'clean';

    // ── Layer 1: Pattern matching on normalized text ──
    for (const pattern of JAILBREAK_PATTERNS) {
      if (pattern.regex.test(normalized)) {
        flaggedPatterns.push(pattern.name);
        if (
          pattern.severity === 'critical' ||
          (pattern.severity === 'suspicious' && maxSeverity === 'clean')
        ) {
          maxSeverity = pattern.severity;
        }
      }
    }

    // ── Layer 2: Base64 smuggling detection ──
    const base64Result = this.detectBase64Smuggling(input);
    if (base64Result) {
      flaggedPatterns.push('base64_smuggling');
      // Re-scan decoded content for jailbreak patterns
      const decodedNormalized = this.normalize(base64Result);
      for (const pattern of JAILBREAK_PATTERNS) {
        if (pattern.regex.test(decodedNormalized)) {
          flaggedPatterns.push(`base64_decoded:${pattern.name}`);
          maxSeverity = 'critical'; // Encoded jailbreak is always critical
        }
      }
      if (maxSeverity === 'clean') {
        maxSeverity = 'suspicious';
      }
    }

    // ── Build result ──
    const safe = maxSeverity !== 'critical';
    const reason = !safe
      ? `Critical jailbreak pattern detected: ${flaggedPatterns.join(', ')}`
      : maxSeverity === 'suspicious'
        ? `Suspicious patterns flagged: ${flaggedPatterns.join(', ')}`
        : undefined;

    // ── Logging ──
    if (maxSeverity === 'critical') {
      // SECURITY: Do NOT log the actual input — it may contain attack payloads
      // that could be exploited via log injection.
      this.logger.warn(
        `SECURITY: Critical jailbreak pattern blocked for tenant ${tenantId}. ` +
        `Patterns: ${flaggedPatterns.join(', ')}`,
      );
    } else if (maxSeverity === 'suspicious') {
      this.logger.log(
        `Suspicious input patterns for tenant ${tenantId}: ${flaggedPatterns.join(', ')}`,
      );
    }

    return { safe, reason, flaggedPatterns, severity: maxSeverity };
  }

  /**
   * Normalize text for pattern matching:
   * 1. NFKC Unicode normalization (collapses compatibility chars)
   * 2. Homoglyph replacement (Cyrillic/fullwidth -> ASCII)
   * 3. Whitespace collapsing (multiple spaces/tabs -> single space)
   *
   * @param text - Raw text to normalize
   * @returns Normalized text suitable for pattern matching
   */
  private normalize(text: string): string {
    // Step 1: NFKC normalization
    let result = text.normalize('NFKC');

    // Step 2: Homoglyph replacement
    for (const [homoglyph, ascii] of Object.entries(HOMOGLYPH_MAP)) {
      // WHY: replaceAll is safe here — homoglyphs are single characters
      result = result.split(homoglyph).join(ascii);
    }

    // Step 3: Collapse whitespace
    result = result.replace(/\s+/g, ' ').trim();

    return result;
  }

  /**
   * Detect Base64-encoded payload smuggling.
   * Looks for Base64 strings >= 20 chars (likely encoded instructions)
   * and attempts to decode them.
   *
   * @param text - Raw input text
   * @returns Decoded Base64 content if found, null otherwise
   */
  private detectBase64Smuggling(text: string): string | null {
    // Match Base64 strings that are at least 20 chars (short strings are
    // unlikely to be smuggled payloads and would cause false positives).
    const base64Regex = /[A-Za-z0-9+/]{20,}={0,2}/g;
    const matches = text.match(base64Regex);

    if (!matches) {
      return null;
    }

    for (const match of matches) {
      try {
        const decoded = Buffer.from(match, 'base64').toString('utf-8');
        // Check if decoded content looks like text (not binary garbage)
        // WHY: We check for printable ASCII ratio to avoid false positives
        // from legitimate base64 data (images, hashes, etc.)
        const printableRatio =
          decoded.replace(/[^\x20-\x7E]/g, '').length / decoded.length;
        if (printableRatio > 0.8 && decoded.length > 10) {
          return decoded;
        }
      } catch {
        // Not valid base64 — skip
      }
    }

    return null;
  }
}
