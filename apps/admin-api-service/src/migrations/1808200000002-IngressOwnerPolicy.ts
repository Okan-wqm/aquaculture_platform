import { MigrationInterface, QueryRunner } from 'typeorm';

export class IngressOwnerPolicy1808200000002 implements MigrationInterface {
  name = 'IngressOwnerPolicy1808200000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "admin"."ingress_owner_policies" (
                "tenant_id" uuid NOT NULL,
                "version" integer NOT NULL,
                "owner" character varying(8) NOT NULL,
                "effective_epoch" TIMESTAMP WITH TIME ZONE NOT NULL,
                "state" character varying(12) NOT NULL,
                "drain_barrier_satisfied" boolean NOT NULL,
                "drain_barrier_evidence" character varying(128),
                "actor_id" uuid,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "PK_6df069f3c9f331521e32e85bcfe" PRIMARY KEY ("tenant_id", "version")
            )
        `);
  }

  public async down(): Promise<void> {
    throw new Error(
      'Ingress owner policy is forward-only; dropping its ledger would destroy handoff history',
    );
  }
}
