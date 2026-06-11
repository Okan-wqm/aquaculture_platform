# Servis kataloğu containerPort SSOT'u (2026-06-11)

## INFRA-HIGH-014 — Readiness view'ı portu 3000'e sabitlemişti; observability 3009 dinliyor → verify yanlış-negatif

**Severity:** HIGH · **Owner:** infra-expert · **Cycle:** 2026-06-11-production-opening

### Gözlem

`readinessServices()` (platform/libs/service-catalog/src/index.ts) her servis
için `port: 3000` SABİTLİYORDU; katalogda per-servis konteyner-içi port alanı
yoktu. `docker-compose.droplet.yml` observability-service için `PORT: 3009`
set ediyor (konteyner kendi healthcheck'iyle SAĞLIKLI). Sonuç: TAG fix'i
sonrası İLK kez kritiklik kapısını geçen post-deploy-verify (run
27370474405), readiness sweep'inde `observability-service:3000` curl exit
7 (connection refused) ile düştü — production 30/30 sağlıklıyken ikinci
yanlış-negatif sınıfı. Droplet'te per-servis reprodüksiyon: 13 servis OK,
yalnız observability:3000 FAIL; 3009'da `/health/ready` OK.

İkincil gözlem: verify'ın readiness döngüsü düşen servisi RAPORLAMADAN
(`set -e` + sessiz `docker exec curl`) ölüyor — gözlemlenebilirlik eksiği
ayrı iyileştirme olarak aynı sınıfta not edildi (döngü artık parity
invariant'ıyla yapısal güvence altında olduğundan ayrı bulguya
terfi ettirilmedi).

### Düzeltme (bu PR)

1. **Katalog SSOT:** `ServiceCatalogEntry.containerPort` alanı —
   normalizer varsayılanı 3000; observability-service `containerPort: 3009`
   deklare ediyor (WHY yorumlu). `readinessServices()` sabit yerine
   `entry.containerPort` döndürür.
2. **Üretilen artifact'ler** kanonik `npm run service-catalog:generate` ile
   yeniden üretildi (deploy.vars `observability-service:3009` + catalogHash
   türevleri).
3. **Parity invariant'ı** (`platform-service-catalog-parity.spec.ts`):
   compose servis bloğundaki `PORT:` env'i (yoksa 3000) ↔ katalog
   `containerPort` birebir — compose↔katalog port sapması artık CI-kırmızı
   (INFRA-MEDIUM-004 compose↔SSOT parity sınıfının ilk somut dilimi).
4. **Katalog unit spec'i:** varsayılan 3000 + observability 3009 pinleri.

### Tier sınıfı

Tier-2 (make it automatic): port artık SSOT'tan akar; Tier-3 parity
invariant'ı sınıfın sessiz geri dönüşünü kapatır.

### Kanıt

- Run 27370474405 verify: "Service health check passed" → exit 7
- Droplet reprodüksiyonu: 13×OK + observability:3000 FAIL(curl=7); 3009 OK
- `docker-compose.droplet.yml:1271` (PORT: 3009)
- `platform/libs/service-catalog/src/index.ts` readinessServices()
