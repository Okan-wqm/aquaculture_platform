# Runbook: 2026-04-14 Public-Schema Teardown Rollout

Production rollout procedure for the 14-commit teardown series. This
runbook is the executable form of P13 from the original plan.

## Pre-flight checklist

  - [ ] Plan reviewed: `docs/plans/2026-04-14-...` (or the equivalent
        location) — every reviewer signed off on the 14 commits.
  - [ ] Encrypted production DB snapshot taken (`pg_dump --format=custom
        --file=/backup/aquaculture-pre-teardown-$(date +%Y%m%dT%H%M%S).dump`)
        and uploaded to a 24-hour-retention S3 location.
  - [ ] Staging environment running the merged main branch for ≥ 24h
        with no `rls.bootstrap.failed` or `schema.drift.detected`
        alerts.
  - [ ] Integration test suite green:
        `npm run test:integration -- schema-invariants` passes
        (asserts public empty + shared layout + 10 moved tables).

## Rollout sequence

The 14 commits are deploy-order-independent in the sense that any
prefix of them is internally consistent, but the FULL effect requires
all of them deployed together. Recommended: deploy as a single
release tag.

### Phase A — Foundation (P1 + P2 + P3 + P4 + P5)

  1. Deploy commits f1c75ae5 through 7f38b15b (P1 + P3 + P4 + P5) and
     the P2 series (4777e8b7 through c52c9632).
  2. Apply `infrastructure/docker/init-scripts/06-public-schema-ownership.sql`
     to the live DB if not yet applied (P1's safety net for fresh
     deploys; live droplet got it manually via commit ef8e1042). Apply
     `infrastructure/docker/init-scripts/09-hr-outbox.sql` for the HR
     outbox creation.
  3. Restart all backend services in rolling fashion (see
     `docs/runbooks/post-deploy-pool-recycle.md`).
  4. Verify:
     - All services log `Tenant RLS applied to N tables in schema "X"`
       on first cold start.
     - `aqua-billing` logs `Migration "AddPlanSoftDeleteColumns" applied`.
     - `aqua-hr` no longer logs `Outbox poll cycle failed: relation
       "hr_outbox" does not exist`.

### Phase B — Table moves (P6-P8 + P9)

  1. Deploy commits f18d9529 (P6-P8) and 834b4b88 (P9).
  2. Apply `infrastructure/docker/init-scripts/10-shared-schema.sql`
     to the live DB:
     ```bash
     docker exec -i aqua-postgres psql -U aquaculture -d aquaculture \
       < infrastructure/docker/init-scripts/10-shared-schema.sql
     ```
     This creates the `shared` schema, moves the four cross-service
     tables, installs RLS policies, and drops the legacy
     `shared_public_owner` role.
  3. Run the per-service migrations against the live DB. Each service's
     own MigrationRunnerService will execute its pending migrations
     on next restart — the canary tests below verify the SET SCHEMA
     moves landed correctly.
  4. Rolling restart all backend services (per the pool-recycle
     runbook). The order matters here: services that own moved tables
     should restart before services that read them, so the migration
     completes before downstream queries hit the table:
     - farm, sensor, hr, auth, notification first
     - billing, config, alert, ai, admin-api, gateway second

### Phase C — Validation

  1. Run integration test suite:
     ```bash
     npm run test:integration -- schema-invariants
     # Expected: 12 passing
     ```
  2. Manual SQL verification:
     ```sql
     -- public should contain only `migrations`
     SELECT tablename FROM pg_tables WHERE schemaname = 'public';
     -- Expected: just 'migrations' (+ pg extension artifacts)

     -- shared should contain exactly 4 tables
     SELECT tablename FROM pg_tables WHERE schemaname = 'shared'
     ORDER BY tablename;
     -- Expected: audit_logs, gdpr_data_requests, user_consents, user_permissions

     -- Each moved table in its expected schema
     SELECT tablename, schemaname FROM pg_tables
     WHERE tablename IN ('weather_observations', 'employees', 'tenant_roles',
                         'channel_detection_log', 'device_tokens',
                         'sensor_type_definitions', 'feeder_calibrations',
                         'marine_observations', 'weather_settings',
                         'notification_logs')
     ORDER BY tablename;
     -- Expected: each table in its owner schema (NOT public)
     ```
  3. Cross-tenant leak test:
     ```sql
     -- As tenant A
     SET app.current_tenant = '<tenant-a-uuid>';
     SELECT COUNT(*) FROM shared.audit_logs;
     -- Expected: only tenant A's count

     -- As tenant B
     SET app.current_tenant = '<tenant-b-uuid>';
     SELECT COUNT(*) FROM shared.audit_logs;
     -- Expected: disjoint from tenant A's count

     -- Bypass check (admin-api context)
     SET app.bypass_rls = 'on';
     SELECT COUNT(*) FROM shared.audit_logs;
     -- Expected: total cross-tenant count
     ```

### Phase D — Drift validator opt-in

  1. After 1 deploy cycle of clean operation (no
     `schema.drift.detected` alerts), flip the validator to fatal mode
     in staging:
     ```yaml
     # docker-compose.staging.yml or values-staging.yaml
     SCHEMA_DRIFT_FATAL: 'true'
     ```
     Restart staging services. Verify clean boot.
  2. After 1 week of clean staging operation, repeat for production.

## Rollback

If Phase B causes a regression (test failures, error rate spike):

  1. Each P6-P9 migration has a working `down()` method. Run them in
     reverse order via TypeORM CLI:
     ```bash
     cd apps/<svc>
     npm run typeorm -- migration:revert --dataSource=src/database/data-source.ts
     ```
  2. Reverse-apply 10-shared-schema.sql by running its inverse:
     ```sql
     -- (Inverse SQL — operator-written; not in repo because rollback is
     -- expected to be exceptional)
     ALTER TABLE shared.audit_logs SET SCHEMA public;
     -- ... etc for each table
     ```
  3. Re-run the post-deploy-pool-recycle procedure.
  4. Restore from snapshot if data corruption is suspected.

## Post-rollout monitoring

For 1 week after rollout:

  - Grafana alert on `rls.bootstrap.failed` (zero tolerance).
  - Grafana alert on `schema.drift.detected > 0` per service.
  - PostgreSQL slow-query log: any query spending > 100ms on the
    moved tables (indicates a missed reader using the wrong schema).
  - Application error rate baseline + 7-day rolling comparison.
