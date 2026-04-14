# Runbook: Secret Rotation

Procedures for rotating security-critical secrets in the aquaculture platform. All rotations are zero-downtime when followed in order.

## Stripe webhook signing secret (`STRIPE_WEBHOOK_SECRET`)

Consumed by `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts:74`. Rotated via Stripe's built-in rolling keys feature so no inbound events are dropped during transition.

**Prerequisites:** Stripe Dashboard admin access, deploy access to billing-service, Slack channel for ops coordination.

**Steps:**

1. **Create a new signing secret in Stripe Dashboard**:
   - Developers → Webhooks → select your endpoint → "Roll signing secret"
   - Stripe activates the new key AND retains the old key for a configurable overlap window (default 24h).
   - Both secrets accept incoming events during overlap — no drop window.

2. **Stage the new secret**:
   - Docker Compose deploys: update `STRIPE_WEBHOOK_SECRET` in your `.env` / Docker secret store.
   - Kubernetes deploys: update the source secret (External Secrets Operator / Sealed Secrets).
   - CI/CD: update the pipeline's secret variable.

3. **Roll billing-service replicas**:
   - `docker compose up -d billing-service` (picks up new env).
   - `kubectl rollout restart deployment/aquaculture-billing-service`.
   - Verify: `docker logs aqua-billing | grep "STRIPE_WEBHOOK_SECRET"` shows NO `not configured` warning.

4. **Trigger a test event** from Stripe dashboard (Developers → Webhooks → your endpoint → "Send test webhook"). Confirm 200 response in Stripe's delivery log.

5. **Mark the old secret revoked** in Stripe dashboard (optional — happens automatically after overlap window expires). Keeps audit clean.

**Rollback**: if a post-roll endpoint rejects valid events, re-deploy with the previous `STRIPE_WEBHOOK_SECRET` value (Stripe still accepts old secret during overlap). Root-cause the verification failure before retrying.

## Stripe server-side API key (`STRIPE_API_KEY`)

Consumed by billing-service's Stripe client for outbound API calls (checkout, subscription, refunds). Use **restricted keys** in production — never the full-access secret key.

**Steps:**

1. Stripe Dashboard → Developers → API keys → "Create restricted key".
2. Grant only the resources billing-service actually uses: Customers (write), Subscriptions (write), Invoices (read), Checkout Sessions (write), Webhook Endpoints (read). Deny everything else.
3. Stage in the same secret store as the webhook secret (step 2 above). Roll billing-service.
4. Verify by creating a subscription in staging — expect 200 from Stripe. Check billing logs for `Stripe API call succeeded`.
5. Revoke the old key in Stripe dashboard after staging verification — no overlap needed for API keys (no signature verification latency).

**Rollback**: re-stage previous key and roll. Stripe retains old key in an audit log; re-create if needed from the dashboard (you cannot recover the raw value once shown).

## JWT signing keys (RS256 keypair)

Consumed by auth-service (issuer) and every other backend service (verifier). See `infrastructure/docker/scripts/generate-jwt-keypair.sh`.

Rotation is more involved (all services need the new public key before auth-service starts issuing with the new private key). Documented separately in a future runbook when rotation is planned.

## Password pepper (`PASSWORD_PEPPER`)

Consumed by auth-service to HMAC passwords before bcrypt. Rotation requires re-hashing all existing user passwords. NOT a routine rotation — only performed after a suspected pepper leak. Separate incident-response runbook covers this.

## Database passwords (per-service)

Defined in `infrastructure/docker/init-scripts/00-init-schemas.sh`. Rotated via:

1. Update service-specific password env var (e.g. `BILLING_SERVICE_DB_PASS`).
2. `ALTER ROLE billing_service WITH PASSWORD '<new>'` on the running DB.
3. Roll the service that uses that role.

Can be done one role at a time without cross-service impact because each service has its own role.

## Audit trail

Every rotation triggers a WARN log entry via the standard logging middleware. Grep production logs for `secret.rotated` to confirm the deploy picked up the new value. Consider adding a Grafana alert on absence of this entry after a scheduled rotation window.
