# Messaging Schema Drift Tenant-Aware Source Resolution

Date: 2026-05-02

## Problem

After tenant business entities were correctly changed to schema-less TypeORM entities, `SchemaDriftValidator` still interpreted `entity.schema ?? 'public'`. For tenant-aware services such as messaging, schema-less entities are intentional: runtime SQL must stay unqualified so tenant `search_path` routes to `tenant_<uuid>`.

The validator reported false schema-location errors like `entity declares schema='public' but table lives in 'messaging'`.

## Enterprise Fix

`SchemaDriftValidator` now resolves schema-less entities in `TENANT_AWARE_SCHEMAS` to the service source schema for validation. Runtime SQL remains unqualified; validation compares against the canonical source table shape.

## Validation

Schema drift logs should no longer report tenant-aware business entities as `public` while still detecting explicit wrong-schema declarations for shared-schema services.
