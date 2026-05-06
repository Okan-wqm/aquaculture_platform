# sens-api-gateway E2E Audit ve Gap Backlog

Tarih: 2026-04-29
Kapsam: `/sens-api-gateway` Rust edge gateway kodu, komut yolu, MQTT/envelope, RBAC, audit, offline queue, OPC UA, Modbus/I/O, config/keystore, performans ve dokuman-kod uyumu.

## Durum Etiketleri

| Etiket | Anlam |
| --- | --- |
| DONE | Kod yolu var ve temel davranis calisiyor. Yine de test/operasyonel risk olabilir. |
| OPEN | Kod yolu yok, eksik, ya da enterprise fail-closed davranis henuz tamamlanmamis. |
| NOT_DONE | Kod yolu stub/no-op veya kullaniciya vaat edilen davranis yok. |
| BLIND_SPOT | Tasarimda veya testte gorunmeyen risk alani var; dogrulama yapilmadan "tamam" denemez. |
| DOC_CODE_MISMATCH | Dokuman/yorum ile mevcut kod davranisi uyusmuyor. |

## Ozet

`sens-api-gateway` cok genis bir edge runtime'a evrilmis: MQTT, offline queue, SQLCipher, RBAC manifest, komut envelope, audit chain, OPC UA, Modbus ve I/O polling ayni binary icinde toplanmis. 2026-04-29 implementasyonu ile komut dispatch RBAC gate'i, legacy/envelope fail-closed ayrimi, checked publish contract'i, offline queue shutdown checkpoint'i, release security config kapilari ve I/O lock kapsami kod tarafinda kapatildi.

En kritik kalan dort risk:

1. OPC UA X.509 session-establish henuz gercek sertifika dogrulamaya bagli degil.
2. OPC UA read visibility/datatype fidelity alanlari henuz tam guvenlik kontratina ulasmadi.
3. Analog write conversion policy (`reverse_scale(..) as u16`) halen ayri takip gerektiriyor.
4. Gateway warning debt'i tam `-D warnings` / `clippy -D warnings` kapisini bu remediation icinde acmayi engelliyor.

## Sistem Durum Matrisi

| Alan | Durum | Karar |
| --- | --- | --- |
| MQTT komut parse + retained reject | DONE | Retained komut reddi var; envelope parse var. |
| Envelope signature modes | FIXED-IN-CODE 2026-04-29 | Signature-enforced modlarda unsigned mutating legacy fallback dispatch oncesi reddediliyor. |
| RBAC permission mapping | FIXED-IN-CODE 2026-04-29 | Permission hesaplama artik dispatch oncesi `InMemoryPolicyEngine::authorize` gate'ine bagli. |
| Two-person integrity | FIXED-IN-CODE 2026-04-29 | Adapter ikinci imzayi dogruluyor; policy engine ikinci aktoru distinct/enrolled/authorized olarak kontrol ediyor. |
| Audit sink | FIXED-IN-CODE 2026-04-29 | Release build'de Disabled mod fail-closed; OPC UA write path'i audit intent before mutation + outcome failure reporting kullaniyor; command post-audit artik AuthorizedContext actor/policy/TPI bilgisini tasiyor. |
| Offline queue drain | FIXED-IN-CODE 2026-04-29 | Drain task stop/await + OfflineQueue WAL checkpoint/fsync shutdown sirasina eklendi. |
| Modbus write routing | FIXED-IN-CODE 2026-04-29 | Device-name lookup, explicit all-range acceptance ve readback receipt eklendi. |
| MQTT `write_opcua` ve `write_s7` | FIXED-IN-CODE 2026-04-29 | Komut fonksiyonlari config inventory `connection_id` ile typed PLC client write + readback verify yapiyor; payload endpoint/secret override reddediliyor. |
| OPC UA anonymous reject | DONE | Anonymous session reddediliyor. |
| OPC UA X.509 auth | NOT_DONE | X.509 session-establish su an reddediliyor. |
| OPC UA read authz/filtering | OPEN | Her authenticated user ayni namespace'i goruyor; read authz-gated degil. |
| Config integrity | FIXED-IN-CODE 2026-04-29 | Release build'de Enforcing zorunlu. |
| Keystore | FIXED-IN-CODE 2026-04-29 | Release build'de explicit FileBacked zorunlu; Auto fallback production-compatible degil. |
| I/O polling performansi | FIXED-IN-CODE 2026-04-29 | Fieldbus await'leri AppState read guard disina alindi. |
| Dokuman seti | FIXED-IN-DOCS 2026-04-29 | Current gateway gap ledger eklendi ve feature matrix/runtime status guncellendi. |

## Bulgular

### F-001 - Critical - Komut dispatch oncesi genel RBAC gate eksik

Durum: FIXED-IN-CODE 2026-04-29

Kanıt:
- `sens-api-gateway/src/commands/envelope_adapter.rs` artik verified actor, signed policy version ve co-approver evidence'i adapter output'unda koruyor.
- `sens-api-gateway/src/mqtt.rs` `CommandMessage` icine verified actor, claimed policy version ve co-approver evidence alanlari eklendi.
- `sens-api-gateway/src/commands/dispatch_lifecycle.rs` artik handler table'a girmeden once `InMemoryPolicyEngine::authorize` cagiriyor.
- `sens-api-gateway/src/commands/required_permission.rs` permission mapping SSoT olarak kullanilmaya devam ediyor.

Risk:
Permission haritasi var gibi gorundugu icin sistem guvenli sanilabilir; fakat legacy veya envelope disi yollarda komut, actor/policy yetkilendirmesi tamamlanmadan calisabilir. Bu, `write_modbus`, `update_policy`, `rotate_master`, `safe_state`, deploy ve firmware update gibi mutating komutlarda kritik.

Uygulanan fix:
- Dispatch oncesi zorunlu RBAC authorize gate eklendi.
- Actor kimligi envelope adapter'dan dispatch'e tasindi.
- Legacy mutating komutlar `signature_mode != Disabled` iken reddediliyor.
- Deny ve engine-error path'leri audit post event uretiyor.

### F-002 - Critical - Legacy MQTT fallback imza ve actor kimligi zorunlulugunu zayiflatiyor

Durum: FIXED-IN-CODE 2026-04-29 for mutating commands in signature-enforced modes

Kanıt:
- `sens-api-gateway/src/commands/mqtt_dispatch.rs:139-147` envelope format degilse legacy `CommandMessage` parse'a dusuyor.
- `sens-api-gateway/src/commands/mqtt_dispatch.rs:178` tenant bilgisi yoksa legacy parse unconditional devam ediyor.
- `sens-api-gateway/src/commands/mqtt_dispatch.rs` artik legacy mutating payload'i signature-enforced modlarda dispatch oncesi reddediyor.
- `sens-api-gateway/src/commands/mqtt_dispatch.rs` malformed timestamp'i reddediyor.
- `sens-api-gateway/src/commands/mqtt_dispatch.rs` invalid JTI'yi signature-enforced modlarda reddediyor.
- `sens-api-gateway/src/commands/envelope_adapter.rs:113-119` parse failure'i `NotEnvelopeFormat` olarak donuyor; caller legacy fallback yapiyor.

Risk:
Envelope enforcing oldugu dusunulen bir ortamda legacy payload, malformed timestamp veya invalid command id ile beklenenden daha gevsek bir yoldan calisabilir. Replay ve freshness guvencesi canonical JTI ve parse edilen timestamp'e bagli oldugu icin attacker surface genisliyor.

Uygulanan fix:
- `signature_mode=Permissive` ve `Enforcing` icin envelope olmayan permissioned komutlar fail-closed reddediliyor.
- Timestamp parse basarisizsa komut reddediliyor.
- Signed/enforcing/permissive modlarda invalid JTI reddediliyor; VecDeque fallback sadece `Disabled` modunda kaliyor.

### F-003 - High - Offline queue shutdown flush/checkpoint no-op

Durum: FIXED-IN-CODE 2026-04-29

Kanıt:
- `sens-api-gateway/src/outbound_publisher.rs:253-424` `DrainTask` var ve reconnect drain mantigi mevcut.
- `sens-api-gateway/src/main.rs:1758-1802` drain task init ve shutdown sender saklama var.
- `sens-api-gateway/src/main.rs` graceful shutdown artik drain task stop/await ve `AsyncOfflineQueue::checkpoint_and_fsync_async` cagiriyor.
- `sens-api-gateway/src/offline_queue.rs` `checkpoint_and_fsync` ile `PRAGMA wal_checkpoint(FULL)` ve DB/WAL/SHM/parent fsync yapiyor.
- `sens-api-gateway/docs/architecture/data-flow.md:93-118` shutdown'da `PRAGMA wal_checkpoint(FULL) + fsync` yapildigini iddia ediyor.
- `sens-api-gateway/docs/product/feature-matrix.md:21-22` ise offline flush on shutdown icin ROADMAP/no-op diyor.

Uygulanan fix:
- OfflineQueue file-backed path'i sakliyor.
- Shutdown sirasinda outbound drain task'a stop sinyali gonderiliyor ve handle bekleniyor.
- WAL checkpoint + fsync gercek API olarak eklendi.

### F-004 - High - Publish helper'lar delivery hatasini caller'a dondurmuyor

Durum: FIXED-IN-CODE 2026-04-29

Kanıt:
- `sens-api-gateway/src/publish_helpers.rs:16-25` failure'larin warn-log yapilip propagate edilmedigini soyluyor.
- `sens-api-gateway/src/publish_helpers.rs:45-52` helper'larin `Result` dondurmedigi acikca belirtilmis.
- `sens-api-gateway/src/publish_helpers.rs` artik `PublishRouteError` ve tum topic class'lari icin checked helper sagliyor.
- `sens-api-gateway/src/commands/mqtt_dispatch.rs` merkezi command response publish path'inde checked helper kullaniyor.
- `sens-api-gateway/src/commands/firmware.rs`, `sens-api-gateway/src/io_poll.rs`, `sens-api-gateway/src/telemetry.rs`, `sens-api-gateway/src/lora/mod.rs`, `sens-api-gateway/src/scripting/task_stats_publisher.rs` ve boot Online status path'i checked helper kullaniyor veya checked failure'i command/domain context ile logluyor.
- `sens-api-gateway/src/outbound_publisher.rs:145-162` queue failure, transport failure ve UTF-8 payload failure gibi ayrilmis hata tipleri aslinda mevcut.

Risk:
Life-safety, command response, audit-like telemetry veya status publish yollari "log-only" kalabilir. Caller, response'un gonderilemedigini veya queue'ya yazilamadigini bilemez.

Uygulanan fix:
- Tum publish helper siniflari icin checked variant eklendi.
- Kritik/operasyonel callsite'lar checked helper'a gecirildi.
- Outbound/legacy/serialize/no-client hatalari command id veya domain context ile gorunur hale getirildi.

### F-005 - High - Audit zinciri configurable; OPC UA audit append failure write'i durdurmuyor

Durum: FIXED-IN-CODE 2026-04-29

Kanıt:
- `sens-api-gateway/src/config.rs` release build icin `audit.mode=Disabled` config validation fail-closed yapildi.
- `sens-api-gateway/src/main.rs:1879-1903` debug/rollout modunda `audit.mode=Disabled` icin init skip ediliyor ve `audit_sink` None kalabiliyor.
- `sens-api-gateway/src/main.rs:3428-3434` Enabled init failure boot'u durduruyor.
- `sens-api-gateway/src/opc_ua_server.rs` OPC UA write path'i audit intent'i mutasyondan once yazar ve audit sink failure durumunda write'i reddeder.
- `sens-api-gateway/src/commands/audit_emit.rs` ve `sens-api-gateway/src/commands/dispatch_lifecycle.rs` command post-audit kayitlarinda actor label, policy version, TPI sonucu ve resource bilgisini `AuthorizedContext`'ten projekte eder.

Risk:
Regule veya forensic beklentisi olan deployment'ta mutating write basarili olabilir ama audit entry kalmayabilir. Audit Disabled mod da uretimde yanlis config ile kritik bosluk yaratir.

Uygulanan fix:
- Release build'de audit Disabled yasaklandi.
- OPC UA write icin audit intent/outcome failure'i caller-visible hale getirildi.
- MQTT command lifecycle post-audit kaydi artik placeholder actor/policy/resource yerine verified authz context'i kullaniyor.

### F-006 - High - MQTT TLS/mTLS fail-closed default degil

Durum: FIXED-IN-CODE 2026-04-29 for release-build plaintext MQTT

Kanıt:
- `sens-api-gateway/src/config.rs` release build'de MQTT TLS disabled ise config validation fail-closed yapildi.
- `sens-api-gateway/src/config.rs:3385-3387` mTLS icin cert/key pair validation var.
- `sens-api-gateway/docs/product/feature-matrix.md:41-43` MQTT mTLS roadmap olarak isaretlenmis.

Risk:
Edge control plane'de username/password ve optional TLS/mTLS kombinasyonu, yanlis config ile uretime cikabilir. Config validation uyari uretse de deployment'i durdurmaz.

Uygulanan fix:
- Production/release profile'da TLS off fail-closed oldu.
- Plaintext sadece debug/local build davranisi olarak kaldi.

### F-007 - Medium - Config integrity enforcing disinda uretim riski tasiyor

Durum: FIXED-IN-CODE 2026-04-29

Kanıt:
- `sens-api-gateway/src/main.rs:3029-3053` boot-time config integrity check calisiyor.
- `sens-api-gateway/src/config_integrity/verify_runtime.rs:178` Disabled modda check atlanıyor.
- `sens-api-gateway/src/config_integrity/verify_runtime.rs:212-214` Permissive failure'da boot devam ediyor.
- `sens-api-gateway/src/config_integrity/verify_runtime.rs:207-209` highest-seen version persist best-effort.
- `sens-api-gateway/src/config.rs` release build icin `config_integrity.mode=enforcing` zorunlu hale getirildi.

Risk:
Rollback/tamper korumasi deployment policy'sine kalmis. Permissive mod rollout icin mantikli olabilir, fakat uretimde kalirsa config downgrade veya imza hatasi log-only kalir.

Uygulanan fix:
- Production/release build config-integrity Enforcing olmadan boot etmiyor.
- Disabled/Permissive modlar debug/rollout davranisi olarak kaldi.

### F-008 - Medium - JTI dedup reboot-safe olmayabilir ve invalid JTI fallback var

Durum: FIXED-IN-CODE 2026-04-29

Kanıt:
- `sens-api-gateway/src/main.rs:1543-1545` signature mode Disabled ise JTI dedup table yok.
- `sens-api-gateway/src/main.rs:1587-1596` SQLCipher persist tier acilamazsa Moka-only fallback'e dusuluyor.
- `sens-api-gateway/src/main.rs:1602` Moka-only default olarak destekleniyor.
- `sens-api-gateway/src/commands/mqtt_dispatch.rs` invalid JTI'yi signature-enforced modlarda reddediyor.

Risk:
Reboot sonrasi replay savunmasi operator config ve SQLCipher sagligina bagli. Invalid id fallback'i canonical JTI disiplinini zayiflatiyor.

Uygulanan fix:
- Enforcing/Permissive signed command yolunda invalid JTI reject edildi.
- Release build'de `signature_mode=enforcing` zorunlu hale getirildi.

### F-009 - Medium - Keystore Auto henuz TPM/systemd-creds degil

Durum: FIXED-IN-CODE 2026-04-29

Kanıt:
- `sens-api-gateway/src/config.rs` release build'de `keystore.mode=FileBacked` disindaki modlari reddediyor.
- `sens-api-gateway/src/main.rs:1999-2006` Auto'nun TPM, sonra systemd-creds, sonra FileBacked sececegi yaziyor; pre-TPM landing Auto debug/rollout davranisi olarak kaliyor.
- `sens-api-gateway/src/main.rs:2051-2059` runtime log'u da TPM/systemd-creds probe'larin ileride gelecegini soyluyor.
- `docs/runbooks/edge-keystore-operations.md:17-22` FileBacked landed, TPM ve systemd-creds pending diyor.

Uygulanan fix:
- Production/release build'de Auto fallback production-compatible degil.
- FileBacked backend explicit secim ve acceptance token disiplini ile kaldi.

### F-010 - Medium - OPC UA path gerceklesmis ama halen yetki ve tip kor noktalari var

Durum: OPEN / NOT_DONE

Kanıt:
- `sens-api-gateway/src/opc_ua_sens_auth_manager.rs:206-217` anonymous session reddediliyor.
- `sens-api-gateway/src/opc_ua_sens_auth_manager.rs:357-371` X.509 auth path su an `BadIdentityTokenRejected` donuyor.
- `sens-api-gateway/src/opc_ua_sens_node_manager.rs:395-405` her authenticated user ayni namespace'i goruyor.
- `sens-api-gateway/src/opc_ua_sens_node_manager.rs:509-513` read authz-gated degil.
- `sens-api-gateway/src/opc_ua_sens_node_manager.rs:610-615` read path her degeri `Variant::Double` olarak donduruyor.
- `sens-api-gateway/src/opc_ua_sens_node_manager.rs:729-756` write path anonymous/missing session'i reddediyor ve typed authz yoluna gidiyor.

Risk:
OPC UA write tarafinda ilerleme var; ama X.509 operator cert, per-user namespace/read filtering ve datatype fidelity tamamlanmadan "tam OPC UA security" denemez.

Gereken fix:
- X.509 session establish gercek cert validation'a baglanmali.
- Namespace/read visibility policy ile filtrelenmeli.
- Tag datatype metadata'si OPC UA Variant tiplerine kayipsiz map edilmeli.

### F-011 - Medium - Modbus write readback ve PLC write stublari

Durum: FIXED-IN-CODE 2026-04-29

Kanıt:
- `sens-api-gateway/src/modbus.rs:269-274` write_register device-name lookup ile dogru client'a gidiyor.
- `sens-api-gateway/src/modbus.rs` artik `ModbusWriteReceipt` ile protocol ACK ve readback verification alanlarini ayiriyor.
- `sens-api-gateway/src/config.rs` artik `allow_all_write_addresses`, `verify_write_readback`, retry ve settle ayarlarini tasiyor.
- `sens-api-gateway/src/config.rs` validation `allow_writes=true` + bos range + explicit all-address acceptance yoksa fail-closed davraniyor.
- `sens-api-gateway/src/commands/write.rs` artik `write_opcua` ve `write_s7` icin gercek PLC client write + readback path'i kullaniyor.
- `sens-api-gateway/src/authz/permission.rs` S7 write icin ayri `S7Write` permission ekliyor; `SafeStateTrigger` artik S7 setpoint write icin surrogate degil.

Risk:
Kod tarafi kapatildi; dogrulama Rust toolchain olmadigi icin bu oturumda compile/test ile tamamlanamadi.

Uygulanan fix:
- Modbus register write path'i write sonrasi holding-register readback yapacak sekilde genisletildi.
- Command response artik `protocol_ack`, `readback_enabled`, `readback_verified`, `readback_value` kanitlarini tasiyor.
- OPC UA/S7 command stublari kaldirildi; typed payload parse, PLC write, readback compare ve disconnect cleanup eklendi.

### F-012 - Medium - I/O polling AppState read lock'i await'ler boyunca tutuluyor

Durum: FIXED-IN-CODE 2026-04-29

Kanıt:
- `sens-api-gateway/src/io_poll.rs` artik process image, force registry, bus handle'lari, alarm manager ve health state'i lock altinda snapshot'liyor.
- GPIO/Modbus/I2C await'leri AppState read guard disinda calisiyor.
- `sens-api-gateway/src/io_poll.rs:84` missed tick skip iyi; fakat lock kapsam problemi ayrica duruyor.

Uygulanan fix:
- Poll cycle basinda gerekli handle/config snapshot'lari clone'lanip lock birakiliyor.
- Fieldbus await'leri AppState guard disinda calisiyor.
- Kalan dogrulama: slow Modbus/I2C mock ile reload latency testi eklenmeli.

### F-013 - Medium - Dokuman ve yorumlar mevcut kodla yer yer uyumsuz

Durum: FIXED-IN-DOCS 2026-04-29

Kanıt:
- `sens-api-gateway/docs/architecture/data-flow.md:93-118` shutdown checkpoint davranisi yeniden dogrulanmali; kod tarafi 2026-04-29'da checkpoint/fsync'e cekildi.
- `sens-api-gateway/docs/product/feature-matrix.md:121` Modbus write routing bug'i artik FIXED-IN-CODE olarak gosteriliyor.
- `sens-api-gateway/docs/reviews/orphan-findings.md` current gateway ledger olarak eklendi.
- `sens-api-gateway/src/opc_ua_server.rs:551-642` ve `sens-api-gateway/src/opc_ua_sens_node_manager.rs` yorumlari bazi yerlerde "prep/stub" dili ile gercek write path arasinda eski kalmis.

Risk:
Planlama yanlis yere odaklanabilir: kapanmis bug tekrar acik sanilir, acik bug ise kapali sanilir. Regule musteri ve RFP dokumanlari icin bu ciddi guven problemi yaratir.

Uygulanan fix:
- Current gap ledger olusturuldu.
- Feature matrix Modbus runtime status'u guncellendi.
- Bug audit dokumaninda sensor-service OPC UA audit riski ayri servis bulgusu olarak nedenleriyle kayda alindi.

### F-014 - Medium - Gateway warning debt tam warnings-as-errors kapisini engelliyor

Durum: OPEN

Kanıt:
- 2026-04-29 yerel `cargo check --locked` dogrulamasi basarili oldu, fakat gateway crate genelinde tarihsel unused/dead-code warning'leri uretildi.
- `.github/workflows/sens-api-gateway-ci.yml` su an `cargo clippy --all-targets --all-features` icin `clippy::correctness`, `clippy::suspicious` ve `clippy::perf` gruplarini deny ediyor.
- Aynı workflow `cargo doc` icin `RUSTDOCFLAGS="-D warnings"` kullanıyor; rustc/clippy full `-D warnings` ise bu remediation icinde bilincli olarak acilmadi.

Neden:
Gateway'te OPC UA, SCADA, LoRaWAN, scheduler, TPM ve debug gibi feature-gated moduller genis bir yuzey olusturuyor. Tarihsel olarak kullanilmayan import/struct/method alanlari birikmis; bunlar davranissal fix kapsaminda toplu silinirse PLC/protocol yuzeyinde istemeden public contract kirma riski olusur.

Risk:
Full warning wall kapali kaldigi surece yeni unused/dead-code debt'i eski debt arasina karisabilir. Bu bir security exploit degil, ama enterprise CI kalite kapisini zayiflatan tooling riski.

Gereken fix:
- Ayrı warning-cleanup PR'inda her warning sinifi owner bazinda kapatilmali.
- Public/feature-gated API mi, gercek dead code mu ayrimi yapilmadan silme yapilmamali.
- Cleanup tamamlaninca gateway CI `cargo check` ve `cargo clippy` icin full `-D warnings` seviyesine cikarilmali.

## Oncelikli Uygulama Backlog'u

### P0 - Guvenlik gate'lerini fail-closed yap

1. `authorize_command` gate dispatch'e baglandi.
2. Enforcing/Permissive modda envelope olmayan permissioned komutlar reddediliyor.
3. Malformed timestamp ve invalid JTI reject ediliyor.
4. Audit Disabled release build'de fail-closed.

Kabul kriteri:
- Unauthorized actor ile `write_modbus`, `update_policy`, `rotate_master`, `deploy_*`, `update_firmware`, `safe_state` calismaz.
- Legacy unsigned mutating payload Enforcing modda calismaz.
- Unit/integration testlerde command response "denied" ve audit deny event'i dogrulanir.

### P1 - Offline queue ve publish reliability'yi kapat

1. OfflineQueue checkpoint/flush API'si eklendi.
2. Shutdown sequence drain stop + WAL checkpoint + fsync yapiyor.
3. Kritik publish helper'lar `Result` donduren checked variant'lara sahip.
4. Drop/fail metric'leri ekle.

Kabul kriteri:
- Broker down iken queued mesaj process restart sonrasinda korunur.
- Shutdown testinde checkpoint API'si cagrildigi ve failure metric/log urettigi dogrulanir.

### P2 - OPC UA ve Modbus contract'i netlestir

1. OPC UA X.509 path'i gercek validate et veya public feature olarak kapali goster.
2. OPC UA read namespace/tag visibility policy ekle.
3. Tag datatype'larini `Variant::Double` disina genislet.
4. OPC UA server-side datatype fidelity testlerini genislet.
5. Analog write conversion policy icin typed range/rounding kontratini kapat.

### P3 - Config/keystore production hardening

1. Production config'te MQTT TLS off, audit disabled, config-integrity disabled/permissive ve keystore Auto->FileBacked fallback'leri policy ile fail-closed yap.
2. TPM/systemd-creds probe'lari gercek hale gelene kadar docs ve boot logs ayni dili kullansin.

### P4 - Performans ve dokuman hijyeni

1. `io_poll` AppState lock kapsamlarini daralt.
2. Slow bus mock ile reload/shutdown latency testi ekle.
3. Kirik `docs/reviews/orphan-findings.md` referanslarini duzelt.
4. `feature-matrix`, `data-flow`, OPC UA yorumlari ve roadmap statulerini yeniden dogrula.
5. Warning debt cleanup tamamlaninca CI'yi full rustc/clippy `-D warnings` wall'a yukselt.

## Test ve Dogrulama Plani

Minimum test paketi:

| Alan | Test |
| --- | --- |
| RBAC | Her mutating komut icin unauthorized deny, authorized allow. |
| Envelope | Enforcing unsigned mutating deny; malformed timestamp deny; invalid JTI deny. |
| Replay | SQLCipher persist acikken reboot sonrası ayni JTI deny. |
| Audit | Audit append failure policy testi: regulated mode fail-write, relaxed mode metric/alarm. |
| Offline queue | Broker down enqueue, reconnect drain, shutdown checkpoint. |
| Publish | Critical publish failure caller'a gorunur. |
| OPC UA | Anonymous deny, U/P allow/deny, X.509 current deny veya implemented validate, read visibility. |
| Modbus | Wrong device write regression, allow_writes=false deny, range deny, optional readback mismatch deny. |
| Performance | Slow fieldbus mock ile AppState write/reload latency bound. |
| Docs | Internal link check ve gap ledger consistency check. |

## Karar Notu

Bu audit'e gore `sens-api-gateway` icin "yapi yok" demek dogru degil; cok sayida guvenlik ve operasyon parcasi yazilmis. 2026-04-29 kod degisikligi kritik enforcement halkalarini bagladi: RBAC dispatch gate, legacy fail-closed ayrimi, audit fail-closed davranisi, PLC write connection inventory, TPI kapsam genisletmesi, checked publish ve offline checkpoint. Kalan enterprise-grade aciklar OPC UA X.509/read policy/datatype fidelity, analog conversion policy, deployment path drift ve warning debt cleanup uzerinde toplanmistir.
