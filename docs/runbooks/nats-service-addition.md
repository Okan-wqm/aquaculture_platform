# Runbook: Adding a new NATS-consuming service

**Owner:** platform team
**Related ADR:** ADR-015 (NATS Cert-Is-Identity SSoT)

## Purpose

Step-by-step procedure for adding a new backend service that publishes
or subscribes to NATS subjects. Enforces the SSoT contract: a new
service must appear in `infrastructure/nats/services.yaml` + have a
matching cert CN + regenerated `nats.conf` — CI fails the build if
any of the three drifts.

## Step 1 — Add to `infrastructure/nats/services.yaml`

Open `infrastructure/nats/services.yaml` and append a new service
entry under `services:`:

```yaml
  - name: <service_name>         # lowercase snake_case, matches cert CN
    description: <one-line domain summary>
    publish:
      - "AQUACULTURE_EVENTS.<Aggregate>*.>"
      # ... other publish subjects
      - "$JS.API.>"
      - "_INBOX.>"
    subscribe:
      - "AQUACULTURE_EVENTS.>"
      # ... other subscribe subjects
      - "$JS.API.>"
      - "_INBOX.>"
```

**Naming:**

- `<service_name>` MUST match the mTLS client cert's `CN=` value (see
  Step 2). This is how `verify_and_map: true` maps handshake → user.
- Subject namespace: use `AQUACULTURE_EVENTS.<Aggregate>*.>` for
  platform events. Never use bare wildcards like `>` or `*.>` —
  platform convention is event-family scoped.

## Step 2 — Add to `generate-internal-certs.sh`

Open `infrastructure/docker/scripts/generate-internal-certs.sh` and
append the service name to the `for svc in ...` loop (around line 97):

```bash
for svc in auth_service farm_service sensor_service gateway_service \
           notification_service billing_service alert_engine \
           hr_service messaging_service hydroponics_service \
           <new_service_name>; do
  generate_per_service_client_cert "$svc"
done
```

**Why lockstep:** CI invariant asserts services.yaml names == cert
script CN list. Changing one without the other fails the build.
BACKLOG-NATS-002 will auto-generate this list from services.yaml.

## Step 3 — Regenerate `nats.conf`

```bash
python3 scripts/nats/generate-nats-conf.py
```

Output: `regenerated — infrastructure/docker/nats/nats.conf (services: 11)`
(or whatever the new count is).

The generator writes a new user entry between the `# BEGIN GENERATED`
/ `# END GENERATED` sentinels. No password field — cert CN IS the
identity.

**Idempotency:** running the generator a second time on an already-up-
to-date nats.conf reports `no change — ... already matches SSoT` and
exits 0. Safe to run in pre-commit hooks.

## Step 4 — Wire the service's NATS connection

### backend (docker-compose)

Add a new `x-nats-<service>-env` anchor in `docker-compose.droplet.yml`
mirroring the existing anchors — NATS_URL + NATS_TLS_CA + NATS_TLS_CERT
(pointing at `/etc/ssl/nats-clients/<service_name>-cert.pem`) +
NATS_TLS_KEY + NATS_TLS_ENABLED. Do NOT add NATS_AUTH_USER or
NATS_AUTH_PASS — cert CN is identity.

Merge the anchor into the service's `environment:` block:

```yaml
<service>-service:
  environment:
    <<: *nats-<service>-env
```

### backend (helm)

Add a values.yaml entry is NOT required (natsAuth block was removed
in ADR-015). Inject the TLS env vars via the helper:

```yaml
# in templates/backend-services.yaml, in the new service's container spec
env:
  {{- include "aquaculture.natsServiceEnv" (list . "<service_name>") | nindent 12 }}
```

### backend (NestJS code)

No code changes needed if using `buildNatsConnectionOptions` or
`buildNatsTransportOptions` from `@aquaculture/backend-common`. Factory
auto-selects cert-only mode when TLS env vars are present.

## Step 5 — Run the CI invariant test locally

```bash
npm run test -- nats-invariants.spec.ts
```

Should pass. If it fails:

- **"Expected N user entries ... got M"** — regenerate nats.conf (Step 3).
- **"publish/subscribe ACL drift"** — your yaml edit didn't match the
  generated nats.conf. Run Step 3 again.
- **"CN list mismatch: only in services.yaml: [...]"** — you forgot
  Step 2.

## Step 6 — Commit

```bash
git add \
  infrastructure/nats/services.yaml \
  infrastructure/docker/nats/nats.conf \
  infrastructure/docker/scripts/generate-internal-certs.sh \
  docker-compose.droplet.yml \
  infrastructure/helm/aquaculture/templates/backend-services.yaml

git commit -m "feat(nats): wire <service-name> for NATS per-service auth"
```

All six files must land in the same commit so the CI invariant stays
green on every intermediate commit.

## Removing a service

Reverse the procedure:

1. Remove cert from `generate-internal-certs.sh`
2. Remove entry from services.yaml
3. Regenerate nats.conf
4. Revoke cert (future BACKLOG item — CRL / OCSP integration)
5. Remove compose/helm references

**⚠️ Security-sensitive:** ensure no live production client is using
the cert AND no in-flight NATS consumers exist with the subject
patterns the removed service published to. Open a tracked finding
before proceeding.

## References

- ADR-015: `docs/adr/015-nats-cert-is-identity-ssot.md`
- SSoT: `infrastructure/nats/services.yaml`
- Generator: `scripts/nats/generate-nats-conf.py`
- CI invariant: `e2e/tests/integration/nats-invariants.spec.ts`
