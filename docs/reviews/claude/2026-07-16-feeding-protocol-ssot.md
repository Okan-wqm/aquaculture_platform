# Feeding Protocol SSoT — bulgu kaydı (plan uygulama döngüsü)

Kaynak: protokol-tabanlı yemleme sistemi keşif + tasarım + 3-ajanlı bağımsız gözden
geçirme döngüsü (2026-07-16). Kayıtlı ID'ler `docs/reviews/_registry/findings.jsonl` zincirindedir; uygulama fazları bu ID'leri `Closes:` satırlarıyla kapatır. Henüz FARM-* ID'si atanmamış satırlar, ilgili faz commit'i atılırken registry'ye eklenir (plan ref'leri korunur). Plan dokümanındaki P/K/D/C kısaltmaları parantez içinde.

## Durum makinesi
`OPEN → IN-PROGRESS → RESOLVED` (merge edilen commit `Closes:` taşır).

## Bulgular

| ID | (Plan ref) | Özet | Durum |
|---|---|---|---|
| FARM-HIGH-215 | P-08 | `receive-delivery.handler.ts` storage yazımlarını `StockMovementService.recordMovement` dışında yapıyor: `Feed.quantity` roll-up'ı atlanıyor (PO ile gelen yem forecast'a görünmez), idempotency yok, outbox event yok | IN-PROGRESS |
| FARM-MEDIUM-216 | (uygulamada bulundu) | `requestIncidentMediaUpload` mutation'ı permission matrix'te sınıflandırılmamış — `permission-matrix.spec.ts` "every @Mutation is classified" invariantı kırmızı (branch başında da kırık) | IN-PROGRESS |
| CRITICAL-001 | P-30 | `daily-feeding-execution.service.ts:1358` ham SQL'i var olmayan `feeding_protocols."isDeleted"` kolonunu filtreliyor — v1 protokol-oran yolu her çağrıda exception (tank başına yutulur). Hotfix YAPILMAZ (davranış değişikliği); v2 Faz 3 doğrulama + Faz 8 silme | OPEN |
| CRITICAL-002 | D-1 | Çok-üniteli batch'te `updateTankBiomassWithManager` `Batch.weight.theoretical`'ı tek tankın değeriyle eziyor (son-yazan-kazanır) — Faz 5 BiomassGrowthApplier v2 + invariant test | OPEN |
| HIGH-002 | P-05 | Manuel FeedingRecord biomass güncellemez; execution yolu feeding_records yazmaz — FCR feed toplamı tutarsız. Faz 5 FeedingLedgerService (üç caller) + Faz 6 backfill | OPEN |
| FARM-HIGH-219 (motor birleşimi; eski satır HIGH-003) | P-01..P-04/K-5 | İki paralel günlük plan motoru (scheduler 05:00 + cron 06:00) + Faz 6'da yalnız birinin kapatılması riski — cutover TÜM legacy üretim/bildirimi kapatır | OPEN |
| FARM-HIGH-218 | P-07/P-09/P-10/P-15 | Üç stok mağazası, üç bağımsız giriş yazarı, iki farklı "days remaining" kaynağı, iki yem-stok UI'ı — tek ledger + tek UI | IN-PROGRESS |
| FARM-HIGH-217 | P-11/C-1/C-2 | Feed/stok alarm zinciri kopuk: eşik tespiti yalnız wrapper'da (feeding düşümleri LowStockDetected üretmiyor), alert-engine tüketicisi yok, in-process zincir ölü uçlu, websocket köprüsü yalnız FeedInventoryLow'a bağlı | IN-PROGRESS |
| HIGH-006 | D-2 | Karışık-batch tanklar: harman ortalamayla band seçimi + ikincil batch'lere büyüme atanmaması + mortality'nin batchDetails re-derivation'ının büyümeyi ezmesi | OPEN |
| HIGH-007 | D-3 | Removal giriş modları tutarsız (mortality/cull yalnız tane; harvest tane+kg zorunlu; kg-only hiçbir yerde) — RemovalQuantityPolicyService | OPEN |
| HIGH-008 | D-4 | Saat dilimi SSoT yok (cron Europe/Istanbul hardcode vs mobil UTC) — Site.timezone + timestamptz | OPEN |
| HIGH-009 | D-5/K-14 | Balıklı-plansız ünite sessiz aç kalıyor (özellikle DRAFT-migrate cutover'ı) — UnfedUnitDetected + kapı | OPEN |
| HIGH-010 | D-6 | Forecast interaktif değil (günlük snapshot) — event-driven yeniden hesap | OPEN |
| HIGH-011 | D-7 | Plan-dışı manuel yem büyüme/recalc/varyansa görünmez | OPEN |
| HIGH-012 | C-3 | Sıcaklık çözümlemesinde duplicate servis riski — mevcut WaterTemperatureService genişletilir; sensör bağlama mevcut equipment kolonunda | OPEN |
| HIGH-013 | C-4/C-5 | Emeklilik kör noktaları: batch traceability + equipment feed dataloader v1 yığınına bağlı | OPEN |
| MEDIUM-002 | P-24 | Mobil `feedingMethod` alanı sunucuda düşürülüyor | OPEN |
| MEDIUM-003 | P-23 | `RECORD_DAILY_FEEDING` mobil dokümanı iki yerde (biri ölü) | OPEN |
| MEDIUM-004 | P-25 | `calculations` GraphQL'de opak JSON — tipli şemaya | OPEN |
| MEDIUM-005 | C-11 | `updateFeedingRecord` düzeltmeleri stok/öğün/büyümeyle desync | OPEN |
| MEDIUM-006 | C-12/K-16 | Retention etkileşimleri (800g feeding_records, MV varyans kolonları, meal soft-ref) | OPEN |
| MEDIUM-007 | C-16 | Execution yolu feedCost yazmıyor — finans eksik sayıyor | OPEN |
| MEDIUM-008 | D-8..D-13, K-7..K-19, C-6..C-10, C-17/C-18 | Plan dokümanındaki kalan tasarım/uygulama bulguları (kısmi öğün, site scoping, protokol/atama gün-ortası değişimi, oruç/ilaç, temizlikçi balık, indeks/enum/formül düzeltmeleri, registry/matrix/tenant-admin/seeder dokunuşları) — ilgili fazlarında kapanır | OPEN |
| MEDIUM-009 | P-13/D-14 | Ünite kimlik parçalanması (Tank/Equipment/ponds) — Faz 8 sonrası ayrı iş; sahip: farm-platform | OPEN |
| MEDIUM-010 | P-17/P-28 | i18n borcu (web feeding sayfaları + aquamobil framework'süz) — dokunulan yüzeyler fazlarında, kalanı ayrı iş; sahip: FE | OPEN |
| LOW-001 | P-06/P-22 | Ölü kod + adlandırma çakışmaları — ilgili fazlarda temizlik | OPEN |

## Merge-öncesi uçtan uca audit bulguları (2026-07-17)

Faz 0–8 uygulaması tamamlandıktan sonra, merge öncesi bağımsız uçtan uca denetimin
(BE motor + plan-kapsama + FE/mobil, 3 paralel denetçi) bulguları. Kayıtlı ID'ler
registry zincirinde; onarım commit'leri `Closes:` ile kapatır.

| ID | (Plan ref) | Özet | Durum |
|---|---|---|---|
| FARM-HIGH-220 | K-1 | `skipMeal` kilitleri ters sırada alıyordu (Meal → DayPlan) — `recordMealFeeding`/`correctMealPour` kanonik DayPlan → Meal yönüyle AB-BA deadlock penceresi | IN-PROGRESS |
| FARM-HIGH-221 | §6/K-8b | alert-engine'de feeding-execution tüketicisi yok: `MealUnderfed`, `MealMissed`, `UnfedUnitDetected` incident üretmiyor; `FeedTypeTransitioned` info/audit kaydı yok — Faz 7 tablosundaki `feeding-execution.handler.ts` hiç yazılmadı | IN-PROGRESS |
| FARM-MEDIUM-222 | K-8c | 20:00 `FeedingDailySummaryEvent` outbox'a yazılıyor ama notification-service tüketicisi yok — günlük özet hiçbir kanala çıkmıyor | IN-PROGRESS |
| FARM-MEDIUM-223 | D-13 | Forecast yükleyicisi biomass'ı nullable `TankBatch.currentBiomassKg` aynasından okuyor (`Number(undefined)` = NaN riski) — motor/generator SSoT'si `totalBiomassKg` (temizlikçi hariç, D-13) ile tutarsız | IN-PROGRESS |
| FARM-MEDIUM-224 | D-4 | Forecast `startDate` UTC takvim günü (`toISOString().slice(0,10)`) — day-plan `planDate` site saat diliminde; gün-0 hizası sınır saatlerde bir gün kayabilir; kontrat belgesiz | IN-PROGRESS |
| FARM-MEDIUM-225 | §5 | `dailySurvivalRate` yükleyicide 1.0 hardcode — `Species.growthParameters.expectedSurvivalRate` hiç bağlanmadı; `mortalityAssumption` daima `none` (plan §5 gereksinimi: tanımlıysa günlük orana çevrilip uygulanır) | IN-PROGRESS |
| FARM-MEDIUM-226 | §6 | Stockout eşikleri iki yerde kod-ikizi: alert-engine `STOCKOUT_CRITICAL_DAYS=3` + warehouse-summary handler'da literal eşikler — tek sabit SSoT yok, sessiz sapma mümkün | IN-PROGRESS |
| FARM-MEDIUM-227 | D-8 | 05:30 sweep bayat `partially_fed` öğünleri finalize ederken `per_meal` modda büyüme UYGULAMIYOR (rollup dalı yalnız `daily` modu kapsıyor) — pencere kapanışıyla finalize olan öğünlerin büyümesi sessizce kayboluyor | IN-PROGRESS |
| FARM-LOW-228 | P-25 | `DayPlanAdminResult.outcome` GraphQL'de düz String (`'recalculated'\|'generated'\|'transitioned'`) — kayıtlı enum değil; geçersiz değer telde yapısal olarak engellenmiyor | IN-PROGRESS |
| FARM-MEDIUM-229 | §1.2 | Plandaki `assignProtocolToBatchUnits(batchId, protocolId)` kolaylık mutation'ı hiç yazılmadı (batch'in güncel ünitelerine toplu atama) | IN-PROGRESS |
| FARM-MEDIUM-230 | P-30 | P-30 kararındaki "her ham-SQL kolonu entity-destekli olmalı" test kuralı v2'ye eklenmedi — feeding-protocol servislerindeki ham SQL kolonları entity tanımlarına karşı doğrulanmıyor | IN-PROGRESS |
| FARM-MEDIUM-231 | D-2 | Karışık-tank UI eksik: day-plan snapshot'ı mixed-batch/CV bilgisi taşımıyor, MealBoard'da rozet + yüksek-CV uyarısı yok (band politikası dominant-biomass ile hesaplanıyor ama operatöre görünmüyor) | IN-PROGRESS |
| FARM-MEDIUM-232 | §8 | `useProtocolFeedForecast` `enabled` guard'sız: siteler yüklenmeden `siteId=undefined` ile sorgu atılıyor (MODULE_USER'da Forbidden; gereksiz çift istek) | IN-PROGRESS |
| FARM-MEDIUM-233 | §8 | KPI başlığı + ForecastTab hata durumunda sessiz 0/boş gösteriyor — hata dürüstlüğü yok (error state ayırt edilmiyor) | IN-PROGRESS |
| FARM-LOW-234 | §8 | `FeedingFilters` FeedingPage'de render ediliyor ama yeni sekmeler (meal board/forecast/records) filtreleri tüketmiyor — ölü UI | IN-PROGRESS |
| FARM-LOW-235 | P-29 | `stableStringify` üç kopya: `command-envelope.ts` kopyası `undefined`-filtreli, FARM-LOW-141 ile pinlenen `useBatches`/aquamobil çifti filtresiz — modül içi kopya tekilleştirilmeli, sapma kapanmalı | IN-PROGRESS |
| FARM-LOW-236 | §8 | `useWarehouseSummary` query key'inde `tenantId` iki kez (`createTenantQueryKey(tenantId, 'warehouseSummary', tenantId)`) — anahtar hijyeni | IN-PROGRESS |

Not: KPI başlığındaki sabit İngilizce metinler (audit C6) yeni ID almaz — MEDIUM-010
(P-17 i18n borcu) kapsamında izlenir.
