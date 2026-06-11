# Deploy bootstrap ordering + identity family review (2026-06-11)

Reviewer: infra-expert (Round-2 Adım-0 — deploy zinciri ikinci tur kırmızısı)
Scope: `scripts/deploy/droplet-up.sh`, `scripts/deploy/lib/required-env-secrets.sh`

## INFRA-HIGH-007 — Bootstrap (A4) interpolasyondan (A2) SONRA koşuyor: generate-if-absent ölü kod; compose'un map-iterasyonu eksik seti maskeliyor

**Severity:** HIGH (production deploy bloke — #388'in üreticisi deploy yolunda hiç çalışamadı)

**Gözlem:** main@4473d2fc7 deploy'u `SERVICE_IDENTITY_SIGNING_KID` eksiğiyle öldü; bir önceki tur
`SERVICE_IDENTITY_KEYRING` demişti. İki gerçek:
1. **Sıralama hatası:** droplet-up.sh'ta required-secrets bootstrap'ı Phase A4'teydi — compose
   interpolasyon kontrolü (A2) ondan ÖNCE koşup eksik değişkende abort ediyordu. #388'in keyring
   üreticisi deploy yolunda ölü koddu (yalnız elle bootstrap çağrısında çalışırdı).
2. **Maskeleme:** compose'un env-map iterasyonu koşudan koşuya FARKLI "ilk eksik" raporluyor
   (Go map sırası) — seri deploy'lar her seferinde başka isim gösterip tam eksik seti gizledi.
   Ampirik enumerasyon (override zinciri, gerçek .env'e karşı): eksik set tam olarak
   {SERVICE_IDENTITY_KEYRING, SERVICE_IDENTITY_SIGNING_KID, CONFIG_ENCRYPTION_KEY}.

**Fix:**
- Bootstrap bloğu Phase A2a olarak interpolasyonun ÖNÜNE taşındı (üretici, tüketen kontrolden önce).
- `SERVICE_IDENTITY_SIGNING_KID` üreticisi eklendi — bağımsız sır DEĞİL: signed-http-client anahtarı
  keyring'den bu kid ile seçer; üretici değeri .env'deki keyring'in ilk kid'inden TÜRETİR
  (dizi sırası keyring'i önce garanti eder; keyring yoksa fail-closed).
- `CONFIG_ENCRYPTION_KEY` eklendi (config-service AES master key — production'da fail-closed).

**Ampirik doğrulama:** ENV_FILE override'lı bootstrap: 3 değişken üretildi, kid==keyring.kid
tutarlılığı ✓, ikinci koşu idempotent ✓; gerçek .env + 3 override ile compose interpolasyonu
TEMİZ (eksik setin tamlık kanıtı); üç script bash -n ✓.

**Not:** INFRA-MEDIUM-004 (compose `:?` ↔ bootstrap SSOT parite invariant'ı) bu insidan sınıfının
kalıcı kapanışı olarak küme-7 portunda — bu PR semptom ailesini ve sıralama kökünü kapatır,
invariant gelecek eklemeleri yakalar.
