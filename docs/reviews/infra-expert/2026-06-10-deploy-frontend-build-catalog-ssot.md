# Deploy frontend build — catalog SSOT review (2026-06-10)

Reviewer: infra-expert (Round-2 treni, Adım-0 production gözetimi sırasında main kırmızısı)
Scope: `.github/workflows/deploy-digitalocean.yml` build-frontend-artifacts, `scripts/service-catalog/generate-artifacts.ts`, `platform/libs/service-catalog/src/index.ts`, `.github/workflows/deploy-staging.yml`

## INFRA-HIGH-005 — Full deploy kırmızı: aquamobil npm-workspace prebuild listesine sızıyor

**Severity:** HIGH (main üzerinde production deploy zinciri bloke)

**Gözlem:** Wave-1 merge'i (`da5fee234`) sonrası main push → CI-Affected → deploy prepare,
`deployed/production` tag'ine karşı diff'te `.github/` + `libs/` dokunuşları görüp **full deploy**
moduna geçti → `AFFECTED_FRONTEND` = tüm frontend hedefleri (aquamobil dahil).
`CATALOG_NON_NX_FRONTEND_PROJECTS=["aquamobil"]` olduğundan build adımı
`npm run build --workspace="web/modules/aquamobil"` koştu → `npm error No workspaces found`
(aquamobil `web/apps/aquamobil`'de yaşar) → build-frontend-artifacts FAIL → shell imajı hiç
üretilmedi → verify-images `shell:da5fee… not found` FAIL. Run: 27299385069.

**Kök neden (iki katman):**
1. **Model eksiği:** "imaj kendi asset'ini Dockerfile içinde derler" kavramı katalogda YOKTU —
   yalnız workflow yorumunda yaşıyordu. Generator nonNx listesini ÇIKARMA ile türetiyordu
   (frontend hedefleri − NX projeleri) → aquamobil kazara npm-workspace şeridine düştü.
2. **Yol konvansiyonu:** build döngüsü workspace yolunu `web/modules/${mod}` diye
   kurguluyordu; yol doğrusu generator'da AYRICA hardcoded'dı (`frontendModulePath`).
   Aynı doğrunun üç kopyası (workflow yorumu + generator çıkarımı + yol konvansiyonu).

**Fix (bu PR):**
- `FrontendAssetStrategy` alanı katalog girdisine eklendi (`prebuilt-artifact` |
  `dockerfile-self-build`); aquamobil = `dockerfile-self-build`.
- `frontendPrebuildPlan()` view'ı: prebuild şeritlerinin TEK türetimi; self-build hedefler
  iki şeritten de yapısal olarak dışlanır. Generator'ın iki artifact'ı da bu view'ı tüketir
  (çifte türetim silindi).
- `modulePath` katalog girdisine taşındı; generator `frontendModulePath` artık katalogdan
  okur; workflow build döngüsü yolu `deploy.nonNxFrontendBuild`'den çözer —
  `web/modules/${mod}` konvansiyonu öldü.
- Spec pinleri: self-build hedefler hiçbir şeritte görünmez; her aktif frontend hedefi üç
  stratejiden tam birinde; her `modulePath` diskte gerçek `package.json`'a çözülür.

**Tier:** 1 — yanlış şerit ataması artık temsil edilemez (katalog alanı + view + spec pini);
yol kayması test zamanında yakalanır.

## INFRA-MEDIUM-002 — deploy-staging.yml frontend build listeleri katalogdan kopuk (OPEN)

**Severity:** MEDIUM · **Owner:** infra-expert · **Deadline:** Round-2 küme-7 (Deploy/CI) hükmüyle, en geç 2026-06-24

**Gözlem:** `deploy-staging.yml` "Build all frontend modules" adımı NX listesini
(`shell,dashboard,farm-module,admin-panel,tenant-admin`) ve npm-workspace listesini
(`sensor-module hr-module hydroponics-module`) HARDCODE'lar. Katalog ise bu 8 modülün
TAMAMINI NX projesi sayar (sensor/hr/hydroponics sonradan project.json kazandı). Staging
bugün yeşil çünkü npm-workspace build'i de çalışıyor; ama liste katalogdan türemediği için
her modül ekleme/taşıma staging'i sessizce eskitir — INFRA-HIGH-005 ile aynı kayma sınıfı.

**Önerilen fix:** Staging build adımı `frontendPrebuildPlan()` çıktılarından
(`CATALOG_NX_FRONTEND_PROJECTS` + `deploy.nonNxFrontendBuild`) beslenmeli; Round-2
küme-7 (Deploy/CI) port'unda ele alınacak — bu hotfix'in kapsamı bilinçli olarak main'i
kırmızıdan çıkarmakla sınırlı tutuldu, staging değişikliği kendi CI turunu ister.
