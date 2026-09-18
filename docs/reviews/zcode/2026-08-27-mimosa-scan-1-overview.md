# Mimosa Derin Güvenlik Taraması — 1/4: Genel Bakış ve Tarama Künyesi

**Tarih:** 2026-08-27 · **Taranan hedef:** `/var/aqua-saas` @ `feat/100-tenant-readiness-v3` · **Ajan:** zcode

Bu dosya serisi, 2026-08-27 Mimosa derin güvenlik taramasının bulgularını ve her
bulgunun **manuel kaynak-kod doğrulamasını (gerekçeleriyle)** kaydeder. Seri plan
aşamasına girdi olarak hazırlanmıştır; kod değişikliği içermez.

| Dosya                                             | İçerik                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------- |
| `2026-08-27-mimosa-scan-1-overview.md`            | Tarama künyesi, seal, kapsam, bulgu dağılımı, bağımlılık riski (bu dosya) |
| `2026-08-27-mimosa-scan-2-candidates.md`          | Doğrulamadan geçen / plana taşınacak aday bulgular (gerekçeli)            |
| `2026-08-27-mimosa-scan-3-false-positives.md`     | Çürütülen bulgular: yanlış pozitif sınıfları ve kanıtleri                 |
| `2026-08-27-mimosa-scan-4-noise-coverage-next.md` | Gürültü kümeleri, kapsanmayan alanlar, sonraki adım önerileri             |

## Tarama künyesi

| Alan         | Değer                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| Araç         | Mimosa güvenlik taraması (MCP), `depth: deep`                                                           |
| Scan ID      | `scan-2026-08-27T11-31-42.404Z-8c8fad3c69f8`                                                            |
| Job ID       | `scan-job-mtbf0nw9-1b9128a11aee6f96` (attempt 1, ~27 dk)                                                |
| Seal         | `sha256:a014ec013673c0664c33d2f3876fc47340b46fc1c5cafeb387bc305ee85f5e04`                               |
| Artifacts    | `~/.mimosa/security-scans/project-89c0c3a75aa714afb763af12/scan-2026-08-27T11-31-42.404Z-8c8fad3c69f8/` |
| Kanıt sınırı | `static_only_no_runtime_execution` — yalnızca statik analiz; çalışma zamanı kanıtı yok                  |
| Run status   | `inconclusive` (validation fazı `partial`; çağrı grafiği dinamik dispatch nedeniyle eksik)              |

**Seal doğrulaması:** `scan-manifest.json`, `findings.json`, `coverage.json`
hash'leri `seal.json` değerleriyle yeniden hesaplanıp birebir doğrulandı
(`81761f0d…`, `fbc324a4…`, `f6675439…`). Artifacts değişmemiştir.

**İlgili önceki çalışma:** `docs/reviews/security/2026-08-23-vuln-scan-findings.md`
(№1–№75, registry ID'li). Bu tarama bağımsız bir ikinci geçiştir; kesişimler
aday dosyasında not edilir. Bu seride **yeni registry ID atanmamıştır** —
registry'ye kayıt, düzeltme planı kararları alındıktan sonra
`finding-registry add` ile yapılacaktır.

## Kapsam

- 13.184 dosya limitinden 8.454 dosya seçildi ve tamamı parse edildi (0 okuma/parse hatası, kesme yok).
- Path analizi: 62.898 fonksiyon, 70.220 çağrı kenarı, 11 iz.
- Threat model: 39 giriş noktası, 11 yetkilendirme yüzeyi.
- Doğrulama fazı: 6 business-logic hipotezi incelendi (205 sorgu); tamamı `inconclusive` — kanıt yetersizliği tarayıcının beyanıdır, bulgunun çürüğü değildir; bu yüzden hepsi manuel olarak kaynak kodda doğrulandı (dosya 2 ve 3).

## Bulgu dağılımı

**Toplam 424 bulgu: 170 HIGH · 250 MEDIUM · 4 LOW** (5'i business-logic adayı).

| Küme                                                                                       | Adet   | Nitelik                                                                           |
| ------------------------------------------------------------------------------------------ | ------ | --------------------------------------------------------------------------------- |
| `web/modules/sensor-module/public/assets/*.js`                                             | 115    | Build çıktısı (minify edilmiş bundle) — gürültü                                   |
| `web/apps/aquamobil/dev-dist/workbox-*.js`                                                 | 36     | Vendored workbox dev dağıtımı — gürültü                                           |
| `tools/gates/*`                                                                            | 120    | Repo'nun kendi CI gate araçları (`finding-registry.ts` tek başına 73) — araç kodu |
| `aria-kernel/aria_kernel/*`                                                                | 40     | Python kernel (repo içi ama çalışma zamanı servisi değil)                         |
| `scripts/*`                                                                                | ~35    | Operatör/CI script'leri (deploy, ci, seed)                                        |
| **Birinci-parti çalışma zamanı kodu** (`apps/`, `libs/`, `platform/`, `sens-api-gateway/`) | **40** | **19 HIGH + 21 MEDIUM** — doğrulamanın odağı                                      |
| Diğer (`loginsample/_ds`, `tools/*`, `infrastructure/simulators`)                          | ~38    | Karma                                                                             |

Birinci-parti 40 bulgunun **manuel adjudikasyonu dosya 3'teki tabloda**dır:
19 HIGH'ın 15'i çürütüldü, 1'i plan adayı (SSRF), 3'ü " mitigasyonlu ama
doğrulama gerektirir" adayı (provisioning uçları). ~200 MEDIUM "cross-file taint"
bulgusu tek ortak sink'e (`libs/backend-common/src/audit/audit-log.service.ts`)
akıyor; sink parametreli ORM çıktığından toplu refütasyon dosya 3'te gerekçelendi.

## Bağımlılık riski

2.863 paket tarandı; çevrimdışı advisory veritabanı **6 pakette 35 advisory**
eşleştirdi (4 paket "unknown"). Mimosa artifacts'i paket bazında itemize
etmiyor (`packages: []`) — bu boşluk dosya 4'teki takip maddelerinden biridir
(`npm audit` + lockfile taraması ile doldurulacak).

## Sonuç disiplini

Bu rapor "proje güvenli/güvensiz" sonucu **vermez**; run status `inconclusive`
ve kanıt sınırı statiktir. Serinin çıktısı, dosya 2'deki doğrulanmış adayların
planlanması ve dosya 3–4'teki refütasyon/gürültü kararlarının sonraki taramalarda
tekrarlanabilir şekilde uygulanmasıdır.
