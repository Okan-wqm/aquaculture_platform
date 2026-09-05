// Bearer-token authentication with a per-address failure limiter.
//
// WHY: the console is published on an IP:port; a token is the only gate, so
// comparison must be constant-time and guessing must get expensive fast. The
// token no longer identifies "the console" — it identifies ONE principal, a
// named person or role account, resolved by the principals directory (or, for
// the shared operator credential, the token holder). MEASURED 2026-09-04: with
// one shared token, every holder was everyone and the custody receipt's author
// was whatever a header said.
// WHAT: `authorize` returns public / ok-with-principal / 401 / 429. Tokens
// reach the resolver as presented and are compared as SHA-256 digests in
// constant time. Twenty failures from one address inside ten minutes lock that
// address out until the window passes.

import { createHash, timingSafeEqual } from 'node:crypto';

import { PUBLIC_PATHS } from '../../shared/api-contract.ts';
import type { Principal } from './principal.ts';
import { TOKEN_HOLDER_PRINCIPAL } from './principal.ts';

export type AuthVerdict =
  | { readonly kind: 'public' }
  | { readonly kind: 'ok'; readonly principal: Principal }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'rate_limited'; readonly retryAfterSeconds: number };

/** Answers "whose token is this?" or null. Every implementation must compare in constant time. */
export type PrincipalResolver = (token: string) => Principal | null;

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

/** The shared operator credential: it proves possession of the instance's token, and acts as the operator. */
export function sharedTokenResolver(token: string): PrincipalResolver {
  const expected = digest(token);
  return (presented) => (timingSafeEqual(digest(presented), expected) ? TOKEN_HOLDER_PRINCIPAL : null);
}

/** Tries each resolver in order; every one runs, so timing does not say which matched. */
export function combineResolvers(resolvers: ReadonlyArray<PrincipalResolver>): PrincipalResolver {
  return (token) => {
    let found: Principal | null = null;
    for (const resolve of resolvers) {
      const candidate = resolve(token);
      if (candidate !== null && found === null) found = candidate;
    }
    return found;
  };
}

export class Authorizer {
  private readonly resolve: PrincipalResolver;
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly failures = new Map<string, FailureWindow>();

  constructor(resolve: PrincipalResolver, options: AuthorizerOptions = {}) {
    this.resolve = resolve;
    this.maxFailures = options.maxFailures ?? 20;
    this.windowMs = options.windowMs ?? 10 * 60 * 1000;
    this.now = options.now ?? (() => Date.now());
  }

  authorize(path: string, authorizationHeader: string | undefined, remoteAddress: string): AuthVerdict {
    if (isPublicPath(path)) return { kind: 'public' };
    const window = this.failures.get(remoteAddress);
    const now = this.now();
    if (window !== undefined && now - window.windowStart >= this.windowMs) {
      this.failures.delete(remoteAddress);
    } else if (window !== undefined && window.count >= this.maxFailures) {
      return { kind: 'rate_limited', retryAfterSeconds: Math.ceil((window.windowStart + this.windowMs - now) / 1000) };
    }
    const presented = extractBearer(authorizationHeader);
    const principal = presented === null ? null : this.resolve(presented);
    if (principal !== null) {
      this.failures.delete(remoteAddress);
      return { kind: 'ok', principal };
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
