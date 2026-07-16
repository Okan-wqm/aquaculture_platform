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
