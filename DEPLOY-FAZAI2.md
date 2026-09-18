# FARM-AI FAZ 2 — Canlı Deploy Runbook (taslak)

Tarih: 2026-09-18 · Dal: `messaging-fix-1` · Worktree: `/var/aqua-messaging-fix`
Kapsam: FAZ 1 + FAZ 2 (persona kontrat/kompozisyon + 3 farm uzmanı ~40 sorgu aracı + ACL)
Önkoşul: PR-4+5 commit'i (bu runbook PR-4/5 indirildiğinde finalleşir)

---

## 0. Deploy edilecek değişiklik yüzeyi

| Bileşen | Değişiklik | Aksiyon |
|---|---|---|
| aqua-nats | services.yaml'a 40 açık subject (farm sub + ai pub) + JS.ACK/resolveCaller SSoT zaten canlıda | nats.conf swap + restart (probe referansını da `--update-reference` ile yenile) |
| ai-service | persona kompozisyonu, narrator, ephemeral, 40+13 araç, migration 1803200000000 (routineAiEnabled + conversation_turns kolonları) | imaj build + recreate; migration boot'ta per-şema koşar |
| farm-service | 13+27 ai-query responder'ı, SENSOR_AUTOMATIC guard, modül kayıtları | imaj build + recreate |
| messaging-service | @IsKnownAiPersonaId validator, registry katalog geçişi, bridge serviceId | imaj build + recreate |
| auth-service | permission-catalogue all-of + seed roller (kod); backfill admin-api'de | imaj build + recreate (backfill auth şemasında, admin-api migrate eder) |
| admin-api-service | migration 1808300000000 (ai_specialties backfill) | imaj build + recreate |
| gateway-api | serviceId: 'gateway_api' eklemesi | imaj build + recreate |
| web (5 MFE) | PR-6'ya kadar DEĞİŞMEDİ — bu deploy'da web yok | — |

## 1. Build (aqua-saas bağlamından — checkout'tan DEĞİİL)

> Tuzak (SCADA deneyiminden): deploy checkout'un eski package-lock'u yeni dist ile uyumsuz.
> İmajlar /var/aqua-saas bağlamından, worktree kodu oraya senkron edilerek build edilir.

```bash
# 1) Worktree commit'ini ana ağaç dalına aktar (bare repo üzerinden):
#    git --git-dir=/var/aqua-saas fetch + worktree güncelle — messaging-fix-1 commit'i
# 2) Build (her servis için):
COMPOSE_PROJECT_NAME=aqua-saas TAG=fazai-2 docker compose -f infrastructure/docker/docker-compose.yml build ai-service farm-service messaging-service auth-service admin-api-service gateway-api
# 3) Recreate:
COMPOSE_PROJECT_NAME=aqua-saas TAG=fazai-2 docker compose ... up -d ai-service farm-service messaging-service auth-service admin-api-service gateway-api
```

## 2. NATS

```bash
# nats.conf (SSoT regen zaten commit'te) → canlı mount noktasına kopyala + restart
cp infrastructure/docker/nats/nats.conf /var/lib/aqua/local-runtime/<tag>/infrastructure/docker/nats/nats.conf
docker restart aqua-nats
# referansı yeniden sabitle (probe sessiz kalması için):
/var/lib/aqua/local-runtime/acl-drift-probe.py --update-reference
/var/lib/aqua/local-runtime/acl-drift-probe.py   # → clean
```

## 3. Doğrulama kapıları (hepsi geçmeden TAMAM DENMEZ)

1. **Boot**: 6 servis healthy; ai-service log'unda `Persona catalogue composed: 13 entries + narrator-v1`
2. **Migration**: conversation_turns'ta correlationId/servicePrincipal kolonları + tenant_agent_configs.routineAiEnabled (db-migrate log)
3. **Backfill**: auth.tenant_role_permissions'ta 5 default role'de `ai_specialties:farm` (SQL ile say)
4. **ACL**: NATS log'unda 0 violation; varz/connz'da farm+ai bağlı
5. **Chat E2E**: mevcut AI kanalına mesaj → yanıt (persona operator-v1; metadata.persona = çözülen id)
6. **Farm sorgu E2E**: kanala `operator-farm-water-health-v1` persona'lı mesaj → araç çağrısı (ör.
   get_tank_water_quality_stats) → gerçek veri dönen yanıt
7. **Yetki matrisi**: farm personası `ai_specialties:farm`'sız kullanıcıya FORBIDDEN (403/ai:error)
8. **Gece probu**: 03:00 cron'u ertesi gün clean (acl-drift-probe.log)

## 4. Geri alma

- İmajlar: önceki TAG'e `up -d` (rollback: fazai-0.1 / 9b44390f taban görüntüleri duruyor)
- NATS: referans nats.conf öncesi yedek `/tmp/nats.conf.pre-fazai02.bak` + probe referansı geri sabitlenir
- Migration geri alma YOK (additive kolonlar + backfill — down gerekmiyor; kolonlar boş kalabilir)

## 5. Bilinen riskler

- ai-service boot invariant'ları HALTED boot'a dönüşür (kayıt dışı tool adı) → bundle adları
  commit'te grep'le doğrulandı (24/24 kayıtlı, PR-4/5 sonrası tekrar doğrulanacak)
- Eski client'lar (web) persona listesinde 13 girişi gösterir ama eski AI_PERSONA_NAMES ile
  ad çözümlemesi yapabilir → zararsız (ad düşerse ham id görünür)
- Faz 5 okuyucusu yokken routineAiEnabled=false — davranış değişikliği yok
