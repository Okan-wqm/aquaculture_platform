# Deploy keyring bootstrap SSOT review (2026-06-11)

Reviewer: infra-expert (Round-2 Adım-0 production gözetimi — Wave-1 deploy zinciri)
Scope: `scripts/deploy/lib/required-env-secrets.sh`, `scripts/deploy/droplet-bootstrap-env.sh`, `docker-compose.droplet.yml`

## INFRA-HIGH-006 — Compose `:?` zorunlu SERVICE_IDENTITY_KEYRING bootstrap SSOT'unda yok; deploy interpolasyonda ölüyor

**Severity:** HIGH (production deploy bloke — Wave-1 + hotfix + küme-0 zinciri son adımda düştü)

**Gözlem:** main@2098f69e2 deploy adımı: `error while interpolating services.event-store-service.environment.SERVICE_IDENTITY_KEYRING: required variable ... missing a value`. `docker-compose.droplet.yml` BEŞ serviste `${SERVICE_IDENTITY_KEYRING:?...}` zorunlu kılıyor (562, 678, 748, 824, 908). Droplet `.env`'i hiç almamış: v2 HMAC keyring'i compose sözleşmesine girerken (#375 dönemi) droplet-side secret provisioning SSOT'una (`REQUIRED_ENV_SECRETS`) eklenmemiş. Preflight'ın "required secrets presence" kapısı da aynı listeden beslendiği için eksikliği YAKALAYAMADI — liste eksikse kapı da kördür (drift-koruması listenin kendisini koruyamaz).

**Kök neden:** Sözleşmeyi genişleten değişiklik (compose `:?`) tüketici tarafın SSOT'unu (required-env-secrets.sh) güncellemeden merge olmuş. Round-1'deki "path-filtreli suite koşmadı" sınıfının secret-provisioning ikizi.

**Fix (bu PR):**
- `generate_service_identity_keyring()` fonksiyonu + `REQUIRED_ENV_SECRETS` girdisi: bootstrap eksikse tek-anahtarlı JSON keyring üretir (`[{"kid":"k-<UTCdate>","secret":"<64-hex>","status":"active"}]`), asla rotate etmez (mevcut never-rotate sözleşmesi). Politika alanları (callers/audiences/tenantScopePolicy) bilinçli boş — sıkılaştırma operatör seremonisi.
- Ampirik doğrulama: ENV_FILE override'lı uçtan uca bootstrap koşusu → satır eklendi, ikinci koşu idempotent SKIP, üretilen değer GERÇEK `parseServiceIdentityKeyring()` ile doğrulandı (kid/secret-64/active).
- droplet-up.sh preflight zaten aynı diziden doğruladığı için tek girdiyle hem üretim hem doğrulama kapanır (Tier-1 SSOT zinciri korunuyor).

**Yapılmayan (kayıtlı):** compose `:?` zorunlu env'leri ile REQUIRED_ENV_SECRETS listesi arasında mekanik parite invariant'ı yok — bir sonraki `:?` eklemesi aynı sınıfı tekrar üretebilir. Bulgu: INFRA-MEDIUM-004 (OPEN, owner infra-expert, deadline 2026-06-24, küme-7 Deploy/CI portunda invariant testi olarak kapanır).

## INFRA-MEDIUM-004 — compose `:?` zorunluları ↔ bootstrap REQUIRED_ENV_SECRETS parite invariant'ı eksik (OPEN)

`docker-compose.droplet.yml` içindeki `${VAR:?}` desenlerini parse edip REQUIRED_ENV_SECRETS isimleriyle (+ DB_PASS jenerasyon ailesiyle) kıyaslayan bir invariant spec'i (`tests/invariants/`) yazılmalı — `:?` eklenen ama SSOT'a girmeyen değişken CI'da kırmızı olmalı. Küme-7'ye bağlandı.
