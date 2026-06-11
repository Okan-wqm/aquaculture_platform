# Compliance şeması bootstrap SSOT'a katılıyor (2026-06-11)

## INFRA-HIGH-015 — compliance şeması 003'te yaratılıp HİÇBİR aşamada yetkilendirilmiyordu; production seremoni grant'leriyle ayakta

**Severity:** HIGH · **Owner:** data-expert · **Cycle:** 2026-06-11-production-opening

### Gözlem

`compliance` cross-service bir şema: platform-geneli legal-hold kayıt
defterini taşıyor (`compliance.legal_holds` — entity
libs/backend-common/src/compliance/legal-hold/legal-hold.entity.ts; DDL
sahibi admin-api migration zinciri 1787500000000-CreateComplianceLegalHolds;
tüketiciler bugün messaging + observability + admin). Stage 003 şemayı
yaratıyor ve varlığını doğruluyor; ancak 004'te grant'i, 008'de sahiplik /
least-privilege muamelesi YOKTU. 2026-06-11 production açılışında admin-api
boot drift validator'ı fatal verdi; USAGE+DML elle (seremoni) verildi —
sahipsiz grant sınıfının son örneği.

(messaging.legal_holds AYRI bir messaging-domain tablosudur — çift-yazar
çatışması yok; isim benzerliği not edildi.)

### Düzeltme (bu PR)

`shared` şemasıyla birebir aynı disiplin:
1. **004:** 14 servis rolüne USAGE + tables/sequences ALTER DEFAULT
   PRIVILEGES (gerekçeli başlık bloğuyla).
2. **008 kuyruğu:** `compliance_schema_owner` NOLOGIN + db_migrate üyeliği +
   `ALTER SCHEMA ... OWNER` + ilişki re-own döngüleri (tablolar + pg_depend
   'a'/'i' dışlamalı serbest sequence'lar — legal_holds migration
   bağlantısının rolünde kalmasın) + PUBLIC revoke seti (tablolar,
   sequence'lar, default-priv'ler). FOREACH servis döngüsü shared'in
   compliance ikizlerini kazandı (USAGE + ALL TABLES DML + sequences +
   default-priv).
3. **Entegrasyon spec'i:** compliance şema sahibi assertion'ı + probe
   tablo zinciri (owner yaratır → messaging_service INSERT, admin_service
   SELECT default-priv kanıtı → messaging_service DDL reddi).

### Tier sınıfı

Tier-2 (make it automatic): her bootstrap koşusu yetki modelini kendisi
kurar; elle grant ihtiyacı sınıf olarak kalkar. ORPHAN-HIGH-088'in
compliance dilimi böylece kapanır (kalan dilim: tenant-şema runtime DML
SSOT'u — provisioner yapısal PR'ında).

### Kanıt

- apps/db-migrate/src/sql/platform-bootstrap/003-schemas.sql:77 (varlık)
- 004/008 önceki halinde 'compliance' geçmiyor (grep boş)
- Ledger 2026-06-11: admin-api drift fatal + elle USAGE+DML seremonisi
