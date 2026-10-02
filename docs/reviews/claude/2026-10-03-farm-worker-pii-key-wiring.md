# Worker PII keys never reach farm-service in production (2026-10-03)

Owner: okan. Raised from the read-only production image audit of 2026-10-02 (~21:45Z).

## DEPLOY-HIGH-027

Severity: HIGH. Deadline: 2026-10-17.

`apps/farm-service/src/worker/entities/worker.entity.ts` encrypts the worker PII columns with
`createEncryptedColumnTransformer('EMPLOYEE_PII_ENCRYPTION_KEY')` and derives `emailHash` with
`createBlindIndex('EMPLOYEE_PII_BLIND_INDEX_KEY')`. Both resolvers fail closed when the variable is
unset and `NODE_ENV` is `production` (`libs/backend-common/src/security/encryption/`), so every
`createWorker` and every read of an encrypted worker column throws.

Neither variable is part of the droplet deploy contract on main (d3adb0f89):

- `platform/libs/service-catalog/src/index.ts` (farm-service `requiredEnv`) lists neither key, so
  `infrastructure/deploy/required-secrets.yaml` (generated from it) does not either.
- `docker-compose.droplet.yml` farm-service `environment` does not interpolate them.
- `scripts/deploy/lib/required-env-secrets.sh` has no bootstrap entry, so `droplet-up.sh`
  Phase A2a never provisions them.

Production evidence (names only, no values read): no running container carries an
`EMPLOYEE_PII_*` variable; `aqua-farm`, `aqua-hr` and `aqua-notification` run with
`NODE_ENV=production`. The droplet `.env` holds an `EMPLOYEE_PII_BLIND_INDEX_KEY` line and no
`EMPLOYEE_PII_ENCRYPTION_KEY` line.

PR #1670 added only `EMPLOYEE_PII_BLIND_INDEX_KEY` to the farm-service compose block. An
uncommitted edit in `/var/aqua-wt-farmfix` added both keys to `gateway-api`, which never reads
them, and hand-edited the generated `required-secrets.yaml`, which `npm run service-catalog:check`
rejects.

Fix: declare both keys in the farm-service catalog entry, interpolate them as `:?` in the
farm-service compose block, regenerate the catalog artifacts, and give both a
generate-if-absent bootstrap entry. Generation is safe for the encryption key because no compose
revision ever delivered it to farm-service or hr-service and the transformer refuses to write
without it, so no production ciphertext under another key exists; the blind-index line already in
the droplet `.env` is kept, since the bootstrap never overwrites.

## DEPLOY-HIGH-028

Severity: HIGH. Deadline: 2026-10-31.

The same class remains open on two more keys, and nothing detects it:

- `apps/hr-service/src/hr/entities/employee.entity.ts:233` reads `EMPLOYEE_PII_ENCRYPTION_KEY`
  (it must be the farm-service value, the key is shared); the hr-service compose block does not
  interpolate it.
- `apps/farm-service/src/regulatory/entities/regulatory-settings.entity.ts:88` reads
  `REGULATORY_ENCRYPTION_KEY`; nothing wires it. Rows re-encrypted by
  `1801000000000-ReEncryptSecretsCbcToGcm` may already depend on a specific value, so it needs the
  pre-provisioned (never generated) semantics of `SENTINEL_HUB_ENCRYPTION_KEY` and a data check
  before wiring.
- No invariant ties the key names passed to `createEncryptedColumnTransformer` /
  `createBlindIndex` in `apps/<service>` to that service's catalog `requiredEnv`.

Fix: wire both services through the catalog and compose with the right bootstrap semantics, and
add an invariant that derives the key names from the transformer call sites and fails when a
service's catalog entry or compose block omits one.
