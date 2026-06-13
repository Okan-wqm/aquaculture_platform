# BatchHarvested.isFinal — additive optional protokol (arbiter B2) (2026-06-12)

## FARM-HIGH-006 — final-vs-partial harvest ayrımı wire'da yoktu

**Severity:** HIGH · **Layer:** 2 · **Owner:** farm-expert
**Cycle:** 2026-06-10-round2 (architectural-arbiter B2; farm-expert + data-expert ortak imza)

### Gözlem

`BatchHarvestedEvent` batch'i boşaltan (final) harvest ile partial harvest'i
ayırt edemiyordu — oysa final harvest batch kapanış akışını (CloseBatch →
FCR/mortality/days-in-production donar) tetikleyen sinyaldir. Handler bu
gerçeği zaten hesaplıyor (`create-harvest-record.handler.ts:314`
`batch.currentQuantity <= 0` → HARVESTED status) ama wire'a koymuyordu.

### Ortak-imza DÜZELTMESİ (park dalın şekli YANLIŞTI)

Park edilen dal (repository-review-frhfaj) `isFinal`'ı **required** yapıp
alan-uyduran bir upcaster ekliyordu. İki uzman da bunu REDDETTİ:

- **farm-expert (FARM-HIGH-001):** NATS bridge payload'u HERHANGİ bir
  upcaster'dan ÖNCE valide ediyor (bridge'e upcaster registry bağlı değil);
  required `isFinal` + `additionalProperties:false` rollout'ta uçuştaki tüm
  v1 event'leri DÜŞÜRÜR (fail-closed event-drop). Ayrıca `true` default
  replay'de batch'leri oto-kapatır (data-integrity tehlikesi).
- **data-expert:** identity upcaster v1→v2 `isFinal`'ı EKLEMEZ; required
  schema bunu reddeder → upcaster'ın `false` UYDURMASI gerekir = v1'in
  gerçek-bilinmeyen finality'sini yanlış-veriye çevirir.

### Uygulanan şekil (arbiter "opsiyonel+default", iki imza)

1. **Interface:** `isFinal?: boolean` opsiyonel + Tolerant-Reader docblock
   (missing/undefined → `false`; `true` yalnız sinyal, batch'i kapatmaz).
2. **Wire + schema:** `isFinal: { type:'boolean', nullable:true }`
   properties'e, `required`'a DEĞİL → TEK schema hem v1 (isFinal yok) hem v2
   payload'u valide eder; `additionalProperties:false` yüzünden v2'nin
   düşmemesi için schema'da bulunması ZORUNLU.
3. **Emitter:** `createBaseEvent(..., { version: 2 })` + `isFinal:
   isFinalHarvest` — `isFinalHarvest` HARVESTED status'unu da kapılayan
   AYNI `currentQuantity<=0` değerinden hoist edildi (FARM-LOW-004 tek
   kaynak, yeniden hesaplama yok).
4. **Upcaster:** `batchHarvestedUpcaster` (v1→v2) IDENTITY — yalnız version
   bump, alan uydurmaz (sensor-reading-v2-to-v3 emsali); index'e register +
   export.
5. **Testler:** upcaster spec 4 yeni case (identity-bump, mevcut-isFinal
   koru, contiguous 1→2, registry round-trip) → suite 34/34; schema-
   validation spec 5 case (v2 true/false geçer, v1 geçer, fazla-alan +
   non-boolean reddedilir) → 5/5; upcaster-chain invariant 4/4. BREAKING
   CHANGE footer YOK (additive + identity upcaster v1'i kırmaz).

### Açık takipler (bu dilimde DEĞİL — arbiter kapsamı dışı)

- **FARM-MEDIUM-002:** `isFinal`'ı okuyan backend batch-closure consumer'ı
  HENÜZ yok; alan dead-on-arrival olmasın diye kayıtlı takip.
- **FARM-MEDIUM-003:** closure consumer gelince FE invalidation set'i
  (useFarmRealtimeStream) closure-metric query key'lerini içermeli.

### Tier sınıfı

Tier-2: JSONSchemaType generic'i interface↔schema drift'ini tsc'de yakalar;
upcaster-chain invariant 1→2 entry'sini CI'da zorlar.
