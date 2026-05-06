/**
 * Platform-wide invariant — BILLING-LOW-004:
 *
 * The Stripe webhook controller MUST carry `@Public()` so the
 * upstream guard chain (ServiceIdentityGuard, JwtAuthGuard,
 * TenantGuard, etc.) is skipped on the webhook path. The webhook's
 * authenticity comes from Stripe's signature header verification
 * which the controller performs in-handler — no platform guard
 * applies because the request originates outside the platform's
 * mTLS service-mesh.
 *
 * # Why this lives in tests/invariants/
 *
 * The current setup works correctly because:
 *
 *   1. The controller method has `@Public()`.
 *   2. The platform guard chain respects the `@Public()` metadata
 *      (every guard's canActivate() short-circuits when the
 *      reflector finds IS_PUBLIC_KEY).
 *
 * Both are independently fragile:
 *
 *   - A future maintainer "tidying up" by removing `@Public()`
 *     thinking it's unused would silently break every Stripe
 *     webhook.
 *   - A future maintainer adding a NEW global guard that doesn't
 *     respect `@Public()` (e.g. a global rate-limit guard, a
 *     mandatory tenant-scoped guard) would silently block every
 *     Stripe webhook.
 *
 * This Tier-3 invariant catches the first regression class at PR
 * review by asserting `@Public()` is present on the @Post()
 * webhook handler. The second regression class (rogue global
 * guard) is too broad for source-level detection — that one
 * needs an e2e test (covered by the BILLING-LOW-004 follow-on
 * tracked in the cure commit body).
 *
 * # What this spec asserts
 *
 *   1. StripeWebhookController has `@Public()` on the
 *      handlePaymentWebhook method (the only @Post handler).
 *   2. The controller imports `@Public()` from the canonical
 *      location (libs/backend-common/src/auth/public.decorator.ts
 *      or wherever the platform's IS_PUBLIC_KEY reflector key
 *      lives), not a local one-off declaration that wouldn't
 *      participate in the guard-chain bypass.
 *
 * Closes: docs/reviews/billing-expert/2026-04-28-core-platform-review.md#BILLING-LOW-004
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const STRIPE_WEBHOOK_CONTROLLER_PATH =
  'apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts';

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

describe('BILLING-LOW-004 — Stripe webhook public-path invariant', () => {
  it('StripeWebhookController has @Public() on the @Post webhook handler', () => {
    const src = read(STRIPE_WEBHOOK_CONTROLLER_PATH);

    // The @Public() decorator MUST sit between the @Post() and
    // the method declaration. Permissive multiline matcher: any
    // amount of whitespace / comments between the two.
    const hasPublicBeforePost =
      /@Public\s*\(\s*\)\s*[\s\S]{0,200}?@Post\s*\(/.test(src) ||
      /@Post\s*\([\s\S]{0,200}?@Public\s*\(\s*\)/.test(src);
    expect(hasPublicBeforePost).toBe(true);
  });

  it('@Public is imported from the canonical platform location (not a local one-off)', () => {
    const src = read(STRIPE_WEBHOOK_CONTROLLER_PATH);

    // Accept any of these canonical sources — the platform has
    // historically housed @Public in different locations and
    // they all consult the same reflector key. Any LOCAL
    // declaration of @Public() inside the file would fail the
    // reflector lookup and let guards run; we forbid that.
    const importsCanonicalPublic =
      /@aquaculture\/backend-common[^'"]*['"]\s*[\s\S]*?\bPublic\b/.test(src) ||
      /from\s*['"][^'"]*\/decorators\/public[^'"]*['"]/.test(src) ||
      /from\s*['"][^'"]*\/auth\/public[^'"]*['"]/.test(src) ||
      /from\s*['"]\.\.\/auth\/public\.decorator['"]/.test(src);
    expect(importsCanonicalPublic).toBe(true);

    // Negative: assert there is no LOCAL `export const Public =`
    // or `function Public(` declaration in the file. Such a
    // local would shadow the platform decorator and silently
    // break the guard-chain bypass.
    expect(src).not.toMatch(/(?:export\s+)?(?:const|function)\s+Public\s*[=(]/);
  });

  it('StripeWebhookController controller path resolves to /webhooks/stripe (canonical)', () => {
    const src = read(STRIPE_WEBHOOK_CONTROLLER_PATH);
    // The controller decorator carries 'webhooks' and the @Post
    // route carries 'stripe' — concatenated to '/webhooks/stripe'.
    // Hard-coding the pair here means a future "rename to
    // /api/webhooks/stripe" silently breaks the deployed Stripe
    // dashboard webhook URL — the change would have to update
    // this invariant in the same PR, forcing reviewer awareness.
    expect(src).toMatch(/@Controller\s*\(\s*['"]webhooks['"]\s*\)/);
    expect(src).toMatch(/@Post\s*\(\s*['"]stripe['"]\s*\)/);
  });
});
