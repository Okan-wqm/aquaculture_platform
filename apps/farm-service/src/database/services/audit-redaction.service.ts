/**
 * AuditRedactionService
 *
 * Normalizes every `changes` and `metadata` payload written to
 * `farm.farm_audit_logs` so that PII, secrets, and oversized JSONB
 * blobs never reach the audit table in their raw form. Called from
 * `AuditLogService.log` (and the CREATE / UPDATE / DELETE / RESTORE
 * helpers that funnel through it) so every write path — direct or
 * handler-initiated — gets the same treatment.
 *
 * Policy axes:
 *
 *   1. **Secret fields** — `password`, `token`, `apiKey`, `secret`,
 *      `privateKey`, `certificate`, connection strings and the
 *      domain-specific IoT credentials are replaced with the
 *      `[REDACTED]` sentinel. These values are never useful for
 *      compliance investigations and their leakage would compromise
 *      the system itself.
 *
 *   2. **Partial-mask PII** — `email` keeps the domain but masks the
 *      local part (`user@example.com` → `***@example.com`). `phone` /
 *      `phoneNumber` / `mobile` keep the last 4 digits
 *      (`+15551234567` → `***4567`). The retained segments let an
 *      auditor recognise whether a complaint is about the right
 *      person without leaking the full identifier.
 *
 *   3. **Hash full-PII** — `ssn`, `nationalId`, `passportNumber`,
 *      `driverLicense`, `creditCard`, `iban`, `bankAccount`,
 *      `routingNumber`, `dateOfBirth`, `firstName`, `lastName`,
 *      `address` are replaced with a deterministic SHA-256 hash
 *      (truncated to 16 hex chars). The hash is stable across runs
 *      so correlation across audit rows still works; the raw value
 *      never lands in the table.
 *
 *   4. **Metadata normalization** — `ipAddress` is truncated to its
 *      /24 subnet for IPv4 or /48 for IPv6 (per GDPR Recital 30
 *      anonymization guidance). `userAgent` is reduced to a coarse
 *      browser family (Chrome / Firefox / Safari / Edge / Mobile /
 *      Other). `correlationId` and `source` are passed through
 *      unmodified — they are operational identifiers, not PII.
 *
 *   5. **Oversized JSONB** — any serialized `before` / `after`
 *      snapshot larger than `AUDIT_REDACTION_MAX_PAYLOAD_BYTES`
 *      (default 5120 = 5 KB) is replaced with
 *      `{ __redacted: 'truncated', bytes: N, sha256: <hex> }`. The
 *      hash preserves identity so two identical oversized payloads
 *      de-duplicate in a simple group-by, and the byte count lets
 *      operators diagnose growth.
 *
 * Phase 2.5 of the "Farm modülü kalan kör noktalar" plan. Closes
 * Girdi 15-B17.
 */
import { createHash } from 'crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuditChanges, AuditMetadata } from '../entities/audit-log.entity';

/** Fields whose raw value is never useful in an audit — always redact. */
const SECRET_FIELDS: ReadonlySet<string> = new Set([
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'apiKey',
  'apiSecret',
  'clientSecret',
  'mfaSecret',
  'cvv',
  'privateKey',
  'clientPrivateKey',
  'clientCertificate',
  'serverCertificate',
  'certificate',
  'encryptionKey',
  'provisioningToken',
  'mqttPasswordHash',
  'connectionString',
  'databaseUrl',
  'redisUrl',
  'natsUrl',
  'appKey',
]);

/** Fields that keep the domain but mask the local part. */
const EMAIL_FIELDS: ReadonlySet<string> = new Set(['email']);

/** Fields that keep the last four digits and mask the rest. */
const PHONE_FIELDS: ReadonlySet<string> = new Set([
  'phone',
  'phoneNumber',
  'mobile',
]);

/** Fields that get SHA-256-hashed — raw value never leaks. */
const HASHED_PII_FIELDS: ReadonlySet<string> = new Set([
  'firstName',
  'lastName',
  'ssn',
  'socialSecurityNumber',
  'dateOfBirth',
  'dob',
  'address',
  'nationalId',
  'passportNumber',
  'driverLicense',
  'creditCard',
  'cardNumber',
  'bankAccount',
  'iban',
  'routingNumber',
  'accountNumber',
]);

const DEFAULT_MAX_PAYLOAD_BYTES = 5 * 1024;
const REDACTED_MARKER = '[REDACTED]';

export interface RedactedChanges {
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  changedFields?: string[];
}

export interface RedactedMetadata {
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
  source?: string;
}

@Injectable()
export class AuditRedactionService {
  private readonly logger = new Logger(AuditRedactionService.name);
  private readonly maxPayloadBytes: number;

  constructor(configService?: ConfigService) {
    const raw = configService?.get<number | string>(
      'AUDIT_REDACTION_MAX_PAYLOAD_BYTES',
    );
    const parsed = typeof raw === 'string' ? Number(raw) : raw;
    this.maxPayloadBytes =
      typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0
        ? parsed
        : DEFAULT_MAX_PAYLOAD_BYTES;
  }

  /**
   * Redact an entire `AuditChanges` payload. Both `before` and `after`
   * are walked recursively; field-level policy is applied per key and
   * the whole object is replaced with a hash if it exceeds the size
   * threshold after field-level redaction.
   */
  redactChanges(changes: AuditChanges | undefined): RedactedChanges | undefined {
    if (!changes) return undefined;

    const redacted: RedactedChanges = {};
    if (changes.before !== undefined) {
      redacted.before = this.redactPayload(changes.before);
    }
    if (changes.after !== undefined) {
      redacted.after = this.redactPayload(changes.after);
    }
    if (changes.changedFields) {
      // changedFields lists field names only — safe as-is.
      redacted.changedFields = [...changes.changedFields];
    }
    return redacted;
  }

  /**
   * Redact metadata written alongside the audit row. Operates on a
   * copy so the caller's original object is not mutated.
   */
  redactMetadata(metadata: AuditMetadata | undefined): RedactedMetadata | undefined {
    if (!metadata) return undefined;
    return {
      ipAddress: metadata.ipAddress
        ? this.anonymizeIp(metadata.ipAddress)
        : undefined,
      userAgent: metadata.userAgent
        ? this.extractBrowserFamily(metadata.userAgent)
        : undefined,
      correlationId: metadata.correlationId,
      source: metadata.source,
    };
  }

  /**
   * Redact an arbitrary object — applies field-level policy then
   * checks the total serialized size against the max payload byte
   * threshold. An oversized object is collapsed into a
   * `{ __redacted: 'truncated', bytes, sha256 }` summary.
   */
  redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
    const fieldRedacted = this.walk(payload) as Record<string, unknown>;
    const serialized = this.safeStringify(fieldRedacted);
    if (Buffer.byteLength(serialized, 'utf8') > this.maxPayloadBytes) {
      return {
        __redacted: 'truncated',
        bytes: Buffer.byteLength(serialized, 'utf8'),
        sha256: createHash('sha256').update(serialized).digest('hex'),
      };
    }
    return fieldRedacted;
  }

  /** Visible for testing — anonymize to /24 (IPv4) or /48 (IPv6). */
  anonymizeIp(ip: string): string {
    if (!ip) return ip;
    // IPv6 detection — contains a colon.
    if (ip.includes(':')) {
      const segments = ip.split(':');
      // Keep the first three segments (/48) and zero the rest.
      const kept = segments.slice(0, 3).map((s) => s.toLowerCase());
      return `${kept.join(':')}::/48`;
    }
    const parts = ip.split('.');
    if (parts.length !== 4) return '[INVALID_IP]';
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }

  /** Visible for testing — reduce user-agent to coarse family. */
  extractBrowserFamily(userAgent: string): string {
    const ua = userAgent;
    if (/Edg\//.test(ua)) return 'Edge';
    if (/OPR\/|Opera\//.test(ua)) return 'Opera';
    if (/Chrome\/\d+/.test(ua)) return 'Chrome';
    if (/Firefox\/\d+/.test(ua)) return 'Firefox';
    if (/Safari\/\d+/.test(ua) && !/Chrome\/\d+/.test(ua)) return 'Safari';
    if (/Mobile|Android|iPhone|iPad/.test(ua)) return 'Mobile';
    return 'Other';
  }

  private walk(node: unknown, depth = 0): unknown {
    // Depth guard against pathological cyclical inputs — 20 levels of
    // nesting is plenty for any domain entity and keeps the recursion
    // bounded.
    if (depth > 20) return '[DEPTH_LIMIT]';
    if (node === null || node === undefined) return node;
    if (Array.isArray(node)) {
      return node.map((item) => this.walk(item, depth + 1));
    }
    if (typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      const next: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        next[key] = this.applyFieldPolicy(key, value, depth);
      }
      return next;
    }
    return node;
  }

  private applyFieldPolicy(
    key: string,
    value: unknown,
    depth: number,
  ): unknown {
    // Nested objects and arrays recurse BEFORE field-name matching so
    // a nested field keyed `email` inside an arbitrary object still
    // gets redacted.
    if (value && typeof value === 'object') {
      return this.walk(value, depth + 1);
    }

    if (SECRET_FIELDS.has(key)) return REDACTED_MARKER;
    if (typeof value !== 'string') return value;

    if (EMAIL_FIELDS.has(key)) return this.maskEmail(value);
    if (PHONE_FIELDS.has(key)) return this.maskPhone(value);
    if (HASHED_PII_FIELDS.has(key)) return this.hashValue(value);
    return value;
  }

  private maskEmail(value: string): string {
    const atIdx = value.lastIndexOf('@');
    if (atIdx <= 0) return REDACTED_MARKER;
    const domain = value.slice(atIdx);
    return `***${domain}`;
  }

  private maskPhone(value: string): string {
    // Strip anything that is not a digit so the last 4 are truly the
    // last 4 digits of the phone regardless of formatting.
    const digits = value.replace(/\D+/g, '');
    if (digits.length < 4) return REDACTED_MARKER;
    return `***${digits.slice(-4)}`;
  }

  private hashValue(value: string): string {
    return `sha256:${createHash('sha256')
      .update(value)
      .digest('hex')
      .slice(0, 16)}`;
  }

  private safeStringify(payload: unknown): string {
    try {
      return JSON.stringify(payload) ?? 'null';
    } catch (err) {
      this.logger.warn(
        `Audit payload serialization failed: ${(err as Error).message}`,
      );
      return '"[SERIALIZATION_FAILED]"';
    }
  }
}
