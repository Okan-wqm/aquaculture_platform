# Küme-10: per-proje typed-lint altyapısı portu (2026-06-11)

## INFRA-MEDIUM-006 — Platformda per-proje tip-bilinçli lint scaffolding'i ve closure araç seti yok (K10 parkı)

**Severity:** MEDIUM · **Owner:** infra-expert · **Cycle:** 2026-06-10-round2

### Gözlem

Projeler kök `.eslintrc.json`'ın tip-bilgisiz kurallarıyla lint'leniyor;
`strict` + `recommended-requiring-type-checking` hiçbir projede etkin değil.
K10 (rescue/lint-infra-prettier-20260610 commit A, c4ddaf00d) bu altyapıyı
park etmişti: 31 proje için `.eslintrc.cjs` + `tsconfig.eslint.json`
scaffold'ları, `tools/quality/quality.mjs` closure koşucusu (format kapsamı /
lint hedef envanteri / rust toolchain manifesti / kapanış manifesti) ve
`tools/gates/enterprise-closure.ts` kapanış kapısı.

### Port kararları (pick-tablosu özeti — tam liste PR gövdesinde)

- **75/82 dosya clean-pick** (main'de hiçbirinin çakışan sahibi yok).
- **HARİÇ (ARIA şeridi, operatör kararı):** aria-kernel burn_in.py
  (main'in bağımsız evrimiyle çakıştı — main hali korundu),
  proof_authority.py, test_enterprise_ssot_closure.py, 2 docs/aria şeması.
- **HARİÇ (ayrı değerlendirme, hüküm tablosu):** apollo5-driver.ts +
  graphql/index.ts (salt re-export) — Apollo v4 EOL geçişi ayrı karar.
- **Reimplement-adaptasyon (1 dosya):** quality.mjs
  EXPECTED_CLOSURE_ENTRYPOINTS — main'in `gates:all`'u zincirli npm gate
  koşucusunun SAHİBİ; port o adı kavga etmez, closure koşucusu
  `quality:closure-run` adını alır. package.json'a yalnız iki YENİ script
  eklendi (`gates:enterprise-closure`, `quality:closure-run`) — park,
  package.json'u hiç yakalamamıştı (sözleşme kablosuz gemiye çıkmıştı).

### Bilinen risk (PR draft açılma sebebi)

31 scaffold, projeleri tip-bilinçli strict lint'e geçirir; main parktan bu
yana ~470 commit ilerledi — yeni konfig altındaki lint yüzeyi ölçülmemiş.
CI hakem; kırmızı lint şeritleri kural-düzeyi kök-neden düzeltmeleriyle
(susturma DEĞİL) bu dalda kapatılmadan PR draft'tan çıkmaz.

### Tier sınıfı

Tier-3 (make it detectable): tip-bilinçli kurallar + closure manifesti
sınıf-düzeyi kalite kaymalarını CI'da görünür kılar.
