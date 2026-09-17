# Mimosa Derin Güvenlik Taraması — 4/4: Gürültü, Kapsam Boşlukları, Sonraki Adımlar

**Tarih:** 2026-08-27 · Kaynak tarama: `scan-2026-08-27T11-31-42.404Z-8c8fad3c69f8` (künye: dosya 1)

## Gürültü kümeleri ve dışlama gerekçeleri

424 bulgunun ~350'si düzeltme planı üretmeyen kümelerdedir. Dışlama
gerekçeleri tekrarlanabilirlik için kayda geçiyor — sonraki taramada exclude
listesine alınmalılar.

| Küme                                                          | Adet                    | Dışlama gerekçesi                                                                                                                                                                                       |
| ------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `web/modules/sensor-module/public/assets/process-editor-*.js` | 115                     | Derleme çıktısı; kaynak `*.tsx` zaten graph'ta. Ayrıca 2026-08-23 №25 (SEC-LOW-080) source-map sızması bu dizinde zaten kayıtlı.                                                                        |
| `web/apps/aquamobil/dev-dist/workbox-*.js`                    | 36                      | Google workbox'un vendored dev dağıtımı; birinci-parti kod değil.                                                                                                                                       |
| `tools/gates/**`                                              | 120                     | Repo'nun kendi kalite/güvenlik gate araçları. `finding-registry.ts` (73) güvenlik bulgu metinleri taşıdığı için desen eşleşmesi üretir — bir güvenlik aracının güvenlik kelime dağarcığı taranmış olur. |
| `aria-kernel/aria_kernel/**`                                  | 40                      | Repo içi Python kernel; NestJS çalışma zamanı attack surface'ının parçası değil. Ayrı bir triage konusudur (aşağıda).                                                                                   |
| `scripts/deploy                                               | ci/\*_`, `scripts/_.js` | ~35                                                                                                                                                                                                     | Operatör/CI bağlamı; bulgular komut enjeksiyonu deseni ama tehdit modeli içeriden-tehdit. Bilinçli erteleme değil, ayrı triage (aşağıda). |
| `loginsample/_ds`                                             | 1                       | Git'te **izlenmeyen** örnek dizin (`git status`'un `?? loginsample/` girdisi). Taramaya girmemesi için repo dışına alınmalı ya da silinmeli.                                                            |
| `infrastructure/simulators`                                   | 2                       | Simülatör kodu; üretim attack surface'i değil.                                                                                                                                                          |

## Denetlenmemişler (dürüstlük kaydı — plan triage girdisi)

Aşağıdakiler bu oturumda satır düzeyinde doğrulanmadı; "FP" ya da "aday"
diye sınıflanmadılar. Plan, bunları C1–C3'ten (dosya 2) sonra triage etmeli:

1. `web/shell/src/pages/SettingsPage.tsx` — 3 MEDIUM (XSS/taint ailesi).
2. `aqua-ctl/aqua-ctl.ts:229` sink'ine akan orta küme — FP-10 gerekçesi
   **muhtemelen** geçerli ama satır düzeyinde kanıtlanmadı.
3. `scripts/deploy/assert-service-signals.ts` (9), `check-service-health.ts` (6)
   ve diğer deploy/cı script bulguları — operatör bağlamı teyidi.
4. `tools/gates/` bulgularından deploy'i etkileyen gerçek olanlar (ör.
   `sens-enterprise-validation.ts` 5 bulgu) — araç zinciri bozulsa CI'ı
   atlatma riski ayrı değerlendirme ister.
5. `aria-kernel/cli.py` (33 bulgu) — Python tarafının kendi güvenlik triage'ı.
6. Bağımlılık advisory'leri: 6 paket / 35 eşleşme / 4 unknown, itemize değil
   (dosya 1). `npm audit --json` + lockfile dökümüyle doldurulacak;
   2026-08-23 №4/№5 (react-router-dom, dompurify) zaten registry'dedir.

## Kapsam boşlukları (Mimosa'nın beyanı + çıkarımlar)

- **Çağrı grafiği kısmi:** dinamik dispatch ve ölçek sınırları nedeniyle
  cross-file erişilebilirlik eksik olabilir (coverage.json `gaps`). Bu,
  dosya 2'deki adayların "doğrulanmış" değil "statik-okumayla desteklenmiş"
  olarak okunmasının nedenidir.
- **Validation fazı partial:** 6 business-logic hipotezinin tamamı
  `inconclusive`; tarayıcı global guard'ların bu girişlere etkisini
  çözemedi. Manuel doğrulama (dosya 2/3) bu boşluğu kapattı.
- **Statik kanıt sınırı:** çalışma zamanı yürütme yok; `verdictEffect: none`.
  Hiçbir bulgu "istismar edilebilir" diye damgalanmadı.

## Sonraki tarama için öneriler

1. Exclude listesi eklensin: `**/public/assets/**`, `**/dist/**`,
   `**/dev-dist/**`, `tools/gates/**` (ya en azından `finding-registry.ts`),
   `loginsample/**` → beklenen gürültü azaltımı ~250–300 bulgu.
2. `loginsample/` repo kökünden kaldırılsın (git içinde değil; yerel dizin).
3. Bağımlılık taraması `npm audit` ile itemize edilip registry'ye
   bağlansın (mevcut SEC-LOW-060/059 kayıtlarıyla birleştirilsin).
4. C1 (proxy SSRF) doğrulaması bittiğinde sonuç bu serinin 2. dosyasına
   geri yazılsın; registry ID ataması o noktada yapılsın.

## Plan girdisi özeti (dosya 2'ye bağlantı)

| Öncelik | Öğe                                                       | Dayanak                                                   |
| ------- | --------------------------------------------------------- | --------------------------------------------------------- |
| 1       | C1 — proxy SSRF yüzey doğrulaması                         | `finding:f8b809808991422dd4542664`                        |
| 2       | C2 — provisioning token zarfı (constant-time/fail-closed) | 4× `business:*`                                           |
| 3       | C3 — status ucu bilgi sızdırma kararı                     | `business:a4e1825eb1c8f9a705ea` + SEC-MEDIUM-070 kesişimi |
| 4       | Denetlenmemişler listesi (yukarıda 1–6)                   | Bu dosya                                                  |
