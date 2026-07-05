# Sensör / VFD / Cihaz Ekleme — Uçtan Uca Audit

- **Tarih:** 2026-07-05
- **Kapsam:** `/sensor/devices` sayfasındaki "Cihaz Ekle" akışları (Sensör kayıt sihirbazı, VFD kayıt sihirbazı, Edge Controller provisioning sihirbazı) — frontend `web/modules/sensor-module/**` + backend `apps/sensor-service/{registration,sensor,vfd,vfd-programming,edge-device,device-group}/**`.
- **Yöntem:** 7 paralel uzman denetim ajanı (sensor-expert, form-write, tenant-isolation, access-boundary, list-visibility, security-reviewer, contract-parity). Aşağıdaki bulguların tümü gerçek satır numaralarına karşı okunarak üretildi; kritik olanlar ayrıca doğrulandı.
- **Karar: BLOCK** — 2 CRITICAL + 12 HIGH. Bu akış üretim için hazır değil.

Bulgu ID formatı `{şiddet}-{sıra}` (CLAUDE.md Review Finding Traceability). Her düzeltme commit'i ilgili ID'yi `Closes:` ile referanslamalı.

---

## Özet tablo

| ID | Şiddet | Alan | Tek cümlelik kusur |
|---|---|---|---|
| SVD-CRIT-001 | CRITICAL | Güvenlik | HTTP-REST sensör adaptörü operatör kontrollü URL'i doğrulamadan `fetch` ediyor → SSRF ile cloud metadata kimlik hırsızlığı |
| SVD-CRIT-002 | CRITICAL | Ürün | VFD sekmesi VFD verisi çekmiyor; kayıtlı VFD'ler hiçbir liste/detayda görünmüyor, sekme sensör listesini gösteriyor |
| SVD-HIGH-001 | HIGH | Güvenlik | VFD Modbus `host` alanı doğrulanmıyor → iç ağ port-taraması / SSRF |
| SVD-HIGH-002 | HIGH | Veri | `dataChannels` sensör kaydında sessizce atılıyor (servis hiç persist etmiyor) |
| SVD-HIGH-003 | HIGH | ICS | VFD Modbus-TCP bağlantısı TLS'siz ve circuit breaker'sız |
| SVD-HIGH-004 | HIGH | Doğrulama | VFD protokol config gevşek union DTO ile doğrulanıyor → aralık dışı baud/slaveId/IP persist ediliyor |
| SVD-HIGH-005 | HIGH | Tenant | `registrationResolver` `'default-tenant'` fail-open fallback + eksik `TenantGuard` |
| SVD-HIGH-006 | HIGH | Erişim | `@RequireTenantPermission('edge:manage-io-config')` hiçbir guard'la uygulanmıyor (ölü metadata) |
| SVD-HIGH-007 | HIGH | Ürün | `mapSensorToType` parent/child + site/departman alanlarını düşürüyor → grup görünümü + detay geri-okuma bozuk |
| SVD-HIGH-008 | HIGH | Veri | Sensör sihirbazı "zorunlu" konum hiyerarşisini (siteId/departmentId) serialize etmiyor |
| SVD-HIGH-009 | HIGH | Veri | Parent+children servis create'i `description` alanını düşürüyor |
| SVD-HIGH-010 | HIGH | Veri | VFD sihirbazı `modelSeries/pumpId/notes/tags` alanlarını düşürüyor (entity kolonu yok) |
| SVD-HIGH-011 | HIGH | Tenant | `tenant_provisioning_keys` per-tenant şemada ama public path'ten aranıyor → self-register akışı kopuk/güvensiz |
| SVD-HIGH-012 | HIGH | Kontrat | Enum drift: FE `SensorType` (PRESSURE/CAMERA/OTHER) ve `VfdChangeSetStatus` (PARTIALLY_APPLIED vs VERIFIED) backend ile uyumsuz |
| SVD-MED-001..010 | MEDIUM | Karışık | Bkz. aşağıda |
| SVD-LOW-001..008 | LOW | Karışık | Bkz. aşağıda |

---

## CRITICAL

### SVD-CRIT-001 — HTTP-REST sensör adaptöründe kısıtlanmamış SSRF (metadata kimlik hırsızlığı)
**Dosya:** `apps/sensor-service/src/protocol/adapters/iot/http-rest.adapter.ts:180-247` (OAuth2 token fetch `:284-320`); erişim yolu `registration/resolvers/registration.resolver.ts` → `sensor-registration.service.ts:220` (`registerSensor` / `testSensorConnection`).

Adaptör `new URL(config.endpoint, config.baseUrl)` ile tamamen operatör kontrollü `protocolConfiguration`'dan URL kuruyor ve `fetch(url.toString())` ile çağırıyor; yanıt gövdesi çağırana `sampleData` olarak dönüyor. **Protokol allowlist yok, IP/host bloklama yok, DNS-pin yok, redirect kontrolü yok.** Circuit breaker (satır 216) yalnızca erişilebilirlik içindir, güvenlik kontrolü değildir — doğrulama koymuyor.

**Exploit:** `TENANT_ADMIN`/`MODULE_MANAGER` bir `HTTP_REST` sensörünü `baseUrl=http://169.254.169.254`, `endpoint=/latest/meta-data/iam/security-credentials/<role>` ile kaydeder, `testSensorConnection` çağırır. Cloud VM'de IMDSv1 varsa AWS/Azure/GCP kimlik bilgileri sunucu tarafında çekilip `sampleData` içinde geri yansıtılır → tam cloud hesabı ele geçirme. Aynı primitif herhangi bir iç HTTP servisini (`http://localhost:3010/...`) okuyabilir.

**Kök-neden düzeltme:** Her fetch öncesi host çözülüp private/loopback/link-local/ULA/cloud-metadata aralıkları (169.254.0.0/16, 100.100.200.200, 168.63.129.16, fd00:ec2::254) reddedilmeli; `https?`-only protokol allowlist; çözülen IP bağlantı boyunca pinlenmeli (DNS-rebinding engeli); redirect `manual`. Merkezi bir `SafeHttpClient` yazıp tüm adaptör fetch'leri oradan geçirilmeli. IMDSv2 altyapı katmanında zorunlu kılınmalı.

### SVD-CRIT-002 — Kayıtlı VFD cihazları görünmez; "VFD" sekmesi sensör verisi gösteriyor
**Dosya:** `web/modules/sensor-module/src/pages/DevicesPage.tsx:435` (yalnızca `useSensorList()` + `useEdgeDevices()`, hiç VFD hook'u yok), `:1050` (`activeTab === 'vfd'` sensör `filteredDevices` render ediyor), `:569-572` (`handleVfdWizardSuccess` sensör listesini refetch ediyor), `Module.tsx:92-95` (VFD liste/detay route'u yok). Backend'de VFD ayrı store: `vfd/resolvers/vfd-device.resolver.ts:52` (`vfdDevices`) bu sayfadan hiç çağrılmıyor.

**Senaryo:** Operatör VFD sihirbazını tamamlar, `registerVfdDevice` başarılı olur ("registered successfully"). "VFD Cihazları" sekmesine geçer — kayıtlı sürücü yerine tenant'ın **sensörlerini** görür (veya boş durum). VFD hiçbir listede görünmez, detay sayfası yoktur (`/sensor/devices/:id` onu sensör olarak sorgular → null → "Sensör yüklenemedi"), ve sekme sensör satırlarını VFD etiketi altında göstererek aktif olarak yanıltıcıdır.

**Kök-neden düzeltme:** VFD sekmesini `useVfdDevices`/`useVfdStats`'a bağla (edge sekmesini aynala: server-side filter/search/pagination + `createTenantQueryKey`), VFD detay route'u ekle (`vfdDevice(id)`), `handleVfdWizardSuccess`'i sensör değil VFD listesini invalidate edecek şekilde düzelt.

---

## HIGH

### SVD-HIGH-001 — VFD Modbus `host` alanı üzerinden SSRF / iç port-taraması
**Dosya:** `apps/sensor-service/src/vfd/adapters/vfd-modbus-tcp.adapter.ts:566-595` (`openSocket`), DTO `vfd/dto/protocol-config.dto.ts:75-92` (`host` çıplak `@IsString()`); erişim `vfd/resolvers/vfd-device.resolver.ts:113` (`registerVfdDevice` oto bağlantı-testi) ve `:186` (`testVfdConnection`). Aynı desen `protocol/adapters/serial/{tcp-socket,udp-socket}.adapter.ts` ve `iot/websocket.adapter.ts`'de.

`host` herhangi bir IP/`localhost`/link-local kabul ediyor; adaptör ham `net.Socket` açıyor ve `testConnection` başarı/latency/`error` dönüyor. Farklı hata metinleri (`Connection timeout` vs `ECONNREFUSED` vs `Modbus exception`) kör→yarı-kör oracle oluşturuyor. Authenticated tenant admin `host=10.0.0.5`/`127.0.0.1`/`169.254.169.254` ile portları tarayabilir.

**Kök-neden düzeltme:** SVD-CRIT-001 ile aynı IP/host allow/deny politikasını `openSocket`'e (ve tüm serial/IoT socket adaptörlerine) uygula; ideal olarak endpoint'leri tenant'ın bildirdiği edge-gateway alt-ağıyla sınırla; istemciye dönen hata mesajlarını tek "connection failed"e normalize et.

### SVD-HIGH-002 — Sensör kaydında `dataChannels` sessizce atılıyor
**Dosya:** `apps/sensor-service/src/registration/dto/register-sensor.dto.ts:119-124` (`RegisterSensorInput.dataChannels` tanımlı+doğrulanıyor), ama `services/sensor-registration.service.ts:58-186` (`registerSensor`) yalnızca `Sensor` satırı oluşturuyor, `ChannelManagementService`'i inject bile etmiyor (constructor `:45-53`). `createChannelsForSensor` (`channel-management.service.ts:330`) repo genelinde sıfır çağrılı (grep ile doğrulandı).

**Senaryo:** Operatör sihirbazda kanal tanımlar, `registerSensor` `success:true` döner, kanallar buharlaşır. Sensör kanalsız oluşturulur, hata yüzeye çıkmaz.

**Kök-neden düzeltme:** `ChannelManagementService`'i `SensorRegistrationService`'e inject et ve sensörü kaydeden **aynı transaction içinde** `createChannelsForSensor(savedSensor.id, tenantId, input.dataChannels)` çağır; ya da tek kanal yolu kastediliyorsa alanı DTO'dan kaldır (ölü kontratı imkânsız kıl — Tier 1).

### SVD-HIGH-003 — VFD Modbus-TCP: transport şifrelemesi ve circuit breaker yok
**Dosya:** `apps/sensor-service/src/vfd/adapters/vfd-modbus-tcp.adapter.ts:59-106,302-374,566-595`. Ham `net.Socket` ile control word / speed reference yazılıyor; `ModbusTcpConfigDto` (`dto/protocol-config.dto.ts:74-112`) ve entity config'te TLS alanı yok; link etrafında breaker yok.

**Senaryo:** Pompa/havalandırıcı süren bir VFD routed OT ağında; segmentteki herhangi bir host doğrulanmamış FC06 register yazıları (frekans, control word) üretebilir. Takılı socket yazma yolunu askıya alır (yük atacak breaker yok).

**Kök-neden düzeltme:** TLS-tünelli transport seçeneği ekle (veya IEC 62443 FR5 segmentasyonunu telafi kontrolü olarak zorla+belgele) ve Modbus link'ini paylaşılan circuit breaker'a sar. Wire-protokol tarafı `edge-expert`'e (ADR-003).

### SVD-HIGH-004 — VFD protokol config gevşek union DTO ile doğrulanıyor
**Dosya:** `apps/sensor-service/src/vfd/dto/register-vfd.dto.ts:58-62` (`protocolConfiguration: ProtocolConfigurationDto`), `dto/protocol-config.dto.ts:303-473` (her alan `@IsOptional`, neredeyse hiç `Min`/`Max`/`@IsEnum`/`@IsIP` yok). Aralık taşıyan katı per-protokol DTO'lar (`ModbusRtuConfigDto` vb.) register input'unda hiç kullanılmıyor. Servis `validateProtocolConfiguration` (`vfd-device.service.ts:421-478`) yalnızca alan varlığını kontrol ediyor.

**Senaryo:** `slaveId:9999`, aralık dışı `baudRate`, `parity:"xyz"`, `host:"not-an-ip"` GraphQL doğrulamasından geçip persist ediliyor; kötü değer yalnızca adaptör/cihaz katmanında patlıyor.

**Kök-neden düzeltme:** Düz union input'u ayrımlı (discriminated) per-protokol input'la değiştir veya `protocol`'e göre eşleşen katı DTO'nun `class-validator` şemasını sunucu tarafında çalıştır.

### SVD-HIGH-005 — `registrationResolver`'da `'default-tenant'` fail-open fallback + eksik `TenantGuard`
**Dosya:** `apps/sensor-service/src/registration/resolvers/registration.resolver.ts:72,113,175,282,324` (`tenantId || 'default-tenant'`). `VfdDeviceResolver` (`vfd-device.resolver.ts:27`) `@UseGuards(TenantGuard)` taşırken `RegistrationResolver`'da sınıf düzeyi `TenantGuard` yok. (Satır 72 ve 113 bizzat okunarak doğrulandı.)

**Senaryo:** Tenant bağlamı yoksa (guard yanlış yapılandırma, iç çağrı, header sıyrılması) sensörler paylaşımlı sentetik `'default-tenant'` kovasına yazılır/listelenir — fail-closed yerine tenant karışması.

**Kök-neden düzeltme:** Fallback'i kaldır, tenantId'yi JWT trust anchor'dan al ve yoksa fırlat (fail-closed); sınıf düzeyinde `@UseGuards(TenantGuard)` ekle.

### SVD-HIGH-006 — `@RequireTenantPermission('edge:manage-io-config')` hiçbir guard'la uygulanmıyor
**Dosya:** `apps/sensor-service/src/edge-device/edge-device.resolver.ts:342,356,371,386,458` (I/O config mutation'ları). Bu dekoratör yalnızca `TenantPermissionGuard` aktifken etki eder; ama o guard `app.module.ts:445-483`'te `APP_GUARD` olarak kayıtlı **değil** ve resolver/module'de `@UseGuards` ile de uygulanmıyor (grep ile doğrulandı). Guard'ın kendi dokümanı bile "APP_GUARD olarak kaydetme, per-controller `@UseGuards` ile bağla" diyor (`tenant-permission.guard.ts:44`) — o adım hiç yapılmamış.

**Senaryo:** `edge:manage-io-config` izni **olmayan** bir `MODULE_MANAGER` bile fiziksel I/O kanal eşlemelerini ekleyip/değiştirip `pushIoConfigToDevice` (canlı endüstriyel donanıma MQTT `update_io_config` gönderir) çağırabilir. İnce-taneli kontrol sessiz no-op; en zayıf katman (rol gate'i) kazanıyor.

**Kök-neden düzeltme:** Dekoratörleri silmek yerine `TenantPermissionGuard`'ı zincire bağla — tercihen `RolesGuard`'dan sonra dördüncü global `APP_GUARD` (dekoratör opt-in olduğu için global kayıt güvenli, Tier-2 "otomatik yap"). Ardından `@RequireTenantPermission` kullanan her resolver'ın guard tarafından kapsandığını doğrulayan bir invariant testi ekle (Tier-3). Fiziksel olarak tehlikeli `setDigitalOutput` (`:407-424`) için de aynı ince-taneli izni uzat.

### SVD-HIGH-007 — `mapSensorToType` parent/child + konum alanlarını düşürüyor
**Dosya:** `apps/sensor-service/src/registration/resolvers/registration.resolver.ts:244-266`. Mapper `parentId`, `isParentDevice`, `dataPath`, `sensorRole`, `siteId`, `departmentId`, `firmwareVersion`, `lastCalibratedAt` alanlarını **döndürmüyor** (bizzat okunarak doğrulandı — yalnızca kullanılmayan legacy `farmId/pondId/tankId` dönüyor). `RegisteredSensorType` bunları GraphQL alanı olarak tanımladığından hepsi null çözülüyor. Hem `sensor(id)` hem `sensors` bu helper'dan geçiyor.

**Senaryo:** Operatör parent gateway + child kanallar kaydeder; liste refetch sonrası tek bir katlanabilir parent kartı yerine parent **ve** her child düz üst-düzey kart olarak "0 veri kanalı" ile görünür (`DevicesPage.tsx:531-545` gruplama `isParentDevice`/`parentId`'ye dayanıyor, ikisi de null → hepsi orphan). Detay sayfasında Site/Departman "Belirtilmemiş", Firmware "Bilinmiyor" — kaydedilen değerler yazılıyor ama hiç geri okunmuyor.

**Kök-neden düzeltme:** Eksik alanları `mapSensorToType`'a ekle (tek mapper hem liste hem detayı besliyor). Tier-3: `RegisteredSensorType` üzerindeki her `@Field`'in mapper tarafından set edildiğini doğrulayan resolver/DTO parite testi ekle.

### SVD-HIGH-008 — Sensör sihirbazı "zorunlu" konum hiyerarşisini serialize etmiyor
**Dosya:** `web/modules/sensor-module/src/components/registration/SensorRegistrationWizard.tsx:201-213` (`parent` payload'u yalnızca `farmId/pondId/tankId/location` gönderiyor, `siteId/departmentId/systemId/equipmentId` yok), `steps/ParentDeviceInfoStep.tsx:146-194` (Site+Departman `*` zorunlu etiketli, farm/pond/tank input'u yok), backend `sensor-registration.service.ts:664-667,698-701` bu alanları map ediyor ama hiç gelmiyor. `validateStep(3)` (`:87-88`) yalnızca `name` kontrol ediyor.

**Senaryo:** Operatör zorunlu Site+Departman seçer; mutation `undefined` taşır; parent ve tüm child'lar NULL konum hiyerarşisiyle persist edilir — site/departman-kapsamlı hiçbir listede görünmez, oysa UI atamanın zorunlu ve başarılı olduğunu söylemiştir.

**Kök-neden düzeltme:** `handleSubmit`'te `siteId/departmentId/systemId/equipmentId`'yi serialize et, ölü `farmId/pondId/tankId`'yi kaldır; `validateStep(3)`'e `siteId`+`departmentId` zorunluluğunu ekle. Tier-1: tek tipli `ParentDeviceInfo → RegisterParentDeviceInput` mapper.

### SVD-HIGH-009 — Parent+children servis create'i `description`'ı düşürüyor
**Dosya:** `apps/sensor-service/src/registration/services/sensor-registration.service.ts:652-677` (`queryRunner.manager.create(Sensor, {…})` objesinde `description` yok), DTO `register-sensor.dto.ts:469-472` alanı doğruluyor, wizard `SensorRegistrationWizard.tsx:208` gönderiyor, resolver `:380` geri okuyor → hep null. Tek-sensör yolu (`registerSensor`, `:111`) `description`'ı persist ediyor — tutarsızlık.

**Kök-neden düzeltme:** Parent `create` objesine `description: parent.description` ekle. Tier-1: `registerSensor` ve `registerParentWithChildren`'ın paylaştığı tek mapper.

### SVD-HIGH-010 — VFD sihirbazı `modelSeries/pumpId/notes/tags`'i düşürüyor (entity kolonu yok)
**Dosya:** UI'da toplanıyor (`components/vfd/steps/VfdBasicInfoStep.tsx:60-81,171-233`), serialize ediliyor (`hooks/useVfdRegistration.ts:657-672`), DTO doğruluyor (`vfd/dto/register-vfd.dto.ts:42-101`), ama `vfd/entities/vfd-device.entity.ts:107-211`'de `modelSeries/pumpId/notes/tags` kolonu **yok** (grep ile doğrulandı). `VfdDeviceService.create` `{ ...input }` yayıp `repository.create` yapıyor — kolon-olmayan anahtarlar persist edilmiyor. Ayrıca entity'de `description` kolonu var ama sihirbaz `notes` gönderiyor → `description` hep boş, notlar kayboluyor.

**Senaryo:** Operatör ABB sürücüsünü Model Series "ACS880", Pump-3, "Kritik" etiketi ve devreye-alma notlarıyla kaydeder. Başarı raporlanır. `vfd_devices` satırında hiçbiri yoktur — model serisi yok (varsayılan register eşlemesi vaadi kırık), pompa bağı yok, filtre etiketi yok, not yok.

**Kök-neden düzeltme:** Eksik kolonları (`model_series`, `pump_id` uuid, `notes` text, `tags` text[]/jsonb) yeni migration ile `VfdDevice`'a ekle ve `VfdDeviceService.create`'te map et; ya da desteklenmiyorsa DTO alanlarını + UI kontrollerini kaldır (Tier-1). `notes` vs `description`'ı tek kanonik kolona indirge.

### SVD-HIGH-011 — `tenant_provisioning_keys` şema-yerleşim uyumsuzluğu → self-register akışı kopuk
**Dosya:** `apps/sensor-service/src/edge-device/tenant-key.service.ts:111-143` (`validateAndGetKey` düz `findOne({ where: { keyToken } })`), public çağrılar `provisioning.service.ts:583,604`; tablo per-tenant kayıtlı (`schema-manager.service.ts:262` — `tables` listesinde, `infrastructureTables` değil), entity `schema:` atlıyor (`entities/tenant-provisioning-key.entity.ts:17`).

Per-tenant tablo olduğundan `createTenantKey` yolu satırı `tenant_<uuid>.tenant_provisioning_keys`'e yazıyor. Ama `validateAndGetKey` cross-schema işlemi olmadan `@SkipTenantGuard` public endpoint'ten (search_path `sensor,public`) çağrılıyor → boş `sensor` şablon şemasını sorguluyor. Bu, doğru çözülen kardeş `edge_devices` (`findDeviceAcrossSchemas`) ile tam zıt. Sonuç: (a) her meşru token "Invalid installer token" ile başarısız (fonksiyonel kırık), veya (b) cross-schema UNION-ALL ile "düzeltilirse" `keyToken` global-eşsiz olmadığından iki şemada çakışan token `LIMIT 1` ile yanlış tenant'a çözülür.

**Kök-neden düzeltme:** Provisioning-key dizinini gerçek pre-tenant token dizini olarak ele al (tıpkı `auth.tenants`'ın cross-tenant olması gibi — CLAUDE.md D14): tabloyu per-tenant `tables`'tan çıkarıp cross-tenant `sensor`-şema `infrastructureTables`'a taşı (`schema: 'sensor'` deklare et), `keyToken`'a tek global unique constraint ver. `validateAndGetKey`'in düz `findOne`'ı böylece doğru ve güvenli çözer.

### SVD-HIGH-012 — Frontend/backend enum drift (SensorType + VfdChangeSetStatus)
**Doğrulandı** (grep karşılaştırması):
- `SensorType`: FE (`web/modules/sensor-module/src/types/registration.types.ts:133,139,140`) `PRESSURE/CAMERA/OTHER` içeriyor; BE (`apps/sensor-service/src/database/entities/sensor.entity.ts:29-45`) bunların **hiçbirini** içermiyor. `inferChildSensorConfig` bilinmeyen kanalı `SensorType.OTHER`'a düşürüyor → çoklu-parametre problarında `registerParentWithChildren` GraphQL enum doğrulama hatasıyla reddediliyor (`Value "OTHER" does not exist in "SensorType"`).
- `VfdChangeSetStatus`: FE (`types/vfd.types.ts:854-865`) `PARTIALLY_APPLIED` içeriyor ama `VERIFIED` **eksik**; BE (`vfd/entities/vfd.enums.ts:54-71`) `VERIFIED` içeriyor ama `PARTIALLY_APPLIED` yok. Input yönü: `PARTIALLY_APPLIED` filtresi `vfdChangeSets` sorgusunu kırar. Output yönü: `VERIFIED` durumundaki change-set FE'de `STATUS_STYLES[undefined]` → `TypeError` / boş rozet (`components/vfd/VfdChangeSetList.tsx:48-89`).

**Kök-neden düzeltme:** İki enum'u tek SSoT'ye hizala. Tier-3: FE enum'unun backend GraphQL enum'unun alt-kümesi olduğunu doğrulayan `contract-parity` invariant testi (`tests/invariants/`).

---

## MEDIUM

- **SVD-MED-001** — Provisioning token'ları ve tenant key'leri düz metin depolanıyor (`edge-device/tenant-key.service.ts:45,112`, `provisioning.service.ts:118,134`). DB okuma sızıntısı → sahte cihaz enrollment. SHA-256 hash depola, `keyId` prefix ile ara, `timingSafeEqual`. (SVD-HIGH-011 ile birlikte düzeltilebilir.)
- **SVD-MED-002** — Provisioning token URL query parametresi olarak taşınıyor (`provisioning.controller.ts:65-69`, `installer-script.service.ts:198-201`) → nginx/proxy/history/Referer log'larına sızar. Header/POST body'ye taşı.
- **SVD-MED-003** — MQTT auth HTTP backend varsayılan olarak kimlik-doğrulamasız (`mqtt-auth.controller.ts:45-100`, `@Public`, secret yalnızca header gönderilirse kontrol ediliyor). Prod'da secret'ı zorunlu kıl (bootstrap'te fail-closed), header-yokluğunda reddet, route'ları iç arayüze bağla.
- **SVD-MED-004** — DoS: her önbelleksiz public/agent isteğinde tüm `tenant_*` şemalarına `UNION ALL` tarama (`provisioning.service.ts:768-796`, `mqtt-auth.service.ts:354-378`); MQTT auth path'inde rate-limit yok. Global `mqtt_client_id → tenant_id` indeksi + negatif-sonuç cache + rate-limit.
- **SVD-MED-005** — MQTT ACL `acc===4` (SUBSCRIBE) için koşulsuz `true` dönüyor (`mqtt-auth.service.ts:166-169`) → cross-tenant wildcard subscribe mümkün, izolasyon yalnızca per-mesaj READ'e dayanıyor. Subscribe anında tenant kapsamını da doğrula.
- **SVD-MED-006** — Legacy `edge/{username}/` MQTT topic'leri tenant namespace'siz ve ACL-izinli (`mqtt-auth.service.ts:222-279`). `tenants/{tenantId}/...`'e migrasyonu tamamla, `edge/` branch'i deny yap.
- **SVD-MED-007** — Device-group üyelik add/move seçili her `deviceId`'nin tenant sahipliğini doğrulamıyor (`device-group.service.ts:184-214,333-360`). Her üyeyi tenant'a karşı doğrula. (`batchUpdateSensors` doğru scope'lu.)
- **SVD-MED-008** — `REVOKED` cihaz durumu re-provisioning/lifecycle geçişlerinde terminal sayılmıyor (`provisioning.service.ts:495,317`, `edge-device.service.ts:586` yalnızca `DECOMMISSIONED` bloke ediyor) → revoked cihaz sessizce yeniden aktifleşir. `isTerminal(state)` ortak predikatı.
- **SVD-MED-009** — `vfd_register_mappings` cross-tenant referans tablosu `schema:` ve `tenantId` olmadan (`entities/vfd-register-mapping.entity.ts:25`) → belirsiz yerleşim, yanlış-register-yazma riski. `schema:'sensor'` + `infrastructureTables`, ya da `tenantId` scope.
- **SVD-MED-010** — `registerParentWithChildren`: commit sonrası fırlatma zaten commit'lenmiş transaction'da `rollbackTransaction()` tetikliyor (`sensor-registration.service.ts:738,753-789,814-821`) → yanlış "failed" + retry'de duplicate cihaz. Commit-sonrası işi try dışına al veya `queryRunner.isTransactionActive` ile gate'le; parent kimliğine idempotency guard.

---

## LOW

- **SVD-LOW-001** — `ingestReading`/`batchIngestReadings` rol gate'siz (`sensor/resolvers/sensor.resolver.ts:305-340`) → `MODULE_USER` sahte ölçüm basıp alert'leri tetikleyebilir. `@Roles(TENANT_ADMIN, MODULE_MANAGER)` ekle.
- **SVD-LOW-002** — `pingEdgeDevice` rol gate'siz (`edge-device.resolver.ts:214-221`), diğer cihaz komutlarıyla tutarsız. `@Roles` ekle.
- **SVD-LOW-003** — `DevicesPage` tüm ayrıcalıklı cihaz aksiyonlarını (ekle/bulk firmware/configure) frontend rol gating olmadan render ediyor (backend fail-closed, ama defense-in-depth + doğru affordance eksik). Paylaşılan auth/rol context'iyle gate'le.
- **SVD-LOW-004** — Sensör/VFD sekmelerinde pagination yok + search yalnızca ilk 20 satırda (`useSensorList.ts:120-127`, `DevicesPage.tsx:1050-1147`) → 20+ cihazda başarılı kayıt gizlenebilir. Edge sekmesiyle server-side arama/pagination paritesi.
- **SVD-LOW-005** — Edge stat-kart/filtre tıklamaları `edgePage`'i resetlemiyor (`DevicesPage.tsx:749,756,765`) → N. sayfada sonuçlar gizlenir. Tek `applyEdgeFilter` helper'ı.
- **SVD-LOW-006** — Sensör listesi online durumu mount-anı snapshot (polling yok, `useSensorList.ts:138-148`), edge sekmesi 30s poll ediyor → bayat bağlantı rozeti. TanStack Query + `refetchInterval`.
- **SVD-LOW-007** — Kayıt lifecycle event'leri lokal `EventEmitter2`, `createBaseEvent()` NATS domain event'i değil (`sensor-registration.service.ts:134,172,...`) → farm/alert kayıt lifecycle'ını gözleyemiyor (ADR-006/014). Cross-service gözlem kastediliyorsa kontrat event'ine çevir.
- **SVD-LOW-008** — Rate limiting in-memory per-instance (`guards/rate-limit.guard.ts:55`), N replica = N× limit; `validateAndGetKey` timing-safe compare etkisiz (SVD-MED-001 ile birlikte); legacy file-mode PBKDF2 101 iterasyon (`mqtt-auth.service.ts:56`). Redis-destekli limiter + hash-lookup + legacy path'i kaldır.

---

## Tasarım gereği (aksiyon yok, kayıt için)
`emergencyStopVfd` (`vfd/resolvers/vfd-command.resolver.ts:148-157`) kasıtlı olarak `@Roles` atlıyor — E-stop RBAC ile bloke edilmemeli (savunulabilir güvenlik tasarımı). `@ThrottleSensitive()` mevcut. **Gereklilik:** aksiyonun aktör kimliğiyle append-only audit log'a yazıldığını doğrula.

---

## Doğru çalışan kontroller (denetlendi, aksiyon yok)
- Provisioning token doğrulama merkezî, SHA-256 + `timingSafeEqual`, tek kullanımlık, atomik `usedCount` artışıyla TOCTOU kapalı.
- MQTT topic'leri komutlarda `tenants/{tenantId}/devices/{deviceId}/...` ile tenant-namespaced (DB-çözümlü tenant).
- Installer script'leri agent versiyonu + repo pinliyor, SHA-256 checksum doğruluyor, `sanitizeForShell` + tek-tırnak heredoc + `execFile` (shell injection yok).
- Dinamik şema adları `^tenant_[a-f0-9]{16}$` regex ile kısıtlı, tüm repo sorguları parametrize, sort kolonları allowlist'li (SQL injection yok).
- Edge-device / LoRa GraphQL mutation'ları backend DTO'larla alan-alan eşleşiyor (contract-parity temiz). Frontend edge query key'leri `createTenantQueryKey` ile tenant-scoped (cross-tenant cache sızıntısı yok).
- `VfdDevice`/`sensors` entity'leri per-tenant tablo olarak doğru şekilde `schema:` atlıyor; VFD kaydı `DRAFT`→explicit activate (Maker-Checker tutarlı).

---

## Önerilen düzeltme sırası
1. **Hemen (CRITICAL):** SVD-CRIT-001 (SSRF `SafeHttpClient`), SVD-CRIT-002 (VFD sekmesi görünürlüğü).
2. **Bu PR / sprint (HIGH):** SVD-HIGH-001..012. Güvenlik (001,003,006), veri-kaybı (002,007,008,009,010), tenant (005,011), kontrat (012,004).
3. **Takip (MEDIUM/LOW):** owner + deadline + tracked finding ID ile.

Ortak `SafeHttpClient`/socket-guard implementasyonu için SVD-CRIT-001 + SVD-HIGH-001'i `auth-security-expert`/`infra-expert`'e yönlendir; yeni `backend → operatör-tanımlı endpoint` trust boundary'sini `docs/architecture/trust-boundaries.md`'ye ekle.
