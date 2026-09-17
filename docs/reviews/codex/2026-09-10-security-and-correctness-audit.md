# Siber güvenlik ve doğruluk denetimi

Tarih: 2026-09-10

İncelenen anlık görüntü: 43f0aa3bf69cd9df6ef620910df2c33d93ec6fd4

Karar: BLOCK

## Yönetici özeti

Bu denetimde 21 HIGH ve 15 MEDIUM olmak üzere 36 doğrulanmış bulgu kaydedildi. En yüksek risk kümeleri; MFA ve tenant yaşam döngüsünü atlayan token üretimi, süresi dolmuş yetkilerin JWT'lere taşınması, Redis ve WebSocket güven sınırları, çalışan performans kayıtlarında nesne yetkilendirmesi, üretim dağıtımında SSH sunucu kimliği ve SCADA fiziksel kontrol sözleşmeleridir.

SCADA tarafındaki üç hata birlikte özellikle önemlidir: bulut PIN seviyesini widget kimliğiyle kaydederken edge tag adıyla arıyor; bulut scrypt üretirken edge SHA-256 karşılaştırıyor; PIN isteği için oluşturulan bekleyen komut sıradan onay cevabıyla tamamlanabiliyor. Bu nedenle kontrol güvenliği hem fail-open hem fail-closed biçimlerde sapıyor. Üretim dağıtımı, HIGH bulgular kapatılmadan güvenlik açısından onaylanmamalıdır.

| Önem   | Güvenlik | Doğruluk / güvenilirlik | Toplam |
| ------ | -------: | ----------------------: | -----: |
| HIGH   |       15 |                       6 |     21 |
| MEDIUM |        7 |                       8 |     15 |
| Toplam |       22 |                      14 |     36 |

## Kapsam ve yöntem

İnceleme; auth, gateway, admin, HR, hydroponics, billing, alert, messaging ve sensor servislerini; web shell, federated remotes ve AquaMobil'i; Rust edge gateway'i; üretim Docker/CI dağıtım dosyalarını; ilgili event, Redis, SCADA ve tenant sözleşmelerini kapsadı.

Yöntem, yalnız metin eşleşmesine dayanmadı. Resolver/controller girişlerinden guard ve servis katmanlarına, kalıcılık ve event çıkışlarına kadar veri ve denetim akışları okundu. Önceki bulgular güncel kaynakta yeniden doğrulandı. Küçük, zararsız yerel kanıtlar; rota önceliği, rate-limit anahtarı, bulut/edge PIN formatı ve worker yürütme sözleşmesi için kullanıldı. Canlı servise saldırı, dış hedef taraması veya veri değişikliği yapılmadı.

Durum değerleri:

- NEW: İncelenen önceki kayıtlarda eşleşme bulunmadı.
- REVALIDATED: Önceki açık bulgu güncel kaynakta hâlâ üretilebilir.
- RESIDUAL: Önceki düzeltme aynı kök nedenin bir bölümünü kapattı; güncel yolda artık risk kaldı.

## HIGH bulgular

### CODEX-HIGH-001 — Parola sıfırlama MFA'yı atlayarak tam oturum üretiyor

Kategori: Güvenlik / kimlik doğrulama
Durum: NEW
Güven: Yüksek

Parola sıfırlama herkese açık resolver'dan başlıyor: [auth.resolver.ts](/var/aqua-saas/apps/auth-service/src/modules/authentication/resolvers/auth.resolver.ts:232). Başarılı sıfırlama eski kimlik bilgilerini iptal ettikten sonra doğrudan tam access ve refresh token üretir: [authentication.service.ts](/var/aqua-saas/apps/auth-service/src/modules/authentication/services/authentication.service.ts:1756). Normal parola girişi ise MFA etkin kullanıcıyı token vermeden challenge akışına alır: [authentication.service.ts](/var/aqua-saas/apps/auth-service/src/modules/authentication/services/authentication.service.ts:522). Token üreticisinin kendisi MFA tamamlandığını zorlamaz: [token.service.ts](/var/aqua-saas/apps/auth-service/src/modules/authentication/services/token.service.ts:203).

Tetikleyici, MFA etkin bir hesabın geçerli parola sıfırlama token'ının ele geçirilmesi veya posta kutusunun devralınmasıdır. Sonuç, ikinci faktör sunulmadan tam oturumdur. SUPER_ADMIN için admin guard da üretilen imzalı role güvenir; mfaVerified şartı koymaz: [platform-admin.guard.ts](/var/aqua-saas/apps/admin-api-service/src/guards/platform-admin.guard.ts:228).

Kök çözüm, bütün primary-factor ve recovery yollarının kullandığı tek bir post-authentication politika sınırıdır. Parola sıfırlama kimlik bilgisini değiştirmeli; etkin MFA tamamlanmadan sınırsız token üretmemelidir.

### CODEX-HIGH-002 — Süresi dolmuş tenant rol atamaları yetki vermeye devam ediyor

Kategori: Güvenlik / yetkilendirme
Durum: NEW
Güven: Yüksek

Rol atama API'si expiresAt kabul eder: [tenant-role.dto.ts](/var/aqua-saas/apps/auth-service/src/modules/tenant/dto/tenant-role.dto.ts:319) ve bunu expires_at alanına yazar: [tenant-user-management.service.ts](/var/aqua-saas/apps/auth-service/src/modules/tenant/services/tenant-user-management.service.ts:1027). Buna rağmen JWT resourcePermissions okuyucusu yalnız is_active koşulunu uygular: [token.service.ts](/var/aqua-saas/apps/auth-service/src/modules/authentication/services/token.service.ts:640). Yetki devri otoritesi de aynı biçimde sona erme zamanını yok sayar: [capability-authority.ts](/var/aqua-saas/apps/auth-service/src/modules/tenant/services/capability-authority.ts:125). Etkin yetkiler görünümü de süreyi filtrelemez: [tenant-user-management.service.ts](/var/aqua-saas/apps/auth-service/src/modules/tenant/services/tenant-user-management.service.ts:961).

Süreli atama sona erdikten sonraki login ve refresh çağrıları yetkileri yeniden JWT'ye basar. Etki mevcut token TTL gecikmesiyle sınırlı değildir; yetki süresiz yaşayabilir ve rol/yetki devri için kullanılabilir.

Kök çözüm, aktif atama tanımını tek sorgu/otorite altında toplamak, expires_at geçmiş kayıtları bütün okuma yollarından çıkarmak ve token ömrünü temsil ettiği en erken süreli yetkiye bağlamaktır.

### CODEX-HIGH-003 — WebAuthn ve parola sıfırlama tenant askısını atlıyor

Kategori: Güvenlik / tenant yaşam döngüsü
Durum: NEW
Güven: Yüksek

Parola login ve refresh tenant durumunu isLoginAllowed ile denetler: [authentication.service.ts](/var/aqua-saas/apps/auth-service/src/modules/authentication/services/authentication.service.ts:456), [authentication.service.ts](/var/aqua-saas/apps/auth-service/src/modules/authentication/services/authentication.service.ts:255). WebAuthn login yalnız kullanıcı aktifliği/kilidini denetleyip token üretir: [webauthn.service.ts](/var/aqua-saas/apps/auth-service/src/modules/authentication/services/webauthn.service.ts:382), [webauthn.service.ts](/var/aqua-saas/apps/auth-service/src/modules/authentication/services/webauthn.service.ts:407). Parola sıfırlama da aynı merkezi tenant durumu kontrolünü atlar: [authentication.service.ts](/var/aqua-saas/apps/auth-service/src/modules/authentication/services/authentication.service.ts:1756).

Tenant askıya alınırken mevcut kimlik bilgileri iptal edilir fakat kullanıcılar aktif kalır: [tenant-provisioning-command.service.ts](/var/aqua-saas/apps/auth-service/src/modules/tenant/services/tenant-provisioning-command.service.ts:789). Bundan sonra passkey login veya parola recovery yeni revocation epoch'u üzerinde geçerli token üretir. Normal tenant kullanıcısı için gateway effective-tenant kontrolü askı durumunu yeniden sorgulamaz: [effective-tenant.middleware.ts](/var/aqua-saas/apps/gateway-api/src/middleware/effective-tenant.middleware.ts:140).

Kök çözüm, platform-admin istisnası açıkça modellenmiş merkezi token-mint transaction'ında tenant uygunluğunu bütün giriş yöntemleri için zorlamaktır.

### CODEX-HIGH-004 — Federated refresh ve parola sıfırlama tek gateway IP kotasını paylaşıyor

Kategori: Güvenlik / kullanılabilirlik
Durum: NEW
Güven: Yüksek

Ortak rate-limit guard kimlik olarak request.ip kullanır ve kullanıcı kimliği yoksa adı/IP'yi anahtar yapar: [rate-limit.guard.ts](/var/aqua-saas/libs/backend-common/src/rate-limit/rate-limit.guard.ts:285), [rate-limit.guard.ts](/var/aqua-saas/libs/backend-common/src/rate-limit/rate-limit.guard.ts:300). Gateway gerçek istemciyi x-client-ip ile forward eder: [authenticated-data-source.ts](/var/aqua-saas/apps/gateway-api/src/federation/authenticated-data-source.ts:253), fakat guard bu doğrulanmış bağlamı okumaz. Public refresh ve reset girişleri: [auth.resolver.ts](/var/aqua-saas/apps/auth-service/src/modules/authentication/resolvers/auth.resolver.ts:141), [auth.resolver.ts](/var/aqua-saas/apps/auth-service/src/modules/authentication/resolvers/auth.resolver.ts:232).

Farklı kullanıcılar auth subgraph'ında aynı gateway container IP'siyle görünür. Böylece on refresh isteği veya üç reset isteği alakasız bütün kullanıcıları ortak pencere boyunca bloke edebilir; saldırgan da geçersiz isteklerle bu kotayı tüketebilir.

Kök çözüm, ortak doğrulanmış client-network context yardımcı işlevini kullanmak ve ayrı istemci, hesap ve session limitleri uygulamaktır.

### CODEX-HIGH-005 — Delegated rol seed işlemi çağıranın yetki verme tavanını aşıyor

Kategori: Güvenlik / yetki yükseltme
Durum: RESIDUAL
Güven: Yüksek

seedTenantRoles yalnız devredilebilir roles:create yetkisini ister: [tenant-role.resolver.ts](/var/aqua-saas/apps/auth-service/src/modules/tenant/resolvers/tenant-role.resolver.ts:257). Seed/reconciliation yolu çağıranın grant authority'sini çözmeden lisanslı template yetkilerini sistem rollerine yeniden ekler: [tenant-role.service.ts](/var/aqua-saas/apps/auth-service/src/modules/tenant/services/tenant-role.service.ts:939), [tenant-role.service.ts](/var/aqua-saas/apps/auth-service/src/modules/tenant/services/tenant-role.service.ts:1164). Normal create/update yolları ise CapabilityAuthorityService ile “sahip olduğundan fazlasını veremezsin” kuralını uygular.

Bir yönetici seed edilmiş rolün yetkilerini bilinçli olarak azaltırsa, roles:create yetkisini koruyan o rolün bir üyesi seed çağırıp kaldırılan template yetkilerini kendi rolüne geri ekleyebilir. Önceki RBAC-MEDIUM-015 additive reconciliation davranışını getirmişti; çağıran otoritesi bu yolda hâlâ yoktur.

Kök çözüm, sistem template migration/provisioning işlemini kullanıcıya devredilebilir rol yazımından ayırmak veya eklenecek her yetkiyi çağıranın grant ceiling'iyle kesiştirmektir.

### CODEX-HIGH-006 — Bulut widget kimliği, edge tag adı arıyor; PIN seviyesi Confirm'e düşüyor

Kategori: Güvenlik / OT kontrol yetkisi
Durum: NEW
Güven: Yüksek

Bulut save sınırı PIN verilen widget'ın w.id değerini controlPermissions.securityLevels.pin dizisine ekler: [scada-package.service.ts](/var/aqua-saas/apps/sensor-service/src/process/services/scada-package.service.ts:315). Resmi deploy fixture'ı da listelerde widget-1/widget-2 taşır: [deploy-scada-package.json](/var/aqua-saas/libs/sensor-contracts/fixtures/deploy-scada-package.json:156). Edge ise gelen komutun tag string'ini bu dizilerde arar ve eşleşme yoksa Confirm döndürür: [scada_server.rs](/var/aqua-saas/sens-api-gateway/src/scada_server.rs:734). Handler bu fonksiyona runtime tag adını verir: [scada_server.rs](/var/aqua-saas/sens-api-gateway/src/scada_server.rs:1350).

Widget kimliği ile water_temp benzeri tag aynı değer olmadığında PIN sınıflandırması hiçbir zaman bulunmaz. PIN gerektiren fiziksel kontrol sıradan kullanıcı onayına düşer; none seviyesi de gereksiz Confirm'e dönüşür.

Kök çözüm, güvenlik seviyesinin canonical anahtarını sözleşmede tekleştirmektir. Tercihen deploy dönüşümü widget kimliğini doğrulanmış canonical tagRef'e çevirir ve edge şeması bu alanı sıkı doğrular.

### CODEX-HIGH-007 — PIN isteği sıradan confirmResponse ile tamamlanabiliyor

Kategori: Güvenlik / OT kontrol yetkisi
Durum: NEW
Güven: Yüksek

Confirm ve PIN bekleyen komutları aynı PendingConfirm yapısı ve aynı pending_confirms map'i içinde saklanır; yapı gereken doğrulama türünü taşımaz: [scada_server.rs](/var/aqua-saas/sens-api-gateway/src/scada_server.rs:1065). PIN kolu requestId'yi bu ortak map'e yazar: [scada_server.rs](/var/aqua-saas/sens-api-gateway/src/scada_server.rs:1382). confirmResponse handler ise requestId'yi map'ten çıkarıp güvenlik seviyesini yeniden denetlemeden komutu pin_used=false ile çalıştırır: [scada_server.rs](/var/aqua-saas/sens-api-gateway/src/scada_server.rs:1490). Gerçek PIN handler'ı aynı kaydı başarıdan sonra pin_used=true ile tamamlar: [scada_server.rs](/var/aqua-saas/sens-api-gateway/src/scada_server.rs:1618).

PIN isteğini alan WebSocket istemcisi, PIN cevabı yerine aynı requestId ile confirmResponse gönderebilir. Mevcut bulut/edge kimlik uyuşmazlığı giderildiğinde dahi bu type-confusion PIN kontrolünü atlar.

Kök çözüm, bekleyen kayda gereken authorization level ve immutable challenge türünü eklemek; her completion yolunda challenge türünü, güncel emergency durumunu ve güncel yetki seviyesini atomik yeniden doğrulamaktır.

### CODEX-HIGH-008 — Emergency stop bütün fiziksel yazma yollarını durdurmuyor

Kategori: Doğruluk / fiziksel güvenlik
Durum: NEW
Güven: Yüksek

Emergency stop yalnız ScadaState içindeki AtomicBool'u true yapar ve etkilenen tag'lere bir defalık sıfır komutları yollar: [scada_server.rs](/var/aqua-saas/sens-api-gateway/src/scada_server.rs:1818). Bayrak yalnız yeni SCADA command başlangıcında kontrol edilir: [scada_server.rs](/var/aqua-saas/sens-api-gateway/src/scada_server.rs:1335). Daha önce bekleyen confirm doğrudan execute_command çağırır ve bayrağı yeniden kontrol etmez: [scada_server.rs](/var/aqua-saas/sens-api-gateway/src/scada_server.rs:1497). Command executor da bayrağı görmez: [main.rs](/var/aqua-saas/sens-api-gateway/src/main.rs:5588). Modbus/GPIO komut yolları doğrudan donanıma yazar: [write.rs](/var/aqua-saas/sens-api-gateway/src/commands/write.rs:120), [write.rs](/var/aqua-saas/sens-api-gateway/src/commands/write.rs:204). Public is_emergency_active için üretim çağrısı yoktur: [scada_server.rs](/var/aqua-saas/sens-api-gateway/src/scada_server.rs:682).

Stop sonrasında bekleyen komut veya başka protokol/yönetim yazıcısı çıkışı tekrar aktive edebilir. Fiziksel güvenlik durumu tek bir merkezi write admission sınırı değildir.

Kök çözüm, bütün actuator yazmalarının geçtiği tek interlock/command authority oluşturmak, stop generation'ını bekleyen komutlara bağlamak ve reset olmadan hiçbir protokolün yazamamasını sağlamaktır.

### CODEX-HIGH-009 — Üretim SSH deploy'u droplet sunucu kimliğini doğrulamıyor

Kategori: Güvenlik / CI-CD tedarik zinciri
Durum: NEW
Güven: Yüksek

Capacity preflight ve gerçek deploy aynı pinned appleboy/ssh-action sürümünü host, username ve private key ile çağırıyor fakat fingerprint vermiyor: [deploy-digitalocean.yml](/var/aqua-saas/.github/workflows/deploy-digitalocean.yml:1186), [deploy-digitalocean.yml](/var/aqua-saas/.github/workflows/deploy-digitalocean.yml:1270). Deploy job'ı içerik yazma yetkili GITHUB_TOKEN/GHCR_TOKEN'ı uzak oturuma forward eder: [deploy-digitalocean.yml](/var/aqua-saas/.github/workflows/deploy-digitalocean.yml:1261), [deploy-digitalocean.yml](/var/aqua-saas/.github/workflows/deploy-digitalocean.yml:1287). Pinned action'ın fingerprint girdisi [action.yml](https://github.com/appleboy/ssh-action/blob/0ff4204d59e8e51228ff73bce53f80d53301dee2/action.yml) içinde isteğe bağlıdır; altında kullanılan easyssh istemcisi fingerprint yoksa host-key doğrulamasını kapatır: [easyssh.go](https://github.com/appleboy/easyssh-proxy/blob/master/easyssh.go).

DNS/ağ yönlendirmesi saldırısında runner yanlış SSH sunucusuna bağlanabilir; deploy komutları ve forward edilen registry token'ı saldırgana gider. Post-deploy doğrulaması da her çalışmada yeni known_hosts ile accept-new kullanır: [production-post-deploy-verify.yml](/var/aqua-saas/.github/workflows/production-post-deploy-verify.yml:103).

Kök çözüm, üretim droplet host public-key fingerprint'ini protected environment secret olarak pinlemek ve bütün SSH yollarında aynı değeri zorunlu kullanmaktır.

### CODEX-HIGH-010 — Tek Redis parolası bütün servisleri auth güvenlik durumuna yetkili kılıyor

Kategori: Güvenlik / servis izolasyonu
Durum: NEW
Güven: Yüksek

Authoritative droplet compose Redis'i yalnız tek requirepass ile başlatır: [docker-compose.droplet.yml](/var/aqua-saas/docker-compose.droplet.yml:518). Gateway, auth ve diğer çok sayıda servis aynı REDIS_PASSWORD değerini alır; örnekler: [docker-compose.droplet.yml](/var/aqua-saas/docker-compose.droplet.yml:664), [docker-compose.droplet.yml](/var/aqua-saas/docker-compose.droplet.yml:802). ACL kullanıcıları, per-service key pattern'i veya command sınırı yoktur. Uygulamadaki keyPrefix yalnız istemci tarafı adlandırmadır: [redis-options.builder.ts](/var/aqua-saas/libs/backend-common/src/redis/redis-options.builder.ts:48).

Auth revocation kayıtları sabit auth namespace'inde tutulur: [redis.service.ts](/var/aqua-saas/libs/backend-common/src/redis/redis.service.ts:13), [redis.service.ts](/var/aqua-saas/libs/backend-common/src/redis/redis.service.ts:176). Bu nedenle daha düşük güvenli herhangi bir servisin ele geçirilmesi aynı Redis credential'ıyla token blacklist/user revocation durumunu silebilir veya değiştirebilir, rate-limit/lock/cache durumlarını zehirleyebilir ve diğer servis verilerini okuyabilir.

Kök çözüm, Redis ACL kullanıcılarını sert servis kimliklerine ayırmak; her kullanıcıya yalnız gerekli key pattern ve command setini vermek; auth revocation alanını ayrı yüksek güvenli instance veya en azından ayrı ACL domaininde tutmaktır.

### CODEX-HIGH-011 — OPC UA endpoint discovery SSRF korumasını atlıyor

Kategori: Güvenlik / SSRF ve iç ağ tarama
Durum: REVALIDATED; Nisan HIGH-002'nin artık yolu
Güven: Yüksek

TENANT_ADMIN ve MODULE_MANAGER caller-controlled endpointUrl ile discovery çağırabilir: [plc-control.resolver.ts](/var/aqua-saas/apps/sensor-service/src/plc-control/resolvers/plc-control.resolver.ts:227). Servis yalnız numeric private adresleri senkron string parser ile engeller; host adları DNS çözümü görmeden geçer: [plc-connection.service.ts](/var/aqua-saas/apps/sensor-service/src/plc-control/services/plc-connection.service.ts:472). Normal OPC UA connect yolu ortak DNS tabanlı outbound guard'ı çağırır: [opcua.adapter.ts](/var/aqua-saas/apps/sensor-service/src/protocol/adapters/industrial/opcua.adapter.ts:215). discoverEndpoints ise yeni client yaratıp endpointUrl'e doğrudan bağlanır: [opcua.adapter.ts](/var/aqua-saas/apps/sensor-service/src/protocol/adapters/industrial/opcua.adapter.ts:386).

İç hostname, alternatif IP yazımı veya DNS rebinding ile sensor-service ağı üzerinden hedef portlara bağlantı kurulabilir; hata ve zamanlama iç ağ keşfine yarar.

Kök çözüm, discovery'yi kayıtlı ve tenant-owned PLC bağlantısıyla sınırlandırmak veya connect ve discovery'nin aynı DNS çözümleme/pinning yapan outbound dialer'ı kullanmasını sağlamaktır.

### CODEX-HIGH-012 — Messaging WebSocket kimlik süresi dolunca kapanmıyor

Kategori: Güvenlik / gerçek zamanlı oturum
Durum: REVALIDATED; SEC-HIGH-053
Güven: Yüksek

ConnectedClient token exp/jti taşımaz: [messaging.gateway.ts](/var/aqua-saas/apps/gateway-api/src/websocket/messaging.gateway.ts:43). Periyodik mekanizma yalnız reAuth olayı gönderir: [messaging.gateway.ts](/var/aqua-saas/apps/gateway-api/src/websocket/messaging.gateway.ts:209), [messaging.gateway.ts](/var/aqua-saas/apps/gateway-api/src/websocket/messaging.gateway.ts:608). Cevapsız challenge için deadline veya disconnect yoktur; hata sayacı yalnız geçersiz cevap geldiğinde artar: [messaging.gateway.ts](/var/aqua-saas/apps/gateway-api/src/websocket/messaging.gateway.ts:438). Desktop client reAuth işlemez: [useMessagingSocket.ts](/var/aqua-saas/web/modules/messaging-module/src/hooks/useMessagingSocket.ts:45).

Geçerli token ile açılmış socket token ömrünü aştıktan sonra odada kalır. Yeni MessageSent akışı tam mesajı odadaki socket'lere gönderirken expiry denetlemez: [messaging.gateway.ts](/var/aqua-saas/apps/gateway-api/src/websocket/messaging.gateway.ts:517).

Kök çözüm, expiry ve reauth deadline'ının sunucu sahipliğinde olması; doğrulanmış yenileme gelmezse socket'in odalardan çıkarılıp kapatılmasıdır.

### CODEX-HIGH-013 — Messaging handshake ve reAuth token iptalini kontrol etmiyor

Kategori: Güvenlik / token revocation
Durum: REVALIDATED; SEC-HIGH-054
Güven: Yüksek

WebSocket validateToken imza, issuer, audience ve type kontrol eder fakat jti blacklist veya kullanıcı revocation epoch'u sorgulamaz: [messaging.gateway.ts](/var/aqua-saas/apps/gateway-api/src/websocket/messaging.gateway.ts:699). Gateway HTTP AuthGuard aynı token için revocation state'i ayrıca denetler: [auth.guard.ts](/var/aqua-saas/apps/gateway-api/src/guards/auth.guard.ts:136). WebSocket constructor bu otoriteyi almaz: [messaging.gateway.ts](/var/aqua-saas/apps/gateway-api/src/websocket/messaging.gateway.ts:114). NATS bridge de logout/revocation olaylarını tüketmez: [messaging-nats-bridge.service.ts](/var/aqua-saas/apps/gateway-api/src/websocket/messaging-nats-bridge.service.ts:43).

İptal edilmiş fakat kriptografik exp zamanı gelmemiş token yeni handshake/reAuth için geçerli kalır; mevcut bağlantı da iptal olayıyla sonlandırılmaz.

Kök çözüm, HTTP ve WebSocket'in aynı revocation-aware verifier'ı kullanması ve aktif session iptallerinin socket eviction'a bağlanmasıdır.

### CODEX-HIGH-014 — Çalışan başka çalışanın performans değerlendirmesini değiştirebiliyor

Kategori: Güvenlik / nesne yetkilendirmesi
Durum: NEW
Güven: Yüksek

submitSelfAssessment resolver'ı owner/role sınırı olmadan caller-selected reviewId'yi geçirir: [performance.resolver.ts](/var/aqua-saas/apps/hr-service/src/performance/performance.resolver.ts:365). Handler yalnız id, tenantId ve isDeleted ile kaydı bulur; userId yalnız updatedBy içindir: [submit-self-assessment.handler.ts](/var/aqua-saas/apps/hr-service/src/performance/handlers/submit-self-assessment.handler.ts:24), [submit-self-assessment.handler.ts](/var/aqua-saas/apps/hr-service/src/performance/handlers/submit-self-assessment.handler.ts:38). acknowledgeReview aynı eksikle başka çalışanın yorum ve acknowledged durumunu değiştirebilir: [acknowledge-review.handler.ts](/var/aqua-saas/apps/hr-service/src/performance/handlers/acknowledge-review.handler.ts:24), [acknowledge-review.handler.ts](/var/aqua-saas/apps/hr-service/src/performance/handlers/acknowledge-review.handler.ts:38).

Global RolesGuard metadata olmayan authenticated çağrıyı kabul eder: [roles.guard.ts](/var/aqua-saas/libs/backend-common/src/guards/roles.guard.ts:67). Tenant eşleşmesi çalışan sahipliği değildir. Aynı politika taramasına goal create/update yolları da alınmalıdır: [create-goal.handler.ts](/var/aqua-saas/apps/hr-service/src/performance/handlers/create-goal.handler.ts:40), [update-goal.handler.ts](/var/aqua-saas/apps/hr-service/src/performance/handlers/update-goal.handler.ts:24).

Kök çözüm, user → employee eşlemesi yapan ve çalışan/reviewer/manager ilişkisini command sınırında zorlayan tek performans yetki politikasıdır.

### CODEX-HIGH-015 — Performans sorguları diğer çalışanların gizli kayıt ve PII'sini açıyor

Kategori: Güvenlik / veri gizliliği
Durum: NEW
Güven: Yüksek

performanceReview, pendingReviews, performanceSummary ve employeeKPIs arbitrary hedef kimliği kabul eder; role veya owner kontrolü yoktur: [performance.resolver.ts](/var/aqua-saas/apps/hr-service/src/performance/performance.resolver.ts:128), [performance.resolver.ts](/var/aqua-saas/apps/hr-service/src/performance/performance.resolver.ts:149), [performance.resolver.ts](/var/aqua-saas/apps/hr-service/src/performance/performance.resolver.ts:158), [performance.resolver.ts](/var/aqua-saas/apps/hr-service/src/performance/performance.resolver.ts:297). Handler employee ve reviewer relations döndürür: [get-performance-review.handler.ts](/var/aqua-saas/apps/hr-service/src/performance/query-handlers/get-performance-review.handler.ts:18).

Kayıtta manager assessment, calibration notes ve development plans vardır: [performance-review.entity.ts](/var/aqua-saas/apps/hr-service/src/performance/entities/performance-review.entity.ts:117), [performance-review.entity.ts](/var/aqua-saas/apps/hr-service/src/performance/entities/performance-review.entity.ts:141), [performance-review.entity.ts](/var/aqua-saas/apps/hr-service/src/performance/entities/performance-review.entity.ts:153). Nested Employee.contactInfo/address GraphQL alanlarıdır: [employee.entity.ts](/var/aqua-saas/apps/hr-service/src/hr/entities/employee.entity.ts:207). Bu yollar top-level employee resolver'ın redaction'ını çağırmaz: [hr.resolver.ts](/var/aqua-saas/apps/hr-service/src/hr/hr.resolver.ts:95).

Kök çözüm, actor-aware performans query policy ve Employee PII'sini yalnız üst resolver'da değil field/projection sınırında zorlamaktır.

### CODEX-HIGH-016 — Hydroponics sahipliği caller'ın değiştirebildiği settings.createdBy alanına güveniyor

Kategori: Güvenlik / nesne yetkilendirmesi
Durum: RESIDUAL; PLAT-HIGH-011 kısmi düzeltmesi
Güven: Yüksek

Delete kontrolü config.settings.createdBy ile authenticated user.sub değerini karşılaştırır: [setup.resolver.ts](/var/aqua-saas/apps/hydroponics-service/src/setup/resolvers/setup.resolver.ts:168). Fakat MODULE_USER aynı tenant'taki konfigürasyonun settings nesnesini update yoluyla değiştirebilir: [setup.resolver.ts](/var/aqua-saas/apps/hydroponics-service/src/setup/resolvers/setup.resolver.ts:116), [setup.resolver.ts](/var/aqua-saas/apps/hydroponics-service/src/setup/resolvers/setup.resolver.ts:124). DTO arbitrary JSON object key'lerini kabul eder: [update-hydroponics-config.input.ts](/var/aqua-saas/apps/hydroponics-service/src/setup/dto/update-hydroponics-config.input.ts:17). Create de güvenilir owner'ı sunucu tarafından damgalamaz: [setup.resolver.ts](/var/aqua-saas/apps/hydroponics-service/src/setup/resolvers/setup.resolver.ts:104).

Kullanıcı önce yönetici kaydındaki createdBy değerini kendisi yapıp sonra delete kontrolünü geçebilir.

Kök çözüm, creator/owner kimliğini ayrı immutable kolonda doğrulanmış request context'ten yazmak ve yetkiyi settings içeriğinden tamamen ayırmaktır.

### CODEX-HIGH-017 — Geçici hata Stripe webhook'unu kalıcı olarak tüketiyor

Kategori: Doğruluk / finansal olay işleme
Durum: RESIDUAL
Güven: Yüksek

Controller business processing'den önce pending durable dedup satırını commit eder: [stripe-webhook.controller.ts](/var/aqua-saas/apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts:256). Aynı event ID tekrar gelirse satırın başarı durumuna bakmadan HTTP 200 döner: [stripe-webhook.controller.ts](/var/aqua-saas/apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts:273). Redis ve handler bundan sonra çalışır: [stripe-webhook.controller.ts](/var/aqua-saas/apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts:298). Handler hataları da 200/handler-error'a çevrilir: [stripe-webhook.controller.ts](/var/aqua-saas/apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts:339), [stripe-webhook.controller.ts](/var/aqua-saas/apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts:370).

Process ölümü, Redis hatası veya DB transaction hatası ödeme/subscription değişikliğini uygulamadan pending satırı bırakır. Satır replay için payload taşımaz: [stripe-webhook-event.entity.ts](/var/aqua-saas/apps/billing-service/src/billing/entities/stripe-webhook-event.entity.ts:21). Retry/recovery worker bulunmadı.

Kök çözüm, payload taşıyan durable inbox, lease/claim, bounded retry ve business commit ile completion'ı bağlayan atomik işleme modelidir.

### CODEX-HIGH-018 — Başarısız alert transaction cooldown'u aktif bırakıyor

Kategori: Doğruluk / alarm güvenilirliği
Durum: RESIDUAL
Güven: Yüksek

Alert evaluation Redis cooldown'u hiçbir durable alert yazılmadan önce alır: [alert-evaluation.service.ts](/var/aqua-saas/apps/alert-engine/src/alert/services/alert-evaluation.service.ts:278). History, incident ve outbox transaction'ı daha sonra başlar: [alert-evaluation.service.ts](/var/aqua-saas/apps/alert-engine/src/alert/services/alert-evaluation.service.ts:327). DB/outbox hatası transaction'ı geri alır fakat cooldown release/recovery yoktur. Dış evaluation hatayı yutup başarılı biçimde döner: [alert-evaluation.service.ts](/var/aqua-saas/apps/alert-engine/src/alert/services/alert-evaluation.service.ts:102); sensor event handler da hatayı yakalar: [sensor-reading.handler.ts](/var/aqua-saas/apps/alert-engine/src/alert/event-handlers/sensor-reading.handler.ts:126).

Geçici persistence hatasında hiçbir alert/notification oluşmaz, fakat tehlikeli sonraki readings cooldown süresince bastırılır.

Kök çözüm, kısa token-owned processing lease ile completed cooldown'u ayırmak ve kalıcı cooldown'u yalnız durable alert kabulünden sonra kurmaktır.

### CODEX-HIGH-019 — Stripe webhook finansal event'leri transaction outbox dışında yayımlıyor

Kategori: Doğruluk / finansal veri bütünlüğü
Durum: REVALIDATED; BILLING-HIGH-005'in webhook kolu
Güven: Yüksek

Payment success DB transaction içinde doğrudan NATS publish yapar ve publish hatasını yutar: [stripe-webhook.service.ts](/var/aqua-saas/apps/billing-service/src/billing/controllers/stripe-webhook.service.ts:167). Payment failure ve subscription deletion aynı paterni tekrarlar: [stripe-webhook.service.ts](/var/aqua-saas/apps/billing-service/src/billing/controllers/stripe-webhook.service.ts:285), [stripe-webhook.service.ts](/var/aqua-saas/apps/billing-service/src/billing/controllers/stripe-webhook.service.ts:431). Normal RecordPaymentHandler artık doğru biçimde transaction outbox kullanır: [record-payment.handler.ts](/var/aqua-saas/apps/billing-service/src/billing/handlers/record-payment.handler.ts:139).

Broker hatası state'i event olmadan commit edebilir; publish başarılı olup sonraki DB commit başarısız olursa hayalet event üretilebilir. CODEX-HIGH-017'deki dedup sırası normal replay ile tamiri de engeller.

Kök çözüm, bütün doğrulanmış Stripe geçişlerini normal billing command'leriyle aynı transaction/outbox otoritesinden yürütmektir.

### CODEX-HIGH-020 — Otomatik mobile logout senkronize edilmemiş saha kayıtlarını siliyor

Kategori: Doğruluk / geri döndürülemez veri kaybı
Durum: REVALIDATED; PRODUCT-SYNC-HIGH-001
Güven: Yüksek

Refresh başarısızlığı logout çağırır: [authenticated-fetch.ts](/var/aqua-saas/web/apps/aquamobil/src/services/authenticated-fetch.ts:165). Logout clearAllUserData'yı bekler: [useAuth.tsx](/var/aqua-saas/web/apps/aquamobil/src/hooks/useAuth.tsx:471). Bu işlev clearAllOperations'ı koşulsuz çağırır: [useAuth.tsx](/var/aqua-saas/web/apps/aquamobil/src/hooks/useAuth.tsx:195). Kuyruk temizleme bütün pending kayıtları, blobları ve kalıcı şifreleme anahtarını siler: [offline-queue.ts](/var/aqua-saas/web/apps/aquamobil/src/pwa/offline-queue.ts:500), [offline-queue.ts](/var/aqua-saas/web/apps/aquamobil/src/pwa/offline-queue.ts:529).

Ağ veya refresh sorunu sırasında mortality, escape, attendance ve diğer saha kayıtları kullanıcı kararı olmadan geri döndürülemez biçimde kaybolabilir.

Kök çözüm, session kapatmayı iş verisi imhasından ayırmak; principal'a bağlı şifreli kuyruğu reauthentication bekleyen karantinada korumak; yalnız açık kullanıcı discard işlemiyle silmektir.

### CODEX-HIGH-021 — Bulut scrypt, edge SHA-256 bekliyor; doğru PIN hiçbir zaman doğrulanamıyor

Kategori: Doğruluk / OT güvenlik sözleşmesi
Durum: NEW
Güven: Yüksek

Bulut PIN'i scrypt, rastgele salt ve 64 bayt sonuçla scrypt$salt$hash biçiminde üretir: [pin-hash.util.ts](/var/aqua-saas/apps/sensor-service/src/process/services/pin-hash.util.ts:29). Save boundary bu hash'i package controlPermissions içine koyar: [scada-package.service.ts](/var/aqua-saas/apps/sensor-service/src/process/services/scada-package.service.ts:327). Edge deploy transform controlPermissions alanını değiştirmeden taşır: [edge-deploy-transform.ts](/var/aqua-saas/libs/sensor-contracts/src/scada-package-doc/edge-deploy-transform.ts:119), ve deploy payload edgeDoc'u doğrudan yayar: [scada-package.service.ts](/var/aqua-saas/apps/sensor-service/src/process/services/scada-package.service.ts:1019).

Rust edge ise kullanıcının PIN'ini düz SHA-256 hex'e çevirip gelen pin_hash string'iyle karşılaştırır: [scada_server.rs](/var/aqua-saas/sens-api-gateway/src/scada_server.rs:796). Zararsız yerel sözleşme kanıtında aynı PIN için bulut değerinin prefix'i scrypt ve uzunluğu 120, edge değerinin uzunluğu 64 ve eşitlik false oldu.

Buluttan oluşturulan korumalı pakette hiçbir doğru PIN local HMI kontrolünü veya emergency reset'i açamaz. Kök çözüm, ortak test vektörleriyle tek wire-format/KDF sözleşmesi; edge'de scrypt verifier veya bulut tarafından edge'e uygun, sürümlü ve güçlü verifier üretimidir.

## MEDIUM bulgular

### CODEX-MEDIUM-001 — Hassas MFA işlemleri tüketilmiş TOTP kodunu yeniden kabul ediyor

Kategori: Güvenlik / MFA replay
Durum: RESIDUAL; eski SEC-HIGH-001 kapsam boşluğu
Güven: Yüksek

Login, setup ve step-up atomik verifyAndConsumeTotp kullanırken disableMfa ve regenerateRecoveryCodes stateless verifyTOTP çağırır: [mfa.service.ts](/var/aqua-saas/apps/auth-service/src/modules/authentication/services/mfa.service.ts:447), [mfa.service.ts](/var/aqua-saas/apps/auth-service/src/modules/authentication/services/mfa.service.ts:485). Bu mutation'larda ayrıca service-local rate limit yoktur.

Aynı zaman penceresinde login/step-up için tüketilmiş kod, authenticated session sahibi tarafından recovery code değiştirme veya MFA kapatma için yeniden kullanılabilir. Disable ayrıca parola ister; bu nedenle etki HIGH yerine MEDIUM'dur.

Kök çözüm, bütün hassas MFA değişikliklerinde tek verify-and-consume primitive'i ve hesap bağlı attempt/lockout politikasıdır.

### CODEX-MEDIUM-002 — Edge bütün SCADA paketini PIN verifier ile WebSocket izleyicilerine yayıyor

Kategori: Güvenlik / secret verifier ifşası
Durum: NEW
Güven: Yüksek

ControlPermissions.pin_hash serialize edilen normal bir alandır: [scada_types.rs](/var/aqua-saas/sens-api-gateway/src/scada_types.rs:188). Package deploy edildiğinde tüm WebSocket istemcilerine setPackage olarak yayınlanır: [scada_server.rs](/var/aqua-saas/sens-api-gateway/src/scada_server.rs:488). Yeni bağlanan istemci de bütün package'ı alır: [scada_server.rs](/var/aqua-saas/sens-api-gateway/src/scada_server.rs:1144). WebSocket'in kimliği yoktur; yalnız private/localhost Origin kontrolü vardır: [scada_server.rs](/var/aqua-saas/sens-api-gateway/src/scada_server.rs:1033).

Cloud hash scrypt olsa da UI dört haneli minimum PIN kabul eder: [scada-edge.html](/var/aqua-saas/sens-api-gateway/static/scada-edge.html:1306). Düşük entropili verifier'ı alan yerel ağ/HMI kullanıcısı global online lockout'u atlayarak offline tahmin yapabilir.

Kök çözüm, browser'a giden view model'den verifier'ı çıkarmak; doğrulamayı yalnız edge process'in server-side state'inde tutmaktır.

### CODEX-MEDIUM-003 — Authoritative üretim Redis trafiği plaintext; TLS yolu da sunucuyu doğrulamıyor

Kategori: Güvenlik / transport
Durum: REVALIDATED; M-NATS-02
Güven: Yüksek

Authoritative droplet compose current phase'i açıkça plaintext olarak tanımlar: [docker-compose.droplet.yml](/var/aqua-saas/docker-compose.droplet.yml:492) ve servisler redis:// URL kullanır: [docker-compose.droplet.yml](/var/aqua-saas/docker-compose.droplet.yml:664). Ağ Docker internal bridge ile sınırlıdır: [docker-compose.droplet.yml](/var/aqua-saas/docker-compose.droplet.yml:225); bu dış erişimi azaltır fakat aynı bridge'deki compromised container'a karşı gizlilik/kimlik sağlamaz.

Alternatif prod compose rediss kullanır, fakat ortak Redis client bütün rediss bağlantılarında rejectUnauthorized:false ayarlar: [redis.service.ts](/var/aqua-saas/libs/backend-common/src/redis/redis.service.ts:37). Yani planlanan TLS geçişi şifreleme sağlar fakat Redis sunucusunun CA/hostname kimliğini doğrulamaz.

Kök çözüm, CA path/SNI'ı config sözleşmesine eklemek, doğrulamayı production'da zorunlu kılmak ve droplet'i rediss'e geçirmek; CODEX-HIGH-010'daki per-service ACL ayrımıyla birlikte uygulamaktır.

### CODEX-MEDIUM-004 — Gerçek ESM remote yüklemeleri SRI guard'dan geçmiyor

Kategori: Güvenlik / frontend tedarik zinciri
Durum: REVALIDATED; RBAC-DEPLOY-002
Güven: Yüksek

Sekiz remote type:module olarak tanımlıdır: [vite.config.ts](/var/aqua-saas/web/shell/vite.config.ts:29). Kilitli Module Federation runtime bu tipi loadEsmEntry'ye yönlendirir: [load.js](/var/aqua-saas/node_modules/@module-federation/runtime-core/dist/utils/load.js:102) ve native import(url) kullanır: [load.js](/var/aqua-saas/node_modules/@module-federation/runtime-core/dist/utils/load.js:38). Shell integrity guard ise script createElement ve setAttribute yollarını patch eder: [remoteIntegrity.ts](/var/aqua-saas/web/shell/src/utils/remoteIntegrity.ts:263), [remoteIntegrity.ts](/var/aqua-saas/web/shell/src/utils/remoteIntegrity.ts:312).

Hash manifesti mevcut olsa dahi gerçek module import yolu integrity attribute üretmez. Remote asset kaynağı değiştirilirse guard mismatch'i engellemez. Ayrı bir remote source compromise yolu bu denetimde kanıtlanmadığı için önem MEDIUM'dur.

Kök çözüm, kullanılan ESM yükleme mekanizmasının enforce ettiği bütün-modül integrity tasarımı ve production bundle üzerinde negatif doğrulama testidir.

### CODEX-MEDIUM-005 — AquaMobil offline kuyruk kullanıcı kimliğine bağlı değil

Kategori: Güvenlik / veri bütünlüğü
Durum: REVALIDATED; PRODUCT-TENANT-MEDIUM-003
Güven: Yüksek

StoredOperation ve encryption key yalnız tenant taşır: [offline-queue.ts](/var/aqua-saas/web/apps/aquamobil/src/pwa/offline-queue.ts:325). Kalıcı anahtar restart sonrasında korunur: [offline-queue.ts](/var/aqua-saas/web/apps/aquamobil/src/pwa/offline-queue.ts:55). Başarısız session restore ve yeni login eski kuyruğu principal bazında ayırmaz: [useAuth.tsx](/var/aqua-saas/web/apps/aquamobil/src/hooks/useAuth.tsx:264), [useAuth.tsx](/var/aqua-saas/web/apps/aquamobil/src/hooks/useAuth.tsx:318). Drain yalnız tenant'a göre filtreler: [useOfflineQueue.tsx](/var/aqua-saas/web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:366).

Aynı tenant'ın ortak cihazında kullanıcı A'dan kalan işlem kullanıcı B'nin token'ıyla gönderilebilir. Tenantlar arası replay kanıtlanmadı.

Kök çözüm, queue/storage/drain sözleşmesine zorunlu tenantId+userId+session generation sahipliği eklemektir.

### CODEX-MEDIUM-006 — Mobile logout önceki kullanıcının image cache'ini bırakıyor

Kategori: Güvenlik / mahremiyet
Durum: REVALIDATED; FE-MEDIUM-067
Güven: Yüksek

Service worker image cache'i görselleri 30 gün tutar: [messaging-sw.ts](/var/aqua-saas/web/apps/aquamobil/src/pwa/messaging-sw.ts:134). Kullanıcı avatarları bu yüzeye gider: [MemberRow.tsx](/var/aqua-saas/web/apps/aquamobil/src/components/messaging/MemberRow.tsx:55). Logout üretilmeyen api-cache adını silmeye çalışır: [useAuth.tsx](/var/aqua-saas/web/apps/aquamobil/src/hooks/useAuth.tsx:213); SW cleanup yalnız messaging- prefix'ini hedefler ve image cache'i temizlemez: [messaging-sw.ts](/var/aqua-saas/web/apps/aquamobil/src/pwa/messaging-sw.ts:346).

Ortak cihazda sonraki kullanıcı önceki principal'ın cache'lenmiş görsellerine erişebilir. Genel GraphQL cache sızıntısı kanıtlanmadı.

Kök çözüm, cache sahipliğini principal/session generation'a bağlamak ve logout purge completion'ını doğrulamaktır.

### CODEX-MEDIUM-007 — Başarısız attachment purge kalıcı retry kaynağını siliyor

Kategori: Güvenlik / veri yaşam döngüsü
Durum: RESIDUAL; MSG-CRITICAL-058 happy-path düzeltmesi
Güven: Yüksek

GDPR erasure attachment DB satırlarını transaction içinde siler ve commit'ten sonra object storage purge'ünü best-effort yürütür: [gdpr.service.ts](/var/aqua-saas/apps/messaging-service/src/gdpr/gdpr.service.ts:322), [gdpr.service.ts](/var/aqua-saas/apps/messaging-service/src/gdpr/gdpr.service.ts:480). Purge hatası loglanıp başarı sonucu korunur: [gdpr.service.ts](/var/aqua-saas/apps/messaging-service/src/gdpr/gdpr.service.ts:508). Purge servisi batch hatalarını yakalayıp yalnız count döndürür: [attachment-object-purge.service.ts](/var/aqua-saas/apps/messaging-service/src/compliance/services/attachment-object-purge.service.ts:84). UserDeleted akışı aynı sıralamayı tekrarlar: [messaging-nats.handler.ts](/var/aqua-saas/apps/messaging-service/src/event-handlers/messaging-nats.handler.ts:677).

Object store outage veya commit sonrası process ölümü PII blobunu bırakır; DB referansı silindiği için retry anahtarı kaybolur. Presigned URL'ler ayrıca bir saate kadar geçerlidir: [media.service.ts](/var/aqua-saas/apps/messaging-service/src/message/services/media.service.ts:49).

Kök çözüm, DB erasure ile aynı transaction'da idempotent durable purge task enqueue etmek ve fiziksel purge tamamlanana kadar kanıt saklamaktır.

### CODEX-MEDIUM-008 — JWT rotation script'i üretimin mount ettiği dosyaları değiştirmiyor

Kategori: Doğruluk / operasyonel güvenlik
Durum: NEW
Güven: Yüksek

Docker wrapper varsayılan olarak repo secrets dizinini seçer ve base script'i bu dizinle çağırır: [rotate-jwt-keys-docker.sh](/var/aqua-saas/scripts/rotate-jwt-keys-docker.sh:111), [rotate-jwt-keys-docker.sh](/var/aqua-saas/scripts/rotate-jwt-keys-docker.sh:167). Base script jwt_private_key.pem ve jwt_public_key.pem üretir: [rotate-jwt-keys.sh](/var/aqua-saas/scripts/rotate-jwt-keys.sh:120). Authoritative production compose ise auth'a /etc/ssl/jwt/private.pem ve public.pem yollarını verir: [docker-compose.droplet.yml](/var/aqua-saas/docker-compose.droplet.yml:805); bunlar certs/jwt altından mount edilir.

Script yanlış dosyaları üretip auth container'ı restart eder: [rotate-jwt-keys-docker.sh](/var/aqua-saas/scripts/rotate-jwt-keys-docker.sh:216). Doğrulama varsayılan localhost port ve wget kullanır: [rotate-jwt-keys-docker.sh](/var/aqua-saas/scripts/rotate-jwt-keys-docker.sh:254); başarısız verification yalnız warning'dir: [rotate-jwt-keys-docker.sh](/var/aqua-saas/scripts/rotate-jwt-keys-docker.sh:262).

Operatör başarı mesajı görürken aktif imzalama anahtarı değişmeyebilir. Kök çözüm, compose mount sözleşmesinden tek key path türetmek ve JWKS'de yeni kid görülmeden rotation'ı başarısız saymaktır.

### CODEX-MEDIUM-009 — Bütün SCADA Modbus yazmaları ilk PLC'ye gidiyor

Kategori: Doğruluk / fiziksel kontrol
Durum: REVALIDATED; ORPHAN-008
Güven: Yüksek

Tag config slave_id ve register taşır: [process_image.rs](/var/aqua-saas/sens-api-gateway/src/process_image.rs:188). Command executor slave/device eşlemesini kullanmak yerine s.config.modbus.first() seçer: [main.rs](/var/aqua-saas/sens-api-gateway/src/main.rs:5608). ORPHAN-008 bu davranışı daha önce kaydetmiş ve açık bırakmıştır: [orphan-findings.md](/var/aqua-saas/docs/reviews/orphan-findings.md:500).

Birden fazla PLC bulunan tesiste tag başka cihaza ait olsa bile write ilk PLC'nin aynı register adresine gider. Bu yanlış aktüatörü değiştirebilir.

Kök çözüm, ProcessImage protocol config'in canonical device/slave kimliğini taşıması ve executor'ın bu kimlikle exact configured device çözmesidir.

### CODEX-MEDIUM-010 — Geçerli SUPER_ADMIN act-as tenant role API'lerinde kayboluyor

Kategori: Doğruluk / yönetim yetkisi
Durum: NEW
Güven: Yüksek

JWT guard raw platform principal'ı request.user'a koyar; SUPER_ADMIN tenantId null'dır: [jwt-auth.guard.ts](/var/aqua-saas/apps/auth-service/src/modules/authentication/guards/jwt-auth.guard.ts:107). TenantGuard imzalı act-as tenant'ı doğrular ve request.tenantId içine yazar: [tenant.guard.ts](/var/aqua-saas/libs/backend-common/src/guards/tenant.guard.ts:173). Tenant-role resolver'ları buna rağmen CurrentUser('tenantId') okur: [tenant-role.resolver.ts](/var/aqua-saas/apps/auth-service/src/modules/tenant/resolvers/tenant-role.resolver.ts:103), [current-user.decorator.ts](/var/aqua-saas/libs/backend-common/src/decorators/current-user.decorator.ts:118).

Geçerli MFA/act-as bağlamı guard'dan geçer, sonra resolver null home-tenant değerini UUID olarak reddeder. Write yollarında CapabilityAuthority user lookup'u da aynı principal/effective-tenant ayrımını modellemez.

Kök çözüm, principal kimliği ile doğrulanmış effective tenant scope'u ayrı tiplerde taşımak ve tenant işlemlerinin tek accessor kullanmasını sağlamaktır.

### CODEX-MEDIUM-011 — IP access stats rotası :id tarafından gölgeleniyor

Kategori: Doğruluk / HTTP routing
Durum: NEW
Güven: Yüksek

GET settings/ip-access/:id rotası static /stats rotasından önce bildirilir: [ip-access.controller.ts](/var/aqua-saas/apps/admin-api-service/src/settings/controllers/ip-access.controller.ts:98), [ip-access.controller.ts](/var/aqua-saas/apps/admin-api-service/src/settings/controllers/ip-access.controller.ts:216). Kurulu Express router ilk eşleşmede stats string'ini id olarak geçirir; service UUID-backed rule lookup yapar: [ip-access.service.ts](/var/aqua-saas/apps/admin-api-service/src/settings/services/ip-access.service.ts:111).

Statistics endpoint erişilemez; malformed UUID veya not-found döner. Yerel Express 5.2.1 router kanıtında /stats için ilk eşleşme /:id oldu.

Kök çözüm, static rotayı öne almak ve item rotasını /rules/:id gibi ayrık namespace'e taşımaktır.

### CODEX-MEDIUM-012 — AquaMobil MFA challenge sözleşmesini desteklemiyor

Kategori: Doğruluk / authentication istemcisi
Durum: NEW
Güven: Yüksek

Mobile login GraphQL selection mfaRequired ve mfaToken istemez: [useAuth.tsx](/var/aqua-saas/web/apps/aquamobil/src/hooks/useAuth.tsx:48). Backend MFA etkin hesap için boş access token ve challenge döndürür: [authentication.service.ts](/var/aqua-saas/apps/auth-service/src/modules/authentication/services/authentication.service.ts:544). Mobile bunu normal login gibi işler: [useAuth.tsx](/var/aqua-saas/web/apps/aquamobil/src/hooks/useAuth.tsx:346). Mobile-settings hatası/null sonucu true'ya düşebilir: [useAuth.tsx](/var/aqua-saas/web/apps/aquamobil/src/hooks/useAuth.tsx:163), ardından isAuthenticated true atanır: [useAuth.tsx](/var/aqua-saas/web/apps/aquamobil/src/hooks/useAuth.tsx:366).

MFA etkin kullanıcı mobilde challenge'ı tamamlayamaz ve boş token ile yanlış authenticated UI state'ine girebilir. Sunucu tarafında MFA bypass kanıtlanmadı.

Kök çözüm, discriminated login result, MFA challenge ekranı ve yalnız başarılı MFA token'ından sonra authenticated state'tir. Belirsiz mobile-settings cevabı fail-closed olmalıdır.

### CODEX-MEDIUM-013 — HR weekly schedule geçersiz GraphQL filter alanları gönderiyor

Kategori: Doğruluk / frontend-backend sözleşmesi
Durum: NEW
Güven: Yüksek

Canlı schedule route'u WeeklySchedulePage'i açar: [Module.tsx](/var/aqua-saas/web/modules/hr-module/src/Module.tsx:82). Sayfa limit ve offset'i filter nesnesi içine koyar: [WeeklySchedulePage.tsx](/var/aqua-saas/web/modules/hr-module/src/pages/scheduling/WeeklySchedulePage.tsx:187). EmployeeFilterInput bu alanları tanımlamaz: [employee-filter.input.ts](/var/aqua-saas/apps/hr-service/src/hr/dto/employee-filter.input.ts:7); resolver pagination'ı ayrı argüman olarak bekler: [hr.resolver.ts](/var/aqua-saas/apps/hr-service/src/hr/hr.resolver.ts:145).

Normal yükleme GraphQL variable coercion hatası verir ve UI bunu “Çalışan bulunamadı” biçiminde yanlış sunar: [WeeklySchedulePage.tsx](/var/aqua-saas/web/modules/hr-module/src/pages/scheduling/WeeklySchedulePage.tsx:609).

Kök çözüm, generated type kullanan canonical employee query ve transport/schema hatasını boş sonuçtan ayırmaktır.

### CODEX-MEDIUM-014 — SCADA package script'leri runtime widget olaylarına bağlanmıyor

Kategori: Doğruluk / SCADA runtime
Durum: NEW
Güven: Yüksek

Builder package script seçtirir: [EventsPanel.tsx](/var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/widget-configs/EventsPanel.tsx:334). Package loader script'leri Zustand store'a yazar: [projectSlice.ts](/var/aqua-saas/web/modules/sensor-module/src/store/scada/projectSlice.ts:358). Runtime event hook ise window.**scadaScripts** registry'sini okur: [useWidgetEvents.ts](/var/aqua-saas/web/modules/sensor-module/src/hooks/useWidgetEvents.ts:115). Repository'de bu global registry'yi üreten production kod bulunmadı; operator route canlıdır: [Module.tsx](/var/aqua-saas/web/modules/sensor-module/src/Module.tsx:136).

Bu wiring düzeltildiğinde worker'da ikinci hata vardır: bootstrap Function globalini nullar: [workerScript.ts](/var/aqua-saas/web/modules/sensor-module/src/engine/scripting/workerScript.ts:309), handler daha sonra new Function çağırır: [workerScript.ts](/var/aqua-saas/web/modules/sensor-module/src/engine/scripting/workerScript.ts:282). Gerçek worker source'u benign return 2+2 ile yerel VM'de Function is not a constructor üretti.

Kök çözüm, package store kullanan tek script runtime service ve gerçek worker bootstrap'ını kapsayan execution testidir.

### CODEX-MEDIUM-015 — Refund webhook invoice accounting ve refund history'yi yanlış uzlaştırıyor

Kategori: Doğruluk / finansal muhasebe
Durum: NEW
Güven: Yüksek

charge.refunded yalnız handleChargeRefunded çağırır: [stripe-webhook.controller.ts](/var/aqua-saas/apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts:543). Handler payment üzerindeki toplam refunded miktarı alıp bunu her event'te yeni tekil refund entry'si gibi append eder ve invoice status'ünü yalnız full refund'da değiştirir: [stripe-webhook.service.ts](/var/aqua-saas/apps/billing-service/src/billing/controllers/stripe-webhook.service.ts:490), [stripe-webhook.service.ts](/var/aqua-saas/apps/billing-service/src/billing/controllers/stripe-webhook.service.ts:495), [stripe-webhook.service.ts](/var/aqua-saas/apps/billing-service/src/billing/controllers/stripe-webhook.service.ts:511). Normal refund command'i invoice amountPaid/amountDue değerlerini ayrıca günceller: [refund-payment.handler.ts](/var/aqua-saas/apps/billing-service/src/billing/handlers/refund-payment.handler.ts:133).

Stripe dışında başlatılan refund invoice tutarlarını düzeltmez. Birden çok partial refund cumulative toplamı her seferinde append ederek history toplamını şişirir; uygulama içi refund'ın webhook'u duplicate entry üretebilir.

Kök çözüm, provider refund ID ile idempotent tek reconciliation transaction'ı, yalnız uygulanmamış delta ve normal command/webhook için ortak accounting otoritesidir.

## Önceki bulgularla ilişki

Bu rapor eski raporları topluca yeniden etiketlemez. Güncel kaynakta doğrudan eşleşenler bulgunun içinde REVALIDATED veya RESIDUAL olarak işaretlendi:

- OPC UA discovery: Nisan HIGH-002; numeric IP filtresi eklendi fakat adapter discovery ortak DNS guard'ı hâlâ atlıyor.
- Messaging socket expiry/revocation: SEC-HIGH-053 ve SEC-HIGH-054 hâlâ açık.
- ESM SRI: RBAC-DEPLOY-002 hâlâ gerçek module import yolunu kapsamıyor.
- AquaMobil queue/cache: PRODUCT-SYNC-HIGH-001, PRODUCT-TENANT-MEDIUM-003 ve FE-MEDIUM-067 hâlâ üretilebilir.
- Modbus first-device routing: ORPHAN-008 hâlâ açık.
- Billing outbox ve attachment purge: eski düzeltmeler normal/happy path'i kapattı; webhook ve failure-recovery kolları açık kaldı.

## Yükseltilmeyen adaylar ve negatif kanıt

- Messaging UserDeleted event'ini yalnız auth_service sertifika kimliği yayımlayabiliyor: [nats.conf](/var/aqua-saas/infrastructure/docker/nats/nats.conf:32), [nats.conf](/var/aqua-saas/infrastructure/docker/nats/nats.conf:43). Normal event bus subject ile payload tenant'ını eşler: [nats-event-bus.ts](/var/aqua-saas/platform/libs/event-bus/src/nats/nats-event-bus.ts:848). Consumer'ın subject/payload bağını yeniden doğrulamaması defense-in-depth eksikliği olsa da daha düşük yetkili bağımsız saldırı yolu kanıtlanmadı.
- SCADA notification webhook sink'i ham halde riskli görünse de production canonical-command gate çağrıyı kapatır ve activation notification config üretmez; erişilebilir production SSRF olarak yükseltilmedi.
- FUXA SVG script'leri sanitize edilmez, fakat allow-scripts ve allow-same-origin içermeyen sandbox ile default-src none CSP içinde çalışır: [FuxaWidgetRenderer.tsx](/var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/widget-renderers/FuxaWidgetRenderer.tsx:56), [FuxaWidgetRenderer.tsx](/var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/widget-renderers/FuxaWidgetRenderer.tsx:333). Parent source doğrulaması da vardır; stored-XSS bulgusu yapılmadı.
- Custom SVG renderer DOMPurify ve sıkı SVG profili kullanır: [CustomSvgRenderer.tsx](/var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/widget-renderers/CustomSvgRenderer.tsx:16).
- MQTT auth HTTP endpoint'leri broker yetkisini tek başına vermez; broker iç ağ erişimi ve credential olmadan doğrulanmış bypass bulunmadı.
- VFD sort alanları allowlist ile, AI tenant schema interpolasyonu regex/UUID doğrulamasıyla sınırlandırılmıştır; SQL injection olarak yükseltilmedi.
- MessagingFeatureGuard kayıtlı değildir ve fail-open kod içerir, fakat auth permission catalogue messaging'i açıkça lisanslanabilir module değil core özellik olarak tanımlar: [permission-catalogue.ts](/var/aqua-saas/apps/auth-service/src/modules/tenant/services/permission-catalogue.ts:164). Desteklenen entitlement ihlali kanıtlanmadığı için bulgu yapılmadı.
- Tracked secret taramasındaki private-key/API-token eşleşmeleri test kanaryaları ve örnek metinlerdi. sens-api-gateway/certs/suderra-ca.pem geçersiz placeholder'dır fakat güncel runtime tarafından embed edildiğine dair üretim yolu bulunmadı.

## Sınırlamalar

- npm audit güncel advisory endpoint'i sandbox içinde DNS EAI_AGAIN ile başarısız oldu. Dış ağ izniyle tekrar çalışma girişimi iptal edildi. Bu nedenle npm lockfile CVE durumu bu raporda doğrulanmış değildir.
- cargo-audit, gitleaks, trufflehog ve semgrep kurulu değildi. Yeni araç indirilmedi.
- Tam Nx, entegrasyon, canlı PostgreSQL/Redis/NATS veya Rust test paketi çalıştırılmadı; bu denetim kaynak akışı ve küçük yerel kanıtlara dayanır.
- Secret taraması güncel tracked çalışma ağacını kapsadı; bütün Git geçmişi üzerinde dedicated entropy scanner çalıştırılmadı.
- Repo çok büyük ve hareketli olduğundan bu belge mutlak eksiksizlik iddiası taşımaz. 43f0aa3bf anlık görüntüsünde doğrulanan bulguların tamamını ve incelenen adayların negatif sonucunu kaydeder.

## Önerilen kapatma sırası

1. Kimlik üretim sınırını merkezileştir: CODEX-HIGH-001, 002, 003, 005 ve MEDIUM-001.
2. Fiziksel write authority'yi tekleştir ve bulut/edge contract testleri kur: CODEX-HIGH-006, 007, 008, 021; MEDIUM-002 ve 009.
3. Gerçek zamanlı ve shared-infra güven sınırlarını kapat: CODEX-HIGH-010, 012, 013; MEDIUM-003.
4. HR/hydro nesne yetkisini service/handler sınırına taşı: CODEX-HIGH-014, 015, 016.
5. Stripe inbox/outbox ve alert cooldown atomikliğini düzelt: CODEX-HIGH-017, 018, 019; MEDIUM-015.
6. Deploy host fingerprint, OPC egress, SRI ve mobile veri sahipliğini kapat: CODEX-HIGH-009, 011, 020; MEDIUM-004, 005, 006, 007.
