// Bearer-token authorization with a per-address failure limiter.
//
// WHY: the console is published on an IP:port; the token is the only gate, so
// comparison must be constant-time and guessing must get expensive fast.
// WHAT: `authorize` returns ok / 401 / 429. Tokens are compared as SHA-256
// digests (equal length) with timingSafeEqual. Twenty failures from one address
// inside ten minutes lock that address out until the window passes.

import { createHash, timingSafeEqual } from 'node:crypto';

import { PUBLIC_PATHS } from '../../shared/api-contract.ts';

export type AuthVerdict = { readonly kind: 'ok' } | { readonly kind: 'unauthorized' } | { readonly kind: 'rate_limited'; readonly retryAfterSeconds: number };

export interface AuthorizerOptions {
  readonly maxFailures?: number;
  readonly windowMs?: number;
  readonly now?: () => number;
}

interface FailureWindow {
  count: number;
  windowStart: number;
}

const PUBLIC = new Set<string>(PUBLIC_PATHS);

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function isPublicPath(path: string): boolean {
  return PUBLIC.has(path);
}

export function extractBearer(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match === null ? null : (match[1] ?? null);
}

export class Authorizer {
  private readonly expected: Buffer;
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly failures = new Map<string, FailureWindow>();

  constructor(token: string, options: AuthorizerOptions = {}) {
    this.expected = digest(token);
    this.maxFailures = options.maxFailures ?? 20;
    this.windowMs = options.windowMs ?? 10 * 60 * 1000;
    this.now = options.now ?? (() => Date.now());
  }

  authorize(path: string, authorizationHeader: string | undefined, remoteAddress: string): AuthVerdict {
    if (isPublicPath(path)) return { kind: 'ok' };
    const window = this.failures.get(remoteAddress);
    const now = this.now();
    if (window !== undefined && now - window.windowStart >= this.windowMs) {
      this.failures.delete(remoteAddress);
    } else if (window !== undefined && window.count >= this.maxFailures) {
      return { kind: 'rate_limited', retryAfterSeconds: Math.ceil((window.windowStart + this.windowMs - now) / 1000) };
    }
    const presented = extractBearer(authorizationHeader);
    if (presented !== null && timingSafeEqual(digest(presented), this.expected)) {
      this.failures.delete(remoteAddress);
      return { kind: 'ok' };
    }
    const current = this.failures.get(remoteAddress);
    if (current === undefined) {
      this.failures.set(remoteAddress, { count: 1, windowStart: now });
    } else {
      current.count += 1;
    }
    return { kind: 'unauthorized' };
  }
}
