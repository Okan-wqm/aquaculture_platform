# Feeding v2 (PR #1002) — merge sonrası uçtan uca denetim bulguları

Kaynak: `7f1508da..219a7b2f` aralığının bağımsız denetimi (on yüzey denetçisi →
çürütücü elemesi → ağır bulgularda ikinci görüş → sentez), ardından üç keşif
turu (büyüme/cron/forecast/alert anatomisi, stok/ledger anatomisi, federasyon +
tenant provizyonu). Her bulgu birebir kod alıntısıyla doğrulandı.

Toplam: 2 CRITICAL + 5 HIGH + 12 MEDIUM + 5 LOW (denetim) + 11 ek + 5 test
kapısı + 5 kapsanmayan alan + 9 keşif bulgusu.

Uygulama programı: `BÖLÜM B — PR #1002 Sonrası Mimari Onarım Programı`
(dalgalar W0–W8). Kural: her seviyeden HER bulgu mimari olarak kapatılır;
kapatılamayan bulgu sahip + tarih ile CRITICAL/HIGH olarak burada kalır.

## Durum makinesi

`OPEN → IN-PROGRESS → RESOLVED` (merge edilen commit `Closes:` taşır).

## Mevcut (bu denetimden ÖNCE açılmış) örtüşen bulgular

`docs/reviews/farm-expert/2026-07-15-enterprise-closure-orphans.md` içindeki beş
bulgu bu programın kapsamındadır ve ayrı ID almaz — ilgili dalgada kapanır:

| ID                | Konu                                                                                        | Dalga                    |
| ----------------- | ------------------------------------------------------------------------------------------- | ------------------------ |
| FARM-CRITICAL-237 | Tükenmiş yem satırı "izlenmiyor" sayılıp düşümsüz yemleme commit'i                          | W2                       |
| FARM-CRITICAL-238 | `1806100000000` çift-mevcut yemlerde legacy bakiyeyi atlıyor, roll-up'ı provenanssız eziyor | W2                       |
| FARM-HIGH-239     | Sayım onayı + stok transferi kanonik mutasyon sink'ini atlıyor                              | W2                       |
| FARM-CRITICAL-240 | Lotsuz eşzamanlı teslimat çift projeksiyon + bayat roll-up üretebiliyor                     | W2                       |
| FARM-CRITICAL-241 | `1806600000000` rollback'i backfill satırlarını canlı drain satırlarından ayıramıyor        | **W0** (provenans ayağı) |

## Bu denetimin bulguları

| ID                | Sev      | Özet                                                                                                                                                                                                                                                                                                                      | Dalga                |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| FARM-CRITICAL-242 | CRITICAL | Site-kapsamlı FEFO join'i ham şartta tırnaklı camelCase kolon kullanıyor (`inv."storageLocationId"`, `loc."siteId"`); gerçek kolonlar `storage_location_id`/`site_id` → TypeORM çeviri yapmaz → `siteId` geçen HER yem düşümü `42703` ile patlar. Öğün motorunun TEK yolu bu; tüm testler mock repo kullandığı için yeşil | W0                   |
| FARM-HIGH-243     | HIGH     | `1806600000000` 800 günlük yem geçmişini tanktaki GÜNCEL batch'e yazıyor (`tank_batches.primaryBatchId` anlık snapshot) — turnover görmüş tankta FCR KPI'sı ve finans türetimi katlanıyor; `batchLocationId` hiç doldurulmuyor                                                                                            | W0                   |
| FARM-CRITICAL-244 | CRITICAL | DAILY rollup damgası tek atımlık: mod dropdown'u değişince 24 aya kadar plan tek koşuda yeniden rollup'lanıp büyümeyi ÇİFT sayıyor; ters yönde tam bir günlük büyüme kalıcı kayboluyor                                                                                                                                    | W1                   |
| FARM-CRITICAL-245 | CRITICAL | Yem düşümü tek lottan yapılıyor (FEFO kaskadı yok): 0.3 kg artık lot yüzünden 3000 kg stokta yemleme komple reddediliyor; mobil offline'da öğün kalıcı kayboluyor                                                                                                                                                         | W2                   |
| FARM-HIGH-246     | HIGH     | Aşırı beyan edilen kg biyokütleyi 0'a clamp'liyor → 500 canlı balıklı tank "boşalmış" sayılıp yemlemeden düşüyor ve alarm da üretmiyor                                                                                                                                                                                    | W4                   |
| FARM-HIGH-247     | HIGH     | Band geçişinden sonra `FeedingDayPlan.snapshot` hiç güncellenmiyor — operatör ESKİ yemi görürken ledger YENİ yemi düşüyor (yanlış pellet + iki yönlü stok bozulması)                                                                                                                                                      | W3                   |
| FARM-HIGH-248     | HIGH     | `updateFeedingRecord` miktarı değiştiriyor ama stok/plan/growth'a dokunmuyor + kilitsiz read-modify-write (lost update)                                                                                                                                                                                                   | W2                   |
| FARM-HIGH-249     | HIGH     | Forecast aynı fiziksel kg'ı hem site hem tenant kapsamında sayıyor → tedarik uyarı penceresi sistematik olarak eriyor (7 gün için tasarlanan uyarı 4.2 günde çalıyor)                                                                                                                                                     | W6                   |
| FARM-MEDIUM-250   | MEDIUM   | finalize yolunda recalc kayıttan ÖNCE koşuyor → `recalcLog` + `plannedTotalKg` lost update                                                                                                                                                                                                                                | W1                   |
| FARM-MEDIUM-251   | MEDIUM   | `transitionUnitFeed` band indeksini feedId'den seçiyor (aynı yem iki bandda → yanlış oran) ve kalan öğünleri yeniden fiyatlamıyor                                                                                                                                                                                         | W3                   |
| FARM-MEDIUM-252   | MEDIUM   | Gün içi band geçişinde `snapshot.expectedFcr` bayat kalıyor → büyüme eski FCR'la hesaplanıyor (~%55 sapma)                                                                                                                                                                                                                | W1+W3                |
| FARM-MEDIUM-253   | MEDIUM   | `applyStorageCorrection`: lot tükendiği için satır silinmişse stok iadesi sessizce atlanıyor                                                                                                                                                                                                                              | W2                   |
| FARM-MEDIUM-254   | MEDIUM   | Aşağı düzeltme her zaman ORİJİNAL lota iade ediyor → lot dağılımı bozuluyor, hayalet lot satırı expiry'siz doğuyor                                                                                                                                                                                                        | W2                   |
| FARM-MEDIUM-255   | MEDIUM   | Cron keşif/tespit sorguları ünite başına çok atamayı süzmüyor (sahte günlük CRITICAL) ve paused-only tenant'ı hiç görmüyor (sweep/rollup/özet hiç koşmuyor)                                                                                                                                                               | W0(a)+W5(b)          |
| FARM-MEDIUM-256   | MEDIUM   | 20:00 özeti yerel gün bitmeden koşuyor (sistematik sahte az-atım), `missedMealCount` yapısal olarak hep 0, iptal edilen plan `plannedTotalKg`'ı taşıyor                                                                                                                                                                   | W5                   |
| FARM-MEDIUM-257   | MEDIUM   | `feedingMethod` doğrulanmamış String olarak PG enum'ına cast ediliyor → 500 + tüm öğün kaydının rollback'i                                                                                                                                                                                                                | W8                   |
| FARM-MEDIUM-258   | MEDIUM   | Manuel yemleme `siteId` taşımıyor (yanlış depodan düşüm) ve plan bağlanamazsa büyüme HİÇ uygulanmıyor                                                                                                                                                                                                                     | W2                   |
| FARM-MEDIUM-259   | MEDIUM   | Stok tükeniş incident'i ilk açıldığı önemde donuyor — WARNING→CRITICAL eskalasyonu hiç tetiklenmiyor                                                                                                                                                                                                                      | W7                   |
| FARM-MEDIUM-260   | MEDIUM   | alert-engine tüketicisi hatayı yutuyor; tek-atımlık `MealMissed`/`MealUnderfed` sinyalleri DLQ'suz kayboluyor (event-bus sözleşmesi ihlali)                                                                                                                                                                               | W7                   |
| FARM-MEDIUM-261   | MEDIUM   | `1806500000000` aktivasyonu ve resume yolu partial unique index'i ihlal edebiliyor (fan-out durur / ham 500)                                                                                                                                                                                                              | W0                   |
| FARM-LOW-262      | LOW      | `autoTransition=false` plan üretiminde tamamen yok sayılıyor — manuel yem seçimi ertesi sabah sessizce eziliyor                                                                                                                                                                                                           | W3                   |
| FARM-LOW-263      | LOW      | Band tabanı üç yerde "dominant-biomass" diye belgeleniyor ama kod tank ortalaması kullanıyor (karar: tank ortalaması doğru, metinler yanlış)                                                                                                                                                                              | W3                   |
| FARM-LOW-264      | LOW      | Üretim/rollup/özet tek global cron saatine bağlı (`Europe/Istanbul`) — `planDate` site diliminde, sorgular UTC gününde                                                                                                                                                                                                    | W5                   |
| FARM-LOW-265      | LOW      | `ForecastPerUnit.currentFeedId` ünitenin bugünkü yemi değil, 120 günlük simülasyonun SON yemi                                                                                                                                                                                                                             | W6                   |
| FARM-LOW-266      | LOW      | Forecast snapshot satırları hiç budanmıyor (fosil kapsam canlı veriye tercih ediliyor) + alert dilimleme birimi karışık                                                                                                                                                                                                   | W6                   |
| FARM-MEDIUM-267   | MEDIUM   | `approve-inventory-count` roll-up'ı atlıyor (FARM-HIGH-239 ile aynı kök)                                                                                                                                                                                                                                                  | W2                   |
| FARM-LOW-268      | LOW      | `correctMealPour` düzeltmeyi GÜNCEL fiyatla tüm döküme uyguluyor → maliyet şişiyor                                                                                                                                                                                                                                        | W2                   |
| FARM-MEDIUM-269   | MEDIUM   | PARTIALLY_FED öğün mobilden kapatılamıyor; tek çıkış uydurma ≥0.001 kg döküm                                                                                                                                                                                                                                              | W8                   |
| FARM-LOW-270      | LOW      | Oruç/ilaç penceresi `toISOString()` ile UTC gününe kesiliyor                                                                                                                                                                                                                                                              | W5                   |
| FARM-MEDIUM-271   | MEDIUM   | `MealWindowUpcoming`'in hiçbir tüketicisi yok; `windowNotifiedAt` aynı tx'te yandığı için geçmiş yeniden üretilemez                                                                                                                                                                                                       | W7                   |
| FARM-LOW-272      | LOW      | `mortalityAssumption` tek global bayrak — uygulanmamış kapsama da `applied:true` damgası basıyor                                                                                                                                                                                                                          | W6                   |
| FARM-MEDIUM-273   | MEDIUM   | Toplu su kalitesi girişi P-31 sıcaklık recalc'ını tetiklemiyor (aynı veri tek tek girilse tetiklerdi)                                                                                                                                                                                                                     | W5                   |
| FARM-MEDIUM-274   | MEDIUM   | `effectiveUnitTemperatures` query'si site filtresi taşımıyor — atanmamış sitenin ünite sıcaklıkları okunabiliyor                                                                                                                                                                                                          | W8                   |
| FARM-MEDIUM-275   | MEDIUM   | `transfer-batch` iki ünitenin DayPlan kilidini payload sırasıyla alıyor → yeni AB-BA penceresi                                                                                                                                                                                                                            | W4                   |
| FARM-MEDIUM-276   | MEDIUM   | 05:30 süpürmesi kanonik kilit sırasını ihlal ediyor (daily modda yapısal)                                                                                                                                                                                                                                                 | W1                   |
| FARM-LOW-277      | LOW      | `RemovalQuantityPolicyService`'in üç-mod sözleşmesi koda ulaşmıyor: mod (c) DTO kısıtı yüzünden erişilemez, `countDerived` hiç okunmuyor                                                                                                                                                                                  | W4                   |
| FARM-LOW-278      | LOW      | `MealExecutionService` spec'i SEC-HIGH-051 reddetme yolunu hiç çalıştırmıyor; `recordMealFeeding` kilit sırası pinlenmemiş                                                                                                                                                                                                | W4                   |
| FARM-LOW-279      | LOW      | P-30 ham-SQL kapısı INSERT kolon listelerini ve QueryBuilder ham şartlarını hiç görmüyordu (FARM-CRITICAL-242 bu boşluktan geçti)                                                                                                                                                                                         | W0                   |
| FARM-LOW-280      | LOW      | Cutover kapısı yalnız ilk 250 karakterde string arıyor, erken-return semantiğini doğrulamıyor                                                                                                                                                                                                                             | W8                   |
| FARM-LOW-281      | LOW      | Aquamobil çevrimdışı plan cache'i `useDailyOpsStats` query-key çakışması yüzünden hiç yazılmıyor                                                                                                                                                                                                                          | W8                   |
| FARM-LOW-282      | LOW      | Günlük özet in-app satırı makbuzsuz yazılıyor — yeniden teslimde kopya                                                                                                                                                                                                                                                    | W7                   |
| FARM-LOW-283      | LOW      | Federasyon tazeliği açık sorusu: prod runtime composition kullanıyor, artefakt gerekmiyor — kapıya bağlandı                                                                                                                                                                                                               | W0                   |
| FARM-MEDIUM-284   | MEDIUM   | Cutover sonrası yeni tenant'a v2 protokol/atama tohumlanmıyor → tenant sessizce yemlemesiz açılıyor, D-5 süpürmesi de görmüyor                                                                                                                                                                                            | W8                   |
| FARM-LOW-285      | LOW      | `weeklyFeedForecast` cron'u legacy kapısının dışında kalmış; emit ettiği olayın dinleyicisi yok                                                                                                                                                                                                                           | W8                   |
| FARM-MEDIUM-286   | MEDIUM   | `recalcLog` jsonb dizisi üst sınırsız büyüyor ve GraphQL'de tamamen açık                                                                                                                                                                                                                                                  | W8                   |
| FARM-LOW-287      | LOW      | 12 yeni subject için JetStream retention/consumer ölçeği ölçülmedi                                                                                                                                                                                                                                                        | W7                   |
| FARM-MEDIUM-288   | MEDIUM   | `lockUnitForGrowth` `ConflictException` fırlatıyor ama hiçbir çağıran retry etmiyor → operatöre 409                                                                                                                                                                                                                       | W1                   |
| FARM-MEDIUM-289   | MEDIUM   | Rollup kilit `null` dönse de damgayı basıyor (sessiz büyüme kaybı); `planned/skipped/cancelled` planlar hiç damgalanmayıp partial indekste birikiyor                                                                                                                                                                      | W1                   |
| FARM-MEDIUM-290   | MEDIUM   | 05:30 süpürmesi tenant'ın TÜM açık öğünlerini limitsiz/kilitsiz belleğe alıyor, cutoff JS'te uygulanıyor                                                                                                                                                                                                                  | W5                   |
| FARM-LOW-291      | LOW      | 18:00 FCR süpürmesi eşiği aşan batch başına 2 ek sorgu atıyor (N+1)                                                                                                                                                                                                                                                       | W5                   |
| FARM-MEDIUM-292   | MEDIUM   | Feeding ham SQL'lerinde `tenantId` predikatı eksik (3 UPDATE + join'ler + forecast yükleyicileri)                                                                                                                                                                                                                         | W0 (kapı) + dalgalar |
| FARM-MEDIUM-293   | MEDIUM   | `loadFeedStock` silinmiş lokasyonların stoğunu sayıyor (`is_deleted` filtresi yok, `tenantId` parametresi yok)                                                                                                                                                                                                            | W6                   |
| FARM-MEDIUM-294   | MEDIUM   | Sensör sıcaklığı gün-içi recalc zincirine hiç bağlı değil — plan 06:00 değerinde çakılı kalıyor                                                                                                                                                                                                                           | W5                   |
| FARM-LOW-295      | LOW      | `round3` dört dosyada kopya (paylaşılan util yok)                                                                                                                                                                                                                                                                         | W1                   |
| FARM-LOW-296      | LOW      | `feeding_forecast_snapshots` retention purge'ünde yok — tenant/site silinince satır öksüz kalıyor                                                                                                                                                                                                                         | W6                   |
| FARM-MEDIUM-297   | MEDIUM   | v1 yemleme cron sınıfı hiçbir modülde provider DEĞİLDİ — `@Cron`'ları asla ateşlenemezdi; belgelenen `FEEDING_LEGACY_ENGINE_ENABLED=true` rollback'i onu geri getiremezdi ve drain-window rollup/cleanup işleri fiilen sahipsizdi                                                                                          | Faz 8 ölü-kod         |
| FARM-LOW-298      | LOW      | v1 `feedConsumptionForecast` yolu tüketicisiz yaşıyordu; K-6'nın erteleme gerekçesi ("scheduler hâlâ derliyor") dolmuştu — scheduler kendi özel `generateFeedForecast`'ini çağırıyor                                                                                                                                       | Faz 8 ölü-kod         |
| FARM-MEDIUM-299   | MEDIUM   | `apps/farm-service/schema.graphql` bayat SDL snapshot'ı: PR #942'den beri yenilenmiyor, v2 feeding yüzeyinin TAMAMINI kaçırıyor, hiçbir drift kapısı karşılaştırmıyor ama CI pagination validator'ı onu okuyor — **bu commit'te bilerek düzeltilmedi** (aşağıya bkz.)                                                       | AÇIK                  |

### Ölü test lane'i ve tip-kontrol zinciri (FARM-HIGH-300 … FARM-MEDIUM-304)

Faz 8 süpürmesinin devamında, "kapı olduğu sanılan ama hiç koşmayan" sınıfı
kovalarken bulundu. Hepsi sessizce YEŞİL olan kusurlar — bu yüzden hiçbiri
mevcut hiçbir kapıya takılmıyordu.

| ID | Özet |
| --- | --- |
| **FARM-HIGH-300** | `applyStockCorrection` ham SQL'i hareket tipini `'OUT'` literaliyle arıyor; kolon `varchar(20)` ve içinde `'out'` duruyor → sorgu her zaman sıfır satır, fonksiyon erken çıkıyor, öğün düzeltmesinin stok ayağı **iki yönde de** sessizce atlanıyor. W2'nin FARM-HIGH-248 için gönderdiği yol doğuşta ölüymüş. Enum parametre olarak bağlandı; regresyon testi hatalı kodda 4/5 kırmızı. |
| **FARM-MEDIUM-301** | `farm-service:test:integration` hiçbir workflow/script tarafından çağrılmıyor → 13 süit hiç koşmamış ve çürümüş (derlenmeyen spec, `42703` taşıyan tenant predikatı, W4'te kaldırılan davranışı doğrulayan assert, ulaşılamaz `manager.save` beklentisi). Onarıldı + CI'ya bağlandı. |
| **FARM-MEDIUM-302** | Tip-kontrol zinciri bayat dosyayı göremiyor: `nx affected -t type-check` **hiçbir projeyle eşleşmiyor** (sessiz no-op), `type-check-changed-files` yalnız değişen dosyaları derliyor, doğru kapı `gates:type-check-spec` ise haftalık `ci-full`'da. PR'a taşındı (29 proje / 165 sn) ve `tests/` kökü eklendi. |
| **FARM-MEDIUM-303** | `e2e/tests/integration/schema-invariants.spec.ts` hiçbir `run:` adımında yok — yalnız `paths:` tetik filtresinde. Kök CLAUDE.md onu "her PR'da koşar" diye ilan ediyordu; belge gerçeğe çekildi, spec'in koşturulması ayrı iş. |
| **FARM-MEDIUM-304** | AquaMobil'in ~380 vitest testi CI'da hiç koşmuyor. Bu turda yalnız SW build-artifact invariantı (FE-CRITICAL-050-SW) gerçek bir `test:invariant` hedefi hâline getirildi — o adım daha önce hiçbir projenin tanımlamadığı bir hedefi sürdüğü için kalıcı sessiz-yeşildi. |

**FARM-CRITICAL-305 — lane bağlanır bağlanmaz CI'ın yakaladığı ilk şey.**
`Site.timezone` birleşim tipli (`string | null`) ama `@Column` açık `type:`
taşımıyordu. TypeScript birleşimler için `design:type`'ı `Object` olarak yayar;
açık tip yoksa TypeORM onu benimser ve **farm-service'in tüm entity metadata'sı**
kurulamaz — `DataTypeNotSupportedError: Data type "Object" in "Site.timezone"`.
Taze bir veritabanında migration zinciri hiç koşamıyordu:
`bootstrap-from-scratch` 70/70 kırmızı. `tsc`, lint ve 1747 birim testinin
hepsi yeşil geçiyordu, çünkü kusur yalnız gerçek bir DataSource kurulduğunda
görünür. W5'in `sites.timezone` nullable değişikliğinden geliyor. Mekanizma
yerelde çalıştırılarak doğrulandı (kolon `Object` constructor'ına çözülüyordu;
açık `type: 'varchar'` ile düzeldi) ve `tests/invariants/entity-column-type-inference.spec.ts`
ile pinlendi — repo genelinde tek ihlal buydu.

Yapısal kapanış: `tests/invariants/test-target-ci-reachability.spec.ts` her iki
yönü birden zorlar — tanımlı her `test*` hedefinin CI koşucusu olmalı, ve CI'ın
sürdüğü her test hedefi bir projede var olmalı. İki yön de aksi hâlde sessizce
yeşildir; `test:integration` (birinci yön) ve `test:invariant` (ikinci yön)
tam olarak bu iki delikten kaçmıştı.

### Faz 8 ölü-kod süpürmesi — silinen iki dosyanın kanıtı

Silme kuralı ("yüzde yüz kullanılmadığına emin ol") iki bağımsız kanıt ayağıyla
karşılandı; her ikisinin de yerine geçen CANLI yol var.

**1. v1 yemleme cron servisi (FARM-MEDIUM-297).** `SchedulerModule.providers`
= `[CronJobsService, FeedingSchedulerService]`; `FeedingModule` de onu hiç
sağlamıyordu; farm-service'in hiçbir modülünde adı geçmiyordu. Nest bir sınıfı
provider olarak görmezse `@Cron` dekoratörlerini hiç kaydetmez — yani dört iş de
(gated `generateDailyPlans`/`checkFeedTransitions`, ungated
`applyDailyGrowthRollup`/`cleanupOldExecutions`) ölü doğmuştu. Bu, K-5 rollback
anlatısını da düzeltir: kapı orada hiçbir şeyi kapatmıyordu, dolayısıyla rollback
yolu YALNIZ `feeding-scheduler.service.ts` üzerinden yaşar. Yerine geçen:
`FeedingCronV2Service` (canlı, `FeedingProtocolModule` provider'ı).

**2. v1 forecast servisi + `feedConsumptionForecast` op'u (FARM-LOW-298).** FE,
mobil ve e2e'de sıfır çağıran; FE hook'ları (`useFeedConsumptionForecast`,
`FEED_CONSUMPTION_FORECAST_QUERY`) zaten `feeding-v1-retired-symbols` kapısında
sıfıra pinliydi. K-6 bu servisin silinmesini "scheduler hâlâ derliyor" diye Faz 8'e
ertelemişti; `weeklyFeedForecast` gerçekte scheduler'ın KENDİ özel
`generateFeedForecast`'ini çağırıyor — bağımlılık yok. Yerine geçen:
`protocolFeedForecast` (Faz 7, snapshot destekli). **BREAKING CHANGE:** public bir
GraphQL sorgusu kalkıyor.

Silinemeyen ve NEDEN silinemediği: `FeedSelectorService`
(`equipment.resolver.ts` dataloader fallback'i + `GrowthSimulatorService`),
`FeedingProtocolRateService` (`feed-selection.dataloader` v1 fallback'i),
`BilinearInterpolationService`, `FeedingProgramService`,
`DailyFeedingExecutionService`, `feeding-scheduler.service.ts`,
`FeedingProtocolSeederService` — hepsinin ya canlı çağıranı var ya da G0–G4
kapılarıyla korunan R1 rollback yolunun parçası. **Plan metni düzeltmesi:**
§9.5'teki "`feed-selector.service.ts` silinir" satırı YANLIŞ — o servis
`growthSimulation` op'unun (Faz 8'den açıkça MUAF, C-15) zincirinde canlı.

**FARM-MEDIUM-299 neden bu commit'te kapatılmadı.** `apps/farm-service/schema.graphql`
elle düzenlenemez: build onu üretmiyor (build `dist/graphql/subgraphs/farm.graphql`
emit ediyor, o da app bootstrap'ında DB bağlantısıyla yazılıyor). Dosya zaten
Faz 3–8 ve W0–W8'in eklediği hiçbir op'u taşımıyor. Silinen op'u elle çıkarmak,
onlarca başka noktada yanlış olan bir dosyaya sahte doğruluk katardı. Kalıcı çözüm
iki seçenekten biri: dosyayı gerçek üretim yoluna bağlamak ya da silip
`scripts/validate-pagination-schema.js`'i composed supergraph'a yöneltmek —
sahibi + tarihi registry'de.
