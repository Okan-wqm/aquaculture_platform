import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RetireAdminPlanDefinitions — `admin.plan_definitions` leaves the admin schema
 * (ADR-0013, BILLING-CRITICAL-002).
 *
 * WHY: two plan catalogues existed and only one was ever resolved. Every
 * runtime path — create-subscription, change-plan, the billing scheduler, the
 * provisioning handler — reads `billing.plans`; `admin.plan_definitions`
 * carried its own ids that nothing resolved, a SECOND writable home for the
 * plan's Stripe product and price ids, and a four-cycle price matrix inside a
 * `jsonb` column where no CHECK could reject a negative price or a
 * `discountPercent` of 400. `MergePlanCatalogue1802200000000` folded it into
 * `billing.plans` + `plan_cycle_prices` + `plan_add_ons`.
 *
 * SAFETY SHAPE: no archive table — the rows were COPIED and EXPANDED into
 * billing first (`SCHEMA_REGISTRY` runs billing at slot 8, admin at slot 11).
 * This migration re-verifies by NAME (the catalogue's UNIQUE business key, and
 * the key the merge matched on) that every definition has a counterpart, and
 * that every cycle it priced and every add-on it sold became a row. It RAISES
 * rather than dropping if one is missing, so a partially-applied deploy stops
 * loudly instead of destroying the only copy of a price.
 *
 * ID REMAP: the merge UPDATES a billing plan whose name matches, so a matched
 * definition's own id does NOT survive. Two admin tables referenced it —
 * `plan_module_assignments.plan_id` and `custom_plans."basePlanId"` — and both
 * are re-pointed at the surviving `billing.plans.id` here, BEFORE the drop.
 *
 * `admin.custom_plans` carries TWO columns for the same reference: the entity
 * declared `@Column('uuid') basePlanId` (camel-cased by TypeORM, and the one
 * the ORM actually wrote) alongside a `@JoinColumn({ name: 'base_plan_id' })`
 * that the FK was built on and nothing ever populated. Both are re-pointed,
 * each guarded by a column probe, so neither a deployment that has only one
 * nor one that has both is left with a dangling id.
 * Their FK constraints go with the table: since the catalogue is billing's, an
 * admin FK onto `billing.plans` would let admin DDL block billing from
 * retiring a plan row, so both columns become soft references (matching the
 * entities, which no longer declare the relation).
 */
export class RetireAdminPlanDefinitions1809100000000 implements MigrationInterface {
  name = 'RetireAdminPlanDefinitions1809100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(`
      DO $$
      DECLARE
        missing_plans bigint;
        missing_cycles bigint;
        missing_add_ons bigint;
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'admin' AND table_name = 'plan_definitions'
        ) THEN
          RETURN;
        END IF;

        IF to_regclass('billing.plan_cycle_prices') IS NULL THEN
          RAISE EXCEPTION
            'billing.plan_cycle_prices does not exist — run the billing migrations (MergePlanCatalogue1802200000000) before retiring admin.plan_definitions';
        END IF;

        SELECT count(*) INTO missing_plans
          FROM "admin"."plan_definitions" d
         WHERE NOT EXISTS (
           SELECT 1 FROM "billing"."plans" p WHERE p."name" = d."name"
         );
        IF missing_plans > 0 THEN
          RAISE EXCEPTION
            '% admin.plan_definitions rows have no counterpart in billing.plans — refusing to drop the only copy',
            missing_plans;
        END IF;

        -- Every cycle the definition priced must be a row. "pricing" holds the
        -- four cycles under camelCase keys; "semiAnnual" is "semi_annual" in the
        -- enum, which is exactly the kind of mismatch that silently drops a price.
        SELECT count(*) INTO missing_cycles
          FROM "admin"."plan_definitions" d
          JOIN "billing"."plans" p ON p."name" = d."name"
          CROSS JOIN LATERAL (
            VALUES ('monthly', 'monthly'), ('quarterly', 'quarterly'),
                   ('semiAnnual', 'semi_annual'), ('annual', 'annual')
          ) AS cycle(json_key, enum_value)
         WHERE d."pricing" ? cycle.json_key
           AND NOT EXISTS (
             SELECT 1 FROM "billing"."plan_cycle_prices" c
              WHERE c."plan_id" = p."id"
                AND c."billing_cycle"::text = cycle.enum_value
           );
        IF missing_cycles > 0 THEN
          RAISE EXCEPTION
            '% admin.plan_definitions cycle prices have no row in billing.plan_cycle_prices — refusing to drop the only copy of a price',
            missing_cycles;
        END IF;

        SELECT count(*) INTO missing_add_ons
          FROM "admin"."plan_definitions" d
          JOIN "billing"."plans" p ON p."name" = d."name"
          CROSS JOIN LATERAL jsonb_array_elements(
            COALESCE(d."features"->'addOns', '[]'::jsonb)
          ) AS add_on
         WHERE NOT EXISTS (
           SELECT 1 FROM "billing"."plan_add_ons" a
            WHERE a."plan_id" = p."id" AND a."code" = add_on->>'code'
         );
        IF missing_add_ons > 0 THEN
          RAISE EXCEPTION
            '% admin.plan_definitions add-ons have no row in billing.plan_add_ons — refusing to drop the only copy of a price',
            missing_add_ons;
        END IF;

        -- Re-point the two referencing admin tables at the surviving billing id.
        -- A no-op for a definition the merge INSERTed (it kept its id).
        UPDATE "admin"."plan_module_assignments" a
           SET "plan_id" = p."id"
          FROM "admin"."plan_definitions" d
          JOIN "billing"."plans" p ON p."name" = d."name"
         WHERE a."plan_id" = d."id" AND p."id" <> d."id";

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'admin' AND table_name = 'custom_plans'
             AND column_name = 'basePlanId'
        ) THEN
          UPDATE "admin"."custom_plans" c
             SET "basePlanId" = p."id"
            FROM "admin"."plan_definitions" d
            JOIN "billing"."plans" p ON p."name" = d."name"
           WHERE c."basePlanId" = d."id" AND p."id" <> d."id";
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'admin' AND table_name = 'custom_plans'
             AND column_name = 'base_plan_id'
        ) THEN
          UPDATE "admin"."custom_plans" c
             SET "base_plan_id" = p."id"
            FROM "admin"."plan_definitions" d
            JOIN "billing"."plans" p ON p."name" = d."name"
           WHERE c."base_plan_id" = d."id" AND p."id" <> d."id";
        END IF;
      END $$;
    `);

    // The FKs onto the admin catalogue go with it. Named explicitly rather than
    // relying on CASCADE from the DROP so a rename in an older deployment is a
    // visible no-op instead of a silently surviving constraint.
    await queryRunner.query(`
      DO $$
      DECLARE
        constraint_row record;
      BEGIN
        FOR constraint_row IN
          SELECT c.conname, n.nspname, t.relname
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
           WHERE c.contype = 'f'
             AND c.confrelid = to_regclass('admin.plan_definitions')
        LOOP
          EXECUTE format(
            'ALTER TABLE %I.%I DROP CONSTRAINT %I',
            constraint_row.nspname, constraint_row.relname, constraint_row.conname
          );
        END LOOP;
      END $$;
    `);

    // DESTRUCTIVE: every definition, cycle price and add-on verified present in billing.plans / plan_cycle_prices / plan_add_ons by name above, and both referencing columns re-pointed; rollback = re-copy from billing (see this migration's docblock)
    await queryRunner.query(`DROP TABLE IF EXISTS "admin"."plan_definitions"`);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only. The rows are in billing.plans and its two child tables,
    // which is now their only home; recreating the admin table would reinstate
    // the second catalogue ADR-0013 removes — with ids nothing resolves and a
    // second writable home for the plan's Stripe objects.
  }
}
