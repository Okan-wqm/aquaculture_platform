# Kanal admission boşluğu + tenant-üyelik doğrulama kontratı (küme-8 DİLİM-2)

## SEC-HIGH-009 — Messaging kanal admission yolları cross-tenant userId enjeksiyonuna açıktı

**Severity:** HIGH · **Owner:** auth-security-expert · **Cycle:** 2026-06-10-round2

### Gözlem

ChannelMember insert eden üç yol, eklenen `userId`'nin çağıran tenant'a ait
olduğunu HİÇ doğrulamıyordu (auth-security-expert tasarım incelemesi,
file:line teyitli):

- `create-channel.handler.ts` GROUP/AI yolu — açık itiraf `// TODO Phase 2:
  Validate all memberIds belong to same tenant` + denetimsiz insert.
- `add-member.handler.ts` — `targetUserId` yalnız kanal-rol hiyerarşisiyle
  denetleniyordu; tenant üyeliği değil. ADMIN/OWNER, tenant'ında olmayan
  bir userId'yi member yapabilirdi.
- `create-channel.handler.ts` DIRECT yolu + `channel.resolver.directChannel`
  — arbitrary peer userId; `IsUUID('4')` yalnız FORMAT doğruluyor, üyelik
  değil.

Saldırgan kendi tenant çağrı bağlamından çıkamasa da (tenantId entity'ye
sabit), yetkisiz cross-tenant userId'yi bir tenant'ın kanal grafiğine
yazmak A01:2025 (Broken Access Control). PII federation prod'a açıldığında
CRITICAL'e yükselir (placeholder bugün veriyi sızdırmıyor).

### Çözüm (bu PR — auth-security-expert CONDITIONAL-APPROVE'un 7 şartıyla)

**Mimari karar:** NATS request/reply (HMAC HTTP RED — mükerrer+zayıf;
emsaller: `AdminCheckUserLimitQuery`, `request.messaging.verifyMembership`).

1. **Kontrat** `libs/event-contracts/src/auth-user-queries.ts`:
   `AUTH_USER_QUERY_SUBJECTS.VALIDATE_TENANT_MEMBERSHIP =
   'request.auth.user.validateTenantMembership'`,
   `ValidateTenantMembershipQuery/Result` — PII YOK (yalnız üyelik durumu).
2. **AJV şeması** `schemas/auth-user-queries.schema.ts` — `additionalProperties:
   false` her iki tarafta (PII alanı eklenemez kilidi + smuggling engeli),
   userIds `maxItems: 200`, UUID formatları. Handler payload'u işlemeden
   ÖNCE valide ediyor (trust boundary).
3. **Auth handler** — tenant-scoped sorgu (`where: { tenantId }` → cross-tenant
   userId platform-varlığı sızdırmadan `invalidUserIds`'e); `requireActive`
   semantiği kilitli (true → inaktif `inactiveUserIds` + `allValid:false`);
   reddedilen doğrulama `recordAwait()` ile awaited audit.
4. **Admission service** (messaging) — **FAIL-CLOSED**: NATS timeout/hata/
   `success:false`/`!allValid` → admission RED (ServiceUnavailable/Forbidden).
   `POLICY_FAIL_OPEN=false` prensibinin admission karşılığı.
5. **NATS ACL** (ADR-015 seremonisi tek commit'te): messaging_service publish'ine
   YALNIZ yeni subject (broad `request.auth.>` publish YOK); auth subscribe'a
   audit-görünür explicit satır; `generate-nats-conf.py` yeniden üretti
   (idempotent: ikinci koşu "no change").
6. **Testler:** auth handler 5 (boundary-red, tenant-scope, requireActive
   ×2, subject); admission 6 (success, forbidden, fail-closed ×2, local-red,
   empty).

### Tier sınıfı

Tier-1 (make it impossible): üç admission yolu da auth-doğrulamasından
geçmeden ChannelMember yazamaz; fail-closed + AJV trust-boundary + ACL
least-privilege.

### Ripple (handoff)

multi-tenant-saas-expert (admission lifecycle), mcp-expert (AI-channel
aiServiceUrl), observability (ACL+audit fan-out). DİLİM-2 kapanışıyla
PR#354 dalının port'lanacak içeriği tükendi → dal seremoniyle silinir.

### Kanıt

- `apps/messaging-service/src/channel/commands/create-channel.handler.ts` (GROUP + DIRECT gate)
- `apps/messaging-service/src/channel/commands/add-member.handler.ts` (targetUserId gate)
- `apps/auth-service/src/modules/tenant/handlers/auth-user-query-nats.handler.ts`
- `infrastructure/nats/services.yaml` + `infrastructure/docker/nats/nats.conf` (GENERATED)
