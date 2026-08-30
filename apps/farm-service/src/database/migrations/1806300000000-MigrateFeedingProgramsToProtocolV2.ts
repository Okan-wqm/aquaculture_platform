import { MigrationInterface, QueryRunner } from 'typeorm';

import {
  convertProgramToProtocolV2,
  convertV1ProtocolToV2,
  resolveUniqueName,
  MIGRATED_PROGRAM_MARKER,
  MIGRATED_V1_PROTOCOL_MARKER,
  type ConvertedProtocol,
  type FeedRef,
  type LegacyProgramRow,
  type LegacyV1ProtocolRow,
  type SpeciesRef,
  type V1Enrichment,
} from '../../feeding-protocol/migration/legacy-protocol-conversion';

/**
 * MigrateFeedingProgramsToProtocolV2 (Faz 4 — plan §9.1–9.3, K-3, D-14)
 *
 * Veri taşıma #1: legacy FeedingProgram / v1 FeedingProtocol tanımları ve tank
 * atamaları FeedingProtocolV2 modeline taşınır. Dönüşüm matematiği SAF lib'de
 * (`feeding-protocol/migration/legacy-protocol-conversion.ts`, birim testli);
 * bu dosya yalnız okuma/yazma sıhhiyesi taşır.
 *
 *  - Programlar: ACTIVE → v2 ACTIVE; draft/paused → DRAFT; completed/cancelled
 *    taşınmaz. Band oran/FCR'ı feed matrisinden band-orta ağırlık +
 *    tenant-medyan sıcaklıkta örneklenir; tanklardaki batch v1 protokol
 *    taşıyorsa öğün/sıcaklık/oran oradan zenginleştirilir.
 *  - v1 protokoller: feedId çözülemeyen bantlar → DRAFT (migrationNote'lu);
 *    `preMedicationFasting` settings.adjustments'a aynen taşınır.
 *  - Atamalar (K-3): migrate edilen TÜM atamalar `paused` yaratılır — Faz 5
 *    motoru deploy olduğunda prod'da aktif v2 ataması YOKTUR (çift planlama
 *    imkânsız); Faz 6 cutover migration'ı operatör kapısıyla aktive eder.
 *  - Sitesi çözülemeyen üniteye atama YAZILMAZ (SEC-HIGH-051 fail-closed
 *    duruşu); D-14 mutabakat scripti bu üniteleri sayar/listeler.
 *
 * İdempotency: protokoller migrationNote başındaki `[migrated:...:<id>]`
 * işaretiyle, atamalar (tenantId, unitId) üzerindeki mevcut active/paused
 * atama kontrolüyle korunur — tekrar koşum çift kayıt üretmez.
 *
 * DDL yok; tüm ifadeler ŞEMA-NİTELEMESİZ ve her pass kendi şemasının verisini
 * işler (tenant fan-out disiplini — CreateFeedingProtocolV2Tables ile aynı).
 */
export class MigrateFeedingProgramsToProtocolV21806300000000 implements MigrationInterface {
  name = 'MigrateFeedingProgramsToProtocolV21806300000000';

  /** Migration'ın yazdığı atamaların ayırt edici createdBy işareti (rapor + idempotency). */
  static readonly ASSIGNMENT_SENTINEL = '00000000-0000-4000-8000-0000000000f4';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '300s'`);

    // ── Bağlam yükleri (pass'in kendi şeması) ────────────────────────────────
    const feeds: Array<FeedRef & { tenantId: string }> = await queryRunner.query(
      `SELECT id, "tenantId", code, name, type, "feedingMatrix2D" FROM "feeds" WHERE "isDeleted" = false`,
    );
    const speciesRows: Array<SpeciesRef & { tenantId: string }> = await queryRunner.query(
      `SELECT id, "tenantId", "commonName", "scientificName", "localName", "growthStages" FROM "species"`,
    );
    const v1Protocols: LegacyV1ProtocolRow[] = await queryRunner.query(
      `SELECT id, "tenantId", name, description, "feedId", species, "targetFcr",
              "minDissolvedOxygen", "temperatureRanges", "growthStageProtocols",
              "defaultSchedule", "isDefault"
       FROM "feeding_protocols" WHERE "isActive" = true`,
    );
    const programs: LegacyProgramRow[] = await queryRunner.query(
      `SELECT id, "tenantId", name, description, status, "feedAssignments", "fcrTable", settings
       FROM "feeding_programs"
       WHERE "isDeleted" = false AND status IN ('draft', 'active', 'paused')`,
    );
    const programTanks: Array<{
      tenantId: string;
      feedingProgramId: string;
      equipmentId: string;
      equipmentType: 'tank' | 'pond' | 'cage';
      equipmentName: string;
      equipmentCode: string;
      currentFeedId: string | null;
    }> = await queryRunner.query(
      `SELECT "tenantId", "feedingProgramId", "equipmentId", "equipmentType",
              "equipmentName", "equipmentCode", "currentFeedId"
       FROM "feeding_program_tanks"
       WHERE "isActive" = true AND "removedAt" IS NULL`,
    );
    const medianTemps: Array<{ tenantId: string; median: string | number | null }> =
      await queryRunner.query(
        `SELECT "tenantId", percentile_cont(0.5) WITHIN GROUP (ORDER BY temperature) AS median
         FROM "water_quality_measurements"
         WHERE temperature IS NOT NULL AND "measuredAt" >= now() - interval '90 days'
         GROUP BY "tenantId"`,
      );
    const existingV2: Array<{
      id: string;
      tenantId: string;
      name: string;
      migrationNote: string | null;
    }> = await queryRunner.query(
      `SELECT id, "tenantId", name, "migrationNote" FROM "feeding_protocols_v2"`,
    );
    // Program → tanklarındaki birincil batch'lerin v1 protokolü (zenginleştirme).
    const programBatchProtocols: Array<{
      feedingProgramId: string;
      protocolId: string;
      cnt: string | number;
    }> = await queryRunner.query(
      `SELECT fpt."feedingProgramId", b."protocolId", COUNT(*) AS cnt
       FROM "feeding_program_tanks" fpt
       JOIN "tank_batches" tb ON tb."tankId" = fpt."equipmentId" AND tb."tenantId" = fpt."tenantId"
       JOIN "batches_v2" b ON b.id = tb."primaryBatchId"
       WHERE fpt."isActive" = true AND fpt."removedAt" IS NULL
         AND b."protocolId" IS NOT NULL AND b."isActive" = true
       GROUP BY fpt."feedingProgramId", b."protocolId"`,
    );
    // Batch.protocolId → batch'in balıklı üniteleri (atama türetimi, plan §9.3).
    const batchUnits: Array<{
      tenantId: string;
      protocolId: string;
      unitId: string;
      unitName: string | null;
      unitCode: string | null;
    }> = await queryRunner.query(
      `SELECT tb."tenantId", b."protocolId", tb."tankId" AS "unitId",
              tb."tankName" AS "unitName", tb."tankCode" AS "unitCode"
       FROM "tank_batches" tb
       JOIN "batches_v2" b ON b.id = tb."primaryBatchId"
       WHERE b."protocolId" IS NOT NULL AND b."isActive" = true AND tb."totalQuantity" > 0`,
    );

    // ── İndeksler ────────────────────────────────────────────────────────────
    const feedsByTenant = new Map<string, Map<string, FeedRef>>();
    const feedsByTypeByTenant = new Map<string, Map<string, FeedRef[]>>();
    for (const feedRow of feeds) {
      const byId = feedsByTenant.get(feedRow.tenantId) ?? new Map<string, FeedRef>();
      byId.set(feedRow.id, feedRow);
      feedsByTenant.set(feedRow.tenantId, byId);
      const byType = feedsByTypeByTenant.get(feedRow.tenantId) ?? new Map<string, FeedRef[]>();
      const bucket = byType.get(feedRow.type) ?? [];
      bucket.push(feedRow);
      byType.set(feedRow.type, bucket);
      feedsByTypeByTenant.set(feedRow.tenantId, byType);
    }
    const speciesByTenant = new Map<string, Array<SpeciesRef & { tenantId: string }>>();
    for (const row of speciesRows) {
      const bucket = speciesByTenant.get(row.tenantId) ?? [];
      bucket.push(row);
      speciesByTenant.set(row.tenantId, bucket);
    }
    const medianByTenant = new Map<string, number>();
    for (const row of medianTemps) {
      const value = row.median === null ? null : Number(row.median);
      if (value !== null && Number.isFinite(value)) medianByTenant.set(row.tenantId, value);
    }
    const v1ById = new Map(v1Protocols.map((protocol) => [protocol.id, protocol]));
    const takenNamesByTenant = new Map<string, Set<string>>();
    const migratedMarkerToV2 = new Map<string, string>();
    for (const row of existingV2) {
      const names = takenNamesByTenant.get(row.tenantId) ?? new Set<string>();
      names.add(row.name.toLowerCase());
      takenNamesByTenant.set(row.tenantId, names);
      const marker = row.migrationNote?.match(/^\[migrated:[^\]]+\]/)?.[0];
      if (marker) migratedMarkerToV2.set(`${row.tenantId}:${marker}`, row.id);
    }
    const enrichmentByProgram = new Map<string, V1Enrichment>();
    {
      const best = new Map<string, { protocolId: string; cnt: number }>();
      for (const row of programBatchProtocols) {
        const cnt = Number(row.cnt);
        const current = best.get(row.feedingProgramId);
        if (!current || cnt > current.cnt) {
          best.set(row.feedingProgramId, { protocolId: row.protocolId, cnt });
        }
      }
      for (const [programId, { protocolId }] of best) {
        const v1 = v1ById.get(protocolId);
        if (v1) {
          enrichmentByProgram.set(programId, {
            temperatureRanges: v1.temperatureRanges,
            defaultSchedule: v1.defaultSchedule,
            minDissolvedOxygen: v1.minDissolvedOxygen,
            growthStageProtocols: v1.growthStageProtocols,
          });
        }
      }
    }

    const matchSpecies = (tenantId: string, name: string): SpeciesRef | undefined => {
      const lowered = name.trim().toLowerCase();
      return (speciesByTenant.get(tenantId) ?? []).find(
        (candidate) =>
          candidate.commonName?.toLowerCase() === lowered ||
          candidate.scientificName?.toLowerCase() === lowered ||
          candidate.localName?.toLowerCase() === lowered,
      );
    };

    const insertProtocol = async (
      tenantId: string,
      marker: string,
      converted: ConvertedProtocol,
    ): Promise<string | null> => {
      const existing = migratedMarkerToV2.get(`${tenantId}:${marker}`);
      if (existing) return existing; // idempotent tekrar koşum
      const names = takenNamesByTenant.get(tenantId) ?? new Set<string>();
      const name = resolveUniqueName(converted.name, names, marker);
      names.add(name.toLowerCase());
      takenNamesByTenant.set(tenantId, names);
      const rows: Array<{ id: string }> = await queryRunner.query(
        `INSERT INTO "feeding_protocols_v2"
           (id, "tenantId", name, description, "speciesId", "speciesName", status,
            bands, "temperatureAdjustments", "defaultMealSchedule", "fcrMatrix",
            settings, "isDefault", "migrationNote", version, "isDeleted")
         VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, $6::feeding_protocols_v2_status_enum,
                 $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, 1, false)
         RETURNING id`,
        [
          tenantId,
          name,
          converted.description ?? null,
          converted.speciesId ?? null,
          converted.speciesName ?? null,
          converted.status,
          JSON.stringify(converted.bands),
          converted.temperatureAdjustments
            ? JSON.stringify(converted.temperatureAdjustments)
            : null,
          JSON.stringify(converted.defaultMealSchedule),
          converted.fcrMatrix ? JSON.stringify(converted.fcrMatrix) : null,
          JSON.stringify(converted.settings),
          converted.isDefault,
          converted.migrationNote,
        ],
      );
      const insertedId = rows[0]?.id ?? null;
      if (insertedId) migratedMarkerToV2.set(`${tenantId}:${marker}`, insertedId);
      return insertedId;
    };

    // ── 1) v1 protokoller → v2 ───────────────────────────────────────────────
    const v1ToV2 = new Map<string, string>(); // v1 protocol id → v2 id
    for (const protocol of v1Protocols) {
      const marker = MIGRATED_V1_PROTOCOL_MARKER(protocol.id);
      const species = matchSpecies(protocol.tenantId, protocol.species ?? '');
      const converted = convertV1ProtocolToV2(protocol, {
        feedsById: feedsByTenant.get(protocol.tenantId) ?? new Map(),
        feedsByType: feedsByTypeByTenant.get(protocol.tenantId) ?? new Map(),
        species,
      });
      const v2Id = await insertProtocol(protocol.tenantId, marker, converted);
      if (v2Id) v1ToV2.set(protocol.id, v2Id);
    }

    // ── 2) programlar → v2 ───────────────────────────────────────────────────
    const programToV2 = new Map<string, string>();
    for (const program of programs) {
      const marker = MIGRATED_PROGRAM_MARKER(program.id);
      const converted = convertProgramToProtocolV2(program, {
        feedsById: feedsByTenant.get(program.tenantId) ?? new Map(),
        medianTempC: medianByTenant.get(program.tenantId) ?? null,
        enrichment: enrichmentByProgram.get(program.id),
      });
      if (!converted) continue;
      const v2Id = await insertProtocol(program.tenantId, marker, converted);
      if (v2Id) programToV2.set(program.id, v2Id);
    }

    // ── 3) atamalar (HEPSİ paused — K-3) ────────────────────────────────────
    const unitIds = [
      ...new Set([
        ...programTanks.map((tank) => tank.equipmentId),
        ...batchUnits.map((unit) => unit.unitId),
      ]),
    ];
    interface UnitInfo {
      name: string;
      code: string;
      siteId: string | null;
      category: string | null;
    }
    const unitInfo = new Map<string, UnitInfo>();
    if (unitIds.length > 0) {
      const rows: Array<{
        id: string;
        name: string;
        code: string;
        siteId: string | null;
        category: string | null;
      }> = await queryRunner.query(
        `SELECT e.id, e.name, e.code, d."siteId" AS "siteId", et.category AS category
         FROM "equipment" e
         LEFT JOIN "departments" d ON d.id = e."departmentId"
         LEFT JOIN "equipment_types" et ON et.id = e."equipmentTypeId"
         WHERE e.id = ANY($1)`,
        [unitIds],
      );
      for (const row of rows) {
        unitInfo.set(row.id, {
          name: row.name,
          code: row.code,
          siteId: row.siteId,
          category: row.category,
        });
      }
    }

    const categoryToUnitType = (category: string | null | undefined): 'tank' | 'pond' | 'cage' => {
      const lowered = (category ?? '').toLowerCase();
      return lowered === 'pond' || lowered === 'cage' ? lowered : 'tank';
    };

    const bandIndexForFeed = async (
      protocolV2Id: string,
      feedId: string | null,
    ): Promise<number | null> => {
      if (!feedId) return null;
      const rows: Array<{ idx: number }> = await queryRunner.query(
        `SELECT (band.ordinality - 1)::int AS idx
         FROM "feeding_protocols_v2" p,
              jsonb_array_elements(p.bands) WITH ORDINALITY AS band(value, ordinality)
         WHERE p.id = $1 AND band.value->>'feedId' = $2
         ORDER BY band.ordinality ASC
         LIMIT 1`,
        [protocolV2Id, feedId],
      );
      return rows[0]?.idx ?? null;
    };

    const insertAssignment = async (assignment: {
      tenantId: string;
      unitId: string;
      unitType: 'tank' | 'pond' | 'cage';
      unitName: string;
      unitCode: string;
      siteId: string;
      protocolId: string;
      currentFeedId: string | null;
    }): Promise<void> => {
      // Mevcut canlı (active/paused) atamayı EZME — operatör kurulumu veya
      // önceki koşum kazanır (idempotency + güvenli tekrar).
      await queryRunner.query(
        `INSERT INTO "feeding_protocol_assignments"
           (id, "tenantId", "unitId", "unitType", "unitName", "unitCode", "siteId",
            "protocolId", status, "effectiveFrom", overrides, suspensions,
            "currentFeedId", "currentBandIndex", "totalTransitions", "createdBy", version)
         SELECT uuid_generate_v4(), $1, $2, $3::feeding_protocol_assignments_unittype_enum,
                $4, $5, $6, $7, 'paused'::feeding_protocol_assignments_status_enum,
                CURRENT_DATE, '{}'::jsonb, '[]'::jsonb, $8, $9, 0, $10, 1
         WHERE NOT EXISTS (
           SELECT 1 FROM "feeding_protocol_assignments"
           WHERE "tenantId" = $1 AND "unitId" = $2 AND status IN ('active', 'paused')
         )`,
        [
          assignment.tenantId,
          assignment.unitId,
          assignment.unitType,
          assignment.unitName,
          assignment.unitCode,
          assignment.siteId,
          assignment.protocolId,
          assignment.currentFeedId,
          await bandIndexForFeed(assignment.protocolId, assignment.currentFeedId),
          MigrateFeedingProgramsToProtocolV21806300000000.ASSIGNMENT_SENTINEL,
        ],
      );
    };

    // 3a) Program tankları → atamalar (denorm ad/kod legacy satırdan hazır).
    for (const tank of programTanks) {
      const protocolV2Id = programToV2.get(tank.feedingProgramId);
      if (!protocolV2Id) continue;
      const info = unitInfo.get(tank.equipmentId);
      if (!info?.siteId) continue; // D-14: sitesiz ünite fail-closed atlanır; mutabakat scripti listeler
      await insertAssignment({
        tenantId: tank.tenantId,
        unitId: tank.equipmentId,
        unitType: tank.equipmentType,
        unitName: tank.equipmentName || info.name,
        unitCode: tank.equipmentCode || info.code,
        siteId: info.siteId,
        protocolId: protocolV2Id,
        currentFeedId: tank.currentFeedId,
      });
    }

    // 3b) Batch.protocolId → batch'in balıklı üniteleri (atamasızsa).
    for (const unit of batchUnits) {
      const protocolV2Id = v1ToV2.get(unit.protocolId);
      if (!protocolV2Id) continue;
      const info = unitInfo.get(unit.unitId);
      if (!info?.siteId) continue; // D-14
      await insertAssignment({
        tenantId: unit.tenantId,
        unitId: unit.unitId,
        unitType: categoryToUnitType(info.category),
        unitName: unit.unitName || info.name,
        unitCode: unit.unitCode || info.code,
        siteId: info.siteId,
        protocolId: protocolV2Id,
        currentFeedId: null,
      });
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Yalnız bu migration'ın yazdıkları geri alınır (işaretlerle seçilir);
    // operatörün elle kurduğu v2 kayıtlarına dokunulmaz.
    await queryRunner.query(`DELETE FROM "feeding_protocol_assignments" WHERE "createdBy" = $1`, [
      MigrateFeedingProgramsToProtocolV21806300000000.ASSIGNMENT_SENTINEL,
    ]);
    await queryRunner.query(
      `DELETE FROM "feeding_protocols_v2" WHERE "migrationNote" LIKE '[migrated:%'`,
    );
  }
}
