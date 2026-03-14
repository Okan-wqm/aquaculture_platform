# D17 - Docker & Container Infrastructure Audit

**Auditor:** Altyapi Uzmani (D17)
**Tarih:** 2026-03-14
**Kapsam:** Tum Dockerfile'lar, docker-compose dosyalari, init scripts, nginx, CI/CD pipeline
**Severity Skalasi:** CRITICAL / HIGH / MEDIUM / LOW / INFO

---

## 1. YONETICI OZETI

Platform 9 Dockerfile, 8 docker-compose varianti, 7 DB init script, 6 nginx konfigurasyonu
ve 1 CI/CD deployment workflow icermektedir. Genel olarak iyi muhendislik pratikleri
uygulanmis; non-root user kullanimi, health check'ler, BuildKit cache, multi-stage build'ler
ve network izolasyonu mevcut. Ancak birkac **CRITICAL** guvenlik bulgusu (ozellikle
hardcoded credential'lar ve trust authentication) ve **HIGH** severity uretim
konfigurasyonu sorunlari tespit edilmistir.

### Skor Tablosu

| Kategori                     | Skor | Aciklama                                        |
|------------------------------|------|-------------------------------------------------|
| Dockerfile Best Practices    | 8/10 | Multi-stage, non-root, dumb-init -- iyi          |
| Compose Service Config       | 7/10 | Health check, depends_on, restart policy mevcut  |
| Secret Management            | 3/10 | Hardcoded credential'lar CRITICAL                |
| Network Isolation             | 8/10 | aqua-internal + aqua-network ayrimi iyi          |
| Resource Limits              | 8/10 | droplet.yml'de detayli, prod.yml'de eksik        |
| Init Scripts / DB Migration  | 6/10 | Hardcoded sifre, trust auth problematik          |
| CI/CD Pipeline               | 8/10 | SHA-pinned actions, integrity check, rollback    |
| Image Security               | 6/10 | `latest` tag kullaniminda risk, bazi root user   |

---

## 2. DOCKERFILE ANALIZI

### 2.1 Envanter

| Dockerfile                       | Multi-Stage | Non-Root | Health Check | dumb-init | Base Image         |
|----------------------------------|-------------|----------|--------------|-----------|--------------------|
| Dockerfile.backend               | 5 stage     | nestjs   | curl         | Evet      | node:22-alpine     |
| Dockerfile.backend.simple (CI)   | 1 stage     | nestjs   | curl         | Evet      | node:22-alpine     |
| Dockerfile.backend.dev           | 1 stage     | node     | curl         | Hayir     | node:22-alpine     |
| Dockerfile.prebuilt              | 2 stage     | nestjs   | curl         | Evet      | node:22-alpine     |
| Dockerfile.frontend              | 4 stage     | nginx    | wget         | Hayir     | node:22 + nginx    |
| Dockerfile.shell                 | 1 stage     | ROOT     | wget         | Hayir     | nginx:alpine       |
| Dockerfile.microfrontend.simple  | 1 stage     | ROOT     | curl         | Hayir     | nginx:alpine       |
| Dockerfile.microfrontend         | 1 stage     | ROOT     | wget         | Hayir     | nginx:alpine       |
| Dockerfile.aquamobil             | 2 stage     | appuser* | curl         | Hayir     | node:22 + nginx    |

### 2.2 Bulgular

#### [MEDIUM] D17-DF-001: Microfrontend ve Shell Container'lari Root Olarak Calisiyor

**Dosyalar:**
- `infrastructure/docker/Dockerfile.shell` -- `USER` direktifi yok
- `infrastructure/docker/Dockerfile.microfrontend.simple` -- `USER` direktifi yok
- `infrastructure/docker/Dockerfile.microfrontend` -- `USER` direktifi yok

Bu container'lar nginx:alpine base image kullanip nginx process'ini root olarak calistiriyor.
`Dockerfile.frontend` bu sorunu dogru sekilde cozmus (chown + USER nginx).
`Dockerfile.aquamobil` ise `appuser` olusturmus ama `USER appuser` satirini **eklememis**,
dolayisiyla fiilen root olarak calisiyor.

**Oneri:** Tum nginx-based Dockerfile'lara `Dockerfile.frontend` pattern'ini uygula:
```dockerfile
RUN chown -R nginx:nginx /usr/share/nginx/html && \
    chown -R nginx:nginx /var/cache/nginx && \
    chown -R nginx:nginx /var/log/nginx && \
    touch /var/run/nginx.pid && \
    chown -R nginx:nginx /var/run/nginx.pid
USER nginx
```

**Not:** `docker-compose.droplet.yml`'de MFE container'lari `read_only: true` ile
calistirilarak bu risk kismen azaltilmis. Bu iyi bir guvenlik katmani.

#### [LOW] D17-DF-002: Dockerfile.backend.simple Tek Stage -- Cache Optimizasyonu Sinirli

`Dockerfile.backend.simple` tek stage kullandigi icin `node_modules` ve uygulama kodu
ayni katmanda. Ancak `npm ci` katmani ayri oldugu icin pratikte sorun yok.
`Dockerfile.prebuilt` ve `Dockerfile.backend` dogru multi-stage yaklasimi kullanmis.

#### [LOW] D17-DF-003: npm Cache Mount Root Olarak Calisiyor

```dockerfile
RUN --mount=type=cache,target=/root/.npm,sharing=shared \
    npm ci --legacy-peer-deps --omit=dev --ignore-scripts --no-audit && \
    chown -R nestjs:nodejs /app/node_modules
```

`npm ci` root olarak calisirken cache `/root/.npm`'e yaziliyor, sonra `USER nestjs`'e
geciliyor. Bu guvenlik acisindan kabul edilebilir cunku build-time'da oluyor, runtime'da
degil. Ancak `chown -R` buyuk `node_modules` icin yavas olabilir.

#### [INFO] D17-DF-004: Image Boyut Tahminleri

| Image Tipi      | Tahmini Boyut | Aciklama                                     |
|-----------------|---------------|----------------------------------------------|
| Backend (simple)| ~200-350MB    | node:22-alpine + prod deps + dist            |
| Backend (full)  | ~200-350MB    | Final stage ayni, build stage atiliyor        |
| Frontend/MFE    | ~30-50MB      | nginx:alpine + static files                  |
| Shell           | ~30-50MB      | nginx:alpine + static files                  |
| AquaMobil       | ~50-80MB      | nginx:alpine + build stage atiyor            |

Alpine base image kullanimi image boyutunu minimumda tutuyor -- **iyi pratik**.

#### [INFO] D17-DF-005: Base Image Guncellik

- `node:22-alpine`: Node.js 22 LTS -- guncel
- `nginx:alpine`: Versiyon pinlenmemis (tag: `alpine`), minor guncelleme riski var
- `timescale/timescaledb:latest-pg16`: `latest` tag kullanimi -- deployment reproducibility riski

**Oneri:** Tum base image'leri belirli versiyona pinle (ornegin `nginx:1.27-alpine`,
`timescale/timescaledb:2.17.2-pg16`).

---

## 3. DOCKER-COMPOSE ANALIZI

### 3.1 Compose Dosya Envanteri

| Dosya                        | Amac                    | Network         | Resource Limits |
|------------------------------|-------------------------|-----------------|-----------------|
| docker-compose.yml           | Full dev stack           | aqua-network    | EVET (tum svc)  |
| docker-compose.infra.yml     | Sadece altyapi (NX dev) | aqua-network    | HAYIR           |
| docker-compose.dev.yml       | Simplified dev           | aqua-network    | HAYIR           |
| docker-compose.watch.yml     | Hot-reload dev           | aqua-network    | HAYIR           |
| docker-compose.prod.yml      | Production (root)        | internal+network| HAYIR           |
| docker-compose.droplet.yml   | DigitalOcean prod        | internal+network| EVET (tum svc)  |

### 3.2 Bulgular

#### [HIGH] D17-DC-001: docker-compose.prod.yml'de Resource Limit Yok

Root-level `docker-compose.prod.yml` dosyasinda hicbir service icin `deploy.resources.limits`
tanimlanmamis. Bu, bir runaway process'in tum host'u OOM yapmasina neden olabilir.

**Karsilastirma:**
- `docker-compose.yml` (dev): Tum backend service'lerde 512M/1.0 CPU limit mevcut
- `docker-compose.droplet.yml`: Detayli limitler (gateway 512M, alert 256M, MFE 64M, vs.)
- `docker-compose.prod.yml`: **HICBIR LIMIT YOK**

**Oneri:** `docker-compose.droplet.yml`'deki limit pattern'ini `docker-compose.prod.yml`'e
de uygula.

#### [HIGH] D17-DC-002: Production'da DATABASE_SYNC: "true" Kullaniliyor

Hem `docker-compose.droplet.yml` hem `infrastructure/docker/docker-compose.prod.yml`
dosyalarinda **hemen tum servisler** `DATABASE_SYNC: "true"` ile calistirilmis:

```yaml
# docker-compose.droplet.yml icinden:
auth-service:    DATABASE_SYNC: "true"
farm-service:    DATABASE_SYNC: "true"
sensor-service:  DATABASE_SYNC: "true"
hr-service:      DATABASE_SYNC: "true"
billing-service: DATABASE_SYNC: "true"
gateway-api:     DATABASE_SYNC: "true"
admin-api:       DATABASE_SYNC: "true"
hydroponics:     DATABASE_SYNC: "true"
notification:    DATABASE_SYNC: "true"
config-service:  DATABASE_SYNC: "true"
alert-engine:    DATABASE_SYNC: "true"
observability:   (yok, kendi DB'si)
```

TypeORM `synchronize: true` production'da veri kaybi riski olusturur (kolon drop, rename).
Her servis baslarken schema'yi otomatik degistirebilir.

**Oneri:** Production'da `DATABASE_SYNC: "false"` kullanilmali, schema degisiklikleri
kontrollü migration'lar ile yapilmali.

#### [MEDIUM] D17-DC-003: Compose Dosyalari Arasinda Tutarsizlik

| Parametre              | docker-compose.yml | dev.yml | droplet.yml | prod.yml |
|------------------------|-------------------|---------|-------------|----------|
| Health check           | EVET (tum svc)    | EVET    | EVET        | EVET     |
| Resource limits        | EVET              | HAYIR   | EVET        | HAYIR    |
| Non-root nginx (MFE)   | HAYIR             | HAYIR   | read_only   | HAYIR    |
| depends_on condition   | service_healthy   | mix     | service_healthy | simple |
| Redis healthcheck auth | EVET (REDISCLI_AUTH)| HAYIR  | EVET        | EVET     |
| NATS monitoring port   | localhost bind    | 8222:8222| yok         | yok      |

`docker-compose.dev.yml` Redis health check'inde `REDISCLI_AUTH` kullanmiyor:
```yaml
# docker-compose.dev.yml (YANLIS):
test: ["CMD", "redis-cli", "ping"]  # requirepass varken basarisiz olur

# docker-compose.yml (DOGRU):
test: ["CMD-SHELL", "REDISCLI_AUTH=${REDIS_PASSWORD:-devpassword} redis-cli ping"]
```

#### [LOW] D17-DC-004: MFE Service'lerinde Health Check Eksik (Production)

`docker-compose.prod.yml` ve `docker-compose.droplet.yml`'de dashboard, farm-module,
hr-module, sensor-module, admin-panel, tenant-admin service'lerinde health check
tanimlanmamis. Sadece shell ve aquamobil'de var.

**Oneri:** Tum MFE service'lerine health check ekle:
```yaml
healthcheck:
  test: ["CMD", "wget", "-q", "--spider", "http://localhost:80/"]
  interval: 30s
  timeout: 5s
  retries: 3
```

#### [INFO] D17-DC-005: Service Bagimlilik Yapisi

Gateway API'nin depends_on yapisi iyi dusunulmus:
- `docker-compose.yml` (dev): Infra -> `service_healthy`, backend -> `service_started`
  (deadlock onlemi)
- `docker-compose.droplet.yml`: Subgraph'lar -> `service_healthy` (federation introspection),
  non-subgraph -> `service_started`

#### [INFO] D17-DC-006: Restart Policy

Tum compose dosyalarinda `restart: unless-stopped` tutarli sekilde kullanilmis.
Infrastructure service'ler (mailhog, adminer) dahil dogru sekilde ayarlanmis.

---

## 4. GUVENLIK ANALIZI

### 4.1 Secret Management

#### [CRITICAL] D17-SEC-001: .env.production.example'da Gercek Credential'lar

`/.env.production.example` dosyasi **git'te tracked** ve icinde gercek production
credential'lari var:

```
POSTGRES_PASSWORD=JFnkR8QuSnsuQklHyWqV45PX
REDIS_PASSWORD=O5LWb1R9Ky10qUakWqi6xkB7
JWT_SECRET=OponN9FQ6A45cflI1JxLWOEAyBnoQd1I6v5BLd8kPhZDsAtB
ENCRYPTION_KEY=c24b93a2703ddd47f01378e5b2e85db0
SUPER_ADMIN_EMAIL=by-okan@live.com
SUPER_ADMIN_PASSWORD="OkanAdmin2024!#"
OBSERVABILITY_INTERNAL_API_KEY=df3fce00f3b38ea81d7fde...
MINIO_USER=aquaminio
MINIO_PASSWORD=0e4c93e345a9d34bac5ccf6aa7ec8d29
MQTT_AUTH_SECRET=b5e3c1c46c10e6b16d8d811dac725d1c...
MQTT_SENSOR_SERVICE_PASSWORD=2TsOhQNhJn6OgiKsvGrVQ-1FfV8OcwkdpmSHdHNYv0g
```

Bu dosya public repo'da oldugu icin **tum bu credential'lar rotate edilmelidir**.

**Karsilastirma:** Root-level `/.env.production.example` placeholder degerler kullaniyor
(CHANGE_ME_...) -- bu dogru yaklasim. Ama `infrastructure/docker/.env.production.example`
gercek degerler iceriyor.

**Acil Aksiyon:**
1. `infrastructure/docker/.env.production.example` dosyasini temizle -- placeholder
   kullan
2. Tum credential'lari rotate et (DB, Redis, JWT, MinIO, MQTT, SuperAdmin)
3. Git history'den credential'lari temizle (`git filter-branch` veya BFG)

#### [CRITICAL] D17-SEC-002: DB Init Script'te Trust Authentication

`infrastructure/docker/init-scripts/00-trust-auth.sh`:
```bash
echo "host all all 0.0.0.0/0 trust" >> /var/lib/postgresql/data/pg_hba.conf
```

Bu script **tum IP'lerden** sifrresiz erisim sagliyor. Init script'ler sadece ilk
container baslatmada calisir ve yalnizca `docker-compose.yml` (dev) ve
`docker-compose.infra.yml` ile mount ediliyor. Ancak:
- `docker-compose.droplet.yml` da init-scripts volume'u mount ediyor (satir 55)
- Eger droplet'te postgres volume silinip yeniden olusturulursa trust auth aktif olur

**Oneri:**
- Init script'i yalnizca dev ortamina ozel yap veya tamamen kaldir
- `docker-compose.droplet.yml`'den init-scripts mount'unu kaldir (satir 55-56)

#### [HIGH] D17-SEC-003: Init Script'te Hardcoded DB Kullanici Sifreleri

`infrastructure/docker/init-scripts/00-init-schemas.sql` dosyasinda per-service DB
kullanicilari hardcoded sifrelerle olusturuluyor:

```sql
CREATE ROLE auth_service WITH LOGIN PASSWORD 'CHANGE_ME_AUTH_SERVICE_PASS';
CREATE ROLE farm_service WITH LOGIN PASSWORD 'CHANGE_ME_FARM_SERVICE_PASS';
-- ... 8 daha
```

Bu kullanicilar gercekte **kullanilmiyor** -- tum servisler paylasilmis `aquaculture`
kullanicisini kullaniyor. Ancak `CHANGE_ME_*` sifreleri degismezse bir saldirgan bu
kullanicilari kullanabilir.

**Oneri:**
1. Per-service kullanicilara gecis yapilacaksa, sifreler environment variable'dan alinmali
2. Gecis yapilmayacaksa bu role'leri olusturma blogu kaldirilmali

#### [MEDIUM] D17-SEC-004: Tum Servisler Ayni DB Kullanicisini Kullaniyor

`aquaculture` kullanicisi tum schemalara `ALL PRIVILEGES` ile erisebiliyor. Bir servisin
compromise edilmesi durumunda tum schemalara yazma erisimi saglaniyor.

Init script'te per-service kullanicilar (`auth_service`, `farm_service` vb.)
olusturulmus ama compose dosyalarinda kullanilmiyor. Least privilege prensibine aykiri.

#### [MEDIUM] D17-SEC-005: Dev Compose'da Default Credential Pattern

Dev ortaminda `${DB_PASSWORD:-devpassword}`, `${JWT_SECRET:-dev-jwt-secret-change-in-production}`
gibi default degerler kullaniliyor. Bu kabul edilebilir ama:

- `docker-compose.dev.yml` icinde `SUPER_ADMIN_PASSWORD: ${SUPER_ADMIN_PASSWORD:-DevPassword123!}`
  -- default super admin sifresi acik
- `ALLOW_DEV_JWT_SECRET: "true"` ve `DEV_JWT_SECRET` environment variable'lari
  production'a kacarsa risk olusturur

#### [INFO] D17-SEC-006: Olumlu Guvenlik Pratikleri

- `.env` dosyasi `.gitignore`'da -- git'te tracked degil
- `.dockerignore` `.env` dosyalarini exclude ediyor
- Production compose'da `${POSTGRES_PASSWORD:?POSTGRES_PASSWORD required}` pattern'i
  ile zorunlu variable kontrolu yapiliyor
- `NATS` monitoring portu localhost'a bind edilmis (`127.0.0.1:8222:8222`)
- `Adminer` localhost'a bind edilmis (`127.0.0.1:8081:8080`)
- Redis health check'te `REDISCLI_AUTH` env var kullanimi (process list leak onlemi)
- Production gateway portu localhost'a bind (`127.0.0.1:3000:3000`)

---

## 5. NETWORK IZOLASYONU

### 5.1 Network Topolojisi

```
                    INTERNET
                       |
                   [80/443]
                       |
                   +---v---+
                   | nginx |-------- aqua-network
                   +---+---+          (bridge)
                       |                 |
              +--------+--------+        |
              |        |        |    +---+---+---+---+---+---+---+---+---+
          [shell] [dashboard] [MFE]  |dashboard|farm |hr  |sensor|admin|...
              |                      +---+---+---+---+---+---+---+---+---+
              |                               aqua-network
              |
         +----v----+
         | gateway |----+---- aqua-network (external traffic)
         +---------+    |
                        +---- aqua-internal (service-to-service)
                              |
              +---------------+--+--+--+--+--+--+
              |     |    |    |  |  |  |  |  |  |
          [auth][farm][sensor][hr][billing][alert]...
              |     |    |    |  |  |  |  |  |  |
          +---+-----+----+----+--+--+--+--+--+--+
                              |
                    +---------+----------+
                    |         |          |
                [postgres] [redis]   [nats]
                              aqua-internal
                              (internal: true)
```

### 5.2 Bulgular

#### [INFO] D17-NET-001: Iyi Network Izolasyonu (droplet.yml)

- `aqua-internal` (`internal: true`): Backend servisler, DB, Redis, NATS -- disaridan
  erisilemez
- `aqua-network` (bridge): Frontend servisler ve nginx -- nginx uzerinden disariya acik
- Gateway hem `aqua-network` hem `aqua-internal`'de -- kopru gorevinde
- Mosquitto yalnizca `aqua-internal`'de -- MQTT 8883 portu nginx uzerinden proxy ediliyor

#### [MEDIUM] D17-NET-002: Dev Compose'da Port Exposure

`docker-compose.yml` (dev) icinde tum portlar 0.0.0.0'a bind ediliyor:
- `5432:5432` (Postgres)
- `6379:6379` (Redis)
- `4222:4222` (NATS)
- `9000:9000`, `9001:9001` (MinIO)
- `3000-3008` (Backend servisleri)

LAN uzerinden erisime acik. Dev ortami icin kabul edilebilir ama uyari konulabilir.

#### [INFO] D17-NET-003: SEC-013 Uyarisi Mevcut

`docker-compose.droplet.yml`'de dokumante edilmis:
> "If a container escape occurs, traffic on this network is readable by other containers.
> For stronger isolation, consider a service mesh."

Bu bilinirlik iyi bir pratik.

---

## 6. VOLUME ve DATA PERSISTENCE

### 6.1 Volume Envanteri

| Volume          | Kullanim         | Compose Dosyalari        |
|-----------------|------------------|--------------------------|
| postgres_data   | PostgreSQL data  | Tum dosyalarda           |
| redis_data      | Redis AOF        | Tum dosyalarda           |
| nats_data       | NATS JetStream   | Tum dosyalarda           |
| minio_data      | Object storage   | dev + infra + droplet    |
| mosquitto_data  | MQTT broker data | droplet                  |
| mosquitto_log   | MQTT logs        | droplet                  |

### 6.2 Bulgular

#### [MEDIUM] D17-VOL-001: Volume Backup Stratejisi Belirsiz

Named volume'lar Docker host'unda kalici depolama sagliyor, ancak:
- Backup/restore mekanizmasi dokumante edilmemis
- Postgres icin pg_dump/pg_basebackup stratejisi yok
- Volume snapshot'lari alinmiyor

**Oneri:** Cron-based pg_dump + S3/MinIO backup scriptleri olustur.

#### [INFO] D17-VOL-002: Read-Only Mounts

Production config dosyalari dogru sekilde `:ro` (read-only) mount edilmis:
- nginx.conf: `:ro`
- nats.conf: `:ro`
- SSL sertifikalari: `:ro`
- certbot: `:ro`

#### [INFO] D17-VOL-003: Frontend Container'larinda tmpfs Kullanimi

`docker-compose.droplet.yml`'de MFE container'lari tmpfs ile calistirilmis:
```yaml
tmpfs:
  - /tmp
  - /var/run
  - /var/cache/nginx
```
Bu, `read_only: true` ile birlikte guvenlik icin iyi bir pratik.

---

## 7. INIT SCRIPTS ve DB MIGRATION

### 7.1 Script Envanteri

| Script                              | Amac                            | Idempotent |
|-------------------------------------|----------------------------------|------------|
| 00-trust-auth.sh                    | Trust authentication (DEV ONLY)  | HAYIR*     |
| 00-init-schemas.sql                 | Schema + extension + user olusturma | EVET    |
| 01-init-databases.sql               | Auth tablo + seed                | EVET       |
| 02-migrate-tanks-to-equipment.sql   | Tank->Equipment migration        | EVET       |
| 03-farm-tables-and-seed.sql         | Farm reference data              | EVET       |
| 04-billing-tables.sql               | Billing + admin tablolari        | EVET       |
| 05-seed-module-pricing.sql          | Module pricing seed              | EVET       |

*`00-trust-auth.sh` her calistiginda pg_hba.conf'a tekrar satirlar ekler.

### 7.2 Bulgular

#### [HIGH] D17-INIT-001: Trust Auth Script Production Ortamina Mount Ediliyor

`docker-compose.droplet.yml` satir 55-56:
```yaml
volumes:
  - ./infrastructure/docker/init-scripts:/docker-entrypoint-initdb.d:ro
```

Bu, `00-trust-auth.sh`'nin production'da da calismasina neden olur (eger postgres
volume'u silinip yeniden olusturulursa). Trust auth uretimde ASLA kullanilmamalidir.

**Oneri:**
1. `00-trust-auth.sh`'yi `dev-only/` alt dizinine tasi
2. Production compose'dan init-scripts mount'unu kaldir
3. Veya init-scripts icinden trust-auth.sh'yi exclude et

#### [MEDIUM] D17-INIT-002: Migration Script Execution Order Riski

`02-migrate-tanks-to-equipment.sql` gibi migration script'leri `IF NOT EXISTS`
kontrolleri ile idempotent yapilmis -- iyi pratik. Ancak bu script'ler yalnizca
ilk postgres baslatmada calisor. Schema degisiklikleri icin:

- Bazi servisler `DATABASE_SYNC: "true"` (TypeORM synchronize) kullaniyor
- Bazi tablolar init-scripts'te olusturuluyor (billing, admin analytics)
- Hibrit yaklasim sorun cikarabilir

#### [INFO] D17-INIT-003: Super Admin Seeding Dogru Yaklasim

Super admin kullanicisi SQL'de degil, `auth-service`'in `SeedService`'inde
bcryptjs ile olusturuluyor. SQL'deki pgcrypto uyumsuzlugu dokumante edilmis.
Bu dogru bir karar.

---

## 8. NGINX KONFIGURASYONU

### 8.1 Bulgular

#### [INFO] D17-NGX-001: Guvenlik Header'lari Kapsamli

Production nginx konfigurasyonu (`nginx.prod.conf`) iyi guvenlik pratikleri iceriyor:
- `server_tokens off` -- versiyon gizleme
- HSTS (63072000 saniye / 2 yil, preload)
- `X-Frame-Options: SAMEORIGIN`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- CSP politikasi tanimli (unsafe-eval kaldirilmis, SEC-NM-017)
- Permissions-Policy tanimli
- Rate limiting (`limit_req_zone`, 100r/s API, 500r/s static)
- `/metrics` endpoint'i `deny all` ile engellenmis
- `client_max_body_size 10m` -- request size limiti

#### [LOW] D17-NGX-002: SSL Cipher Suite Guncellemesi

SSL konfigurasyonu TLS 1.2 ve 1.3 destekliyor, cipher suite modern ama
`ssl_prefer_server_ciphers off` TLS 1.2 icin downgrade riski olusturabilir.

#### [INFO] D17-NGX-003: WebSocket Proxy Dogru Yapistirilmis

`map $http_upgrade $connection_upgrade` ile duplicate Connection header sorunu
cozulmus (SEC-NM-008).

---

## 9. CI/CD PIPELINE

### 9.1 Bulgular

#### [INFO] D17-CI-001: Olumlu CI/CD Pratikleri

`deploy-digitalocean.yml` pipeline'i bircok iyi guvenlik ve performans pratigi iceriyor:
- Tum 3rd-party GitHub Actions SHA ile pinlenmis (SEC-CI-002)
- npm tarball SHA-512 integrity dogrulamasi (SEC-CI-007)
- Deploy oncesi image digest capture + basarisiz deploy'da rollback (ARCH-CI-007)
- Affected-only build/deploy (PERF-CI-001)
- Concurrency group ile paralel deploy onlemi
- `checkout -f ${{ github.sha }}` ile TOCTOU race condition onlemi (SEC-CI-012)
- `deployed/production` tag ile delta detection
- DROPLET_HOST echo kaldirma (SEC-CI-005)

#### [MEDIUM] D17-CI-002: GITHUB_TOKEN Droplet'te Expose Ediliyor

Deploy step'inde `${{ secrets.GITHUB_TOKEN }}` droplet'e SSH uzerinden gonderilip
`docker login` icin kullaniliyor. Bu token kisa omurlu (workflow scope) ve log'larda
masked, ancak SSH baglantisinin guvenligine bagimli.

**Oneri:** Droplet'te uzun omurlu bir GHCR read-only token kullanmayi degerlendir.

#### [MEDIUM] D17-CI-003: `latest` Tag Overwrite Stratejisi

Her deploy'da hem `${{ github.sha }}` hem `latest` tag pushlanmis. `latest` tag
overwrite edilmesi rollback'i zorlastirir. SHA-tagged image'ler mevcut ama
`docker-compose.droplet.yml` yalnizca `:latest` referanslari kullaniyor.

**Oneri:** Compose dosyasinda SHA-tagged image'leri kullan veya deploy sirasinda
`.env`'ye `TAG=${{ github.sha }}` yaz.

---

## 10. RESOURCE LIMITS OZETI

### 10.1 docker-compose.droplet.yml (Referans)

| Service              | Memory | CPU   | NODE_OPTIONS         |
|----------------------|--------|-------|----------------------|
| postgres             | 1536M  | 1.0   | --                   |
| redis                | 256M   | 0.25  | --                   |
| nats                 | 192M   | 0.25  | --                   |
| mosquitto            | 128M   | 0.15  | --                   |
| minio                | 256M   | 0.25  | --                   |
| gateway-api          | 512M   | 0.5   | --max-old-space=384  |
| auth-service         | 384M   | 0.5   | --max-old-space=256  |
| farm-service         | 384M   | 0.5   | --max-old-space=256  |
| sensor-service       | 512M   | 0.5   | --max-old-space=256  |
| admin-api            | 384M   | 0.5   | --max-old-space=256  |
| alert-engine         | 256M   | 0.25  | --max-old-space=256  |
| billing-service      | 256M   | 0.25  | --max-old-space=256  |
| hr-service           | 256M   | 0.25  | --max-old-space=256  |
| hydroponics-service  | 256M   | 0.25  | --max-old-space=256  |
| notification-service | 256M   | 0.25  | --max-old-space=256  |
| observability        | 256M   | 0.25  | --max-old-space=256  |
| config-service       | 256M   | 0.25  | --max-old-space=256  |
| nginx                | 64M    | --    | --                   |
| MFE'ler (x8)        | 64M ea | --    | --                   |

**Toplam:** ~6.5GB (8GB droplet icin uygun)

`NODE_OPTIONS --max-old-space-size` ile Node.js heap limiti Docker memory limitinin
altinda tutulmus -- OOM kill yerine graceful hata almak icin iyi pratik.

---

## 11. ONCELIKLI AKSIYONLAR

### CRITICAL (Hemen)

| ID           | Aksiyon                                                    | Etki            |
|--------------|------------------------------------------------------------|-----------------|
| D17-SEC-001  | .env.production.example'daki gercek credential'lari temizle | Credential leak |
| D17-SEC-001  | Tum production credential'lari rotate et                   | Credential leak |
| D17-SEC-002  | 00-trust-auth.sh'yi production mount'dan kaldir            | DB erisim       |

### HIGH (Bu sprint)

| ID           | Aksiyon                                                    | Etki            |
|--------------|------------------------------------------------------------|-----------------|
| D17-DC-001   | docker-compose.prod.yml'e resource limits ekle             | OOM riski       |
| D17-DC-002   | Production'da DATABASE_SYNC: "false" yap                   | Veri kaybi      |
| D17-SEC-003  | Init script'teki hardcoded sifreleri cikart veya blogu sil | Credential leak |
| D17-INIT-001 | Production compose'dan init-scripts mount'unu kaldir       | Trust auth      |

### MEDIUM (Sonraki sprint)

| ID           | Aksiyon                                                    | Etki            |
|--------------|------------------------------------------------------------|-----------------|
| D17-DF-001   | Tum nginx Dockerfile'lara non-root user ekle               | Container sec   |
| D17-DC-003   | Compose dosyalari arasinda tutarsizliklari gider           | Ops guvenilirlik|
| D17-DC-004   | MFE service'lerine health check ekle (prod)                | Monitoring      |
| D17-VOL-001  | Backup stratejisi olustur ve dokumante et                  | Data recovery   |
| D17-SEC-004  | Per-service DB kullanicilarina gecis planla                 | Least privilege |
| D17-CI-002   | Droplet GHCR auth yontemini gozden gecir                   | Token exposure  |
| D17-CI-003   | SHA-based image tag'leri compose'da kullan                  | Rollback        |

### LOW (Backlog)

| ID           | Aksiyon                                                    | Etki            |
|--------------|------------------------------------------------------------|-----------------|
| D17-DF-005   | Base image'leri belirli versiyona pinle                     | Reproducibility |
| D17-NET-002  | Dev compose'da portlari localhost'a bind et                 | LAN exposure    |
| D17-NGX-002  | SSL cipher suite'i gozden gecir                            | TLS guvenlik    |

---

## 12. OLUMLU BULGULAR

Audit sirasinda tespit edilen iyi muhendislik pratikleri:

1. **dumb-init kullanimi** -- Tum backend Dockerfile'larda PID 1 sorununu cozen dumb-init
   mevcut. Graceful shutdown dogru calisiyor.

2. **BuildKit cache mount** -- npm install icin cache mount kullanimi build surelerini
   kisaltiyor (`--mount=type=cache,target=/root/.npm,sharing=shared`).

3. **Dual-network architecture** -- `aqua-internal` (internal: true) ile backend servisler
   disaridan tamamen izole edilmis.

4. **read_only containers** -- MFE container'lari `read_only: true` + `tmpfs` ile
   calisiyor (droplet.yml).

5. **Zorunlu env var kontrolu** -- Production compose'da `${VAR:?message}` pattern'i
   ile eksik degisken kontolu.

6. **CI/CD SHA pinning** -- Tum GitHub Actions SHA ile pinlenmis, supply chain attack
   riski azaltilmis.

7. **Affected-only deployment** -- PERF-CI-001 ile yalnizca degisen servisler build
   edilip deploy ediliyor.

8. **Rollback mekanizmasi** -- Health check basarisizliginda otomatik rollback
   (ARCH-CI-007).

9. **.dockerignore kapsamli** -- 1.34GB simulator data, node_modules, test dosyalari,
   .env dosyalari exclude edilmis.

10. **Health check tutarliligi** -- Backend servislerde `/health/live` endpoint'i,
    nginx'te `/health` endpoint'i tutarli kullanilmis.

---

*Rapor sonu. Toplam bulgu: 4 CRITICAL/HIGH, 8 MEDIUM, 7 LOW/INFO.*
