-- ============================================================================
-- Feeding Protocol v2 taşıma MUTABAKAT RAPORU (Faz 4 → Faz 6 kapısı)
-- ============================================================================
-- Nasıl çalıştırılır: her şema pass'i için ayrı ayrı (kaynak `farm` + her
-- `tenant_<uuid>`), örn.:
--   psql "$DATABASE_URL" -v schema=tenant_xxxxxxxx -f feeding-protocol-v2-reconciliation.sql
--   (psql değişkeni yoksa: SET search_path TO tenant_xxxxxxxx; sonra dosyayı çalıştırın)
--
-- Rapor NE anlatır (plan §9.10–9.11 + P-30 uyarısı):
--  * Bu rapor "eski davranışla parite" DEĞİL "yeni davranış" incelemesidir —
--    v1 protokol-oran yolu üretimde hiç çalışmadı (P-30 doğrulanmış canlı bug);
--    örneklenen oranlar operatör onayı gerektirir.
--  * DRAFT protokoller plan üretmez; Faz 6 cutover kapısı hiçbir aktif atamanın
--    DRAFT protokole işaret etmemesini şart koşar (K-14).
--  * Migrate edilen TÜM atamalar 'paused' durumdadır (K-3) — Faz 6 aktive eder.
-- ============================================================================

-- 1) Taşınan protokoller — durum + kaynak + dönüşüm notları (operatör onay kuyruğu).
SELECT
  p."tenantId",
  p.name,
  p.status,
  CASE
    WHEN p."migrationNote" LIKE '[migrated:program:%' THEN 'feeding_program'
    WHEN p."migrationNote" LIKE '[migrated:protocol-v1:%' THEN 'feeding_protocol_v1'
    ELSE 'manual'
  END AS source,
  p."migrationNote"
FROM feeding_protocols_v2 p
WHERE p."migrationNote" LIKE '[migrated:%'
ORDER BY p."tenantId", p.status, p.name;

-- 2) DRAFT sayacı — Faz 6 kapısından önce sıfırlanması gereken onay kuyruğu.
SELECT p."tenantId", COUNT(*) AS draft_count
FROM feeding_protocols_v2 p
WHERE p."migrationNote" LIKE '[migrated:%' AND p.status = 'draft'
GROUP BY p."tenantId";

-- 3) Migration'ın yazdığı atamalar (K-3: hepsi paused olmalı).
SELECT a."tenantId", a.status, COUNT(*) AS assignment_count
FROM feeding_protocol_assignments a
WHERE a."createdBy" = '00000000-0000-4000-8000-0000000000f4'
GROUP BY a."tenantId", a.status;

-- 4) D-14: balıklı olup Equipment.id üzerinden ERİŞİLEMEYEN veya sitesi
--    çözülemeyen üniteler — bu ünitelere atama YAZILMADI (fail-closed).
--    Migration öncesi/sonrası operatöre listelenir; boş olması beklenir.
SELECT
  tb."tenantId",
  tb."tankId"        AS unit_id,
  tb."tankName"      AS unit_name,
  tb."totalQuantity" AS fish_count,
  CASE
    WHEN e.id IS NULL THEN 'equipment kaydı yok (pond ikiliği / P-13)'
    WHEN d."siteId" IS NULL THEN 'departman→site zinciri kopuk'
  END AS reason
FROM tank_batches tb
LEFT JOIN equipment e ON e.id = tb."tankId"
LEFT JOIN departments d ON d.id = e."departmentId"
WHERE tb."totalQuantity" > 0
  AND (e.id IS NULL OR d."siteId" IS NULL)
ORDER BY tb."tenantId", tb."tankName";

-- 5) Anomali: taşınabilir durumda olup v2 karşılığı OLUŞMAMIŞ programlar
--    (boş feedAssignments dışında boş olması beklenir).
SELECT fp."tenantId", fp.id, fp.name, fp.status
FROM feeding_programs fp
WHERE fp."isDeleted" = false
  AND fp.status IN ('draft', 'active', 'paused')
  AND NOT EXISTS (
    SELECT 1 FROM feeding_protocols_v2 p
    WHERE p."tenantId" = fp."tenantId"
      AND p."migrationNote" LIKE '[migrated:program:' || fp.id || ']%'
  );

-- 6) Anomali: aktif v1 protokolü olup v2 karşılığı OLUŞMAMIŞLAR (boş beklenir).
SELECT v1."tenantId", v1.id, v1.name
FROM feeding_protocols v1
WHERE v1."isActive" = true
  AND NOT EXISTS (
    SELECT 1 FROM feeding_protocols_v2 p
    WHERE p."tenantId" = v1."tenantId"
      AND p."migrationNote" LIKE '[migrated:protocol-v1:' || v1.id || ']%'
  );

-- 7) Balıklı ama etkin v2 ataması OLMAYAN üniteler (Faz 6 kapısında operatör
--    onayı ister — D-5 "sessiz aç kalma" tespitiyle aynı küme).
SELECT tb."tenantId", tb."tankId" AS unit_id, tb."tankName" AS unit_name,
       tb."totalQuantity" AS fish_count
FROM tank_batches tb
WHERE tb."totalQuantity" > 0
  AND NOT EXISTS (
    SELECT 1 FROM feeding_protocol_assignments a
    WHERE a."tenantId" = tb."tenantId"
      AND a."unitId" = tb."tankId"
      AND a.status IN ('active', 'paused')
  )
ORDER BY tb."tenantId", tb."tankName";
