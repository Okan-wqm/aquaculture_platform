-- ============================================================================
-- Platform Bootstrap — Stage 8 of 10: Least-Privilege Runtime Boundary
--
-- Stage 004 intentionally preserved the historical broad grants so bootstrap
-- could run against already-live databases. This final stage is the executable
-- boundary: app runtime roles end DML-only, schema ownership moves to NOLOGIN
-- owner roles, and db_migrate is the only role granted schema-owner membership.
-- ============================================================================

DO $least_privilege_runtime_boundary$
DECLARE
  spec record;
  relation record;
  service_role text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'db_migrate') THEN
    CREATE ROLE db_migrate NOLOGIN;
  END IF;

  FOR spec IN
    SELECT *
    FROM jsonb_to_recordset(
      '[
        {"schema_name":"auth","owner_role":"auth_schema_owner","runtime_role":"auth_service","provisioner_role":null},
        {"schema_name":"farm","owner_role":"farm_schema_owner","runtime_role":"farm_service","provisioner_role":"farm_tenant_provisioner"},
        {"schema_name":"sensor","owner_role":"sensor_schema_owner","runtime_role":"sensor_service","provisioner_role":"sensor_tenant_provisioner"},
        {"schema_name":"hr","owner_role":"hr_schema_owner","runtime_role":"hr_service","provisioner_role":"hr_tenant_provisioner"},
        {"schema_name":"messaging","owner_role":"messaging_schema_owner","runtime_role":"messaging_service","provisioner_role":"messaging_tenant_provisioner"},
        {"schema_name":"hydroponics","owner_role":"hydroponics_schema_owner","runtime_role":"hydroponics_service","provisioner_role":"hydroponics_tenant_provisioner"},
        {"schema_name":"alert","owner_role":"alert_schema_owner","runtime_role":"alert_service","provisioner_role":"alert_tenant_provisioner"},
        {"schema_name":"billing","owner_role":"billing_schema_owner","runtime_role":"billing_service","provisioner_role":null},
        {"schema_name":"notification","owner_role":"notification_schema_owner","runtime_role":"notification_service","provisioner_role":null},
        {"schema_name":"ai","owner_role":"ai_schema_owner","runtime_role":"ai_service","provisioner_role":"ai_tenant_provisioner"},
        {"schema_name":"admin","owner_role":"admin_schema_owner","runtime_role":"admin_service","provisioner_role":null},
        {"schema_name":"observability","owner_role":"observability_schema_owner","runtime_role":"observability_service","provisioner_role":null},
        {"schema_name":"event_store","owner_role":"event_store_schema_owner","runtime_role":"event_store_service","provisioner_role":null},
        {"schema_name":"config","owner_role":"config_schema_owner","runtime_role":"config_service","provisioner_role":null},
        {"schema_name":"gateway","owner_role":"gateway_schema_owner","runtime_role":"gateway_service","provisioner_role":null}
      ]'::jsonb
    ) AS x(schema_name text, owner_role text, runtime_role text, provisioner_role text)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = spec.owner_role) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', spec.owner_role);
    END IF;

    EXECUTE format('GRANT %I TO db_migrate', spec.owner_role);

    IF spec.provisioner_role IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = spec.provisioner_role) THEN
        EXECUTE format('CREATE ROLE %I NOLOGIN', spec.provisioner_role);
      END IF;
      EXECUTE format('GRANT CREATE ON DATABASE %I TO %I', current_database(), spec.provisioner_role);
    END IF;

    EXECUTE format('REASSIGN OWNED BY %I TO %I', spec.runtime_role, spec.owner_role);
    EXECUTE format('ALTER SCHEMA %I OWNER TO %I', spec.schema_name, spec.owner_role);

    -- Ownership realignment, three passes (2026-06-11 production incident:
    -- the original single loop ran ALTER SEQUENCE on column-linked serial/
    -- identity sequences, which PostgreSQL refuses outright — "cannot change
    -- owner of sequence ... linked to table" — even for a superuser. CI never
    -- saw it because bootstrap-from-scratch runs this stage against EMPTY
    -- schemas; only a pre-existing production database has relations here.)
    --
    --   Pass 1: tables / partitioned tables / foreign tables — ALTER TABLE
    --           moves column-linked sequences along automatically.
    --   Pass 2: views + materialized views.
    --   Pass 3: free-standing sequences ONLY (pg_depend 'a'/'i' rows mark
    --           column-linked sequences, which pass 1 already moved).
    --
    -- Every pass skips relations whose owner already matches (idempotent —
    -- re-running the stage performs zero ALTERs on an aligned database, so
    -- a least-privilege db_migrate run cannot trip over objects it could
    -- not re-own anyway).
    FOR relation IN
      SELECT c.oid::regclass::text AS qualified_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
      WHERE n.nspname = spec.schema_name
        AND c.relkind IN ('r', 'p', 'f')
        AND r.rolname IS DISTINCT FROM spec.owner_role
    LOOP
      EXECUTE format('ALTER TABLE %s OWNER TO %I', relation.qualified_name, spec.owner_role);
    END LOOP;

    FOR relation IN
      SELECT c.relkind, c.oid::regclass::text AS qualified_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
      WHERE n.nspname = spec.schema_name
        AND c.relkind IN ('v', 'm')
        AND r.rolname IS DISTINCT FROM spec.owner_role
    LOOP
      IF relation.relkind = 'm' THEN
        EXECUTE format('ALTER MATERIALIZED VIEW %s OWNER TO %I', relation.qualified_name, spec.owner_role);
      ELSE
        EXECUTE format('ALTER VIEW %s OWNER TO %I', relation.qualified_name, spec.owner_role);
      END IF;
    END LOOP;

    FOR relation IN
      SELECT c.oid::regclass::text AS qualified_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
      WHERE n.nspname = spec.schema_name
        AND c.relkind = 'S'
        AND r.rolname IS DISTINCT FROM spec.owner_role
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_depend d
          WHERE d.classid = 'pg_catalog.pg_class'::regclass
            AND d.objid = c.oid
            AND d.refclassid = 'pg_catalog.pg_class'::regclass
            AND d.deptype IN ('a', 'i')
        )
    LOOP
      EXECUTE format('ALTER SEQUENCE %s OWNER TO %I', relation.qualified_name, spec.owner_role);
    END LOOP;
    EXECUTE format('REVOKE CREATE ON DATABASE %I FROM %I', current_database(), spec.runtime_role);

    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I', spec.schema_name, spec.runtime_role);
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', spec.schema_name, spec.runtime_role);

    -- NOTE (DATA-HIGH-006): the 2026-06-11 messaging CREATE carve-out that
    -- lived here was dissolved by Stage 010 — partition DDL now runs through
    -- platform.create_messaging_partition (SECURITY DEFINER owned by
    -- messaging_schema_owner; ownership is the binding pg16 requirement,
    -- proven empirically — schema CREATE alone cannot create a partition).
    -- The messaging runtime holds EXECUTE only, so this REVOKE/GRANT pair
    -- applies uniformly to every runtime role again. The idempotent re-run
    -- of this stage is also what revokes the old carve-out grant on
    -- already-bootstrapped databases (REVOKE ALL above).

    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM %I',
      spec.schema_name,
      spec.runtime_role
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I',
      spec.schema_name,
      spec.runtime_role
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM %I',
      spec.schema_name,
      spec.runtime_role
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
      spec.schema_name,
      spec.runtime_role
    );

    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM %I',
      spec.schema_name,
      spec.runtime_role
    );
    EXECUTE format(
      'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO %I',
      spec.schema_name,
      spec.runtime_role
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM %I',
      spec.schema_name,
      spec.runtime_role
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I',
      spec.schema_name,
      spec.runtime_role
    );
  END LOOP;

  -- admin.tenant_schemas is the committed tenant-schema identity ledger.
  -- The admin runtime may read it and may update only the lifecycle evidence
  -- written by its provisioning/deprovisioning sagas. Stage 004 and the
  -- generic loop above intentionally grant the common DML envelope first;
  -- this object-specific contract must therefore run after that loop on every
  -- bootstrap invocation. On a fresh database the admin migration chain
  -- creates the table later and asserts the same envelope itself.
  IF to_regclass('admin.tenant_schemas') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE
      ON TABLE admin.tenant_schemas
      FROM admin_service;
    GRANT SELECT
      ON TABLE admin.tenant_schemas
      TO admin_service;
    GRANT UPDATE ("status", "metadata", "updatedAt")
      ON TABLE admin.tenant_schemas
      TO admin_service;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'shared_schema_owner') THEN
    CREATE ROLE shared_schema_owner NOLOGIN;
  END IF;
  GRANT shared_schema_owner TO db_migrate;
  ALTER SCHEMA shared OWNER TO shared_schema_owner;

  -- Compliance schema (INFRA-HIGH-015): cross-service legal-hold registry,
  -- same ownership discipline as `shared`. Relations are re-owned too —
  -- compliance.legal_holds was created by the admin-api migration chain
  -- under the migration connection's role, not by bootstrap.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'compliance_schema_owner') THEN
    CREATE ROLE compliance_schema_owner NOLOGIN;
  END IF;
  GRANT compliance_schema_owner TO db_migrate;
  ALTER SCHEMA compliance OWNER TO compliance_schema_owner;
  FOR relation IN
    SELECT c.oid::regclass::text AS qualified_name
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
    WHERE n.nspname = 'compliance'
      AND c.relkind IN ('r', 'p', 'f')
      AND r.rolname IS DISTINCT FROM 'compliance_schema_owner'
  LOOP
    EXECUTE format('ALTER TABLE %s OWNER TO compliance_schema_owner', relation.qualified_name);
  END LOOP;
  FOR relation IN
    SELECT c.oid::regclass::text AS qualified_name
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
    WHERE n.nspname = 'compliance'
      AND c.relkind = 'S'
      AND r.rolname IS DISTINCT FROM 'compliance_schema_owner'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_catalog.pg_class'::regclass
          AND d.objid = c.oid
          AND d.refclassid = 'pg_catalog.pg_class'::regclass
          AND d.deptype IN ('a', 'i')
      )
  LOOP
    EXECUTE format('ALTER SEQUENCE %s OWNER TO compliance_schema_owner', relation.qualified_name);
  END LOOP;

  REVOKE USAGE ON SCHEMA compliance FROM PUBLIC;
  REVOKE SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA compliance FROM PUBLIC;
  REVOKE USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA compliance FROM PUBLIC;
  ALTER DEFAULT PRIVILEGES IN SCHEMA compliance
    REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM PUBLIC;
  ALTER DEFAULT PRIVILEGES IN SCHEMA compliance
    REVOKE USAGE, SELECT, UPDATE ON SEQUENCES FROM PUBLIC;

  REVOKE USAGE ON SCHEMA shared FROM PUBLIC;
  REVOKE SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA shared FROM PUBLIC;
  REVOKE USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA shared FROM PUBLIC;
  ALTER DEFAULT PRIVILEGES IN SCHEMA shared
    REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM PUBLIC;
  ALTER DEFAULT PRIVILEGES IN SCHEMA shared
    REVOKE USAGE, SELECT, UPDATE ON SEQUENCES FROM PUBLIC;

  REVOKE USAGE ON SCHEMA platform FROM PUBLIC;
  REVOKE SELECT ON platform.bootstrap_signal FROM PUBLIC;
  REVOKE SELECT ON platform.release_ledger FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION public.current_tenant_id() FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION public.set_tenant_id(uuid) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION public.update_updated_at_column() FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION public.audit_immutability_guard() FROM PUBLIC;

  FOREACH service_role IN ARRAY ARRAY[
    'auth_service',
    'farm_service',
    'sensor_service',
    'billing_service',
    'hr_service',
    'alert_service',
    'admin_service',
    'gateway_service',
    'notification_service',
    'hydroponics_service',
    'ai_service',
    'messaging_service',
    'observability_service',
    'event_store_service',
    'config_service'
  ]
  LOOP
    EXECUTE format('REVOKE shared_schema_owner FROM %I', service_role);
    EXECUTE format('GRANT USAGE ON SCHEMA shared TO %I', service_role);
    EXECUTE format('REVOKE compliance_schema_owner FROM %I', service_role);
    EXECUTE format('GRANT USAGE ON SCHEMA compliance TO %I', service_role);
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA compliance TO %I',
      service_role
    );
    EXECUTE format(
      'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA compliance TO %I',
      service_role
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
      service_role
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I',
      service_role
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA shared TO %I',
      service_role
    );
    EXECUTE format(
      'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA shared TO %I',
      service_role
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
      service_role
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I',
      service_role
    );
    EXECUTE format('GRANT USAGE ON SCHEMA platform TO %I', service_role);
    EXECUTE format('GRANT SELECT ON platform.bootstrap_signal TO %I', service_role);
    EXECUTE format('GRANT SELECT ON platform.release_ledger TO %I', service_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO %I', service_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.set_tenant_id(uuid) TO %I', service_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.update_updated_at_column() TO %I', service_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.audit_immutability_guard() TO %I', service_role);
  END LOOP;

  ALTER ROLE sensor_ingestion
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  EXECUTE format('GRANT CONNECT, TEMP ON DATABASE %I TO sensor_ingestion', current_database());
  EXECUTE format('REVOKE CREATE ON DATABASE %I FROM sensor_ingestion', current_database());
  REVOKE ALL ON SCHEMA sensor FROM sensor_ingestion;
  REVOKE ALL ON SCHEMA shared FROM sensor_ingestion;
  REVOKE ALL ON SCHEMA compliance FROM sensor_ingestion;
  REVOKE ALL ON SCHEMA platform FROM sensor_ingestion;

END
$least_privilege_runtime_boundary$;
