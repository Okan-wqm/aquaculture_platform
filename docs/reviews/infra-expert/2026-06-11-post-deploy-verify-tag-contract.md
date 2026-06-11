# post-deploy-verify: compose TAG env sözleşmesi eksiği (2026-06-11)

## INFRA-HIGH-012 — Verify script'i compose'un TAG sözleşmesini taşımıyor; sağlık kapısı tek konteynere bakamadan ölüyor

**Severity:** HIGH · **Owner:** infra-expert · **Cycle:** 2026-06-11-production-opening

### Gözlem

`docker-compose.droplet.yml` imaj referansları `${TAG:?TAG required}` ile
interpolasyon yapar. `scripts/deploy/droplet-up.sh:32-33` bu sözleşmeyi
`TAG="${TAG:-${DEPLOY_SHA}}"` ile sahiplenir; ancak
`scripts/deploy/post-deploy-verify.sh` compose'u üç yerden çağırırken
(`check-service-health.ts` → `compose config --services`; readiness
sweep'i → `compose ps -q` ×2) TAG'i HİÇ export etmiyordu. Sonuç: ilk
gerçek tam-yığın verify koşusu (run 27364403664, e05214c6b deploy'u)
"error while interpolating services.gateway-api.image: required variable
TAG is missing" ile, tek konteyner sağlığına bakamadan exit 2 — production
o anda 30/30 SAĞLIKLIYDI (elle doğrulandı), kırmızı tamamen yanlış-negatif.

INFRA-HIGH-010 ile aynı sınıf: paylaşılan bir dosyanın env sözleşmesini
tüketicilerden yalnız biri taşıyor.

### Düzeltme (bu PR)

`post-deploy-verify.sh` TARGET_SHA doğrulamasının hemen ardından
`TAG="${TAG:-${TARGET_SHA}}"; export TAG` — verifier'ın deploy kimliği
zaten ledger-doğrulamalı TARGET_SHA (imajlar SHA-tag'li); droplet-up'ın
sözleşmesinin verify tarafındaki birebir karşılığı. WHY bloğu üç compose
çağrısını ve sınıfı adlandırıyor.

### Ampirik kanıt (droplet, salt-okunur)

- `TAG=e05214c6b... docker compose -f docker-compose.droplet.yml config --services` → exit 0, servis listesi.
- TAG'siz aynı komut → "required variable TAG is missing a value" (verify
  koşusundaki hatayla birebir).

### Tier sınıfı

Tier-2: verifier'ın compose erişimi artık deploy kimliğinden otomatik
beslenir. Sınıfın yapısal kapanışı (compose env sözleşmesinin TÜM
tüketicilerini sayan bir invariant) küme-7 deploy-fail-safe PR'ının
kapsamına not edildi.
