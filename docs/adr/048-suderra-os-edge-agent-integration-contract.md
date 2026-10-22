# ADR-048: Suderra OS – edge agent – bulut entegrasyon sözleşmesi

- **Status:** Accepted — karar, operatörün 2026-10-19 yetki devriyle ("uzman sensin, nasıl
  başlaman gerekiyorsa başla") Claude tarafından alındı; operatör incelemesi ve CODEOWNERS
  (@Okan-wqm) onayı bekleniyor. Uygulama fazlar halinde takip ediliyor (bkz. Uygulama).
- **Date:** 2026-10-19
- **Deciders:** operatör (yetki devri, 2026-10-19), Claude (öneri ve sentez; güvenlik/OT,
  operasyon/filo ve donanım/üretici bakışlarıyla bağımsız eleştiri turu)
- **Relates to:** ADR-014 / ADR-015 (kimlik, kimliği doğrulanmış principal'dır; kendi beyan
  ettiği alan değil), ADR-017 (ST bytecode runtime, program imzası), ADR-018 (edge RBAC/ABAC,
  operatör anahtarları), ADR-019 (edge firmware imzalama, A/B, provisioning blob), ADR-024
  (donanım adapter envanteri, safe-state şeması), ADR-045 (edge çevrimdışı emniyet otoritesidir),
  ADR-047 (cihaz başına MQTT kimliği, client-ID bağlama); Suderra-OS ADR-0004 (RAUC A/B),
  ADR-0005 (dm-verity + Secure Boot), ADR-0007 (ARM doğrulanmış boot + A/B zinciri)
- **Supersedes:** ADR-019 §3–§5 (agent'ın sahip olduğu A/B, tryboot, rescue slot sahipliği) ve
  ADR-019 §2/§6'nın cihaz güven çapalarını agent'ın düzenleyebildiği config'e koyan kısımları —
  Suderra OS profili için. Aynı profilde ADR-019 §8'in 3-pin leaf pinning modeli DEC-10'daki
  CA-anchored modelle değişir. Generic-Linux kanalı (DEC-28) ADR-019'a tabi kalır.

## Karar özeti

| DEC | Karar | Faz | Ana bulgular |
|---|---|---|---|
| DEC-1 | Agent imaja gömülmez; tek kanal root installer, `/data/suderra/edge` ro/exec bind, atomik `current`, her start'ta `verify-current`, tek unit ve kart drop-in'leri | P0; verity imajı P2 | EI-007, EI-017, EI-019, EI-042 |
| DEC-2 | OS'i yalnız RAUC/`suderra-ota`, agent'ı yalnız root installer günceller; agent içi güncelleyiciler derlenmez; dar istek kanalı, `update_seq`, `security_version` | P0; istek kanalı P1; `approvals[]` P2; hava boşluklu ingress P3 | SENSOR-MEDIUM-223, INFRA-MEDIUM-238, EI-039, EI-071 |
| DEC-3 | DSSE, amaç başına anahtar ve epoch, device binding; agent çapaları fleet-root imzalı `suderra.trust-anchors.v1` bundle'ında | P0 (dev/CI anahtarları, dev fleet-root); üretim anahtar seremonisi ve üretim imajları P1; KMS P2 | SENSOR-CRITICAL-202, SENSOR-HIGH-204, SENSOR-HIGH-216, EI-038 |
| DEC-4 | `/etc` RO; `/data` alt ağaçları tek yazıcıyla; yollar derleme zamanı sabiti; site config yalnız imzalı `site-config` ile root üzerinden; geçici machine-id, volatile journal | P0; `kind=site-config` P1 | EDGE-CRITICAL-046, EDGE-CRITICAL-047, EDGE-CRITICAL-048, EDGE-HIGH-050, SENSOR-CRITICAL-200 |
| DEC-5 | Provisioning `/data`'ya bağlı bir boot durumudur: `/run` OTP'si, header'da token, imzalı ve cihaza bağlı manifest, iki fazlı token, root'un doğruladığı receipt, asenkron lockdown, MAINTENANCE'ta yeniden provisioning | P0; USB bundle P1; claim-code P3 | EI-002, EI-003, EI-016, SENSOR-HIGH-205, SENSOR-MEDIUM-218 |
| DEC-6 | `notify(false)`, READY safe-state'ten sonra, degraded mode, kontrol döngüsüne bağlı heartbeat, donanım watchdog'u PID1'in, iki parçalı health gate | P0; PID1 watchdog P1 | EDGE-CRITICAL-049, EDGE-HIGH-051, EDGE-HIGH-052, EI-008, EI-033 |
| DEC-7 | NTS'li chrony, zaman tabanı, time-state ve saat senkron kapısı | P1 | EI-046, EDGE-MEDIUM-077 |
| DEC-8 | Kart kimliği imzalı imajdan; tek kart sözlüğü; (arch, board) release matrisi; RevPi KUNBUS kernel'i ve piControl; x86 ve dev QEMU kernel sembolleri | P0 kernel ve matris; RevPi ve x86 P1 | INFRA-CRITICAL-236, EI-018, EI-020, EI-021, EI-032, EDGE-HIGH-053 |
| DEC-9 | Derleme zamanında Enforcing; tek publisher; platform aktörlü RBAC manifesti; TPI sınıfı P2'ye kadar fail-closed; HMI aynı yetki hattından | P0; e-stop P1; HMI, v4, operatör anahtarları P2 | SENSOR-CRITICAL-201, SENSOR-HIGH-206, EDGE-HIGH-069, EDGE-HIGH-070 |
| DEC-10 | Yalnız 8883 TLS; cihaz başına kimlik bilgisi; `CaAnchored` mTLS, kökler bundle'dan; kısa ömürlü cihaz sertifikaları | P0; özel PKI P2; CSR P3 | INFRA-MEDIUM-239, SENSOR-MEDIUM-219, SENSOR-MEDIUM-232 |
| DEC-11 | Varsayılan deny, fail-closed yükleme, provisioning SSH yalnız varsayılan rota arayüzünde; UID başına egress; imzalı OT allowlist'i | P0; UID egress P1; OT allowlist P2 | EI-021, EI-041, EI-059 |
| DEC-12 | Root-owned yaşam döngüsü; belirsiz durum LOCKED; PROVISIONING yalnız pozitif kanıtla (dev: lifecycle dosyası yoksa); MAINTENANCE P0'da yeniden provisioning için | P0; TPM NV aynası ve RMA P3 | EI-041, EI-044 |
| DEC-13 | Agent SIL değildir; donanımsal kilitleme ve fail-safe kablolama; olay davranış tablosu ve çıkış başına politika | P1 tablo; P2 politika | EDGE-HIGH-058, EDGE-HIGH-060, EDGE-HIGH-065 |
| DEC-14 | x86'da PCR 7 + imzalı PCR 11 ve recovery yolu; RevPi'de OTP secure boot + measured boot; attestation | x86 P1; RevPi ve attestation P3 | EI-037, EI-067 |
| DEC-15 | Fleet-root imzalı `key-epoch-advance`; anahtar başına ihlal runbook'ları; yıllık tatbikat | P2 | — |
| DEC-16 | İmzalı, süreli ve fiziksel varlık isteyen break-glass bakım erişimi | P3 | — |
| DEC-17 | Yeniden provisioning, RMA ve decommission akışları | akış (a) P0; RMA ve decommission P3 | SENSOR-MEDIUM-231 |
| DEC-18 | PARTUUID bağlama, usbguard, konsolsuz prod, yalnız kurulumda rw `/boot`, redundant U-Boot env | P1 | EI-013, EI-034, EI-035, EI-036, EI-050 |
| DEC-19 | Üretim modu ve güvenlikle ilgili yollar env'den okunmaz | P0 | EI-030, EI-039, EI-053, EI-062 |
| DEC-20 | Cache'siz, ayrı imzalama job'u; KMS, reproducible build, provenance admission | P0; KMS ve provenance P2 | INFRA-HIGH-237, INFRA-MEDIUM-244 |
| DEC-21 | Agent P2'ye kadar TPM cihazı almaz; TPM keystore'la (P2) yalnız `/dev/tpmrm0`; TPM kaynak kaydı; rastgele owner/lockout auth | P0 kaldırma; kayıt P1; auth ve `tpmrm0` P2 | EDGE-MEDIUM-099 |
| DEC-22 | Cihaza/tenant'a bağlı ifadelerde `tenant_id`, bundle'da tenant kapsamı; tekdüze public hatalar | P0; KMS tenant kapsamı P2 | SENSOR-LOW-234, SENSOR-LOW-235 |
| DEC-23 | `min_os_version` ve `agent_abi` ile uyumsuz OS/agent çiftinin reddi | P0; OS güncelleme teslimi P1 | — |
| DEC-24 | Read-only root mutable-state tablosu, `REMOUNT_ROOTFS_RW=n`, EROFS testleri | P0; prod-QEMU boot testi P1 | EI-026, EI-010 |
| DEC-25 | `contracts/suderra-edge/` SSoT; her PR'da dev imajında `edge-e2e` QEMU job'u; prod_ab senaryosu release kanıtında | P0; güncelleme/rollback ve prod_ab P1 | EI-023, EI-027 |
| DEC-26 | Suderra OS kiosk sevk etmez; HMI LAN'dan, TLS ve kimlik doğrulamayla | P0; HMI TLS P2 | INFRA-MEDIUM-243, INFRA-MEDIUM-245 |
| DEC-27 | Root'un tipli kurulum/güncelleme sonuçları `/data` ve `/run`'da; agent buluta yayınlar | P0 yerel dosyalar; P1 yayın | — |
| DEC-28 | Generic kanal sözleşmesi dondurulur; HC-1 göçü yeniden imajlamadır; P2'de generic profilde de imzalı komut | P0; P2 | SENSOR-MEDIUM-223, SENSOR-HIGH-208 |

Saha devreye alma kapıları (SG-1…SG-3) ve takip edilen kalıntı riskler (EDGE-MEDIUM-116…EDGE-LOW-127)
Implementation bölümündedir.

Yol kısaltmaları: `Suderra-OS/…` Suderra-OS reposudur; `overlay/…` =
`Suderra-OS/board/suderra/common/rootfs-overlay/…`; önek taşımayan yollar aquaculture_platform
köküne görelidir. Satır numaraları 2026-10-19 itibarıyla doğrulanmıştır.

## Context

### Kapsam

Bu ADR, üç bileşen arasındaki sözleşmenin tek kaydıdır (SSoT). Suderra-OS tarafındaki
yükümlülükler `Suderra-OS/docs/architecture/ADR-0008-edge-agent-integration-contract.md`'de karar
kimliğiyle listelenir; gerekçe yalnız burada tutulur.

| Bileşen | Konum | Rol |
|---|---|---|
| Suderra OS | `Suderra-OS` (Buildroot) | dm-verity RO rootfs, RAUC A/B, LUKS2 `/data`, root installer (`overlay/usr/sbin/suderra-edge-install`, `Suderra-OS/userspace/suderra-installer`), provisioning, lockdown, firewall |
| Suderra edge agent | `sens-api-gateway` (crate `suderra-agent`) | uid 200 `suderra` olarak çalışan ayrıcalıksız süreç: I/O, yerel kontrol, safe-state, MQTT, HMI |
| Bulut | `apps/sensor-service/src/edge-device`, `infrastructure/`, `.github/workflows/edge-agent-release.yml` | release, provisioning manifesti, aktivasyon, broker, komut imzalama |

### Operatör kısıtları (olgu; tartışmaya açık değil)

1. Üretim hedefi 1 (birincil): **RevPi Connect 4 + PiBridge genişleme modülleri**.
2. Üretim hedefi 2: **Windows ile gelen endüstriyel x86 PC'ler**. Windows silinir; üzerinde
   yalnız Linux (Suderra OS) çalışır. x86 modeli **henüz seçilmedi**.
3. Üretim hedefi 3 (ikincil): **RPi4 / CM4**.
4. **Dinamik doğrulama (QEMU) zorunludur.**

### Bugünkü durum: zincir uçtan uca, birbirinden bağımsız noktalarda kırık

Aşağıdaki kırıkların her biri tek başına zinciri durdurur; birini düzeltmek zinciri çalıştırmaz.

| # | Kırık | Kanıt | Sonuç | Bulgular |
|---|---|---|---|---|
| K1 | Agent `SUDERRA_CONFIG`'i yok sayar | `sens-api-gateway/src/config.rs:143` (`DEFAULT_CONFIG_PATH=/etc/suderra/config.yaml`), `:3246-3247` `load()`, `:4239-4240` `save()`; `src/main.rs:247` env yalnız `--init` yolunda okunur; boot yüklemesi `src/main.rs:3189` `AgentConfig::load()`; config-integrity yolu sabit `src/main.rs:3309` | Overlay unit `SUDERRA_CONFIG=/var/lib/suderra/config/config.yaml` verir (`overlay/etc/systemd/system/suderra-agent.service:12`); agent `/etc`'deki var olmayan dosyayı okur | EDGE-CRITICAL-046, EDGE-LOW-103 |
| K2 | `sd_notify(true)` `NOTIFY_SOCKET`'i siler | `src/main.rs:4225` `notify(true, [Ready])`; `:4248` sonraki `WATCHDOG=1` ping'leri no-op; READY `run_agent`'tan önce gider (`:3768` vs `:3775`) | `WatchdogSec=60s` (`overlay/…/suderra-agent.service:22`) ile systemd agent'ı her 60 s'de öldürür | EDGE-CRITICAL-049, EDGE-HIGH-051 |
| K3 | provision-worker sandbox'ı installer'ın yazdığı yolları içermez | `overlay/etc/systemd/system/suderra-provision-worker.service:22-23` (`ProtectSystem=strict`; `ReadWritePaths` `/run/suderra-installer` ve `/var/lib/suderra-installer` içermez, RO `/etc` yollarını listeler) vs `overlay/usr/sbin/suderra-edge-install:142` (`mkdir -p "${STATE_DIR}" "${WORK_DIR}"`, `:5`, `:7`) | Kurulum `set -e` altında EROFS/EACCES ile düşer | EI-001, EI-002, EI-003 |
| K4 | Lockdown, agent'ın hiç yazmadığı bir işareti bekler | `overlay/usr/sbin/suderra-lockdown:41-43` (`/var/lib/suderra/edge/registered` veya `registration.json`); `sens-api-gateway/src/` altında yazıcı yok | Lockdown asla başarılı olmaz; edge-install onu restart'tan hemen sonra senkron çağırdığı için kurulum geri alınır | EI-004 |
| K5 | OS'in beklediği Ed25519 `suderra.edge-provisioning.v1` manifestinin üreticisi yok | OS doğrulayıcısı: `Suderra-OS/userspace/suderra-installer/src/contracts.rs:24`, `:279-299`; bulut imzasız JSON + düz `activation_token` üretir: `apps/sensor-service/src/edge-device/installer-script.service.ts:27-35`, `:243-266`; release yalnız cosign keyless imzalar: `.github/workflows/edge-agent-release.yml:346-366` | Hiçbir manifest doğrulanamaz. Token da cihaza ulaşmaz: bulut token'ı SSH argv'sine koyar (`installer-script.service.ts:236`), `overlay/usr/sbin/suderra-provision:43-50` yalnız `$2`'yi kullanır | SENSOR-HIGH-204, SENSOR-CRITICAL-202, SENSOR-HIGH-205, EI-016 |
| K6 | Release tarball'ındaki binary adı yanlış | `.github/workflows/edge-agent-release.yml:22` (`ARCHIVE_BINARY_NAME: edge-agent`) vs `overlay/usr/sbin/suderra-edge-install:16` (`BIN_NAME=suderra-agent`) | Installer "suderra-agent not found in artifact" ile durur | SENSOR-MEDIUM-224 |
| K7 | Release `gpio` feature'ı içermez; GPIO simülasyon stub'ına düşer | `edge-agent-release.yml:20` (`EDGE_RELEASE_FEATURES: scada-display`); `sens-api-gateway/Cargo.toml:424-425`; `sens-api-gateway/src/gpio.rs:502-508` (derlenmemiş dal uyarı loglar ve `Ok(())` döner) | Yapılandırılmış GPIO çıkışları sessizce sürülmez | INFRA-CRITICAL-236 |
| K8 | RAUC health gate, prod'da kurulamayan agent'ı şart koşar | `Suderra-OS/package/suderra-rauc-config/suderra-rauc-health-gate:25-29` (unit dosyası varsa agent aktif olmalı) | K3–K6 nedeniyle agent'sız her prod cihazda her OS güncellemesi geri alınır | EI-008 |
| K9 | `current` link'i rootfs'te, `releases/` `/data`'da | `overlay/usr/sbin/suderra-data-unlock:18-19` yalnız `/opt/suderra/edge/releases`'i bind eder; `CURRENT_LINK=/opt/suderra/edge/current` (`suderra-edge-install:9`) verity rootfs üzerindedir | Prod'da EROFS; dev'de link slot başınadır, RAUC slot değişiminden sonra `ConditionPathExists` (`suderra-agent.service:6`) başarısız olur | EI-017 |
| K10 | Bulut `CommandEnvelopeSignerService` hiçbir yere bağlı değil | `apps/sensor-service/src/edge-device/command-envelope-signer.service.ts:171` tek referanstır; `edge-device.service.ts:1187`, `:1263`, `:2567` vb. ham komut nesnelerini `tenants/*/devices/*/commands`'e yayınlar | İmzasız komutlar; Enforcing modda cihaz hepsini reddeder | SENSOR-HIGH-206 |
| K11 | `db.key` read-only `/etc` altında oluşturulur | `sens-api-gateway/src/db_secret.rs:71` (`/etc/suderra/db.key`), `:168-246` (`read_or_create_v1_secret`: `create_dir_all` + `create_new`); anahtar ayrıca `HMAC(machine-id, db.key)` ile türetilir (`src/offline_queue.rs`) ve prod imaj firstboot çalıştırmaz (`Suderra-OS/board/suderra/common/post-build.sh:188-189`), yani `/etc/machine-id` her boot'ta yeniden üretilir | Verity'de EROFS; açılabilse bile offline queue, JTI ve RBAC sürüm deposu her reboot'ta okunamaz olur | EDGE-CRITICAL-047, EDGE-CRITICAL-048 |
| K12 | Provisioning token'ı agent kalıcı yazmadan yakılır | `apps/sensor-service/src/edge-device/provisioning.service.ts:357` (kontrol transaction dışında), `:398` (`tokenUsedAt`), `:407` (token `null`) — aynı transaction kimlik bilgilerini döndürür | Agent yanıtı kalıcı yazamazsa cihaz bir daha aktive olamaz; eşzamanlı iki aktivasyon da başarılı olabilir | SENSOR-MEDIUM-218, SENSOR-CRITICAL-200 |
| K13 | RevPi imajı genel bir CM4 imajıdır | `Suderra-OS/configs/suderra_aarch64_revpi4_prod_ab_defconfig:30` (raspberrypi/linux `576cc10…`), `:36` (`bcm2711-rpi-cm4`, `bcm2711-rpi-cm4-io` DTB), `:55` (paylaşılan `aarch64-rpi4/config.txt`); `board/` ve `package/` altında KUNBUS kernel'i, piControl paketi veya `revpi-connect4` overlay'i yok | SPI TPM düğümü (yalnız KUNBUS overlay'inde) görünmez → `suderra-data-unlock:53-57` TPM'siz fail-closed, `/data` açılmaz; PiBridge ve RTC yok | EI-032, EI-018, EI-029 |
| K14 | x86 kernel config'i üretime uygun değil | `Suderra-OS/board/suderra/x86_64/linux-x86_64.config`: `DM_CRYPT` yok (`:69` yalnız yorumlu `DM_VERITY`), `:80` yalnız `CONFIG_NF_TABLES=y` (`NF_TABLES_INET`/`NFT_CT`/`NFT_LIMIT` yok), hiçbir `CONFIG_USB*` yok | LUKS `/data` açılmaz; `nftables.conf` (inet tablo, `ct state`, `limit`) yüklenmez → firewall kuralsız açılır (`overlay/etc/systemd/system/nftables.service:5-8` yalnız Wants; `overlay/usr/sbin/suderra-firewall:10` düz `exec nft -f`) | EI-020, EI-021, EI-043 |

Üç bileşeni birlikte çalıştıran bir test yoktur.
`Suderra-OS/tests/image-contracts/edge-agent-unit-contract-test.sh:15` sevk edilmeyen
`package/suderra-edge-agent/suderra-agent.service`'i test ederken sevk edilen overlay unit'i
`/dev/watchdog` ve `/dev/tpm0` erişimi verir
(`overlay/etc/systemd/system/suderra-agent.service:69-70`; EI-042).

### Eleştiri turu ve kabul kuralı

Taslak 11 karar üç bağımsız bakışla eleştirildi: güvenlik/OT (SEC), operasyon/filo (OPS),
donanım/üretici (HW). Kural: güvenliği/emniyeti güçlendiren veya olgusal bir hatayı düzelten her
değişiklik, bir operatör kısıtıyla ya da kabul edilmiş başka bir değişiklikle çelişmedikçe kabul
edildi. Çatışmada fiziksel çıkışlar, anahtarlar ve boot bütünlüğü için güvenlik/emniyet; sıralama ve
geçiş için operasyon bakışı esas alındı. Önerilerin çoğu olduğu gibi alındı. Aşağıdaki tablo olduğu
gibi alınmayan her öneriyi kaydeder.

#### Kabul edilmeyen / değiştirilerek alınan öneriler

Kimlikler `<bakış> DEC-<taslak karar> A<n>` (değişiklik önerisi) veya `<bakış> M<n>` (eksik karar
önerisi) biçimindedir. "Fazı değişti" önerinin içeriğinin alındığını, ama daha geç bir fazda
uygulandığını gösterir.

| Öneri | Sonuç | Uygulanan kural ve gerekçe |
|---|---|---|
| Her release'i kernel keyring imzalı verity imajı olarak sevk et; IPE ile exec'i verity'ye bağla (SEC DEC-1 A1, HW DEC-1 A3) | Fazı değişti: P0'da `verify-current` (DEC-1.5); P2'de EROFS + dm-verity release imajı ve kernel'in zorladığı root hash imza doğrulaması (`DM_VERITY_VERIFY_ROOTHASH_SIG` veya IPE), aynı P2 işinin parçası olarak (DEC-1.6) | Olgu: kernel Ed25519 doğrulayamaz; root hash imzası ayrı bir X.509 `edge-image` anahtarı (RSA veya ECDSA) ister ve bu anahtar P2'de KMS ile gelir (DEC-3.3). Takip: EDGE-MEDIUM-116 |
| Installer durumu `/data/suderra/edge/state`'te (OPS DEC-1 A3) | Değiştirilerek: `/data/suderra/os/edge/` (root:root 0700) | Güvenlik: receipt ve floor exec ağacından (0755) ayrı tutulur ve yalnız root okur (DEC-1.3) |
| Start'ta `verify-installed` veya ext4 fs-verity (OPS DEC-1 A4) | Değiştirilerek: `verify-current`, P2'de verity imajı; fs-verity seçilmedi | Tek bütünlük mekanizması: verity imajı exec anını zaten korur; fs-verity ikinci bir format olurdu |
| TPI onay kanıtı bulut imzalı güncelleme manifestinde, root doğrular (SEC DEC-2 A2) | Fazı değişti: P1'de sunucu tarafında iki kişilik onay, P2'de `edge-update.v2` + cihazda `approvals[]` | Sıralama: operatör anahtarları P2'de gelir (DEC-9.4). Takip: EDGE-MEDIUM-117 |
| Hava boşluklu sahalara USB/LAN ortamıyla imzalı güncelleme (OPS DEC-2 A7) | Fazı değişti: P3 (DEC-2.11). P1–P3 arasında bu sahalar MAINTENANCE'ta USB provisioning bundle'ıyla yeniden provision edilerek güncellenir | ACTIVE'de USB depolama kapalıdır (DEC-18.2); ingress MAINTENANCE ister. Takip: EDGE-MEDIUM-118 |
| Agent'ın yazdığı `registered`/health işareti: lockdown, health gate ve güncelleme sağlığı bu işarete bağlanır (OPS DEC-2 A5, OPS DEC-5 A6, OPS DEC-5 A7, OPS DEC-6 A5, HW DEC-2 A4, HW DEC-6 A6) | Reddedildi; yerine root'un doğruladığı activation receipt ve yaşam döngüsü ACTIVE kullanılır | Güvenlik: agent'ın yazdığı bir işaret kayıt kanıtı değildir (SEC DEC-5 A8; K4) |
| Sonuçlar `$DATA/state/*-result.json`'da (OPS DEC-2 A4, OPS M8) | Değiştirilerek: `/data/suderra/os/results/` ve `/run/suderra/results/` (DEC-27) | Güvenlik: root agent ağacına yazmaz (DEC-4.3) |
| İmzalama baştan KMS/OIDC ile (SEC DEC-3 A7, SEC DEC-3 A8, OPS DEC-3 A6) | Fazı değişti: KMS P2'de. P0'da yalnız dev/CI anahtarları vardır; P1 seremonisi seremoni kökenli offline fleet-root ve edge-release anahtarlarını üretir; online anahtarlar P2'ye kadar servis secret'larındadır (DEC-3.9) | KMS sağlayıcısı operatör seçimidir (Soru 5); hiçbir donanım prod imajı dev/CI anahtarı pinleyemez (DEC-3.9, invariant). Online anahtarların KMS dışında olması SG-1 izleme amaçlı pilotları için kabul edilmiştir. Takip: EDGE-HIGH-119 |
| x86'da DMI `product_uuid` ile device binding (OPS DEC-3 A3) | Reddedildi; yalnız TPM'siz dev/QEMU imajlarında | Olgu: endüstriyel kartlarda sıklıkla benzersiz değildir (HW DEC-3 A2); TPM EK esastır (DEC-3.6) |
| Ayrık imza dosyası `<artifact>.ed25519.sig` (OPS DEC-3 A5, OPS DEC-8 A11) | Değiştirilerek: `<artifact>.release.dsse.json` | Olgu: ham tarball değil release statement imzalanır (SEC DEC-3 A3) |
| Agent config-integrity çapası env ile verilen OS yolundan (OPS DEC-3 A7) | Değiştirilerek: çapa fleet-root imzalı trust-anchor bundle'ındaki `config-integrity` anahtarıdır; yollar derleme zamanı sabitidir | Güvenlik: env herhangi bir drop-in ile değişir (DEC-19) |
| ADR-019 §2/§6 Suderra OS'te de aynen yürürlükte (OPS DEC-2 A2) | Değiştirilerek: §2/§6'nın cihaz güven çapalarını agent'ın düzenleyebildiği config'e koyan kısımları Suderra OS profilinde değişir | Güvenlik: kademeli güven çapaları (SEC DEC-3 A6) |
| `config.yaml`'ı ikiye böl; io_config ve Modbus cihaz listesi agent'a ait `$DATA/config`'te; ADR-024 §8 donanım envanteri de oraya (OPS DEC-4 A2, HW DEC-4 A3) | Reddedildi | Emniyet: I/O haritası ve fieldbus envanteri fiziksel çıkışları belirler; ele geçirilmiş agent bunları değiştirememelidir. Değişiklik imzalı `site-config` ifadesiyle root üzerinden gelir: P0'da yeniden provisioning, P1'de `kind=site-config` (DEC-4.12) |
| Kalıcı, donanımdan türetilmiş machine-id; `/data`'dan `/etc/machine-id` üzerine bind (OPS DEC-4 A5, HW DEC-4 A2) | Reddedildi; geçici machine-id korunur | Kalıcı hiçbir şey ona bağlanmaz: journald `Storage=volatile`, networkd `ClientIdentifier=mac`, agent kimliği OS kimlik dosyasından, DB anahtarı rastgele (DEC-4.8, DEC-4.9) |
| Kalıcı journal `/data/log/journal`'da, boyut sınırlı (OPS M1) | Reddedildi; HW M7'nin volatile seçeneği alındı | Kalıcı kanıt `/data`'daki agent audit log'u ve DEC-27 sonuç telemetrisidir; `/data` (RevPi prod'da 2G) offline queue ile paylaşılır (DEC-4.9) |
| Agent kimliği `SUDERRA_MACHINE_ID_PATH` ile okunur (SEC DEC-4 A5, OPS DEC-4 A5) | Değiştirilerek: Suderra OS profilinde derleme zamanı sabiti `/run/suderra/identity.json`; env yalnız generic profilde | Güvenlik: DEC-19 |
| `db.key` ve keystore sırları `LoadCredentialEncrypted=` ile (OPS DEC-4 A6) | Değiştirilerek: P0'da agent'ın ürettiği rastgele `secrets/db.key` (0400); TPM mühürü veya `LoadCredentialEncrypted=` P2'de (EDGE-MEDIUM-099) | Sıralama: TPM keystore bugün yalnız trait ve mock'tur |
| Provisioning birimlerine `ConditionPathExists=!/var/lib/suderra/.appliance-locked` (OPS DEC-5 A1, HW DEC-4 A1, HW DEC-5 A1) | Reddedildi; kendiliğinden kapanma (OTP süresi) alındı | Güvenlik: bir kilit işaretinin yokluğu provisioning açmaz (SEC DEC-5 A1, A2); PROVISIONING yalnız pozitif kanıtla başlar (DEC-12) |
| OTP `/data`'da saklanır (OPS DEC-5 A2, HW DEC-5 A2) | Değiştirilerek: OTP yalnız `/run`'da, her boot'ta yeniden üretilir (DEC-5.2) | Güvenlik: kalıcı kimlik bilgisi bırakılmaz |
| Inbound portsuz cihaz-çekme eşleştirmesi SSH push yerine (SEC DEC-5 A5) | Fazı değişti: claim-code + PoP P3'te varsayılan olur; P0–P2'de SSH push | Sıralama: PoP, TPM anahtarı ve attestation (P3) ister. Takip: EDGE-LOW-125 |
| Aktivasyonda cihaz anahtarına sahiplik kanıtı (proof-of-possession) (SEC DEC-5 A6) | Fazı değişti: P3, CSR ve cihaz anahtarlarıyla birlikte (DEC-10.7). P0–P2'de aktivasyon bağlaması provisioning token'ı, imzalı manifestteki `device_binding` hash'i ve bulut imzalı activation receipt'idir (DEC-5.7, DEC-5.8) | Sıralama: PoP, TPM'de üretilen cihaz anahtarı ve EK bağlaması (P3) ister; bugün cihaz anahtarı yoktur (EDGE-MEDIUM-099, SENSOR-MEDIUM-232). Takip: EDGE-MEDIUM-126 |
| USB provisioning bundle ingress ve RevPi durum LED'leri (OPS DEC-5 A8, HW DEC-5 A4) | Fazı değişti: P1 | Sıralama: P0 ağ yolunu çalıştırır |
| RMA'da bulut kaydı REGISTERED kalır; tetik düğme veya bulut imzalı seri konsol challenge'ı (OPS DEC-5 A10, OPS M3) | Değiştirilerek: bulut kaydı RMA olur; imzalı RMA token'ı + fiziksel varlık; P3 (DEC-17) | Güvenlik (SEC M6) |
| `/data` "yeniden oluşturulabilir" ilan edilsin, unseal hatası re-provision'a gitsin (HW M1, alternatif) | Diğer alternatif (bulut emanetli recovery key) seçildi (DEC-14.3) | Operasyon: offline queue ve audit zinciri kaybolmamalıdır |
| Kritik unit'lerde `FailureAction=`/`StartLimitAction=reboot` (HW DEC-6 A1) | Reddedildi | Emniyet: agent hatası OS reboot'una tırmanmaz; reboot çıkışları keser (DEC-6.5) |
| `suderra-watchdog`'u NOWAYOUT ve REQUIRE_HW ile tutma seçeneği (SEC DEC-6 A4, OPS DEC-6 A4) | Reddedildi; tek sahip PID1 | Daha küçük TCB, PID1 kilitlenmesini de kapsar (DEC-6.6) |
| PID1 `RuntimeWatchdogSec=30s` (OPS DEC-6 A4) | Değiştirilerek: kart başına, donanım maksimumunun altında (BCM2835 ≈15 s) | Olgu (HW DEC-6 A2) |
| Bootstrap için provisioning API'den Roughtime benzeri imzalı zaman token'ı (SEC DEC-7 A5, isteğe bağlı) | Alınmadı | Zaman tabanı + NTS yeterlidir; provisioning API'yi zaman otoritesi yapmak bulut ihlalinde saati geri alma yolu açar |
| ARM'da DT `compatible`, x86'da DMI ile kart tespiti (HW DEC-1 A5, HW DEC-8 A4) | Değiştirilerek: kart kimliği imzalı imajdan (`/etc/suderra/board`); DT `compatible`/DMI yalnız çapraz kontroldür | Güvenlik: cihazın kendi beyanı fiziksel I/O seçimini belirlemez (SEC DEC-8 A1) |
| Overlay unit'e `DeviceAllow=/dev/piControl0` (OPS DEC-8 A2) | Değiştirilerek: kart drop-in'i (DEC-1.8) | Tek unit, kart başına cihaz (HW DEC-1 A4) |
| Her OS profiline `tpm` feature'ı (OPS DEC-8 A3) | Değiştirilerek: yalnız TPM'li kartlar (RPi4/CM4'te yalnız add-on varsa) ve P2'de TPM keystore ile (DEC-21) | Olgu: RPi4/CM4'te TPM yoktur; TPM keystore bugün yalnız trait ve mock'tur (EDGE-MEDIUM-099) |
| Yapılandırılmış ama bulunamayan donanım release'te başlangıç hatası (OPS DEC-8 A4) | Değiştirilerek: degraded mode (DEC-6.3) | Emniyet: çıkış yerine kalıcı safe-state; crash-loop çıkışları tekrar tekrar değiştirir (SEC DEC-8 A4) |
| RPi4/CM4'ü yalnız kritik olmayan sahalara sınırla, add-on TPM iste veya yalnız geliştirme/test amaçlı ilan et; müşteri OTP değeriyle bağlama (SEC DEC-8 A6, OPS DEC-8 A8, HW DEC-8 A7, HW DEC-3 A2) | Operatör kararına bırakıldı (Soru 3); OTP değeri önerilen varsayılandır | Geri dönüşsüz ve BOM'u etkiler. Takip: EDGE-MEDIUM-120 |
| RevPi üretiminde OTP secure boot zorunlu (HW M1) | Operatör kararına bırakıldı (Soru 7); öneri: P3'te, KUNBUS'un yazılı görüşünden sonra | Fuse geri dönüşsüzdür ve kurtarma akışını değiştirir |
| RevPi üretimi için asgari 32 GB eMMC SKU'su (HW M7) | Operatör kararına bırakıldı (Soru 6); öneri: 32 GB | SKU/BOM seçimi |
| Yaşam desteği için bağımsız donanımsal kilitleme ve fail-safe kablolama (SEC M2) | Teknik içerik alındı (DEC-13.1); müşteri yükümlülüğü olarak bağlanması operatör kararıdır (Soru 8) | Sözleşme ve devreye alma etkisi |
| Operatör başına, operatörün tuttuğu komut anahtarları; RBAC aktör → anahtar (SEC DEC-9 A2, OPS DEC-9 A2) | Fazı değişti: P2. P0–P2'de tek platform aktörü; TPI sınıfı komutlar fail-closed reddedilir (DEC-9.4) | Sıralama: operatör anahtar altyapısı yok. Takip: EDGE-MEDIUM-121 |
| Envelope v4 (device bağlaması), v3 yalnız generic'te (SEC DEC-9 A1, OPS DEC-9 A3) | Fazı değişti: v4 P2'de; o zamana kadar `suderra-os` v3 kabul eder | Takip: EDGE-MEDIUM-122 |
| Enforcing'e yalnız publisher, operatör anahtarlı RBAC manifesti ve saat kapısı hazır olduktan sonra geçiş (OPS DEC-9 A6) | Değiştirilerek: Enforcing P0'da derlenir; publisher, platform aktörlü RBAC manifesti ve bundle da P0'dadır; saat kapısı P1'dedir (EDGE-MEDIUM-077); fiziksel aktüasyonlu dağıtım SG-1'e (P2 çıkışı) bağlıdır | Güvenlik: imzasız yolun açık kalması daha büyük risktir (SENSOR-CRITICAL-201); sıralama kilitlenmesi aynı fazda çözülür |
| Yerel HMI kimlikleri, TLS, kilitlenme ve çıkış başına e-stop (SEC DEC-9 A6, OPS DEC-9 A7) | Fazı değişti: e-stop kalıcılığı ve kapsamı P1, HMI authz/yönlendirme/TLS P2 | Telafi: SG-1 (P2 çıkışından önce fiziksel aktüasyonlu saha yok) |
| RBAC manifesti `$DATA/policy`'de (OPS DEC-9 A8) | Değiştirilerek: `/data/suderra/site/` (root yazar, agent salt okur; DEC-9.9) | Güvenlik: agent ağacında olmaz |
| Cihaz sertifikası ömrü azami çevrimdışı süreyi aşar (OPS DEC-10 A4) | Reddedildi; kısa ömür ve otomatik yenileme alındı (SEC DEC-10 A5) | Anahtar konusu: güvenlik bakışı esastır. Operasyon kaygısı DEC-10 Sonuçlar'da risk olarak kayıtlıdır; çevrimdışıyken süresi dolan cihaz PoP ile teknisyensiz yeniden sertifika alır (DEC-10.7). Takip: EDGE-LOW-127 |
| Özel cihaz PKI'si; current + next kökler imajda (SEC DEC-10 A2) | Fazı değişti: özel PKI P2'de (DEC-10.4); current + next kökler imaja değil fleet-root imzalı trust-anchor bundle'ına girer (DEC-3.7) | Olgu: broker uç noktası bugün Let's Encrypt sertifikası sunar (`infrastructure/nginx/droplet.conf:36-37`). P2'ye kadar üretim bundle'ındaki kamu ISRG kökleri yalnız sunucu kimlik doğrulaması içindir; cihaz kimliği hiçbir zaman kamu CA'sından türetilmez (P3'e kadar cihaz başına kimlik bilgisi, P3'te özel PKI'den CSR sertifikası; DEC-10.3, DEC-10.7). Kökler bundle'dadır, çünkü agent çapaları OS imajına pinlenmez ve rotasyon bundle'la yapılır. Takip: EDGE-MEDIUM-123 |
| Kamu LE kalırsa ISRG köklerini pinle (HW DEC-10 A4) | Değiştirilerek: P2'ye kadar üretim bundle'ındaki MQTT CA kümesi ISRG köklerini içerir; P2'de yalnız özel cihaz PKI'si | Takip: EDGE-MEDIUM-123 |
| Agent unit'ine `Requires=`/`After=nftables.service` (HW DEC-11 A1) | `After=` kabul edildi, `Requires=` reddedildi | Emniyet: firewall hatası yerel kontrol döngüsünü durdurmamalıdır; ağ zaten açılmaz (DEC-11.2) |
| UID başına egress ve imzalı site politikası için tipli renderer (SEC DEC-11 A3, A5; OPS DEC-11 A4, A5) | Fazı değişti: UID egress P1, imzalı OT allowlist ve renderer P2 | Takip: EI-059 |
| TPM NV sayacıyla floor ve epoch çapası (HW DEC-3 A4) | Fazı değişti: P0'da root-owned dosya, NV aynası P3 (DEC-12, DEC-21) | Takip: EDGE-MEDIUM-124 |
| Yerel kiosk varyantı (OPS M7, HW M8) | Reddedildi; uzak HMI (DEC-26) | Boyut bütçesi ve ayrı güvenlik incelemesi; Buildroot Chromium paketlemez |

Eleştirilerin ortaya çıkardığı eksik kararlar DEC-12…DEC-28 olarak eklendi.

## Decision

**Suderra OS kök güvendir: agent'ın kurulumunu, güncellenmesini, kimliğini, ağını, zamanını,
donanım watchdog'unu ve yaşam döngüsünü root olarak sahiplenir. Agent ayrıcalıksız bir
uygulamadır, yalnız kendi veri dizinine yazar ve fiziksel çıkışların tek yazıcısıdır. Bulut,
amaç başına ayrı anahtarla imzalanmış, cihaza bağlı ifadeler üretir. Her sınır imzalı, şemalı ve
üç bileşende aynı golden fixture'larla test edilen bir sözleşmedir; hata durumunda süreç ayakta
kalır, çıkışlar donanım safe-state'inde tutulur, alarm yükselir.**

### Sahiplik matrisi

| Varlık | Sahip ve tek yazıcı | Okuyan |
|---|---|---|
| OS imajı, bootloader, boot config, platform firmware'i | RAUC / `suderra-ota` | — |
| Agent binary ve `current` | OS root installer (`suderra-installer edge`) | systemd (exec) |
| Site config (`config.yaml`, RBAC manifesti, trust-anchor bundle, site politikası, PiCtory `config.rsc`) | OS root installer, imzalı payload'dan | agent (salt okunur) |
| Agent çalışma durumu (state, secrets, queue, scripts, policy-cache) | agent | root yalnız kopyalayarak okur |
| Cihaz kimliği, yaşam döngüsü durumu, receipt'ler, floor'lar, ratchet'ler | OS root | agent `/run/suderra/` görünümünden |
| Firewall ruleset'i | OS root, imzalı politikadan | — |
| Sistem saati ve zaman tabanı | chrony + OS root yardımcıları | agent `/run/suderra/time-state`'ten |
| Donanım watchdog'u | systemd PID1 | — |
| Fiziksel çıkışlar | agent, imzalı çıkış politikası içinde | — |
| Güven çapaları | OS imajı (pinli anahtarlar) + fleet-root imzalı bundle | installer, agent |

Her karar beş parçadan oluşur: Karar, Gerekçe, Sonuçlar/Riskler, Uygulama (dosyalar), Faz.

---

### DEC-1 — Agent teslim kanalı ve unit SSoT

**Karar.**

1. Agent OS imajına gömülmez. `Suderra-OS/package/suderra-edge-agent/` silinir; hiçbir defconfig
   `BR2_PACKAGE_SUDERRA_EDGE_AGENT`'ı set etmez ve imajda tek bir `suderra-agent.service` vardır
   (invariant).
2. Tek kanonik kanal: OS root installer, DEC-3'teki imzalı ifadeleri tüketir. Teslim ortamı ağ
   (manifesti cihaz kendisi çeker) veya imzalı USB provisioning bundle'ıdır (DEC-5); ikisi aynı
   doğrulayıcıdan geçer.
3. Yerleşim: `/data/suderra/edge` (root:root 0755) `/opt/suderra/edge` üzerine
   `ro,nosuid,nodev,exec` ile bind edilir; içinde `releases/<version>/` ve `current` symlink'i
   bulunur. Yetkili kurulum kaydı (install receipt: version, security_version, sha256, release
   statement digest, key epoch, board profile) root-owned `/data/suderra/os/edge/` altındadır.
   En fazla iki release (current + previous) tutulur, eskisi silinir.
4. Geçiş atomiktir: yeni symlink ara adla oluşturulur ve `rename(2)` ile `current`'ın üzerine
   taşınır. `ln -sfn` (unlink + symlink) kullanılmaz; o pencerede link yoktur ve unit "failed"
   değil "condition failed" olur, hiçbir şey alarm vermez.
5. Her start'tan önce `ExecStartPre=+/usr/bin/suderra-installer edge verify-current` çalışır:
   `current`'ın receipt'teki release'i gösterdiğini, binary sha256'sını ve release statement
   imzasını root olarak yeniden doğrular; uyuşmazlıkta start reddedilir ve alarm sonucu yazılır
   (DEC-27).
6. Hedef format: her release imzalı read-only imajdır (EROFS + dm-verity hash tree). Release
   statement verity root hash'ini taşır; installer imajı `veritysetup` ile map eder ve kernel her
   sayfa okumasında doğrular. Root installer release statement'ın Ed25519 imzasını doğrular. Root
   hash imzasını ayrıca kernel zorlar: kernel Ed25519 doğrulayamadığından root hash ayrı bir X.509
   `edge-image` anahtarıyla (RSA veya ECDSA; DEC-3.3) PKCS#7 olarak imzalanır, sertifika kernel'in
   trusted keyring'ine build'de gömülür ve imaj `veritysetup --root-hash-signature` ile map edilir
   (`CONFIG_DM_VERITY_VERIFY_ROOTHASH_SIG=y`); seçilen kernel'de IPE LSM varsa exec'i imzalı verity
   cihazlarına bağlayan politika aynı amaca hizmet eder. Bu zorlama P2 verity release imajı işinin
   parçasıdır (EDGE-MEDIUM-116). ARM fragment'larına `CONFIG_BLK_DEV_LOOP` eklenir (x86'da var:
   `linux-x86_64.config:49`).
7. `/data` `nosuid,nodev,noexec` bağlanır (bugün seçeneksiz). Tek exec konumu doğrulanmış release
   mount'udur.
8. Unit SSoT: `overlay/etc/systemd/system/suderra-agent.service` Suderra OS için tek unit'tir. Karta
   özgü cihaz erişimi imajdaki drop-in'lerle gelir
   (`suderra-agent.service.d/10-board-<profile>.conf`): revpi `/dev/piControl0`, `/dev/ttyAMA5`; rpi
   `/dev/gpiomem`, `/dev/i2c-1`, `/dev/spidev0.*`, `/dev/ttyAMA0`; x86 `ttyS*`/`ttyUSB*`/`ttyACM*`
   ve `AF_CAN`. Bugün tek unit her kartta RPi cihaz listesini verir (`suderra-agent.service:63-72`).
   Agent unit'inden `/dev/watchdog`, `/dev/tpm0` ve `/dev/tpmrm0` kaldırılır (`:69-71`); P0–P1'de
   agent hiçbir TPM cihazı almaz. `/dev/tpmrm0` P2'de, TPM keystore etkinleştiğinde, yalnız `tpm`
   feature'lı profilin kart drop-in'iyle verilir (DEC-21; EDGE-MEDIUM-099; SEC M10, SEC DEC-1 A4).
   `CAP_NET_BIND_SERVICE` (`:30-31`) kaldırılır (1024 altında bind yok). Cihaz node sahipliği imaj
   udev kuralıyla (`/dev/piControl0` 0660 root:suderra-io, seri portlar `dialout`; P2'den
   `tpmrm0` grup `tss`) ve `SupplementaryGroups=` ile verilir.
9. `sens-api-gateway/systemd/suderra-agent.service` generic-Linux referansıdır; bulutun ürettiği
   fleet unit'i (`installer-script.service.ts` içindeki heredoc) bu dosyadan üretilir. Overlay ve
   referans unit arasında güvenlik açısından anlamlı direktif kümesi (sandbox, cihazlar,
   capability'ler, yollar, sıralama) metin olarak değil küme olarak contract testle karşılaştırılır;
   yalnız yollar ve `ExecStart` farklı olabilir. Referanstaki `Requires=time-sync.target` (`:33`)
   `Wants=` olur (DEC-7).
10. Installer imzalı girdiye de savunma derinliğiyle davranır: `version` katı, yol-güvenli bir
    semver regex'iyle eşleşir (yol bileşeni olarak kullanılır); `binary_name` tam olarak
    `suderra-agent`'tır (bugün `find -name … | head -n1`); tar `--no-same-owner
    --no-same-permissions` ve tek, tam üye yoluyla açılır. İndirme, açma ve geçiş `/bin/sh` yerine
    Rust doğrulayıcıda yapılır (`openat`, `O_NOFOLLOW`).

**Gerekçe.** Agent'ı imaja gömmek her agent sürümü için bir OS release'i ve RAUC reboot'u
gerektirir; reboot havalandırma/pompa çıkışlarını keser. İmaj dışındaki kod ise verified-boot
zincirinin dışındadır; bu yüzden bütünlük yalnız kurulumda değil her exec'te yeniden kurulur. LUKS2
gizlilik sağlar, bütünlük sağlamaz; ARM'da `/data` mühürü bugün hiçbir ölçüme bağlı değildir
(DEC-14), yani `/data`'yı açabilen herkes binary'yi değiştirebilir. Tek unit ve tek kanal, K6/K9
türü sapmaların bir daha oluşamamasını sağlar.

**Sonuçlar / Riskler.**

- Fabrikada agent önceden yüklenemez: `/data` ilk boot'ta cihazda LUKS'la formatlanır. Her cihaz
  agent'ını ağdan veya USB bundle'dan alır; hava boşluklu sahalar USB ingress'e bağlıdır.
- P0'daki tar.gz formatında `verify-current` start anını korur, çalışan süreç sırasında `/data`
  üzerindeki değişikliği korumaz; verity imaj formatı ve kernel'in zorladığı root hash imzası (P2)
  bunu exec anında kapatır (EDGE-MEDIUM-116).
- `/data` kapasitesi: RevPi prod `genimage-prod.cfg`'de `/data` 2G'dir; bütçe iki release ve
  offline queue içindir, journal volatile'dır (DEC-4.9, DEC-24).
- Paket silindiğinde `/var/lib/suderra/config` sahiplik tanımı (`suderra-edge-agent.mk`) OS'in tek
  sahiplik yazıcısına taşınır (DEC-4).

**Uygulama.**

- Suderra-OS: `overlay/usr/sbin/suderra-data-unlock` (bind'ler, mount seçenekleri, çakışan
  chown'ların kaldırılması); `board/suderra/common/post-build.sh` (tüm mountpoint'ler build'de);
  `overlay/usr/sbin/suderra-edge-install` → `userspace/suderra-installer/src/cmd/edge.rs` (yeni;
  `edge install|verify-current|rollback|request`), `src/cli.rs`, `src/contracts.rs`;
  `overlay/etc/systemd/system/suderra-agent.service` ve `suderra-agent.service.d/` (yeni);
  `overlay/usr/lib/udev/rules.d/60-suderra-devices.rules` (yeni); `package/suderra-edge-agent/`
  silinir, `Config.in`, dokuz `configs/*_defconfig`,
  `tests/image-contracts/rust-workspace-contract-test.sh`, `.github/dependabot.yml`,
  `docs/architecture/ARCHITECTURE.md`, `ROADMAP.md`, `README.md` güncellenir;
  `tests/image-contracts/edge-agent-unit-contract-test.sh` overlay unit'e ve drop-in'lere yeniden
  hedeflenir.
- aquaculture_platform: `sens-api-gateway/systemd/suderra-agent.service`;
  `apps/sensor-service/src/edge-device/installer-script.service.ts` (fleet unit'i referans
  dosyadan üretme); `sens-api-gateway/tests/invariants/systemd_unit_directive_contract.rs` (yeni);
  direktif allowlist'i `contracts/suderra-edge/v1/unit-directives.json` (yeni, DEC-25).
- Kapatılan bulgular: EI-007, EI-017, EI-019, EI-042, EI-064 (P0); EI-069 (paketin silinmesiyle,
  P0); EI-070 (doküman adları, P0); EDGE-MEDIUM-116 (verity release imajı ve kernel'in zorladığı
  root hash imzası, P2).

**Faz.** P0: yerleşim, bind, mount seçenekleri, atomik geçiş, `verify-current`, unit SSoT ve
drop-in'ler, paketin silinmesi, girdi savunması. P2: verity imaj formatı ve kernel'in zorladığı root
hash imzası (EDGE-MEDIUM-116).

---

### DEC-2 — Güncelleme sahipliği

**Karar.**

1. OS imajı yalnız RAUC/`suderra-ota` ile, agent binary'si yalnız OS root installer ile güncellenir.
   Agent hiçbir zaman binary, boot config, bootloader env veya platform/I/O firmware'i yazmaz ve
   servis yönetmez: `reboot` ve `restart_agent` komutları (bugün ayrıcalıksız kullanıcıyla
   `shutdown`/`systemctl` çağırıp başarı raporlar, `src/commands/system.rs:105-109`, `:154-165`)
   `suderra-os` profilinde derlenmez; yeniden başlatma yalnız root istek kanalından (madde 3) gelir.
2. Bugün altı güncelleme yolu vardır; her biri için karar:

   | # | Yol | Kanıt | Karar |
   |---|---|---|---|
   | 1 | RAUC / `suderra-ota` | `Suderra-OS/package/suderra-ota/`, `package/suderra-rauc-config/` | Tek OS yolu |
   | 2 | `suderra-edge-install` (root) | `overlay/usr/sbin/suderra-edge-install` | Tek agent yolu; Rust `suderra-installer edge`'e taşınır |
   | 3 | Agent legacy tarball OTA | `sens-api-gateway/src/commands/firmware.rs:92-101` (Permissive → `AllowWithWarn`) | `os-managed-updates` feature'ında derlenmez |
   | 4 | Agent `apply_signed_manifest` / `confirm_slot` / tryboot A/B | `src/commands/apply_signed_manifest.rs`, `src/commands/confirm_slot.rs`, `src/updater/{tryboot,partition,partition_store}.rs` | Aynı. tryboot, RAUC/U-Boot'un kullandığı FAT boot bölümüne RPi firmware `autoboot.txt` yazar: tek bölümde iki bağımsız A/B seçici |
   | 5 | `suderra-installer install/upgrade/rollback/remove` (apt benzeri paket yolu, cosign keyless, env ile ezilebilen varyant kapısı) | `Suderra-OS/userspace/suderra-installer/src/cmd/install.rs:1-12`, `:502-510`; `src/variant.rs:30-37` | Suderra OS prod build'inden derleme zamanında çıkarılır |
   | 6 | USB payload installer | `contracts.rs` usb-payload, `package/suderra-os-installer/` | OS kurulumu ve kurtarma için kalır; USB provisioning bundle (DEC-5) yol 2'nin doğrulayıcısını kullanır, ayrı bir yol değildir |

3. Agent'ın güncelleme isteği dar bir kanaldır: agent `$SUDERRA_DATA_DIR/update-requests/` altına
   ara adla yazıp `rename` eder; root `suderra-edge-request.path` tetiklenir. Root worker dosyayı
   `openat(O_NOFOLLOW|O_NONBLOCK)` ile açar, düzenli dosya ve boyut sınırını `fstat` ile denetler,
   baytları kendi root dizinine kopyalar ve yalnız kopyayı işler (symlink, FIFO, aşırı boyut
   reddedilir). Uçuşta tek işlem vardır (`/run/suderra-update.lock`, RAUC işlemleriyle ortak);
   `StartLimitBurst` ve temiz ortam uygulanır.
4. Root worker agent'ın yetkilendirmesine güvenmez. Bulut manifestini kendisi yeniden doğrular:
   DSSE imzası (provisioning anahtarı), payloadType `suderra.edge-update.v1`, device binding,
   zaman penceresi, key epoch ratchet'i, rollback floor ve bulutun verdiği monotonik `update_seq`
   (cihaz ve payloadType başına; root `/data/suderra/os/seq/<kind>`'da saklar; son kabul edilenden
   küçük veya eşit olan reddedilir). Güncelleme manifesti token veya kimlik bilgisi taşımaz;
   provisioning manifesti güncelleme olarak, güncelleme manifesti provisioning olarak tekrar
   oynatılamaz (payloadType ayrımı). İki kişilik onay: P1'de bulut, release-bundle dağıtımında iki
   kayıtlı insan onayını sunucu tarafında zorunlu kılar ve audit'ler; `edge-update.v1` şemasında
   `approvals[]` alanı yoktur. P2'de `suderra.edge-update.v2` zorunlu `approvals[]` taşır; root
   worker her onayı trust-anchor bundle'ındaki `update-approver` çapalarına (operatör anahtarları,
   DEC-9.4) karşı doğrular ve payload sürümü ratchet'iyle v1'i reddeder. Cihaz tarafında TPI
   kanıtının P2'ye kadar olmaması EDGE-MEDIUM-117'dir. Aynı zincir (DSSE, device binding, zaman
   penceresi, epoch ratchet'i, `update_seq`) cihaza bağlı diğer ifadeler için de geçerlidir:
   `os-update` (madde 9), `site-config` (DEC-4.12) ve `device-lifecycle` (DEC-12); anahtar her türün
   kendi amacına aittir (DEC-3.3). `trust-anchors` bundle'ı cihaza bağlı değildir ve `update_seq`
   taşımaz: root onu OS imajında pinli fleet-root anahtarına karşı doğrular, `bundle_seq`
   ratchet'ini uygular (son kabul edilenden küçük olan reddedilir, eşit olan yalnız aynı digest'le
   yeniden kabul edilir) ve cihazın tenant'ının `tenant_scope`'ta olduğunu denetler (DEC-3.7,
   DEC-22).
5. Sürümler monotonik tamsayı `security_version` ile karşılaştırılır; semver string karşılaştırması
   (`suderra-edge-install` `version_key()` pre-release etiketlerini yok sayar) kullanılmaz. Rollback
   floor ve current `/data/suderra/os/edge/` altında root-owned'dır (TPM'li kartlarda NV sayaç
   aynası, DEC-21); floor yalnız health window geçtikten sonra yükselir. Acil downgrade imzalı bir
   rollback yetkisi ister; `SUDERRA_EDGE_ALLOW_SIGNED_ROLLBACK` gibi env bayrakları kaldırılır.
6. Health window: restart'tan (Type=notify READY'ye kadar bloklar) sonra sınırlı süre boyunca
   kontrol döngüsü heartbeat'i ilerler, safe-state uygulanmıştır, N dakika restart olmaz,
   çevrimiçiyse ilk kimliği doğrulanmış MQTT oturumu kurulur. Başarısızlıkta önceki release ve
   onunla sürümlenmiş config payload'ı birlikte geri alınır. Bir agent güncellemesinden sonraki
   agent hatası yalnız agent'ı geri alır, OS slotunu asla.
7. Fiziksel süreç güvenliği: agent restart'ı shutdown safe-state'ini uygular, OS güncellemesi reboot
   eder; ikisi de havalandırma ve pompa çıkışlarını değiştirebilir. Güncellemeler bildirilmiş bakım
   penceresi ve/veya yerel operatör onayı ile ve maksimum kesinti bütçesi içinde yapılır; aktif
   alarm veya forced değer varken reddedilir. RAUC reboot'u zamanlanmış ve onaylıdır, kendiliğinden
   olmaz (DEC-13).
8. Tek RAUC mark-good sahibi `suderra-rauc-mark-good`'dur; health gate'siz
   `package/suderra-ota/suderra-ota-mark-good.service` silinir.
9. OS güncelleme teslimi aynı istek kanalını kullanır: `suderra.os-update.v1` root worker'dan
   `suderra-ota`'ya verilir (bugün `suderra-ota` yalnız yerel manifest tüketir). Agent ve OS
   işlemleri aynı kilidi paylaşır; OS slot değişimi agent değişimiyle yarışmaz.
10. Platform ve I/O firmware'i (PiBridge modül firmware'i, CM4 bootloader EEPROM, x86 UEFI capsule,
    TPM firmware) OS'e ait bakım işlemleridir: imzalı RAUC bundle hook'larıyla, bakım penceresinde,
    ön/son kontrollerle (BIOS güncellemesinden önce TPM politikasını yeniden mühürleme, sonra SB
    anahtarlarının korunduğunu doğrulama) gelir. piControl modül firmware'ini verity rootfs'teki
    `/lib/firmware/revpi/`'den yükler, yani içerik yalnız OS imajıyla gelir.
11. Hava boşluklu sahalar: aynı cihaza bağlı `edge-update`, `os-update` ve `site-config` ifadeleri
    artifact'larıyla birlikte USB ortamından gelebilir; root ingress birimi (DEC-18.2) ifadeleri
    istek kanalının kopyala-sonra-doğrula yoluna verir; doğrulayıcı, `update_seq`, floor ve bakım
    kuralları ağ yoluyla aynıdır. ACTIVE'de USB depolama kapalı olduğundan ingress yalnız
    MAINTENANCE'ta (DEC-12) açılır. Bu yol P3'e kadar yoktur (EDGE-MEDIUM-118). P1–P3 arasında hava
    boşluklu bir sahada agent ve site config değişikliği, MAINTENANCE'ta USB provisioning
    bundle'ıyla (DEC-5.10) yeniden provisioning'dir; OS güncellemesi bu aralıkta yalnız bakım
    ziyaretinde USB payload installer'ıyla (madde 2, yol 6) yapılır.
12. Bir istek nasıl biter (sözleşme 1.2.0, `channels.json update_channel.settlement`): root her
    spool girdisini, ifadenin digest'ini `subject.statement_digest` olarak adlandıran tam bir sonuç
    belgesiyle kapatır ve digest'i `concluded` kaydına yazar; bu karar kesindir. Root bir ifadeyi
    penceresinin açılmasını, bir engelin kalkmasını veya saatin senkronlanmasını beklemek için
    tutmaz: ifade penceresi dışında ilk bakışta `not-yet-valid` veya `expired` ile kapanır. Bu
    yüzden bulut pencereli bir ifadeyi yalnız pencerenin içinde (`not_before <= now <
    expires_at - 600 s`) teslim eder; "erken teslim, root pencere açılınca uygular" tasarımı
    yoktur. Agent spool girdisini, herhangi bir sonuçla adlandırıldığında siler; bulut isteği aynı
    sonuçtan kapatır; ikisi aynı belgeyi okuduğundan uyuşurlar
    (`fixtures/update-channel/settlement-vectors.json`). Retlerin sınıfı: `retryable`
    (`clock-unsynced`, `fetch-failed`, `io-error`, `maintenance-blocked`, `not-yet-valid`: bulut
    en erken 900 s sonra, en çok 7 gün boyunca aynı niyeti yeni bir ifadeyle yeniden verebilir),
    `reschedule` (`approval-missing`, `expired`: pencere geçti; operatör yeni pencere seçer) ve
    `final` (ifade, artifact veya cihaz durumu nedendir; başka bir ifade gerekir). Yeniden verme
    her zaman yeni bir ifadedir: yeni `not_before` yeni bir digest verir ve `update_seq`, bulutun o
    tür için cihaza verdiği her değerden büyüktür, çünkü root doğrulamayı geçen bir ifadenin
    `update_seq`'ini bakım kapısından önce harcar (`statements.json sequences.spending`); gerçek
    kabul değil, geçerli doğrulama diziyi ilerletir. Bu, madde 4'ün "`update_seq` yalnız kabul
    edilenle ilerler" okumasını bilinçli olarak daraltır: kapıda reddedilen bir ifade, agent
    tarafından sonradan oynatılamaz. P2'de `edge-update.v2` onayları cihaza ve release'e bağlamalıdır;
    aksi halde her `maintenance-blocked` reddi yeni bir iki kişilik onay isterdi.

**Gerekçe.** Birden fazla yazıcı, bir bileşenin diğerinin varsayımlarını bozmasına yol açar.
ADR-019 §3–§5 A/B ve tryboot'u agent'a veriyordu; Suderra OS'te A/B RAUC'undur ve aynı FAT
bölümündeki iki seçici cihazı brick edebilir. Derleme zamanında çıkarma 1. kademedir (imkânsız
kılma); config modlarıyla kapılama bugün tutarsızdır (`sens-api-gateway/src/config.rs:2010-2025`
`FirmwareUpdateMode` dokümanı `firmware.rs:96-99` kapısıyla çelişir).

**Sonuçlar / Riskler.**

- Generic-Linux profili agent OTA kodunu tutar; iki profil iki ayrı build'dir (DEC-28).
- Root worker saldırganın etkileyebildiği dosyaları parse eder → Rust, boyut sınırı,
  kopyala-sonra-doğrula.
- Ele geçirilmiş bir agent eski geçerli manifestleri tekrar oynatabilir → `update_seq` ve floor.
- Her güncelleme bir çıkış geçişidir; kendiliğinden rollback döngüsü kesintileri çoğaltır → bir
  rollback'ten sonra durma ve alarm.

**Uygulama.**

- aquaculture_platform: `sens-api-gateway/Cargo.toml` (`os-managed-updates`, `suderra-os`
  feature'ları);
  `src/commands/{firmware.rs,apply_signed_manifest.rs,confirm_slot.rs,mod.rs,catalog.rs}`,
  `src/updater/`, `src/main.rs` (PartitionStore ve bootloader init) cfg ile kapılanır;
  `src/commands/request_update.rs` (yeni; yalnız istek dosyası yazar);
  `sens-api-gateway/tests/invariants/os_managed_updates_no_updater.rs` (yeni; updater sembolleri ve
  `/boot`, `/opt` yazmaları yok);
  `apps/sensor-service/src/edge-device/edge-update-manifest.service.ts` (yeni;
  `apps/sensor-service/src/release-bundle/` tablolarını kullanır);
  `docs/adr/019-edge-firmware-signing-ab-partition.md` başlığına supersession notu.
- Suderra-OS: `userspace/suderra-installer/src/cmd/edge.rs` (`request`), `src/contracts.rs`
  (`EDGE_UPDATE_KIND`, `update_seq`, `security_version`), `userspace/suderra-installer/Cargo.toml`
  (paket kurulum komutlarını prod build'den çıkaran feature);
  `overlay/etc/systemd/system/suderra-edge-request.{path,service}` (yeni);
  `userspace/suderra-ota/src/main.rs` (worker'dan istek kabulü); `package/suderra-ota/suderra-ota.mk`,
  `package/suderra-ota/suderra-ota-mark-good.service` silinir.
- Kapatılan bulgular: SENSOR-MEDIUM-223 (Suderra OS profilinde derlenmez; generic kanaldaki ölü
  legacy OTA aynı fazda silinir, DEC-28), INFRA-MEDIUM-238, EI-039, EI-053, EI-062, EI-071 (P0);
  EI-055 (health window rollback'i config'i de geri alır, P1); EDGE-MEDIUM-117 (`edge-update.v2` +
  `approvals[]`, P2); EDGE-MEDIUM-118 (hava boşluklu USB update ingress'i, P3).
  SENSOR-HIGH-207, EDGE-MEDIUM-073 (tryboot), EDGE-MEDIUM-074 (ajan içi cold-boot watchdog) ve
  EDGE-HIGH-064 (`reboot`/`restart_agent`) için Suderra OS profilindeki P0/P1 işi (bu yolların
  derlenmemesi) `Refs:` taşır; bulgular DEC-28'in P2 generic profil işiyle kapanır (kapanış kuralı,
  Implementation).

**Faz.** P0: agent tarafı yolların derleme zamanında çıkarılması, paket yolunun prod'dan
çıkarılması, tek mark-good, `security_version` ve root floor. P1: istek kanalı, update worker
(`edge-update`, `os-update`, `site-config`, `trust-anchors` türleri), `update_seq`, bakım penceresi,
OS güncelleme teslimi, bulut tarafında iki kişilik onay. P2: `edge-update.v2` ve cihazda
`approvals[]` doğrulaması. P3: platform firmware bakım hook'ları, hava boşluklu USB güncelleme
ingress'i.

---

### DEC-3 — Güven, imzalama ve anahtarlar

**Karar.**

1. İki imzalı ifade, iki ayrı anahtar:
   - `suderra.edge-release.v1` — edge-release anahtarıyla imzalı release statement: name, version,
     `security_version`, `board_profile`, arch, features, artifact sha256 (verity formatında root
     hash), `min_os_version`, `agent_abi`, provenance digest. (arch, board profile) başına bir
     statement. Tasarım gereği tenant'tan bağımsızdır (DEC-22).
   - `suderra.edge-provisioning.v1` — bulut provisioning anahtarıyla imzalı, cihaza bağlı manifest:
     device_id, device_code, tenant_id, `device_binding`, board, arch, release statement digest,
     `update_seq`, cihazın gönderdiği nonce, `not_before`/`expires_at`, config payload (iç içe
     `site-config` ifadesi, DEC-4.12) ve trust-anchor bundle'ı (madde 7). Cihaz manifestin
     version/board/arch alanlarının release statement'la eşit olduğunu doğrular; online
     provisioning anahtarının sahibi eski veya başka karta ait bir binary'yi yeni sürüm diye
     etiketleyemez.
2. Format DSSE'dir: `{payloadType, payload: base64(ham JSON), signatures: [{keyid, sig}]}`; imza
   `PAE(payloadType, payload)` tam baytları üzerindedir; doğrulama `ed25519-dalek` `verify_strict`
   ile yapılır; payload `deny_unknown_fields` ile parse edilir; her çağrı noktası beklediği
   payloadType'ı sabitler. Bugünkü yeniden serileştirme (`contracts.rs:856-862`
   `canonical_without_signature`) ve `verify` (`:848`) kaldırılır. payloadType'lar:
   `application/vnd.suderra.<kind>.v1+json`; kind ∈ {`edge-release`, `edge-provisioning`,
   `edge-update`, `edge-activation-receipt`, `site-config`, `site-netpolicy`, `rbac-manifest`,
   `trust-anchors`, `key-epoch-advance`, `device-lifecycle`, `os-update`}.
3. Amaç başına ayrı anahtar ve ayrı epoch. P0'da yalnız dev/CI anahtarları vardır; üretim
   anahtarları P1 seremonisiyle gelir (madde 9). "Tutan" sütunu her fazdaki tutanı gösterir:

   | Amaç | Algoritma | Tutan | Cihazdaki çapa | İmzaladığı |
   |---|---|---|---|---|
   | `edge-release` | Ed25519 | P0: dev/CI anahtarı, korumalı `edge-release` environment'ındaki imzalama job'u; P1: seremoni kökenli üretim anahtarı offline HSM'de, üretim release statement'ı offline imzalanır; P2: KMS/OIDC | OS imajı: `/etc/suderra/keys/edge-release/<epoch>.pub` (root); bundle kopyası (agent) | `edge-release` |
   | `edge-provisioning` | Ed25519 | sensor-service `ManifestSigner` (P0 dev/CI; P1'den KMS'e kadar ayrı secret, EDGE-HIGH-119; P2 KMS) | OS imajı: `/etc/suderra/keys/edge-provisioning/<epoch>.pub` (root); bundle kopyası (agent) | `edge-provisioning`, `edge-update`, `edge-activation-receipt`, `os-update` |
   | `fleet-root` | Ed25519 | dev/CI: `scripts/gen-dev-keys.sh`; üretim: P1'de offline HSM seremonisi, offline kalır (Soru 9) | OS imajı: `/etc/suderra/keys/fleet-root/<epoch>.pub` | `trust-anchors`, `key-epoch-advance` |
   | `device-lifecycle` | Ed25519 | ayrı signer servis kimliği (P0 dev/CI; P1'den KMS'e kadar ayrı secret, EDGE-HIGH-119; P2 KMS, 4-göz) | OS imajı: `/etc/suderra/keys/device-lifecycle/<epoch>.pub` | `device-lifecycle` (yeniden provisioning için MAINTENANCE, P3'te break-glass, RMA, decommission) |
   | `config-integrity` | Ed25519 | sensor-service ayrı `ManifestSigner` kimliği (P0 dev/CI; P1'den KMS'e kadar ayrı secret, EDGE-HIGH-119; P2 KMS) | trust-anchor bundle | `site-config` (DEC-4.12), `site-netpolicy` (DEC-11.7) |
   | `rbac-manifest` | Ed25519 | sensor-service ayrı `ManifestSigner` kimliği (P0 dev/CI; P1'den KMS'e kadar ayrı secret, EDGE-HIGH-119; P2 KMS) | trust-anchor bundle | `rbac-manifest` (DEC-9.4) |
   | `command` (platform aktörü) | Ed25519 | `CommandEnvelopeSignerService` (P0 dev/CI; P1'den KMS'e kadar ayrı secret, EDGE-HIGH-119; P2 KMS) | trust-anchor bundle; RBAC manifesti aktörü anahtara eşler | komut envelope'u |
   | `update-approver`, `program`, `license` (P2) | Ed25519 | operatör anahtarları / KMS (DEC-9.4) | trust-anchor bundle | güncelleme onayları, ST bytecode, lisans |
   | `edge-image` (P2) | X.509, RSA veya ECDSA P-256 (kernel Ed25519 doğrulayamaz) | KMS | kernel trusted keyring (sertifika imzalı kernel build'ine gömülü) | agent release imajının dm-verity root hash'i, PKCS#7 (DEC-1.6) |
   | `mqtt-ca` | X.509 kök kümesi | P2'ye kadar: broker'ın kamu CA kökleri (üretim bundle'ı, P1'den; yalnız sunucu kimlik doğrulaması) ve dev/QEMU test broker'ının CI kökü (dev bundle'ı); P2: özel cihaz PKI'sinin offline kökü | trust-anchor bundle | broker sunucu sertifikası (DEC-10.6); P3'te cihaz sertifikaları |
   | RAUC bundle, FIT, UEFI db, verity | mevcut | HSM (ADR-0004/0005/0007) | mevcut | değişmez |

   Root `edge-*`, `os-update`, `device-lifecycle` ve `trust-anchors` ifadelerini yalnız OS
   imajındaki pinlere karşı doğrular. `site-config`, `site-netpolicy` ve `rbac-manifest`'i ise
   fleet-root'a karşı doğrulanmış bundle'daki çapalara karşı doğrular. Bundle'daki `edge-release`
   ve `edge-provisioning` girdileri agent'ın kendi kontrolleri içindir: release statement'taki
   profil (DEC-8.5) ve activation receipt'i yazmadan önceki kontrol. Bu girdiler OS imajında pinli
   bir keyid'e eşit olmalıdır, değilse root bundle'ı reddeder. Generic profildeki config'ten okunan
   anahtarlar (`config.rs:1727`, `:2098`, `:2372`) Suderra OS profilinde derlenmez.

4. Anahtarlar verity rootfs'te `/etc/suderra/keys/<purpose>/<epoch>.pub` altında pinlenir.
   Doğrulayıcı anahtarı DSSE `keyid` → epoch dosyasından seçer; manifestin kendi beyan ettiği
   `key_epoch` (`contracts.rs:315-317`) yetki kaynağı değildir. Bir imaj N ve N+1 epoch'unu birlikte
   taşıyabilir.
5. Min-epoch ratchet'i amaç başına root-owned `/data/suderra/os/ratchet/<purpose>`'tadır (TPM'li
   kartlarda NV sayaç aynası, DEC-21); yalnız fleet-root imzalı `key-epoch-advance` ifadesiyle
   ilerler, asla geri gitmez.
6. Device binding OS'in sahip olduğu bir donanım kimliğine bağlanır; root ilk boot'ta
   `/data/suderra/os/identity/` altında üretir: TPM varsa EK public key'in SHA-256'sı (RevPi
   SLB9670, x86 dTPM/PTT, QEMU swtpm); TPM yoksa SHA-256(BCM2711 seri numarası ‖ müşteri OTP
   değeri) (RPi4/CM4; OTP değeri staging'de bir kez yazılır, geri dönüşsüzdür, önerilen varsayılandır
   ve operatör onayına bağlıdır: Soru 3); DMI `product_uuid` yalnız TPM'siz x86 dev imajlarında ve
   bulutun benzersizlik kontrolüyle. Agent kimliği yalnız `/run/suderra/identity.json`'dan okur.
   Doğrulayıcı manifestteki `device_binding`'i yerel değerle karşılaştırır, uyuşmazlığı reddeder
   (bugün yalnız boş olmama kontrolü var, `contracts.rs:301-306`).
7. Trust-anchor bundle'ı P0'dan itibaren tek agent güven kaynağıdır.
   - Format: `suderra.trust-anchors.v1` (DSSE, payloadType
     `application/vnd.suderra.trust-anchors.v1+json`): `bundle_seq` (monotonik), `issued_at`,
     `tenant_scope` (tenant_id listesi, DEC-22) ve `anchors[]` (purpose → keyid → epoch → public key
     veya sertifika kümesi).
   - İmzalayan fleet-root'tur; cihaz bundle'ı OS imajında epoch başına pinli fleet-root anahtarıyla
     doğrular. CI ve QEMU için dev fleet-root'u `scripts/gen-dev-keys.sh` üretir; yalnız dev imajları
     ve QEMU hedefleri onu pinler (madde 9). Üretim fleet-root'u P1'deki offline seremoniyle oluşur
     (operatör eylemi, Soru 9); üretim imajları P1 seremonisinden itibaren build edilir (madde 9).
   - P0 bundle'ının içeriği: platform `command` anahtarı, `rbac-manifest`, `config-integrity`,
     `edge-release` ve `edge-provisioning` anahtarları ve `mqtt-ca` kümesi (DEC-10.6). P2'de
     `update-approver`, `program` ve `license` çapaları eklenir.
   - Teslim: bundle provisioning payload'ında gelir; root doğrular ve `/data/suderra/site/`
     altına yazar; agent `src/trust_anchors.rs` ile OS imajındaki fleet-root pinine karşı yeniden
     doğrular ve salt okur. Bundle P0'da yeniden provisioning'le, P1'den itibaren istek kanalının
     `trust-anchors` türüyle (DEC-2.4; `bundle_seq` geri gidemez) güncellenir.
   - Online provisioning anahtarı agent güveninin kökü olmaz (ADR-019 slot 7 "factory
     semi-air-gap" idi, online cihaz başına imzacı değil): provisioning anahtarıyla imzalı bir çapa
     reddedilir ve agent çapaları OS imajına pinlenmez.
8. cosign keyless ve in-toto SLSA provenance yalnız provenance içindir; cihaz bunlara güvenmez.
   Bulut, bir release'i herhangi bir manifeste almadan önce provenance'ı (repo, workflow ref, tag)
   doğrular (DEC-20). Ed25519 release statement dosyası cosign'ın `<artifact>.sig` adıyla çakışmaz:
   `<artifact>.release.dsse.json`.
9. Anahtar saklama ve köken. İmzalama ayrı, cache'siz bir job'dadır (DEC-20).
   - P0: yalnız dev/CI anahtarları vardır (`scripts/gen-dev-keys.sh`,
     `scripts/ci/prepare-ci-keyring.sh`; dev fleet-root dahil). dev/CI edge-release anahtarı korumalı
     `edge-release` environment'ındadır (required reviewers, yalnız `agent-v*` tag'leri); diğer
     dev/CI anahtarları sensor-service'te ayrı secret'larda ve `ManifestSigner` arayüzünün
     arkasındadır. dev/CI anahtarlarını yalnız dev imajları ve QEMU hedefleri
     (`suderra_qemu_x86_64_defconfig`, `suderra_qemu_x86_64_prod_ab_defconfig`) pinler; hiçbiri
     üretim envanterine girmez.
   - P1: üretim anahtarları offline seremoniyle (Soru 9) üretilir ve
     `Suderra-OS/docs/security/key-management.md` envanterine seremoni kökenli olarak kaydedilir. fleet-root ve edge-release özel anahtarları
     offline HSM'de kalır: imzalama job'u üretim release statement'ının imzasız payload'ını ve
     provenance'ı üretir, emanetçiler provenance'ı doğrulayıp statement'ı offline imzalar. Online
     amaçların (edge-provisioning, device-lifecycle, command, config-integrity, rbac-manifest)
     seremonide üretilen özel anahtarları KMS'e kadar sensor-service'te ayrı secret'larda ve
     `ManifestSigner` arayüzünün arkasındadır.
   - Donanım kartlarının prod defconfig'lerinde (`suderra_aarch64_revpi4_prod_ab_defconfig`,
     `suderra_aarch64_rpi4_prod_ab_defconfig`, `suderra_x86_64_defconfig`) `package/suderra-keys`
     yalnız envanterde KMS/HSM veya offline seremoni kökenli olarak kayıtlı keyid'leri kurar; build
     başka bir keyid'de, dev/CI keyid'leri dahil, başarısız olur (invariant). P1 seremonisinin
     anahtarları bu allowlist'ten geçer; üretim imajları bu yüzden P1'den itibaren build edilir.
   - Online anahtarların P1'den P2'deki KMS'e kadar servis secret'larında durması EDGE-HIGH-119'dur.
     Bu risk SG-1 izleme amaçlı pilotlar için kabul edilmiştir; pilotlar dev imajıyla değil üretim
     imajıyla çalışır. Sızan bir online anahtar sahte manifest, site config veya komut imzalayabilir;
     SG-1 pilot sahalarında canlı stok ve fiziksel aktüasyon olmadığı için etki fiziksel değildir.
   - P2'de imzalama KMS'e taşınır: OIDC workload identity, anahtar kullanım politikası tek signer
     servis kimliğine bağlı, imza başına audit, oran ve anomali sınırları, tenant kapsamı (DEC-22).
     KMS'te yeniden üretilen anahtarlar yeni epoch'tur: OS imajı N ve N+1'i birlikte taşır (madde 4),
     eskisi fleet-root imzalı `key-epoch-advance` ile emekliye ayrılır (DEC-15).
10. Ed25519 yazılım doğrulaması içindir. Cihazda yerleşik anahtarlar (mTLS kimliği, attestation AK,
    keystore) TPM içinde ECDSA P-256'dır; SLB9670 ve Intel PTT Ed25519 sunmaz.
11. edge-release, edge-provisioning, config-integrity, rbac-manifest, fleet-root,
    device-lifecycle, command, `edge-image` (P2) ve MQTT CA anahtarları kökenleriyle (madde 9)
    `Suderra-OS/docs/security/key-management.md` envanterine (bugün yalnız
    UEFI/kernel/RAUC/verity/MQTT CA/SRK listeli) ve
    `docs/adr/021-platform-key-ceremony-lifecycle.md` slot haritasına eklenir; rotasyon, iptal ve
    ihlal runbook'ları DEC-15'tedir.
12. ADR-019 §2 ile uzlaştırma: §2, provisioning pubkey'in güncellenebilir rootfs dışında durmasını
    istiyordu, çünkü o modelde rootfs firmware anahtarıyla değiştirilebilirdi. Suderra OS'te
    rootfs'i yalnız OS imaj zinciri (RAUC bundle anahtarı + FIT/UEFI imzası) değiştirir;
    edge-release anahtarı rootfs'e dokunamaz. Bu yüzden pin verity rootfs'tedir. §2'nin TPM NV
    PCR[0..3] mühürü RevPi'de geçersizdir: BCM2711'de bu PCR'lar hiç extend edilmez.

**Gerekçe.** Bugün tek bir anahtar (`overlay/usr/sbin/suderra-edge-install:10` `EDGE_PUBKEY`;
`contracts.rs:293` ve `:377` aynı `read_public_key`) hem neyin çalışacağını hem hangi cihazda
çalışacağını belirler; CI veya bulut ihlali ikisini birden verir. Yeniden serileştirilmiş JSON
üzerinden imza TS (`toISOString` `.000Z`) ile Rust (chrono biçimi) arasında bayt farkı ve sessizce
düşen bilinmeyen alanlar demektir: ya alanda doğrulama hatası ya da gevşetilmiş doğrulayıcı. Kendi
beyan edilen epoch iptali imkânsız kılar. Agent çapalarının P0'dan itibaren bundle'la gelmesi,
Enforcing komut yolunun (DEC-9) ve config bütünlüğünün (DEC-4.10) ilk fazdan beri izin verilen tek
kökle çalışmasını sağlar.

**Sonuçlar / Riskler.**

- Fleet-root kaybı veya ihlali filo çapında bir olaydır: offline seremoni, offline saklama, DEC-15.
- P0'daki dev/CI anahtarlarının sızması üretim cihazlarını etkilemez: hiçbir donanım prod imajı
  onları pinlemez (madde 9, invariant).
- P1'den P2'deki KMS'e kadar online üretim anahtarları (edge-provisioning, device-lifecycle,
  command, config-integrity, rbac-manifest) servis secret'larındadır (EDGE-HIGH-119). SG-1 izleme
  amaçlı pilotlar üretim imajlarıyla bu riskle çalışır; risk bu pilotlar için kabul edilmiştir ve
  KMS P2 çıkış kriteridir.
- P1 seremonisi yapılmazsa üretim imajı build edilemez; SG-1 pilotları ve P1 çıkışı buna bağlıdır.
  fleet-root ve edge-release offline kaldığından her üretim agent release'i bir offline imza adımı
  ister (P2'de KMS/OIDC ile otomatikleşir).
- TPM'siz kartlarda floor ve ratchet yalnız `/data`'dadır → rollback'e karşı zayıf (DEC-8 SL notu;
  EDGE-MEDIUM-120).

**Uygulama.**

- Suderra-OS: `userspace/suderra-installer/src/contracts.rs` (DSSE, `verify_strict`,
  `deny_unknown_fields`, `--release-key-dir` / `--provisioning-key-dir`, ratchet, device binding),
  `userspace/suderra-installer/src/trust_anchors.rs` (yeni; bundle doğrulaması, tenant kapsamı),
  `src/cli.rs`; `package/suderra-keys/suderra-keys.mk` ve `Config.in` (amaç/epoch başına pubkey'ler,
  prod keyid allowlist'i); `scripts/gen-dev-keys.sh` ve `scripts/ci/prepare-ci-keyring.sh` (amaç
  başına dev/CI anahtarları, dev fleet-root'u, imzalı dev bundle'ı);
  `overlay/usr/sbin/suderra-identity` ve `overlay/etc/systemd/system/suderra-identity.service`
  (yeni); `docs/security/key-management.md`, `docs/security/key-ceremony.md`.
- aquaculture_platform: `.github/workflows/edge-agent-release.yml` (ayrı `sign-release-statement`
  job'u); `apps/sensor-service/src/edge-device/edge-provisioning-manifest.service.ts`,
  `site-config-manifest.service.ts`, `rbac-manifest.service.ts`, `trust-anchor-bundle.service.ts` ve
  `manifest-signer.ts` (yeni), `edge-device.module.ts`; `installer-script.service.ts`
  (`SuderraOsInstallManifest` ve `renderSuderraOsInstallManifest` kaldırılır; varsayılan
  `${artifactUrl}.sig` cosign blob imzasını gösteriyordu, `:246-249`);
  `sens-api-gateway/src/trust_anchors.rs` (yeni), `src/authz/manifest_runtime.rs` (RBAC manifest
  anahtarı bundle'dan; ağdan gelen `hot_reload_from_bytes` yolu `suderra-os`'te derlenmez);
  `docs/adr/021-platform-key-ceremony-lifecycle.md`; şema ve golden fixture'lar
  `contracts/suderra-edge/v1/` altında (DEC-25).
- Kapatılan bulgular: SENSOR-CRITICAL-202, SENSOR-HIGH-204, SENSOR-MEDIUM-217, EI-038, EI-054 (P0);
  SENSOR-HIGH-214 (P1; P0'daki provisioning, bundle ve RBAC manifesti üreticileri `Refs:` taşır,
  bulgu P1'de güncelleme üreticisiyle kapanır); EI-060 ve SENSOR-MEDIUM-226 (P2; provenance
  admission, yayımlanan imajlarda üretim anahtarları ve KMS); EDGE-HIGH-119 (P2, KMS).
  SENSOR-HIGH-216'nın Suderra OS profilindeki P0 işi (amaç başına anahtar ve bundle) `Refs:` taşır;
  bulgu DEC-28'in P2 generic profil işiyle kapanır (kapanış kuralı, Implementation).

**Faz.** P0: iki ifade, DSSE, `verify_strict`, amaç başına ayrı dev/CI anahtarları, epoch
dizinleri, ratchet, device binding, golden fixture'lar, korumalı imzalama job'u, dev fleet-root'uyla
imzalı `suderra.trust-anchors.v1` bundle'ı (madde 7'deki P0 içeriği), prod keyid allowlist'i. P1:
üretim anahtar seremonisi (operatör; fleet-root ve edge-release offline, online anahtarlar servis
secret'larında), envanter kaydı, üretim imajlarının build'i, bundle'ın istek kanalıyla
güncellenmesi. P2: bundle'da `update-approver`, `program`, `license` çapaları, KMS/OIDC ve online
anahtarların KMS'e taşınması (EDGE-HIGH-119), `edge-image` anahtarı (DEC-1.6), provenance
admission.

---

### DEC-4 — Dosya sistemi sözleşmesi ve kimlik

**Karar.**

1. `/etc` read-only'dir ve OS'e aittir; çalışma anında hiçbir bileşen `/etc`'e yazmaz.
2. `/data` yerleşimi (mountpoint'ler build'de oluşturulur; sahiplik tek yazıcıdadır:
   `suderra-data-unlock`, `/data`'yı bağladıktan sonra
   `systemd-tmpfiles --create /usr/lib/suderra/data-layout.tmpfiles.conf` çalıştırır. Bu dosya
   `tmpfiles.d` altında değildir, çünkü `systemd-tmpfiles-setup.service` `/data`'dan önce koşar
   (`overlay/etc/systemd/system/suderra-data.service` `After=systemd-tmpfiles-setup.service`);
   `/run` girdileri `/usr/lib/tmpfiles.d/suderra.conf`'tadır):

   | `/data` yolu | Mount noktası | Sahip / mod | Yazıcı | İçerik |
   |---|---|---|---|---|
   | `/data/suderra/os/` | `/var/lib/suderra-os` | root:root 0700 | OS root birimleri | yaşam döngüsü, installer durumu ve receipt'ler, floor'lar, ratchet'ler, `seq/<kind>`, provisioning durumu, SSH host key, zaman tabanı, firewall LKG, kimlik, sonuçlar (DEC-27) |
   | `/data/suderra/os/chrony/` | `/var/lib/chrony` | chrony:chrony 0750 | chronyd (`--with-user=chrony`, `buildroot/package/chrony/chrony.mk:20`) | drift ve dump dosyaları (DEC-7). chronyd dizine yalnız bind üzerinden erişir; üst dizinin 0700 olması erişimi engellemez ve diğer root-only alt ağaçlar ona görünmez |
   | `/data/rauc/` | — | root:root 0700 | RAUC ve `suderra-rauc-*` | `status.ini` (`system.conf:6`, `system.conf.arm:5`), `boot-state.json`, `health-preflight.json`, `pre-mark-good.json`, `mark-good.json`, `pre-update.json` (DEC-6.8) |
   | `/data/suderra/site/` | `/var/lib/suderra-site` (ro bind) | root:suderra 0750, dosyalar 0640 | yalnız root installer, imzalı payload'dan | `config.yaml`, `site-config.dsse`, trust-anchor bundle, RBAC manifesti, site politikası, `revpi/config.rsc`, donanım envanteri |
   | `/data/suderra/edge/` | `/opt/suderra/edge` (ro, exec bind) | root:root 0755 | root installer | `releases/`, `current` |
   | `/data/suderra/agent/` | `/var/lib/suderra` (agent veri kökü) | suderra:suderra 0750 | agent; alt dizinleri yalnız `data-layout.tmpfiles.conf` oluşturur (madde 3) | `state/`, `secrets/` (0700), `queue/`, `scripts/`, `policy-cache/`, `update-requests/` |
   | `/data/suderra/log/` | `/var/log/suderra` | suderra:suderra 0750 | agent | uygulama logları, `audit.log` (madde 9) |
   | — (tmpfs) | `/run/suderra/` | root:suderra 0750 | root yardımcıları | `identity.json`, `time-state`, `board`, `lifecycle`, `results/` (dizin 0750, dosyalar 0640) |
   | — (tmpfs) | `/run/suderra-os/` | root:root 0700 | root yardımcıları | provisioning OTP shadow'u, `data-created` kanıtı (DEC-12), provisioning manifesti (DEC-5.6) |
   | — (tmpfs `/run/suderra-provision/`) | `/var/spool/suderra-provision` (bind; `provision` kullanıcısının ev dizini, `board/suderra/common/users.txt`) | root:provision 0750; `inbox/` provision:provision 0700; sonuç dosyası root:provision 0640 | `provision` forced command (inbox), root worker (sonuç dosyası; `provision` kullanıcısı okur ve teknisyene döner, EI-002) | provisioning spool'u: boyut sınırlı, ara ad + rename (DEC-5.5) |

3. Root, agent'ın yazabildiği ağacın içine hiçbir zaman doğrudan yazmaz, chown/chmod yapmaz ve
   agent'ın yazabildiği bir yolun üzerine mount etmez (symlink yarışı ilkesi). Tek, onaylı istisna
   systemd'dir: agent'ın alt dizinlerini unit başlamadan önce
   `/usr/lib/suderra/data-layout.tmpfiles.conf`'taki sabit sahipli (`suderra:suderra`) ve sabit modlu
   `d` girdileri oluşturur. systemd-tmpfiles güvensiz yol geçişlerini (root olmayan bir kullanıcıya
   ait bir symlink'i izleyerek ilerlemeyi) reddeder. `StateDirectory=`/`LogsDirectory=` yerine
   tmpfiles seçildi, çünkü `secrets/` farklı mod ister ve `StateDirectoryMode=` tüm dizinlere tek mod
   uygular. Installer, lockdown, firstboot ve diğer root betikleri agent ağacının içine hiçbir şey
   yazmaz. Bugünkü çakışan chown'lar kaldırılır: `suderra-data-unlock:21-22` aynı bind'i önce
   root:root sonra 200:200 yapar; `suderra-edge-install:145` `/var/lib/suderra`'yı root:root yapar
   (agent kendi veri köküne yazma hakkını reboot'a kadar kaybeder); `suderra-firstboot.service`
   `edge/`'i chown eder. Contract test, `data-layout.tmpfiles.conf` dışında hiçbir root betiğinin bu
   ağaçlara yazmadığını, chown/chmod yapmadığını doğrular.
4. Kilit, provisioning ve firstboot durumu agent ağacında değil `/data/suderra/os/`'tedir. Bugün
   `.appliance-locked` agent'ın sahip olduğu `/var/lib/suderra`'dadır; uid 200 onu silebilir ve
   sonraki boot provisioning ruleset'ini (port 22) yükler (`overlay/usr/sbin/suderra-firewall:4-8`).
5. Agent'ın tek yol çözücüsü vardır (`sens-api-gateway/src/data_dir.rs` bir paths modülüne
   genişletilir) ve her çağrı yeri onu kullanır. Suderra OS profilinde yollar OS mutable-state
   tablosundan (madde 2, DEC-24) türetilmiş derleme zamanı sabitleridir: config
   `/var/lib/suderra-site/config.yaml`, veri kökü `/var/lib/suderra`, log kökü `/var/log/suderra`,
   cihaz kimliği `/run/suderra/identity.json`. `SUDERRA_CONFIG`, `SUDERRA_DATA_DIR`
   (`data_dir.rs:33`), `SUDERRA_MACHINE_ID_PATH` (`machine_id.rs:67`) ve `SUDERRA_DB_KEY_PATH`
   (`db_secret.rs:67`) yalnız generic profilde okunur; overlay unit'i hiçbirini set etmez (bugün
   `suderra-agent.service:12` `SUDERRA_CONFIG` set eder). Generic profilde env yokken mevcut
   `/etc/suderra` varsayılanı korunur (HC-1). Bu belgede `$SUDERRA_DATA_DIR` ve `$DATA` agent veri
   kökünü gösterir. Dönüştürülecek çağrı yerleri: `config.rs:143`, `:3246`, `:4239`; `main.rs:247`,
   `:3189`, `:3309`, `:4367` (SIGHUP reload); `db_secret.rs:71`; `keystore/bootstrap.rs`;
   `authz/manifest_runtime.rs`; `scripting/storage.rs`; `license_cache.rs`; `scada_server.rs`;
   `updater/partition_store.rs` ve `commands/firmware.rs` (yalnız generic).
6. `config.yaml` provisioning'e aittir: root installer imzalı payload'dan yazar; agent asla yeniden
   yazmaz (`save()` Suderra OS profilinde derlenmez; bugün `commands/provision.rs`,
   `commands/config_dispatch.rs` ve aktivasyon `config.save()` çağırır). Agent'ın çalışma sonuçları
   (aktivasyon sonucu, broker kimlik bilgisi, tenant/device id, activation receipt)
   `$SUDERRA_DATA_DIR/state/`'e (0600) gider. Tek öncelik kuralı: imzalı config güvenlik ve uç nokta
   alanlarının tek kaynağıdır; state yalnız state alanlarını taşır; aynı alan iki yerde bulunamaz
   (test).
7. Site config yolu `/var/lib/suderra-site/config.yaml`'dır (madde 5). RevPi'de piControl config'i
   derleme zamanı yolundan (`/etc/revpi/config.rsc`, kernel `filp_open`) okur; imaj bu yolu
   `/var/lib/suderra-site/revpi/config.rsc`'ye symlink olarak taşır; yeniden yükleme (`KB_RESET`)
   root aracıyla yapılır, agent ile değil.
8. DB anahtarı `$SUDERRA_DATA_DIR/secrets/db.key`'dir: agent'ın ilk start'ta ürettiği rastgele 256
   bit (0400); dosya ara adla yazılır, dosya ve dizin fsync'lenir, sonra `rename(2)` ile yerine
   konur. Türetmede machine-id kullanılmaz (machine-id gizli değildir). TPM'li profillerde hedef,
   anahtarın TPM ile mühürlenmesi (`tpm` feature, `/dev/tpmrm0`) ya da `LoadCredentialEncrypted=`
   (TPM2) kullanılmasıdır (P2, TPM keystore ile). Generic-Linux cihazlarında v1
   (`HMAC(machine-id, /etc/suderra/db.key)`) → v2 tek seferlik rekey göçü `src/db_migration/` ile
   yapılır; v1.6.0 config/DB fixture testi (TST-008) şarttır.
9. Kalıcı cihaz kimliği DEC-3'teki donanım kimliği ve (mümkünse TPM'de yerleşik) cihaz anahtar
   çiftidir. `/etc/machine-id` geçicidir ve öyle kalır: prod imajı firstboot çalıştırmaz
   (`post-build.sh:188-189`), `/etc` read-only'dir, Buildroot `/etc/machine-id`'yi boş dosya olarak
   bırakır (`buildroot/package/systemd/systemd.mk:682`) ve systemd her boot'ta geçici bir değer
   üretip onun üzerine bind eder. Bu kabul
   edilebilir, çünkü kalıcı hiçbir şey machine-id'ye bağlanmaz:
   - journald `Storage=volatile` ve sınırlı `RuntimeMaxUse=` ile çalışır
     (`overlay/etc/systemd/journald.conf.d/10-suderra-volatile.conf`, yeni). Böylece
     `/var/log/journal/<machine-id>` dizinleri hiç oluşmaz. Bugün overlay'de journald yapılandırması
     yoktur ve varsayılan `Storage=auto`'dur.
   - Kalıcı kanıt `/data`'daki agent audit log'u ile kurulum ve güncelleme sonuç telemetrisidir
     (DEC-27). Bu yüzden audit log Suderra OS profilinde zorunludur: `audit.mode` bu profilde yalnız
     `Enabled` olabilir (bugün varsayılan `Disabled`, `config.rs:1820-1825`). Log
     `/var/log/suderra/audit.log`'a, yani `/data/suderra/log/`'a yazılır ve HMAC zinciri anahtarı
     keystore'dan türetilir (`config.rs:4025-4034`). Zincirin dış çapası EDGE-MEDIUM-100'dür (P2).
   - systemd-networkd'nin varsayılan DHCP kimliği machine-id'den türetilen DUID'dir; bu yüzden
     `10-ethernet.network` `[DHCPv4] ClientIdentifier=mac` taşır. IPv6 sysctl ile kapalıdır
     (`overlay/etc/sysctl.d/90-suderra-hardening.conf:62-64`). Saha DHCP rezervasyonları ve IP
     tabanlı OT allowlist'leri NIC'e bağlı kalır.
   - Agent kimliği yalnız OS kimlik dosyasından (`/run/suderra/identity.json`) gelir, asla
     `/etc/machine-id`'den değil. Suderra OS profilinde machine-id okuyan yol yoktur (invariant:
     `src/machine_id.rs` bu profilde derlenmez); DB anahtarı ona dayanmaz (madde 8) ve aktivasyonda
     buluta ham machine-id gönderilmez.
   Read-only root contract testi (DEC-24) imajdaki `/etc/machine-id`'nin boş dosya olduğunu,
   journald'ın volatile olduğunu ve hiçbir Suderra biriminin `/etc/machine-id` okumadığını denetler.
10. Config bütünlüğü. Generic profilde agent'ın config-integrity çapası öz-referanslıdır:
    `factory_pubkey_hex` ve mod doğrulanan dosyanın içindedir (`config.rs:2372`), yol sabittir
    (`main.rs:3309`). Suderra OS profilinde üç kural geçerlidir:
    - Agent `site-config` ifadesini (`/var/lib/suderra-site/site-config.dsse`) bundle'daki
      `config-integrity` çapasına (DEC-3.7) karşı doğrular ve `config.yaml` ile diğer site
      dosyalarının digest'lerini ifadeyle karşılaştırır. `factory_pubkey_hex` ve config içindeki
      mod bu profilde derlenmez.
    - Sürüm kapısı aynı `update_seq`'i ve aynı digest'i yeniden kabul eder. Bugün kesin büyüktür
      kuralı aynı imzalı config'i ikinci boot'ta reddeder.
    - Root, site dosyalarının digest'ini her start'ta (`ExecStartPre=+`) ve her `ExecReload`'da
      install receipt'e karşı doğrular.
11. Agent unit'i: `ReadOnlyPaths=/var/lib/suderra-site`; `ReadWritePaths=` yalnız agent'ın alt
    dizinleridir: `/var/lib/suderra/{state,secrets,queue,scripts,policy-cache,update-requests}` ve
    `/var/log/suderra`. Bu dizinler madde 3'teki istisnayla unit başlamadan önce vardır. Biri
    eksikse unit 226/NAMESPACE ile başlamaz ve bu bir alarm sonucudur (DEC-27); agent dizin
    oluşturmaz.
12. Site config `suderra.site-config.v1` ifadesidir: `config-integrity` anahtarıyla imzalı, cihaza
    bağlı ve `tenant_id` taşır (DEC-3.3, DEC-22).
    - İçerik: `config.yaml`, çıkış politikası ve olay davranış tablosu (DEC-13), I/O haritası
      (io_config), fieldbus envanteri (Modbus cihazları ve slave id'leri, OPC UA hedefleri,
      PLC'ler), RevPi PiCtory `config.rsc` ve RBAC manifesti (kendi `rbac-manifest` imzasıyla iç içe
      DSSE; agent ayrıca doğrular).
    - Rollback koruması: cihaz ve payloadType başına monotonik `update_seq` (DEC-2.4),
      `not_before`/`expires_at`, epoch ratchet'i.
    - P0'da tek yol provisioning'dir. İlk site config, provisioning manifestinin config payload'ında
      iç içe `site-config` ifadesi olarak gelir. Değişiklik için bulut aynı cihaz için imzalı,
      cihaza bağlı yeni bir provisioning manifesti üretir ve bu manifest MAINTENANCE durumunda
      (DEC-12) yeniden provisioning ile kurulur. Bu profilde config topic hiçbir şey uygulamaz:
      `config.save()` ve `config_dispatch` uygulama yolu derlenmez ve mesaj `unsupported` sonucuyla
      reddedilir.
    - P1'de root update worker'a `kind=site-config` eklenir: aynı istek kanalı (DEC-2.3), aynı
      doğrulama (DSSE, device binding, zaman penceresi, epoch ratchet'i, `update_seq`) ve aynı
      install receipt. Kapsam: io_config, Modbus/PLC envanteri, RBAC manifesti, çıkış politikası ve
      PiCtory `config.rsc`. Bulutun config push'u (bugün `config_dispatch` ile işlenen config topic
      mesajı) bu profilde yalnız bir `site-config` ifadesi taşır; agent ifadeyi istek kanalına yazar,
      başka bir şey yapmaz. Çıkış politikasını, I/O haritasını veya `config.rsc`'yi değiştiren ifade
      bakım penceresi ve/veya yerel onay ister (DEC-13.4). Root yeni sürümü `/data/suderra/site/`
      altında yeni bir dizine yazıp `rename(2)` ile etkinleştirir, receipt'i günceller ve agent'ı
      yeniden yükleme yeterliyse `ExecReload` ile, değilse restart ile yeniler; `config.rsc`
      değişikliğinde `KB_RESET`'i root aracı yapar. Health window başarısızsa önceki site sürümü geri
      yüklenir (DEC-2.6).

**Gerekçe.** K1, K3, K9 ve K11 aynı kökten gelir: yol ve sahiplik birden fazla yerde, birbirinden
habersiz tanımlanmış. Tek çözücü ve tek sahiplik yazıcısı doğru davranışı varsayılan yapar
(2. kademe); invariant testler sapmayı build'de yakalar (3. kademe). Site config'in tek bir imzalı
ifade türüyle ve root üzerinden gelmesi, fiziksel çıkışları belirleyen verinin ele geçirilmiş bir
agent tarafından değiştirilememesini yapısal hale getirir (1. kademe).

**Sonuçlar / Riskler.**

- Kimlik bilgisi depolamasını göç ettirmeden taşımak mevcut cihazları ortada bırakır: token'ları
  harcanmıştır, kimlik bilgileri `config.yaml`'dadır → önce `$DATA/state`, sonra legacy mqtt
  alanları okunur.
- Generic cihazda machine-id kaynağını değiştirmek v1 DB anahtarını değiştirir → önce rekey.
- Journal reboot'ta kaybolur; reboot öncesi tanı bilgisi yalnız audit log, uygulama logları ve
  DEC-27 telemetrisindedir.
- P0–P1 arasında her site config değişikliği teknisyenli bir yeniden provisioning'dir (SENSOR-HIGH-210
  P1'de kapanır).
- `sens-api-gateway/docs/deployment/install.md` `config.yaml`'ı root:suderra 0600 yapıyor; agent
  okuyamaz → 0640.

**Uygulama.**

- aquaculture_platform: `sens-api-gateway/src/data_dir.rs`, `src/config.rs`, `src/main.rs`
  (aktivasyon `$DATA/state/activation.json`'a yazar), `src/db_secret.rs`, `src/offline_queue.rs`,
  `src/machine_id.rs`, `src/db_migration/`, `src/keystore/bootstrap.rs`,
  `src/authz/manifest_runtime.rs`, `src/scripting/storage.rs`, `src/license_cache.rs`,
  `src/scada_server.rs`, `src/config_integrity/verify_runtime.rs`,
  `src/commands/{provision.rs,config_dispatch.rs}`;
  `sens-api-gateway/tests/invariants/no_etc_write_paths.rs` (yeni; Suderra OS profilinde
  `$SUDERRA_DATA_DIR` dışında yazma yolu yok) ve `sens-api-gateway/tests/v1_6_0_fixture_boot.rs`
  (yeni; `sens-api-gateway/tests/fixtures/v1.6.0/` config ve DB fixture'larıyla);
  `sens-api-gateway/docs/deployment/install.md`;
  `apps/sensor-service/src/edge-device/site-config-manifest.service.ts` (yeni; P0 provisioning
  payload'ı, P1 config push).
- Suderra-OS: `overlay/usr/sbin/suderra-data-unlock`; `overlay/usr/lib/tmpfiles.d/suderra.conf`
  ve `overlay/usr/lib/suderra/data-layout.tmpfiles.conf` (yeni); `board/suderra/common/post-build.sh`
  (mountpoint'ler, boş `/etc/machine-id`, `/etc/revpi/config.rsc` symlink'i);
  `overlay/etc/systemd/system/suderra-agent.service` (Environment satırlarının kaldırılması,
  ReadOnlyPaths, ReadWritePaths, `ExecStartPre=+`, `ExecReload`);
  `overlay/etc/systemd/system/suderra-firstboot.service` (`/etc` yazmaları kaldırılır);
  `overlay/etc/systemd/network/10-ethernet.network` (`ClientIdentifier=mac`);
  `overlay/etc/systemd/journald.conf.d/10-suderra-volatile.conf` (yeni);
  `userspace/suderra-installer/src/cmd/site.rs` (yeni; `site apply`);
  `tests/image-contracts/single-owner-chown-contract-test.sh` (yeni).
- Kapatılan bulgular: EDGE-CRITICAL-046, EDGE-CRITICAL-047, EDGE-CRITICAL-048, EDGE-HIGH-050,
  EDGE-LOW-103, SENSOR-CRITICAL-200, EI-006, EI-041, EI-063, EDGE-LOW-112 (P0); SENSOR-HIGH-210
  (P1). Suderra OS profilindeki P0 işi `Refs:` taşıyan, kapanış commit'i DEC-28'in P2 generic profil
  işiyle gelen bulgular (kapanış kuralı, Implementation): EDGE-HIGH-054, EDGE-HIGH-055,
  EDGE-MEDIUM-079, EDGE-MEDIUM-080, EDGE-MEDIUM-085, SENSOR-HIGH-212, SENSOR-HIGH-215 ve
  EDGE-MEDIUM-072 (P0'da Suderra OS profilinde kimlik ve kart okuması).

**Faz.** P0: madde 1–11 ve madde 12'nin P0 yolu (ilk config ve yeniden provisioning). P1: madde
12'nin `kind=site-config` yolu. P2: TPM ile mühürlü DB anahtarı (madde 8; EDGE-MEDIUM-099).

---

### DEC-5 — Provisioning

**Karar.**

1. Provisioning modu bir imaj varyantı değil, `/data`'ya bağlı bir boot durumudur (DEC-12). Prod
   imaj provisioning birimlerini içerir (dropbear prod defconfig'lere eklenir), ama birimler yalnız
   root-owned yaşam döngüsü durumu PROVISIONING veya yeniden provisioning amaçlı MAINTENANCE
   (madde 14) iken çalışır (`ConditionPathExists=` ve koşul betiği). Bir kilit işaretinin yokluğu
   provisioning açmaz; belirsiz, eksik veya mount edilemeyen durum LOCKED'dur. `post-build.sh`'taki
   prod maskeleri (`:228-266`) birim koşullarıyla değiştirilir. Bu karar ADR-0005'in "PROD: SSH YOK"
   satırını değiştirir.
2. OTP: `suderra-provision-mode.service` her boot'ta bir tek-kullanımlık parola üretir, root-only
   `/run/suderra-os/` altında bir shadow oluşturup `/etc/shadow` üzerine bind-mount eder (ya da
   forced command OTP'yi kendisi doğrular); `/etc` mutasyonu yoktur. OTP süreli (varsayılan 2 saat),
   her başarısız denemede ve her reboot'ta yenilenir; süre dolunca pencere kapanır, yeniden açma
   yerel fiziksel eylem ister (PROVISIONING durumunda güç döngüsü).
3. MITM'e karşı: OTP ve SSH host-key fingerprint'i konsolda/HDMI'da birlikte gösterilir. Host key
   root-only `/data/suderra/os/ssh/`'te kalıcıdır. Staging adımı EK hash'ini ve host-key
   fingerprint'ini cihaz envanterine ve etikete (QR) yazar; bulutun ürettiği teknisyen komutu host
   key'i pinler (known_hosts satırıyla). Başsız RevPi'de beş programlanabilir RGB durum LED'i
   (A1–A5) provisioning / registered / locked / hata durumlarını gösterir.
4. Kapsam: P0'da provisioning SSH'ı yalnız provisioning anında varsayılan rotayı taşıyan arayüzde
   ve o arayüzün on-link alt ağında kabul edilir. Yürürlükteki imzalı manifest bir arayüz
   adlandırıyorsa o arayüz kullanılır: yeniden provisioning'de mevcut site config'i, USB
   bundle'ında bundle manifesti (DEC-11.6). Bugün kural her arayüzde ve her kaynaktan geçerlidir
   (`overlay/etc/nftables.provisioning.conf:20`). Aynı P0 değişikliğinde global
   `limit rate 10/minute` (LAN'daki herhangi bir host teknisyeni kilitleyebilir) yerine kaynak
   adresi başına bir nft meter gelir (`overlay/etc/nftables.provisioning.conf`).
5. Token taşıma: teknisyen `ssh provision@<ip> provision <device-code>` çalıştırır; token stdin'den
   okunup inbox'a (DEC-4.2) yazılır, root worker onu root-only bir dosyaya kopyalar ve
   `curl -H @dosya` ile `X-Provisioning-Token` header'ında gönderir; token argv, `ps` veya shell
   geçmişinde görünmez. Manifesti cihaz kendisi çeker
   (`GET /install/:code/suderra-os`) ve isteğe `device_binding` ile nonce ekler. Inbox yazımı ara
   ad + rename ile yapılır; path unit yalnız tetik dosyasını izler (bugün
   `suderra-provision:52`'deki akan `cat >` yarısı yazılmış dosyayı tetikleyebilir).
6. Bulut imzalı, cihaza bağlı `suderra.edge-provisioning.v1` üretir (DEC-3); payload iç içe
   imzalı ilk `site-config` ifadesini (DEC-4.12) ve trust-anchor bundle'ını (DEC-3.7) taşır; root
   her birini kendi anahtarına karşı doğrular. Manifest yalnız `/run/suderra-os/`'ta tutulur,
   kurulumdan sonra silinir, loglanmaz.
7. İki fazlı token: `TOKEN_ISSUED` → `MANIFEST_RESERVED` (`device_binding`'e bağlı; süre dolana
   kadar aynı binding için yeniden çekilebilir) → `ACTIVATION_PENDING` (kimlik bilgileri aynı
   binding için idempotent biçimde yeniden verilir) → `COMMITTED` (o cihazın kendi kimlik bilgisiyle
   ilk kimliği doğrulanmış MQTT CONNECT'i `/mqtt/auth`'ta görüldüğünde). Geçişler tek bir koşullu
   `UPDATE … RETURNING` ile atomiktir (koşul: `token_used_at IS NULL` ve rezervasyon boş ya da aynı
   binding'e ait); rezervasyon TTL'i kısadır. Bugünkü check-then-act
   (`provisioning.service.ts:357-407`) kaldırılır.
8. Activation receipt: COMMIT'ten sonra bulut, provisioning anahtarıyla imzalı, cihaza bağlı
   `suderra.edge-activation-receipt.v1` verir; agent onu `$DATA/state/activation-receipt.dsse`'ye
   yazar; root `suderra-activation.path` dosyayı kopyalar ve doğrular (anahtar, payloadType,
   `device_binding`, device_id, tenant_id, manifest digest), yaşam döngüsünü ACTIVE yapar ve
   lockdown'ı başlatır. Agent'ın yazdığı bir işaret kayıt kanıtı değildir (bugün
   `suderra-lockdown:41-43` bunu kabul eder). Health gate de agent'ı yalnız bu root-doğrulanmış
   duruma göre sayar (DEC-6).
9. Lockdown asenkron ve imaj-yerlidir: installer "kuruldu, kayıt bekleniyor" sonucunu döner;
   lockdown provisioning birimlerinin koşullarını false yapar, appliance ruleset'ini yükler, OTP'yi
   ve spool'u yok eder. Sonuç teknisyene okunmadan ve bir grace süresi dolmadan oturum kapatılmaz
   (bugün lockdown spool'u siler ve `pkill -KILL -u provision` yapar, worker sonucu yazmadan önce).
   `/etc/shadow` ve `/etc/systemd/system` yazmaları kaldırılır; firewall hatası yok sayılmaz (bugün
   `suderra-firewall || true`).
10. Hava boşluklu sahalar: imzalı USB provisioning bundle'ı (manifest + release statement +
    artifact) aynı doğrulayıcıdan geçer; binding teknisyenin tanımlama adımından (seri/QR) gelir,
    bulut manifesti önceden üretir; USB ingress DEC-18 kurallarına uyar.
11. Hedef kanal inbound port gerektirmeyen claim-code eşleştirmesidir: etiket/QR'daki EK hash'ine
    bağlı kod; teknisyen panelde bağlar; cihaz manifestini kendi TPM anahtarıyla proof-of-possession
    yaparak çeker. P3 çıkışında claim-code varsayılandır; SSH girişi site bazında açılan bir seçenek
    olarak kalır.
12. Suderra OS profili için tenant token'lı self-register kapalıdır
    (`provisioning.controller.ts:445-446`); manifest verme token'ının TTL'i 24 saatten saatlere
    iner.
13. Provision worker `After=time-sync.target` ile sınırlı süre bekler; saat senkron değilse
    teknisyene açık bir `clock-unsynced` sonucu döner (DEC-7).
14. Yeniden provisioning (DEC-17 akış a; P0'da site config değişikliğinin tek yolu, DEC-4.12):
    ACTIVE bir cihaz, bulutun imzaladığı ve cihaza bağlı `suderra.device-lifecycle.v1`
    (`action: enter-maintenance`, `purpose: reprovision`, süreli) ifadesiyle MAINTENANCE'a geçer
    (DEC-12). Provisioning yüzeyi madde 2–9'daki kurallarla ve aynı süre sınırıyla açılır. Aynı
    device_id için reserve/commit (madde 7) yeni kimlik bilgisi verir; yeni activation receipt ile
    cihaz ACTIVE'e döner. Süre dolarsa cihaz mevcut kurulum ve config ile ACTIVE'e döner.

**Gerekçe.** K4, K5, K12. Prod imajın bugün hiç provisioning yüzeyi yoktur:
`suderra_aarch64_revpi4_prod_ab_defconfig:92` dropbear içermez, `post-build.sh:188-189` prod'da
yalnız agent'ı etkinleştirir ve provisioning birimlerini maskeler. Agent tarafından yazılabilir bir
işarete bağlı lockdown, agent ele geçirildiğinde geri alınabilir.

**Sonuçlar / Riskler.**

- Prod imajda koşullu bir SSH daemon'u saldırı yüzeyini büyütür → süreli, arayüz kapsamlı, host-key
  pinli, OTP'li; claim-code varsayılan olana kadar (P3) EDGE-LOW-125.
- Bağlama "ilk gelen kazanır"dır: token'ı ilk sunan cihaz manifesti bağlar → token TTL'i ve
  gizliliği kritiktir.
- P3'e kadar aktivasyon cihaz anahtarına sahiplik kanıtı (PoP) istemez: bağlama provisioning
  token'ı, imzalı manifestteki `device_binding` hash'i ve bulut imzalı activation receipt'idir.
  Token'ı ele geçiren ve binding değerini (etiketteki EK hash'i) bilen biri kimlik bilgisi
  alabilir → kısa token TTL'i, iki fazlı token, COMMIT'in cihazın kendi kimlik bilgisiyle ilk MQTT
  CONNECT'e bağlanması (madde 7); PoP P3'te CSR ve cihaz anahtarlarıyla gelir (DEC-10.7;
  EDGE-MEDIUM-126).
- Reserve/commit, aktivasyon, MQTT auth ve token yaşam döngüsüne dokunur → eşzamanlılık testleri
  (çift aktivasyon, bayat rezervasyon).
- Canlı tesiste provisioning agent restart'ı ve çıkış değişimi demektir → DEC-13 penceresi.

**Uygulama.**

- Suderra-OS: `configs/suderra_aarch64_revpi4_prod_ab_defconfig`,
  `configs/suderra_aarch64_rpi4_prod_ab_defconfig`, `configs/suderra_x86_64_defconfig`,
  `configs/suderra_qemu_x86_64_prod_ab_defconfig` (`BR2_PACKAGE_DROPBEAR=y`);
  `board/suderra/common/post-build.sh`;
  `overlay/usr/sbin/{suderra-provision,suderra-provision-worker,suderra-lockdown}`;
  `overlay/usr/sbin/suderra-provision-mode` (yeni; madde 2);
  `overlay/etc/systemd/system/{suderra-provision-worker.path,suderra-provision-worker.service,suderra-firstboot.service}`;
  `overlay/etc/systemd/system/suderra-provision-mode.service` (yeni; madde 2);
  `overlay/etc/systemd/system/{suderra-activation.path,suderra-activation.service}` (yeni; madde 8);
  `overlay/etc/systemd/system/{suderra-lifecycle.path,suderra-lifecycle.service}` (yeni; madde 14);
  `overlay/etc/default/dropbear` (host key `/data`'da); `overlay/etc/nftables.provisioning.conf`
  (varsayılan rota arayüzüne kapsama ve kaynak başına meter, madde 4);
  `board/suderra/common/post-build.sh` (`/etc/shells`'e `/usr/sbin/suderra-provision`).
- aquaculture_platform:
  `apps/sensor-service/src/edge-device/{provisioning.service.ts,provisioning.controller.ts,installer-script.service.ts,mqtt-auth.service.ts,entities/edge-device.entity.ts}`;
  üretilmiş migration
  `apps/sensor-service/src/database/migrations/<ts>-EdgeProvisioningReservation.ts` (per-tenant
  `edge_devices`; `schema:` yok);
  `apps/sensor-service/src/edge-device/__tests__/provisioning-reservation.spec.ts` (yeni);
  `sens-api-gateway/src/main.rs` (aktivasyon akışı, receipt yazımı), `src/mqtt.rs` (ilk CONNACK).
- Kapatılan bulgular: EI-002, EI-003, EI-005, EI-015, EI-016, EI-025, EI-040, EI-057, EI-072,
  SENSOR-HIGH-205, SENSOR-MEDIUM-218, SENSOR-MEDIUM-222, SENSOR-MEDIUM-227 (P0); EI-011 ve EI-066
  (firstboot birimlerinin yerine `suderra-provision-mode.service` gelir, P0); EDGE-LOW-125
  (claim-code varsayılan, P3).

**Faz.** P0: provisioning durumu, `/run` OTP'si, header token, imzalı manifest, iki fazlı token,
receipt, asenkron lockdown, varsayılan rota arayüzüne kapsama ve kaynak başına meter (madde 4),
yeniden provisioning (madde 14). P1: USB bundle ingress, LED/etiket. P3: claim-code ve PoP.

---

### DEC-6 — Canlılık: READY, heartbeat, degraded mode, watchdog, health gate

**Karar.**

1. Tüm `sd_notify::notify` çağrıları `unset_env=false` kullanır (`main.rs:4225`). Invariant:
   `sens-api-gateway/src/`'de `notify(true` yoktur (çok iş parçacıklı runtime'da `remove_var` da
   güvensizdir).
2. Başlangıç sırası: config → donanım init → safe-state uygulanır → yerel kontrol döngüsü çalışır →
   READY. Ağ, aktivasyon ve MQTT asenkron arka plan görevleridir ve asla fatal değildir (bugün
   `MqttClient::new` hatası `?` ile `init_hardware` ve safe-state'ten önce süreçten çıkar;
   çevrimdışı boot çıkışları safe-state'e sürmeden crash-loop'a girer). READY ağı beklemez;
   `TimeoutStartSec`, her probe sınırlı olacak şekilde tam seri/Modbus taramasını kapsar.
3. "Fail closed" DEGRADED MODE demektir, çıkış değil: süreç ayakta, kontrol mantığı devre dışı,
   çıkışlar donanımın tanımladığı safe-state'te, alarm yükselmiş. Yapılandırılmış ama derlenmemiş
   veya bulunamayan bir backend (`gpio.rs:502-508`, `i2c.rs`) release build'de degraded mode'a
   geçirir; simülasyona sessiz düşüş release build'de kaldırılır. Degraded mode da READY gönderir ve
   durumu `STATUS=` ile ve `/run/suderra/agent-health` görünümüyle bildirir; böylece systemd restart
   döngüsü çıkışları tekrar tekrar değiştirmez.
4. Heartbeat kontrol döngüsünden gelir: watchdog ping'i yalnız I/O/kontrol döngüsünün ve script
   motorunun periyot başına canlılık sayaçları ilerlediyse gönderilir (son tamamlanan tick <
   `WatchdogSec/2`). Bugünkü serbest çalışan zamanlayıcı (`main.rs:4231-4251`) kaldırılır. Döngüdeki
   her bloklayan I/O çağrısının tick bütçesi vardır.
5. Agent hataları asla OS reboot'una tırmanmaz: agent unit'inde
   `FailureAction=`/`StartLimitAction=reboot` yoktur; `Restart=on-failure`,
   `StartLimitIntervalSec`/`StartLimitBurst` ve alarm vardır.
6. Donanım watchdog'unun tek sahibi systemd PID1'dir (`RuntimeWatchdogSec`, `RebootWatchdogSec`,
   `WatchdogDevice=` kart başına `system.conf.d`'de; timeout donanım maksimumunun altında,
   BCM2835'te ≈15 s). `Suderra-OS/userspace/suderra-watchdog` paketlenmez (bugün Buildroot paketi de
   yoktur; magic close'u herhangi bir root `systemctl stop`'un donanım watchdog'unu kapatmasına izin
   verir, sağlık tırmanması reboot döngüsü üretir). Prod kernellerde `CONFIG_WATCHDOG_NOWAYOUT=y`.
   Agent `/dev/watchdog` almaz. Kart başına cihaz, maksimum timeout ve reset kapsamı (yalnız SoC mu,
   taşıyıcı kart mı) donanımda doğrulanır: RevPi Connect 4'te PCF2129 RTC watchdog'u
   (`reset-source`) ile bcm2835-wdt arasında seçim ve kararlı udev symlink'i; x86'da iTCO
   (`I2C_I801`/`LPC_ICH` gerektirir, BIOS `NO_REBOOT` biti) veya modelin super-IO/EC watchdog'u.
7. RevPi I/O watchdog'u: agent'ın piControl backend'i açılışta `KB_SET_OUTPUT_WATCHDOG`'u kurar ve
   kontrol döngüsü tick'iyle besler; döngü durursa PiBridge çıkışları milisaniyeler içinde 0'a
   gider, 60 s'lik systemd watchdog'undan bağımsız. "0" güvenli olmayan çıkışlar (must-stay-on)
   donanım kablolamasıyla çözülür (DEC-13). Connect serisinin kart watchdog'u bir piControl süreç
   imajı bitiyle sürülüyorsa backend o biti asla değiştirmez; bu donanımda doğrulanır.
8. Health gate iki parçadır. `suderra-installer health check` OS ve agent yüklemidir, RAUC'a
   bağlı değildir ve her imajda vardır; `suderra-rauc-health-gate` RAUC slot durumunu denetler,
   yüklemi çağırır ve tek mark-good yoludur (bugünkü betik slot `A|B` değilse başarısız olur,
   `suderra-rauc-health-gate:17-21`; tek slotlu dev imajında çalışamaz). Yüklemin OS kontrolleri:
   verity mapping aktif (verity'li imajlarda), `/data` LUKS mapper'ı, nft ruleset yüklü ve hash'i
   eşleşiyor, yaşam döngüsü tutarlı, saat tabanın altına düşmemiş, TPM erişilebilir, BSP probları
   (TPM, RTC, PID1 watchdog'u, RevPi'de `/dev/piControl0`, x86'da Secure Boot etkin;
   `CONFIG_EFIVAR_FS` gerekir). Agent yalnız root-doğrulanmış activation receipt'i varsa (yaşam
   döngüsü ACTIVE) ve OS güncellemesinden önce sağlıklıysa (`/data/rauc/pre-update.json`) sayılır;
   anlık `is-active` yerine `activating → active` ve degraded olmama için sınırlı bekleme yapılır.
   Böylece fabrika-taze cihazda OS güncellemesi geri alınmaz (K8), ama OS/agent ABI kırılması
   (kernel, piControl) yakalanır. Yüklemin denetlediği özellik kümesi çalışma anı yoklamasından
   değil imajın build'de yazılan beyanından (`/etc/suderra/board`, DEC-8.2) gelir: beyan edilen bir
   özelliğin (verity, Secure Boot, RAUC) yokluğu başarısızlıktır; dev imajı verity, Secure Boot ve
   RAUC beyan etmez.
9. Üretim modu env'den okunmaz (DEC-19); `Suderra-OS/userspace/suderra-ota/src/main.rs:644`
   `SUDERRA_OTA_PRODUCTION` kaldırılır.

**Gerekçe.** K2 ve K8. Restart veya reboot döngüleri havalandırma ve pompaları tekrar tekrar
durdurur; bu canlı stok için fiziksel tehlikedir. PID1 tek sahip olarak daha küçük bir TCB'dir ve
PID1 kilitlenmesini de kapsar.

**Sonuçlar / Riskler.**

- NOWAYOUT ile planlı kapanışta besleme güç kesilene kadar sürmelidir; RevPi ve x86 zamanlaması
  doğrulanır.
- Döngüye bağlı heartbeat uzun bloklayan I/O'da yanlış tetiklenebilir → tick bütçesi.
- Çok sıkı health gate rollback fırtınası, çok gevşek gate bozuk slot sevk eder → kontroller
  contracts fixture'larıyla sabitlenir.

**Uygulama.**

- aquaculture_platform: `sens-api-gateway/src/main.rs` (`notify_systemd_ready`, READY'nin
  `run_agent` içinde safe-state'ten sonraya taşınması, MQTT/aktivasyon arka plan görevleri,
  heartbeat sayaçları), `src/gpio.rs`, `src/i2c.rs`, `src/spi.rs`, `src/pwm.rs`,
  `src/safe_state_v2.rs`, `src/degraded.rs` (yeni);
  `sens-api-gateway/tests/invariants/sd_notify_no_unset_env.rs`, `ready_after_safe_state.rs` (yeni)
  ve `sens-api-gateway/tests/offline_boot_safe_state.rs` (yeni; broker yokken safe-state ve READY).
- Suderra-OS: `userspace/suderra-installer/src/cmd/health.rs` (yeni; `health check`),
  `package/suderra-rauc-config/suderra-rauc-health-gate` (v2; yüklemi çağırır),
  `package/suderra-rauc-config/suderra-rauc-mark-good.service`;
  `overlay/etc/systemd/system.conf.d/10-suderra-watchdog.conf` (kart başına, yeni);
  `board/suderra/common/kernel-fragment.config` (`CONFIG_WATCHDOG_NOWAYOUT=y`); kart başına WDT
  sürücüleri `board/suderra/aarch64-rpi4/linux-rpi4.config`,
  `board/suderra/aarch64-revpi-connect4/linux-revpi-suderra.config` ve
  `board/suderra/x86_64/linux-x86_64.config`'te; QEMU için `board/suderra/x86_64/linux-qemu.config`'e
  `I6300ESB_WDT`;
  `package/suderra-ota/suderra-ota-mark-good.service` silinir; `userspace/suderra-ota/src/main.rs`.
- Kapatılan bulgular: EDGE-CRITICAL-049, EDGE-HIGH-051, EDGE-HIGH-052, EDGE-MEDIUM-078,
  EDGE-HIGH-061 (yazılabilir çıkışı olmayan config'le boot; izleme amaçlı dağıtımın ön koşulu),
  EI-008, EI-012, EI-030 (P0); EI-033 (P1).

**Faz.** P0: NOTIFY, READY sırası, degraded mode, döngüye bağlı heartbeat, `health check`
yüklemi ve receipt'e bağlanması, tek mark-good. P1: PID1 watchdog sahipliği, NOWAYOUT, kart başına
sürücüler, health gate genişletmesi, piControl output watchdog'u, RAUC kısmının prod-QEMU lane'inde
doğrulanması (P1 çıkışı, `suderra_qemu_x86_64_prod_ab_defconfig`). P0'da agent `/dev/watchdog`'u
kaybeder ve P1'e kadar donanım watchdog'unun sahibi yoktur (EI-033). Bu aralıkta sahada yalnız
izleme amaçlı dağıtım vardır (SG-1).

---

### DEC-7 — Zaman

**Karar.**

1. Zaman kimliği doğrulanmış kaynaktan gelir: chrony ≥ 4 NTS ile pinli sunuculara. OS'e ait bir
   `/etc/chrony.conf` sevk edilir (bugün overlay'de yoktur; Buildroot varsayılanı kimliksiz pool
   NTP'dir ve egress udp/123 her adrese açıktır, `overlay/etc/nftables.conf:52-53`). `makestep`
   yalnız ilk senkronda ve sınırlıdır; sonrasında eşiğin ötesindeki geri adımlar reddedilir; RTC'li
   kartlarda `rtcsync`; drift/dump dosyaları chrony'ye ait `/data/suderra/os/chrony/`'dedir
   (`/var/lib/chrony` bind'i, chrony:chrony 0750; DEC-4.2). Site NTP sunucuları imzalı site
   politikasından (DEC-11) render edilir; NTS desteklemeyen bir site sunucusu yalnız politika bunu
   açıkça işaretlerse kullanılır ve durum `synced-unauthenticated` olarak raporlanır.
2. Zaman tabanı = max(build zaman damgası, kalıcı son-iyi zaman). Root `suderra-timefloor.service`
   (`/data` açıldıktan sonra, `time-sync.target`'tan önce) tabanı uygular ve son-iyi zamanı
   periyodik olarak ve kapanışta root-owned `/data/suderra/os/time/`'a yazar (RTC'siz kartlarda
   fake-hwclock semantiği). RTC fiziksel erişimle ayarlanabilir bir alt sınırdır; çapraz kontrol
   edilir.
3. Senkron sinyali: `suderra-chrony-wait.service` (`chronyc waitsync`, sınırlı,
   `Before=time-sync.target`, başarısızlık fatal değil; Buildroot chrony paketi chrony-wait kurmaz,
   yani bugün `After=time-sync.target` etkisizdir). Root yardımcısı `/run/suderra/time-state` yazar
   (`unsynced` | `synced-unauthenticated` | `synced-nts`, offset, son senkron). Agent'ın saat
   otoritesi (bugün `nts_sync_age_secs=0`'ı koşulsuz raporlayan stub, `config.rs:274-280`) bu
   dosyayı okur; `ProtectClock` altında agent adjtimex okuyamaz.
4. Agent ve provision worker `After=`/`Wants=time-sync.target` kullanır; `Requires=` kullanılmaz.
5. Tazelik gerektiren aktüasyon saat senkron değilken bekletilir veya yeniden denenebilir
   `clock-unsynced` sonucuyla reddedilir; tazelik kontrolü atlanarak asla çalıştırılmaz. Manifest
   kurulumları senkron bekler; çevrimdışı USB yolu zaman tabanına göre değerlendirir. Yerel kontrol,
   safe-state ve alarmlar zamana bağlı değildir ve her durumda çalışır. Agent senkron olmayan saat
   yüzünden çıkmaz. Hangi durumun yettiği tüketici başına sabittir (sözleşme 1.2.0,
   `channels.json time`): root'un ifade kabulü (provisioning, edge-update, os-update, rbac-manifest,
   site-config, site-netpolicy) ve agent'ın tazeliğe bağlı aktüasyonu için `synced-nts` ve
   `synced-unauthenticated` yeter, `unsynced` yetmez (`clock-unsynced`); `synced-unauthenticated`
   yalnız imzalı site politikası düz bir NTP kaynağını işaretlediğinde oluşabildiğinden ve zaman
   tabanı (madde 2) geri adımı sınırladığından kabul edilir, düz NTP'ye güvenmeyen bir kurulum
   kaynak işaretlemez. Yerel kontrol her durumda çalışır. `time-state` belgesi en az 30 s'de bir
   yeniden yazılır; `updated_at`'i okuyanın saatinden 120 s'den fazla uzak, yok veya bozuk bir
   belge `unsynced` sayılır.
6. JTI dedup tutma süresi ≥ maksimum envelope geçerliliği + izin verilen sapmadır; anahtar
   (device, jti)'dir; depo reboot'tan sağ çıkar (DEC-4 DB anahtarı düzeltmesine bağlı).
7. Egress: udp/123 yalnız NTS sunucu kümesine ve tcp/4460 (NTS-KE), yalnız chrony UID'sinden
   (DEC-11). linuxptp kullanılırsa udp 319/320 yalnız OT rolünde.
8. RTC kernel desteği kart başına doğrulanır: RevPi `CONFIG_RTC_DRV_PCF2127=y` (built-in, hctosys
   için) ve overlay; bugünkü `RTC_DRV_DS1307`/`RTC_DRV_BCM2835` RevPi için yanlıştır; CM4 IO board
   PCF85063A ister; x86 CMOS yeterlidir, pil sağlığı telemetriye girer.

**Gerekçe.** Saat geri alınırsa süresi dolmuş manifestler ve komutlar yeniden geçerli olur ve sonucu
fiziksel aktüasyondur; ileri alınırsa her şeyin süresi dolar ve JTI kayıtları budanır. RTC'siz
kartlar ilk boot'ta epoch'ta başlar; hem TLS hem `not_before` başarısız olur.

**Sonuçlar / Riskler.**

- udp/123'ü engelleyen sahalarda saat senkron olmaz → mutating komutlar reddedilir; site NTS
  sunucusu veya imzalı istisna gerekir.
- Uzun güç kesintisinden sonraki meşru büyük adım kimliği doğrulanmış kaynaktan kurtarma ister.
- Kuyruktaki telemetri monotonik ofsetle damgalanır; sonraki adım yaş kontrollerini bozmaz.

**Uygulama.**

- Suderra-OS: `overlay/etc/chrony.conf` (yeni);
  `overlay/etc/systemd/system/{suderra-chrony-wait.service,suderra-timefloor.service,suderra-timefloor.timer}`
  (yeni); `overlay/usr/sbin/suderra-time-state` (yeni); `board/suderra/common/post-build.sh`;
  `overlay/etc/nftables.conf`; `overlay/etc/systemd/system/suderra-provision-worker.service`;
  `userspace/suderra-installer/src/contracts.rs` (`--clock-floor-file`);
  `board/suderra/aarch64-rpi4/linux-rpi4.config` ve
  `board/suderra/aarch64-revpi-connect4/linux-revpi-suderra.config` (yeni, DEC-8).
- aquaculture_platform: `sens-api-gateway/src/config.rs` (chrony tabanlı saat otoritesi),
  `src/command_envelope/envelope.rs`, `src/commands/envelope_adapter.rs` (senkron kapısı; bugün
  `SystemTime::now` + `unwrap_or(0)`), `src/command_envelope/envelope.rs`'teki JTI tutma sabiti;
  `sens-api-gateway/systemd/suderra-agent.service:33`.
- Kapatılan bulgular: EI-046, EI-052, EDGE-MEDIUM-077 (P1). EDGE-MEDIUM-090'ın JTI tutma kısmı P1'de
  `Refs:` taşır; bulgu replay pencereleriyle birlikte DEC-9'da P2'de kapanır.

**Faz.** P1. Generic referans unit'teki `Requires=` → `Wants=` düzeltmesi P0'daki unit
contract'ıyla. P0'da Enforcing komut yolu saat senkron kapısı olmadan çalışır; bu EDGE-MEDIUM-077'dir
ve P1'de kapanır. Bu aralıkta sahada yalnız izleme amaçlı dağıtım vardır, fiziksel aktüasyon komutu
yoktur (SG-1).

---

### DEC-8 — Kartlar, kernel ve agent profilleri

**Karar.**

1. Hedefler: RevPi Connect 4 + PiBridge (birincil), endüstriyel x86 (yalnız Linux; model seçilmedi),
   RPi4/CM4 (ikincil) ve CI/dev için QEMU x86_64. armv7 Suderra OS kanalından çıkarılır; generic
   kanalda filo envanteri sıfır armv7 gösterene kadar kalır (DEC-28).
2. Kart kimliği imzalı OS imajından gelir: `/etc/suderra/board` (verity üzerinde, defconfig başına
   build'de yazılır: `board_profile`, arch, `rauc_compatible` ve imajın beyan ettiği özellikler:
   verity, Secure Boot, RAUC, TPM). ARM'da DT `compatible`, x86'da DMI
   vendor/product (imzalı allowlist) yalnız çapraz kontrol iddiasıdır; uyuşmazlık degraded mode ve
   alarm demektir. `detect_board` (`suderra-edge-install:41-55`) prod'da kullanılmaz. Fonksiyonun
   bir RevPi dalı vardır (`*RevPi*|*Revolution Pi*` → `revpi4`, `:49`), ama dal
   `/proc/device-tree/model`'e bakar ve bugünkü RevPi imajının kullandığı genel CM4 DTB'sinin model
   string'i "RevPi" içermez. Bu yüzden RevPi Connect 4'te `rpi4-cm4` döner (`:50`). KUNBUS overlay'i
   de yalnız `compatible`'ı değiştirir, model string'ini değil (HW DEC-1 A5). Model string'i
   böylece hiçbir RevPi imajında güvenilir bir kart kimliği değildir; kart kimliğinin imzalı imajdan
   gelmesinin nedeni budur. Dal tetiklense bile `revpi-connect4` değil `revpi4` döner (madde 4'teki
   sözlüklerden biri). `SUDERRA_TARGET_BOARD` env'i tespiti tümüyle ezer (`:42`, DEC-19); x86 dalı
   yoktur (`:53-54`, exit 2). Agent'ın `detect_gpio_platform`'u (`config.rs:114-126`, "Raspberry Pi"yi
   RevPi'den önce eşleştirir) da prod'da kullanılmaz. Manifest `board` = imaj `board_profile` =
   release statement `board_profile`. Yanlış tespit RevPi'de PiBridge, LED ve rölelere bağlı CM4
   GPIO'larını sürer: güvensiz aktüasyon.
3. Kart başına ayrı RAUC compatible (ADR-0007 corr-M3): `suderra-os-revpi-connect4`,
   `suderra-os-rpi4-cm4`, `suderra-os-x86-ipc-<model>`, `suderra-os-qemu-x86_64`.
4. Kart kimliği sözlüğü tektir: `contracts/suderra-edge/v1/boards.json` (DEC-25). Installer, manifest,
   release artifact adları, agent profili, RAUC compatible ve bulut `DeviceModel` eşlemesi
   (`entities/edge-device.entity.ts`) buradan türetilir. Bugün beş ayrı sözlük vardır: installer
   `revpi4` / `rpi4-cm4` (`suderra-edge-install:49-50`); agent `GpioPlatform::{RaspberryPi,
   RevolutionPi, …}` (`config.rs:89`); bulut `DeviceModel` (`revolution_pi_connect_4`,
   `raspberry_pi_4`, `industrial_pc`, …; `edge-device.entity.ts:103-114`); release
   `target_slug` yalnız arch'tır (`x86_64-linux`, `aarch64-linux`, `armv7-linux`;
   `edge-agent-release.yml:156-162`); RAUC compatible yalnız arch'tır (`suderra-os-x86_64`,
   `suderra-os-aarch64`; `system.conf:2`, `system.conf.arm:2`).
5. Release matrisi (arch, board profile) başınadır:
   `suderra-agent-os-<version>-<board_profile>-<arch>.tar.gz`, içinde `suderra-agent`, yanında DSSE
   release statement. Feature setleri aşağıdaki matristedir. Agent, release statement'taki profil OS
   kartından farklıysa kontrolü başlatmaz (degraded mode). ELF `NEEDED` girdileri (serialport
   üzerinden libudev, `tpm` ile tss2) OS sysroot'una karşı CI'da kontrol edilir.
6. RevPi kernel'i: pinli KUNBUS RevolutionPi kernel'i (`gitlab.com/revolutionpi/linux` `revpi-6.12`
   dalı, değişmez commit + hash, `revpi-v8_defconfig` tabanı, PREEMPT_RT) ve üzerine Suderra
   hardening fragment'ları. piControl built-in derlenir ya da modül imzalama anahtarıyla imzalanır
   (ADR-0007 M3, `MODULE_SIG_FORCE`). Ek sürücüler: `GPIO_PCA953X`, `LEDS_GPIO`, `RTC_DRV_PCF2127`.
   Hardening (lockdown, `MODULE_SIG_FORCE`, init_on_free, verity, dm-crypt, nft inet/ct, TPM-SPI) bu
   kernel üzerinde yeniden doğrulanır (ADR-0007 G4).
7. RevPi device tree: `revpi-connect4` overlay'i image build'de `fdtoverlay` ile
   `bcm2711-rpi-cm4.dtb` üzerine birleştirilir ve imzalı FIT'te ayrı bir config (compatible
   `kunbus,revpi-connect4`) olarak gelir; `bootm` FIT'in DTB'sini kullandığı için config.txt
   overlay'leri kernel'e ulaşmaz. CI kapısı FIT DTB'sinde `tpm@0`, `rtc@51`, pibridge ve uart5 rs485
   düğümlerini doğrular.
8. RevPi I/O: agent'ın `revpi-io` backend'i `/dev/piControl0` üzerinde `lseek`/`read`/`write` ve
   ioctl allowlist'i {`KB_GET_DEVICE_INFO_LIST`, `KB_GET_VALUE`, `KB_SET_VALUE`, `KB_FIND_VARIABLE`,
   `KB_SET_OUTPUT_WATCHDOG`, `KB_WAIT_FOR_EVENT`} kullanır. Firmware/reset/stop ioctl'leri
   (`KB_UPDATE_DEVICE_FIRMWARE`, `PICONTROL_UPLOAD_FIRMWARE`, `KB_RESET`, `KB_STOP_IO`; piControl'de
   capability kontrolü yoktur) bu profilde derlenmez; yalnız root OS aracı çağırır.
   `/dev/piControl0` tüm süreç imajına ya-hep-ya-hiç erişim verdiği için backend kendi çıkış
   allowlist'ini ve force registry'sini uygular; agent tek yazıcıdır (udev grubu `suderra-io` yalnız
   agent'ı içerir). `piTest` exec'i (`hardware_scanner.rs`) kullanılmaz; piTest ve PiCtory imaja
   konmaz. PiCtory `config.rsc` güvenlik açısından anlamlı site config'idir: imzalı payload'la
   `/data/suderra/site/revpi/`'ye gelir, yerinde düzenlenmez. revpi profili rppal `gpio` içermez: DI
   ve röle hatları kernel pibridge düğümüne aittir, `/dev/gpiomem` erişimi kernel ile yarışır.
9. x86 yalnız Linux: Windows silinir. Suderra x86 USB installer imajı eklenir (bugün yalnız
   `configs/suderra_aarch64_rpi4_usb_installer_defconfig` var). Dönüşüm runbook'u: (1) BIOS'ta SB
   anahtarlarını Setup Mode'a al, CSM'i kapat; (2) USB installer'dan boot; (3) NVMe/eMMC'yi tamamen
   sil, Windows `Boot####` girdilerini sil, TPM'i PPI ile temizle (Suderra hiyerarşilere sahip
   olur); (4) Suderra PK/KEK/db'yi kaydet — Microsoft UEFI CA db'de yalnız seçilen modelin option
   ROM'ları gerektiriyorsa kalır, o durumda mühür PCR 7 + 11 imzalı politikadır (DEC-14); SB'yi
   etkinleştir; (5) BIOS admin parolası, harici boot (USB/PXE) kapalı, boot sırası kilitli; (6)
   Intel ME/AMT kapalı veya vPro'suz SKU, IOMMU/DMA koruması açık, dTPM tercih; (7) chipsec ile
   qualification kanıtı (SPI/BIOS yazma koruması, SMM). Kernel sürücü kümesi ve super-IO watchdog'u
   model başına doğrulanır; kernel monolitik olduğundan sürücüler `=y`'dir. Prod'da shim/MOK yolu
   kullanılmaz (bootloader Suderra db anahtarıyla imzalıdır); MOK yalnız dev imajları içindir. 2026
   Microsoft CA rotasyonu (KEK CA 2011, UEFI CA 2011, Windows Production PCA 2011 sona erişleri)
   db/dbx/KEK güncellemesi demektir; PCR 7 değişir; recovery yolu zorunludur (DEC-14).
10. x86 kernel'i (`board/suderra/x86_64/linux-x86_64.config`; x86 hedefi ve prod-QEMU imajı
    kullanır, `configs/suderra_qemu_x86_64_prod_ab_defconfig:33`) P0'da `DM_CRYPT`,
    `NF_TABLES_INET`, `NFT_CT`, `NF_CONNTRACK`, `NFT_LIMIT`, `NFT_REJECT`, UKI'nin verity
    initramfs'i için `BLK_DEV_INITRD` ve `RD_GZIP` (EI-009) ve USB (xHCI, HID, usb-serial
    FTDI/CP210x/CH341/PL2303) alır. Dev QEMU imajı başka bir config kullanır (`x86_64_defconfig` +
    `board/suderra/x86_64/linux-qemu.config`, `configs/suderra_qemu_x86_64_defconfig:37-39`). Onun
    bugünkü build'inde `NF_TABLES_INET` ve `NF_CONNTRACK` `x86_64_defconfig`'ten gelir, `NFT_CT`,
    `NFT_LIMIT`, `NFT_LOG`, `TCG_TPM`, `DM_CRYPT` ve `CRYPTO_USER_API_SKCIPHER` kapalıdır,
    `NFT_REJECT`/`NFT_REJECT_INET` modüldür
    (`output/suderra_qemu_x86_64_defconfig/build/linux-6.12.6/.config:1140`, `:1157-1169`, `:1926`,
    `:2708`, `:4828`); `nftables.conf` (`ct state`, `limit`) bu kernel'de yüklenmez. P0'da
    `linux-qemu.config`'e `=y` olarak girenler: `NF_TABLES_INET`, `NF_CONNTRACK`, `NFT_CT`,
    `NFT_LIMIT`, `NFT_REJECT`, `NFT_REJECT_INET`, `NFT_LOG`; swtpm için `TCG_TPM`, `TCG_TIS`,
    `TCG_CRB`; `DM_CRYPT` ve `CRYPTO_USER_API_SKCIPHER`. Aynı fazda
    `configs/suderra_qemu_x86_64_defconfig`'e `BR2_PACKAGE_SUDERRA_KEYS` (CI/dev test anahtarlarıyla,
    `scripts/ci/prepare-ci-keyring.sh` ve `scripts/gen-dev-keys.sh`), `BR2_PACKAGE_SUDERRA_OS_INSTALLER`
    (doğrulayıcı; bugün yok, EI-023), `BR2_PACKAGE_TPM2_TSS`, `BR2_PACKAGE_TPM2_TOOLS` (EK okuması) ve
    `BR2_PACKAGE_CRYPTSETUP` eklenir. `tests/image-contracts/kernel-config-contract-test.sh` (yeni)
    gerekli sembol kümesini her PR'da her kart config'inde ve fragment'ında denetler.
    Model qualification'ında `I2C_I801`, `LPC_ICH`, super-IO WDT,
    igb/igc, 8250/Exar/LPSS UART, `MMC_SDHCI`, `EFIVAR_FS`, CPU mikro kodu ve gerekli firmware
    blob'ları (`CONFIG_EXTRA_FIRMWARE`) kesinleşir.
11. RPi4/CM4, OTP secure boot ve add-on TPM olmadan SL2 iddia edemez. Bugünkü prod `/data`
    provizyonu TPM'siz fail-closed'dur (`suderra-data-unlock:53-57`). Bu kartın üretimde nasıl
    kullanılacağı açık bir operatör sorusudur (Soru 3; EDGE-MEDIUM-120).
12. Kernel hattı tek 6.12 LTS majörüdür: RevPi KUNBUS `revpi-6.12`, RPi raspberrypi `rpi-6.12.y`,
    x86 kernel.org `6.12.y`; SHA + hash pinli; aylık bump sahibi ve CVE tetikli bant dışı bump; CI
    kernel sürümünün header serisine eşit olduğunu doğrular (bugün ARM 6.6.28 kernel'i 6.12
    header'larıyla derlenir: `suderra_aarch64_revpi4_prod_ab_defconfig:22`, `:30`).

**Kart matrisi.**

| | RevPi Connect 4 + PiBridge (birincil) | Endüstriyel x86 IPC (model seçilmedi) | RPi4 / CM4 (ikincil) | QEMU x86_64 (CI/dev) |
|---|---|---|---|---|
| Board profile / RAUC compatible | `revpi-connect4` / `suderra-os-revpi-connect4` | `x86-ipc-<model>` / `suderra-os-x86-ipc-<model>` | `rpi4-cm4` / `suderra-os-rpi4-cm4` | `qemu-x86_64` / `suderra-os-qemu-x86_64` |
| Kernel | KUNBUS `revpi-6.12` pinli, PREEMPT_RT, Suderra hardening yeniden doğrulanmış; piControl built-in veya imzalı | kernel.org 6.12.y, monolitik; P0: DM_CRYPT, nft inet/ct/limit, BLK_DEV_INITRD, USB; model başına sürücü kümesi | raspberrypi `rpi-6.12.y` (bugün 6.6.28 @576cc10) | dev: 6.12.6 `x86_64_defconfig` + `linux-qemu.config` (P0: nft inet/ct/limit/reject/log, TPM TIS/CRB, DM_CRYPT, `CRYPTO_USER_API_SKCIPHER`; P1: `I6300ESB_WDT`); prod-QEMU: `linux-x86_64.config` + `kernel-fragment.config` |
| DT / kart kimliği | `bcm2711-rpi-cm4.dtb` + `revpi-connect4.dtbo` → birleşik DTB imzalı FIT'te; çapraz kontrol `kunbus,revpi-connect4` | DT yok; `/etc/suderra/board` + DMI imzalı allowlist | `bcm2711-rpi-cm4(-io).dtb` FIT'te | `/etc/suderra/board` |
| TPM | Infineon SLB9670 SPI TPM 2.0 (yalnız overlay ile görünür) | dTPM 2.0 tercih; Intel PTT kabul; AMD fTPM değil | yok; add-on SLB9670 opsiyonu | swtpm. dev: yalnız cihaz kimliği (EK hash'i); prod-QEMU: kimlik ve `/data` mühürü |
| RTC | NXP PCF2129 (i2c 0x51, CR2032), `RTC_DRV_PCF2127=y` | CMOS, pil sağlığı telemetrisi | Pi 4B yok; CM4 IO PCF85063A; fake-hwclock | QEMU RTC |
| Donanım watchdog'u | PID1; PCF2129 `reset-source` veya bcm2835-wdt (reset kapsamı donanımda doğrulanır); I/O için piControl `KB_SET_OUTPUT_WATCHDOG` | PID1; iTCO (I2C_I801/LPC_ICH) veya model super-IO/EC WDT | PID1; bcm2835-wdt, maks. ≈15 s | PID1; QEMU `i6300esb` cihazıyla test (P1) |
| Secure boot kök güveni | U-Boot FIT imzası (ADR-0007); ilk aşama yalnız OTP secure boot ile (geri dönüşsüz; karar Soru 7) | UEFI SB, Suderra PK/KEK/db; Microsoft UEFI CA yalnız option ROM gerektiriyorsa; BIOS parolası, harici boot kapalı, ME/AMT kapalı, IOMMU açık | U-Boot FIT imzası; OTP secure boot yoksa ilk aşama imzasız | dev: SB yok, RAUC yok, rootfs rw ext4; prod-QEMU: OVMF + CI'da üretilen SB test anahtarları, UKI, verity, RAUC A/B |
| Disk anahtarı mühürleme | LUKS2 + TPM2; measured boot olmadan mühür hiçbir ölçüme bağlı değil → U-Boot measured boot + imzalı PolicyAuthorize (DEC-14, P3) | PCR 7 + imzalı PCR 11 politikası (P1, SB sahipliğiyle); PCR 0/2/4 yok; recovery key emaneti | TPM yoksa prod `/data` bugün fail-closed | dev: şifreleme yok; `/data` `SUDERRA-DATA` etiketli düz ext4 (DEC-12); prod-QEMU: LUKS2 + swtpm, PCR 7 + imzalı PCR 11 (P1 çıkışında doğrulanır) |
| Agent profili ve feature'lar | `suderra-os`, `revpi-io`, `scada-display`; P2'den `tpm` (TPM keystore, DEC-21); `gpio` yok | `suderra-os`, `scada-display`; P2'den `tpm` | `suderra-os`, `gpio`, `scada-display` (add-on TPM varsa P2'den `tpm`) | `suderra-os`, `scada-display`; P2'den `tpm` |
| I/O backend | `/dev/piControl0` (ioctl allowlist, çıkış allowlist'i, force registry); RS485 `/dev/ttyAMA5` (`/dev/ttyRS485`); 2× GbE (WAN/OT) | fieldbus: Modbus TCP/RTU (`ttyS*`, `ttyUSB*`, Exar/LPSS), OPC UA, CAN (AF_CAN drop-in); yerel çıkış katı yok | rppal GPIO, I2C, SPI, `ttyAMA0` | sahte Modbus sunucusuna karşı test |
| SL iddiası (SG-2) | SL2 hedefi; koşul: P3 çıkışı, OTP secure boot + measured boot + ADR-0007 G4/G5 kanıtı | SL2 hedefi; koşul: P3 çıkışı, model qualification + SB sahipliği + imzalı PCR politikası + recovery yolu | SL2 iddia edilemez (add-on TPM + OTP secure boot olmadan) | yok (test) |

**Gerekçe.** K7, K13, K14. Kart kimliği cihazın kendi beyanına (DT model string'i) dayandığında,
yanlış I/O backend'i fiziksel zarar demektir; imzalı imajdaki kimlik buna izin vermez. Board profile
matrisi build'de belirlenir, yani bir feature'ın yokluğu çalışma anında değil CI'da görünür.

**Sonuçlar / Riskler.**

- KUNBUS kernel'i mainline'ı geriden izler ve kendi CVE kadansı vardır → backport sahipliği
  operatör sorusudur (Soru 4; öneri: Suderra'nın sahip olduğu pinli fork, aylık senkron, her
  bump'ta kernel hardening contract testleri).
- Microsoft UEFI CA çıkarılırsa seçilen modelde option ROM kırılması (video/POST) olabilir;
  tutulursa mühür zayıflar → model başına doğrulama.
- armv7'yi erken bırakmak 32-bit filoyu güncelleme yolsuz bırakır → yalnız OS kanalından çıkar.
- 8 GB eMMC RevPi varyantında KUNBUS kernel, modüller ve iki release ile alan daralır → üretim için
  asgari 32 GB önerilen varsayılandır; SKU seçimi operatör kararıdır (Soru 6).
- HAT EEPROM'un overlay'i kendiliğinden yükleyip yüklemediği ve eth1'i hangi kontrolcünün sürdüğü
  donanımda doğrulanmamıştır (ADR-0007 G4 maddesi).
- Dev QEMU imajı read-only kökü, RAUC'u, verity'yi ve LUKS'u içermez; bunlar P1 çıkışında prod-QEMU
  imajıyla, read-only kök davranışları P0'da sandbox testiyle doğrulanır (Uygulama, P0).

**Uygulama.**

- Suderra-OS: `board/suderra/aarch64-revpi-connect4/` (yeni: `config.txt`, `genimage-prod.cfg`,
  `linux-revpi-suderra.config`, `revpi-connect4.its`); `configs/suderra_aarch64_revpi4_defconfig` ve
  `configs/suderra_aarch64_revpi4_prod_ab_defconfig` (KUNBUS kernel tarball'ı ve hash'i,
  `board/suderra/buildroot-hashes/linux`);
  `package/revpi-picontrol/{Config.in,revpi-picontrol.mk,revpi-picontrol.hash}` (yeni, kernel-module
  altyapısı; kök `Config.in`'e eklenir); `scripts/production-artifacts.sh` (fdtoverlay ve FIT DTB
  kapısı);
  `package/suderra-rauc-config/system.conf`, `system.conf.arm` ve `ci/evidence-contract.yml` (ayrı
  compatible'lar); `board/suderra/x86_64/linux-x86_64.config`;
  `board/suderra/x86_64/linux-qemu.config`; `configs/suderra_qemu_x86_64_defconfig`;
  `tests/image-contracts/kernel-config-contract-test.sh` (yeni);
  `configs/suderra_x86_64_usb_installer_defconfig` (yeni); `board/suderra/common/post-build.sh`
  (`/etc/suderra/board`); `tests/image-contracts/x86-hardware-station-contract-test.sh`;
  `docs/security/field-appliance-hardening.md` (x86 SB/TPM fabrika runbook'u).
- aquaculture_platform: `.github/workflows/edge-agent-release.yml` (matris, adlandırma, ELF NEEDED
  kontrolü, armv7 yalnız generic kanalda); `sens-api-gateway/Cargo.toml` (`revpi-io`, `suderra-os`);
  `sens-api-gateway/src/picontrol.rs` (yeni); `src/hardware_scanner.rs`; `src/config.rs` (kart
  tespiti); `apps/sensor-service/src/edge-device/entities/edge-device.entity.ts` (`DeviceModel` →
  board profile).
- RevPi backend'i, P1 agent uygulaması (`sens-api-gateway/src/picontrol/`; sürücü, OS'un pinlediği
  KUNBUS piControl v2.6.2'dir (`Suderra-OS/package/revpi-picontrol/revpi-picontrol.{mk,hash}`):
  etiket `v2.6.2`, commit `7acf6e9110dd558b434b57f50ee5d4b5d54b5d91`,
  `https://gitlab.com/revolutionpi/piControl/-/archive/7acf6e9110dd558b434b57f50ee5d4b5d54b5d91/piControl-7acf6e9110dd558b434b57f50ee5d4b5d54b5d91.tar.gz`,
  indirilen arşivin sha256'sı `7ea4192156c3a98b4a21df67aa37ffe2dff098088d30c967a81d86da12849349`.
  Davranış sorusunun cevabı o etiketteki `src/piControlMain.c`'dir. İstek numaraları ve yapı
  boyutları başlık dosyası gerçek `_IO()` makrosuyla derlenerek alındı ve v2.8.2 ile (etiket
  `v2.8.2`, commit `7980b36f361a8c31680dbd1cbc8d567a7afa4a38`, arşiv sha256'sı
  `ea6b8277c70d066068b3f4e359ad73730c3b9af93cb89ce23b3f77c26959e437`) karşılaştırıldı: ikisinde de
  aynıdır; kapanışta sıfırlama, reset olayı, varsayılan imaj ve ofset aritmetiği de iki sürümde
  aynıdır. Üç davranış farkı agent'ta karşılanır ve her biri iki sürüme karşı sınanır (sahte
  çekirdek varsayılan olarak v2.6.2'dir, `Driver::V2_8_2` ile v2.8.2 oynar): (1)
  `KB_SET_OUTPUT_WATCHDOG` v2.6.2'de bir C `unsigned long` okur (`get_user(...,
  (unsigned long __user *) usr_addr)`: AArch64'te 8 bayt, 32 bit ARM'de 4), v2.8.2'de
  `unsigned int` (4 bayt); agent argümanı `unsigned long` genişliğinde verir, değer alt dört
  baytta, kalanı sıfır (`abi::watchdog_arg`): 4 baytlık bir tampon sürücünün tamponun yanındaki
  baytları okuyup çöp bir periyot kurmasına ya da kapatmanın (0) başarısız olmasına, o zaman da
  descriptor kapanırken tüm çıkışların sıfırlanmasına yol açardı; (2) v2.6.2 bilinmeyen değişken
  adı için `KB_FIND_VARIABLE`'dan `ENOENT` değil `EFAULT` döndürür (durum hiç atanmaz, "bulunamadı"
  varsayılanları geri kopyalanır); agent bunu "değişken yok" sayar, yani yerleşim kanıtsızdır;
  (3) `KB_WAIT_FOR_EVENT` bir sinyalle kesilince v2.6.2 `EFAULT`, v2.8.2 `EINTR` döndürür; agent
  ikisini de "yeniden bekle" sayar, olay iş parçacığı bitmez).
  Çıkış allowlist'i `config.yaml`'ın imzalı `picontrol:` bölümüdür (noktalar, yön,
  `safe_state_value`); taban modülün çıkışları (LED'ler, Connect 4 X2 çıkışı ve Connect/Connect SE'de
  kart watchdog tetik biti `PICONTROL_WD_TRIGGER` = 0x80) allowlist'e giremez, yani kart watchdog
  bitine dokunmamak bir özen kuralı değil yapı gereğidir. Bir çıkışın güvenli değeri `config.rsc`'nin
  o değişken için bildirdiği varsayılana eşit olmak zorundadır, çünkü sürücü PiBridge başlangıcında
  varsayılan imajı süreç imajının üzerine kopyalar (`PiBridgeMaster_setDefaults`): reset ve yeniden
  başlatma çıkışı o değere düşürür. Agent değişken adlarını imzalı `config.rsc`'den çözer, her adı
  sürücüye `KB_FIND_VARIABLE` ile doğrulatır ve her yazmadan önce soruyu tekrarlar; sürücü reset
  olayı (`KB_EVENT_RESET`) ya da cihaz listesinin dosyayla uyuşmaması düzeni "kanıtsız" yapar, yazma
  ve safe-state reddedilir, yeni imzalı dosya SIGHUP ile `reload` edilir. Süreç imajı `lseek` +
  `read`/`write` ile erişilir (tek `read` tutarlı bir anlık görüntüdür); tek bit `KB_SET_VALUE` ile
  yazılır (sürücünün kilidi altında oku-değiştir-yaz), daha geniş değer yalnız kendi baytlarıyla.
  Çıkış watchdog'u (madde 6.7) açılışta değil döngünün ilk tick'inde kurulur ve her tick'te aynı
  ioctl'le beslenir (süreç imajına yazmadan): açılışla döngü başlangıcı arasındaki saniyeler,
  periyottan kısa bir watchdog'un başlayan agent'ın çıkışlarını sıfırlamasına yol açardı. Sürücü,
  watchdog'u kurulu bir descriptor kapanınca tüm çıkışları sıfırladığı için agent watchdog'u yalnız
  safe-state tamamlandıktan sonra kapatır: zarif yeniden başlatma güvenli değerleri korur, çökme
  çıkışları sıfırlar (DEC-13.3 tablosu `src/picontrol/behaviour_table.rs`; sahte çekirdekle
  `cargo test`te, gerçek donanımda `tests/hil/output_behaviour_table.rs` ile). Safe-state geçişi
  çıkış listesini açılıştaki yapılandırma anlık görüntüsünden değil sürücüye karşı kanıtlanmış kayıt
  defterinden alır: SIGHUP yeniden yüklemesiyle sonradan verilen bir çıkış da güvenli değerine
  sürülür (aksi halde `release` watchdog'u kapatır ve o çıkış son değerinde kalırdı); yeniden
  yüklemede kaldırılan çıkışı sürücünün sıfırlaması zaten PiCtory varsayılanına döndürmüştür.
  Genel (generic) profilin sabit unit'i (`DevicePolicy=closed`, DEC-28) `/dev/piControl0`'a izin
  vermez; o profilde `revpi-io` bir operatör drop-in'i gerektirir, Suderra OS'ta izin
  `revpi-connect4` drop-in'inden gelir. Sağlık görünümü
  sözleşmesinin `reasons[].code` listesi piControl için kod tanımlamaz; agent en yakın tanımlı kodu
  (`boot-dependency-failed`) kullanır, ayrıntı piControl'ü adlandırır. Bir sözleşme revizyonu
  `picontrol-backend-unavailable` kodunu eklemelidir.
- Kapatılan bulgular: INFRA-CRITICAL-236, SENSOR-MEDIUM-224, EI-009, EI-018, EI-020, EI-021, EI-043,
  EI-023 (dev imajına doğrulayıcı ve anahtarlar) (P0); EI-024, EI-028, EI-029, EI-032, EI-045,
  EI-047, EI-048, EI-051, EI-065, EDGE-HIGH-053, EDGE-MEDIUM-120 (Soru 3 kararı ve bulutun
  uyguladığı kart politikası) (P1); EDGE-LOW-104 (P2).

**Faz.** P0: release matrisi, adlandırma, `/etc/suderra/board`, x86 kernel'inde
DM_CRYPT/nft/initramfs/USB, dev QEMU kernel'inde ve defconfig'inde madde 10'daki semboller ve
paketler, kernel config contract testi, eksik backend için degraded mode. P1: RevPi KUNBUS kernel'i,
overlay, piControl backend'i ve revpi profili; x86 USB installer'ı, SB sahiplik runbook'u ve sürücü
kümesi; ayrı RAUC compatible'lar; tek 6.12 hattı.

---

### DEC-9 — Komut güvenliği

**Karar.**

1. Suderra OS profilinde imza modu her yerde Enforcing'dir ve derleme zamanında sabittir.
   - P0'da `suderra-os` cargo profilinden derleme zamanında çıkarılanlar:
     `SignatureMode::{Disabled, Permissive}` varyantları; `commands/catalog.rs`'teki legacy imzasız
     komut yolu (envelope'suz dispatch); config topic'ten `config.save()` yolu (DEC-4.6, DEC-4.12);
     ağdan RBAC manifest yükleme (`hot_reload_from_bytes`).
   - P2'de generic profilden de `Disabled`/`Permissive` varyantları ve legacy imzasız yol
     kaldırılır; HC-1 filosu bundan önce imzalı komut yoluna geçirilir (madde 10, DEC-28). Aynı
     fazda `suderra-os` profilinden envelope v3 kabulü (yalnız v4 kalır, madde 5) ve HMI/SCADA
     yürütücüsünün doğrudan GPIO/Modbus/I2C yazma yolu (madde 7) kaldırılır.
   Enforcing imzalı payload'la da teslim edilir; payload bir tabanı düşüremez. Bugün release build
   yalnız Disabled'ı reddeder (`config.rs:3783-3800`); Permissive imzasız mutating komutu kabul eder
   ve Disabled her envelope'u geçirir (`command_envelope/envelope.rs:432-441`).
2. Bulutta tek yayın noktası vardır: `EdgeCommandPublisher`, `tenants/*/devices/*/commands`'e yazan
   tek bileşendir ve `CommandEnvelopeSignerService`'i sarar. Doğrudan `mqtt.publish(…/commands)`
   invariant spec'le yasaktır (bugün `edge-device.service.ts:1187`, `:1263`, `:1627`, `:1642`,
   `:1799`, `:1888`, `:2008`, `:2415`, `:2491`, `:2567` ve
   `vfd/services/vfd-edge-{write,read,provisioning}.service.ts` ham yayın yapar). Signer
   yapılandırılmamışsa Suderra OS profilli cihaza yayın reddedilir (bugün signer `null` döner ve
   çağıran imzasız yayınlar).
3. Broker'da derinlemesine savunma: cihaz komut topic'lerine yalnız komut servisi principal'i yayın
   yapabilir (ADR-047, `sensor_service`'in tüm tenant'ların komut topic'lerine yazabildiğini
   kaydeder).
4. Anahtar modeli: cihazda komutu yetkilendiren aktör, RBAC manifestindeki aktör → pubkey
   eşlemesidir. RBAC manifesti `rbac-manifest` anahtarıyla imzalıdır; o anahtarın ve platform
   `command` anahtarının çapası P0'dan itibaren fleet-root imzalı trust-anchor bundle'ındadır
   (DEC-3.7).
   - P0: bulut `CommandEnvelopeSignerService`'i `EdgeCommandPublisher` üzerinden tek bir platform
     aktörüyle bağlar. sensor-service'teki asgari RBAC manifest üreticisi
     (`rbac-manifest.service.ts`) bu aktörü `platform-authenticated` rolüyle kaydeder ve manifesti
     `rbac-manifest` anahtarıyla imzalar. Rolün anlamı "platform kimliği doğruladı"dır, operatör
     başına yetki değildir.
   - P2'ye kadar TPI sınıfı komutlar cihazda fail-closed reddedilir. Bu sınıf
     `Permission::requires_two_person_integrity` kümesidir (`src/authz/permission.rs:584-598`):
     firmware güncellemesi, program deploy'u, `ForceValue`, `SafeStateTrigger`, reboot, OPC UA
     yazması ve S7 yazması. Co-approver imzası olmayan böyle bir komutu motor bugün de
     `TwoPersonIntegrityMissing` ile reddeder (`authz/in_memory_engine.rs:213`); bulutun signer'ı
     `co_approver_signature`'ı her zaman `null` yayınlar (`command-envelope-signer.service.ts:249`).
     Bu durum bir invariant testiyle sabitlenir ve RBAC manifest üreticisi bu kümeyi
     `platform-authenticated` rolüne veremez.
   - P2: operatör başına anahtarlar ve TPI co-signing gelir; hedef operatörün tuttuğu anahtardır
     (WebAuthn/passkey veya kullanıcı başına HSM). Operatör anahtarları bulutta saklandığı sürece
     bulut ihlali güven köküdür ve TPI yalnız farklı servislerin tuttuğu iki farklı KMS anahtarı ve
     kayıtlı insan onaylarıyla anlamlıdır; güvenlik vakası bunu açıkça beyan eder (SL2). Bugünkü
     signer her aktör için tek env tohumu kullanır (`command-envelope-signer.service.ts:175`). P0–P2
     arasındaki tek aktörlü yetki modeli EDGE-MEDIUM-121'dir.
5. Envelope v4: transcript'e `device_id` ve cihaz başına sıra numarası eklenir (yeni domain tag);
   cihaz kendisine eşitliği doğrular. Bugün yalnız tenant bağlıdır (`envelope.rs:417-419`): bir
   komut aynı tenant'taki başka bir cihaza 300 s geçerlilik içinde tekrar oynatılabilir. P2'den
   itibaren v3 yalnız generic profilde kabul edilir; o zamana kadar `suderra-os`'teki v3 kabulü
   EDGE-MEDIUM-122'dir. Rust ve TS ortak test vektörleri `contracts/suderra-edge/v1/envelope-v4/`
   altındadır.
6. Fiziksel emniyet limitleri yetkilendirmeden bağımsızdır (DEC-13): çıkış başına mühendislik
   limitleri ve kilitlemeler imzalı site config'ten gelir ve uzak ve HMI yazmalarında yerelde
   uygulanır. Yetkilendirme emniyet değildir.
7. SCADA/HMI yazmaları aynı yetkilendirme hattından geçer: yerel aktör (RBAC manifestindeki HMI
   kullanıcısı), force registry, output-only kontrolü ve audit (bugün `main.rs:5580-5719` WebSocket
   yazmalarını doğrudan GPIO/Modbus/I2C'ye uygular). HMI tag başına cihaz yönlendirmesi: Modbus
   yazması tag'in cihazına ve slave id'sine gider (bugün `s.config.modbus.first()`, `main.rs:5658` —
   yanlış PLC'ye aktüasyon); aralık dışı değer reddedilir, doyurulmaz. MQTT yazma komutları da aynı
   kurala uyar: `set_output` tag'in register tipine ve cihazına göre yazar, `write_modbus`
   yetkilendirildiği hedefe yazar (EDGE-HIGH-062, EDGE-HIGH-063; P1). E-stop yalnız güvenli yönde
   muaftır, çıkış başına tanımlıdır, kapsamı boşsa başarı raporlamaz, agent restart'ından sağ çıkar
   ve yaşam desteği çıkışlarını (havalandırma, oksijen) enerjisiz bırakmaz; kimliği doğrulanmamış
   bir LAN kullanıcısı e-stop tetikleyemez (bugün e-stop yalnız Confirm düzeyindedir,
   `scada_server.rs:1856-1861`, ve token kimlik doğrulaması env ile açılır,
   `scada_server.rs:1094-1100`). E-stop kapsamı ve kalıcılığı EDGE-HIGH-057 ve EDGE-HIGH-067'dir
   (P1); HMI yetkilendirmesi ve yönlendirmesi EDGE-HIGH-069 ve EDGE-HIGH-070'tir (P2). Fiziksel
   aktüasyonlu dağıtım bunlar kapanmadan yapılmaz (SG-1).
8. Config topic mesajları Suderra OS profilinde P0'da uygulanmaz (`unsupported`, DEC-4.12); P1'den
   itibaren yalnız imzalı, cihaza bağlı `site-config` ifadelerini taşır (`config-integrity`
   anahtarı). Agent onlara güvenmez, root doğrular. Agent'ın giden HTTP istemcileri yalnız
   allowlist'li hedeflere gider (SSRF); OPC UA server varsayılan olarak kapalıdır ve yalnız site
   politikasıyla açılır (bugün varsayılan bind `0.0.0.0`, `config.rs:2542`); OPC UA client hedefleri
   ve PLC envanteri imzalı site config'in parçasıdır.
9. Anti-replay (JTI) ve RBAC `policy_version` depoları reboot'tan sağ çıkar (DEC-4). RBAC manifesti
   `/etc/suderra/rbac_manifest.json`'da değil (`authz/manifest_runtime.rs:52`, prod'da RO)
   `/data/suderra/site/`'tadır. P0'da provisioning ve yeniden provisioning payload'ındaki
   `site-config` ifadesinin içinde, P1'den itibaren `kind=site-config` ile gelir. Root installer onu
   bundle'daki `rbac-manifest` çapasına karşı doğrulayıp yazar, agent yüklerken yeniden doğrular.
   Sürüm kapısı daha önce kabul edilmiş aynı manifesti reboot'ta yeniden kabul eder; bugün kesin
   büyüktür kuralı Enforcing boot'u durdurur (EDGE-HIGH-059).
10. Generic profil: `signature_mode` belirtmeyen v1.6.0 config'leri yeni release binary'siyle
    açılabilir olmalıdır; bugün serde varsayılanı Disabled'dır ve release kapısı onu reddeder
    (SENSOR-CRITICAL-203). P1'de profil bilinçli varsayılanlar alır (generic: permissive + göç logu)
    ve v1.6.0 fixture testi eklenir. P2'de generic profilden de Disabled/Permissive kaldırılır
    (madde 1); HC-1 cihazları bundan önce publisher'ın imzaladığı komutlara ve imzalı bir RBAC
    manifestine geçirilir (DEC-28).

**Gerekçe.** K10. Cihaz, ADR-045'e göre çevrimdışı emniyet otoritesidir; aynı tenant'taki cihazlar
arası replay ve kimliği doğrulanmamış LAN yazmaları doğrudan fiziksel aktüasyondur. İmzasız ve
izinsiz yolların derleme zamanında çıkarılması 1. kademedir; TPI sınıfının operatör anahtarları
gelene kadar kapalı tutulması, tek bir platform anahtarının iki kişilik bütünlük gibi görünmesini
engeller.

**Sonuçlar / Riskler.**

- Enforcing derleme zamanında sabit olduğundan Suderra OS cihazları publisher, bundle ve RBAC
  manifesti olmadan mutating komut kabul etmez; üçü de P0 kapsamındadır.
- P2'ye kadar TPI sınıfı uzak komut yoktur (firmware, deploy, force, uzak safe-state, reboot, PLC
  yazmaları). Agent ve OS güncellemesi root kanallarıyla yapılır (DEC-2); SG-1 öncesindeki izleme
  amaçlı dağıtımlar için bu bir işlev kaybı değildir.
- Bulut ihlali imzalı, RBAC açısından geçerli komutlar demektir; güvenlik vakası bunu SL2 sınırı
  olarak kaydeder.
- HMI yolu OT davranışını değiştirir → protokol başına HIL testi.

**Uygulama.**

- aquaculture_platform: `apps/sensor-service/src/edge-device/edge-command-publisher.service.ts`
  (yeni), `edge-device.service.ts`,
  `apps/sensor-service/src/vfd/services/vfd-edge-{write,read,provisioning}.service.ts`,
  `edge-device.module.ts`, `command-envelope-signer.service.ts` (v4; P2'de KMS),
  `__tests__/command-envelope-signer.spec.ts` (vektörler);
  `tests/invariants/edge-command-publish-chokepoint.spec.ts` (yeni);
  broker komut topic ACL'i `apps/sensor-service/src/edge-device/mqtt-auth.service.ts`'te
  (`checkTopicAccess`, `:267`; mosquitto onu `/mqtt/acl` ile çağırır,
  `infrastructure/mosquitto/mosquitto-production.conf:43`);
  `apps/sensor-service/src/edge-device/rbac-manifest.service.ts` (yeni, P0); `sens-api-gateway/src/command_envelope/envelope.rs`,
  `src/commands/{catalog.rs,envelope_adapter.rs,config_dispatch.rs}`, `src/authz/permission.rs`,
  `src/config.rs`, `src/main.rs` (HMI yürütücüsü), `src/scada_server.rs`,
  `src/authz/manifest_runtime.rs`;
  `sens-api-gateway/tests/invariants/tpi_commands_rejected_without_co_approver.rs` (yeni).
- Kapatılan bulgular: SENSOR-HIGH-206, EDGE-HIGH-059 (P0); SENSOR-CRITICAL-201 (P0'da Suderra OS
  profili derleme zamanında Enforcing olur ve bu commit'ler `Refs:` taşır; generic profil P2'ye kadar
  Permissive çalışabildiği için bulgu DEC-28'in P2 generic profil işiyle kapanır, kapanış kuralı);
  EDGE-HIGH-057,
  EDGE-HIGH-062, EDGE-HIGH-063, EDGE-HIGH-067, SENSOR-CRITICAL-203, SENSOR-HIGH-209,
  SENSOR-HIGH-213 (P1); EDGE-HIGH-068 (P0'daki Suderra OS profili işi `Refs:` taşır; generic profil
  işiyle kapanır, kapanış kuralı), EDGE-HIGH-069, EDGE-HIGH-070, EDGE-HIGH-071, EDGE-MEDIUM-086,
  EDGE-MEDIUM-088, EDGE-MEDIUM-090, EDGE-MEDIUM-091, EDGE-MEDIUM-092, EDGE-MEDIUM-095,
  EDGE-MEDIUM-096, EDGE-MEDIUM-097, EDGE-LOW-105, EDGE-LOW-110, INFRA-MEDIUM-246, SENSOR-MEDIUM-228,
  EDGE-MEDIUM-121 (operatör anahtarları ve TPI co-signing), EDGE-MEDIUM-122 (envelope v4) (P2).

**Faz.** P0: madde 1'in P0 kısmı, publisher ve signer bağlantısı, imzasız yayının reddi, broker
komut ACL'i, asgari RBAC manifest üreticisi ve `platform-authenticated` aktörü, bundle'dan çapa,
TPI sınıfının fail-closed reddi, RBAC sürüm kapısı (madde 9). P1: config topic'in `site-config`
ifadesine indirgenmesi (madde 8), e-stop kapsamı ve kalıcılığı, MQTT yazmalarında hedef ve register
tipi, generic profil varsayılanları (madde 10). P2: madde 1'in P2 kısmı, SCADA yürütücüsünde authz ve
yönlendirme, v4 ve replay pencereleri, SSRF, OPC UA client/server, PLC envanteri, operatör anahtarları
ve TPI co-signing.

---

### DEC-10 — Broker ve cihaz kimliği

**Karar.**

1. Cihazlar yalnız 8883 TLS ile bağlanır. Suderra OS profilinde agent'ta düz metin MQTT transport'u
   tip düzeyinde yoktur (bugün TLS isteğe bağlı bir boolean'dır, `mqtt.rs:280`). Broker host ve port
   yalnız imzalı config'ten gelir; aktivasyon yanıtı onları değiştiremez (bugün `main.rs:4653-4654`
   üzerine yazar). Bulutta port numarasından TLS çıkarımı (`provisioning.service.ts:430`
   `mqtt_tls_enabled: config.mqttPort === 8883`; `installer-script.service.ts` varsayılan 1883)
   Suderra OS profili için kaldırılır.
2. "1883 yok", cihazların ulaşabildiği düz metin yol yok demektir. Dahili `mosquitto:1883`
   (`infrastructure/mosquitto/mosquitto-production.conf:13`) yalnız izole Docker ağında servis
   hesapları için kalır ve bu istisna kayıtlıdır; mosquitto HTTP auth backend'i (düz HTTP,
   paylaşılan header sırrı) yalnız bu izole ağda kabul edilir.
3. Cihaz başına kimlik bilgisi: aktivasyonda verilir, her yeniden aktivasyonda yenilenir, loglanmaz,
   yalnız `$DATA/state`'te (0600) tutulur; client-ID `{username}-{deviceCode}`'dur (ADR-047); ACL
   cihaz topic'i başınadır.
4. Sunucu kimliğinde CA pinlenir, leaf değil. Hedef: cihaza dönük özel bir PKI (offline kök, KMS'te
   online issuing intermediate), ayrı bir MQTT host adı (`mqtt-devices.<domain>`), trust-anchor
   bundle'ında current + next kök (rotasyon bundle'la, DEC-3.7); kök pinlenir, intermediate değil.
   Kamu CA'sını pinlemek (bugün nginx `app.suderra.com` için Let's Encrypt sertifikası sunar,
   `infrastructure/nginx/droplet.conf:34-36`) o ad için herhangi bir DV sertifikasını güvenilir
   kılar. P0'da agent sunucuyu trust-anchor bundle'ındaki `mqtt-ca` kümesine (DEC-3.7) ve host adına
   karşı CA-anchored modda (madde 6) doğrular. Broker bugün Let's Encrypt sertifikası sunduğu için
   üretim bundle'ının kümesi (P1'den, DEC-3.9) P2'ye kadar ISRG köklerini içerir; bu kökler yalnız
   sunucu kimlik doğrulaması içindir, cihaz kimliği hiçbir zaman kamu CA'sından türetilmez (madde
   3, madde 7). dev/QEMU bundle'ı yalnız test broker'ının CI kökünü taşır. P2 çıkışında MQTT
   yolundan kamu CA güveni kaldırılır ve küme yalnız özel cihaz PKI'sinin current + next köklerini
   taşır (rotasyon bundle'la); o zamana kadar kamu kökü güveni EDGE-MEDIUM-123'tür.
5. Topoloji: cihaz TLS'i mosquitto'da sonlanır (8883 listener, `cafile` = cihaz CA'sı,
   `require_certificate`, `use_identity_as_username`) ve nginx `ssl_preread` ile passthrough yapar,
   çünkü bugünkü nginx stream TLS sonlandırması (`droplet.conf:26-42` → `mosquitto:1883`) istemci
   sertifikası kimliğini broker'a taşıyamaz. Geçişte çift listener penceresi vardır; generic filo
   eski yolda kalır.
6. Agent'ın strict mTLS modu leaf fingerprint pinning'dir (`src/mtls/pinning.rs`) ve release
   build'ler legacy modu yasaklar (`config.rs:3800`). Bugünkü üç moddan hiçbiri Suderra OS'e
   uymaz: `Legacy` release'te reddedilir; `Strict` leaf pinning'dir; `Warn` pin uyuşmazlığını yalnız
   loglayıp kabul eder (`src/mtls/mode.rs:39-42`, `src/mtls/rustls_verifier.rs` Warn dalı). P0'da
   `MtlsMode::CaAnchored` eklenir ve `suderra-os` profilinde derlenen tek moddur:
   - root store yalnız trust-anchor bundle'ındaki sabitlenmiş platform CA kümesidir (`mqtt-ca`);
     native/sistem kökleri ve gömülü webpki kökleri yüklenmez;
   - host adı doğrulaması açıktır ve kapatılamaz;
   - politika kapıları (sertifika yaşı, zincir derinliği, cipher) ihlali reddeder; leaf pin'i yoktur;
     rotasyon sırasında issuing intermediate SPKI'si isteğe bağlı ek kısıttır.
   `Legacy`, `Warn` ve `Strict` (leaf pinning) yalnız generic profilde derlenir. ADR-019 §8 3-pin
   leaf pinning Suderra OS profilinde kullanılmaz; Let's Encrypt leaf ve intermediate rotasyonu
   çevrimdışı cihazları kilitlerdi.
7. Cihaz sertifikaları CSR iledir (hedef): anahtar TPM'de üretilir, dışa aktarılamaz, ECDSA
   P-256'dır (RevPi, x86); TPM'siz RPi4'te yazılım anahtarı `$DATA/secrets`'tadır ve zayıf duruşu
   belgelenir (EDGE-MEDIUM-120). Sertifika ömrü kısadır (varsayılan 30 gün, yarı ömürde otomatik
   yenileme; uzun çevrimdışı süre riski EDGE-LOW-127); yenileme mevcut mTLS oturumu üzerinden
   yapılır. Çevrimdışıyken sertifikası dolan cihaz yerel kontrolünü sürdürür (ADR-045) ve yeniden
   bağlandığında aynı TPM anahtarıyla, EK bağlamasına ve attestation'a (DEC-14.4) dayanan
   proof-of-possession ile teknisyensiz yeniden sertifika alır; yaşam döngüsü REVOKED ise bu yol da
   kapalıdır. REVOKED oturumları keser ve yenilemeyi engeller (auth backend her CONNECT'te ve ACL
   kararında yaşam döngüsünü kontrol eder). Aktivasyonun proof-of-possession'ı da CSR ile P3'te
   gelir: aktivasyon isteği cihaz anahtarıyla imzalı CSR'ı taşır ve bulut kimlik bilgisini EK
   bağlamasına karşı doğrulanmış bu anahtara verir (claim-code ile aynı PoP, DEC-5.11). P0–P2'de
   aktivasyon bağlaması provisioning token'ı, imzalı manifestteki `device_binding` hash'i ve bulut
   imzalı activation receipt'idir (DEC-5.7, DEC-5.8); cihaz anahtarına sahiplik kanıtı yoktur
   (EDGE-MEDIUM-126). CSR'a kadar cihaz başına parola kimlik bilgisi `$DATA/state`'te durur (madde
   3; SENSOR-MEDIUM-232, P3).
8. Sertifika doğrulaması saate bağlıdır: ilk TLS bağlantısı time-state'e bağlanır; telemetri ve
   LED'ler `clock-unsynced`'i TLS hatasından ayrı raporlar.

**Gerekçe.** Server-driven port/TLS seçimi düz metne indirgemeye açıktır; kamu CA'sı pinlemek DV
ele geçirmesine karşı korumaz; nginx önünde sonlanan TLS ile cihaz sertifikası kimliği yetkilendirme
noktasına hiç ulaşmaz.

**Sonuçlar / Riskler.**

- TLS sonlandırma noktasını taşımak bağlı her cihazı etkiler → çift listener penceresi.
- Özel CA anahtarının kaybı veya ihlali filo çapında olaydır → seremoni ve offline saklama.
- SPI SLB9670'te ECDSA imzası onlarca-yüzlerce ms sürer → handshake için kabul edilebilir, mesaj
  başına kullanılmaz.
- Kısa sertifika ömrü (operasyon kaygısı): sertifika ömründen uzun çevrimdışı kalan bir cihaz,
  bağlantı geri geldiğinde PoP ile yeniden sertifika alana kadar buluta bağlanamaz; telemetri
  offline queue'da bekler. Yerel kontrol, safe-state ve alarmlar etkilenmez (ADR-045). PoP yolu da
  çalışmazsa (örneğin TPM hatası) yeniden sertifikalama saha ziyareti ister (EDGE-LOW-127).
- P2'ye kadar üretim bundle'ının CA kümesi kamu köklerini içerir (EDGE-MEDIUM-123).

**Uygulama.**

- aquaculture_platform: `infrastructure/mosquitto/mosquitto-production.conf`,
  `infrastructure/nginx/droplet.conf`, `docker-compose.droplet.yml`;
  `apps/sensor-service/src/edge-device/{installer-script.service.ts,provisioning.service.ts,mqtt-auth.service.ts}`;
  `apps/sensor-service/src/edge-device/trust-anchor-bundle.service.ts` (`mqtt-ca` girdisi);
  `apps/sensor-service/src/edge-device/device-certificate.service.ts` ve
  `device-certificate.controller.ts` (yeni, P3; CSR ve PoP ile yeniden sertifikalama);
  `docs/adr/021-platform-key-ceremony-lifecycle.md` (cihaz CA'sı); `sens-api-gateway/src/mqtt.rs`,
  `src/mtls/mode.rs`, `src/mtls/rustls_verifier.rs` (`CaAnchored`), `src/mtls/pinning.rs`,
  `src/mtls/verify.rs`, `src/trust_anchors.rs` (`mqtt-ca` kümesi), `src/keystore/` (TPM
  `ResolvesClientCert`), `src/main.rs` (aktivasyon).
- Suderra-OS: `package/suderra-keys/Config.in` (`/etc/ssl/certs/suderra-ca.pem` vaadi kaldırılır;
  `.mk` onu hiç kurmadı; MQTT CA kümesi bundle'la gelir).
- Kapatılan bulgular: INFRA-MEDIUM-239, SENSOR-LOW-233, SENSOR-MEDIUM-220 (P0);
  SENSOR-MEDIUM-219 (P2, mosquitto TLS sonlandırması), EDGE-MEDIUM-123 (P2, özel cihaz PKI'si);
  SENSOR-MEDIUM-232, EDGE-MEDIUM-126 (aktivasyon PoP'u), EDGE-LOW-127 (yenileme penceresi ve
  çevrimdışı yeniden sertifikalama) (P3).

**Faz.** P0: 8883 TLS-only profil, cihaz başına kimlik bilgisi, topic ACL'i, aktivasyonun broker'ı
değiştirememesi, `CaAnchored` mod ve bundle'daki CA kümesine karşı doğrulama. P2: özel cihaz PKI'si,
mosquitto TLS sonlandırması, kök kümesinden kamu köklerinin çıkarılması. P3: CSR ile kısa ömürlü
cihaz sertifikaları, TPM anahtarı, PoP ile yeniden sertifikalama, yaşam döngüsü tabanlı iptal.

---

### DEC-11 — Ağ politikası

**Karar.**

1. Her iki yönde varsayılan deny; forward drop.
2. Firewall fail-closed yüklenir: imajda her zaman yüklenebilen minimal bir temel drop ruleset'i
   vardır; `nft -c` ön kontrolü yapılır; `systemd-networkd` drop-in'i
   `Requires=`/`After=nftables.service`'tir; yükleme başarısızsa ağ arayüzleri kaldırılmaz
   (`OnFailure=` → ağ failsafe target'ı); health gate ruleset hash'ini kontrol eder. QEMU kapısı
   `nft -c`'yi hedef kernel'e karşı çalıştırır. Agent unit'i `After=nftables.service` taşır, ama
   `Requires=` taşımaz: firewall hatası ağı zaten açmaz ve yerel kontrol döngüsünü durdurmamalıdır
   (DEC-6.2).
3. Mod seçimi fail-safe'tir: appliance ruleset'i varsayılandır; provisioning ruleset'i yalnız yaşam
   döngüsü PROVISIONING veya yeniden provisioning amaçlı MAINTENANCE (DEC-12) iken yüklenir (bugün
   işaret yoksa provisioning ruleset'i yüklenir, `suderra-firewall:4-8`). `/data` açılamazsa LOCKED
   kuralları yüklenir.
4. UID başına egress (`meta skuid`): agent yalnız broker, API ve site PLC kümesine; root installer
   yalnız platform API/artifact host'una; chrony yalnız NTS sunucularına. Bugün egress herhangi bir
   IP'ye port bazındadır (`overlay/etc/nftables.conf:42-65`; 53/123/443/8883/502/4840); P1'deki
   UID kapsamına ve P2'deki OT allowlist'ine kadar bu durum EI-059'dur.
5. Ad tabanlı hedefler güvenilir bir çözücüyle (DoT/DNSSEC) ve root güncelleyiciyle nft set'lerine
   doldurulur; DNS yalnız yapılandırılmış çözücülere (DHCP'den gelenler networkd hook'uyla).
   Artifact'lar allowlist'li platform API alan adından sunulur; GitHub release CDN'i geniş 443
   egress gerektirirdi.
6. Arayüz rolleri: imzalı site politikası NIC'leri MAC veya PCI yoluna göre rollere eşler (WAN/IT ve
   OT/PLC), kart profili varsayılanlarıyla; broker/API/NTP/DNS yalnız WAN rolünde, PLC
   CIDR/port'ları yalnız OT rolünde. Sözleşme 1.2.0'da kart varsayılanı `boards.json`
   `default_interface_role`'dür ve her kart için `wan`'dır (porttan role sabit bir eşleme, nitelikli
   bir port-NIC olgusu gerektirir ve henüz hiçbir kartta yoktur). Etkin rol, politikanın
   `interfaces[]` girdisinden (MAC veya PCI yolu eşleşmesi), yoksa varsayılandır; cihazda bulunmayan
   bir girdi yok sayılır. Etkin eşleme cihazı hiç `wan` arayüzsüz bırakıyorsa veya bir arayüzü iki
   girdiyle (biri MAC, biri PCI yolu) eşliyorsa root, bir şey render etmeden politikayı
   `interface-mapping-invalid` ile reddeder ve önceki kurallar kalır: `nft -c` ve atomik yükleme
   WAN'sız bir kural kümesini geçerli sayacağından bu kontrol ruleset doğrulamasından önce yapılır. Bugün `overlay/etc/systemd/network/10-ethernet.network` her
   `en*`/`eth*` üzerinde DHCP çalıştırır ve kurallar arayüzü yok sayar.
7. İmzalı site OT allowlist'i (`suderra.site-netpolicy.v1`, `config-integrity` anahtarı, cihaza bağlı,
   sürümlü, rollback'e karşı korumalı) root'ta tipli bir renderer ile render edilir: string
   birleştirme yok; CIDR, port ve protokol doğrulanır; `0.0.0.0/0` açık bayrak olmadan yasaktır;
   bulut politika derleyicisi CIDR boyutunu ve port sayısını sınırlar; `nft -f` atomiktir;
   başarısızlıkta son-iyi (LKG) dosyaya düşülür ve alarm verilir. Politika WAN rolündeki broker/API
   kuralını kaldıramaz.
8. Temel kurallar: DHCP (udp 67/68; unicast yenileme), NTS-KE tcp/4460, ICMP; IPv6 sysctl ile
   kapalıyken ICMPv6/ND kuralları tutarlıdır.
9. Inbound: provisioning SSH P0'da yalnız provisioning anında varsayılan rotayı taşıyan arayüzde
   (yürürlükteki imzalı manifest bir arayüz adlandırıyorsa o arayüzde) ve onun on-link alt ağında
   kabul edilir ve kaynak adresi başına nft meter'la sınırlanır (DEC-5.4, P0); lockdown'da ve süre
   aşımında kapanır.
   Yerel HMI (`scada_server.rs`, varsayılan loopback) ve OPC UA server yalnız site başına, arayüz ve
   kaynak CIDR'ıyla ve HMI TLS'iyle birlikte açılır; unit `Environment=` değeri ve input kuralı
   politikadan render edilir.
10. x86'da Intel AMT/vPro paylaşılan NIC üzerinden nftables'ı atlar → qualification'da vPro'suz SKU
    veya MEBx'te AMT kapalı ve MEBx parolası değiştirilmiş (DEC-8).

**Gerekçe.** K14: x86'da ruleset yüklenemiyor ve hiçbir şey bunu fark etmiyor. Port bazlı egress,
ele geçirilmiş bir agent'ın izin verilen herhangi bir porttan herhangi bir IP'ye çıkmasına izin
verir.

**Sonuçlar / Riskler.**

- Hatalı bir site politikası PLC trafiğini keser → LKG zorunlu; broker/API kuralı kaldırılamaz.
- Ad tabanlı set'ler CDN/IP değişiminde kırılır → sabit broker IP'leri veya özel uç nokta tercih
  edilir.
- Arayüz adları x86 modelleri arasında değişir (`enp1s0` / `eno1`) → roller MAC/PCI yoluna bağlanır.

**Uygulama.**

- Suderra-OS: `board/suderra/x86_64/linux-x86_64.config`, `board/suderra/x86_64/linux-qemu.config`;
  `overlay/etc/nftables.conf`,
  `overlay/etc/nftables.provisioning.conf`, `overlay/etc/nftables.base.conf` (yeni);
  `overlay/etc/systemd/system/nftables.service`,
  `overlay/etc/systemd/system/systemd-networkd.service.d/10-require-firewall.conf` (yeni),
  `overlay/etc/systemd/system/suderra-network-failsafe.target` (yeni);
  `overlay/usr/sbin/suderra-firewall` → `userspace/suderra-installer/src/cmd/policy.rs` (yeni;
  `policy apply`: ön kontrol, varsayılan rota arayüzüne kapsanan ve kaynak başına meter'lı
  provisioning kuralı, LKG);
  `userspace/suderra-installer/src/contracts.rs` (`site-netpolicy`);
  `overlay/etc/systemd/network/10-wan.network` ve `20-ot.network` (yeni, P1; bugünkü
  `10-ethernet.network`'ün yerine kart profili rolleri); `tests/qemu/nft-ruleset-smoke-test.py`
  (yeni; hedef kernel'e karşı `nft -c` ve `nft list ruleset`, x86 ve arm).
- aquaculture_platform: `apps/sensor-service/src/edge-device/site-config-manifest.service.ts`
  (`site-netpolicy` üretimi; provisioning payload'ında ve DEC-4.12 yolunda teslim);
  `sens-api-gateway/src/scada_server.rs`, `src/config.rs` (OPC UA varsayılanı).
- Kapatılan bulgular: EI-021, EI-041 (P0); EI-059 (P2).

**Faz.** P0: x86 ve dev QEMU nft kernel seçenekleri, fail-closed yükleme, appliance varsayılanı,
provisioning ruleset'inin yaşam döngüsüne ve varsayılan rotayı taşıyan arayüze bağlanması ve
provisioning SSH için kaynak başına meter (madde 9), health check'te ruleset hash'i, DHCP ve NTS-KE
kuralları, agent `After=nftables.service`. P1: UID başına egress, kart profili varsayılan arayüz
rolleri. P2: imzalı site OT allowlist'i ve tipli renderer, imzalı arayüz rolü eşlemesi, HMI/OPC UA
inbound.

---

### DEC-12 — Cihaz yaşam döngüsü durum makinesi

**Karar.** Durumlar `FACTORY → PROVISIONING → ACTIVE ⇄ MAINTENANCE → DECOMMISSIONED | RMA`'dır ve
root-owned `/data/suderra/os/lifecycle`'da tutulur; TPM'li kartlarda TPM NV aynası vardır (tek
yazımlık "provisioned" biti + monotonik sayaç; P3).

- Bilinmeyen, eksik, bozuk veya mount edilemeyen durum LOCKED'dur (appliance davranışı; provisioning
  yüzeyi kapalı). `/data` mount edilemezse LOCKED'a ek olarak bir alarm sonucu yazılır (DEC-27).
- Prod imajında PROVISIONING yalnız pozitif kanıtla başlar: `/data` bu boot'ta ilk kez oluşturuldu
  VE TPM NV "provisioned" biti set değil (bit P3'te gelir). Kanıtı `suderra-data-unlock` üretir: boş
  bölümü bu boot'ta LUKS2 ile formatladığında root-only `/run/suderra-os/data-created` yazar ve root
  store'u FACTORY olarak oluşturur; yaşam döngüsü aracı aynı boot'ta kanıtı tüketip PROVISIONING'e
  geçer. P3'ten itibaren TPM'li bir cihazda `/data`'nın boş bulunup yeniden formatlanması
  (`suderra-data-unlock` boş bölümü kendiliğinden formatlar) provisioning'i yeniden açmaz; RMA
  token'ı ve fiziksel varlık gerekir (DEC-17). O zamana kadar bu EDGE-MEDIUM-124'tür. TPM'siz
  kartlarda bu koruma yoktur (DEC-8 SL notu).
- Dev imajı ayrı bir giriş kuralı kullanır. Dev `/data`'yı `SUDERRA-DATA` etiketli düz ext4 olarak
  bağlar (`suderra-data-unlock:27-36`); QEMU dev imajında bu bölüm
  `board/suderra/x86_64/genimage-qemu.cfg`'ye eklenir (bugün yoktur, bu yüzden
  `suderra-data-unlock:30-33` dev QEMU'da çıkar). Şifresiz ve önceden var olan bir bölümde "bu
  boot'ta oluşturuldu" kanıtı üretilemez. Bu yüzden dev imajında ilk boot'ta
  `/data/suderra/os/lifecycle` yoksa yaşam döngüsü PROVISIONING'e geçer. Kural yalnız `VARIANT=dev`
  imajlarda etkindir; varyant env'den değil imajdan okunur (DEC-19). Prod giriş kuralı değişmez.
  Etikete göre bağlama sahte bir bölümle kandırılabilir (EI-044). Bu yalnız dev imajını etkiler:
  dev imajı yalnız dev/CI anahtarlarını pinler ve üretim bulutunun imzaladığı bir manifesti kabul
  etmez (DEC-3.9). P1'de dev imajı da `/data`'yı booted diskin PARTUUID'iyle bağlar (DEC-18.1).
- `PROVISIONING → ACTIVE` yalnız root-doğrulanmış activation receipt'iyle.
- `ACTIVE → MAINTENANCE`:
  - P0: yalnız yeniden provisioning için (DEC-5.14, DEC-4.12). Tetik, bulutun imzaladığı ve cihaza
    bağlı `suderra.device-lifecycle.v1` ifadesidir (`action: enter-maintenance`,
    `purpose: reprovision`, `expires_at`, `update_seq`, `tenant_id`; `device-lifecycle` anahtarı,
    OS imajında pinli). Agent ifadeyi `$DATA/state/lifecycle-request.dsse`'ye yazar; root
    `suderra-lifecycle.path` dosyayı kopyalar, doğrular (anahtar, payloadType, device binding,
    tenant, zaman penceresi, `update_seq`) ve geçişi yapar. MAINTENANCE süreli bir durumdur: yeni
    activation receipt'iyle ya da süre dolunca ACTIVE'e döner. OTP yalnız konsolda/HDMI'da
    göründüğü için (DEC-5.3) yeniden provisioning de yerinde bir teknisyen ister.
  - P3: imzalı break-glass (DEC-16) ikinci MAINTENANCE amacı olarak eklenir.
- `DECOMMISSIONED`/`RMA` imzalı `suderra.device-lifecycle.v1` ifadesi (device-lifecycle anahtarı) ve
  fiziksel varlık ister (DEC-17).
- Her geçiş audit'lenir ve bulut cihaz kaydıyla (`DeviceLifecycleState`) eşlenir; agent yaşam
  döngüsünü `/run/suderra/lifecycle`'dan salt okur.

**Gerekçe.** Bugün kilit ve provisioning durumu agent'ın sahip olduğu işaretlere ve verity'de kalıcı
olamayan `/etc` yazmalarına bağlıdır; eksik bir işaret veya `/data` mount hatası SSH'ı açar. Durumun
tek root yazıcısı ve fail-safe varsayılanı bunu yapısal olarak kapatır. MAINTENANCE'ın P0'da
yeniden provisioning için var olması, P1'deki `site-config` kanalından önce site config'i
değiştirmenin tek imzalı yoludur.

**Sonuçlar / Riskler.** TPM NV yazma ömrü sınırlıdır → yalnız geçişlerde yazılır. Bozuk durum
LOCKED'a düşer ve saha ziyareti gerektirir (DEC-14 recovery, DEC-17). TPM NV aynası gelene kadar
(P3) fiziksel erişimli biri `/data`'yı silerek provisioning'i yeniden açabilir (EDGE-MEDIUM-124).
Uzaktan tetiklenen MAINTENANCE provisioning yüzeyini açar → ayrı `device-lifecycle` imzacısı (P2'de
KMS, 4-göz), süre sınırı, varsayılan rota arayüzüne kapsama (DEC-5.4) ve konsoldaki OTP.

**Uygulama.**

- Suderra-OS: `userspace/suderra-installer/src/cmd/lifecycle.rs` (yeni);
  `overlay/usr/sbin/{suderra-data-unlock,suderra-firewall,suderra-lockdown}`;
  `overlay/etc/systemd/system/{suderra-lifecycle.path,suderra-lifecycle.service}` (yeni);
  `board/suderra/x86_64/genimage-qemu.cfg` (`SUDERRA-DATA` etiketli ext4 `data` bölümü);
  provisioning ve agent birimlerinin koşulları
  (`overlay/etc/systemd/system/{suderra-provision-mode.service,suderra-provision-worker.service,suderra-agent.service}`).
- aquaculture_platform: `apps/sensor-service/src/edge-device/entities/edge-device.entity.ts`,
  `provisioning.service.ts`, `device-lifecycle-statement.service.ts` (yeni; `device-lifecycle`
  imzacısı); `sens-api-gateway/src/commands/lifecycle_request.rs` (yeni; ifadeyi state dizinine
  yazar, başka bir şey yapmaz).
- Kapatılan bulgular: EI-041 (P0); EI-044 (P1: prod'da sessiz unlock hatası yerine LOCKED + alarm,
  dev'de etiket yerine PARTUUID bağlama, DEC-18.1); EDGE-MEDIUM-124 (TPM NV "provisioned" biti,
  P3).

**Faz.** P0: root store, FACTORY/PROVISIONING/ACTIVE, LOCKED varsayılanı, dev giriş kuralı,
yeniden provisioning amaçlı MAINTENANCE. P3: break-glass amaçlı MAINTENANCE, DECOMMISSIONED, RMA ve
TPM NV aynası.

---

### DEC-13 — Fonksiyonel emniyet sınırı

**Karar.**

1. Agent SIL dereceli bir emniyet fonksiyonu değildir ve IEC 62443 bu riski kapsamaz. Yaşam desteği
   (havalandırma, oksijen) için bağımsız, donanımsal kilitlemeler ve fail-safe kablolama önerilen
   varsayılan olarak devreye alma gereksinimidir: NO/NC röle seçimi, PiBridge modül varsayılan
   durumları, iletişim kaybında modül çıkış davranışı. Devreye alma kontrol listesi bunu kanıtlar.
   Bu gereksinimin müşteriye sözleşmesel bir yükümlülük olarak bağlanması operatör kararıdır
   (Soru 8).
2. Çıkış başına politika imzalı site config'tedir: `hold-last` | `force-safe` | `must-stay-on`;
   aralık, değişim hızı, asgari açık/kapalı süre, karşılıklı dışlama. Uzak ve HMI yazmaları aynı
   yerel uygulama katmanından geçer (DEC-9).
3. Olay başına çıkış davranışı tablosu site config şemasının parçasıdır: agent restart'ı, agent
   güncellemesi, OS güncellemesi (reboot), watchdog reset'i, güç kaybı, PiBridge iletişim kaybı,
   degraded mode. Her çıkış politikası için beklenen davranış ve onu sağlayan katman (kablolama /
   modül varsayılanı / piControl output watchdog'u / agent safe-state'i) tanımlıdır; HIL testleriyle
   doğrulanır.
4. Planlı kesinti: güncellemeler bakım penceresi ve/veya yerel operatör onayı ister; azami kesinti
   bütçesi güncelleme ve watchdog mantığınca uygulanır; aktif alarm veya forced değer varken
   güncelleme reddedilir; RAUC reboot'u zamanlanmış ve onaylıdır (DEC-2). Bu kapı agent'ın yazdığı
   sağlık görünümünü (`/run/suderra/agent-health/health.json`, `update_blockers`) okur ve agent
   en az güvenilen bileşen olduğundan görünümün yokluğu bir güncellemeyi onu onaracak tek yolda
   sonsuza dek engelleyemez. Karar (sözleşme 1.2.0, `channels.json
   update_channel.maintenance.blockers`): (a) yalnız çalışan bir kontrol döngüsü alarm veya forced
   değer tutabilir; bu yüzden kapı yalnız `suderra-agent.service` `active`/`reloading` iken
   engeller. Birim `inactive`, `failed`, `activating` veya `deactivating` ise çıkışlar safe-state'te
   tutulur, korunacak bir şey yoktur ve görünümün yokluğu, bayatlığı veya bozukluğu asla engellemez;
   agent'ı onaran veya değiştiren güncelleme her zaman başlayabilir. (b) Birim aktifken boş olmayan
   `update_blockers`, yok/okunamaz/64 KiB'dan büyük/bozuk bir görünüm ve `updated_at`'i root'un
   saatinden 60 s'den fazla uzak (iki yönde) bir görünüm engeller; Suderra OS'te agent görünümü
   değişmese de en az 15 s'de bir yeniden yazar. (c) Erteleme sınırlıdır: agent'ın watchdog'u
   askıdaki agent'ı `active`'den çıkarır ve operatör, `local_approval: true` ile birlikte
   `blockers_override: true` taşıyan imzalı bir `edge-update`/`os-update` verebilir; yerel onay
   sahada bir kişinin alarmı veya forced değeri gördüğünü kanıtlar ve override agent'ı değiştirip
   yeniden başlatan güncellemeyi her durumda açar. `site-config` için override yoktur: önce agent
   `edge-update` ile değiştirilir. (d) Kapı, root'un bir şeyi getirmeden önce ve agent'ı durduracağı
   veya reboot'u zamanlayacağı anda yeniden değerlendirilir. Sözleşmenin 1.1.0 metni, bu maddenin
   söylemediği bir kural ekleyerek yok veya bozuk görünümü her durumda engelleyici sayıyordu; bu
   kural kaldırıldı ve yukarıdaki (a)-(d) ile değiştirildi.
5. x86 (fieldbus-only): uzak I/O ve PLC iletişim watchdog'ları (Modbus cihaz timeout'ları) devreye
   almanın parçasıdır; IPC'nin yerel çıkış katı yoktur.
6. E-stop çıkış başına tanımlıdır ve yaşam desteği çıkışlarını enerjisiz bırakmaz (DEC-9).

**Gerekçe.** Agent restart'ı shutdown safe-state'ini uygular; reboot ve RAUC rollback'i çıkışları
enerjisiz bırakır; akuakültürde havalandırmanın durması tehlikenin kendisidir (ADR-024 safe-state
şeması, ADR-045 edge emniyet otoritesi).

**Sonuçlar / Riskler.** Saha devreye alması uzar; kablolama gereksinimi müşteri tarafında iş
demektir (Soru 8); yanlış tanımlanmış bir `must-stay-on` çıkışı bakım sırasında tehlike yaratabilir →
politika değişikliği imzalı ve audit'li. Çıkış başına politika P2'ye kadar yoktur; bu yüzden P2
çıkışından önce fiziksel aktüasyonlu dağıtım yapılmaz (SG-1).

**Uygulama.**

- aquaculture_platform: `sens-api-gateway/src/main.rs` (shutdown safe-state yolu),
  `src/safe_state.rs`, `src/safe_state_v2.rs`, `src/gpio.rs` (shutdown'dan sonra güvenli seviyede
  kalma), `src/output_policy.rs` (yeni; çıkış başına politika ve yerel uygulama katmanı);
  `contracts/suderra-edge/v1/schemas/site-config.schema.json` (yeni; çıkış politikası ve olay
  davranış tablosu); `sens-api-gateway/tests/hil/output_behaviour_table.rs` (yeni, HIL);
  `apps/sensor-service/src/edge-device/site-config-manifest.service.ts`.
- Suderra-OS: `userspace/suderra-installer/src/cmd/edge.rs` (`request`: bakım penceresi, yerel onay
  ve kesinti bütçesi), `userspace/suderra-ota/src/main.rs` (reboot onayı);
  `docs/operations/commissioning-checklist.md` (yeni; kablolama ve modül varsayılanları kanıtı).
- Kapatılan bulgular: EDGE-HIGH-058, EDGE-HIGH-060, EDGE-HIGH-065, EDGE-MEDIUM-075,
  EDGE-MEDIUM-076 (P1); EDGE-MEDIUM-081, EDGE-MEDIUM-082, INFRA-MEDIUM-250 (P2).

**Faz.** P0: READY'den önce safe-state, degraded mode. P1: davranış tablosu (iletişim kaybı dahil),
bakım penceresi/onay, kesinti bütçesi, devreye alma kontrol listesi, safe-state registry'sinin
çalışma anı çıkışlarını kapsaması ve GPIO çıkışlarının shutdown'dan sonra güvenli seviyede kalması.
P2: çıkış başına politika ve yerel uygulama katmanı.

---

### DEC-14 — Measured boot, disk anahtarı mühürleme ve attestation

**Karar.**

1. x86: PCR 7 + imzalı PCR 11 politikası (systemd-stub UKI, `ukify`/`systemd-measure` veya
   `systemd-pcrlock`, `systemd-cryptenroll --tpm2-public-key`); literal PCR değeri yerine imzalı
   politika; PCR 0/2/4'e asla mühürlenmez; eski imzalı ama zayıf bir slotun grubenv/ESP üzerinden
   boot edilmesine karşı SBAT/dbx tabanlı anti-rollback. Bu politika SB sahipliği ve dönüşüm
   runbook'uyla (DEC-8.9) aynı fazda, P1'de gelir: Microsoft UEFI CA'nın db'de kaldığı bir x86
   birimi yalnız PCR 7'ye mühürlenmiş olarak hiçbir zaman devreye alınmaz (SG-3). Bugün
   `suderra-data-unlock:73-74` yalnız `--tpm2-pcrs=7` kullanır.
2. RevPi/CM4: OTP secure boot provizyonu (imzalı bootloader EEPROM, `program_pubkey`, ardından JTAG
   kilidi) geri dönüşsüzdür. Önerilen varsayılan, fuse'un P3'te ve KUNBUS'un yazılı destek
   görüşünden sonra yapılmasıdır; karar operatöründür (Soru 7). Ardından U-Boot measured boot
   (`CONFIG_MEASURED_BOOT`) ve imzalı initramfs verity root hash'ini ayrı bir PCR'a extend eder; LUKS
   Suderra imzalı `PolicyAuthorize` ile mühürlenir, A/B güncellemeleri unseal'i bozmaz. Bu
   sağlanana kadar ARM'da `/data` şifrelemesi yalnız depolamanın sökülmesine karşı korur; bu
   sınırlama threat model'de beyan edilir ve EI-037 açık kalır. Bugün `suderra-data-unlock:72-74`
   PCR 7'ye mühürler; BCM2711'de PCR 7 hiç extend edilmez.
3. Kurtarma: cihaz başına recovery key slotu, offline HSM anahtarına şifrelenmiş olarak bulutta
   emanet tutulur. Unseal hatası boot döngüsü değil MAINTENANCE/recovery yoludur (fiziksel varlık +
   imzalı yetki). Bugün parola slotu silinir ve kurtarma yolu yoktur. 2026 Microsoft CA rotasyonu ve
   BIOS güncellemeleri PCR 7'yi değiştirir → recovery yolu x86 SB sahipliğiyle birlikte (P1)
   zorunludur.
4. Attestation: `Suderra-OS/userspace/suderra-attestation` TPM2_Quote üretir (AK, EK'ye karşı
   MakeCredential ile sertifikalanır); bulut manifest ve kimlik bilgisi vermeden önce doğrular.
   Uzaktan doğrulama P3'tedir.

**Gerekçe.** Hiçbir ölçüme bağlı olmayan bir mühür, `/data`'yı açabilen herkese agent binary'sini ve
güven durumunu değiştirme imkânı verir (DEC-1); kurtarma yolu olmayan bir mühür her firmware
güncellemesinde cihazın verisini kaybettirir. x86'da SB sahipliği ile imzalı PCR politikasının aynı
fazda gelmesi, MS UEFI CA'lı bir cihazın zayıf mühürle sahaya çıkabileceği aralığı ortadan kaldırır.

**Sonuçlar / Riskler.** OTP fuse'u geri alınamaz ve rpiboot kurtarması bundan sonra imzalı imaj
ister; emanet, bulutta şifreli anahtar materyali demektir (yalnız offline HSM açar). P1'de x86 UKI
ve politika imzalama anahtarı bir seremoni ve envanter girdisi ister (DEC-3.11).

**Uygulama.**

- Suderra-OS: `overlay/usr/sbin/suderra-data-unlock` (`--tpm2-public-key`, recovery slotu);
  `scripts/production-artifacts.sh` (UKI'ye imzalı PCR 11 politikası: `.pcrsig`/`.pcrpkey`);
  `board/suderra/aarch64-rpi4/uboot-fragment.config` ve
  `board/suderra/aarch64-revpi-connect4/uboot-fragment.config` (yeni; `CONFIG_MEASURED_BOOT`, P3);
  `userspace/suderra-attestation/`; `docs/security/security-gaps-and-risks.md`,
  `docs/security/threat-model.md`, `docs/security/field-appliance-hardening.md`.
- aquaculture_platform: `apps/sensor-service/src/edge-device/recovery-key-escrow.service.ts` (yeni,
  P1), `apps/sensor-service/src/edge-device/attestation.service.ts` (yeni, P3).
- Kapatılan bulgular: EI-067 (SBAT/dbx anti-rollback, P1); EI-037 (P3). EI-037 P3'e kadar açık
  kalır: x86 imzalı politika ve recovery yolu (P1) commit'leri onu `Refs:` ile anar; bulguyu
  kapatan, RevPi'deki OTP secure boot + U-Boot measured boot + imzalı `PolicyAuthorize` işidir (P3).

**Faz.** P1: x86 imzalı PCR 7 + 11 politikası, recovery yolu, SB sahipliğiyle birlikte. P3: RevPi
OTP secure boot + U-Boot measured boot, attestation ve uzaktan doğrulama.

---

### DEC-15 — Anahtar ihlali, iptal ve epoch ratchet prosedürü

**Karar.** Fleet-root imzalı `suderra.key-epoch-advance.v1` ifadesi (purpose, yeni asgari epoch,
iptal edilen keyid'ler, kapsam, zaman) iptalin tek formatıdır; cihaz ratchet'leri DEC-3'tedir. Her
anahtar için ihlal runbook'u yazılır: edge-release, edge-provisioning, config-integrity,
device-lifecycle, command, rbac-manifest, fleet-root, `edge-image`, RAUC, FIT/UEFI db, cihaz CA'sı.
Fleet-root ihlali yeni fleet-root pin'li bir OS imajıyla (ayrı RAUC zinciri) çözülür. QEMU filosu
üzerinde yılda en az bir filo çapında yeniden anahtarlama tatbikatı yapılır.

**Gerekçe.** Kendi beyan edilen epoch'larla iptal imkânsızdır (`contracts.rs:315-317`); edge ve
komut anahtarları envanterde yoktur.

**Sonuçlar / Riskler.** Tatbikat CI ve operasyon zamanı ister; ihlal anında güncellemeler ratchet
ilerleyene kadar durdurulur.

**Uygulama.** Suderra-OS: `userspace/suderra-installer/src/contracts.rs` (`key-epoch-advance`),
`docs/security/key-management.md`, `docs/security/key-ceremony.md`,
`docs/operations/key-compromise-response.md` (yeni; OS anahtarları), `tests/qemu/key-epoch-advance-drill.py`
(yeni; yıllık tatbikatın QEMU senaryosu). aquaculture_platform: `docs/runbooks/edge-key-compromise.md`
(yeni; anahtar başına bir bölüm), `docs/adr/021-platform-key-ceremony-lifecycle.md`.

**Faz.** P2.

---

### DEC-16 — Break-glass bakım erişimi

**Karar.** Lockdown sonrası saha servisi imzalı (device-lifecycle anahtarı), süreli, cihaza bağlı
bir challenge-response ile açılır; yerel fiziksel varlık (konsol veya kart üzerindeki düğme)
gerekir; kısıtlı bir tanı kabuğu veya komut seti açılır; her şey buluta audit'lenir; süre dolunca
kendiliğinden kapanır; yaşam döngüsü MAINTENANCE olur. Küresel provisioning parolası deseni geri
gelmez.

**Gerekçe.** Lockdown'dan sonra hiçbir saha servis yolu yoktur; kesinti baskısı arka kapı
taleplerine dönüşür.

**Sonuçlar / Riskler.** Fiziksel varlık kanıtı kart başına farklıdır (RevPi düğme/konsol, x86
konsol); bulut erişimi olmayan sahada challenge'ın imzalanması için çevrimdışı akış gerekir.

**Uygulama.** Suderra-OS: `userspace/suderra-installer/src/cmd/lifecycle.rs` (break-glass amacı),
`overlay/etc/systemd/system/suderra-maintenance.service` (yeni; süreli bakım oturumu),
`overlay/usr/sbin/suderra-maintenance-shell` (yeni; kısıtlı tanı komut seti). aquaculture_platform:
`apps/sensor-service/src/edge-device/break-glass.service.ts` ve `break-glass.controller.ts` (yeni;
challenge imzalama `device-lifecycle-statement.service.ts` üzerinden, audit).

**Faz.** P3. Yeniden provisioning amaçlı MAINTENANCE P0'dadır (DEC-12); bu karar ona ikinci bir,
break-glass amacı ekler.

---

### DEC-17 — Factory reset, RMA ve decommission

**Karar.** Üç akış: (a) yeniden provisioning — device_id korunur, kimlik bilgileri yenilenir,
MAINTENANCE üzerinden reserve/commit akışından geçer (DEC-5.14, DEC-12); (b) RMA — fiziksel reset +
imzalı RMA token'ı; LUKS header silinir, TPM'de mühürlü anahtar ve NV "provisioned" biti sıfırlanır;
bulut kaydı RMA olur; (c) decommission — bulutta iptal (MQTT kimlik bilgisi/sertifika, cihaz kaydı
REVOKED), cihazda crypto-erase. FACTORY'ye yeniden giriş yalnız fiziksel varlık + imzalı RMA
token'ıyla. `resetForReprovisioning`'in (`provisioning.service.ts`) Suderra OS varyantı generic
`curl | bash` komutunu döndürmez. `Suderra-OS/userspace/suderra-factory-reset` bugün
placeholder'dır.

**Gerekçe.** Tanımlı bir crypto-erase veya iptal yoktur; yeniden provisioning bugün `/data` boş
olduğunda örtük olarak gerçekleşir.

**Sonuçlar / Riskler.** Crypto-erase geri alınamaz → iki aşamalı onay; decommission edilmiş bir
cihazın çevrimdışıyken iptali ancak bir sonraki bağlantı denemesinde etkili olur.

**Uygulama.** Suderra-OS: `userspace/suderra-factory-reset/`,
`overlay/etc/systemd/system/suderra-factory-reset.service` (yeni; fiziksel varlık + imzalı RMA
token'ı ile crypto-erase), `docs/operations/factory-reset.md`. aquaculture_platform:
`apps/sensor-service/src/edge-device/provisioning.service.ts` (`resetForReprovisioning`'in Suderra OS
varyantı), `apps/sensor-service/src/edge-device/edge-device.resolver.ts` (RMA ve decommission
mutation'ları), `docs/runbooks/edge-device-rma-decommission.md` (yeni). Kapatılan bulgu:
SENSOR-MEDIUM-231 (P3).

**Faz.** P0: akış (a) (DEC-5.14). P3: RMA ve decommission.

---

### DEC-18 — Fiziksel arayüz ve depolama kimliği politikası

**Karar.**

1. Depolama booted diskin PARTUUID'lerine bağlanır: `/data` ve RAUC slotları
   `/dev/disk/by-partlabel` veya `by-label` ile bulunmaz (aynı etiketleri taşıyan bir USB bellek
   `/data` olarak bağlanabilir veya RAUC tarafından yazılabilir).
2. USB depolama ACTIVE durumunda usbguard ile varsayılan olarak engellidir. USB
   provisioning/kurtarma bundle'ı yalnız PROVISIONING veya MAINTENANCE durumunda, root ingress
   biriminde, private mount namespace'te `ro,nosuid,nodev,noexec` ile bağlanır; içerik yalnız imza
   doğrulamasından sonra kabul edilir. USB-serial (RS485 adaptörleri) ve HID sınıfları ayrı
   kurallarla izinlidir.
3. Prod'da login getty ve seri login yoktur; konsol çıktısı yalnız provisioning bilgisi (OTP,
   fingerprint) içindir. U-Boot'ta `bootdelay=-1` ve etkileşimli konsol kapalıdır; x86'da BIOS boot
   sırası kilitli ve setup parolası vardır.
4. `/boot` yalnız RAUC kurulumu ve mark-good sırasında rw bağlanır (bugün `boot.mount`
   `local-fs.target`'tan rw gelir; ADR-0007 H2).
5. U-Boot env'i redundant'tır (`CONFIG_ENV_REDUNDANT`, tercihen eMMC donanım boot bölümleri);
   bekleyen güncelleme yoksa boot başına `saveenv` yapılmaz (24 V saha ortamında güç kaybında FAT
   bozulması, eMMC aşınması).

**Gerekçe.** Etikete göre depolama bulmak ve rw `/boot` fiziksel erişimli saldırgana kalıcılık ve
boot zinciri değişimi verir.

**Sonuçlar / Riskler.** usbguard kuralları kart başına bakım ister; RS485 adaptörü değişimi kural
güncellemesi gerektirebilir.

**Uygulama.** Suderra-OS: `overlay/usr/sbin/suderra-data-unlock`,
`package/suderra-rauc-config/{system.conf,system.conf.arm,boot.mount,boot.mount.arm,fw_env.config}`,
`board/suderra/aarch64-rpi4/uboot-fragment.config`, `board/suderra/aarch64-rpi4/boot.scr.cmd`,
`configs/suderra_*_prod_ab_defconfig` (`BR2_PACKAGE_USBGUARD=y`), `overlay/etc/usbguard/rules.conf`
(yeni), `overlay/etc/systemd/system/suderra-usb-ingress@.service` (yeni; private mount namespace),
`userspace/suderra-installer/src/cmd/ingress.rs` (yeni; kopyala-sonra-doğrula),
`board/suderra/aarch64-revpi4/cmdline.txt`. Kapatılan bulgular: EI-013, EI-034, EI-035, EI-036,
EI-049, EI-050 (P1); EI-061 (USB ingress'te kopyala-sonra-doğrula, P1).

**Faz.** P1.

---

### DEC-19 — Üretim modu asla env ile belirlenmez

**Karar.** Üretim modu verity korumalı `/etc/os-release` `VARIANT`'ından veya derleme zamanı
feature'ından türetilir; prod'da güvenlikle ilgili tüm env override'ları yok sayılır. Bugünkü
örnekler: `Suderra-OS/userspace/suderra-installer/src/variant.rs:30-37` (env os-release'i ezer),
`Suderra-OS/userspace/suderra-ota/src/main.rs:644` (`SUDERRA_OTA_PRODUCTION`),
`overlay/usr/sbin/suderra-edge-install:10-11`, `:22-24` (pubkey, doğrulayıcı binary'si, asgari
epoch, rollback floor), `:42` (`SUDERRA_TARGET_BOARD` kart tespitini, yani I/O backend'ini ezer),
`overlay/usr/sbin/suderra-data-unlock:89-90` (`SUDERRA_DATA_DEVICE`, `SUDERRA_DATA_MAPPER`), agent'ta
`SUDERRA_SCADA_BIND`, `SUDERRA_SCADA_PORT` (`scada_server.rs:2269-2277`) ve
`SUDERRA_SCADA_AUTH_TOKEN` (`:1100`). Agent'ın yol env'leri (`SUDERRA_CONFIG`, `SUDERRA_DATA_DIR`,
`SUDERRA_MACHINE_ID_PATH`, `SUDERRA_DB_KEY_PATH`) Suderra OS profilinde okunmaz (DEC-4.5). Her iki
repoda bir invariant testi prod kod yollarındaki env okumalarını tarar ve allowlist dışını reddeder;
allowlist boş başlar ve her girdi bir gerekçe ister.

**Gerekçe.** Env, root'un altındaki herhangi bir unit dosyası veya drop-in ile değişebilir; güvenlik
kararı verity'deki veriye bağlanmalıdır.

**Sonuçlar / Riskler.** Dev/test akışları env yerine dev imaj varyantı ister.

**Uygulama.** Suderra-OS: `userspace/suderra-installer/src/variant.rs`,
`userspace/suderra-ota/src/main.rs`, `userspace/suderra-installer/src/cmd/edge.rs`,
`overlay/usr/sbin/suderra-data-unlock`, `tests/security/no-security-env-in-prod-test.sh` (yeni).
aquaculture_platform: `sens-api-gateway/src/scada_server.rs`, `src/config.rs`, `src/data_dir.rs`,
`src/machine_id.rs`, `src/db_secret.rs`,
`sens-api-gateway/tests/invariants/no_security_env_in_suderra_os.rs` (yeni). Kapatılan bulgular:
EI-030, EI-039, EI-040, EI-053, EI-062 (P0).

**Faz.** P0.

---

### DEC-20 — Release pipeline bütünlüğü

**Karar.** Release build'leri cache'sizdir (bugün `actions/cache` `~/.cargo/bin/cross`'u ve target'ı
geri yükler, `.github/workflows/edge-agent-release.yml:183-203`: imzalanacak artifact'a cache
zehirlenmesi yolu); toolchain imajları digest ile pinlidir; imzalama ayrı, minimal bir job'dadır
(cache yok, üçüncü taraf action yok, korumalı environment, required reviewers, korumalı tag'ler).
P0'da bu job dev/CI anahtarıyla imzalar; P1'den KMS'e kadar üretim release statement'ının imzasız
payload'ını ve provenance'ı üretir, statement'ı edge-release emanetçileri offline imzalar (DEC-3.9).
P2'de imzalama KMS/OIDC'ye taşınır, iki builder arasında reproducible-build doğrulaması yapılır
(`Suderra-OS/scripts/verify-reproducible.sh` deseni) ve bulut provenance'ı release admission'da
doğrular.

**Gerekçe.** Ed25519 ile imzalanacak bir artifact'ın girdileri imzanın güvenilirliğini belirler.

**Sonuçlar / Riskler.** Cache'siz build'ler daha uzun sürer; reproducible build Rust cross
toolchain'inde yol/zaman damgası normalleştirmesi ister.

**Uygulama.** aquaculture_platform: `.github/workflows/edge-agent-release.yml`,
`apps/sensor-service/src/release-bundle/release-admission.service.ts` (yeni; P2 provenance
admission). Suderra-OS: yok. Kapatılan bulgular: INFRA-HIGH-237 (P0; `gpio` dahil release feature
setinin CI'da derlenmesi ve test edilmesi); INFRA-MEDIUM-241, INFRA-MEDIUM-242, INFRA-MEDIUM-244
(P2).

**Faz.** P0: ayrı cache'siz imzalama job'u ve korumalı environment. P1: üretim release
statement'larının offline imzası (DEC-3.9). P2: KMS/OIDC, reproducible build, provenance admission.

---

### DEC-21 — TPM hiyerarşi sahipliği ve kaynak kaydı

**Karar.** Provisioning'de rastgele owner ve lockout auth değerleri atanır (politikaya göre
mühürlenir veya atılır). Agent P0–P1'de hiçbir TPM cihazı almaz: overlay unit'inden `/dev/tpm0` ve
`/dev/tpmrm0` P0'da kaldırılır (bugün ikisi de rw verilir, `suderra-agent.service:70-71`; sahipsiz
bir TPM'de ele geçirilmiş agent `TPM2_Clear` veya dictionary-attack lockout'u ile `/data` anahtarını
yok edebilir). Agent `/dev/tpmrm0`'ı yalnız P2'de, TPM keystore etkinleştiğinde (EDGE-MEDIUM-099),
yalnız `tpm` feature'lı profilin kart drop-in'iyle alır (SEC M10, SEC DEC-1 A4); drop-in yalnız
rastgele owner ve lockout auth atanmış bir cihazda etkindir, bu yüzden owner/lockout auth da P2'de
gelir. `/dev/tpm0` hiçbir fazda verilmez. OS'e ait bir TPM kaynak kaydı
tutulur: SRK, EK ve AK handle'ları, sahip başına NV indeks aralıkları (OS bloğu, agent bloğu),
politikaya bağlı PCR'lar (agent asla extend etmez), DA parametreleri; kod sabitleri üzerinde
contract test.

**Gerekçe.** OS (LUKS mühürü, rollback floor, AK) ve agent (keystore, sayaçlar, mTLS anahtarı) tek
TPM'i paylaşır; kayıt yoksa kalıcı handle'larda ve NV indekslerinde çakışırlar.

**Sonuçlar / Riskler.** Owner auth'un kaybı TPM'in yeniden sahiplenilmesini (veri kaybıyla)
gerektirir → emanet politikası DEC-14 ile birlikte.

**Uygulama.** Suderra-OS: `docs/security/tpm-resource-registry.md` (yeni),
`overlay/usr/sbin/suderra-data-unlock`, `overlay/usr/sbin/suderra-identity`,
`overlay/etc/systemd/system/suderra-agent.service` (P0: `/dev/tpm0` ve `/dev/tpmrm0` satırları
kaldırılır), `overlay/etc/systemd/system/suderra-agent.service.d/10-board-<profile>.conf` (P0–P1'de
TPM cihazı yok; P2'de `/dev/tpmrm0` yalnız TPM keystore etkin `tpm` profilinde),
`tests/image-contracts/tpm-registry-contract-test.sh` (yeni).
aquaculture_platform: `sens-api-gateway/src/keystore/` (handle/NV sabitleri),
`sens-api-gateway/tests/invariants/tpm_registry_constants.rs` (yeni). Kapatılan bulgu:
EDGE-MEDIUM-099 (TPM keystore, P2).

**Faz.** P0: agent unit'inden `/dev/tpm0` ve `/dev/tpmrm0`'ın kaldırılması. P1: kaynak kaydı ve
contract test. P2: rastgele owner/lockout auth ve ardından TPM keystore ile `/dev/tpmrm0` drop-in'i
(EDGE-MEDIUM-099).

---

### DEC-22 — İmzalama ve public uç noktalar için bulut tenant izolasyonu

**Karar.** Cihaza veya tenant'a bağlı her imzalı ifade `tenant_id` taşır: `edge-provisioning`,
`edge-update`, `edge-activation-receipt`, `site-config`, `site-netpolicy`, `rbac-manifest`,
`device-lifecycle` ve `os-update`. Cihaz `tenant_id`'yi kendi tenant bağlamasına (ilk provisioning
manifestinden root'un yazdığı `/data/suderra/os/identity/` kaydı) karşı doğrular. Release statement
(`edge-release`) tasarım gereği tenant'tan bağımsızdır: aynı binary her tenant'a gider ve hangi
cihazda çalışacağını cihaza bağlı manifest belirler (DEC-3.1). Trust-anchor bundle'ı tek bir
`tenant_id` değil `tenant_scope` listesi taşır; root ve agent cihazın tenant'ının bu listede
olduğunu doğrular, değilse bundle reddedilir (DEC-3.7). `key-epoch-advance` filo çapındadır ve kendi
kapsam alanını taşır (DEC-15). KMS'te anahtar politikası tenant kapsamlıdır (P2). Public `/install`
ve `/activate` uç noktaları tekdüze hata yanıtları ve oran sınırları kullanır; bugün yanıtlar
404/401/409 olarak ayrışır ve cihaz şemalar arasında aranır (`provisioning.service.ts`), bu bir
numaralandırma oracle'ıdır.

**Gerekçe.** Online imzacılar tüm tenant'lara hizmet eder; tenant bağlaması imza altında değilse bir
tenant'ın manifesti başka bir tenant'ın cihazında doğrulanabilir.

**Sonuçlar / Riskler.** Tekdüze hatalar teknisyen tanısını zorlaştırır → ayrıntı yalnız kimliği
doğrulanmış panelde görünür.

**Uygulama.** aquaculture_platform:
`apps/sensor-service/src/edge-device/{provisioning.controller.ts,provisioning.service.ts,edge-provisioning-manifest.service.ts,trust-anchor-bundle.service.ts}`,
`apps/gateway-api/src/config/rate-limit.config.ts` (oran sınırları). Suderra-OS:
`userspace/suderra-installer/src/contracts.rs` ve `src/trust_anchors.rs` (tenant ve tenant kapsamı
kontrolü). Kapatılan bulgular: SENSOR-LOW-234, SENSOR-LOW-235 (P0).

**Faz.** P0: `tenant_id` imza altında, tekdüze hatalar, oran sınırları. P2: KMS tenant kapsamı.

---

### DEC-23 — OS/agent uyumluluk sözleşmesi

**Karar.** Release statement `min_os_version`, gerekli kernel özelliklerini ve `agent_abi`'yi taşır;
OS `/etc/os-release`'te desteklediği `SUDERRA_AGENT_ABI` aralığını yayımlar. Her iki installer
uyumsuz çifti reddeder: `suderra-ota` ön kontrolü kurulu agent'ı desteklemeyen bir OS'i, agent
installer'ı çalışan OS'in desteklemediği bir agent'ı kurmaz. Health gate çifti doğrular. OS
güncelleme teslimi DEC-2 istek kanalı ve bulut kohort dağıtımıyla
(`apps/sensor-service/src/release-bundle/`) yapılır.

**Gerekçe.** OS güncellemeleri (kernel, piControl, libc) agent'ı, agent release'leri OS
özelliklerini bozabilir; bugünkü gate ya her OS güncellemesini engeller ya da yalnız `is-active`'e
bakar.

**Sonuçlar / Riskler.** ABI sürümlemesi disiplin ister; ABI'yi bozan bir OS değişikliği agent
release'iyle koordine edilir.

**Uygulama.** Suderra-OS: `userspace/suderra-ota/src/main.rs` (ön kontrol),
`userspace/suderra-installer/src/contracts.rs`, `package/suderra-rauc-config/suderra-rauc-health-gate`
(çift kontrolü), `board/suderra/common/post-build.sh` (os-release `SUDERRA_AGENT_ABI`).
aquaculture_platform: `.github/workflows/edge-agent-release.yml`,
`apps/sensor-service/src/release-bundle/release-bundle.service.ts` (kohort dağıtımı).

**Faz.** P0: alanlar ve reddetme. P1: OS güncelleme teslimi ve kohort.

---

### DEC-24 — Read-only root mutable-state tablosu

**Karar.** Prod root, `/var` veya `/etc` overlay'i olmayan read-only bir dm-verity mount'udur
(`Suderra-OS/scripts/production-artifacts.sh`). Her değişebilir yol ve sahibi tek tabloda tutulur;
`/data` altındaki sahiplik ve modlar DEC-4.2'dedir:

| Yol | Çözüm |
|---|---|
| `/etc/machine-id` | Boş dosya olarak sevk edilir; systemd her boot'ta geçici değer üretip bind eder. Kalıcı hiçbir şey ona bağlanmaz (DEC-4.9) |
| `/etc/shadow` | provisioning OTP'si `/run/suderra-os/`'tan bind (DEC-5.2) |
| `/etc/systemd/system` maskeleri | birim koşulları veya `/run/systemd/system` runtime maskeleri |
| `/var/spool/suderra-provision` | `/run/suderra-provision/` (tmpfs) bind; root:provision 0750, `inbox/` provision:provision 0700, sonuç dosyası root:provision 0640 (DEC-4.2) |
| `/var/lib/suderra-installer` | `/data/suderra/os/installer/` (root:root 0700) |
| `/run/suderra-installer` | `RuntimeDirectory=` ile oluşur (worker unit'i; EI-001) |
| `/opt/suderra/edge` | `/data/suderra/edge` bind (DEC-1) |
| `/etc/dropbear` host key | `/data/suderra/os/ssh/` (root:root 0700) |
| `/var/lib/chrony` | `/data/suderra/os/chrony/` bind; chrony:chrony 0750 (DEC-4.2, DEC-7) |
| `/var/lib/systemd/timesync` | kullanılmaz; zaman tabanı DEC-7 |
| `/var/log/journal` | kullanılmaz; journald `Storage=volatile`, `/run/log/journal`, sınırlı `RuntimeMaxUse=` (DEC-4.9) |
| `/data/rauc` | RAUC durum ve health-gate kayıtları; root:root 0700 (DEC-4.2) |
| `/boot` | yalnız RAUC kurulumu ve mark-good sırasında rw |

Prod defconfig'lerde `BR2_TARGET_GENERIC_REMOUNT_ROOTFS_RW=n` (bugün hiçbir defconfig set etmez,
varsayılan `y`; `systemd-remount-fs` verity'de başarısız olur). Bir image-contract testi QEMU prod
imajını boot eder ve journal'da herhangi bir EROFS'ta başarısız olur (P1 çıkışı). P0'da aynı yollar,
dev imajının kökü rw olduğu için, üretim unit'lerinin sandbox'ıyla koşan testlerle kapsanır
(`tests/qemu/edge-readonly-sandbox-test.py`, Uygulama P0). `/data` ilk boot'ta
`luksFormat`'tan önce cihazı dolduracak şekilde büyütülür (`systemd-repart`); eMMC EXT_CSD
ömür/pre-EOL telemetrisi gönderilir. RevPi üretimi için asgari eMMC boyutu operatör kararıdır;
önerilen varsayılan 32 GB'tır (Soru 6).

**Gerekçe.** Rootfs'e yazan her bileşen prod'da sessizce başarısız olur (K3, K9, K11); tablo bunları
tek yerde görünür kılar, EROFS testi build'de yakalar.

**Sonuçlar / Riskler.** `/data` büyütme ilk boot süresini uzatır. Volatile journal reboot'ta
kaybolur; kalıcı kanıt audit log'u ve DEC-27 telemetrisidir (DEC-4.9).

**Uygulama.** Suderra-OS: `configs/*_prod_ab_defconfig`, `board/suderra/common/post-build.sh`,
`overlay/usr/lib/tmpfiles.d/suderra.conf` (yeni),
`overlay/etc/systemd/journald.conf.d/10-suderra-volatile.conf` (yeni),
`overlay/etc/systemd/system/suderra-provision-worker.service` (`RuntimeDirectory=`),
`overlay/usr/lib/repart.d/50-data.conf` (yeni, P1), `tests/image-contracts/readonly-root-contract-test.sh`
(yeni), `board/suderra/aarch64-revpi4/genimage-prod.cfg`. Kapatılan bulgular: EI-026 (P0); EI-010
(veri birimi sandbox'ı ve mountpoint'ler, P1).

**Faz.** P0: tablo, `REMOUNT_ROOTFS_RW=n`, volatile journal, sandbox EROFS testi. P1: prod-QEMU
EROFS boot testi, `/data` büyütme, eMMC telemetrisi.

---

### DEC-25 — Çapraz repo sözleşme SSoT'si

**Karar.**

1. aquaculture_platform'da sürümlü bir `contracts/suderra-edge/v<N>/` dizini tutulur:
   - `schemas/<kind>.schema.json`: release statement, provisioning, update, activation receipt, site
     config (çıkış politikası ve olay davranış tablosu dahil), site netpolicy, RBAC manifesti,
     trust-anchor bundle, device-lifecycle, os-update ve sonuç telemetrisi (DEC-27);
   - `fixtures/<kind>/{valid,invalid}/`: test anahtarlarıyla imzalı golden fixture'lar (geçerli
     örnekler ve her red nedeni için negatif örnekler). `test-keys/` yalnız public anahtarları
     tutar; fixture'lar bir kez üretilip imzalanır, private test anahtarı repoda tutulmaz;
   - `boards.json` (kart haritası, DEC-8.4), `unit-directives.json` (unit direktif allowlist'i,
     DEC-1.9), `artifact-naming.json` (DEC-8.5) ve `envelope-v4/` test vektörleri (DEC-9.5).
2. Suderra-OS dizini digest ile vendor eder (`Suderra-OS/contracts/suderra-edge/` +
   `Suderra-OS/contracts/suderra-edge.digest`); `sens-api-gateway` ve sensor-service aynı dizini
   doğrudan tüketir. Her repoda CI drift'te başarısız olur: vendored digest ≠ pin, fixture
   doğrulaması başarısız, şema ile üretici/tüketici tipi arasında fark.
3. Uçtan uca QEMU hattı faz faz büyür:
   - P0, her PR: `Suderra-OS/.github/workflows/image-build.yml`'a yeni bir `edge-e2e` job'u eklenir
     (`needs: [matrix, build]`). Job, aynı workflow'un PR'da build ettiği
     `suderra_qemu_x86_64_defconfig` dev imajını (`qemu_test: true`, `ci/build-matrix.yml:19`; bugün
     yalnız `qemu-smoke-test` boot eder, `image-build.yml:1087-1131`) OVMF ve swtpm ile boot eder ve
     `tests/qemu/edge-provisioning-e2e.py`'yi çalıştırır. Workflow'un `pull_request.paths`
     filtresine `tests/qemu/**` ve `contracts/**` eklenir (bugün yalnız `board/`, `ci/`, `configs/`,
     `package/`, `patches/`, `scripts/`, `userspace/` ve workflow dosyası tetikler,
     `image-build.yml:9-19`). Kapsam: provisioning → aktivasyon → lockdown (Uygulama, P0 çıkış
     kriteri); agent güncellemesi ve rollback P0 kapsamında değildir.
   - P1: aynı job'a agent güncellemesi + rollback ve `kind=site-config` senaryoları eklenir.
     `.github/workflows/production-runtime-qemu.yml` `workflow_dispatch` ile tetiklenen release
     kanıtı rolünü korur (`:3-30`; `suderra_qemu_x86_64_prod_ab_defconfig`'i build eder, `:89`) ve
     prod_ab senaryosunu kazanır: RAUC health gate, verity rootfs, LUKS2 + swtpm, read-only kökte
     EROFS'suz boot, reboot sonrası `verify-current`, agent güncellemesi + rollback
     (`tests/qemu/production-runtime-scenario.py`).

**Gerekçe.** Üç bileşen manifest şeması ve kanonik baytlar, unit hardening kümesi, kart kimlikleri
(bugün beş ayrı sözlük), artifact adları ve anahtar yolları konusunda anlaşmalıdır; bunu hiçbir şey
test etmediği için zincir hiçbir CI kırmızıya dönmeden kırıktır (3. kademe: tespit edilebilir
kılma). `production-runtime-qemu.yml` yalnız elle ve release girdileriyle tetiklendiği için PR kapısı
olamaz; PR'da zaten build edilen dev imajı bu yüzden P0 kapısını taşır.

**Sonuçlar / Riskler.** Sözleşme değişikliği iki repoda koordineli PR ister; vendored kopya bilerek
güncellenir. `edge-e2e` job'u image-build süresini uzatır; imaj zaten build edildiği için ek süre boot
ve testtir. KVM'siz runner'da QEMU TCG modunda yavaştır (`image-build.yml` KVM kontrolü).

**Uygulama.**

- aquaculture_platform: `contracts/suderra-edge/v1/` (yeni), `.github/workflows/ci-edge.yml`
  (fixture doğrulaması ve drift), `sens-api-gateway/tests/contracts_golden.rs` (yeni),
  `apps/sensor-service/src/edge-device/__tests__/contracts-golden.spec.ts` (yeni).
- Suderra-OS: `contracts/suderra-edge/` (vendored) ve `contracts/suderra-edge.digest` (yeni),
  `tests/image-contracts/contracts-vendor-digest-test.sh` (yeni), `.github/workflows/image-build.yml`
  (`edge-e2e` job'u, `paths` filtresi), `tests/qemu/edge-provisioning-e2e.py` (yeni),
  `tests/qemu/fake_cloud.py` (yeni; yerel sahte bulut), `tests/qemu/edge-readonly-sandbox-test.py`
  (yeni), `.github/workflows/production-runtime-qemu.yml` ve
  `tests/qemu/production-runtime-scenario.py` (P1).
- Kapatılan bulgular: EI-023 (P0; dev imajı doğrulayıcı ve anahtarlarla build edilir, DEC-8.10);
  EI-027 (P1; senaryo sürücüsü geçerli `suderra-ota` CLI'sini kullanır ve beklenen redleri nedenine
  göre ayırır).

**Faz.** P0: SSoT dizini, vendoring, drift CI, `edge-e2e` job'u (provisioning → lockdown). P1:
güncelleme, rollback ve site-config senaryoları; `production-runtime-qemu.yml`'da prod_ab
senaryosu.

---

### DEC-26 — Yerel kiosk ekranı

**Karar.** Suderra OS yerel kiosk sevk etmez. `sens-api-gateway/systemd/suderra-display.service`
(cage + `chromium-browser`, `ConditionPathExists=/dev/dri/card0`) yalnız generic-Linux içindir ve
Suderra OS imajına girmez (invariant). HMI LAN üzerinden, yalnız site başına etkinleştirildiğinde,
TLS ve kimlik doğrulamayla sunulur (DEC-11 inbound, DEC-9 yetkilendirme). `scada-display` cargo
feature'ı (gömülü web HMI sunucusu) Suderra OS profillerinde kalır; varsayılan bind loopback'tir.

**Gerekçe.** Buildroot Chromium paketlemez; kernellerde DRM/input yok; KUNBUS overlay'i HDMI1'i
kapatır; rootfs bütçesi 256–512M'dir; bir kiosk varyantı kendi boyut bütçesini ve güvenlik
incelemesini ister.

**Sonuçlar / Riskler.** Yerel ekran isteyen sahalar LAN üzerindeki bir panel PC veya tablet
kullanır.

**Uygulama.** Suderra-OS: `tests/image-contracts/no-kiosk-contract-test.sh` (yeni;
`suderra-display.service` ve cage/Chromium imajda yok). aquaculture_platform:
`sens-api-gateway/src/scada_server.rs` (TLS, kimlik doğrulama, kilitlenme, config ile kapatılabilme),
`sens-api-gateway/systemd/suderra-display.service` (yalnız generic). Kapatılan bulgular:
INFRA-MEDIUM-243 (karar, P0); INFRA-MEDIUM-245, EDGE-MEDIUM-093, EDGE-LOW-108 (P2).

**Faz.** P0: karar ve invariant. P2: HMI TLS ve kimlik doğrulama.

---

### DEC-27 — Kurulum ve güncelleme sonucu telemetrisi

**Karar.** Root worker'lar tipli sonuçları kalıcı olarak `/data/suderra/os/results/` altına yazar ve
`/run/suderra/results/` altında agent'a gösterir (dizin root:suderra 0750, dosyalar 0640): kurulum,
güncelleme, site-config, verify-current, lockdown, yaşam döngüsü geçişleri, health gate, `/data`
unlock hatası ve time-state. Agent bunları ayrı bir MQTT topic'inde yayınlar;
bulut cihaz başına saklar (filo görünümü ve audit kanıtı): kurulu sürüm, doğrulama sonucu, rollback
olayları, lockdown durumu. Lockdown teknisyenin SSH oturumunu kapattığı için provisioning sonucu
bulut panelinde de görünür.

**Gerekçe.** Bugün kurulum sonuçları yalnız teknisyenin SSH oturumuna gider ve lockdown o oturumu
öldürür; cihazdan buluta bir kayıt yoktur (`suderra-lockdown-status` vardır ama hiçbir şey onu
raporlamaz).

**Sonuçlar / Riskler.** Telemetri şeması contracts'a girer; sonuç dosyaları imzalı değildir, bulut
onları gözlem olarak işler, yetki olarak değil.

**Uygulama.**

- Suderra-OS: `userspace/suderra-installer/src/results.rs` (yeni; tipli sonuç yazıcısı;
  `src/cmd/{edge.rs,site.rs,lifecycle.rs,health.rs,policy.rs}` bunu kullanır);
  `overlay/usr/sbin/suderra-lockdown`, `overlay/usr/sbin/suderra-data-unlock` ve
  `overlay/usr/sbin/suderra-time-state` sonuçlarını aynı biçimde yazar (`suderra-installer result
  write` alt komutu).
- aquaculture_platform: `contracts/suderra-edge/v1/schemas/result.schema.json` (yeni),
  `sens-api-gateway/src/telemetry.rs` (sonuç topic'i),
  `apps/sensor-service/src/edge-device/edge-result-telemetry.service.ts` (yeni; cihaz başına
  saklama), `apps/sensor-service/src/edge-device/mqtt-auth.service.ts` (sonuç topic'i ACL'i,
  `checkTopicAccess`).

**Faz.** P0: yerel tipli sonuç dosyaları (P0 kararlarının alarm sonuçları dahil). P1: MQTT yayını ve
bulutta saklama.

---

### DEC-28 — Generic-Linux kanalı ve HC-1 filosu

**Karar.** Generic kanal sözleşmesi dondurulur ve contract testle korunur: asset adları
`suderra-agent-<ver>-<slug>.tar.gz`, iç binary adı `edge-agent`, armv7, `/opt/suderra/edge-agent`,
bulutun `curl | bash` installer/update betiği (`installer-script.service.ts`). Agent'ın legacy
OTA'sı (`commands/firmware.rs:308` `suderra-agent-<arch>-unknown-linux-gnu.tar.gz` indirir) mevcut
release adlarını tüketemez; ölü kod olarak kaldırılır (SENSOR-MEDIUM-223). HC-1 cihazından Suderra
OS'e geçiş yeniden imajlama ve aynı device_id altında reserve/commit ile yeniden provisioning'dir;
offline queue ve audit zinciri isteğe bağlı olarak önceden dışa aktarılır. Generic kanalın sona erme
tarihi ancak filo telemetrisi arch ve kartı raporladıktan sonra yayımlanır. P2'de generic profil,
Suderra OS profilinde daha önce düzeltilen agent bulgularının generic karşılıklarını da alır:
config-integrity sürüm kapısı ve sidecar'ı (EDGE-HIGH-054, EDGE-HIGH-055), uzak config
güncellemesinin geri alınması ve `save()` davranışı (EDGE-MEDIUM-079, EDGE-MEDIUM-085), `db.key`'in
dayanıklı oluşturulması (EDGE-MEDIUM-080), I/O config'in ve alarm eşiklerinin yeniden yüklenmesi
(SENSOR-HIGH-212), imzalı ve yetkilendirilmiş config topic (SENSOR-HIGH-215), agent'ın doğruladığı
`SignedFirmwareManifest`'in bulut üreticisi (SENSOR-HIGH-207; generic kanal ADR-019'a tabidir), amaç
başına anahtarlar ve config dışı güven çapaları (SENSOR-HIGH-216), imzasız envelope aktörüne güvenin
kaldırılması (EDGE-HIGH-068) ve `/proc` okumalarının sysfs ile unit cgroup'una taşınması
(EDGE-MEDIUM-072). Bu bulguların kapanış commit'leri bu işle gelir (kapanış kuralı,
Implementation).

**Gerekçe.** v1.6.0 filosu generic Linux'ta, bulutun ürettiği unit'le ve `/etc/suderra`'daki
config'le çalışır; Suderra OS'e yerinde geçiş yolu yoktur. Suderra OS kararlarının generic kanalı
kırmaması gerekir.

Generic profil P1'de bilinçli varsayılanlarla (permissive + göç logu, DEC-9.10) açılır; P2'de
Disabled/Permissive ve legacy imzasız yol generic profilden de kaldırılır (DEC-9.1). Bundan önce HC-1
cihazları imzalı komut yoluna geçirilir: bulut onlara da `EdgeCommandPublisher` üzerinden imzalı
komut gönderir ve generic config'e imzalı bir RBAC manifesti ve çapası teslim edilir; v1.6.0 fixture
testi göçü kapsar.

**Sonuçlar / Riskler.** İki kanal paralel bakım ister; generic kanal P2'ye kadar ADR-019 ve permissive
varsayılanlarla yaşar. P2 geçişi göç etmemiş HC-1 cihazlarının mutating komutlarını keser → göç
durumu cihaz başına telemetriyle izlenir.

**Uygulama.** aquaculture_platform: `.github/workflows/edge-agent-release.yml`,
`sens-api-gateway/docs/deployment/fleet-ops.md`,
`apps/sensor-service/src/edge-device/provisioning.service.ts` (aktivasyon/heartbeat'te arch raporu),
`apps/sensor-service/src/edge-device/installer-script.service.ts` (generic installer ve unit),
`sens-api-gateway/tests/invariants/generic_channel_contract.rs` (yeni). Kapatılan bulgular:
SENSOR-MEDIUM-223 (P0); SENSOR-HIGH-208, SENSOR-HIGH-211 (P1); SENSOR-MEDIUM-225,
SENSOR-MEDIUM-226, SENSOR-HIGH-207, SENSOR-HIGH-212, SENSOR-HIGH-215, SENSOR-HIGH-216,
EDGE-HIGH-054, EDGE-HIGH-055, EDGE-HIGH-068, EDGE-MEDIUM-072, EDGE-MEDIUM-079, EDGE-MEDIUM-080,
EDGE-MEDIUM-085, SENSOR-CRITICAL-201 (generic profilde Permissive/Disabled ve legacy yolun da
kaldırılması), EDGE-MEDIUM-073, EDGE-MEDIUM-074, EDGE-HIGH-064 (generic profilde tryboot, ajan içi
cold-boot watchdog ve `reboot`/`restart_agent` yollarının kaldırılması veya OS'e devri) (P2; son
tarih 2026-12-31).

**Faz.** P0: generic kanal contract testi. P1: arch/kart raporu, profil varsayılanları. P2: generic
profilde imzalı komut zorunluluğu (HC-1 göçüyle) ve yukarıdaki bulguların generic karşılıkları.

## Consequences

**Olumlu.**

- Zincirdeki her sınır imzalı ve şemalıdır; K1–K14'ün her biri ya derleme zamanında imkânsızdır ya
  da CI'da (contracts fixture'ları, invariant'lar, QEMU e2e) tespit edilir.
- Agent ele geçirilse bile kendi binary'sini, boot config'ini, firewall'ını, kilit durumunu veya
  güven çapalarını değiştiremez; root her şeyi kopyalayıp yeniden doğrular.
- İmzacıların ihlali sınırlıdır: release anahtarı hangi cihazda çalışacağını, provisioning
  anahtarı ne çalışacağını, ikisi de agent içi güven çapalarını belirleyemez; epoch ratchet'i gerçek
  iptal sağlar.
- Hata durumunda süreç ayakta kalır ve çıkışlar donanım safe-state'indedir; agent hataları OS
  reboot'una, OS güncellemeleri plansız kesintiye dönüşmez.
- Kart kimliği imzalı imajdan gelir; yanlış I/O backend'i sürmek mümkün değildir.

**Olumsuz.**

- Prod imaj koşullu bir SSH daemon'u ve ek root birimleri taşır; saldırı yüzeyi provisioning
  süresince büyür.
- İki agent profili (Suderra OS, generic) ve iki release kanalı paralel bakım ister.
- RevPi için KUNBUS kernel'i ve piControl'ün sahipliği, x86 için model qualification'ı ve SB
  seremonisi kalıcı operasyon yüküdür.
- OTP secure boot fuse'u geri dönüşsüzdür (Soru 7).
- Saha devreye alması (kablolama, çıkış politikası, ağ rolleri, NTS) uzar.
- P2 çıkışına kadar sahalar yalnız izleme amaçlıdır ve TPI sınıfı uzak komut yoktur (SG-1, DEC-9.4);
  P1b çıkışına kadar x86 birimi kurulmaz (SG-3).

**Nötr / ödünleşimler.**

- P1'den P2 çıkışına kadar online üretim imzalama anahtarları KMS dışında, sensor-service
  secret'larındadır (EDGE-HIGH-119); SG-1 izleme amaçlı pilotlar üretim imajlarıyla bu riskle
  çalışır. fleet-root ve edge-release P1'den itibaren offline'dır; KMS P2 çıkış kriteridir.
- Bulut operatör anahtarlarını sakladığı sürece güvenlik vakası SL2'dir.
- RPi4/CM4, add-on TPM ve OTP secure boot olmadan SL2 iddiası taşımaz.

## Implementation

Bulgular kayıtlıdır: aquaculture_platform
`docs/reviews/claude/2026-10-19-suderra-os-edge-integration-audit.md` (EDGE-, SENSOR- ve INFRA-
kimlikleri; `docs/reviews/_registry/findings.jsonl`), Suderra-OS
`docs/assessments/2026-10-19-edge-agent-integration-audit.md` (`EI-NNN`). Her bulgunun sahibi
@Okan-wqm'dir; son tarihi fazından gelir: P0 2026-11-02, P1 2026-11-30, P2 2026-12-31, P3 2027-03-31.
Bulgu → karar eşlemesi her kararın Uygulama bölümünde ve Karar özeti'ndedir. aquaculture_platform'da
bulguyu kapatan uygulama commit'i
`Closes: docs/reviews/claude/2026-10-19-suderra-os-edge-integration-audit.md#<finding-id>` satırı
taşır (kapatmayan ara commit'ler aşağıdaki kapanış kuralına göre `Refs:` taşır); Suderra-OS'te her
uygulama commit'i `Refs: docs/assessments/2026-10-19-edge-agent-integration-audit.md#<finding-id>`
satırı taşır. Bir fazın çıkış kriterine bağlı iş, önceki faz o kritere ulaşmadan başlamaz; bağımsız
işler paralel yürür.

Kapanış kuralı: bir bulgu yalnız desteklenen her profilde (Suderra OS ve generic) ve her parçasıyla
düzeltildiğinde kapanır. Suderra OS profilindeki iş daha erken bir fazda gelirse o commit'ler
bulguyu `Refs: docs/reviews/claude/2026-10-19-suderra-os-edge-integration-audit.md#<finding-id>` ile
anar; `Closes:` satırı, generic profil/HC-1 işiyle DEC-28 altında P2'de (son tarih 2026-12-31) gelen
commit'tedir. Bu, DEC-2, DEC-3, DEC-4 ve DEC-9'un Uygulama bölümlerinde böyle işaretlenen bulgular
içindir (SENSOR-HIGH-207, SENSOR-HIGH-212, SENSOR-HIGH-215, SENSOR-HIGH-216, EDGE-HIGH-054,
EDGE-HIGH-055, EDGE-HIGH-068, EDGE-MEDIUM-072, EDGE-MEDIUM-079, EDGE-MEDIUM-080, EDGE-MEDIUM-085).
Parçaları farklı fazlara düşen bir bulgu son parçanın fazında kapanır; önceki parçalar `Refs:`
taşır (örneğin EI-037: x86 P1, ARM P3).

Sıralama kısıtları (yanlış sırada uygulanırsa kilitlenme): Enforcing, publisher, trust-anchor bundle
ve imzalı RBAC manifesti yokken komut düzlemini durdurur; lockdown, root-doğrulanmış receipt yokken
her kurulumu geri alır; health gate'in agent koşulu yaşam döngüsüne bağlanmadan fabrika-taze
cihazlarda OS güncellemelerini geri alır; x86 firewall'ı kernel seçenekleri gelmeden açık kalır; dev
QEMU imajı nft/TPM kernel seçenekleri, doğrulayıcı ve anahtarlar gelmeden P0 testini koşturamaz. P0
bunların hepsini birlikte çözer.

### Saha devreye alma kapıları

| Kapı | Kural | Kapıyı açan koşul | Uygulama noktası |
|---|---|---|---|
| SG-1 | P2 çıkışından önce canlı stoklu veya fiziksel aktüasyonlu bir sahaya dağıtım yapılmaz; o zamana kadar dağıtımlar yalnız izleme amaçlı (salt okunur) pilotlardır ve P1 seremonisinden sonra build edilen üretim imajlarıyla yapılır (DEC-3.9); dev imajı sahaya kurulmaz | P2 çıkışı: HMI yetkilendirmesi ve tag başına cihaz yönlendirmesi (DEC-9.7; EDGE-HIGH-069, EDGE-HIGH-070), e-stop kapsamı ve kalıcılığı (EDGE-HIGH-057, EDGE-HIGH-067), DEC-13 çıkış başına politika ve yerel uygulama katmanı | Bulut: `site-config-manifest.service.ts`, SG-1 açılana kadar yazılabilir çıkış içeren site config'i imzalamaz (contract testi) |
| SG-2 | Hiçbir kart için P3 çıkışından ve donanım kanıtından önce SL2 iddia edilmez | P3 çıkışı ve kart başına kanıt: RevPi'de OTP secure boot + measured boot + ADR-0007 G4/G5; x86'da model qualification + SB sahipliği + imzalı PCR politikası + recovery yolu | Güvenlik vakası (`Suderra-OS/docs/security/security-architecture.md`) ve müşteri dokümanları |
| SG-3 | P1b çıkışından önce sahaya x86 birimi kurulmaz | P1b çıkışı (x86 modeli seçildikten sonra): SB sahipliği, imzalı PCR 7 + 11 politikası, recovery yolu, dönüşüm runbook'u, model qualification (DEC-8.9, DEC-14.1); x86 prod imajı P1 seremonisinin üretim anahtarlarıyla build edilmiştir (DEC-3.9). Kurulan x86 birimi SG-1'e de tabidir | Bulut: provisioning manifesti P1 çıkışından önce `x86-ipc-*` board profile'ı için üretilmez |

İzleme amaçlı (salt okunur) dağıtım: imzalı site config'te yazılabilir çıkış yoktur (Modbus
`allow_writes: false`; GPIO/piControl çıkışı, OPC UA ve S7 yazma hedefi tanımlı değildir); HMI ve
OPC UA inbound kapalıdır (DEC-11.9); TPI sınıfı komutlar zaten reddedilir (DEC-9.4). Yazılabilir
çıkışı olmayan bir config'le boot edebilmek (EDGE-HIGH-061, DEC-6) bu dağıtımların ön koşuludur.
Pilotlar üretim imajıyla, P2'deki KMS'e kadar servis secret'larında tutulan online üretim
anahtarlarıyla çalışır; bu risk (EDGE-HIGH-119) yalnız bu izleme amaçlı pilotlar için kabul
edilmiştir.

### Takip edilen kalıntı riskler

Kalıntı riskler aquaculture_platform bulgu kaydındaki bulgulardır
(`docs/reviews/claude/2026-10-19-suderra-os-edge-integration-audit.md`,
`docs/reviews/_registry/findings.jsonl`); sahibi @Okan-wqm'dir, son tarihi fazından gelir ve her
biri tablodaki kararın Uygulama bölümünde kapanır. Kalıntı riskle örtüşen, denetimden gelen bulgular
kendi kimlikleriyle anılır ve burada tekrarlanmaz (örneğin EI-033, EI-037, EI-059, EDGE-MEDIUM-077,
SENSOR-HIGH-210, SENSOR-MEDIUM-232). Eşleme notu: taslaktaki R-01…R-10 sırasıyla
EDGE-MEDIUM-116…EDGE-LOW-125'e, R-12 ve R-13 EDGE-MEDIUM-126 ve EDGE-LOW-127'ye taşındı; R-11
EI-037'ye birleşti.

| ID | Risk | DEC | Önem | Faz | Son tarih |
|---|---|---|---|---|---|
| EDGE-MEDIUM-116 | Agent binary'si `/data`'da yalnız start anında doğrulanır (`verify-current`); çalışma sırasındaki değişiklik, kernel'in root hash imzasını zorladığı (`DM_VERITY_VERIFY_ROOTHASH_SIG` veya IPE) imzalı verity release imajına kadar yakalanmaz | DEC-1.5, DEC-1.6 | MEDIUM | P2 | 2026-12-31 |
| EDGE-MEDIUM-117 | Root update worker P1'de operatör onaylarını doğrulayamaz; iki kişilik onay yalnız bulut tarafındadır (`edge-update.v2` + `approvals[]` P2'de) | DEC-2.4 | MEDIUM | P2 | 2026-12-31 |
| EDGE-MEDIUM-118 | Hava boşluklu sahalarda yerinde güncelleme yolu (USB/LAN update ingress) yoktur; güncelleme MAINTENANCE'ta yeniden provisioning ile yapılır | DEC-2.11 | MEDIUM | P3 | 2027-03-31 |
| EDGE-HIGH-119 | Online üretim imzalama anahtarları (edge-provisioning, device-lifecycle, command; aynı şekilde config-integrity, rbac-manifest) P1 seremonisinden P2'deki KMS/OIDC imzacısına kadar KMS dışında, sensor-service secret'larındadır. SG-1 izleme amaçlı pilotlar üretim imajlarıyla bu riskle çalışır ve risk yalnız bu pilotlar için kabul edilmiştir; fleet-root ve edge-release offline'dır | DEC-3.9 | HIGH | P2 | 2026-12-31 |
| EDGE-MEDIUM-120 | TPM'siz kartlarda (RPi4/CM4) rollback floor'u, epoch ratchet'i ve mTLS/keystore anahtarları yalnız `/data` korumasındadır; kart SL2 iddia edemez; üretim kullanımı operatör kararına bağlıdır (Soru 3) | DEC-3, DEC-8.11, DEC-10.7 | MEDIUM | P1 | 2026-11-30 |
| EDGE-MEDIUM-121 | Komut yetkisi P2'ye kadar tek bir `platform-authenticated` aktörüdür; operatör başına anahtar ve TPI co-signing yoktur (TPI sınıfı reddedilir) | DEC-9.4 | MEDIUM | P2 | 2026-12-31 |
| EDGE-MEDIUM-122 | Envelope v3 cihaza değil tenant'a bağlıdır: aynı tenant'taki başka bir cihaza 300 s içinde replay mümkündür | DEC-9.5 | MEDIUM | P2 | 2026-12-31 |
| EDGE-MEDIUM-123 | Üretim bundle'ının MQTT CA kümesi P2'ye kadar kamu ISRG köklerini içerir; broker adı için herhangi bir DV sertifikası sunucu olarak güvenilir sayılır (cihaz kimliği kamu CA'sından türetilmez) | DEC-10.4 | MEDIUM | P2 | 2026-12-31 |
| EDGE-MEDIUM-124 | TPM NV "provisioned" biti gelene kadar `/data`'yı fiziksel olarak silen biri provisioning'i yeniden açabilir | DEC-12 | MEDIUM | P3 | 2027-03-31 |
| EDGE-LOW-125 | Prod imajı provisioning için koşullu bir SSH daemon'u taşır (claim-code varsayılan olana kadar) | DEC-5 | LOW | P3 | 2027-03-31 |
| EDGE-MEDIUM-126 | P0–P2'de aktivasyon cihaz anahtarına sahiplik kanıtı (PoP) istemez; bağlama provisioning token'ı, imzalı manifestteki `device_binding` hash'i ve bulut imzalı activation receipt'idir | DEC-5.8, DEC-10.7 | MEDIUM | P3 | 2027-03-31 |
| EDGE-LOW-127 | Kısa ömürlü cihaz sertifikaları: sertifika ömründen uzun çevrimdışı kalan bir saha PoP ile yeniden sertifika alana kadar buluta bağlanamaz; PoP da başarısızsa saha ziyareti gerekir | DEC-10.7 | LOW | P3 | 2027-03-31 |

### P0 — "zincir çalışır"

**Çıkış kriteri.** `Suderra-OS/.github/workflows/image-build.yml`'daki yeni `edge-e2e` job'u her PR'da
aynı workflow'un build ettiği `suderra_qemu_x86_64_defconfig` dev imajını OVMF ve swtpm ile boot eder
ve `tests/qemu/edge-provisioning-e2e.py`'yi çalıştırır (DEC-25). Bulut tarafını yerel sahte bulut
taşır (`tests/qemu/fake_cloud.py`: manifest, aktivasyon ve receipt uç noktaları, 8883 TLS test
broker'ı, dev anahtarlarıyla imzacı). Test şu zinciri doğrular:

1. ilk boot → `/data/suderra/os/lifecycle` yok → yaşam döngüsü PROVISIONING (DEC-12 dev kuralı);
   provisioning ruleset'i yalnız varsayılan rotayı taşıyan arayüzde (DEC-5.4);
2. betikli teknisyen SSH komutu (token stdin'den) → cihaz manifesti `X-Provisioning-Token`
   header'ıyla çeker;
3. sahte bulut, dev anahtarlarıyla imzalı ve cihaza bağlı (swtpm EK hash'i)
   `suderra.edge-provisioning.v1` döner; root release statement'ı, manifesti, iç içe `site-config`
   ifadesini ve dev fleet-root'uyla imzalı trust-anchor bundle'ını doğrular;
4. agent `/data/suderra/edge`'e atomik olarak kurulur, `verify-current` geçer;
5. agent aktiftir ve en az üç `WatchdogSec` periyodu boyunca `NRestarts=0`'dır (K2);
6. aktivasyon → cihaz kimlik bilgisiyle 8883 TLS CONNECT → sahte bulutun imzaladığı activation
   receipt'ini root doğrular → ACTIVE;
7. lockdown: SSH kapalıdır ve yüklü ruleset'in hash'i appliance ruleset'ininkine eşittir.

Negatif durumlar aynı testtedir ve her biri reddedilir, yaşam döngüsü değişmez: yanlış device
binding, süresi dolmuş manifest, değiştirilmiş artifact, imzasız receipt.

Dev imajının kökü rw olduğu için read-only kök davranışları (K3, K9, K11'deki EROFS yolları)
kendiliğinden oluşmaz. P0'da onları aynı job'daki `tests/qemu/edge-readonly-sandbox-test.py` kapsar:
release binary'si `systemd-run --wait` ile üretim agent unit'inin sandbox özellikleriyle koşar
(`ProtectSystem=strict`, read-only `/etc`, unit'in `ReadWritePaths=`'i; özellikler overlay unit
dosyasından okunur). Test READY'yi, `/etc` altına yazma denemesi olmadığını ve durumun yalnız
`/var/lib/suderra` altına gittiğini doğrular (K1, K11). Aynı mekanizma `suderra-installer edge
install`'ı provision-worker unit'inin özellikleriyle çalıştırır (K3, K9). RAUC health gate, verity
rootfs ve LUKS2 + swtpm P0'da doğrulanmaz; P1 çıkışında `suderra_qemu_x86_64_prod_ab_defconfig`'in
QEMU koşusuyla doğrulanır.

Ayrıca: agent envelope testleri platform aktörüyle imzalı ve RBAC manifestinde izinli bir komutu
kabul eder; imzasız komutu, TPI sınıfı komutları (DEC-9.4; fail-closed) ve provisioning anahtarıyla
imzalanmış bir trust-anchor bundle'ını reddeder. Contracts golden fixture'ları üç bileşende geçer;
her iki repoda CI yeşildir.

**Kapsam.** DEC-1, DEC-2 (agent tarafı yolların derleme zamanında çıkarılması, tek mark-good,
`security_version`), DEC-3 (DSSE, ayrı dev/CI anahtarları, epoch, binding, imzalama job'u, dev
fleet-root'lu trust-anchor bundle'ı, prod keyid allowlist'i), DEC-4 (madde 12'nin P0 yolu dahil),
DEC-5 (P0 maddeleri, yeniden provisioning dahil), DEC-6 (P0 maddeleri), DEC-8 (matris, adlandırma,
kart dosyası, x86 ve dev QEMU kernel'leri, dev defconfig), DEC-9 (P0 maddeleri), DEC-10 (P0
maddeleri, `CaAnchored`), DEC-11 (P0 maddeleri), DEC-12 (P0 maddeleri), DEC-13 (P0 maddeleri),
DEC-17 (akış a), DEC-19, DEC-20 (P0), DEC-21 (agent unit'inden `/dev/tpm0` ve `/dev/tpmrm0`'ın
kaldırılması), DEC-22 (P0), DEC-23 (P0), DEC-24 (P0), DEC-25 (P0), DEC-26,
DEC-27 (yerel sonuç dosyaları), DEC-28 (P0).

**Dosyalar — aquaculture_platform.**

- `sens-api-gateway/Cargo.toml`; `src/data_dir.rs`, `src/config.rs`, `src/main.rs`,
  `src/db_secret.rs`, `src/offline_queue.rs`, `src/machine_id.rs`, `src/db_migration/`,
  `src/gpio.rs`, `src/i2c.rs`, `src/spi.rs`, `src/pwm.rs`, `src/degraded.rs` (yeni),
  `src/trust_anchors.rs` (yeni), `src/commands/` (firmware, apply_signed_manifest, confirm_slot,
  catalog, provision, config_dispatch, system, request_update, lifecycle_request), `src/updater/`,
  `src/command_envelope/envelope.rs`, `src/authz/permission.rs`, `src/authz/manifest_runtime.rs`,
  `src/mqtt.rs`, `src/mtls/{mode.rs,rustls_verifier.rs}`, `src/keystore/bootstrap.rs`,
  `src/scripting/storage.rs`, `src/license_cache.rs`, `src/scada_server.rs`,
  `src/config_integrity/verify_runtime.rs`; `systemd/suderra-agent.service`; `tests/invariants/`
  (`sd_notify_no_unset_env.rs`, `ready_after_safe_state.rs`, `os_managed_updates_no_updater.rs`,
  `no_etc_write_paths.rs`, `no_security_env_in_suderra_os.rs`,
  `systemd_unit_directive_contract.rs`, `tpi_commands_rejected_without_co_approver.rs`,
  `generic_channel_contract.rs`); `tests/contracts_golden.rs`; `tests/v1_6_0_fixture_boot.rs`.
- `.github/workflows/edge-agent-release.yml` (matris, `suderra-agent` adı, DSSE release statement,
  cache'siz imzalama job'u, generic kanal contract'ı); `.github/workflows/ci-edge.yml`.
- `apps/sensor-service/src/edge-device/`: `installer-script.service.ts`, `provisioning.service.ts`,
  `provisioning.controller.ts`, `mqtt-auth.service.ts`, `edge-device.service.ts`,
  `edge-device.module.ts`, `command-envelope-signer.service.ts`,
  `edge-provisioning-manifest.service.ts`, `site-config-manifest.service.ts`,
  `rbac-manifest.service.ts`, `trust-anchor-bundle.service.ts`,
  `device-lifecycle-statement.service.ts`, `manifest-signer.ts`,
  `edge-command-publisher.service.ts` (hepsi yeni), `entities/edge-device.entity.ts`,
  `__tests__/` (`provisioning-reservation.spec.ts`, `contracts-golden.spec.ts`);
  `apps/sensor-service/src/vfd/services/vfd-edge-{write,read,provisioning}.service.ts`; üretilmiş
  migration `apps/sensor-service/src/database/migrations/<ts>-EdgeProvisioningReservation.ts`.
- `infrastructure/mosquitto/mosquitto-production.conf` (8883 cihaz yolu);
  `apps/sensor-service/src/edge-device/mqtt-auth.service.ts` (komut topic ACL'i; `/mqtt/acl`,
  `mosquitto-production.conf:43`); `tests/invariants/edge-command-publish-chokepoint.spec.ts`
  (yeni); `contracts/suderra-edge/v1/` (yeni).

**Dosyalar — Suderra-OS.**

- `overlay/usr/sbin/`: `suderra-data-unlock`, `suderra-edge-install` (Rust'a devredilir),
  `suderra-provision`, `suderra-provision-worker`, `suderra-lockdown`, `suderra-firewall`,
  `suderra-provision-mode` (yeni), `suderra-identity` (yeni).
- `overlay/etc/systemd/system/`: `suderra-agent.service` ve `suderra-agent.service.d/` (yeni),
  `suderra-provision-worker.{path,service}`, `suderra-activation.{path,service}` (yeni),
  `suderra-lifecycle.{path,service}` (yeni), `suderra-provision-mode.service` (yeni),
  `suderra-identity.service` (yeni), `nftables.service`,
  `systemd-networkd.service.d/10-require-firewall.conf` (yeni),
  `suderra-network-failsafe.target` (yeni), `suderra-firstboot.service`.
- `overlay/etc/nftables.conf`, `overlay/etc/nftables.provisioning.conf`,
  `overlay/etc/nftables.base.conf` (yeni) (`nftables.provisioning.conf`'ta varsayılan rota arayüzüne
  kapsama ve kaynak başına meter); `overlay/etc/systemd/journald.conf.d/10-suderra-volatile.conf`
  (yeni); `overlay/etc/systemd/network/10-ethernet.network`;
  `overlay/usr/lib/tmpfiles.d/suderra.conf` ve `overlay/usr/lib/suderra/data-layout.tmpfiles.conf`
  (yeni);
  `overlay/usr/lib/udev/rules.d/60-suderra-devices.rules` (yeni); `overlay/etc/default/dropbear`.
- `board/suderra/common/post-build.sh`; `configs/*_defconfig` (prod'da dropbear,
  `REMOUNT_ROOTFS_RW=n`, `SUDERRA_EDGE_AGENT` satırlarının kaldırılması);
  `configs/suderra_qemu_x86_64_defconfig` (`BR2_PACKAGE_SUDERRA_KEYS`,
  `BR2_PACKAGE_SUDERRA_OS_INSTALLER`, `BR2_PACKAGE_TPM2_TSS`, `BR2_PACKAGE_TPM2_TOOLS`,
  `BR2_PACKAGE_CRYPTSETUP`); `board/suderra/x86_64/linux-x86_64.config`;
  `board/suderra/x86_64/linux-qemu.config` (DEC-8.10'daki semboller);
  `board/suderra/x86_64/genimage-qemu.cfg` (`SUDERRA-DATA` ext4 bölümü).
- `userspace/suderra-installer/`: `Cargo.toml`, `src/cli.rs`, `src/contracts.rs`, `src/variant.rs`,
  `src/trust_anchors.rs`, `src/results.rs`, `src/cmd/edge.rs`, `src/cmd/site.rs`,
  `src/cmd/lifecycle.rs`, `src/cmd/health.rs`, `src/cmd/policy.rs` (yeniler);
  `userspace/suderra-ota/src/main.rs`.
- `package/suderra-keys/` (`suderra-keys.mk`, `Config.in`),
  `package/suderra-rauc-config/suderra-rauc-health-gate`,
  `package/suderra-rauc-config/suderra-rauc-mark-good.service`, `package/suderra-ota/`
  (mark-good unit'inin silinmesi), `package/suderra-edge-agent/` (silinir), `Config.in`;
  `scripts/gen-dev-keys.sh` ve `scripts/ci/prepare-ci-keyring.sh` (amaç başına anahtarlar, dev
  fleet-root'u, imzalı dev bundle'ı).
- `.github/workflows/image-build.yml` (`edge-e2e` job'u, `paths` filtresi);
  `tests/qemu/edge-provisioning-e2e.py`, `tests/qemu/fake_cloud.py`,
  `tests/qemu/edge-readonly-sandbox-test.py`, `tests/qemu/nft-ruleset-smoke-test.py` (yeniler);
  `tests/image-contracts/` (`edge-agent-unit-contract-test.sh`'in yeniden hedeflenmesi,
  `single-owner-chown-contract-test.sh`, `readonly-root-contract-test.sh`,
  `kernel-config-contract-test.sh`, `no-kiosk-contract-test.sh`,
  `contracts-vendor-digest-test.sh`); `tests/security/no-security-env-in-prod-test.sh` (yeni);
  `contracts/suderra-edge/` ve `contracts/suderra-edge.digest` (vendored).

### P1 — kartlar, zaman, watchdog, güncelleme kanalı

**Kapsam ve çıkış kriterleri.**

- RevPi (DEC-8): KUNBUS kernel'i, `revpi-connect4` DTB'si FIT'te, piControl paketi, `revpi-io`
  backend'i ve revpi profili. Çıkış: CI FIT DTB kapısı yeşil; ADR-0007 G4 HIL'de `config.rsc`
  yüklenir, bir DIO/AIO modülü listelenir, output watchdog çıkışları düşürür, TPM seal/unseal ve RTC
  hctosys çalışır, P0 e2e testinin donanım varyantı geçer.
- x86 (DEC-8, DEC-14) — P1b: USB installer imajı, SB sahiplik runbook'u, sürücü kümesi, imzalı PCR 7 + 11
  politikası ve recovery yolu. **Bu paket seti, operatör x86 modelini seçene kadar başlamaz** (Soru 1;
  model seçilmeden sürücü kümesi, qualification kaydı ve Microsoft UEFI CA kararı verilemez). Takip:
  EDGE-MEDIUM-142, sahip @Okan-wqm, son tarih 2026-12-31 (seçim bu tarihten sonra gelirse tarih
  seçimden 30 gün sonrasına çekilir ve bulgu güncellenir). Modelden bağımsız parçalar P1'de kalır:
  x86 çekirdeğinin sürüm ve kaynak-hash sabitlemesi (EI-028, EI-051), `/data` kurtarma slotu, TPM kaynak
  kaydı ve EI-078. P1b çıkışı: operatörün seçtiği modelde runbook uçtan uca uygulanmış, imzalı
  politikayla unseal bir A/B güncellemesinden sonra çalışır, PCR 7 değişikliği recovery yoluna düşer,
  chipsec kanıtı ve qualification contract testi yeşil. Bu çıkış SG-3'ü açar; P1b bitmeden SG-3 kapalıdır.
- Güven (DEC-3.9): üretim anahtar seremonisi (operatör eylemi, Soru 9) yapılmıştır. fleet-root ve
  edge-release anahtarları seremoni kökenli ve offline'dır; online anahtarlar (edge-provisioning,
  device-lifecycle, command, config-integrity, rbac-manifest) seremonide üretilmiş ve sensor-service
  secret'larına konmuştur (EDGE-HIGH-119, P2'de KMS). Hepsi kökenleriyle envantere girmiştir; donanım
  kartlarının prod defconfig'leri keyid allowlist'inden geçerek üretim imajı üretir ve SG-1 pilotları
  bu imajlarla başlar. İlk üretim agent release statement'ı offline imzalanmıştır. Trust-anchor
  bundle istek kanalıyla güncellenir.
- U-Boot hardening (DEC-18): redundant env, PARTUUID tabanlı boot yolları, `bootdelay=-1`, `/boot`
  yalnız kurulumda rw, usbguard, USB ingress.
- Zaman (DEC-7): NTS, zaman tabanı, time-state, saat senkron kapısı.
- systemd donanım watchdog sahipliği ve NOWAYOUT (DEC-6); health gate genişletmesi; ayrı RAUC
  compatible'ları; tek 6.12 kernel hattı.
- Güncelleme kanalı (DEC-2, DEC-4.12): istek kanalı, update worker (`edge-update`, `os-update`,
  `site-config`, `trust-anchors`), `update_seq`, bakım penceresi, OS güncelleme teslimi; DEC-13
  davranış tablosu ve devreye alma listesi; DEC-9 e-stop kapsamı/kalıcılığı, MQTT yazmalarında
  hedef ve register tipi, generic profil varsayılanları; DEC-11 UID başına egress ve kart profili
  arayüz rolleri; DEC-21 TPM kaydı; DEC-24 `/data` büyütme ve eMMC telemetrisi; DEC-27 MQTT yayını
  ve bulutta saklama; DEC-28 arch raporu.
- Genel çıkış: `edge-e2e` job'u agent güncellemesi + rollback ve `kind=site-config` senaryolarını
  geçer; `production-runtime-qemu.yml` koşusu `suderra_qemu_x86_64_prod_ab_defconfig` üzerinde P0
  zincirini ve ek olarak RAUC health gate'i, verity rootfs'i, LUKS2 + swtpm'i, read-only kökte
  EROFS'suz boot'u, reboot sonrası `verify-current`'ı ve güncelleme/rollback'i geçer (DEC-25).

**Dosyalar — Suderra-OS.** `board/suderra/aarch64-revpi-connect4/` (yeni; `config.txt`,
`genimage-prod.cfg`, `linux-revpi-suderra.config`, `revpi-connect4.its`),
`configs/suderra_aarch64_revpi4_defconfig`, `configs/suderra_aarch64_revpi4_prod_ab_defconfig`,
`board/suderra/buildroot-hashes/linux`,
`package/revpi-picontrol/{Config.in,revpi-picontrol.mk,revpi-picontrol.hash}` (yeni), `Config.in`,
`package/suderra-keys/` (üretim keyid'leri), `docs/security/key-management.md` ve
`docs/security/key-ceremony.md` (seremoni kaydı ve envanter),
`scripts/production-artifacts.sh` (FIT DTB kapısı; x86 UKI'ye imzalı PCR 11 politikası),
`package/suderra-rauc-config/{system.conf,system.conf.arm,boot.mount,boot.mount.arm,fw_env.config,suderra-rauc-health-gate}`,
`ci/evidence-contract.yml`,
`board/suderra/aarch64-rpi4/{uboot-fragment.config,boot.scr.cmd,linux-rpi4.config}`,
`board/suderra/x86_64/linux-x86_64.config`, `configs/suderra_x86_64_usb_installer_defconfig` (yeni),
`overlay/usr/sbin/suderra-data-unlock` (`--tpm2-public-key`, recovery slotu),
`overlay/etc/chrony.conf` (yeni), `overlay/etc/systemd/system.conf.d/10-suderra-watchdog.conf`
(yeni),
`overlay/etc/systemd/system/{suderra-chrony-wait.service,suderra-timefloor.service,suderra-timefloor.timer,suderra-edge-request.path,suderra-edge-request.service,suderra-usb-ingress@.service}`
(yeni), `overlay/etc/usbguard/rules.conf` (yeni), `overlay/etc/systemd/network/{10-wan.network,20-ot.network}`
(yeni), `overlay/usr/lib/repart.d/50-data.conf` (yeni), `userspace/suderra-installer/src/cmd/edge.rs`,
`userspace/suderra-installer/src/cmd/ingress.rs` (yeni), `userspace/suderra-ota/src/main.rs`,
`.github/workflows/production-runtime-qemu.yml`, `tests/qemu/production-runtime-scenario.py`,
`docs/security/field-appliance-hardening.md`, `docs/security/tpm-resource-registry.md` (yeni),
`docs/operations/commissioning-checklist.md` (yeni),
`tests/image-contracts/x86-hardware-station-contract-test.sh`,
`tests/image-contracts/tpm-registry-contract-test.sh` (yeni).

**Dosyalar — aquaculture_platform.** `sens-api-gateway/src/picontrol.rs` (yeni),
`src/hardware_scanner.rs`, `src/config.rs` (saat otoritesi, generic varsayılanlar),
`src/command_envelope/envelope.rs`, `src/commands/envelope_adapter.rs`, `src/commands/write.rs`,
`src/scada_server.rs` (e-stop), `src/safe_state.rs`, `src/telemetry.rs`,
`sens-api-gateway/Cargo.toml` (`revpi-io`); `sens-api-gateway/tests/hil/output_behaviour_table.rs`
(yeni); `apps/sensor-service/src/edge-device/edge-update-manifest.service.ts` (yeni),
`site-config-manifest.service.ts` (config push), `edge-result-telemetry.service.ts` (yeni),
`recovery-key-escrow.service.ts` (yeni); `apps/sensor-service/src/release-bundle/release-bundle.service.ts`;
`.github/workflows/edge-agent-release.yml` (revpi matrisi; üretim release statement'ının imzasız
payload'ı ve offline imza adımı, DEC-20).

### P2 — komut yolu sertleştirmesi, güven çapaları, KMS

**Kapsam.** Agent komut yolu (DEC-9): generic profilden de Disabled/Permissive ve legacy imzasız
yolun kaldırılması (HC-1 göçüyle, DEC-28), `suderra-os`'te v3'ün kaldırılması ve envelope v4, SCADA
yürütücüsünde authz ve tag başına cihaz yönlendirmesi, replay pencereleri, SSRF, OPC UA
client/server, PLC envanteri, operatör anahtarları ve TPI co-signing; trust-anchor bundle'ında
`update-approver`, `program` ve `license` çapaları; `edge-update.v2` ve cihazda `approvals[]`
(DEC-2); DEC-13 çıkış başına politika ve yerel uygulama katmanı; DEC-11 imzalı site OT allowlist'i
ve tipli renderer, HMI/OPC UA inbound; DEC-26 HMI TLS ve kimlik doğrulama. DEC-15 runbook'ları;
KMS/OIDC imzalama ve online anahtarların KMS'e taşınması (EDGE-HIGH-119), reproducible build,
provenance admission (DEC-3, DEC-20, DEC-22); özel cihaz PKI'si ve mosquitto TLS sonlandırması
(DEC-10); verity release imaj formatı ve kernel'in zorladığı root hash imzası, `edge-image` anahtarı
(DEC-1.6, EDGE-MEDIUM-116); TPM keystore, TPM ile mühürlü DB anahtarı (DEC-4.8), owner/lockout auth
ve agent'a `/dev/tpmrm0` (DEC-21); generic profilde DEC-28'deki bulgu karşılıkları.

**Çıkış kriteri.** Cihaz başka bir cihaz için imzalanmış komutu reddeder (e2e); HMI kimlik
doğrulama ve yetkilendirme testleri geçer (e2e + HIL; EDGE-HIGH-069, EDGE-HIGH-070): kimliği
doğrulanmamış bir LAN istemcisi tag yazamaz, e-stop tetikleyemez veya sıfırlayamaz; kimliği
doğrulanmış HMI yazmaları yetkilendirmeden, force registry'den ve tag başına cihaz yönlendirmesinden
geçer ve HMI Modbus yazması tag'in cihazına gider; çıkış başına politika HIL'de `must-stay-on`
çıkışını restart, güncelleme ve e-stop boyunca korur; operatör anahtarlı bir TPI komutu iki onayla
kabul, tek onayla red edilir; hiçbir online imzalama anahtarı KMS dışında değildir (fleet-root
offline HSM'de kalır); MQTT yolunda kamu CA güveni yoktur; agent verity imajdan çalışır ve
değiştirilmiş bir root hash imzasıyla imaj map edilmez; bir epoch-ilerletme tatbikatı QEMU'da
geçmiştir. Bu çıkış SG-1'i açar.

**Dosyalar — aquaculture_platform.**
`sens-api-gateway/src/{command_envelope/,commands/,main.rs,scada_server.rs,mqtt.rs,mtls/,trust_anchors.rs,config.rs,output_policy.rs,keystore/}`,
`apps/sensor-service/src/edge-device/{command-envelope-signer.service.ts,edge-command-publisher.service.ts,manifest-signer.ts,edge-update-manifest.service.ts,site-config-manifest.service.ts,trust-anchor-bundle.service.ts}`,
`apps/sensor-service/src/edge-device/operator-key.service.ts` (yeni; operatör anahtarları ve TPI
onayları), `apps/sensor-service/src/release-bundle/release-admission.service.ts` (yeni),
`infrastructure/mosquitto/mosquitto-production.conf` (cihaz 8883 listener'ı, `require_certificate`),
`infrastructure/nginx/droplet.conf`, `docker-compose.droplet.yml`,
`.github/workflows/edge-agent-release.yml`, `docs/adr/021-platform-key-ceremony-lifecycle.md`,
`docs/runbooks/edge-key-compromise.md` (yeni).

**Dosyalar — Suderra-OS.** `userspace/suderra-installer/src/contracts.rs` (`edge-update.v2`, epoch
ilerletme, site netpolicy, verity imaj), `userspace/suderra-installer/src/cmd/policy.rs`,
`package/suderra-keys/` (fleet-root epoch'ları, KMS epoch'ları),
`board/suderra/aarch64-rpi4/linux-rpi4.config` ve
`board/suderra/aarch64-revpi-connect4/linux-revpi-suderra.config` (`CONFIG_BLK_DEV_LOOP`,
`CONFIG_DM_VERITY_VERIFY_ROOTHASH_SIG`), `board/suderra/x86_64/linux-x86_64.config`
(`CONFIG_DM_VERITY_VERIFY_ROOTHASH_SIG`), `tests/image-contracts/kernel-config-contract-test.sh`
(aynı semboller), `overlay/etc/systemd/system/suderra-agent.service.d/10-board-<profile>.conf`
(`/dev/tpmrm0`, DEC-21), `overlay/usr/sbin/suderra-identity` (rastgele owner/lockout auth,
DEC-21),
`tests/qemu/key-epoch-advance-drill.py` (yeni), `docs/security/key-management.md`,
`docs/security/key-ceremony.md`, `docs/operations/key-compromise-response.md` (yeni).

### P3 — measured boot, yaşam döngüsü, kimlik

**Kapsam.** DEC-14 RevPi OTP secure boot (Soru 7), U-Boot measured boot ve attestation; DEC-12 tam
yaşam döngüsü ve TPM NV aynası; DEC-16 break-glass; DEC-17 RMA/decommission; DEC-10 CSR ile cihaz
mTLS sertifikaları, TPM anahtarı ve aktivasyon PoP'u (EDGE-MEDIUM-126); DEC-5 claim-code
eşleştirmesi ve PoP; DEC-2 platform firmware bakım hook'ları ve hava boşluklu USB güncelleme
ingress'i.

**Çıkış kriteri.** RevPi'de OTP secure boot ve measured boot ADR-0007 G4/G5 kanıtıyla; bulut
attestation olmadan manifest vermez; `/data` silinmiş TPM'li cihaz provisioning'e dönmez; RMA ve
decommission akışları e2e'de geçer; claim-code varsayılandır; aktivasyon cihaz anahtarına sahiplik
kanıtı olmadan kimlik bilgisi vermez (e2e). Bu çıkış, kart başına kanıtla birlikte
SG-2'yi açar.

**Dosyalar — Suderra-OS.** `overlay/usr/sbin/suderra-data-unlock`,
`board/suderra/aarch64-rpi4/uboot-fragment.config`,
`board/suderra/aarch64-revpi-connect4/uboot-fragment.config` (yeni), `userspace/suderra-attestation/`,
`userspace/suderra-factory-reset/`, `userspace/suderra-installer/src/cmd/lifecycle.rs`,
`overlay/etc/systemd/system/{suderra-maintenance.service,suderra-factory-reset.service}` (yeni),
`overlay/usr/sbin/suderra-maintenance-shell` (yeni), `docs/security/threat-model.md`,
`docs/operations/factory-reset.md`.

**Dosyalar — aquaculture_platform.** `sens-api-gateway/src/keystore/`, `src/mqtt.rs`, `src/main.rs`;
`apps/sensor-service/src/edge-device/{device-certificate.service.ts,device-certificate.controller.ts,attestation.service.ts,break-glass.service.ts,break-glass.controller.ts}`
(yeni), `apps/sensor-service/src/edge-device/edge-device.resolver.ts` (RMA ve decommission),
`docs/runbooks/edge-device-rma-decommission.md` (yeni),
`infrastructure/mosquitto/mosquitto-production.conf` (`use_identity_as_username`),
`apps/sensor-service/src/edge-device/mqtt-auth.service.ts` (CONNECT ve ACL'de yaşam döngüsü
kontrolü).

### Bu ADR ile birlikte yapılacak doküman değişiklikleri (P0 kapsamı)

- `docs/adr/019-edge-firmware-signing-ab-partition.md` başlığına supersession notu (§3–§5; §2/§6'nın
  güven çapası kısımları; §8 — Suderra OS profili için).
- Suderra-OS ADR-0004, ADR-0005, ADR-0007'ye ADR-0008'deki değişiklik notları.

## Açık sorular (operatör)

Yalnız iş, tedarik ve donanım seçimleri. Teknik varsayılanlar yukarıda kararlaştırılmıştır; her
soruda Claude'un önerisi verilir.

1. **x86 modeli.** Seçim ölçütleri: ayrık TPM 2.0 (dTPM; en az Intel PTT, AMD fTPM değil); Intel
   I210/I225/I226 NIC'leri (upstream igb/igc); yerleşik RS485/RS232 (8250 veya Exar, RS485
   desteğiyle); upstream sürücüsü olan, belgelenmiş super-IO/EC watchdog'u; BIOS'ta Secure Boot
   anahtar yönetimi (Setup Mode, özel PK/KEK/db, BIOS güncellemelerinde anahtarların korunması),
   Intel Boot Guard etkin ve setup parolası; option ROM'lar için zorunlu Microsoft CA bağımlılığı
   olmaması (yerleşik iGPU GOP); vPro'suz SKU veya kapatılabilir AMT; uzun dönem bulunabilirlik ve
   BIOS güncelleme kanalı; fansız, DIN-ray montajlı, 24 V besleme. SG-3 bu seçime ve P1 çıkışına
   bağlıdır.
2. **Microsoft UEFI CA.** Seçilen modelde db'de tutulacak mı? Tutulursa disk anahtarı mühürü PCR 7 +
   11 imzalı politikadır (P1) ve 2026 CA rotasyonu planı gerekir. Öneri: iGPU GOP'lu ve option ROM
   gerektirmeyen bir model seçip CA'yı db'den çıkarmak.
3. **RPi4/CM4.** Bu kartları kullanan sahalar SL2 iddiası olmadan çalışmayı mı kabul ediyor, yoksa
   add-on TPM (ve OTP secure boot) zorunlu mu? Bugün prod `/data` TPM'siz açılmaz. TPM'siz kartta
   device binding için müşteri OTP değerinin yazılması (DEC-3.6) geri dönüşsüzdür. Öneri: üretimde
   yalnız add-on SLB9670'li CM4; TPM'siz RPi4 yalnız geliştirme ve test amaçlı. Karar
   EDGE-MEDIUM-120'yi kapatır (son tarih 2026-11-30).
4. **KUNBUS kernel backport'ları.** Aylık rebase ve CVE backport'larının sahibi kim (iç ekip, KUNBUS
   destek sözleşmesi)? Öneri: Suderra, RevolutionPi kernel dalının (`revpi-6.12`) pinli bir
   fork'unun sahibidir (sahip @Okan-wqm). Fork her ay upstream KUNBUS dalı ve 6.12.y stable ile
   senkronlanır; CVE tetikli acil bir bump yolu ayrıca vardır. Her bump'ta kernel hardening contract
   testleri (`tests/image-contracts/kernel-config-contract-test.sh`, ADR-0007 G4 kontrolleri)
   yeniden koşar; KUNBUS destek sözleşmesi bu sahipliği tamamlar, yerini almaz.
5. **Bulut KMS sağlayıcısı.** edge-release, edge-provisioning, config-integrity, rbac-manifest,
   device-lifecycle, command, `edge-image` ve cihaz CA intermediate'i için hangi KMS (OIDC workload
   identity desteğiyle)? Öneri: yerel Ed25519 imzalama sunan bir yönetilen KMS veya HashiCorp Vault
   Transit (`ed25519` anahtar tipi); anahtar kullanımı OIDC ile tek bir signer workload kimliğine
   bağlanır. Operatör sağlayıcıyı, yerel Ed25519 desteğini doğruladıktan sonra seçer. EDGE-HIGH-119
   bu seçimle P2'de kapanır.
6. **RevPi eMMC asgari boyutu (SKU/BOM).** 8 GB varyantta KUNBUS kernel'i, modüller, iki release ve
   offline queue sığmayabilir (`/data` bugün 2G). Öneri: üretim için asgari 32 GB eMMC.
7. **RevPi OTP secure boot fuse'u.** Fuse geri dönüşsüzdür ve rpiboot kurtarmasını imzalı imaja
   bağlar. Öneri: P3'te, KUNBUS'un yazılı destek görüşü alındıktan sonra ve önce bir pilot partide
   fuse etmek; fuse edilmemiş RevPi SL2 iddia etmez (SG-2).
8. **Müşteri tarafı fail-safe kablolama yükümlülüğü.** Yaşam desteği çıkışları (havalandırma,
   oksijen) için bağımsız donanımsal kilitleme ve fail-safe kablolama (DEC-13.1) müşteriye
   sözleşmesel bir yükümlülük olarak mı bağlanacak? Öneri: evet; kanıt devreye alma kontrol
   listesinde (`Suderra-OS/docs/operations/commissioning-checklist.md`) imzalı olarak tutulur ve SG-1
   sonrası aktüasyonlu her saha için ön koşuldur.
9. **Üretim anahtar seremonisi (P1).** Tarih, emanetçiler, HSM ve saklama yeri. Öneri: P1
   içinde offline HSM'de, 2-of-3 emanetçi yetersayısıyla ve iki ayrı fiziksel konumda saklanan
   yedekle. Seremoni fleet-root ve edge-release anahtarlarını offline üretir ve online amaçların
   üretim anahtarlarını da üretip sensor-service secret'larına teslim eder; seremoni yapılmadan
   üretim imajı build edilemez (DEC-3.7, DEC-3.9).
