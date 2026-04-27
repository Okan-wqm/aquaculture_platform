/**
 * AuditRedactionService Unit Tests
 *
 * Exercises every redaction axis:
 *   - secret-field full redact
 *   - email local-part mask, domain retained
 *   - phone last-four mask
 *   - hashed PII (SHA-256 truncated)
 *   - IPv4 /24 and IPv6 /48 anonymization
 *   - user-agent family extraction
 *   - oversized JSONB collapse
 *   - nested object recursion
 *   - pass-through for safe fields and scalar types
 *
 * Uses a hand-rolled `ConfigService` double — no `as any`.
 */
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';

import { AuditRedactionService } from '../services/audit-redaction.service';

class StubConfigService {
  constructor(private readonly values: Record<string, string> = {}) {}
  get<T = string>(key: string): T | undefined {
    const raw = this.values[key];
    return raw === undefined ? undefined : (raw as unknown as T);
  }
}

function makeService(env: Record<string, string> = {}): AuditRedactionService {
  return new AuditRedactionService(
    new StubConfigService(env) as unknown as ConfigService,
  );
}

describe('AuditRedactionService.redactPayload', () => {
  it('returns undefined/null unchanged and copies primitives', () => {
    const service = makeService();
    const out = service.redactPayload({
      id: 'batch-1',
      count: 42,
      active: true,
      blank: null,
    });
    expect(out).toEqual({
      id: 'batch-1',
      count: 42,
      active: true,
      blank: null,
    });
  });

  it('replaces secret fields with [REDACTED]', () => {
    const service = makeService();
    const out = service.redactPayload({
      password: 'Hunter2',
      apiKey: 'sk_live_abc',
      refreshToken: 'rt_xyz',
      connectionString: 'postgres://u:p@h/db',
    });
    expect(out).toEqual({
      password: '[REDACTED]',
      apiKey: '[REDACTED]',
      refreshToken: '[REDACTED]',
      connectionString: '[REDACTED]',
    });
  });

  it('masks email local part but keeps the domain', () => {
    const service = makeService();
    const out = service.redactPayload({ email: 'alice@example.com' });
    expect(out).toEqual({ email: '***@example.com' });
  });

  it('masks phone to the last four digits regardless of formatting', () => {
    const service = makeService();
    expect(service.redactPayload({ phone: '+1 (555) 123-4567' })).toEqual({
      phone: '***4567',
    });
    expect(service.redactPayload({ mobile: '05551234567' })).toEqual({
      mobile: '***4567',
    });
  });

  it('hashes high-sensitivity PII to a truncated SHA-256 prefix', () => {
    const service = makeService();
    const value = 'Alice';
    const expected = `sha256:${createHash('sha256')
      .update(value)
      .digest('hex')
      .slice(0, 16)}`;
    const out = service.redactPayload({ firstName: value });
    expect(out).toEqual({ firstName: expected });
  });

  it('hashes are stable across calls — correlation is possible', () => {
    const service = makeService();
    const a = service.redactPayload({ ssn: '111-22-3333' });
    const b = service.redactPayload({ ssn: '111-22-3333' });
    expect(a).toEqual(b);
  });

  it('recurses into nested objects and arrays', () => {
    const service = makeService();
    const out = service.redactPayload({
      id: 'site-1',
      owner: {
        email: 'admin@aqua.io',
        phone: '+15551234567',
        firstName: 'Alice',
      },
      contacts: [
        { email: 'first@aqua.io' },
        { email: 'second@example.com' },
      ],
    });
    expect(out).toMatchObject({
      id: 'site-1',
      owner: {
        email: '***@aqua.io',
        phone: '***4567',
      },
      contacts: [
        { email: '***@aqua.io' },
        { email: '***@example.com' },
      ],
    });
  });

  it('collapses oversized payloads into a hashed summary', () => {
    const service = makeService({ AUDIT_REDACTION_MAX_PAYLOAD_BYTES: '256' });
    // Build a payload > 256 bytes.
    const bigText = 'x'.repeat(500);
    const payload = { bigText };
    const out = service.redactPayload(payload) as {
      __redacted: string;
      bytes: number;
      sha256: string;
    };
    expect(out.__redacted).toBe('truncated');
    expect(out.bytes).toBeGreaterThan(256);
    expect(out.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('falls back to the default size limit when env var is not a number', () => {
    const service = makeService({
      AUDIT_REDACTION_MAX_PAYLOAD_BYTES: 'not-a-number',
    });
    // A 100-char string is well below the default 5 KB so the field
    // remains in place (not collapsed to a hash summary).
    const out = service.redactPayload({ notes: 'x'.repeat(100) });
    expect(out).toEqual({ notes: 'x'.repeat(100) });
  });
});

describe('AuditRedactionService.redactChanges', () => {
  it('redacts before + after and copies changedFields list', () => {
    const service = makeService();
    const out = service.redactChanges({
      before: { email: 'a@a.com' },
      after: { email: 'b@b.com' },
      changedFields: ['email'],
    });
    expect(out).toEqual({
      before: { email: '***@a.com' },
      after: { email: '***@b.com' },
      changedFields: ['email'],
    });
  });

  it('returns undefined for an undefined input', () => {
    const service = makeService();
    expect(service.redactChanges(undefined)).toBeUndefined();
  });

  it('retains partial payloads (before only, after only)', () => {
    const service = makeService();
    const out = service.redactChanges({
      after: { password: 'topsecret' },
    });
    expect(out).toEqual({ after: { password: '[REDACTED]' } });
  });
});

describe('AuditRedactionService.redactMetadata', () => {
  it('anonymizes IPv4 to /24', () => {
    const service = makeService();
    const out = service.redactMetadata({ ipAddress: '192.168.42.17' });
    expect(out?.ipAddress).toBe('192.168.42.0/24');
  });

  it('anonymizes IPv6 to /48', () => {
    const service = makeService();
    const out = service.redactMetadata({
      ipAddress: '2001:db8:1234:abcd::1',
    });
    expect(out?.ipAddress).toBe('2001:db8:1234::/48');
  });

  it('flags invalid IP formats', () => {
    const service = makeService();
    const out = service.redactMetadata({ ipAddress: 'not-an-ip' });
    expect(out?.ipAddress).toBe('[INVALID_IP]');
  });

  it('extracts browser family from user-agent', () => {
    const service = makeService();
    const chrome = service.redactMetadata({
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    expect(chrome?.userAgent).toBe('Chrome');

    const firefox = service.redactMetadata({
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
    });
    expect(firefox?.userAgent).toBe('Firefox');

    const safari = service.redactMetadata({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
    });
    expect(safari?.userAgent).toBe('Safari');

    const edge = service.redactMetadata({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/120.0.0.0',
    });
    expect(edge?.userAgent).toBe('Edge');

    const other = service.redactMetadata({
      userAgent: 'curl/8.5.0',
    });
    expect(other?.userAgent).toBe('Other');
  });

  it('passes correlationId and source through unmodified', () => {
    const service = makeService();
    const out = service.redactMetadata({
      correlationId: 'req-abc-123',
      source: 'API',
    });
    expect(out?.correlationId).toBe('req-abc-123');
    expect(out?.source).toBe('API');
  });

  it('returns undefined for undefined input', () => {
    const service = makeService();
    expect(service.redactMetadata(undefined)).toBeUndefined();
  });
});
