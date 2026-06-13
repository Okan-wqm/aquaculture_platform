# Farm GraphQL FE↔BE parity invariant + 4 canlı uyumsuzluk düzeltmesi (2026-06-12)

## FARM-HIGH-005 — Farm-module FE, farm subgraph'ın serve etmediği 4 alanı çağırıyor (sessiz runtime hatası)

**Severity:** HIGH · **Owner:** farm-expert · **Cycle:** 2026-06-10-round2
(architectural-arbiter B1 onaylı — repository-review-frhfaj)

### Gözlem

FE GraphQL belge alan adları subgraph'a karşı build-time denetimi olmadan
elle tutuluyordu. Port edilen invariant (taze main'e karşı koşturuldu) tam
4 canlı uyumsuzluk yakaladı — hepsi park edilen repository-review-frhfaj
dalının docblock'unda adlandırdığı bug'lar, main'e hiç inmemişti:

1. `batchFeedAssignmentForBatch` (`useBatchFeedAssignments.ts`) — BE
   `batchFeedAssignment(batchId)` serve ediyor. Batch Feeding sekmesi
   production'da sessizce boş render ediyordu.
2-4. `feedingProgramStats`, `feedingProgramCalendar`,
   `availableProgramsForTank` (`feedingProgram.queries.ts`) — hiç var
   olmayan resolver'lara işaret eden DEAD-CODE query'ler (kendi
   yorumlarında "DEAD-CODE" diye işaretli; bundle'a gidiyordu).

### Çözüm (bu PR — arbiter B1: temiz commit)

- **Invariant** `tests/invariants/farm-graphql-fe-be-parity.spec.ts`:
  farm-service resolver dekoratörlerini (`{ name }` opsiyonu dahil) ve
  farm-module FE operasyon belgelerini tarar; her FE kök-alanı bir BE
  resolver'a VEYA allowlist'li federation alanına (CROSS_SUBGRAPH_FIELDS,
  her giriş sahip-subgraph adıyla) çözülmeli. Extractor-çürümesine karşı
  canary'ler (BE ≥200 alan + 4 isimli alan; FE ≥50 operasyon).
- **4 FE düzeltmesi** (dalın temiz versiyonları, main bu iki dosyada
  pre-fix tabandan sapmamış): `batchFeedAssignmentForBatch` →
  `batchFeedAssignment` rename (query alanı + response tipi + dönüş); 3
  DEAD-CODE query export'u silindi (0 dış-referans doğrulandı — gerçekten
  ölü).

### Tier sınıfı

Tier-3 (make it detectable): FE'nin subgraph'ın servelemediği bir alanı
adlandırması artık kullanıcının tarayıcısında runtime'da değil, CI'da
kırmızı.

### Kanıt

- Invariant taze main'e karşı: 4 uyumsuzluk yakaladı → düzeltme → 4/4 yeşil.
- `web/modules/farm-module/src/hooks/useBatchFeedAssignments.ts:56`
- `web/modules/farm-module/src/graphql/feedingProgram.queries.ts` (3 silme)
- Kaynak: claude/repository-review-frhfaj (arbiter B1 PORT kararı; B2 isFinal
  ayrı PR'da farm-expert+data-expert ortak imzayla).
