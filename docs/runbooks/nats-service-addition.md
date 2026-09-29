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
    application: <apps-dir-name> # the single runtime that owns this cert
    description: <one-line domain summary>
    publish:
      - "events.*.<EventType>"
      # ... other publish subjects
      - "$JS.API.>"
    subscribe:
      - "request.<service>.<rpc>"
      # ... other subscribe subjects
      - "$JS.API.>"
      - "_INBOX_<service_name>.>"
```

**Naming:**

- `<service_name>` MUST match the mTLS client cert's `CN=` value (see
  Step 2). This is how `verify_and_map: true` maps handshake → user.
- Subject namespace: domain events are `events.*.<EventType>` — the single
  `*` matches every tenantId and the literal `system` segment. The legacy
  `AQUACULTURE_EVENTS.` scheme is BANNED (that string is the JetStream
  stream NAME, never a subject) and `services.schema.json` rejects it.
  Never use bare wildcards like `>` or `*.>`.
- **Reply inbox (ORPHAN-CRITICAL-402):** every identity subscribes exactly
  one inbox grant — its OWN `_INBOX_<service_name>.>`. The shared `_INBOX.>`
  is structurally rejected: one token for the whole fleet meant any
  certificate could read every other service's request-reply responses.
  Never add an inbox grant to `publish`, not even your own — responders
  reply through the broker's `allow_responses` permission, which the
  generator emits for every user. The client side needs no configuration:
  `buildNatsConnectionOptions()` derives the prefix from the certificate CN.

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
- **"must subscribe its own reply inbox exactly once"** / **"grants the
  shared inbox"** — the generator refused to write the ACL. Add
  `_INBOX_<service_name>.>` to `subscribe` and remove any `_INBOX.>` or
  foreign `_INBOX_*` grant (ORPHAN-CRITICAL-402).

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

## Deploying a reply-inbox change (ORPHAN-CRITICAL-402)

The broker's inbox grants and the client's inbox prefix are two halves of one
contract, so they must go out together:

- The broker grants `_INBOX_<CN>.>` and nothing else. A service image that
  still uses the old shared `_INBOX` default has its inbox subscription
  REFUSED (`Permissions Violation for Subscription to "_INBOX.*"` in the NATS
  log) and every request-reply call it makes times out.
- A new service image pointed at an old broker fails the mirror image of that.

`docker compose -f docker-compose.droplet.yml up -d` recreates the NATS
container and the service containers in one pass, so the exposure is the
reconnect window, not a sustained outage. During it:

- JetStream domain events are unaffected — they are durable and redelivered.
- Core-NATS request-reply (the `request.*` subjects) fails fast and the caller
  retries once its container is recreated.

If a partial deploy leaves the two halves out of step, roll the remaining
containers forward (never pin the broker back to a shared-inbox ACL — that
re-opens the confidentiality hole for every service at once).

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
