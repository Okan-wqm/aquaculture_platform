# Safe-GC rollback retention politikası (2026-06-11)

## INFRA-HIGH-013 — Rollback retag'leri hiçbir GC filtresine girmiyordu; jenerasyon birikimi kapasite kapısını yapısal olarak bloke etti

**Severity:** HIGH · **Owner:** infra-expert · **Cycle:** 2026-06-11-production-opening

### Gözlem

Her deploy, önceki koşan jenerasyonu `rollback-<sha>-<ts>` olarak retag'ler
(~tam imaj seti, ~15-20GB). `safe_image_gc` (scripts/deploy/
droplet-capacity.sh) yalnız `^[0-9a-f]{40}$` SHA tag'lerini değerlendirir —
rollback retag'leri filtreye HİÇ girmez ve sonsuza dek birikir. Ek olarak
untag-sonrası final prune yoktu: kardeş tag'ler/yetim layer'lar kalınca
"before=after" semptomu (preflight logunda removed_tags=25,
before=35.26GB after=35.26GB).

Sonuç: capacity-preflight 2026-06-11'de merge trenini ÜÇ kez bloke etti
(46f6bd68f deploy'u, be8b95650 deploy'u; her seferinde elle, operatör-onaylı
GC seremonisi gerekti). Fail-closed kapı doğru çalıştı; kök neden retention
politikasının yokluğuydu.

### Düzeltme (bu PR)

`safe_image_gc`'ye iki yapısal ekleme:

1. **Rollback-retention geçişi:** `rollback-*` retag'leri sayılır; bir retag
   YALNIZ mevcut rollback manifest'i (veya koşan bir konteyner) imaj ID'sini
   referansladığı sürece yaşar — yani tam olarak en yeni jenerasyon. Eski
   jenerasyonlar bu droplet'in GHCR'dan YALNIZ ÇEKTİĞİ imajların lokal
   retag'leridir (pull-only runtime, ADR-033) — silme, yeniden çekilemez
   hiçbir şeyi kaybettirmez (bugünkü üç elle seremoninin gerekçesinin
   politikaya dönüşmüş hali).
2. **Final dangling prune:** untag geçişleri sonrası tek dangling-only
   prune — untag'in gerçek byte'a dönüşmesi (before=after sınıfının
   kapanışı).

Ek: `GC_DRY_RUN=true` — silmeden enumerasyon (operatör-denetlenebilir);
dry-run'da İKİ prune da atlanır. Droplet'te ampirik dry-run: sözdizimi +
uçtan uca koşu doğrulandı (temiz durumda 0 aday — beklenen).

### Tier sınıfı

Tier-2 (make it automatic): retention artık her preflight GC koşusunda
kendiliğinden uygulanır; elle seremoni ihtiyacı sınıf olarak kalkar.
deploy-ssot-contract'a Tier-3 varlık pinleri eklendi (retention geçişi +
sayaç + dry-run kaybolamaz).

### Kanıt

- `scripts/deploy/droplet-capacity.sh:295` (safe_image_gc; retention geçişi)
- Preflight logu run 27362651525: `removed_tags=25 ... before=35.26GB after=35.26GB`
- Bugünkü üç elle GC seremonisi: ledger 2026-06-11 (~17:04Z, ~19:30Z kayıtları)
- `tests/invariants/deploy-ssot-contract.spec.ts` yeni `it` bloğu
