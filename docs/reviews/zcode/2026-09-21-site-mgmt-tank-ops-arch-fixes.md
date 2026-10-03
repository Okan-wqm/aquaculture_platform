# 2026-09-21 Site Management + Tank Ops — Mimari Düzeltme Denetimi

Tenant admin panelinde (app.suderra.com/sites/\*) 12 sekmeli Site Management
modülü ve tank operasyonları (/sites/tanks) uçtan uca denetlendi; bulunan
bulgular mimari (SSoT) düzeltmelerle kapatıldı. Aşağıdaki bulgular bu
dokümanda kayıtlıdır.

**Kimlik geçmişi (2026-10-03, main'e iniş):** PR #1670 bu dokümanda
301–306, registry satırlarında ise FARM-HIGH-324..327, FARM-MEDIUM-329,
FE-HIGH-307 kullanmıştı. FARM 324–329 dizileri main'de o arada başka
bulgulara ayrıldığı için (dizi = kimlik), bulgular main'e allocator
(`npm run findings:add`) üzerinden yeniden kaydedildi:

| #1670 doküman   | #1670 registry  | main            |
| --------------- | --------------- | --------------- |
| FARM-HIGH-301   | FARM-HIGH-324   | FARM-HIGH-356   |
| FARM-HIGH-302   | FARM-HIGH-325   | FARM-HIGH-357   |
| FARM-HIGH-303   | FARM-HIGH-326   | FARM-HIGH-358   |
| FARM-HIGH-304   | FARM-HIGH-327   | FARM-HIGH-359   |
| FARM-MEDIUM-305 | FARM-MEDIUM-329 | FARM-MEDIUM-360 |
| FE-HIGH-306     | FE-HIGH-307     | FE-HIGH-309     |

Düzeltmeler main'e tek commit olarak indi; #1670'in yedi commit'i
(c53d16b4a … 22b95ad91) o commit'in gövdesinde listelenir.

## FARM-HIGH-356 — createDepartment DB'de RI (FK) kontrolü sahibi rol üzerinden reddediliyordu

- **Kanıt:** farm-service logu `permission denied for schema tenant_...` —
  `INSERT INTO departments` FK kontrolü `SELECT ... FROM ONLY sites FOR KEY SHARE`
  adımında tablo SAHİBİ (`farm_schema_owner`) olarak koşar; owner rollerin
  tenant şemasında USAGE yetkisi yoktu (nspacl kanıtı).
- **Düzeltme:** `tenant-schema-privileges.ts` — `assertTenantSchemaPrivileges`
  artık owner role'e de USAGE veriyor; verify aynı ekseni denetliyor.

## FARM-HIGH-357 — notification-subgraph kullanıcı bağlamı hiç kurulmuyordu (zombi oturum kökü)

- **Kanıt:** unreadNotificationCount her çağrıda UNAUTHENTICATED —
  `TenantGuard: No verified user reached the tenant guard`; x-verified-user-assertion
  işlenmiyordu.
- **Düzeltme:** notification-service app.module'üne VerifiedUserAssertionMiddleware eklendi.

## FARM-HIGH-358 — TypeORM date kolonları GraphQL DateTime scalar'ında null serileşiyordu

- **Kanıt:** `Expected DateTime.serialize("2026-09-21") to return non-nullable value` —
  batches/harvestPlans sorguları komple çöküyordu.
- **Düzeltme (SSoT):** `installDateOnlyDateTimeScalar()` gerçek
  GraphQLISODateTime singleton'unu sarmalar; 26-entity
  `@Field(() => String)` dağınık yaması geri alındı.

## FARM-HIGH-359 — Hasat planı tamamlanması stoğu hiç düşürmüyordu

- **Kanıt:** completeHarvestPlan sonrası batches.currentQuantity ve tank
  stoğu değişmedi (canlı ölçüm).
- **Düzeltme:** completeHarvest artık CreateHarvestRecordCommand'ı
  TankBatch.batchDetails konumlarında orantılı tetikler; plan COMPLETED
  işaretlenmeden önce. Canlıda doğrulandı: batch 767→467, tanklar −300/−14,95 kg.

## FARM-MEDIUM-360 — updateBatchStatus reason argümanı updatedBy uuid kolonuna kayıyordu

- **Kanıt:** `invalid input syntax for type uuid: "<reason metni>"`.
- **Düzeltme:** resolver arg sırası komut sözleşmesiyle hizalandı.

## FE-HIGH-309 — enum DEĞER/AD uyuşmazlığı sınıfı (chemicals/mortality/cull/harvest)

- **Kanıt:** `Value "disinfectant" does not exist in "ChemicalType" enum` vb.
- **Düzeltme (SSoT):** `utils/graphql-enum.ts` tek köprü; dağınık
  toUpperCase/toLowerCase yamaları buna bağlandı.
