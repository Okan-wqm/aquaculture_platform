# Mimosa Derin Güvenlik Taraması — 2/4: Doğrulanmış Aday Bulgular

**Tarih:** 2026-08-27 · Kaynak tarama: `scan-2026-08-27T11-31-42.404Z-8c8fad3c69f8` (künye: dosya 1)

Bu dosya, manuel kaynak-kod doğrulamasından geçen ve **düzeltme planına girmeyi
hak eden** adayları gerekçeleriyle listeler. Registry ID'leri henüz atanmamıştır;
plan kararı sonrası `finding-registry add` ile kaydedilecekler. Önerilen öncelik
sırası: C1 → C2 → C3.

---

## C1 — Gateway SSE proxy'sinde SSRF yüzeyi (HIGH aday)

- **Mimosa:** `finding:f8b809808991422dd4542664` (HIGH, SSRF, CWE-918) +
  iki MEDIUM cross-file taint (`finding:40d8577206f8d0859a851cfe`, satır 460/484)
- **Konum:** `apps/gateway-api/src/proxy/service-proxy.service.ts:419`
  (`fetch(targetUrl, …)` circuit-breaker içinde)
- **Mimosa iddiası:** Sunucu, kullanıcı kaynaklı URL'e doğrudan istek atıyor;
  iç ağ / bulut metaverisi / localhost erişimi mümkün olabilir.
- **Doğrulamam:** `targetUrl`, servis kayıt defterinden gelen `serviceName`'den
  türetiliyor ve istek yolu/query'si bu URL'e ekleniyor (satır 399:
  `query: new URL(targetUrl).search`). Ağ geçidi proxy'si **tasarım gereği**
  SSRF şeklinde bir yüzeydir; statik okumada URL şeması/host allowlist'i veya
  hedef normalizasyonu görülmedi.
- **Neden plana giriyor:** Tek gerçek HIGH adayı. Proxy yüzeyinde `serviceName →
baseURL` çözümlemesinin allowlist ile sınırlı olduğunu, yol birleştirmesinin
  (`path`/`query` enjeksiyonuyla `targetUrl`'in bozulamayacağını) ve redirect
  takibinin kapatıldığını doğrulamak gerekiyor. Bu, dosya 2'deki adayların en
  yüksek önceliğidir.
- **Plan doğrulama maddeleri:** (1) `targetUrl` bileşenlerinin kaynakları ve
  normalizasyonu; (2) servis kayıt defterinin dışarıdan genişletilebilirliği;
  (3) `fetch` redirect davranışı (`redirect: manual` mi?); (4) iç IP alanlarına
  (169.254.169.254, 127.0.0.1, RFC1918) erişimin tasarım gereği olmadığının testi.

## C2 — Provisioning uçlarında servis katmanı token doğrulaması (MEDIUM aday, 4 Mimosa bulgusu)

- **Mimosa:** `business:33b6fb883ae1a3e1bf22` (:68 `GET /install/:deviceCode`),
  `business:5943f1bb12bba4c0de31` (:145 `GET /install/:deviceCode/suderra-os`),
  `business:966c0fd0fe9cce83eea0` (:388 `GET /install/tenant`),
  `business:bb1ee5b15ccd4b304e68` (:445 `POST /api/devices/self-register`)
- **Konum:** `apps/sensor-service/src/edge-device/provisioning.controller.ts`
- **Mimosa iddiası:** Duyarlı uçlarda rol/izin denetimi gözlemlenmedi (Nest
  guard/decorator yok).
- **Doğrulamam:** Uçlar bilinçli olarak public (bootstrap/installer akışı) ve
  controller düzeyinde gerçek mitigasyonlar var: token **header**'dan okunuyor
  (URL'e sızma engeli, SENSOR-MEDIUM-002), device-code regex'i
  (`/^[A-Z]{2,5}-[0-9A-F]{8}$/`), token format regex'i (`/^[0-9a-f]{64}$/`),
  rate-limit (3–5 istek/dk). Mimosa'nın "guard yok" iddiası controller
  düzeyinde **çürütüldü**: yetkilendirme token'ın kendisi.
- **Neden plana giriyor:** Token'ın gerçek karşılaştırması servis katmanına
  bırakılmış (`generateInstallerScript(deviceCode, token)` :111,
  `generateTenantInstallerScript(tenantToken)` :409, `selfRegisterDevice(request)`
  :461). Bu karşılaştırmanın **constant-time** olduğu, **fail-closed** olduğu
  (geçersiz/hatalı uzunlukta token'ın istisna fırlattığı) ve token'ın
  loglanmadığı henüz doğrulanmadı. Ayrıca Mimosa proof-gap'lerinin işaret
  ettiği global guard'ların (`TenantGuard`, `RolesGuard`,
  `TenantPermissionGuard`) bu public uçlarda gerçekten devre dışı kalıp
  kalmadığı (bilinçli `@Public()` durumu) teyit edilmeli.
- **Plan doğrulama maddeleri:** (1) servis katmanı token karşılaştırmasının
  zarfı (timing, hata davranışı); (2) token rotasyonu/süresi politikası;
  (3) bu dört ucun `@Public()` envanterine açıkça yazılması.

## C3 — Cihaz durum ucu varlık bilgisi sızdırıyor (HIGH aday, bilinçli tasarım + kalıntı risk)

- **Mimosa:** `business:a4e1825eb1c8f9a705ea` (HIGH — istek parametresiyle
  kaynak konumlandırma, sahiplik/tenant bağı gözlemlenmedi)
- **Konum:** `apps/sensor-service/src/edge-device/provisioning.controller.ts:316`
  (`GET /api/devices/:deviceCode/status`)
- **Doğrulamam:** Uç bilinçli public (installer doğrulama akışı) ve yalnızca
  `{deviceCode, ready: boolean, status: READY|NOT_AVAILABLE}` döndürüyor — PII
  veya tenant verisi yok. Enumerasyon karşıtı üç katman mevcut: regex format
  zorlaması, 3 istek/dk rate-limit, 100 ms sabit minimum yanıt süresi (LOW-002
  timing koruması, :325–343).
- **Neden plana giriyor:** Kalıntı risk sıfır değil: geçerli bir device code'un
  **varlığını ve hazırlığını** doğrulama gerektirmeden ifşa ediyor. Regex
  uzayı (2–5 harf + 8 hex) büyük olsa da sızdırılan bilgi bir oracle.
  Riski kapatmak için status yanıtının da (installer'daki gibi) bir token
  ölçüsüyle bağlanması değerlendirilebilir — ya da bilinçli-kabul kaydı
  (Tier 4: dokümante edilmiş tasarım kararı) yazılmalı.
- **Plan doğrulama maddeleri:** (1) readiness bilgisinin saldırgan değeri
  değerlendirmesi; (2) token gerekliliği maliyet/kararı; (3) mevcut korumaların
  (rate-limit + timing) etkinlik testi.

---

## Kapsam dışı bırakılanlar ve gerekçeleri

- **`scripts/deploy/*` komut-enjeksiyonu desenleri (15 bulgu):** Operatör/CI
  bağlamında çalışıyor; istismar modeli içeriden tehdit. Plan triage listesinde
  düşük öncelik olarak işaretlendi (dosya 4), bu dosyada aday olarak açılmadı.
- **`db-migrate` env-kaynaklı SQL bulguları:** Manuel doğrulamada parametreli
  sorgular çıktı — dosya 3'te FP-9 olarak çürütüldü.
- **`web/shell/src/pages/SettingsPage.tsx` (3 MEDIUM):** Kaynak kodda
  doğrulanmadı; denetlenmemişler listesinde (dosya 4).

## 2026-08-23 taramasıyla kesişim

- SEC-MEDIUM-070 (sensor-service TRUST_PROXY eksikliği) C2/C3 ile aynı ucu
  etkiliyor: nginx arkasında rate-limit kovaları paylaşımlı IP üzerine
  düşüyorsa enumeration koruması zayıflar. Plan, C3'ü SEC-MEDIUM-070 ile
  birlikte ele almalı.
- SEC-MEDIUM-061 (SCADA WS Origin) bu taramanın `sens-api-gateway` FP'lerinden
  bağımsızdır; Rust tarafındaki gerçek bulgu envanteri 2026-08-23 dosyasındadır.
