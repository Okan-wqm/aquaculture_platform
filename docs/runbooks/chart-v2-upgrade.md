# Helm Chart v1 → v2 Upgrade Runbook

**Chart version:** `1.0.0` → `2.0.0`
**Breaking surface:** 2026-04-14 security hardening
**Downtime:** ≤ 30s per service (rolling restart triggered by secret mount changes)

## Why v2 is breaking

v2 tightens the production secret contract. Existing installs MUST supply new required values or the chart render fails fast (this is intentional — a render failure surfaces the mismatch during `helm upgrade --dry-run`, not at pod startup).

## Required value changes

| Old (v1)                    | New (v2)                                        | How to populate                                              |
|-----------------------------|--------------------------------------------------|--------------------------------------------------------------|
| `secrets.jwtSecret`         | **REMOVED**                                      | n/a — delete from your overlay                               |
| *(new)*                     | `secrets.jwtPrivateKey` (RS256 PEM)              | `infrastructure/docker/scripts/generate-jwt-keypair.sh`      |
| *(new)*                     | `secrets.jwtPublicKey` (RS256 PEM)               | same script                                                  |
| *(new)*                     | `secrets.passwordPepper` (min 32 bytes)          | `openssl rand -base64 48`                                    |
| *(new)*                     | `secrets.natsAuth.<svc>Pass` × 10                | `openssl rand -base64 32` per service                        |
| *(new)*                     | `secrets.stripeWebhookSecret`                    | Stripe Dashboard → Webhooks → Signing secret                 |
| *(new)*                     | `secrets.stripeApiKey`                           | Stripe Dashboard → API keys (restricted server key)          |

## Upgrade steps

```bash
# 1. Generate the RS256 keypair (outputs ./certs/jwt/{private,public}.pem)
infrastructure/docker/scripts/generate-jwt-keypair.sh

# 2. Dry-run the upgrade with all new required values populated.
#    The chart throws if anything is missing — this is the failure gate.
helm upgrade --dry-run --debug aquaculture ./infrastructure/helm/aquaculture \
  -n aquaculture \
  -f infrastructure/helm/aquaculture/values-production.yaml \
  --set-file secrets.jwtPrivateKey=./certs/jwt/private.pem \
  --set-file secrets.jwtPublicKey=./certs/jwt/public.pem \
  --set secrets.passwordPepper="$(openssl rand -base64 48)" \
  --set secrets.natsAuth.authPass="$(openssl rand -base64 32)" \
  --set secrets.natsAuth.farmPass="$(openssl rand -base64 32)" \
  --set secrets.natsAuth.sensorPass="$(openssl rand -base64 32)" \
  --set secrets.natsAuth.gatewayPass="$(openssl rand -base64 32)" \
  --set secrets.natsAuth.notificationPass="$(openssl rand -base64 32)" \
  --set secrets.natsAuth.billingPass="$(openssl rand -base64 32)" \
  --set secrets.natsAuth.alertPass="$(openssl rand -base64 32)" \
  --set secrets.natsAuth.hrPass="$(openssl rand -base64 32)" \
  --set secrets.natsAuth.messagingPass="$(openssl rand -base64 32)" \
  --set secrets.natsAuth.hydroponicsPass="$(openssl rand -base64 32)" \
  --set secrets.stripeWebhookSecret="$STRIPE_WEBHOOK_SECRET" \
  --set secrets.stripeApiKey="$STRIPE_API_KEY"

# 3. If using External Secrets Operator (externalSecrets.enabled=true in
#    values-production.yaml), populate the remote store BEFORE the upgrade:
#
#    aws secretsmanager create-secret \
#      --name aquaculture/production/jwt-private-key \
#      --secret-string file://./certs/jwt/private.pem
#    ... etc for every key (see templates/secrets.yaml ExternalSecret block)

# 4. Apply the upgrade (remove --dry-run).
helm upgrade ... (same command as step 2)
```

## Cert-manager note

`values-production.yaml` now defaults `certManager.internal.enabled: true`. Clusters that do NOT run cert-manager must explicitly opt out:

```bash
helm upgrade ... --set certManager.internal.enabled=false
```

That explicit-opt-out pattern is deliberate — an operator disabling cert-manager makes a conscious choice, instead of silently running on manual certs.

## Rollback

```bash
helm rollback aquaculture <previous-revision> -n aquaculture
```

Rollback is safe: v1 and v2 store the same per-service passwords (just under different secret keys), so rolling back restores old functionality. Rotating the pepper or JWT keypair forces a user password reset / token re-issuance — plan those as security events, not routine rollbacks.

## Verification

After upgrade:

```bash
# 1. All pods Ready
kubectl get pods -n aquaculture -w

# 2. Auth-service issued a fresh RS256 token (smoke)
curl -sX POST https://<your-gateway>/auth/login -d '{...}' | jq .

# 3. gitleaks CI + security-gitleaks.yml pass on the next push
# 4. No pod shows "CRITICAL SECURITY ERROR" in logs (boot-time RSA key check)
```
