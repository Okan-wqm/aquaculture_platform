# Send-idempotency DB ledger'ı (küme-8 / PR#354 DİLİM-1) (2026-06-12)

## DATA-HIGH-007 — Mesaj gönderim idempotency otoritesi fail-open Redis cache'iydi; partitioned tablo global UNIQUE taşıyamıyor

**Severity:** HIGH · **Owner:** messaging-expert · **Cycle:** 2026-06-10-round2

### Gözlem

`SendMessageHandler` idempotency'yi yalnız Redis SET NX ile sağlıyordu ve
`safeRedisSetNx/safeRedisGet/safeRedisSetEx` sarmalayıcıları Redis
hatalarını BİLEREK yutuyor (mesajlaşma Redis kesintisinde yazmayı
sürdürsün diye — fail-open cache tasarımı). Sonuç: Redis kesinti
penceresinde duplicate send mümkün. Kalıcı çare olan
`UNIQUE(tenantId, idempotencyKey)` ise `messages` tablosunda imkansız:
tablo `createdAt` üzerinden RANGE-partitioned ve PostgreSQL her unique
kısıtın partition anahtarını içermesini şart koşar (message.entity:76-85
dokümante ediyor).

Kaynak dal (fix/messaging-tenant-isolation-2026-05-28, PR#354) bu boşluğu
`MessageSendIdempotency` partition-DIŞI ledger'ıyla kapatmıştı — hüküm
tablosu DİLİM-1'i "EN DEĞERLİ port" işaretledi.

### Reimplement-port (bu PR)

1. **Entity:** `MessageSendIdempotency` — PK(tenantId, channelId,
   senderId, idempotencyKey) + messageId + messageCreatedAt;
   **`{ schema: 'messaging' }` EXPLICIT** (ADR-011 Wave 4-A.2 cross-tenant
   sınıfı, messaging_outbox emsali; tenant şemalarına klonlanmaz).
   messageCreatedAt denormalizasyonu duplicate-yolunda partition pruning
   sağlar.
2. **Migration:** `1800600000000-CreateMessageSendIdempotencyLedger` —
   `@SourceOnlyMigration`, `pinSearchPath`, PK inline (R11: bare ADD
   CONSTRAINT yok), IF NOT EXISTS idempotent.
3. **Handler:** otorite transaction İÇİNE taşındı — `INSERT ... ON
   CONFLICT DO NOTHING` (orIgnore + returning) claim'i; conflict'te ledger
   satırından orijinal mesaj (partition-pruned findOne) döner; claim'siz
   yol normal akış. Redis fast-path cache olarak kalır (semantik
   değişmedi). Eşzamanlılık: rakip transaction commit'e dek unique-index
   beklemesi → conflict eden okuma her zaman commit'li orijinali görür.
   Metrik yalnız gerçek yeni gönderimde artar; okunamaz-ledger/eksik-mesaj
   patolojileri ConflictException ile fail-loud.
4. **Testler (3 yeni, 15/15 yeşil):** conflict→orijinal döner (save/outbox/
   metric YOK); Redis tamamen ölüyken claim yine otorite; ledger satırı
   okunamazsa ConflictException.

### Tier sınıfı

Tier-1 (make it impossible): duplicate send artık Redis durumundan
bağımsız, aynı-transaction unique-claim ile yapısal imkansız.

### Kanıt

- apps/messaging-service/src/message/commands/send-message.handler.ts (claim bloğu + safe* fail-open sarmalayıcılar)
- apps/messaging-service/src/message/entities/message.entity.ts:76-85 (partition/UNIQUE kısıtı)
- Kaynak: origin'den silinmeden önce bundle'lanacak PR#354 dalı; hüküm: round2/verdict-table.md DİLİM-1
