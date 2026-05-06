/**
 * Platform-wide invariant — BILLING-MEDIUM-001:
 *
 * StripeWebhookController.constructor MUST treat RedisService as a
 * REQUIRED dependency (no `@Optional()`). The webhook idempotency
 * check is functionally a quota gate; layer-1-nestjs requires
 * fail-closed posture for quota gates on Redis outage.
 *
 * # Why this lives in tests/invariants/
 *
 * The `@Optional()` annotation is a single character to add and
 * easy to slip into a refactor "for symmetry" with the other
 * @Optional() dependencies in the same constructor (auditLog,
 * dedupRepo, securityEventService). All three of those are
 * legitimately optional for local-dev paths. RedisService is NOT
 * — silent dedup bypass is a security regression.
 *
 * # What this spec asserts
 *
 *   1. The RedisService constructor parameter has NO @Optional()
 *      annotation immediately preceding it.
 *   2. The parameter type is `RedisService` (not `RedisService | undefined`,
 *      which would also signal optionality).
 *
 * Closes: docs/reviews/billing-expert/2026-04-28-core-platform-review.md#BILLING-MEDIUM-001
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CONTROLLER_PATH =
  'apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts';

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

describe('BILLING-MEDIUM-001 — Stripe webhook RedisService required', () => {
  it('redisService parameter is REQUIRED (no @Optional, no `?` modifier)', () => {
    const src = read(CONTROLLER_PATH);

    // The RedisService parameter should appear inside the
    // constructor without a preceding @Optional() decorator.
    // We use a regex that allows whitespace/comments before the
    // parameter declaration.

    // Negative shape: forbid `@Optional() ... redisService`
    // anywhere in the file (ensuring no future refactor adds the
    // annotation back).
    expect(src).not.toMatch(
      /@Optional\s*\(\s*\)\s*(?:[^,()]|\([^)]*\))*\bredisService\s*\??\s*:\s*RedisService/,
    );

    // Positive shape: redisService MUST be typed as
    // `RedisService` (no `?` optionality marker, no `| undefined`).
    expect(src).toMatch(
      /\bredisService\s*:\s*RedisService\s*[,)]/,
    );
    expect(src).not.toMatch(/\bredisService\s*\?\s*:\s*RedisService/);
    expect(src).not.toMatch(/\bredisService\s*:\s*RedisService\s*\|\s*undefined/);
  });

  it('Optional import is preserved (other constructor params still need it)', () => {
    const src = read(CONTROLLER_PATH);
    // The constructor has THREE legitimately-optional dependencies
    // (auditLog, dedupRepo, securityEventService) — the @Optional
    // import must stay or those will break.
    expect(src).toMatch(/Optional/);
  });

  it('Redis idempotency check is unconditional (no `if (this.redisService)` guard)', () => {
    const src = read(CONTROLLER_PATH);
    // Pre-cure the idempotency block sat behind
    // `if (this.redisService) { ... }`. Post-cure that conditional
    // is removed because the dependency is required. A future
    // refactor that re-adds the guard would silently re-introduce
    // the silent-bypass class — this assertion catches that.
    expect(src).not.toMatch(/if\s*\(\s*this\.redisService\s*\)/);
  });
});
