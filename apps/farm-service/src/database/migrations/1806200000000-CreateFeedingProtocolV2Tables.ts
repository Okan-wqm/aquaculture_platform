import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateFeedingProtocolV2Tables1806200000000
 *
 * Feeding-protocol SSoT Faz 3 (FARM-HIGH-219): birleşik protokol modelinin
 * tabloları + saat dilimi SSoT kolonu.
 *
 *  - `feeding_protocols_v2`: band başına yem+oran+FCR+öğün planı taşıyan tek
 *    protokol varlığı (jsonb value-object'ler; doğrulama uygulama katmanında
 *    ProtocolValidationService'te).
 *  - `feeding_protocol_assignments`: protokol → ünite (Equipment.id) ataması;
 *    ünite başına TEK aktif atama partial unique index ile YAPISAL olarak
 *    garanti (tier-1).
 * Saat dilimi (D-4) için yeni kolon GEREKMEZ: `sites.timezone` Baseline'dan
 * beri mevcut (varchar(50) NOT NULL DEFAULT 'UTC') — D-4'ün işi bu kolonu
 * öğün saatlerinin TEK yorumlama kaynağı yapmak (Faz 5 motoru + mobil gün
 * sınırı aynı kaynağı okur; cron'lardaki Europe/Istanbul hardcode ölür).
 *
 * Her iki tablo TENANT-SCOPED'tur (schema fan-out MODULE_SCHEMAS listesiyle
 * tenant_<uuid> şemalarına klonlar); bu migration kaynak `farm` şemasında ve
 * her tenant pass'inde idempotent çalışır. DDL bu yüzden ŞEMA-NİTELEMESİZDİR
 * (tablolar VE enum tipleri) — her pass'in search_path'i nesneleri kendi
 * şemasına indirir; "farm" nitelemesi ORPHAN-HIGH-408'in bug şekliydi
 * (per-tenant tablo yalnız kaynak şemada oluşur, tenant klonları boş kalır).
 * Desen emsali: 1806000000000-CreateIncidentMedia.
 */
export class CreateFeedingProtocolV2Tables1806200000000 implements MigrationInterface {
  name = 'CreateFeedingProtocolV2Tables1806200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    // Enum tipleri NİTELEMESİZ oluşur — her schema pass'i tipi kendi şemasına
    // indirir (tablo ile aynı şemada yaşar; CreateIncidentMedia deseni).
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE feeding_protocols_v2_status_enum AS ENUM ('draft', 'active', 'archived');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE feeding_protocol_assignments_unittype_enum AS ENUM ('tank', 'pond', 'cage');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE feeding_protocol_assignments_status_enum AS ENUM ('active', 'paused', 'ended');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "feeding_protocols_v2" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "name" character varying(200) NOT NULL,
        "description" text,
        "speciesId" uuid,
        "speciesName" character varying(200),
        "status" feeding_protocols_v2_status_enum NOT NULL DEFAULT 'draft',
        "bands" jsonb NOT NULL,
        "temperatureAdjustments" jsonb,
        "defaultMealSchedule" jsonb NOT NULL,
        "fcrMatrix" jsonb,
        "settings" jsonb NOT NULL,
        "isDefault" boolean NOT NULL DEFAULT false,
        "migrationNote" text,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "createdBy" uuid,
        "updatedBy" uuid,
        "version" integer NOT NULL,
        "isDeleted" boolean NOT NULL DEFAULT false,
        "deletedAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_feeding_protocols_v2" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_fpv2_tenant_name" ON "feeding_protocols_v2" ("tenantId", "name")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fpv2_tenant_status" ON "feeding_protocols_v2" ("tenantId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fpv2_tenant_species" ON "feeding_protocols_v2" ("tenantId", "speciesId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fpv2_tenant_isdeleted" ON "feeding_protocols_v2" ("tenantId", "isDeleted")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fpv2_tenant" ON "feeding_protocols_v2" ("tenantId")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "feeding_protocol_assignments" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "unitId" uuid NOT NULL,
        "unitType" feeding_protocol_assignments_unittype_enum NOT NULL,
        "unitName" character varying(200) NOT NULL,
        "unitCode" character varying(50) NOT NULL,
        "siteId" uuid NOT NULL,
        "protocolId" uuid NOT NULL,
        "status" feeding_protocol_assignments_status_enum NOT NULL DEFAULT 'active',
        "effectiveFrom" date NOT NULL,
        "endedAt" TIMESTAMP WITH TIME ZONE,
        "overrides" jsonb NOT NULL DEFAULT '{}',
        "suspensions" jsonb NOT NULL DEFAULT '[]',
        "currentFeedId" uuid,
        "currentBandIndex" integer,
        "lastTransitionAt" TIMESTAMP WITH TIME ZONE,
        "totalTransitions" integer NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "createdBy" uuid,
        "updatedBy" uuid,
        "version" integer NOT NULL,
        CONSTRAINT "PK_feeding_protocol_assignments" PRIMARY KEY ("id")
      )
    `);
    // Ünite başına TEK aktif atama — yapısal garanti (çift planlama imkânsız).
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_fpa_tenant_unit_active" ON "feeding_protocol_assignments" ("tenantId", "unitId") WHERE "status" = 'active'`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fpa_tenant_protocol" ON "feeding_protocol_assignments" ("tenantId", "protocolId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fpa_tenant_status" ON "feeding_protocol_assignments" ("tenantId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fpa_tenant_unit_from" ON "feeding_protocol_assignments" ("tenantId", "unitId", "effectiveFrom")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fpa_tenant_site" ON "feeding_protocol_assignments" ("tenantId", "siteId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fpa_tenant" ON "feeding_protocol_assignments" ("tenantId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "feeding_protocol_assignments"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "feeding_protocols_v2"`);
    // Tipler şema-yerel oluştuğundan pass'in kendi şemasından güvenle düşer.
    await queryRunner.query(`DROP TYPE IF EXISTS feeding_protocol_assignments_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS feeding_protocol_assignments_unittype_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS feeding_protocols_v2_status_enum`);
  }
}
