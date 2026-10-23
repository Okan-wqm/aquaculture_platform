# 2026-10-19 — Suderra OS ↔ edge agent ↔ bulut entegrasyon denetimi (platform tarafı)

Karar kaydı: [ADR-048](../../adr/048-suderra-os-edge-agent-integration-contract.md). Suderra OS reposuna düşen bulgular `Okan-wqm/Suderra-OS` reposunda `docs/assessments/2026-10-19-edge-agent-integration-audit.md` içinde `EI-NNN` kimlikleriyle tutulur. Bu dosyadaki her bulgu `docs/reviews/_registry/findings.jsonl` kaydındadır; kapatan commit `Closes: docs/reviews/claude/2026-10-19-suderra-os-edge-integration-audit.md#<ID>` satırını taşır.

## Yöntem

1. Dört bağımsız envanter taraması (gateway saldırı yüzeyi, gateway iç yapısı, Suderra OS, entegrasyon + bulut).
2. 126 iddia yedi alanda kodla tek tek doğrulandı (`file:line` kanıtı zorunlu; kanıt yoksa REFUTED/UNVERIFIABLE).
3. CRITICAL/HIGH çıkan her iddia ayrı bir şüpheci agent tarafından çürütülmeye çalışıldı (78 iddia; hiçbiri
   çürütülemedi, bir kısmının önemi yeniden derecelendirildi — bkz. Not satırları).
4. Kod okunurken kaydedilen 174 yan bulgu tekilleştirildi (iddialarla çakışanlar ilgili iddiaya kanıt olarak eklendi).
5. Kritik iddiaların bir bölümü ayrıca elle doğrulandı (config yolu, `sd_notify(true)` → `NOTIFY_SOCKET` silinmesi —
   sd-notify 0.4.5 kaynağı, provision-worker `ReadWritePaths`, `/data` bind-mount'ları, RAUC health gate, lockdown
   marker'ı, release feature seti, bulut komut imzalayıcısının bağlantısızlığı, tarball binary adı).

Fazlar ve son tarihler ADR-048'in uygulama planından gelir: P0 2026-11-02, P1 2026-11-30, P2 2026-12-31,
P3 2027-03-31. Yan bulgular, uygulama paketine alınana kadar önemine göre P1 (CRITICAL/HIGH) veya P2'ye yazıldı.

## Özet

| Domain | CRITICAL | HIGH | MEDIUM | LOW | Toplam |
|---|---|---|---|---|---|
| EDGE | 4 | 26 | 38 | 15 | 83 |
| INFRA | 1 | 1 | 17 | 2 | 21 |
| SENSOR | 4 | 13 | 17 | 6 | 40 |

## Dizin

| ID | Önem | Faz | Başlık |
|---|---|---|---|
| [EDGE-CRITICAL-046](#EDGE-CRITICAL-046) | CRITICAL | P0 | AgentConfig::load()/save() hardcode /etc/suderra/config.yaml; SUDERRA_CONFIG is honoured only by --init, so the agent cannot boot on Suderra OS |
| [EDGE-CRITICAL-047](#EDGE-CRITICAL-047) | CRITICAL | P0 | v1 SQLCipher secret (db.key) is created lazily under /etc/suderra by the unprivileged agent; the offline queue is enabled by default and fails boot closed, so the agent exits under the hardened unit |
| [EDGE-CRITICAL-048](#EDGE-CRITICAL-048) | CRITICAL | P0 | v1 SQLCipher key = HMAC(db.key, machine-id); on Suderra OS prod (verity rootfs, empty /etc/machine-id) machine-id is regenerated every boot and per A/B slot, so every encrypted DB becomes unreadable |
| [EDGE-CRITICAL-049](#EDGE-CRITICAL-049) | CRITICAL | P0 | notify(true, READY) unsets NOTIFY_SOCKET, so every WATCHDOG=1 is a silent no-op and WatchdogSec=60 kills and restarts the agent about every minute |
| [EDGE-HIGH-050](#EDGE-HIGH-050) | HIGH | P0 | Agent persists runtime state into read-only /etc/suderra (RBAC manifest, io_config, scripts); after update_policy the RBAC floor advances but the manifest is not persisted, which bricks Enforcing boot |
| [EDGE-HIGH-051](#EDGE-HIGH-051) | HIGH | P0 | READY=1 is sent before activation, MQTT, hardware init and boot safe-state, so systemd and OS health gates treat the agent as healthy too early |
| [EDGE-HIGH-052](#EDGE-HIGH-052) | HIGH | P0 | Watchdog heartbeat is a fixed-interval timer that ignores control-loop health, so a stalled I/O or control loop is never detected |
| [EDGE-HIGH-053](#EDGE-HIGH-053) | HIGH | P1 | The agent has no piControl/PiBridge I/O backend: ProtocolConfig has no piControl variant and /dev/piControl0 is used only for read-only discovery, so RevPi Connect 4 expansion-module DIO/AIO (the primary target) cannot be read or driven |
| [EDGE-HIGH-054](#EDGE-HIGH-054) | HIGH | P1 | Config-integrity Enforcing mode rejects the same signed config on the second boot: the version gate is strictly greater-than and the accepted version is persisted as highest-seen on the first boot |
| [EDGE-HIGH-055](#EDGE-HIGH-055) | HIGH | P1 | The agent rewrites the factory-signed config.yaml (activation, config topic, Modbus provisioning) without refreshing the integrity sidecar, so the next Enforcing boot fails the digest check and exits |
| [EDGE-HIGH-056](#EDGE-HIGH-056) | HIGH | P1 | SCADA process/package deploy signatures cover only the claimed artifactSha256; the edge never hashes the deployed content, so any previously signed (signature, sha256) pair verifies arbitrary content |
| [EDGE-HIGH-057](#EDGE-HIGH-057) | HIGH | P1 | HMI emergency stop with no package or no control_permissions.emergency_stop de-energises nothing but reports success and broadcasts "emergency active" to every HMI |
| [EDGE-HIGH-058](#EDGE-HIGH-058) | HIGH | P1 | Graceful shutdown releases GPIO outputs right after driving them to safe state: rppal OutputPin defaults to reset_on_drop=true and the agent never disables it, so dropping the actor returns every pin to its previous (input) mode |
| [EDGE-HIGH-059](#EDGE-HIGH-059) | HIGH | P1 | In RBAC Enforcing mode the agent rejects its own previously accepted manifest on every reboot (strict policy_version > floor), so the boot exits independently of /etc writability |
| [EDGE-HIGH-060](#EDGE-HIGH-060) | HIGH | P1 | The safe-state output registry is built once at boot, so outputs added by provision_modbus_device or a SIGHUP config reload are never driven to safe state at shutdown |
| [EDGE-HIGH-061](#EDGE-HIGH-061) | HIGH | P1 | Agents with no writable outputs (sensor-only Modbus with allow_writes=false, input-only GPIO, any I2C) abort boot with "safe-state could not be applied" and crash-loop |
| [EDGE-HIGH-062](#EDGE-HIGH-062) | HIGH | P1 | MQTT set_output writes every Modbus tag as an FC05 coil (value != 0), ignoring register_type/IoType, routes by the first slave_id match, and records the analog value as Good |
| [EDGE-HIGH-063](#EDGE-HIGH-063) | HIGH | P1 | write_modbus is authorised against params.slave_id/address but executes against the separate params.device name, so a ModbusWrite grant for one device writes any device |
| [EDGE-HIGH-064](#EDGE-HIGH-064) | HIGH | P1 | reboot/restart_agent shell out to shutdown/systemctl as unprivileged user suderra with no polkit; they always fail but report success |
| [EDGE-HIGH-065](#EDGE-HIGH-065) | HIGH | P1 | No communications-loss output policy: actuators hold their last commanded state indefinitely when cloud or bus links drop |
| [EDGE-HIGH-066](#EDGE-HIGH-066) | HIGH | P1 | A full offline queue refuses new Critical alarms the same way as telemetry |
| [EDGE-HIGH-067](#EDGE-HIGH-067) | HIGH | P1 | The SCADA emergency stop is an in-memory flag that only the HMI WebSocket path honours and that clears on agent restart |
| [EDGE-HIGH-068](#EDGE-HIGH-068) | HIGH | P2 | In Permissive or Disabled mode, an unsigned envelope's self-asserted actor is trusted as the RBAC subject |
| [EDGE-HIGH-069](#EDGE-HIGH-069) | HIGH | P2 | SCADA HMI has no mandatory authentication, and the optional WS token cannot be used by the bundled browser HMI |
| [EDGE-HIGH-070](#EDGE-HIGH-070) | HIGH | P2 | SCADA WS writes bypass authz, force registry and IO-type checks, and are routed to the wrong Modbus/I2C target |
| [EDGE-HIGH-071](#EDGE-HIGH-071) | HIGH | P2 | Hand-rolled OPC UA client silently downgrades to SecurityPolicy None and sends PLC passwords in clear |
| [EDGE-MEDIUM-072](#EDGE-MEDIUM-072) | MEDIUM | P0 | ProcSubset=pid hides /proc/cpuinfo, /proc/meminfo, /proc/stat and /proc/device-tree; CPU serial, platform detection and CPU/memory telemetry silently degrade |
| [EDGE-MEDIUM-073](#EDGE-MEDIUM-073) | MEDIUM | P0 | Tryboot backend writes /boot/firmware/autoboot.txt (outside the sandbox), hardcodes partitions 2/3 (p3 is a verity hash partition on Suderra OS), never issues a tryboot reboot, and competes with RAUC+U-Boot |
| [EDGE-MEDIUM-074](#EDGE-MEDIUM-074) | MEDIUM | P1 | Cold-boot rollback watchdog runs inside the agent it judges, starts late, uses wall-clock time and never reboots; it only edits partition.json |
| [EDGE-MEDIUM-075](#EDGE-MEDIUM-075) | MEDIUM | P1 | Boot continues when only some outputs reach safe-state, and GPIO outputs are enabled with an undefined level |
| [EDGE-MEDIUM-076](#EDGE-MEDIUM-076) | MEDIUM | P1 | safe_state_v2 is unused type-only code, and the v1 header promises crash/OOM safe-state that panic=abort and SIGKILL make impossible |
| [EDGE-MEDIUM-077](#EDGE-MEDIUM-077) | MEDIUM | P1 | Envelope freshness and RBAC time checks use raw SystemTime, not the agent ClockAuthority; chrony query is off by default |
| [EDGE-MEDIUM-078](#EDGE-MEDIUM-078) | MEDIUM | P2 | Boot safe-state runs only after cloud activation and MQTT client creation, so an unactivated device whose activation fails restart-loops without ever driving outputs safe |
| [EDGE-MEDIUM-079](#EDGE-MEDIUM-079) | MEDIUM | P2 | Remote config update mutates the live in-memory config before persisting and does not restore it when save() fails |
| [EDGE-MEDIUM-080](#EDGE-MEDIUM-080) | MEDIUM | P2 | db.key is created with create_new + write_all and no fsync of file or directory; a torn or zero-length write permanently bricks every v1 SQLCipher database |
| [EDGE-MEDIUM-081](#EDGE-MEDIUM-081) | MEDIUM | P2 | GPIO direction "in"/"out" or mixed case passes validation and safe-state registration, but the GPIO actor matches only exact "input"/"output" and leaves the pin unconfigured |
| [EDGE-MEDIUM-082](#EDGE-MEDIUM-082) | MEDIUM | P2 | I2C DAC/relay outputs are writable (write_direct) but never included in safe-state, and the promised warning is never logged |
| [EDGE-MEDIUM-083](#EDGE-MEDIUM-083) | MEDIUM | P2 | A command larger than the 1 MiB incoming MQTT limit tears down the connection, and with clean_session=false and QoS1 the broker redelivers it on reconnect, causing a reconnect loop |
| [EDGE-MEDIUM-084](#EDGE-MEDIUM-084) | MEDIUM | P2 | Offline-queue row expiry runs only in the drain path while connected, and space is never reclaimed (incremental_vacuum never scheduled), contrary to the documented drop-oldest/expunge-on-enqueue behaviour |
| [EDGE-MEDIUM-085](#EDGE-MEDIUM-085) | MEDIUM | P2 | save() serializes the entire AgentConfig including every serde default, so after the first activation or config save, later agent default changes never reach that device |
| [EDGE-MEDIUM-086](#EDGE-MEDIUM-086) | MEDIUM | P2 | SCADA audit records carry no actor identity: source_ip is always None and the actor is "ws_client", so actuator changes and PIN failures cannot be attributed |
| [EDGE-MEDIUM-087](#EDGE-MEDIUM-087) | MEDIUM | P2 | HMI calibration computes slope/offset with reference = raw (reference_value None) and the stored result is never applied to readings |
| [EDGE-MEDIUM-088](#EDGE-MEDIUM-088) | MEDIUM | P2 | SCADA CORS origin predicate uses starts_with("http://localhost"/"http://127.0.0.1"), which also accepts http://localhost.attacker.example and http://127.0.0.1.attacker.example |
| [EDGE-MEDIUM-089](#EDGE-MEDIUM-089) | MEDIUM | P2 | The SCADA executor holds the global AppState read lock across actuator I/O awaits, so a queued writer (activation, SIGHUP) blocks all readers until a slow Modbus write times out |
| [EDGE-MEDIUM-090](#EDGE-MEDIUM-090) | MEDIUM | P2 | Signed commands can be replayed between the 60 s dedup TTL and the 300 s age window; the persistent tier is off by default |
| [EDGE-MEDIUM-091](#EDGE-MEDIUM-091) | MEDIUM | P2 | Emergency reset needs no PIN when the package has no pin_hash, and the global PIN lockout lets any client lock operators out indefinitely |
| [EDGE-MEDIUM-092](#EDGE-MEDIUM-092) | MEDIUM | P2 | SCADA query parameters and pending confirmations are unbounded (memory/CPU DoS of the control agent) |
| [EDGE-MEDIUM-093](#EDGE-MEDIUM-093) | MEDIUM | P2 | HMI loads unpinned React/Recharts/ReactFlow from public CDNs without SRI; air-gapped sites get a blank HMI |
| [EDGE-MEDIUM-094](#EDGE-MEDIUM-094) | MEDIUM | P2 | Lifecycle/observability HMAC covers only timestamp+method+path (replayable within ±300 s), and no shipped unit provisions its key |
| [EDGE-MEDIUM-095](#EDGE-MEDIUM-095) | MEDIUM | P2 | OPC UA endpoint declares only the ANONYMOUS token id while anonymous is rejected, and every OPC UA write is denied by the two-person-integrity floor |
| [EDGE-MEDIUM-096](#EDGE-MEDIUM-096) | MEDIUM | P2 | PLC upload/deploy commands connect to arbitrary address/port/cert paths from params instead of the configured inventory (OT pivot) |
| [EDGE-MEDIUM-097](#EDGE-MEDIUM-097) | MEDIUM | P2 | Script webhook SSRF guard is a string-prefix check that is trivially bypassed and refers to a non-existent allowlist |
| [EDGE-MEDIUM-098](#EDGE-MEDIUM-098) | MEDIUM | P2 | MQTT broker failover is cosmetic: the client always uses the primary broker, yet failover commands report success |
| [EDGE-MEDIUM-099](#EDGE-MEDIUM-099) | MEDIUM | P2 | TPM keystore is a trait plus mock only; Auto mode silently falls back to FileBacked |
| [EDGE-MEDIUM-100](#EDGE-MEDIUM-100) | MEDIUM | P2 | Audit chain has no external anchor; deleted or truncated logs silently restart or continue, and audit is disabled by default |
| [EDGE-MEDIUM-101](#EDGE-MEDIUM-101) | MEDIUM | P2 | ADR-019 security promises diverge from the code (Argon2 parameters, passphrase on disk, key epoch, SignedBootFlag, rescue slot, AntiRollbackCounter) |
| [EDGE-MEDIUM-102](#EDGE-MEDIUM-102) | MEDIUM | P2 | 34 ADR-cited invariant tests do not exist, and d3_boot_order.rs is orphaned by a copy-paste overwrite in Cargo.toml |
| [EDGE-LOW-103](#EDGE-LOW-103) | LOW | P0 | Several persistent stores hardcode /var/lib/suderra and ignore SUDERRA_DATA_DIR, so a data-dir override splits state |
| [EDGE-LOW-104](#EDGE-LOW-104) | LOW | P2 | GPIO pin validation caps RaspberryPi at 0-27 (rejecting CM4 GPIO 28-45) and allows 0-127 on RevPi, where rppal cannot address those lines |
| [EDGE-LOW-105](#EDGE-LOW-105) | LOW | P2 | MUTATING_COMMANDS is unused, lists non-existent commands and contradicts envelope.rs docs, while the catalog holds a second divergent list |
| [EDGE-LOW-106](#EDGE-LOW-106) | LOW | P2 | The OPC UA client sends UserNameIdentityToken with a hardcoded policyId "username" instead of the server-advertised UserTokenPolicy |
| [EDGE-LOW-107](#EDGE-LOW-107) | LOW | P2 | Rate-limited commands are dropped with only a local warn: no CommandResponse and no audit event |
| [EDGE-LOW-108](#EDGE-LOW-108) | LOW | P2 | If CSP nonce generation fails, the HMI is served under the middleware's static script-src 'none' CSP, giving a blank page |
| [EDGE-LOW-109](#EDGE-LOW-109) | LOW | P2 | Dead and misleading PIN code: per-session PinSession lockout fields and is_locked_out are never updated, hash_pin() is never called (the "transparent upgrade" comment is false), and reset_requires_pin/hold_duration are never read |
| [EDGE-LOW-110](#EDGE-LOW-110) | LOW | P2 | SCADA REST endpoints (/scada/process, /scada/tags, /scada/alarms/history) do not validate the Host header, allowing DNS-rebinding reads |
| [EDGE-LOW-111](#EDGE-LOW-111) | LOW | P2 | OPC UA login throttle is per-username only, and Argon2 cost comes from the manifest PHC with no floor |
| [EDGE-LOW-112](#EDGE-LOW-112) | LOW | P2 | Raw /etc/machine-id and CPU serial are sent to the cloud at activation (only MACs are pseudonymised) |
| [EDGE-LOW-113](#EDGE-LOW-113) | LOW | P2 | SQLCipher hex key cached as a plain String for the process lifetime; keystore passphrase and salt buffers not zeroized |
| [EDGE-LOW-114](#EDGE-LOW-114) | LOW | P2 | memfd_secret primitive is unused, and mlockall failure is non-fatal and in practice silent |
| [EDGE-LOW-115](#EDGE-LOW-115) | LOW | P2 | Backup format is unencrypted and unsigned, embeds the raw config, and create/restore have no callers |
| [EDGE-HIGH-128](#EDGE-HIGH-128) | HIGH | P0 | The agent crate does not compile without its health feature, so every Suderra OS release builds the boards.json features plus health and signs a suderra.edge-release.v1 statement whose cargo_features misstate the build |
| [EDGE-MEDIUM-130](#EDGE-MEDIUM-130) | MEDIUM | P0 | The suderra-os agent profile still builds tenant-token self-registration, which ADR-048 DEC-5.12 closes for Suderra OS, and the cloud cannot tell an agent's profile when it self-registers |
| [EDGE-HIGH-131](#EDGE-HIGH-131) | HIGH | P1 | Safe-state writes pass through the per-device Modbus write limiter (burst 4, 2 ops/s), so a device with more than four outputs cannot be driven fully safe at boot or shutdown |
| [EDGE-HIGH-132](#EDGE-HIGH-132) | HIGH | P1 | On the generic profile the cached license is never loaded after a restart: init_license_cache reads AppState.tenant_id, which is still None at that point, so the device runs on Starter limits and I/O polling is refused above 16 channels |
| [EDGE-HIGH-133](#EDGE-HIGH-133) | HIGH | P1 | The offline queue is never used with the default config: the outbound publisher needs HealthState, which exists only when the health server is enabled (default off), so publishes go direct and are lost during a broker outage |
| [EDGE-MEDIUM-134](#EDGE-MEDIUM-134) | MEDIUM | P2 | A Modbus device with allow_writes=true but the default function-code whitelist [1,2,3,4] passes config validation and registers safe-state outputs it can never write, so every boot goes degraded |
| [EDGE-MEDIUM-135](#EDGE-MEDIUM-135) | MEDIUM | P2 | Every refused command envelope (bad signature, RBAC denial, stale or replayed command, missing tenant binding) is dropped with a WARN: no CommandResponse reaches the cloud and no audit event records the attempt |
| [EDGE-MEDIUM-136](#EDGE-MEDIUM-136) | MEDIUM | P2 | Command audit actions are classified by a hand-written string match, not by the catalog that declares them, so the Suderra OS hand-off commands are audited as generic CommandExecuted and the catalog's audit and bootstrap fields plus command_acceptance.rs are dead code |
| [EDGE-MEDIUM-137](#EDGE-MEDIUM-137) | MEDIUM | P2 | Eighteen files under sens-api-gateway/tests/invariants (about 110 tests) assert on a string literal they define themselves, and some store tests silently skip when the store cannot open, so the security invariants they name are not tested |
| [EDGE-MEDIUM-138](#EDGE-MEDIUM-138) | MEDIUM | P2 | write_atomic_json/bytes uses one temp file name per process (.name.tmp-<pid>), so two concurrent writers of the same target can rename a half-written file into place |
| [EDGE-LOW-139](#EDGE-LOW-139) | LOW | P2 | SPI and PWM drivers (about 1,370 lines) and the I2C/tag 'simulated' quality are compiled but unreachable: no config, no handle, no safe-state, no dispatch |
| [EDGE-LOW-140](#EDGE-LOW-140) | LOW | P2 | Agent hygiene: the --audit-verify doc and clippy allows sit on the wrong function, run_audit_verify lacks its print allows, compute_hmac uses expect(), and remote-commands.md describes a pre-signing dispatcher |
| [INFRA-CRITICAL-236](#INFRA-CRITICAL-236) | CRITICAL | P0 | Release and OS builds ship without the gpio feature, so GPIO writes and safe-state only simulate while reporting success |
| [INFRA-HIGH-237](#INFRA-HIGH-237) | HIGH | P0 | Edge CI suppresses every denied clippy lint, never compiles gpio, and release ships untested, unlocked builds |
| [INFRA-MEDIUM-238](#INFRA-MEDIUM-238) | MEDIUM | P0 | apply_signed_manifest streams base64 files from the MQTT command into agent-owned slot dirs (impossible above 1 MiB, never executed), and the anti-rollback floor lives in a plaintext, agent-writable partition.json that resets when deleted |
| [INFRA-MEDIUM-239](#INFRA-MEDIUM-239) | MEDIUM | P1 | mTLS pinning has no viable production mode: Legacy/Warn never enforce, and Strict pins the auto-renewed Let's Encrypt broker leaf |
| [INFRA-MEDIUM-240](#INFRA-MEDIUM-240) | MEDIUM | P2 | The nightly fuzz job can never report a crash: fuzz_exit is tee's status (no pipefail), and the 23h run exceeds the 6h GitHub-hosted job limit |
| [INFRA-MEDIUM-241](#INFRA-MEDIUM-241) | MEDIUM | P2 | Release builds fetch an unpinned apt.llvm.org key and Xenial repo inside tag-pinned EOL cross images, and install unpinned cargo-audit/cargo-deny with errors swallowed |
| [INFRA-MEDIUM-242](#INFRA-MEDIUM-242) | MEDIUM | P2 | Rust toolchain and lockfile discipline drift across pipelines: MSRV 1.85, CI/release 1.88, Buildroot 1.86, ci-edge.yml on unpinned stable without --locked, and no gate builds the OS package or the declared MSRV |
| [INFRA-MEDIUM-243](#INFRA-MEDIUM-243) | MEDIUM | P2 | The SCADA kiosk cannot run: Suderra OS ships no display stack (cage/chromium), and the unit's NoNewPrivileges/RestrictNamespaces/RestrictSUIDSGID break the Chromium sandbox |
| [INFRA-MEDIUM-244](#INFRA-MEDIUM-244) | MEDIUM | P2 | The SLSA/in-toto provenance is a hand-written heredoc from the build job (builder.id actions/runner/ubuntu-latest), not trusted-builder provenance |
| [INFRA-MEDIUM-245](#INFRA-MEDIUM-245) | MEDIUM | P2 | SCADA server cannot be disabled by config and serves plain HTTP only |
| [INFRA-MEDIUM-246](#INFRA-MEDIUM-246) | MEDIUM | P2 | OPC UA server defaults to 0.0.0.0:4840 with trust-any-client-cert (TOFU) on first boot and a library-generated sample keypair |
| [INFRA-MEDIUM-247](#INFRA-MEDIUM-247) | MEDIUM | P2 | Three of four fuzz targets never call agent code; every real untrusted-input parser except the ST parser is unfuzzed |
| [INFRA-MEDIUM-248](#INFRA-MEDIUM-248) | MEDIUM | P2 | sx1302-vendor-hal builds a fake concentrator instead of failing when the Semtech C sources are absent |
| [INFRA-MEDIUM-249](#INFRA-MEDIUM-249) | MEDIUM | P2 | Five RustSec advisories ignored, and the RSA Marvin rationale is factually wrong for the OPC UA server |
| [INFRA-MEDIUM-250](#INFRA-MEDIUM-250) | MEDIUM | P2 | Release builds wrap integer overflow silently, and panic=abort kills the whole agent with no software safe-state |
| [INFRA-LOW-251](#INFRA-LOW-251) | LOW | P2 | Load-bearing agent comments and config docs contradict the code (FirmwareUpdateMode::Disabled "sole update path", safe-state degraded-mode claim, "default build must include gpio", Strict leaf max-age "unbounded" vs 398 days, panic=abort rationale, dead log_file setting, release trigger) |
| [INFRA-LOW-252](#INFRA-LOW-252) | LOW | P2 | WASM decoder compilation is unbounded and decoder modules are unsigned |
| [INFRA-MEDIUM-253](#INFRA-MEDIUM-253) | MEDIUM | P1 | The release checks a binary's NEEDED libraries and glibc symbol versions against hand-maintained release facts, not against a sysroot manifest the Suderra OS image publishes |
| [INFRA-MEDIUM-257](#INFRA-MEDIUM-257) | MEDIUM | P1 | No tool signs the production trust-anchors bundle with the offline fleet-root key: the only producer is the dev/CI generator, which signs with a file key, so the first production bundle and every later bundle change has no ceremony-grade path |
| [INFRA-MEDIUM-254](#INFRA-MEDIUM-254) | MEDIUM | P1 | sens-api-gateway-ci.yml greps for the literal version = "2.0.0-rc.4", and the release workflow now calls that CI, so the first version bump blocks every agent release |
| [INFRA-MEDIUM-255](#INFRA-MEDIUM-255) | MEDIUM | P1 | The nine CRITICAL findings registered by this audit have no truth-table row, so derived-merge-pins and enterprise-grade-debt-plan-contract fail on every run of the registry invariants |
| [INFRA-MEDIUM-256](#INFRA-MEDIUM-256) | MEDIUM | P2 | e2e/.github/workflows/e2e-tests.yml is a nested workflow GitHub never runs, and it is the only caller of the e2e security, workflow and integration suites |
| [SENSOR-CRITICAL-200](#SENSOR-CRITICAL-200) | CRITICAL | P0 | Activation credentials are persisted by rewriting the whole config.yaml via save(); secrets are only base64-encoded, and on Suderra OS the save fails after the cloud has already consumed the single-use token |
| [SENSOR-CRITICAL-201](#SENSOR-CRITICAL-201) | CRITICAL | P0 | Production can only run Permissive or Disabled, where unsigned legacy commands drive outputs and I/O config with no RBAC |
| [SENSOR-CRITICAL-202](#SENSOR-CRITICAL-202) | CRITICAL | P0 | Releases are signed only with cosign keyless; Suderra OS accepts only Ed25519-signed artifacts, so no official release can be installed. An unused armv7 build can also block releases |
| [SENSOR-CRITICAL-203](#SENSOR-CRITICAL-203) | CRITICAL | P1 | Release agent refuses to boot with every shipped config: cloud and Suderra OS templates omit signature_mode and mtls.mode, whose serde defaults (Disabled/Legacy) are rejected by release-only validation |
| [SENSOR-HIGH-204](#SENSOR-HIGH-204) | HIGH | P0 | The cloud's Suderra OS install manifest is unsigned and in a different format from what the OS verifier accepts |
| [SENSOR-HIGH-205](#SENSOR-HIGH-205) | HIGH | P0 | The manifest endpoint requires an X-Provisioning-Token header that the OS fetch path never sends |
| [SENSOR-HIGH-206](#SENSOR-HIGH-206) | HIGH | P0 | Cloud commands, including physical-output writes, are published unsigned; the envelope signer is never wired in and there is no RBAC manifest producer |
| [SENSOR-HIGH-207](#SENSOR-HIGH-207) | HIGH | P0 | Nothing in either repo produces the ed25519 SignedFirmwareManifest the agent verifies, while the cloud disables legacy OTA and points operators to it |
| [SENSOR-HIGH-208](#SENSOR-HIGH-208) | HIGH | P1 | AGENT_VERSION is not set in any deployment, so every generic installer, uninstall and update script request throws and returns an error script or 500 |
| [SENSOR-HIGH-209](#SENSOR-HIGH-209) | HIGH | P1 | Command-envelope canonicalization rejects any nested-object param, so deploy_bundle (params.contents map) and deploy_scada_package (meta/packageData objects) can never be sent as signed envelopes, even once the cloud signer is wired |
| [SENSOR-HIGH-210](#SENSOR-HIGH-210) | HIGH | P1 | Cloud device-config pushes are published on the commands topic as command "config", which the agent rejects (uncatalogued, two-person gate), while the cloud returns success |
| [SENSOR-HIGH-211](#SENSOR-HIGH-211) | HIGH | P1 | GET /install/tenant is captured by the earlier @Get('install/:deviceCode') route, so the tenant self-registration installer always returns 400 "Invalid device code format" |
| [SENSOR-HIGH-212](#SENSOR-HIGH-212) | HIGH | P1 | I/O tag config and HH/H/L/LL alarm thresholds vanish on every agent restart (write-only persistence, no boot reader), alarm updates are additive so stale alarms persist, and the cloud never re-pushes automatically |
| [SENSOR-HIGH-213](#SENSOR-HIGH-213) | HIGH | P1 | The cloud stores SCADA package PINs as scrypt$salt$hash, but the edge verifies only $argon2id$ PHC strings or legacy hex SHA-256, so no PIN ever validates on the device and every attempt feeds the global lockout |
| [SENSOR-HIGH-214](#SENSOR-HIGH-214) | HIGH | P1 | The cloud has nothing that produces cert-pinning updates, signed firmware manifests, OS RAUC OTA triggers or the RBAC manifest |
| [SENSOR-HIGH-215](#SENSOR-HIGH-215) | HIGH | P2 | MQTT config-topic updates are applied unsigned, with no RBAC even in Enforcing mode, and can persistently disable all control logic |
| [SENSOR-HIGH-216](#SENSOR-HIGH-216) | HIGH | P2 | One firmware key verifies every artifact class, every trust anchor lives in the editable config.yaml, and config integrity can be bypassed |
| [SENSOR-MEDIUM-217](#SENSOR-MEDIUM-217) | MEDIUM | P0 | The SUDERRA_OS_EDGE_* variables the manifest needs are missing from every deployment, so the endpoint always returns 400 |
| [SENSOR-MEDIUM-218](#SENSOR-MEDIUM-218) | MEDIUM | P0 | Activation burns the single-use token before the device confirms it saved its credentials, and on Suderra OS the agent cannot save them |
| [SENSOR-MEDIUM-219](#SENSOR-MEDIUM-219) | MEDIUM | P0 | The broker listens only on plain 1883 behind nginx TLS without client-cert checks, and sensor-ingestion expects mqtts://mosquitto:8883, which nothing serves |
| [SENSOR-MEDIUM-220](#SENSOR-MEDIUM-220) | MEDIUM | P0 | MQTT settings default to plain 1883 and derive TLS from the port number; production overrides this, but staging and the admin-API path do not |
| [SENSOR-MEDIUM-221](#SENSOR-MEDIUM-221) | MEDIUM | P0 | The MQTT ACL denies the agent's watch and graceful-shutdown status topics, and the cloud never subscribes to task_stats or watch |
| [SENSOR-MEDIUM-222](#SENSOR-MEDIUM-222) | MEDIUM | P0 | The Suderra OS SSH install command builder is never called and has no UI, and its route shape contradicts the OS runbook |
| [SENSOR-MEDIUM-223](#SENSOR-MEDIUM-223) | MEDIUM | P0 | Legacy tarball OTA takes its repo from command params, verifies only a same-origin sha256, requests asset names the release workflow never publishes, and installs to a non-ExecStart read-only path |
| [SENSOR-MEDIUM-224](#SENSOR-MEDIUM-224) | MEDIUM | P0 | Release tarball contains `edge-agent`, but the Suderra OS installer, the cloud's Suderra OS manifest and the agent's own OTA look for `suderra-agent` |
| [SENSOR-MEDIUM-225](#SENSOR-MEDIUM-225) | MEDIUM | P2 | The installer's remote provisioning-config fetch sends an INTERNAL_SERVICE_TOKEN nothing else issues to a PlatformAdminGuard endpoint at an unset ADMIN_API_URL, so it always fails silently into fallback; if it succeeded, its localhost:1883/"latest" defaults would override production env |
| [SENSOR-MEDIUM-226](#SENSOR-MEDIUM-226) | MEDIUM | P2 | No consumer verifies the cosign release signatures: the cloud's generic Linux installer checks only a sha256 file from the same release |
| [SENSOR-MEDIUM-227](#SENSOR-MEDIUM-227) | MEDIUM | P2 | Self-register power-loss recovery re-issues a device's MQTT password to anyone holding the shared tenant token and the device's raw machine-id, and on Suderra OS prod (transient machine-id) it never matches, creating duplicate devices |
| [SENSOR-MEDIUM-228](#SENSOR-MEDIUM-228) | MEDIUM | P2 | Uncataloged commands resolve to the SafeStateTrigger permission; write_opcua and write_s7 are cataloged but have no dispatch arm |
| [SENSOR-MEDIUM-229](#SENSOR-MEDIUM-229) | MEDIUM | P2 | SCADA process/package deploys accept unsigned artifacts; script, program, CODESYS and PLC uploads have no artifact signature |
| [SENSOR-MEDIUM-230](#SENSOR-MEDIUM-230) | MEDIUM | P2 | Seven security/ADR-phase features are no-ops, and signed-deploy falsely claims to enforce signatures |
| [SENSOR-MEDIUM-231](#SENSOR-MEDIUM-231) | MEDIUM | P3 | Decommissioning only changes database state: no wipe or safe-state command goes to the device and on-device secrets stay valid |
| [SENSOR-MEDIUM-232](#SENSOR-MEDIUM-232) | MEDIUM | P3 | There is no device certificate issuance (CSR); MQTT uses shared-secret passwords, and the provisioning_blob/signature/key_epoch fields are never filled |
| [SENSOR-LOW-233](#SENSOR-LOW-233) | LOW | P0 | MqttTlsConfig derived Default contradicts its serde defaults (enabled/verify_hostname false when the tls block is missing) |
| [SENSOR-LOW-234](#SENSOR-LOW-234) | LOW | P2 | Provisioning endpoints return raw exception messages with 400 (env var names, token/activation/device-existence state), reveal readiness before token validation, and readiness ignores the REVOKED lifecycle state |
| [SENSOR-LOW-235](#SENSOR-LOW-235) | LOW | P2 | Topic templates substitute the cloud-supplied tenant_id without rejecting MQTT wildcards or separators |
| [SENSOR-MEDIUM-236](#SENSOR-MEDIUM-236) | MEDIUM | P2 | Re-provisioning replaces the device's live MQTT password hash at activation, before the commit, so a reinstall that never connects strands the device |
| [SENSOR-LOW-237](#SENSOR-LOW-237) | LOW | P2 | Self-register power-loss recovery reads a device outside a transaction and then saves the whole stale entity, overwriting concurrent changes (revocation, lifecycle, token) with the snapshot |
| [SENSOR-LOW-238](#SENSOR-LOW-238) | LOW | P2 | The provisioning controller validates device codes with four copies of ^[A-Z]{2,5}-[0-9A-F]{8}$, narrower than the contract's ^[A-Za-z0-9_-]{1,50}$ |
| [SENSOR-LOW-239](#SENSOR-LOW-239) | LOW | P2 | Banned type escapes remain in the edge provisioning and MQTT adapter code, and edge-device.service.ts and automation.service.ts fail the repo's Prettier gate |
| [EDGE-MEDIUM-141](#EDGE-MEDIUM-141) | MEDIUM | P1 | The activation request carries no deviceBinding or installedManifest, and the cloud checks no binding, although the contract requires both: a request built to the contract is refused with 400 by the DTO whitelist |
| [EDGE-MEDIUM-142](#EDGE-MEDIUM-142) | MEDIUM | P1b | x86 industrial-PC package set (USB installer image, Windows conversion and Secure Boot ownership runbook, qualification checker, driver set, signed PCR 7+11 policy) is deliberately P1b: it starts only after the operator selects the x86 model, and SG-3 stays closed until it is done |

## Edge agent (sens-api-gateway)

<a id="EDGE-CRITICAL-046"></a>

### EDGE-CRITICAL-046 — AgentConfig::load()/save() hardcode /etc/suderra/config.yaml; SUDERRA_CONFIG is honoured only by --init, so the agent cannot boot on Suderra OS

- **Önem:** CRITICAL · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway config loading (config.rs / main.rs)
- **Köken:** doğrulanan iddia T01 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/config.rs:143`, `sens-api-gateway/src/config.rs:3246-3248`, `sens-api-gateway/src/config.rs:4239-4241`, `sens-api-gateway/src/main.rs:247-255`, `sens-api-gateway/src/main.rs:3189`, `sens-api-gateway/src/main.rs:3284-3288`, `sens-api-gateway/src/main.rs:3309`, `sens-api-gateway/src/main.rs:4367`, `sens-api-gateway/src/main.rs:3875`, `Suderra-OS/board/suderra/common/rootfs-overlay/etc/systemd/system/suderra-agent.service:7`, `Suderra-OS/package/suderra-edge-agent/suderra-agent.service:8`, `Suderra-OS/board/suderra/common/post-image.sh:251`
- **Kanıt (ayrıntı):**
  - aquaculture_platform/sens-api-gateway/src/config.rs:143 const DEFAULT_CONFIG_PATH = "/etc/suderra/config.yaml"
  - config.rs:3246-3248 load() -> load_from(DEFAULT_CONFIG_PATH); config.rs:4239-4241 save() -> save_to(DEFAULT_CONFIG_PATH); neither reads any env var
  - main.rs:247-255 the only std::env::var("SUDERRA_CONFIG") read, inside generate_default_config (--init)
  - main.rs:3189 boot AgentConfig::load(); main.rs:3284-3288 on error logs 'Please ensure /etc/suderra/config.yaml exists' and exit(1)
  - main.rs:3309 config-integrity verify uses PathBuf::from("/etc/suderra/config.yaml") literal
  - main.rs:4367 SIGHUP reload AgentConfig::load(); main.rs:3875 --migrate-db AgentConfig::load()
  - Suderra-OS board/suderra/common/rootfs-overlay/etc/systemd/system/suderra-agent.service:7,12 ConditionPathExists + Environment=SUDERRA_CONFIG=/var/lib/suderra/config/config.yaml (same in package/suderra-edge-agent/suderra-agent.service:8,13)
  - Suderra-OS rootfs-overlay/etc/suderra/ holds only edge-install.env; suderra-edge-install:6,276 writes config to /var/lib/suderra/config/config.yaml; prod rootfs is dm-verity (post-image.sh:251,294-299), so /etc/suderra/config.yaml can never be created
- **Kök neden:** There is no single place that resolves paths. The config path is a private constant baked into load()/save(), which take no arguments. The env-var lookup was only added to the --init generator, and every other caller (boot, integrity check, SIGHUP, migrate-db) hardcodes the path again. Suderra OS moved config to /var/lib because its rootfs is verity/read-only, and no contract test checks the two repos against each other.
- **Mimari düzeltme yönü:** Add one AgentPaths SSoT, resolved once at process start from SUDERRA_CONFIG or systemd $CONFIGURATION_DIRECTORY/$STATE_DIRECTORY. Delete DEFAULT_CONFIG_PATH and the no-argument load()/save(), and make AgentConfig::load/save take a typed &ConfigPath so boot, integrity verify, SIGHUP and the CLIs cannot disagree on the path. Add a cross-repo contract test that parses the Suderra OS unit (Environment=, ReadWritePaths=) and checks that the agent resolves exactly those paths.
- **Doğrulama:** Integration test: start the binary with SUDERRA_CONFIG=<tmp>/config.yaml and no /etc/suderra. Assert it passes the config stage, that SIGHUP reload re-reads the tmp file, and that config-integrity reads <tmp> plus its sidecar. QEMU prod-image test: suderra-agent reaches active with NRestarts=0.
- **Not:** Even with the path fixed, save() still fails on Suderra OS: the config dir is root:suderra 0750 and the file is 0640 (see T06).

<a id="EDGE-CRITICAL-047"></a>

### EDGE-CRITICAL-047 — v1 SQLCipher secret (db.key) is created lazily under /etc/suderra by the unprivileged agent; the offline queue is enabled by default and fails boot closed, so the agent exits under the hardened unit

- **Önem:** CRITICAL · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway db_secret.rs / offline_queue.rs / boot
- **Köken:** doğrulanan iddia T02 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/db_secret.rs:71`, `sens-api-gateway/src/db_secret.rs:168-226`, `sens-api-gateway/src/offline_queue.rs:103-138`, `sens-api-gateway/src/offline_queue.rs:163-165`, `sens-api-gateway/src/config.rs:689-691`, `sens-api-gateway/src/main.rs:1405-1415`, `sens-api-gateway/src/main.rs:3444-3449`, `sens-api-gateway/src/config.rs:1884-1891`, `sens-api-gateway/systemd/suderra-agent.service:34`, `Suderra-OS/package/suderra-edge-agent/suderra-edge-agent.mk:53`, `sens-api-gateway/systemd/suderra-agent.service:87-95`, `sens-api-gateway/src/main.rs:1843-1845`
- **Kanıt (ayrıntı):**
  - aquaculture_platform/sens-api-gateway/src/db_secret.rs:71 DEFAULT_SECRET_KEY_PATH="/etc/suderra/db.key"; :87-92 only the SUDERRA_DB_KEY_PATH override; :96-99 doc says 'root-owned agent', but the unit runs User=suderra
  - db_secret.rs:168-226 read-or-create: create_dir_all(parent) then OpenOptions.create_new().mode(0o400) under /etc/suderra
  - offline_queue.rs:103-138 derive_db_encryption_key -> load_or_create_db_secret (offline_queue.rs:163-165) -> db_secret
  - config.rs:689-691 default_offline_enabled()=true; main.rs:1405-1415 init_offline_queue; main.rs:3444-3449 'OfflineQueue init failed (fail-closed boot)' exit(1)
  - config.rs:1884-1891 KeystoreMode default Disabled, so the v1 db.key path is the default key path
  - Suderra-OS rootfs-overlay suderra-agent.service:34 ProtectSystem=strict, :37 ReadWritePaths=/var/lib/suderra /var/log/suderra; suderra-edge-agent.mk:53 /etc/suderra root:root 0755; prod rootfs is dm-verity
  - Agent repo's own unit sens-api-gateway/systemd/suderra-agent.service:87-95 says '/etc/suderra — READ-ONLY for the agent' and sets ReadOnlyPaths=/etc/suderra, which contradicts the code
  - Turning the queue off is no escape: main.rs:1843-1845 init_outbound_publisher errors if offline_queue is None, and main.rs:4744-4749 exits
- **Kök neden:** Secret material sits in the config dir (a habit from before hardening) and is generated lazily by the unprivileged runtime instead of at provisioning time. There is no path SSoT, and nothing tests the sandbox contract (ProtectSystem=strict).
- **Mimari düzeltme yönü:** Have the root-owned installer (suderra-edge-install) provision a per-device secret, or seal it to the TPM, and deliver it via systemd LoadCredentialEncrypted= / $CREDENTIALS_DIRECTORY. The agent only reads it, never creates it, and fails closed with an explicit diagnostic if it is missing. Make keystore v2 (HKDF from a /data master key) the default and delete the /etc v1 dependency after migration.
- **Doğrulama:** CI: run the agent under systemd-run with the production unit's sandbox properties (ProtectSystem=strict, read-only /etc) and assert the offline queue opens. Image test: no db.key in rootfs, and two QEMU instances end up with different credentials.

<a id="EDGE-CRITICAL-048"></a>

### EDGE-CRITICAL-048 — v1 SQLCipher key = HMAC(db.key, machine-id); on Suderra OS prod (verity rootfs, empty /etc/machine-id) machine-id is regenerated every boot and per A/B slot, so every encrypted DB becomes unreadable

- **Önem:** CRITICAL · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway db_migration/v1_legacy_key.rs, machine_id.rs
- **Köken:** doğrulanan iddia T05 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/db_migration/v1_legacy_key.rs:141-181`, `sens-api-gateway/src/offline_queue.rs:120-131`, `sens-api-gateway/src/offline_queue.rs:52-58`, `sens-api-gateway/src/machine_id.rs:87-104`, `Suderra-OS/board/suderra/common/post-image.sh:251`, `Suderra-OS/board/suderra/aarch64-revpi4/genimage-prod.cfg:43-63`, `Suderra-OS/board/suderra/common/post-build.sh:188-197`, `sens-api-gateway/src/main.rs:3444-3449`, `sens-api-gateway/src/authz/manifest_version_store.rs:459`, `sens-api-gateway/src/scada_db.rs:153`, `sens-api-gateway/src/db/sqlcipher_factory.rs:134`
- **Kanıt (ayrıntı):**
  - aquaculture_platform/sens-api-gateway/src/db_migration/v1_legacy_key.rs:141-181 HmacSha256::new_from_slice(secret_key).update(machine_id)
  - offline_queue.rs:120-131 machine_id::read() + db secret -> derive; offline_queue.rs:52-58 comment asserts 'machine-id is stable'
  - machine_id.rs:87-104 machine_uid::get(); machine-uid 0.5.4 lib.rs:89-91 reads /var/lib/dbus/machine-id then /etc/machine-id; buildroot package/dbus/dbus.mk:120 symlinks the dbus path to /etc/machine-id
  - buildroot package/systemd/systemd.mk:682 ships an empty /etc/machine-id; Suderra-OS prod rootfs is dm-verity (post-image.sh:251,294-299; aarch64-revpi4/genimage-prod.cfg:43-63), so systemd uses a transient random ID each boot
  - Nothing in Suderra-OS persists machine-id to /data; the only systemd-machine-id-setup call is in suderra-firstboot.service:35-37, which is enabled only for non-prod (post-build.sh:188-197)
  - Even on RW dev images every RAUC slot carries its own /etc/machine-id, so an OS A/B switch changes the key
  - Consumers that fail closed include offline_queue (main.rs:3444-3449), rbac/user-token version stores and scada_db (offline_queue::derive_db_encryption_key callers: manifest_version_store.rs:459,510; scada_db.rs:153; db/sqlcipher_factory.rs:134)
- **Kök neden:** The KDF binds the at-rest key to an OS-instance identifier that is neither stable nor secret on an immutable A/B OS. The assumption 'machine-id is stable' was never checked against the target OS.
- **Mimari düzeltme yönü:** Bind the DB key to a stable per-device secret on /data: TPM-sealed, or keystore v2 HKDF(master) as the default. Remove machine-id from the derivation and do a one-time v1->v2 migration. If an OS identity is needed, Suderra OS should own a persisted machine-id (stored in LUKS /data and applied via systemd.machine_id= or a bind before sysinit) as the single source of truth, but the better fix is to remove the dependency.
- **Doğrulama:** QEMU prod image: enqueue offline rows, reboot, RAUC slot switch, reboot again. Assert every SQLCipher DB opens and the rows survive. Unit test that the KDF input set excludes machine-id.

<a id="EDGE-CRITICAL-049"></a>

### EDGE-CRITICAL-049 — notify(true, READY) unsets NOTIFY_SOCKET, so every WATCHDOG=1 is a silent no-op and WatchdogSec=60 kills and restarts the agent about every minute

- **Önem:** CRITICAL · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway main.rs notify_systemd_ready
- **Köken:** doğrulanan iddia T08 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/main.rs:4225`, `Cargo.lock:3559-3560`, `sens-api-gateway/src/main.rs:4231`, `sens-api-gateway/src/main.rs:4245-4254`, `sens-api-gateway/systemd/suderra-agent.service:22`, `sens-api-gateway/src/main.rs:3148`, `Cargo.toml:4`
- **Kanıt (ayrıntı):**
  - aquaculture_platform/sens-api-gateway/src/main.rs:4225 sd_notify::notify(true, &[NotifyState::Ready])
  - sd-notify 0.4.5 (Cargo.lock:3559-3560) lib.rs:167-171 and 244-251: connect_notify_socket(unset_env=true) calls env::remove_var("NOTIFY_SOCKET"); later calls hit lib.rs:245-246 'else return Ok(None)' -> Ok(())
  - main.rs:4231 watchdog_enabled(false, ..) still returns true (WATCHDOG_USEC/PID not removed), so the ping task at main.rs:4245-4254 runs and logs 'Watchdog heartbeat sent' while sending nothing
  - No other WATCHDOG=1 source in the crate (grep NotifyState::Watchdog / NOTIFY_SOCKET)
  - Suderra-OS suderra-agent.service:22 WatchdogSec=60s, :14 Restart=on-failure, :15 RestartSec=5s; agent repo unit:56
  - env::remove_var runs while the multi-thread tokio runtime (main.rs:3148) already has worker threads, a getenv data race (remove_var is unsafe in edition 2024, Cargo.toml:4)
- **Kök neden:** Misuse of the sd-notify API flag (unset_env=true on the first call), plus no integration test against a real notify socket. Restarts re-run activation, MQTT and hardware init and re-apply boot safe-state every cycle.
- **Mimari düzeltme yönü:** Create one SystemdNotifier at process start, before any threads, that reads NOTIFY_SOCKET once and owns the socket. Expose ready(), watchdog() and stopping(). Ban direct sd_notify calls with clippy disallowed-methods, so losing the socket cannot happen.
- **Doğrulama:** Integration test: bind a UnixDatagram at a temp path, set NOTIFY_SOCKET/WATCHDOG_USEC/WATCHDOG_PID, run the notifier, and assert READY=1 followed by periodic WATCHDOG=1 datagrams. QEMU: WatchdogSec=10 and assert NRestarts==0 after 2 minutes.

<a id="EDGE-HIGH-050"></a>

### EDGE-HIGH-050 — Agent persists runtime state into read-only /etc/suderra (RBAC manifest, io_config, scripts); after update_policy the RBAC floor advances but the manifest is not persisted, which bricks Enforcing boot

- **Önem:** HIGH · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway authz/manifest_runtime.rs, commands/io_config.rs, scripting/storage.rs
- **Köken:** doğrulanan iddia T03 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/authz/manifest_runtime.rs:52`, `sens-api-gateway/src/authz/manifest_runtime.rs:240-247`, `sens-api-gateway/src/main.rs:1758`, `sens-api-gateway/src/authz/manifest_runtime.rs:161`, `sens-api-gateway/src/main.rs:3508-3514`, `sens-api-gateway/src/commands/io_config.rs:793-803`, `sens-api-gateway/src/commands/io_config.rs:118-120`, `sens-api-gateway/src/scripting/storage.rs:26`, `sens-api-gateway/src/main.rs:905`, `sens-api-gateway/src/main.rs:1105-1108`, `sens-api-gateway/systemd/suderra-agent.service:87-90`
- **Kanıt (ayrıntı):**
  - aquaculture_platform/sens-api-gateway/src/authz/manifest_runtime.rs:52 DEFAULT_MANIFEST_PATH=/etc/suderra/rbac_manifest.json
  - manifest_runtime.rs:240-247 version floor advanced (record_accepted) in verify_and_floor BEFORE the disk persist; :297-305 in-memory swap; :307-340 create_dir_all + tmp write + rename under /etc/suderra (fails with EROFS)
  - main.rs:1758,1808-1809 boot loads the manifest from that path; manifest_runtime.rs:161 Enforcing + Err -> Err -> main.rs:3508-3514 exit(1). Old on-disk manifest < persisted floor gives a rollback rejection, so the boot loops
  - commands/io_config.rs:793-803 persist_io_config writes /etc/suderra/io_config.yaml; io_config.rs:118-120 failure is only warned and the command still returns success; nothing anywhere reads io_config.yaml back (grep)
  - scripting/storage.rs:26 DEFAULT_SCRIPTS_DIR=/etc/suderra/scripts; :230 create_dir_all in init; :346 and :496 fs::write; main.rs:905 ScriptStorage::new(None); main.rs:1105-1108 init failure is only warned
  - Contradiction: sens-api-gateway/systemd/suderra-agent.service:87-90 says configuration changes 'go through a separate operator flow, not through agent writes'
- **Kök neden:** Nothing separates read-only operator/factory config from agent-mutable state. Each persistence feature picked /etc/suderra on its own, and the RBAC hot-reload advances its anti-rollback floor without making it depend on a durable manifest write.
- **Mimari düzeltme yönü:** Introduce typed ConfigDir (read-only) and StateDir (read-write, under ReadWritePaths) APIs from AgentPaths. Store and load-at-boot every runtime-mutated artifact (rbac/user-token manifests, io_config, scripts) only through StateDir. Make the RBAC update atomic: persist the manifest first and advance the floor only on success, or keep both in one SQLite transaction, so the floor can never exceed what is on disk. Add an invariant test that forbids filesystem writes to literal /etc paths.
- **Doğrulama:** Unit test: hot_reload_from_bytes with an unwritable manifest dir returns Err and leaves the floor unchanged. Integration under the production sandbox: update_policy then restart in Enforcing mode boots; update_io_config then restart restores tags and alarms; deploy_script then restart restores the script.

<a id="EDGE-HIGH-051"></a>

### EDGE-HIGH-051 — READY=1 is sent before activation, MQTT, hardware init and boot safe-state, so systemd and OS health gates treat the agent as healthy too early

- **Önem:** HIGH · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway main.rs async_main / run_agent ordering
- **Köken:** doğrulanan iddia T09 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/main.rs:3765-3771`, `sens-api-gateway/src/main.rs:3773-3774`, `sens-api-gateway/src/main.rs:4536-4705`, `Suderra-OS/package/suderra-rauc-config/suderra-rauc-health-gate:25-29`
- **Kanıt (ayrıntı):**
  - aquaculture_platform/sens-api-gateway/src/main.rs:3765-3771 notify_systemd_ready() before main.rs:3773-3774 local.run_until(run_agent(..))
  - run_agent: main.rs:4536-4705 activation with up to 5 retries (10/20/40/80 s backoff); 4718-4723 MqttClient::new; 4746 init_outbound_publisher; 4793-4795 init_hardware; 4797-4846 boot safe-state, which returns Err at 4837-4839 on failure
  - OS consumers trust is-active: Suderra-OS package/suderra-rauc-config/suderra-rauc-health-gate:25-29 (RAUC mark-good decision), suderra-edge-install:292, suderra-lockdown:37-38
- **Kök neden:** Readiness is signalled at the end of async_main's pre-runtime init instead of at the 'outputs safe, control running' milestone. The notifier is not wired into run_agent.
- **Mimari düzeltme yönü:** Emit READY from run_agent only after safe-state is applied and the control loops have started, through a ReadyGate passed in from main. During activation, send STATUS= and EXTEND_TIMEOUT_USEC=. OS health gates should check an explicit agent health state rather than is-active alone.
- **Doğrulama:** Notify-socket integration test: READY arrives after the safe-state-applied event. Fault-inject a safe-state failure: the unit never becomes active and suderra-rauc-health-gate fails.

<a id="EDGE-HIGH-052"></a>

### EDGE-HIGH-052 — Watchdog heartbeat is a fixed-interval timer that ignores control-loop health, so a stalled I/O or control loop is never detected

- **Önem:** HIGH · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway main.rs watchdog heartbeat task
- **Köken:** doğrulanan iddia T10 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/main.rs:4245-4254`, `sens-api-gateway/src/main.rs:3148`, `sens-api-gateway/src/main.rs:3772-3774`
- **Kanıt (ayrıntı):**
  - aquaculture_platform/sens-api-gateway/src/main.rs:4245-4254 loop { sleep(interval); notify(Watchdog) } with no health input
  - main.rs:3148 multi-thread runtime: the ping task runs on worker threads while run_agent and control run on the LocalSet (main.rs:3772-3774), so a deadlocked LocalSet does not stop pings
  - No liveness or last-cycle tracking in io_poll.rs or health.rs (grep)
- **Kök neden:** The watchdog is treated as a 'process alive' heartbeat rather than proof that the control loops are live.
- **Mimari düzeltme yönü:** Add a LivenessRegistry: the io_poll scan loop, command dispatcher, MQTT event loop and safe-state supervisor each register a deadline and check in. The notifier sends WATCHDOG=1 only when every check-in is fresh; otherwise it stops pinging and logs the stalled loop, so systemd restarts the agent and safe-state runs.
- **Doğrulama:** Unit test with a fake clock: io_poll stops checking in and no ping is emitted. Integration: inject a deadlock in the LocalSet and assert systemd kills the agent within WatchdogSec.

<a id="EDGE-HIGH-053"></a>

### EDGE-HIGH-053 — The agent has no piControl/PiBridge I/O backend: ProtocolConfig has no piControl variant and /dev/piControl0 is used only for read-only discovery, so RevPi Connect 4 expansion-module DIO/AIO (the primary target) cannot be read or driven

- **Önem:** HIGH · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway process_image.rs / hardware_scanner.rs (RevPi I/O)
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/process_image.rs:183-207`, `sens-api-gateway/src/commands/read.rs:16`, `sens-api-gateway/src/hardware_scanner.rs:4`, `Suderra-OS/package/suderra-edge-agent/suderra-agent.service:63-76`
- **Kanıt (ayrıntı):**
  - Spot-checked: sens-api-gateway/src/process_image.rs:183-207 ProtocolConfig = Gpio | Modbus | I2c | Spi | Uart only, no piControl variant
  - Spot-checked: grep of src finds piControl only in hardware_scanner.rs (existence checks :328/:445, piTest parsing :434-470) and doc comments in commands/read.rs:16,146; no KB_* ioctl or process-image read/write
  - hardware_scanner.rs:4,18 'All hardware access is read-only (... piTest stdout parsing)'; /usr/bin/piTest is not shipped by Suderra OS
  - The gpio feature uses rppal (BCM GPIO) only
  - Suderra-OS package/suderra-edge-agent/suderra-agent.service:63-76 DevicePolicy=closed with no DeviceAllow for /dev/piControl0; grep of Suderra-OS (excluding buildroot/) finds piControl/piTest only in docs/architecture/ADR-0008-edge-agent-integration-contract.md
  - OS-side counterpart (no KUNBUS kernel/piControl module, no RevPi DT) is claim T112
- **Kök neden:** The I/O model was built around RPi BCM GPIO (rppal), I2C, SPI and Modbus; RevPi support stopped at hardware discovery (piTest -d parsing), and no process-image backend exists.
- **Mimari düzeltme yönü:** Make it impossible to ship unsupported: add a PiControl{offset, bit, length} ProtocolConfig variant and a PiControlBackend (KB_* ioctls on /dev/piControl0, offsets from config.rsc) behind the same I/O trait, with safe-state and authz going through it; pair it with the OS-side KUNBUS driver and DeviceAllow (T112). HIL test with DIO/AIO modules.
- **Not:** Incidental finding (merged from 4 raw report(s)); area=agent.

<a id="EDGE-HIGH-054"></a>

### EDGE-HIGH-054 — Config-integrity Enforcing mode rejects the same signed config on the second boot: the version gate is strictly greater-than and the accepted version is persisted as highest-seen on the first boot

- **Önem:** HIGH · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway config_integrity verify.rs / verify_runtime.rs
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/config_integrity/verify.rs:44-50`, `sens-api-gateway/src/config_integrity/verify_runtime.rs:203-211`, `sens-api-gateway/src/main.rs:3323-3337`
- **Kanıt (ayrıntı):**
  - Spot-checked: sens-api-gateway/src/config_integrity/verify.rs:44-50 'Gate 2 — strict monotonic version' rejects config_version <= highest_seen_config_version (test rejects_equal_config_version :120)
  - Spot-checked: config_integrity/verify_runtime.rs:203-211 calls save_highest_seen_version(data_dir, version) on success; :269 the next boot loads it
  - sens-api-gateway/src/main.rs:3323-3337 Enforcing failure -> std::process::exit(1)
- **Kök neden:** Rollback protection was modelled as "every boot must see a newer version" instead of "never accept a version lower than the highest accepted".
- **Mimari düzeltme yönü:** Accept version >= highest_seen when the digest matches the previously accepted artifact for that version, and reject only lower versions. Test: boot twice with the same signed config in Enforcing; a lower version still fails.
- **Not:** Incidental finding (merged from 1 raw report(s)); area=agent.

<a id="EDGE-HIGH-055"></a>

### EDGE-HIGH-055 — The agent rewrites the factory-signed config.yaml (activation, config topic, Modbus provisioning) without refreshing the integrity sidecar, so the next Enforcing boot fails the digest check and exits

- **Önem:** HIGH · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway config.rs save() / config_integrity
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/config_integrity/verify_runtime.rs:245-252`, `sens-api-gateway/src/main.rs:3306-3333`, `sens-api-gateway/src/config.rs:4238-4290`, `sens-api-gateway/src/main.rs:4596-4597`, `sens-api-gateway/src/commands/config_dispatch.rs:78-81`, `sens-api-gateway/src/commands/provision.rs:111`, `sens-api-gateway/src/main.rs:4290-4293`
- **Kanıt (ayrıntı):**
  - Spot-checked: config_integrity/verify_runtime.rs:245-252 compares the SHA-256 of the config.yaml bytes against the signed sidecar; main.rs:3306-3333 verifies the hardcoded /etc/suderra/config.yaml + .sig at boot and exits(1) in Enforcing
  - config.rs:4238-4290 save()/save_to rewrite the whole YAML and never refresh the sidecar. Callers: activation (main.rs:4596-4597, 4677), config topic (commands/config_dispatch.rs:78-81), Modbus provisioning (commands/provision.rs:111, 201)
  - main.rs:4290-4293 claims 'systemctl reload sends SIGHUP', but no shipped unit defines ExecReload
  - The SIGHUP-skips-integrity part of incidental #24 is covered by claim T30
- **Kök neden:** One file is modelled as both factory-signed immutable input and agent-mutable state (credentials, tenant id, provisioned devices).
- **Mimari düzeltme yönü:** Make it impossible: split a signed read-only base config from an agent-owned state/overlay store in the data dir with typed merge precedence; save() can only write the mutable store. Run the same integrity verifier on every load path including SIGHUP, and add ExecReload= only if reload is a supported contract. Test: Enforcing, activate, reboot, integrity passes.
- **Not:** Incidental finding (merged from 4 raw report(s)); area=agent.

<a id="EDGE-HIGH-056"></a>

### EDGE-HIGH-056 — SCADA process/package deploy signatures cover only the claimed artifactSha256; the edge never hashes the deployed content, so any previously signed (signature, sha256) pair verifies arbitrary content

- **Önem:** HIGH · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway commands/system.rs + scripting/deploy_sig.rs
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/scripting/deploy_sig.rs:220-230`, `sens-api-gateway/src/commands/system.rs:310-328`
- **Kanıt (ayrıntı):**
  - Spot-checked: sens-api-gateway/src/scripting/deploy_sig.rs:220-230 verify_deploy_signature verifies canonical_bytes(DeploySigBody{kind, tenant_id, artifact_sha256_hex})
  - Spot-checked: src/commands/system.rs:310-328 (cmd_deploy_process) and :446-471 (cmd_deploy_scada_package) read params.artifactSha256 and call scada_state.deploy_process/package without hashing process/package/params (no sha2 use in system.rs)
  - Any previously signed (signature, artifactSha256) pair for the tenant can be attached to arbitrary content and is logged as 'signature verified (artifact sha256 bound)'
  - Currently reachable only with a co-approved signed envelope (DeployProgram two-person gate), which the cloud never produces (T118)
- **Kök neden:** Signature verification and content integrity are separate steps and the second (recomputing the artifact hash from the bytes being applied) was never implemented.
- **Mimari düzeltme yönü:** Make it impossible: verify the signature over a hash the edge computes itself from the canonical bytes it will apply, and accept only a typed VerifiedArtifact in deploy_process/deploy_scada_package (or route these deploys through the bundle path that already recomputes per-artifact sha256).
- **Not:** Incidental finding (merged from 1 raw report(s)); area=agent.

<a id="EDGE-HIGH-057"></a>

### EDGE-HIGH-057 — HMI emergency stop with no package or no control_permissions.emergency_stop de-energises nothing but reports success and broadcasts "emergency active" to every HMI

- **Önem:** HIGH · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway scada_server.rs emergency stop
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/scada_server.rs:1901-1909`, `sens-api-gateway/src/scada_server.rs:1984-1990`, `sens-api-gateway/src/scada_server.rs:1995-2000`
- **Kanıt (ayrıntı):**
  - Spot-checked: sens-api-gateway/src/scada_server.rs:1901-1909 affected_tags = unwrap_or_default() when the package has no control_permissions.emergency_stop, or Vec::new() when no package is deployed
  - With an empty list the loop does nothing; scada_server.rs:1984-1990 reports success = failed_tags.is_empty() = true with totalTags 0
  - scada_server.rs:1995-2000 broadcasts {type: 'emergency', active: true} to all HMIs
- **Kök neden:** The e-stop scope is optional package data that defaults to an empty list, and success is defined as "no failures" rather than "every actuator reached the stop state".
- **Mimari düzeltme yönü:** Make it impossible: derive the e-stop scope from the live actuator registry (every registered output) unless a package explicitly narrows it, reject an empty scope at package validation, and return an error when zero outputs were resolved.
- **Not:** Incidental finding (merged from 2 raw report(s)); area=agent.

<a id="EDGE-HIGH-058"></a>

### EDGE-HIGH-058 — Graceful shutdown releases GPIO outputs right after driving them to safe state: rppal OutputPin defaults to reset_on_drop=true and the agent never disables it, so dropping the actor returns every pin to its previous (input) mode

- **Önem:** HIGH · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway gpio.rs GPIO actor (rppal)
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/gpio.rs:484`, `sens-api-gateway/src/pwm.rs:425`, `sens-api-gateway/src/gpio.rs:152-157`, `sens-api-gateway/src/main.rs:3773-3783`, `sens-api-gateway/src/main.rs:5953-5967`, `sens-api-gateway/src/gpio.rs:694-697`
- **Kanıt (ayrıntı):**
  - Spot-checked: rppal-0.17.1 src/gpio/pin.rs:200-216 Drop restores prev_mode (and clears bias) when reset_on_drop is true; :592-606 OutputPin::new sets reset_on_drop: true and records prev_mode
  - Spot-checked: sens-api-gateway/src/gpio.rs:484 into_output() and pwm.rs:425 into_output() never call set_reset_on_drop(false)
  - gpio.rs:152-157 the actor is spawned with spawn_local; main.rs:3773-3783 async_main returns after local.run_until(run_agent), dropping the LocalSet and the actor right after the shutdown safe-state at main.rs:5953-5967
  - gpio.rs:694-697 reconfigure also clears output_pins (see claim T18)
  - Latent in shipped binaries because release builds lack the gpio feature (claim T17)
- **Kök neden:** Pin ownership lifetime equals process lifetime and the library default (restore previous mode on drop) contradicts the fail-safe contract that the safe level persists after the agent exits.
- **Mimari düzeltme yönü:** Construct outputs with set_reset_on_drop(false), or hold safe levels with a kernel-owned mechanism (gpio-hog / DT overlay or a supervisor-held gpiochip line); make persistence part of the per-actuator FailSafe policy. HIL test: read the pin level after `systemctl stop`.
- **Not:** Incidental finding (merged from 1 raw report(s)); area=agent.

<a id="EDGE-HIGH-059"></a>

### EDGE-HIGH-059 — In RBAC Enforcing mode the agent rejects its own previously accepted manifest on every reboot (strict policy_version > floor), so the boot exits independently of /etc writability

- **Önem:** HIGH · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway authz manifest_common.rs / manifest_runtime.rs boot load
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/authz/manifest_common.rs:143-148`, `sens-api-gateway/src/authz/manifest_runtime.rs:172-181`, `sens-api-gateway/src/main.rs:1808-1809`, `sens-api-gateway/src/authz/manifest_runtime.rs:161`, `sens-api-gateway/src/main.rs:3508-3514`, `sens-api-gateway/src/authz/manifest_runtime.rs:241-243`
- **Kanıt (ayrıntı):**
  - Spot-checked: sens-api-gateway/src/authz/manifest_common.rs:143-148 'Strictly greater' -> StalePolicyVersion when policy_version <= highest_seen
  - Spot-checked: manifest_runtime.rs:172-181 boot load_from_file_inner -> verify_and_floor, which reads vs.get_highest_seen() (:226-229) and calls record_accepted(verified.policy_version) (:240-247) on the first boot
  - main.rs:1808-1809 boot load; manifest_runtime.rs:161 Enforcing + Err -> main.rs:3508-3514 exit(1)
  - manifest_runtime.rs:241-243 comment claims 'idempotent on re-load of the same manifest across a process restart', which contradicts the gate; tests/invariants/rbac_hot_reload.rs has no restart/re-load test
  - Related to claim T03 (floor advanced before the manifest is persisted), but this boot loop occurs even when the manifest is persisted correctly
- **Kök neden:** Ingestion semantics (strictly newer) are reused for boot re-verification of an already-accepted artifact, and record_accepted ratchets the floor to that same version on the first boot.
- **Mimari düzeltme yönü:** Separate verify_for_ingest (strict >) from verify_for_reload (>= floor and same digest as the last accepted manifest); persist the accepted digest next to the floor. Test: accept v5, restart, Enforcing boot succeeds; replaying v4 fails.
- **Not:** Incidental finding (merged from 1 raw report(s)); area=agent.

<a id="EDGE-HIGH-060"></a>

### EDGE-HIGH-060 — The safe-state output registry is built once at boot, so outputs added by provision_modbus_device or a SIGHUP config reload are never driven to safe state at shutdown

- **Önem:** HIGH · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway main.rs SafeStateManager lifecycle
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/main.rs:4799-4802`, `sens-api-gateway/src/main.rs:5960`, `sens-api-gateway/src/commands/provision.rs:107-109`, `sens-api-gateway/src/main.rs:4374-4375`
- **Kanıt (ayrıntı):**
  - Spot-checked: sens-api-gateway/src/main.rs:4799-4802 builds SafeStateManager::from_config once into a local; main.rs:5960 applies the same instance at shutdown
  - Spot-checked: src/commands/provision.rs:107-109 provision_modbus_device pushes into state.config.modbus at runtime without touching the manager
  - main.rs:4374-4375 SIGHUP replaces state_guard.config; only the LoRa actor is restarted (:4376-4410), with no hardware or safe-state rebuild
- **Kök neden:** The registry is a boot-time snapshot of config rather than being derived from the live output set held in AppState.
- **Mimari düzeltme yönü:** Make it automatic: register each output with its FailSafe policy in the output layer when it is constructed (or rebuild the registry atomically on every config/provisioning change) so shutdown safe-state always iterates live outputs. Test: SIGHUP/provision adds an output, shutdown drives it safe.
- **Not:** Incidental finding (merged from 2 raw report(s)); area=agent.

<a id="EDGE-HIGH-061"></a>

### EDGE-HIGH-061 — Agents with no writable outputs (sensor-only Modbus with allow_writes=false, input-only GPIO, any I2C) abort boot with "safe-state could not be applied" and crash-loop

- **Önem:** HIGH · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway main.rs boot safe-state gate / safe_state.rs
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/safe_state.rs:139-142`, `sens-api-gateway/src/safe_state.rs:205-207`, `sens-api-gateway/src/config.rs:1528-1530`, `sens-api-gateway/src/main.rs:4824-4842`, `sens-api-gateway/src/main.rs:3777-3779`
- **Kanıt (ayrıntı):**
  - Spot-checked: sens-api-gateway/src/safe_state.rs:139-142 apply() returns 0 when no output tags are registered
  - Spot-checked: safe_state.rs:205-207 collects Modbus outputs only if security.allow_writes, and config.rs:1528-1530/:1586 allow_writes defaults to false; input GPIO is skipped (:246-258) and I2C is never collected (:108-118)
  - Spot-checked: main.rs:4824-4842 `if safe_count == 0 && (!gpio.is_empty() || !modbus.is_empty() || !i2c.is_empty())` -> return Err; main.rs:3777-3779 exit(1); OS unit Restart=on-failure RestartSec=5s
  - So a water-quality monitoring node with sensor-only Modbus or Atlas EZO I2C never reaches runtime
- **Kök neden:** The boot gate compares the safe-state success count against "any hardware configured" instead of against the number of registered output tags; apply() returns a bare count, so "no outputs exist" is indistinguishable from "all outputs failed".
- **Mimari düzeltme yönü:** Make it impossible: SafeStateManager::apply returns a typed report {registered, succeeded, failed}; the gate requires failed.is_empty() and treats registered==0 as trivially safe. Add unit tests for input-only GPIO, a read-only Modbus device and an I2C-only config.
- **Not:** Incidental finding (merged from 2 raw report(s)); area=agent.

<a id="EDGE-HIGH-062"></a>

### EDGE-HIGH-062 — MQTT set_output writes every Modbus tag as an FC05 coil (value != 0), ignoring register_type/IoType, routes by the first slave_id match, and records the analog value as Good

- **Önem:** HIGH · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway commands/io_config.rs cmd_set_output
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/commands/io_config.rs:186-209`, `sens-api-gateway/src/commands/io_config.rs:194-199`, `sens-api-gateway/src/commands/io_config.rs:235-243`, `sens-api-gateway/src/main.rs:5660-5676`
- **Kanıt (ayrıntı):**
  - Spot-checked: sens-api-gateway/src/commands/io_config.rs:186-209 matches ProtocolConfig::Modbus{slave_id, register, function: _, register_type: _} and always calls handle.write_coil(&device.name, *register, value != 0.0)
  - An AO setpoint is written as an FC05 coil on/off at the same address (a different object, possibly an unrelated relay) and the analog value is lost
  - io_config.rs:194-199 the device is the first `find(|d| d.slave_id == slave_id)`, ambiguous when several Modbus TCP devices use unit id 1
  - io_config.rs:235-243 the process image is updated with the commanded analog value and TagQuality::Good
  - The HMI executor does distinguish DO/AO (main.rs:5660-5676), so the two ingress paths are inconsistent
- **Kök neden:** Each ingress path improvises its own tag-to-device-to-function mapping; ProtocolConfig::Modbus carries no resolved device identity and the register_type/function fields are deliberately ignored in this path.
- **Mimari düzeltme yönü:** Make it impossible: one OutputWriter/TagWriter resolves (device_id, WriteOp Coil|HoldingRegister{width, signed}, scaling) from TagConfig at load time and is the only write path for HMI, MQTT, scripts and e-stop. Tests: an AO tag issues FC06/FC16 with the scaled value; two TCP devices with the same unit id route by device_id.
- **Not:** Incidental finding (merged from 3 raw report(s)); area=agent.

<a id="EDGE-HIGH-063"></a>

### EDGE-HIGH-063 — write_modbus is authorised against params.slave_id/address but executes against the separate params.device name, so a ModbusWrite grant for one device writes any device

- **Önem:** HIGH · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway commands/catalog.rs + commands/write.rs
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/commands/catalog.rs:94-117`, `sens-api-gateway/src/commands/write.rs:49-58`
- **Kanıt (ayrıntı):**
  - Spot-checked: sens-api-gateway/src/commands/catalog.rs:94-117 ModbusWriteParam builds Permission::ModbusWrite from params.slave_id|slaveId|device_id|deviceId|unit_id|unitId + address
  - Spot-checked: src/commands/write.rs:49-58 the handler takes params.device (a name) and :120 calls handle.write_register(device_name, address, value); slave_id is never checked against the named device
  - An operator granted ModbusWrite{device 5, reg 100} can target any device name at register 100; only the device-local allowed_write_ranges remains as a backstop
- **Kök neden:** The authorization subject is extracted from different fields than the ones the handler acts on; no typed command target is parsed once and shared by authz and execution.
- **Mimari düzeltme yönü:** Make it impossible: parse params once into a typed WriteModbusCommand{device: ModbusDeviceRef, address, value}; derive the Permission from that struct and pass the same struct to the handler. Test: a grant for device 5 cannot write device "pump-2".
- **Not:** Incidental finding (merged from 1 raw report(s)); area=agent.

<a id="EDGE-HIGH-064"></a>

### EDGE-HIGH-064 — reboot/restart_agent shell out to shutdown/systemctl as unprivileged user suderra with no polkit; they always fail but report success

- **Önem:** HIGH · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway commands/system.rs (reboot, restart_agent)
- **Köken:** doğrulanan iddia T11 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/commands/system.rs:105-109`, `sens-api-gateway/src/commands/system.rs:118-130`, `sens-api-gateway/src/commands/firmware.rs:473-475`, `sens-api-gateway/systemd/suderra-agent.service:17-18`, `Suderra-OS/configs/suderra_aarch64_revpi4_prod_ab_defconfig:83`
- **Kanıt (ayrıntı):**
  - aquaculture_platform/sens-api-gateway/src/commands/system.rs:105-109 Command::new("shutdown").args(["-r","now"]); :163-166 Command::new("systemctl").args(["restart","suderra-agent"])
  - system.rs:118-130 and :175-183 return success=true, 'scheduled', before the outcome is known; failures are only logged locally
  - commands/firmware.rs:473-475 same systemctl restart after OTA
  - Suderra-OS suderra-agent.service:17-18 User=suderra; :26-28 CapabilityBoundingSet=CAP_NET_BIND_SERVICE only; :24 NoNewPrivileges; :59 SystemCallFilter=~... @reboot @privileged
  - No BR2_PACKAGE_POLKIT in any defconfig (configs/suderra_aarch64_revpi4_prod_ab_defconfig:83 DBUS only; :59 logind disabled)
  - The real blocker is PID1 authorization: systemctl/shutdown talk to PID1 over D-Bus or the private socket, and unprivileged callers are denied without polkit. The @reboot filter only blocks reboot(2) inside the agent.
- **Kök neden:** Privileged lifecycle actions are written as shell-outs that assume a root agent. The hardened unit dropped privileges without adding a privileged broker.
- **Mimari düzeltme yönü:** Add a privileged action broker: root-owned oneshot units (suderra-reboot.service, suderra-agent-restart.service) triggered through an allowlisted, audited request channel (for example a .path unit on an agent-writable /run/suderra/requests, or a minimal root service restricted to uid 200). For restart, an alternative is a dedicated exit code with RestartForceExitStatus=. Report the real outcome (boot_id or MainPID change) back to the cloud.
- **Doğrulama:** QEMU: a reboot command yields a new boot_id and a 'completed' result; restart_agent changes MainPID. Negative test: no request means no action, and failures are reported as success=false.

<a id="EDGE-HIGH-065"></a>

### EDGE-HIGH-065 — No communications-loss output policy: actuators hold their last commanded state indefinitely when cloud or bus links drop

- **Önem:** HIGH · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway safe-state / MQTT / io_poll
- **Köken:** doğrulanan iddia T19 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/safe_state_v2.rs:116-147`, `sens-api-gateway/src/main.rs:4820`, `sens-api-gateway/src/main.rs:5960`, `sens-api-gateway/src/command_envelope/mutating.rs:36`, `sens-api-gateway/src/commands/audit_emit.rs:113`, `sens-api-gateway/src/commands/dispatch_lifecycle.rs:264-387`, `sens-api-gateway/src/safe_state.rs:23-25`
- **Kanıt (ayrıntı):**
  - Searching src for comm-loss, cloud-loss, link-loss, on_disconnect, hold_last, heartbeat_timeout and fallback_output finds nothing outside dead safe_state_v2 types (safe_state_v2.rs:116-147)
  - SafeStateManager is applied only at boot (main.rs:4820) and shutdown (main.rs:5960). No other call site exists
  - There is no `safe_state_trigger` handler: it is listed in command_envelope/mutating.rs:36 and audit_emit.rs:113, but has no catalog entry and no dispatch arm (dispatch_lifecycle.rs:264-387)
  - safe_state.rs:23-25 claims the IEC 62443 FR7 requirement 'fail to a safe state upon loss of communication' is addressed
  - mqtt_failover.rs and the MQTT event loop only track the connection state and never touch outputs
- **Kök neden:** Fail-safe behaviour was modelled only as a process-lifecycle event (boot and graceful shutdown). It was not a supervised runtime invariant over link freshness, so no component owns 'what outputs do when the commander disappears'.
- **Mimari düzeltme yönü:** Make it automatic: add a runtime supervisor that owns per-output staleness policy (from the v2 FailSafe/FailSafeOnStale model): hold-for-N-seconds then go to the safe value, process-aware fallbacks, and a separate policy for cloud loss versus field-bus loss. Each cloud-originated write carries a lease/TTL. When the lease expires without renewal, the supervisor drives the output to its configured fail-safe. Also configure the hardware output watchdogs (Modbus device comm-loss timers, RevPi module watchdog) so a crashed agent also fails safe.
- **Doğrulama:** Integration test with a mock broker: set_output a cloud-commanded tag, cut the broker connection, and assert the output reaches its configured safe value within lease + grace. Repeat with the Modbus slave disconnected. HIL: kill -9 the agent and assert the hardware watchdog drops the outputs.

<a id="EDGE-HIGH-066"></a>

### EDGE-HIGH-066 — A full offline queue refuses new Critical alarms the same way as telemetry

- **Önem:** HIGH · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway offline_queue.rs
- **Köken:** doğrulanan iddia T21 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/offline_queue.rs:379-386`, `sens-api-gateway/src/offline_queue.rs:721-728`, `sens-api-gateway/src/publish_helpers.rs:158-171`, `sens-api-gateway/src/offline_queue.rs:696-699`, `sens-api-gateway/src/offline_queue.rs:603-611`
- **Kanıt (ayrıntı):**
  - src/offline_queue.rs:379-386 QueueFullError says 'message REFUSED, not evicted'
  - src/offline_queue.rs:721-728 `if current_size >= self.max_size { return Err(QueueFullError Rows) }` and :731-740 the disk-bytes refusal. The `priority` argument is not consulted before refusing
  - src/publish_helpers.rs:158-171 publish_alarms routes at MessagePriority::Critical into the same enqueue
  - Doc/code contradiction: offline_queue.rs:696-699 says 'the oldest low-priority messages are removed'
  - get_db_size (offline_queue.rs:603-611) uses page_count*page_size, which includes freelist pages, so the disk-bytes cap can stay reached after a drain until VACUUM runs
- **Kök neden:** Task 1.7 fixed silent telemetry eviction by making the queue uniformly refusing. Admission control was never split by priority class, so a fixed capacity shared with high-volume telemetry blocks life-safety alarms after a long outage.
- **Mimari düzeltme yönü:** Make it impossible: give each priority class its own reserved capacity (separate tables or quota), so Normal telemetry can never consume the Critical/High budget. Critical admission may evict Normal rows (with an explicit, audited eviction counter) or use an alarm-state compaction model where the latest state per alarm id is always kept. Fix the doc comment and count freelist correctly (page_count - freelist_count).
- **Doğrulama:** Unit: fill the queue to max with Normal rows, then enqueue Critical and assert Ok and that the Critical row drains first. Fill the Critical quota with Normal traffic still flowing and assert Normal is refused while Critical is admitted. Test that the disk cap releases after a drain.

<a id="EDGE-HIGH-067"></a>

### EDGE-HIGH-067 — The SCADA emergency stop is an in-memory flag that only the HMI WebSocket path honours and that clears on agent restart

- **Önem:** HIGH · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway scada_server.rs
- **Köken:** doğrulanan iddia T22 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/scada_server.rs:286`, `sens-api-gateway/src/scada_server.rs:1898`, `sens-api-gateway/src/scada_server.rs:1919-1926`, `sens-api-gateway/src/scada_server.rs:1565-1585`, `sens-api-gateway/src/scripting/engine.rs:1522`, `sens-api-gateway/src/safe_state_v2.rs:112-117`
- **Kanıt (ayrıntı):**
  - src/scada_server.rs:286 `emergency_active: AtomicBool` and :288 `emergency_tags: RwLock<Vec<String>>`, initialised false at :312/:362
  - src/scada_server.rs:1898 store(true) and :2106 store(false). Persistence is only an audit row (:1965-1974, :2111); the latch is never restored at boot
  - emergency_active is read only inside scada_server.rs (:1411 handle_command_or_setpoint). grep shows no check in MQTT set_output/write_gpio/write_modbus, the script engine or the bytecode runner, so cloud commands and running programs can re-energise during an e-stop
  - src/scada_server.rs:1919-1926 the e-stop writes 0.0 to every affected tag, ignoring per-actuator safe_state_value (life-support fail-ON)
- **Kök neden:** The e-stop was implemented as a UI-session feature of the HMI server, not as a device-wide safety state owned by the output layer. Its lifetime is the process and its scope is one ingress path.
- **Mimari düzeltme yönü:** Make it impossible: move the e-stop latch into the single actuator-write chokepoint (one OutputGate that all writers go through: MQTT, HMI, scripts, bytecode, force). Persist it durably (SQLCipher, fsynced before acknowledging) and restore it before any control runtime starts. It is cleared only by an authenticated reset. E-stop values come from per-actuator configured e-stop/safe values, not a literal 0.0.
- **Doğrulama:** Integration: trigger the e-stop, then send MQTT set_output and run a script writing the same tag. Assert both are rejected. Restart the agent and assert the latch is still active and outputs are held. The reset path requires a PIN/auth.

<a id="EDGE-HIGH-068"></a>

### EDGE-HIGH-068 — In Permissive or Disabled mode, an unsigned envelope's self-asserted actor is trusted as the RBAC subject

- **Önem:** HIGH · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway command_envelope/envelope.rs + commands/envelope_adapter.rs
- **Köken:** doğrulanan iddia T24 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/command_envelope/envelope.rs:433`, `sens-api-gateway/src/commands/envelope_adapter.rs:253-266`, `sens-api-gateway/src/commands/envelope_adapter.rs:282-300`, `sens-api-gateway/src/commands/mqtt_dispatch.rs:180-195`
- **Kanıt (ayrıntı):**
  - src/command_envelope/envelope.rs:433 `(Disabled, _, _) => {}` and :441 `(Permissive, None, _) => {}` accept with no signature
  - src/commands/envelope_adapter.rs:253-266 an unsigned but accepted envelope becomes AdaptedCommand with `actor: env.actor` (wire-supplied)
  - src/commands/envelope_adapter.rs:282-300 authorize_adapted builds `ActorIdentity::Operator(OperatorId::new_from_verified(adapted.actor))`, labelled 'verified' though nothing verified it
  - mqtt_dispatch.rs:180-195 RBAC Allow on that actor leads to execution, and audit/attribution records the spoofed operator. Operator UUIDs are not secret (manifest bindings)
- **Kök neden:** The type `OperatorId::new_from_verified` is constructed from unverified wire bytes. Authentication outcome (signature verified vs absent) is not carried in the type passed to authorization.
- **Mimari düzeltme yönü:** Make it impossible: verify_envelope returns `VerifiedActor` only when the signature verified. Unsigned acceptance yields `UnauthenticatedActor`, and the policy engine's authorize() only accepts VerifiedActor. Remove `new_from_verified` from any wire-parsing path (crate-private constructor callable only from the signature-verify closure).
- **Doğrulama:** Unit: an unsigned Permissive envelope with actor = an admin UUID from the manifest is denied (or rejected at compile level by type). Assert the audit entry records 'unauthenticated' rather than the claimed actor.

<a id="EDGE-HIGH-069"></a>

### EDGE-HIGH-069 — SCADA HMI has no mandatory authentication, and the optional WS token cannot be used by the bundled browser HMI

- **Önem:** HIGH · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway/src/scada_server.rs (SCADA HMI HTTP+WS)
- **Köken:** doğrulanan iddia T32 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/scada_server.rs:2233-2246`, `sens-api-gateway/src/scada_server.rs:1100-1124`, `sens-api-gateway/static/scada-edge.html:504`, `sens-api-gateway/systemd/suderra-display.service:50`, `sens-api-gateway/src/scada_server.rs:2252-2283`, `sens-api-gateway/src/scada_server.rs:2277-2288`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/scada_server.rs:2233-2246 every route (/scada/process, /scada/tags, /scada/trends, /scada/alarms, /scada/alarms/history, /ws/scada) is registered with only a CORS layer and the security-headers middleware. There is no auth layer.
  - sens-api-gateway/src/scada_server.rs:1100-1124 the Bearer check runs only when env SUDERRA_SCADA_AUTH_TOKEN is set and non-empty. When it is unset, the only gate is the Origin header check (1076-1090), which any non-browser client can forge. is_private_network_origin (719-744) accepts any RFC1918/127.x origin.
  - sens-api-gateway/static/scada-edge.html:504 `var ws = new WebSocket(url);` sends no credential. The browser WebSocket API cannot set an Authorization header, so turning on the token locks out the bundled HMI and the kiosk (sens-api-gateway/systemd/suderra-display.service:50 --app=http://localhost:6526/scada).
  - sens-api-gateway/src/scada_server.rs:2252-2283 the default bind is 127.0.0.1, so any local process/UID can drive outputs. The docstring recommends SUDERRA_SCADA_BIND=<OT NIC> for production, which hands Command/Setpoint/EmergencyStop/Calibrate/AlarmAck to every host on the OT LAN (handlers at 1368-1392).
- **Kök neden:** The HMI was designed with 'Origin header + bind address' as its trust boundary. Authentication was added later as an opt-in env var, and it uses a header that browser WebSockets cannot send. Enabling it breaks the shipped client, so the unauthenticated default stays in place.
- **Mimari düzeltme yönü:** Make an authenticated operator session a type-level precondition for every mutating WS handler. Use an `AuthenticatedOperator` extractor that can only be built by verifying credentials from the signed user-token manifest. Deliver the session as an HttpOnly SameSite=Strict cookie or as a first-message/subprotocol token the bundled HMI actually sends. Remove the env-var opt-in. Refuse any non-loopback bind unless auth (and TLS) is configured, failing closed like the health server's ExternalBindNoKey path.
- **Doğrulama:** Router-level tests with tower::ServiceExt: a WS upgrade with no credential returns 401, and GET /scada/tags with no session returns 401. A Playwright e2e test logs into the bundled HMI and shows the WS connects with a session. A unit test shows start_scada_server refuses a non-loopback bind without auth configured.
- **Not:** Adversarial re-check rated HIGH (verifier CRITICAL): TITLE: SCADA HMI WebSocket has no mandatory authentication, and the optional token cannot be sent by the bundled browser client. VERDICT: the code facts are CONFIRMED. There is no auth layer on any route. The Bearer check runs only when the env var SUDERRA_SCADA_AUTH_TOKEN is non-empty. The browser `new WebSocket(url)` cannot set an Authorization header, so enabling the token locks out the shipped HMI and the kiosk. Origin is the only gate. COUNTER-EVIDENCE that lowers real-world severity from CRITICAL to HIGH: (1) The default bind is 127.0.0.1, and nothing in either repo or in Suderra-OS sets SUDERRA_SCADA_BIND or SUDERRA_SCADA_AUTH_TOKEN (repo-wide grep finds them only in scada_server.rs). (2) The Suderra-OS nftables input chain is `policy drop` and accepts only lo, so even an OT-NIC bind cannot be reached from the LAN on Suderra-OS. (3) Suderra-OS ships no display stack (no cage or chromium in any defconfig). The OS-baked agent is also built without the scada-display feature (suderra-edge-agent.mk passes only `--bin`, and default features are [health]). Only OTA release binaries (EDGE_RELEASE_FEATURES=scada-display) contain the server. (4) 'Calibrate' is effectively harmless: the result is computed with reference=raw and never applied. In shipped configurations, unauthenticated actuator control is therefore open to any local process or UID on the device. It reaches the whole OT LAN only in the documented OT-NIC deployment on a host without the Suderra-OS firewall. Unauthenticated AlarmAck, EmergencyStop and Command/Setpoint are real. ROOT CAUSE: the trust boundary was set as 'Origin header + bind address'. Authentication was later added as an opt-in env var on a transport (the Authorization header) that the only client cannot use, and WsSession carries no principal. FIX (architectural): make an authenticated principal a type-level precondition of the WS upgrade. build_scada_router takes an Authenticator, and the upgrade handler requires a `SessionPrincipal` extractor, so no router can be built without auth. Issue short-lived sessions from a same-origin login endpoint (operator credential or PIN verified server-side), delivered as an HttpOnly SameSite=Strict cookie or a Sec-WebSocket-Protocol token that browsers can send. Move bind and auth from env vars into validated config, and make a non-loopback bind without TLS + auth a boot-time config-coherence error. Record the principal in every audit row. TEST: an axum integration test where the upgrade without credentials returns 401, a forged Origin without a session returns 401, and a valid session returns 101. A headless-browser test runs the bundled HTML end-to-end through login and then sends a command. A config-coherence unit test checks that a non-loopback bind without auth refuses to boot.

<a id="EDGE-HIGH-070"></a>

### EDGE-HIGH-070 — SCADA WS writes bypass authz, force registry and IO-type checks, and are routed to the wrong Modbus/I2C target

- **Önem:** HIGH · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway/src/scada_server.rs + src/main.rs SCADA command executor
- **Köken:** doğrulanan iddia T33 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/scada_server.rs:1424-1434`, `sens-api-gateway/src/main.rs:5613-5715`, `sens-api-gateway/src/io_poll.rs:494`, `sens-api-gateway/src/commands/deploy_st_source.rs:113`, `sens-api-gateway/src/main.rs:5656-5658`, `sens-api-gateway/src/process_image.rs:188-193`, `sens-api-gateway/src/main.rs:5672`, `sens-api-gateway/src/main.rs:5684-5690`, `sens-api-gateway/src/i2c.rs:268`, `sens-api-gateway/src/process_image.rs:194-198`, `sens-api-gateway/src/main.rs:5694-5697`, `sens-api-gateway/src/scada_server.rs:1919-1931`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/scada_server.rs:1424-1434 with no package deployed, security_level = SecurityLevel::None and execute_command runs immediately. 'Confirm' (746-759, 1435-1452) is just a round trip to the client, which can auto-reply confirmed=true, so there is no server-side identity.
  - sens-api-gateway/src/main.rs:5613-5715 the executor checks only is_shutting_down (5628-5635). It has no authz engine, no force_registry.is_forced (compare io_poll.rs:494,517), no IoType DO/AO output check (compare commands/deploy_st_source.rs:113) and no range check against eng_min/eng_max.
  - sens-api-gateway/src/main.rs:5656-5658 the Modbus branch ignores ProtocolConfig::Modbus{slave_id,function,register_type} (process_image.rs:188-193) and always writes to `s.config.modbus.first()`, so on a multi-device site the register is written on device #0.
  - sens-api-gateway/src/main.rs:5672 `raw_value as u16` is a saturating cast: negative becomes 0, >65535 becomes 65535, NaN becomes 0.
  - sens-api-gateway/src/main.rs:5684-5690 the I2C branch calls `write_direct(&cmd.tag, ..)`, but i2c.rs:268 and 663-667 look the device up by name in device_map. ProtocolConfig::I2c{bus,address} (process_image.rs:194-198) is ignored.
  - sens-api-gateway/src/main.rs:5694-5697 on Ok the tag is written back as TagQuality::Good, so a mis-routed write is reported to the operator as a success.
- **Kök neden:** The SCADA executor was built as a separate write path instead of reusing the command pipeline (authz, force registry, output-type check, protocol routing) that MQTT and OPC UA use. Device addressing is pulled ad hoc from global config instead of from the tag's own ProtocolConfig, which carries no device name.
- **Mimari düzeltme yönü:** Create a single ActuatorWritePort as the only module that can reach the modbus/gpio/i2c handles (private constructors). Its entry point is write(AuthorizedContext, TagName, EngValue), and it enforces the E-stop interlock, force registry, output-only IO type and engineering range. Make ProtocolConfig::Modbus/I2c carry the device identity so routing is total and resolved from the tag, never from `.first()`. SCADA, MQTT, OPC UA, scripts and the VM all go through this port, and SCADA must present an AuthorizedContext from the authenticated session.
- **Doğrulama:** Unit tests with mock handles: with two Modbus devices and a tag mapped to slave 2, the write lands on device 2. Writing an AI/DI tag is rejected. A forced tag is rejected. An out-of-range or NaN value is rejected. An I2C tag write reaches the device named in its ProtocolConfig. A trybuild compile-fail test shows the protocol handles cannot be called outside the port.
- **Not:** Adversarial re-check rated HIGH (verifier CRITICAL): TITLE: The SCADA WebSocket write path skips authz and IO-type and range checks, routes Modbus writes to device #0 and I2C writes by tag name, and reports mis-routed writes as Good. VERDICT: CONFIRMED in code. (a) With no package (also after clear_package, or when the stored package fails to parse, because get_active_package uses `.ok()` and the error is swallowed), every tag gets SecurityLevel::None and executes immediately. 'Confirm' is a client round-trip with no server-side identity. (b) The executor checks only is_shutting_down. It has no authz, no force check, no DO/AO check (AI/DI Modbus tags go to write_register FC06 on device #0) and no eng_min/eng_max check. (c) It always uses `s.config.modbus.first()` and ignores slave_id. (d) `raw_value as u16` saturates, so negative values become 0 and signed INT16 registers get the wrong value. NaN is unreachable because serde_json rejects NaN. (e) I2C uses write_direct(&cmd.tag), which looks up device_map by device name. bus and address are ignored. (f) On Ok the tag is set to TagQuality::Good. Aggravation: in release and OS builds the `gpio` feature is off, so the I2C and GPIO writes are simulated no-ops that return Ok and are then marked Good (see incidental). Counter-evidence to the stated root cause: the MQTT cmd_set_output path that the claim calls the 'pipeline' to reuse also lacks force, IO-type and range checks, and also uses write_direct(tag_name). It does route Modbus by slave_id and is RBAC-gated. Severity is HIGH rather than CRITICAL only because on Suderra-OS production targets the HMI has no reachable consumer (loopback bind, inbound firewall drop, no display stack). The defect is CRITICAL-class (a silent mis-actuation reported as success) on any deployment where an operator actually uses the HMI. ROOT CAUSE: tag-to-device addressing is not a first-class resolved type. ProtocolConfig::Modbus carries slave_id but no device identity, and ProtocolConfig::I2c carries bus/address that the I2C actor does not accept. Every write path (SCADA executor, set_output, scripting engine) therefore re-derives routing ad hoc and re-implements, or skips, the output policy. FIX (architectural): add a single `OutputWriter` service that is the only holder of the protocol handles. Its only input is a `ResolvedOutputTag` built at io-config load time, carrying a device_id that is a validated FK into config.modbus, the register type, the IoType restricted to DO/AO by construction, the engineering range, the signedness and the fail-safe class. Construction fails for input tags or unresolved devices. OutputWriter::write(principal, tag, value) enforces authz, force-registry, emergency latch, range and checked integer conversion (try_from, no `as`), and returns the hardware's actual result (Simulated stays distinct from Good). The SCADA executor, set_output, OPC UA and the scripting engine all call it, and the handles become private to it so a bypass will not compile. A missing package must mean 'deny writes', not SecurityLevel::None. TEST: unit tests on ResolvedOutputTag (an AI tag is rejected; an unknown slave/device is rejected). A two-Modbus-device mock test where the write lands on device #2. Range and negative-value tests return Err. A simulated-backend test checks quality != Good. A compile-time visibility test (handles are not pub outside the writer module). A test with no package checks that writes are refused.

<a id="EDGE-HIGH-071"></a>

### EDGE-HIGH-071 — Hand-rolled OPC UA client silently downgrades to SecurityPolicy None and sends PLC passwords in clear

- **Önem:** HIGH · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway/src/plc_programming/opcua.rs (hand-rolled OPC UA client)
- **Köken:** doğrulanan iddia T45 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/plc_programming/opcua.rs:3971-3992`, `sens-api-gateway/src/plc_programming/opcua.rs:2086-2111`, `sens-api-gateway/src/commands/plc/upload.rs:168-179`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/plc_programming/opcua.rs:3971-3992 if security_mode, security_policy or cert paths are requested, the client logs a warn ('Falling back to None security') and connects anyway.
  - sens-api-gateway/src/plc_programming/opcua.rs:2086-2111 the UserNameIdentityToken password is written raw with EncryptionAlgorithm null. The 'unencrypted' warn fires only when mode==None, so a requested secure mode still sends cleartext with no warning.
  - sens-api-gateway/src/commands/plc/upload.rs:168-179 the command path uses the Default security policy and mode plus username/password from params.
- **Kök neden:** A minimal binary client was written to avoid a full SDK, and the unimplemented security features were handled with warnings instead of errors.
- **Mimari düzeltme yönü:** Fail closed: return Err whenever the requested security cannot be honoured. Replace the hand-rolled client with async-opcua's client (already a dependency) using Basic256Sha256 SignAndEncrypt and encrypted user tokens. Model the (SecurityPolicy, credentials) combination as a type that cannot express a password over None.
- **Doğrulama:** Unit test: connect() with security_mode=SignAndEncrypt returns an error from the legacy client. An integration test against an async-opcua server requiring encryption succeeds, and a packet capture shows no cleartext password.

<a id="EDGE-MEDIUM-072"></a>

### EDGE-MEDIUM-072 — ProcSubset=pid hides /proc/cpuinfo, /proc/meminfo, /proc/stat and /proc/device-tree; CPU serial, platform detection and CPU/memory telemetry silently degrade

- **Önem:** MEDIUM · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway provisioning.rs / config.rs platform detect / telemetry.rs vs unit ProcSubset=pid
- **Köken:** doğrulanan iddia T07 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/systemd/suderra-agent.service:45-46`, `sens-api-gateway/systemd/suderra-agent.service:111-112`, `sens-api-gateway/src/provisioning.rs:504-518`, `sens-api-gateway/src/config.rs:114-136`, `sens-api-gateway/src/security.rs:162-180`, `sens-api-gateway/src/telemetry.rs:78-112`, `sens-api-gateway/src/commands/system.rs:108`, `sens-api-gateway/src/commands/system.rs:228`, `sens-api-gateway/src/commands/system.rs:222`
- **Kanıt (ayrıntı):**
  - Suderra-OS rootfs-overlay suderra-agent.service:45-46 ProtectProc=invisible, ProcSubset=pid; agent repo systemd/suderra-agent.service:111-112
  - aquaculture_platform/sens-api-gateway/src/provisioning.rs:504-518 get_cpu_serial reads /proc/cpuinfo and returns None (weaker device fingerprint)
  - config.rs:114-136 detect_gpio_platform reads /proc/device-tree/model and falls through to GenericLinux (pin range 0..255); duplicate copy in security.rs:162-180
  - telemetry.rs:78-112 sysinfo refresh_all; sysinfo 0.33.1 reads /proc/stat (unix/linux/cpu.rs:62, system.rs:108), /proc/meminfo (system.rs:228), /proc/cpuinfo (cpu.rs:423); metrics end up None with no error
  - Not affected: rppal 0.17.1 system.rs:222,263 reads /sys/firmware/devicetree/base first
- **Kök neden:** The sandbox was hardened without an inventory of the agent's /proc consumers. Read failures map to Option::None, so the degradation is silent.
- **Mimari düzeltme yönü:** Read identity from one platform module using sysfs (/sys/firmware/devicetree/base/{model,serial-number}, /sys/class/dmi/id/* on x86). Take resource metrics from the unit's own cgroup v2 files or from the OS telemetry daemon. Mark metrics explicitly 'unavailable(reason)' in the telemetry schema. Add a CI job that runs the agent under the production unit's sandbox properties.
- **Doğrulama:** systemd-run -p ProcSubset=pid -p ProtectProc=invisible (CI or QEMU): assert the fingerprint contains the board serial and model, and telemetry contains CPU and memory values.

<a id="EDGE-MEDIUM-073"></a>

### EDGE-MEDIUM-073 — Tryboot backend writes /boot/firmware/autoboot.txt (outside the sandbox), hardcodes partitions 2/3 (p3 is a verity hash partition on Suderra OS), never issues a tryboot reboot, and competes with RAUC+U-Boot

- **Önem:** MEDIUM · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway updater/tryboot.rs
- **Köken:** doğrulanan iddia T14 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/updater/tryboot.rs:88`, `sens-api-gateway/systemd/suderra-agent.service:37`, `Suderra-OS/board/suderra/aarch64-revpi4/genimage-prod.cfg:43-63`, `Suderra-OS/package/suderra-rauc-config/system.conf.arm:1-12`, `sens-api-gateway/src/config.rs:2076-2081`, `Suderra-OS/package/suderra-rauc-config/system.conf.arm:3`
- **Kanıt (ayrıntı):**
  - aquaculture_platform/sens-api-gateway/src/updater/tryboot.rs:88 DEFAULT_AUTOBOOT_TXT_PATH=/boot/firmware/autoboot.txt; :92-93 slot A=2, B=3; :167-232 create_dir_all + tmp + rename; :245-265 [all]/[tryboot] boot_partition
  - No reboot("0 tryboot") or equivalent anywhere in the crate (grep)
  - Suderra-OS package/suderra-rauc-config/boot.mount.arm: FAT mounted at /boot (not /boot/firmware), umask=0077 root-only; agent unit ReadWritePaths excludes /boot (suderra-agent.service:37)
  - aarch64-revpi4/genimage-prod.cfg:43-63: p2 rootfs-a, p3 rootfs-a-verity, p4 rootfs-b, so 'slot B = partition 3' points at a dm-verity hash partition
  - OS A/B is RAUC bootloader=uboot (package/suderra-rauc-config/system.conf.arm:1-12), a second A/B authority
  - Opt-in only: default BootloaderBackend::Noop (config.rs:2076-2081)
- **Kök neden:** The agent-level A/B design predates OS RAUC integration, and nothing designates a single owner of the boot-slot state.
- **Mimari düzeltme yönü:** Delete the Tryboot backend and all agent-side bootloader manipulation. OS updates go through RAUC (D-Bus Installer) invoked by a privileged OS service; the agent only requests and reports.
- **Doğrulama:** Invariant test: no agent write paths under /boot. QEMU test: an OS update triggered by command goes through RAUC and mark-good.

<a id="EDGE-MEDIUM-074"></a>

### EDGE-MEDIUM-074 — Cold-boot rollback watchdog runs inside the agent it judges, starts late, uses wall-clock time and never reboots; it only edits partition.json

- **Önem:** MEDIUM · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway updater/watchdog.rs + spawn in run_agent
- **Köken:** doğrulanan iddia T12 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/updater/watchdog.rs:205-330`, `sens-api-gateway/src/main.rs:5409-5480`, `sens-api-gateway/src/main.rs:4795`, `sens-api-gateway/src/updater/watchdog.rs:223-228`, `sens-api-gateway/src/updater/partition_store.rs:544`, `sens-api-gateway/src/config.rs:2076-2081`, `sens-api-gateway/src/main.rs:1020`
- **Kanıt (ayrıntı):**
  - aquaculture_platform/sens-api-gateway/src/updater/watchdog.rs:205-330 watchdog_tick only calls store.apply_roll(Rollback) and bootloader.rollback_next_boot; no reboot or exec anywhere in the module (grep)
  - Spawned from run_agent at main.rs:5409-5480, after activation, MQTT, init_hardware (main.rs:4795) and OPC UA init, so a new build that crashes or hangs earlier never runs it
  - watchdog.rs:223-228 SystemTime::now() wall clock; the deadline is set at apply time, not at boot of the new slot (partition_store.rs:544,575)
  - Default backend Noop (config.rs:2076-2081; main.rs:1020, 2884-2910), so rollback is JSON-only
  - Nothing in Suderra-OS calls --confirm-active or POST /lifecycle/confirm-active (grep), so every apply auto-'rolls back' after 90 s while the same binary keeps running
- **Kök neden:** Rollback authority is placed in the very component whose health it judges, and it is not tied to the OS boot or exec chain.
- **Mimari düzeltme yönü:** Move rollback authority to the OS/root layer. The root-owned edge release manager keeps the previous release and the current symlink; an OnFailure=/boot-counter mechanism (in /data, counted in boots and CLOCK_BOOTTIME rather than wall clock) restores the previous release when the agent fails to reach readiness and liveness N times. The agent only reports.
- **Doğrulama:** QEMU: install a release that exits immediately, and one that hangs before READY. Both must be reverted automatically to the previous release within the budget.

<a id="EDGE-MEDIUM-075"></a>

### EDGE-MEDIUM-075 — Boot continues when only some outputs reach safe-state, and GPIO outputs are enabled with an undefined level

- **Önem:** MEDIUM · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway main.rs boot safe-state / gpio.rs
- **Köken:** doğrulanan iddia T18 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/main.rs:4820-4842`, `sens-api-gateway/src/safe_state.rs:178-185`, `sens-api-gateway/src/safe_state.rs:150-176`, `sens-api-gateway/src/gpio.rs:484`, `sens-api-gateway/src/main.rs:4820`, `sens-api-gateway/src/main.rs:4794`, `sens-api-gateway/src/gpio.rs:704-712`
- **Kanıt (ayrıntı):**
  - src/main.rs:4820-4842 boot aborts only if `safe_count == 0 && (gpio||modbus||i2c non-empty)`. With 1 of N outputs safe, boot proceeds after a warn (safe_state.rs:178-185)
  - src/safe_state.rs:150-176 per-output errors and timeouts are logged and skipped
  - src/gpio.rs:484 `let output_pin = pin.into_output();` switches the pin to output with whatever level is in the output latch (rppal offers into_output_low/high to preset the level; it is not used). The configured safe level is applied only later, in main.rs:4820
  - src/main.rs:4794 init_hardware (pin mode switch) runs before safe-state at 4797-4846, so there is a window where outputs drive stale latch values
  - src/gpio.rs:704-712 reconfigure_pins drops the OutputPins (rppal resets the mode on drop) and re-inits them with the same undefined-level pattern
- **Kök neden:** Safe-state is a best-effort post-init pass instead of a precondition of output construction. An output pin can exist without a defined level, and the boot gate counts successes instead of requiring every actuator to be proven safe.
- **Mimari düzeltme yönü:** Make it impossible: an output handle can only be built with its fail-safe level (into_output_low/high, or a typed `SafeOutput::new(pin, safe_level)`), so there is no unsafe intermediate state. Make the boot gate all-or-explicit: every registered output must report Ok. Otherwise the agent enters a typed Degraded state that blocks all actuator writes and reports to the cloud. Proceeding on partial success must not be possible.
- **Doğrulama:** Unit: SafeStateManager returns a typed report. A mocked failure on one of three outputs blocks the control runtime from starting (assert no command handler or script engine spawned). HIL: scope the GPIO line at agent restart with the latch pre-set high and assert no high pulse on a fail-LOW output.
- **Not:** Adversarial re-check rated MEDIUM (verifier HIGH): CONFIRMED as described, but I rate the real-world impact lower than HIGH. The boot gate aborts only when safe_count == 0. With 1 of N outputs safe, boot proceeds after error/warn logs. into_output() is used without presetting the level, and safe-state runs after all of init_hardware, which includes Modbus/I2C initialisation with its own timeouts. Why lower: per-output failures are logged at error level, so the failure is not silent. The outputs that fail are usually unreachable, so the runtime cannot drive them either. The BCM output latch usually holds either the last commanded level (after a crash the pin never left output mode, so no new value is driven) or the shutdown safe value (after a graceful exit). The worst case is a cold boot with a fail-ON (HIGH) safe level, which sits LOW for the init window. Also, the in-code comment at main.rs:4813-4816 promises degraded mode if ANY output fails, which contradicts the code. The same gate is also too strict: configs with no outputs abort boot (see incidental). Root cause: safe-state is a post-init pass that counts successes, not a precondition of constructing an output handle. Fix: make output construction take the safe level (an OutputPin type built only via into_output_low/high(safe_level)) so an output cannot exist without a defined level. Track per-output Proven/Unproven state, refuse runtime writes to Unproven outputs except the safe value, publish a degraded-state alarm, and gate on 'all registered outputs proven safe' instead of '>0'. Test: a unit test with a mock handle where 1 of 3 writes fails asserts the degraded alarm and that runtime writes to the failed output are refused. A HIL test asserts the pin level is the safe level immediately after mode switch.

<a id="EDGE-MEDIUM-076"></a>

### EDGE-MEDIUM-076 — safe_state_v2 is unused type-only code, and the v1 header promises crash/OOM safe-state that panic=abort and SIGKILL make impossible

- **Önem:** MEDIUM · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway safe_state.rs / safe_state_v2.rs
- **Köken:** doğrulanan iddia T20 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/main.rs:91-96`, `sens-api-gateway/src/safe_state_v2.rs:12-17`, `sens-api-gateway/src/safe_state.rs:3-5`, `Cargo.toml:553`
- **Kanıt (ayrıntı):**
  - src/main.rs:91-96 `#[allow(dead_code)] mod safe_state_v2;` with the comment 'Pure types, zero runtime behavior ... v1 SafeStateManager remains the runtime owner'
  - grep `safe_state_v2::` outside the module returns no consumers. safe_state_v2.rs:12-17 says 'Pure type definitions — zero runtime behavior'
  - src/safe_state.rs:3-5 claims that on shutdown (SIGTERM, SIGINT, crash, OOM-kill) all outputs are driven safe; :23-25 claims fail-safe on software failure
  - Cargo.toml:553 `panic = "abort"`; process_hardening.rs:214-260 the panic hook aborts without unwinding. OOM-kill and systemd watchdog/TimeoutStopSec kills (SIGKILL/SIGABRT, unit WatchdogSec=60s, TimeoutStopSec=90s) run no userspace code
- **Kök neden:** Safety requirements were documented as properties of a userspace module, while the termination model (abort, SIGKILL) structurally prevents userspace from acting. The v2 redesign was staged as types with no migration owner.
- **Mimari düzeltme yönü:** Make it detectable, then automatic: move crash and OOM fail-safe to mechanisms outside the agent process (hardware/IO-module watchdogs, a separate minimal supervisor, or kernel GPIO line defaults via device tree). Rewrite the header to state exactly what v1 guarantees (graceful SIGTERM/SIGINT only). Either wire v2 as the single runtime owner and delete v1, or delete v2. An invariant test should fail when a `#[allow(dead_code)]` safety module has no consumers.
- **Doğrulama:** Invariant test: no `allow(dead_code)` on modules under the safe_state* namespace. HIL: SIGKILL and an OOM-kill of the agent each drive outputs to safe via the hardware watchdog, measured on the IO lines.

<a id="EDGE-MEDIUM-077"></a>

### EDGE-MEDIUM-077 — Envelope freshness and RBAC time checks use raw SystemTime, not the agent ClockAuthority; chrony query is off by default

- **Önem:** MEDIUM · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway commands/envelope_adapter.rs / runtime_safety clock
- **Köken:** doğrulanan iddia T29 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/commands/envelope_adapter.rs:196-199`, `sens-api-gateway/src/commands/envelope_adapter.rs:300`, `sens-api-gateway/src/commands/mqtt_dispatch.rs:278`, `sens-api-gateway/src/config.rs:2294`, `sens-api-gateway/src/config.rs:2262-2266`
- **Kanıt (ayrıntı):**
  - src/commands/envelope_adapter.rs:196-199 `SystemTime::now()...unwrap_or(0)` is fed to verify_envelope
  - src/commands/envelope_adapter.rs:300 authorize_adapted passes `SystemTime::now()` to AuthorizationRequest (manifest validity window)
  - src/commands/mqtt_dispatch.rs:278 replay age uses chrono::Utc::now()
  - src/config.rs:2294 and :2310 `enable_chrony_query: false` by default, so even ClockAuthority consumers (force_registry, opc_ua) get a 0-age always-trusted clock (config.rs:2262-2266)
  - Unit ProtectClock=true limits tampering by the agent but not wrong-time-at-boot on RTC-less RPi4/CM4 (no fake-hwclock assurance)
- **Kök neden:** ClockAuthority was introduced as a parallel abstraction and never made the only time source for security decisions. Raw SystemTime stays freely callable in the authz paths.
- **Mimari düzeltme yönü:** Make it impossible: security-decision functions (verify_envelope, authorize, replay check) take a `TrustedInstant` produced only by ClockAuthority::trustworthy_wall_clock(). Add a clippy disallowed-methods lint for SystemTime::now/Utc::now in command_envelope, authz and commands. Enable the chrony-backed authority by default on Suderra OS (chrony with NTS is part of the image) and fail closed on stale sync for mutating commands.
- **Doğrulama:** Lint test: a disallowed_methods violation fails CI. Unit: with a ClockAuthority mock reporting NtsSyncStale, a mutating envelope is rejected. With the clock at 1970 (no RTC), commands are rejected rather than silently accepted or replayed.

<a id="EDGE-MEDIUM-078"></a>

### EDGE-MEDIUM-078 — Boot safe-state runs only after cloud activation and MQTT client creation, so an unactivated device whose activation fails restart-loops without ever driving outputs safe

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway main.rs run_agent boot ordering
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/main.rs:4536-4705`
- **Kanıt (ayrıntı):**
  - main.rs:4536-4705 activation retries return Err (4617-4623, 4693-4699) before init_hardware (4795), so outputs are never driven safe while the agent restart-loops (confirmed)
  - Partial-failure tolerance of the same gate is claim T18
- **Kök neden:** Safe-state is sequenced after the cloud lifecycle instead of immediately after config load.
- **Mimari düzeltme yönü:** Apply safe-state right after config load and hardware init, independent of network or activation; activation failures then degrade connectivity only.
- **Not:** Incidental finding (merged from 1 raw report(s)); area=agent.

<a id="EDGE-MEDIUM-079"></a>

### EDGE-MEDIUM-079 — Remote config update mutates the live in-memory config before persisting and does not restore it when save() fails

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway commands/config_dispatch.rs
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/commands/config_dispatch.rs:30-73`, `sens-api-gateway/src/commands/provision.rs:103-120`
- **Kanıt (ayrıntı):**
  - src/commands/config_dispatch.rs:30-73 mutates state.config fields in place; :76-80 a save error returns Err without restoring
  - Contrast commands/provision.rs:103-120, which restores a backup on failure
- **Kök neden:** There is no copy-on-write config update pattern (provision.rs does restore a backup; config_dispatch does not).
- **Mimari düzeltme yönü:** Build the new config value, validate and persist it, then swap it in under the lock.
- **Not:** Incidental finding (merged from 1 raw report(s)); area=agent.

<a id="EDGE-MEDIUM-080"></a>

### EDGE-MEDIUM-080 — db.key is created with create_new + write_all and no fsync of file or directory; a torn or zero-length write permanently bricks every v1 SQLCipher database

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway db_secret.rs
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/db_secret.rs:200-224`, `sens-api-gateway/src/db_secret.rs:172-178`
- **Kanıt (ayrıntı):**
  - src/db_secret.rs:200-224 create_new(0400) then write_all, with no sync_all and no directory fsync
  - db_secret.rs:172-178 a short existing file triggers a permanent 'too short' bail with no recovery path
- **Kök neden:** Secret creation does not use the atomic-write discipline used elsewhere, and a short existing file is a permanent bail with no recovery.
- **Mimari düzeltme yönü:** Provision the secret at install time (or via TPM credential); if it is ever written locally, write tmp, fsync, rename, fsync the directory.
- **Not:** Incidental finding (merged from 1 raw report(s)); area=agent.

<a id="EDGE-MEDIUM-081"></a>

### EDGE-MEDIUM-081 — GPIO direction "in"/"out" or mixed case passes validation and safe-state registration, but the GPIO actor matches only exact "input"/"output" and leaves the pin unconfigured

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway gpio.rs vs config.rs vs safe_state.rs
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/config.rs:3391-3397`, `sens-api-gateway/src/safe_state.rs:246-253`, `sens-api-gateway/src/gpio.rs:473-494`, `sens-api-gateway/src/gpio.rs:517-519`, `sens-api-gateway/src/gpio.rs:651-655`
- **Kanıt (ayrıntı):**
  - config.rs:3391-3397 accepts input/output/in/out case-insensitively; safe_state.rs:246-253 lowercases and treats 'output'|'out' as safe-state outputs
  - gpio.rs:473-494 hardware init matches the exact strings "input"/"output" (others: warn and skip); gpio.rs:517-519/:559-565 reads require exactly "input"; gpio.rs:651-655 sim writes require exactly "output"
  - So an 'out' or 'Output' pin is registered for safe-state but never becomes an output, its safe-state write fails, and a partial-success boot continues (T18)
- **Kök neden:** Direction is a free-form String validated in one module and matched with different rules in two others.
- **Mimari düzeltme yönü:** Make it impossible: replace direction: String with a serde enum PinDirection {Input, Output} with aliases, parsed once at config load; add a round-trip test per accepted spelling.
- **Not:** Incidental finding (merged from 2 raw report(s)); area=agent.

<a id="EDGE-MEDIUM-082"></a>

### EDGE-MEDIUM-082 — I2C DAC/relay outputs are writable (write_direct) but never included in safe-state, and the promised warning is never logged

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway safe_state.rs I2C outputs
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/safe_state.rs:108-118`, `sens-api-gateway/src/commands/io_config.rs:210-222`, `sens-api-gateway/src/main.rs:5678-5686`
- **Kanıt (ayrıntı):**
  - src/safe_state.rs:108-118 'I2C devices are skipped ... (Placeholder: I2C safe-state is logged as a warning.)', but no warning is emitted (confirmed)
  - commands/io_config.rs:210-222 and main.rs:5678-5686 allow I2C output writes via write_direct, so I2C actuators exist but have no fail-safe
- **Kök neden:** The I2C device schema carries no output or safe-value metadata, so the registry cannot include those devices.
- **Mimari düzeltme yönü:** Require writable I2C devices to declare safe_state_register/value in typed config (refuse write_direct otherwise) so the registry includes them automatically.
- **Not:** Incidental finding (merged from 1 raw report(s)); area=agent.

<a id="EDGE-MEDIUM-083"></a>

### EDGE-MEDIUM-083 — A command larger than the 1 MiB incoming MQTT limit tears down the connection, and with clean_session=false and QoS1 the broker redelivers it on reconnect, causing a reconnect loop

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway mqtt.rs
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/mqtt.rs:276`, `sens-api-gateway/src/config.rs:470-474`, `sens-api-gateway/src/mqtt.rs:286-290`, `sens-api-gateway/src/commands/apply_signed_manifest.rs:716-778`
- **Kanıt (ayrıntı):**
  - src/mqtt.rs:276 set_max_packet_size(1 MiB); config.rs:470-474 clean_session default false; mqtt.rs:286-290 commands subscribed at QoS1
  - rumqttc 0.25.1 mqttbytes/mod.rs:182 PayloadSizeLimitExceeded tears down the connection; MQTT 3.1.1 session resume redelivers unacked QoS1 messages
  - apply_signed_manifest carries base64 files inline (apply_signed_manifest.rs:716-778)
- **Kök neden:** There is no payload-size contract on command topics between cloud, broker and edge.
- **Mimari düzeltme yönü:** Enforce a maximum command payload at the cloud publisher and at the broker (max_packet_size/ACL), reject oversize messages without dropping the session, and send large artifacts by signed URL only.
- **Not:** Incidental finding (merged from 1 raw report(s)); area=agent.

<a id="EDGE-MEDIUM-084"></a>

### EDGE-MEDIUM-084 — Offline-queue row expiry runs only in the drain path while connected, and space is never reclaimed (incremental_vacuum never scheduled), contrary to the documented drop-oldest/expunge-on-enqueue behaviour

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway offline_queue.rs / outbound_publisher.rs
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/offline_queue.rs:818-823`, `sens-api-gateway/src/outbound_publisher.rs:349-352`, `sens-api-gateway/src/db/sqlcipher_factory.rs:206`, `sens-api-gateway/src/config.rs:603-606`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/offline_queue.rs:818-823, :886-891 cleanup_expired runs only in peek/peek_batch; src/outbound_publisher.rs:349-352 the drain is skipped when disconnected
  - src/db/sqlcipher_factory.rs:206 auto_vacuum=INCREMENTAL, but there is no incremental_vacuum in src; vacuum()/vacuum_if_needed_async have no callers outside offline_queue.rs
  - src/config.rs:603-606, :636 docs claim drop_oldest_low_priority and expunge-on-enqueue
  - The freelist-pages-count-toward-cap aspect is also noted in claim T21 evidence
- **Kök neden:** Maintenance was attached to the read path, and VACUUM helpers were written but never scheduled.
- **Mimari düzeltme yönü:** Apply expiry at admission and on a connectivity-independent timer, measure live bytes rather than file pages, and schedule incremental_vacuum; test an outage longer than max_age.
- **Not:** Incidental finding (merged from 1 raw report(s)); area=agent.

<a id="EDGE-MEDIUM-085"></a>

### EDGE-MEDIUM-085 — save() serializes the entire AgentConfig including every serde default, so after the first activation or config save, later agent default changes never reach that device

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway config.rs save_to
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/config.rs:4251`, `sens-api-gateway/src/config.rs:626-628`
- **Kanıt (ayrıntı):**
  - config.rs:4251 serde_yaml::to_string(self) of the whole AgentConfig
  - Fields such as OfflineQueueConfig.enabled (config.rs:626-628) use serde(default) without skip_serializing_if, so defaults get pinned into the file
- **Kök neden:** The full config is used as the persistence unit instead of a device-owned delta.
- **Mimari düzeltme yönü:** Persist only device-owned state (identity, credentials, provisioned I/O) in a separate store and never round-trip the full config.
- **Not:** Incidental finding (merged from 1 raw report(s)); area=agent.

<a id="EDGE-MEDIUM-086"></a>

### EDGE-MEDIUM-086 — SCADA audit records carry no actor identity: source_ip is always None and the actor is "ws_client", so actuator changes and PIN failures cannot be attributed

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway scada_server.rs audit
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/scada_server.rs:1434`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/scada_server.rs:1434, 1444, 1469, 1875 and 1924 source_ip is hardcoded to None; :1749 alarm-ack actor is "ws_client"; :1529-1538, :1631-1640 and :1717-1727 insert_audit receives None
- **Kök neden:** WS sessions have no authenticated principal and the peer address (ConnectInfo) is never captured.
- **Mimari düzeltme yönü:** Extract ConnectInfo<SocketAddr> at upgrade plus the authenticated operator (see T32) and make both required fields of a typed AuditActor passed to every audit call.
- **Not:** Incidental finding (merged from 1 raw report(s)); area=agent.

<a id="EDGE-MEDIUM-087"></a>

### EDGE-MEDIUM-087 — HMI calibration computes slope/offset with reference = raw (reference_value None) and the stored result is never applied to readings

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway scada_server.rs / calibration_engine.rs
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/scada_server.rs:1761-1785`, `sens-api-gateway/src/calibration_engine.rs:270-275`, `sens-api-gateway/src/scada_db.rs:542`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/scada_server.rs:1761-1785 'start' builds a config with reference_value: None for both points
  - src/calibration_engine.rs:270-275 reference = p.reference_value.unwrap_or(raw)
  - src/scada_db.rs:542 get_latest_calibration has no caller outside its definition (grep)
- **Kök neden:** The calibration package schema was never implemented and nothing consumes calibration records in the scaling pipeline, so the feature is UI-only.
- **Mimari düzeltme yönü:** Remove the WS Calibrate surface or implement it end to end: typed reference values, versioned coefficients applied in io_poll scaling, authenticated principal.
- **Not:** Incidental finding (merged from 1 raw report(s)); area=agent.

<a id="EDGE-MEDIUM-088"></a>

### EDGE-MEDIUM-088 — SCADA CORS origin predicate uses starts_with("http://localhost"/"http://127.0.0.1"), which also accepts http://localhost.attacker.example and http://127.0.0.1.attacker.example

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway scada_server.rs build_scada_router CORS
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/scada_server.rs:2218-2229`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/scada_server.rs:2218-2229 `s.starts_with("http://localhost") || s.starts_with("http://127.0.0.1")` also matches http://localhost.evil.com and http://127.0.0.1.evil.com, letting such a site read /scada/tags, /scada/process and /scada/alarms from an operator browser (confirmed)
- **Kök neden:** Origin is compared as a raw string prefix instead of parsing scheme, host and port.
- **Mimari düzeltme yönü:** Parse the Origin with url::Url and compare the exact host against the loopback set and parsed RFC1918 addresses (reuse is_private_network_origin), with a test corpus.
- **Not:** Incidental finding (merged from 1 raw report(s)); area=agent.

<a id="EDGE-MEDIUM-089"></a>

### EDGE-MEDIUM-089 — The SCADA executor holds the global AppState read lock across actuator I/O awaits, so a queued writer (activation, SIGHUP) blocks all readers until a slow Modbus write times out

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway main.rs SCADA command executor
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/main.rs:5638`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/main.rs:5638 `let s = cmd_state.read().await;` is held across write_pin, write_coil, write_register and write_direct awaits (5644-5690) and update_tag (5694); tokio's RwLock is write-preferring, so a queued writer blocks all new readers
- **Kök neden:** Handles are reached through the monolithic AppState lock instead of being cloned out before I/O.
- **Mimari düzeltme yönü:** Clone the needed handles and tag config under a short guard and drop it before any I/O, or route through an output port that owns its handles.
- **Not:** Incidental finding (merged from 1 raw report(s)); area=agent.

<a id="EDGE-MEDIUM-090"></a>

### EDGE-MEDIUM-090 — Signed commands can be replayed between the 60 s dedup TTL and the 300 s age window; the persistent tier is off by default

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway command_envelope dedup / mqtt_dispatch replay window
- **Köken:** doğrulanan iddia T25 (PARTIAL)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/command_envelope/moka_dedup.rs:54`, `sens-api-gateway/src/config.rs:2239-2246`, `sens-api-gateway/src/config.rs:3072-3078`, `sens-api-gateway/src/commands/mqtt_dispatch.rs:270-279`, `sens-api-gateway/src/config.rs:3941-3951`, `sens-api-gateway/src/commands/mqtt_dispatch.rs:322-364`, `sens-api-gateway/src/command_envelope/envelope.rs:391`, `sens-api-gateway/src/command_envelope/moka_dedup.rs:134-138`, `sens-api-gateway/src/commands/mod.rs:251-255`, `sens-api-gateway/src/main.rs:1615-1672`, `sens-api-gateway/src/commands/mqtt_dispatch.rs:335`
- **Kanıt (ayrıntı):**
  - src/command_envelope/moka_dedup.rs:54 DEFAULT_MOKA_TTL_SECS=60; config.rs:2239-2246 the envelope_dedup default ttl is 60 and enable_sqlcipher_persist=false
  - src/config.rs:3072-3078 max_command_age_secs=300, :3081-3086 skew=60. mqtt_dispatch.rs:270-279 checks the age against the iat-derived timestamp
  - src/config.rs:3941-3951 Rule 11 bounds the TTL to [30,3600] but never requires ttl >= max_age+skew
  - The Moka path never consults the VecDeque (mqtt_dispatch.rs:322-364), so a captured signed envelope replayed 61-300 s after iat is accepted
  - envelope.rs:391 and :410 do not bound exp-iat, but the MQTT path's iat age check caps the effective window at max_command_age_secs. That sub-claim is mitigated (PARTIAL)
  - moka_dedup.rs:134-138 is a non-atomic get-then-insert (documented race). Today it is latent because CommandHandler::run awaits handle_message sequentially (commands/mod.rs:251-255)
  - main.rs:1615-1672 the persistent tier is opt-in. Even when enabled, mqtt_dispatch.rs:335 sets expires_at=now+3600 (1 h, not the documented 72 h). Moka is empty after an agent restart
- **Kök neden:** Dedup retention and the freshness window are configured independently, with no invariant linking them. The hot-path cache was sized for QoS-1 redelivery, not for the replay window it must cover.
- **Mimari düzeltme yönü:** Make it impossible: derive dedup retention from the freshness policy (retention = max_age + skew, computed, not configured). Make the persistent tier mandatory in release, and use an atomic insert-if-absent (moka entry().or_insert_with / SQL INSERT ... ON CONFLICT) as the authoritative check. Bound exp-iat in verify_envelope itself (<= max_age) so non-MQTT consumers inherit it, and key expiry on the envelope exp.
- **Doğrulama:** Unit: replay the same signed envelope at t=+90 s with a mocked clock and assert Duplicate. Restart (new process, same SQLCipher file) and replay within the window: Duplicate. Concurrency test: two parallel check_and_mark calls on one jti yield exactly one Fresh. Config test: ttl < age+skew is unrepresentable.
- **Not:** Adversarial re-check rated MEDIUM (verifier HIGH): CONFIRMED technically, but I rate it MEDIUM for today's production. The Moka TTL defaults to 60 s, the age window is 300 s (+60 s skew), and Rule 11 never links them. The Moka path never consults the VecDeque, the SQLCipher tier is opt-in and is given expires_at = now+3600, and Moka is empty after a restart. The get-then-insert is non-atomic, but handle_message runs sequentially, so that race is latent. The real exposure is that a captured signed envelope can be replayed 61-300 s after iat (bounded further by exp). However, the fleet must run Permissive (T23) and the cloud sends only unsigned legacy commands. Anyone able to inject on the command topic can therefore forge a fresh unsigned command, which dominates replay. This becomes HIGH once Enforcing is reachable. Root cause: retention and freshness windows are configured independently. Fix: derive the dedup retention from the freshness window (ttl := max_command_age + max_skew, enforced at construction rather than via a validate rule), cap exp - iat at max_command_age in verify_envelope, make the persistent tier mandatory whenever signature_mode != Disabled (or persist only jtis with iat in the window), and use an atomic insert (`entry().or_insert` / INSERT OR FAIL). Test: replay the same signed envelope at t+61 s and t+299 s and assert both are rejected. Restart the agent between the original and the replay and assert rejection.

<a id="EDGE-MEDIUM-091"></a>

### EDGE-MEDIUM-091 — Emergency reset needs no PIN when the package has no pin_hash, and the global PIN lockout lets any client lock operators out indefinitely

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway/src/scada_server.rs (PIN / emergency reset)
- **Köken:** doğrulanan iddia T34 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/scada_server.rs:2027-2041`, `sens-api-gateway/src/scada_server.rs:80-83`, `sens-api-gateway/src/scada_server.rs:791-801`, `sens-api-gateway/src/scada_server.rs:1648-1665`, `sens-api-gateway/src/scada_server.rs:829-834`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/scada_server.rs:2027-2041 `None => { // No PIN configured, allow reset do_emergency_reset(state).await; }`
  - sens-api-gateway/src/scada_server.rs:80-83 MAX_PIN_FAILURES=3, PIN_LOCKOUT_SECS=60. Lines 766-807 define PinLockoutState as process-global (shared by all WS sessions).
  - sens-api-gateway/src/scada_server.rs:791-801 record_failure never resets failed_attempts when a lockout expires. Only a correct PIN calls reset() (803-806). After the first lockout, each single wrong PIN re-locks for 60s, so one bad PIN per minute keeps every operator out.
  - sens-api-gateway/src/scada_server.rs:1648-1665 and 2011-2025 while locked out, all PIN-level commands and EmergencyReset are refused for every operator.
  - sens-api-gateway/src/scada_server.rs:829-834 legacy unsalted single-pass SHA-256 PIN hashes are still accepted.
- **Kök neden:** Sessions carry no authenticated identity or source address (source_ip is always None), so the lockout cannot be scoped and was made global. The package schema allows pin_hash to be omitted even when emergency_stop/pin tags exist.
- **Mimari düzeltme yönü:** Validate at package deploy: if any pin or emergency_stop entries exist, pin_hash (argon2id only) is required, and the package is rejected otherwise. Scope the throttle to the authenticated principal plus source address with exponential backoff, never globally, and clear the counters on expiry. Require a local physical reset condition (key-switch DI) for E-stop reset. Remove the SHA-256 path through a deploy-time migration.
- **Doğrulama:** Unit tests: a package with emergency_stop and no pin_hash is rejected. Three failures from client A do not lock client B. After the lockout expires, one failure does not re-lock. EmergencyReset without a valid PIN always fails.
- **Not:** Adversarial re-check rated MEDIUM (verifier HIGH): TITLE: Emergency reset needs no PIN when the package has no pin_hash, and the global PIN lockout never clears its failure counter, so one bad PIN per minute locks every operator out. VERDICT: CONFIRMED. With no pin_hash, EmergencyReset calls do_emergency_reset directly. The package's `resetRequiresPin` field is parsed but never read, and `holdDuration` is never read either. PinLockoutState is process-global. record_failure never resets failed_attempts when the lockout expires, so after the first lockout each single wrong PIN re-locks for 60s, and only a correct PIN calls reset(). Legacy unsalted SHA-256 hashes are still accepted, and the 'transparent upgrade' comment is false because hash_pin() has no caller. ADDITIONAL (cross-repo, makes it worse): the cloud stores pinHash as `scrypt$<salt>$<hash>` and ships controlPermissions to the edge unchanged. The edge verifier understands only `$argon2id$` or hex SHA-256, so every legitimate PIN fails on the edge. Operators lock themselves out, and with pinHash set an emergency reset is impossible (until an agent restart silently clears the in-memory E-stop). Severity is MEDIUM rather than HIGH because the WS is reachable only locally on Suderra-OS (see T32), and the E-stop flag latches only the SCADA WS path. ROOT CAUSE: sessions carry no authenticated identity or source address (source_ip is always None), so rate limiting could only be made global. The package schema makes pin_hash optional even when PIN-level tags or emergency_stop exist. The PIN hash format is not a shared contract between cloud and edge. FIX: (1) Define a versioned PinHash type in the shared contract (a PHC string with an algorithm tag, the same KDF on both sides). The edge deserializer rejects unknown formats at deploy time, and the package fails validation when security_levels.pin is non-empty, or emergency_stop.reset_requires_pin is true, but pin_hash is absent. (2) Scope lockout per authenticated principal plus per source address, with exponential backoff on a counter that decays on expiry, and keep a separate local-console override that is physically gated. (3) Delete the legacy SHA-256 branch with a migration that rehashes or rejects. TEST: a unit test where a package with pin tags and no hash fails deploy. A cloud-generated hash fixture (golden file shared by the TS and Rust test suites) verifies on the edge. Lockout tests: 3 failures, wait for expiry, 1 failure does not re-lock, and principal A's failures do not lock principal B. An emergency_reset with resetRequiresPin=true and no hash is refused.

<a id="EDGE-MEDIUM-092"></a>

### EDGE-MEDIUM-092 — SCADA query parameters and pending confirmations are unbounded (memory/CPU DoS of the control agent)

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway/src/scada_db.rs + scada_server.rs
- **Köken:** doğrulanan iddia T35 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/scada_db.rs:317-341`, `sens-api-gateway/src/trend_engine.rs:136-143`, `sens-api-gateway/src/scada_server.rs:965-971`, `sens-api-gateway/src/trend_engine.rs:23-29`, `sens-api-gateway/src/scada_server.rs:860-867`, `sens-api-gateway/src/scada_db.rs:442-452`, `sens-api-gateway/src/scada_server.rs:1147-1150`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/scada_db.rs:317-341 query_trend has no LIMIT. trend_engine.rs:136-143 forwards to it. scada_server.rs:965-971 (HTTP) and 1835-1850 (WS RequestTrend) run this synchronous rusqlite query on a tokio worker while holding the tokio Mutex on trend_engine. Mitigation: retention of 7 days at a 10 s sample interval (trend_engine.rs:23-29) caps one tag at about 60k points.
  - sens-api-gateway/src/scada_server.rs:860-867 AlarmHistoryParams.limit is a u32 (default 100) with no cap, passed to scada_db.rs:442-452 `LIMIT ?1`, so values up to 4,294,967,295 are accepted.
  - sens-api-gateway/src/scada_server.rs:1147-1150 pending_confirms is a plain HashMap. Lines 1439, 1464 and 1870 insert a fresh UUID entry on every Command/Setpoint/EmergencyStop. Entries are removed only on a matching response (1572, 1694), with no TTL and no cap, across up to 16 connections (line 71), and the agent runs under MemoryMax=256M (Suderra-OS package/suderra-edge-agent/suderra-agent.service).
- **Kök neden:** The API was written for one trusted local HMI, so resource bounds were never part of the request types or the session state.
- **Mimari düzeltme yönü:** Use bounded newtypes at deserialization: BoundedLimit<1..=1000> and a time window with a maximum span. Make pending_confirms a bounded TTL map (for example, at most 4 entries for 30 s, and reject new commands while one is pending). Run DB queries in spawn_blocking with pagination. Add a per-connection message rate limit.
- **Doğrulama:** Deserialize ?limit=1000000000 and expect 400. Send a trend request with a span over the maximum and expect 400. A WS fuzz test sends 10k Command messages and checks pending_confirms stays at or below the cap and RSS stays bounded.

<a id="EDGE-MEDIUM-093"></a>

### EDGE-MEDIUM-093 — HMI loads unpinned React/Recharts/ReactFlow from public CDNs without SRI; air-gapped sites get a blank HMI

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway/static/scada-edge.html + scada_server.rs CSP/service worker
- **Köken:** doğrulanan iddia T36 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/static/scada-edge.html:16-24`, `sens-api-gateway/static/scada-edge.html:6`, `sens-api-gateway/src/scada_server.rs:896-907`, `sens-api-gateway/src/scada_server.rs:893`, `sens-api-gateway/src/scada_server.rs:128-145`, `sens-api-gateway/systemd/suderra-display.service:37-50`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/static/scada-edge.html:16-24 scripts load from unpkg/jsdelivr with floating versions (react@18, react-dom@18, react-is@18, prop-types@15, recharts@2) and no integrity= attribute. There is no local fallback (only window.ReactFlow use at 434).
  - sens-api-gateway/static/scada-edge.html:6 the meta CSP whitelists https://unpkg.com and https://cdn.jsdelivr.net with 'unsafe-inline'. scada_server.rs:896-907 the header CSP whitelists the same hosts.
  - sens-api-gateway/src/scada_server.rs:893 the nonce is injected into every `<script` tag, CDN tags included, so the 'strict-dynamic' trust extends to whatever the CDN serves.
  - sens-api-gateway/src/scada_server.rs:128-145 the service worker precaches /libs/vendor/*.js and claims 'All third-party libraries are vendored into /libs/ during the build'. The router (2233-2246) serves only /libs/aquaculture-nodes.umd.js, and static/ contains only aquaculture-nodes.umd.js and scada-edge.html, so cache.addAll rejects and there is never an offline copy.
  - sens-api-gateway/systemd/suderra-display.service:37-50 the local kiosk HMI depends on this page.
- **Kök neden:** The HMI page started as a CDN-loaded prototype. The vendoring step the comments describe was never implemented, and nothing at build time ties the HTML or the precache list to assets the server actually serves.
- **Mimari düzeltme yönü:** Vendor exact-version bundles into static/, embed them with include_bytes!, and serve them under /libs/vendor/*. Remove the CDN hosts from both CSPs (script-src 'nonce-..' 'self'). Add a build-time/unit invariant that SCADA_HTML contains no external http(s) script/link URLs and that every PRECACHE_URL is a served route.
- **Doğrulama:** Unit test: a regex over SCADA_HTML finds no external URL. Router test: GET on every PRECACHE_URL returns 200. Playwright offline test with network egress blocked shows the HMI renders and the service worker installs.
- **Not:** Adversarial re-check rated MEDIUM (verifier HIGH): TITLE: The HMI loads unpinned React/Recharts from public CDNs without SRI, and the offline service worker precaches files the server never serves, so air-gapped sites get a blank HMI. VERDICT: CONFIRMED. react@18, react-dom@18, react-is@18, prop-types@15 and recharts@2 float, and no tag has integrity=. reactflow is pinned at 11.11.4 but has no SRI either. The nonce is injected into every `<script` tag, so CDN scripts are trusted by the header CSP (`'strict-dynamic'` makes the host allowlist irrelevant). Any CDN compromise runs JS in the HMI origin, which passes the WS Origin check and can drive outputs. The SW precaches /libs/vendor/*, which no route serves and static/ does not contain, so cache.addAll rejects and SW install fails. window.ReactFlow being undefined throws, and the page renders blank. No build step vendors these files (build.rs only handles sx1302). Severity is MEDIUM because on Suderra-OS production targets no browser runs on the device and the server is loopback-only. Impact is HIGH on kiosk or OT-bind deployments, where it combines a supply-chain path to actuator control with total HMI loss offline. Also: the getrandom-failure fallback returns HTML with no CSP header, so the middleware applies `script-src 'none'` and the HMI breaks (the log says 'falling back to static CSP'). ROOT CAUSE: the page started as a CDN prototype. The vendoring that the SW comment asserts was never implemented, and nothing ties the HTML or the precache list to assets the binary actually embeds. FIX: vendor exact-version assets into static/vendor with a lockfile and checksums, embed them with include_bytes!, and generate both the router entries and the SW PRECACHE_URLS from one Rust asset manifest (build.rs emits the list, so an unserved precache entry cannot exist). Drop external hosts from both CSPs (script-src 'self' 'nonce-…'). Add a build-time check that fails if the HTML references any non-'self' URL. TEST: a unit test that every PRECACHE_URLS entry returns 200 from build_scada_router. A test that scada-edge.html contains no 'http' script/link src. A headless-browser test with network egress blocked checks that the HMI renders and the SW installs.

<a id="EDGE-MEDIUM-094"></a>

### EDGE-MEDIUM-094 — Lifecycle/observability HMAC covers only timestamp+method+path (replayable within ±300 s), and no shipped unit provisions its key

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway/src/lifecycle_auth.rs + health.rs + systemd units
- **Köken:** doğrulanan iddia T40 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/lifecycle_auth.rs:76`, `sens-api-gateway/src/lifecycle_auth.rs:364-379`, `sens-api-gateway/src/lifecycle_auth.rs:123-140`, `sens-api-gateway/src/main.rs:1285-1300`, `sens-api-gateway/src/health.rs:1176-1216`, `sens-api-gateway/src/config.rs:2035-2046`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/lifecycle_auth.rs:76 HMAC_TIMESTAMP_WINDOW_SECS=300. Lines 53-62 state that body signature and nonce are out of scope.
  - sens-api-gateway/src/lifecycle_auth.rs:364-379 compute_hmac MACs only timestamp, method and path. Query string, body and nonce are not covered.
  - sens-api-gateway/src/lifecycle_auth.rs:123-140 the key is read only from $CREDENTIALS_DIRECTORY/<name>. main.rs:1285-1300 and 3726-3740: with auth_mode=HmacToken and no credential, the agent calls exit(1).
  - sens-api-gateway/src/health.rs:1176-1216 the observability GETs use the same verify_request.
  - Neither Suderra-OS package/suderra-edge-agent/suderra-agent.service nor sens-api-gateway/systemd/suderra-agent.service has LoadCredential=, so HmacToken mode cannot boot on shipped images. config.rs:2035-2046 the default is Disabled.
- **Kök neden:** The scheme was designed for one body-less idempotent endpoint and then reused for observability, and the deployment units were never updated to deliver the credential.
- **Mimari düzeltme yönü:** Canonicalise the request as method, path, query, sha256(body), timestamp and nonce, and reject nonces seen within the window (reuse JtiDedupTable). Ship LoadCredential (or a TPM-sealed systemd-creds file minted at first boot) in the OS unit. Require HmacToken for any non-loopback health bind.
- **Doğrulama:** Unit tests: the same signed headers replayed twice means the second is rejected, and a changed body or query is rejected. Image test: systemd-analyze verify plus a boot with auth_mode=hmac_token succeeds.

<a id="EDGE-MEDIUM-095"></a>

### EDGE-MEDIUM-095 — OPC UA endpoint declares only the ANONYMOUS token id while anonymous is rejected, and every OPC UA write is denied by the two-person-integrity floor

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway/src/opc_ua_server_runtime.rs + opc_ua_sens_auth_manager.rs + opc_ua_sens_node_manager.rs
- **Köken:** doğrulanan iddia T42 (PARTIAL)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/opc_ua_server_runtime.rs:326-336`, `sens-api-gateway/src/opc_ua_sens_auth_manager.rs:195-221`, `sens-api-gateway/src/opc_ua_sens_node_manager.rs:828-840`, `sens-api-gateway/src/authz/permission.rs:584-599`, `sens-api-gateway/src/authz/in_memory_engine.rs:210-213`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/opc_ua_server_runtime.rs:326-336 `let user_tokens = vec![ANONYMOUS_USER_TOKEN_ID.to_string()]` for the only endpoint.
  - sens-api-gateway/src/opc_ua_sens_auth_manager.rs:195-221 the advertised policies are UserName and X509. Lines 239-258 authenticate_anonymous_token always returns BadIdentityTokenRejected. Whether async-opcua 0.18 gates activation on the endpoint's user_token_ids or on AuthManager::user_token_policies cannot be verified without the library source, so the endpoint is at minimum misdeclared.
  - sens-api-gateway/src/opc_ua_sens_node_manager.rs:828-840 `authorize_write(&authn, &tag_node.tag_name, received_at, None)` passes no co-approver.
  - sens-api-gateway/src/authz/permission.rs:584-599 OpcUaWrite is in requires_two_person_integrity, and authz/in_memory_engine.rs:210-213 denies with TwoPersonIntegrityMissing, so every write returns BadUserAccessDenied.
- **Kök neden:** The endpoint token list was never updated after SensAuthManager landed, and a global TPI floor was applied to OpcUaWrite without any co-approval channel on that surface.
- **Mimari düzeltme yönü:** Derive the endpoint's user_token_ids from the same policy list the AuthManager advertises (one source of truth). Make an explicit design decision on OPC UA writes: either implement a co-approval Method/envelope, or use a signed per-tag policy classifying which setpoints need TPI. Until then, expose nodes with a read-only AccessLevel so clients see read-only nodes rather than writes that fail at runtime.
- **Doğrulama:** async-opcua client integration test: GetEndpoints lists exactly UserName and X509, username login succeeds, anonymous fails, and a write returns the status the policy dictates.

<a id="EDGE-MEDIUM-096"></a>

### EDGE-MEDIUM-096 — PLC upload/deploy commands connect to arbitrary address/port/cert paths from params instead of the configured inventory (OT pivot)

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway/src/commands/plc/upload.rs + commands/ide_deploy.rs
- **Köken:** doğrulanan iddia T44 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/commands/plc/upload.rs:77-99`, `sens-api-gateway/src/commands/plc/upload.rs:168-187`, `sens-api-gateway/src/commands/ide_deploy.rs:67-103`, `sens-api-gateway/src/config.rs:386-392`, `sens-api-gateway/src/config.rs:3412-3443`, `sens-api-gateway/src/plc_programming/mod.rs:367-387`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/commands/plc/upload.rs:77-99 address is a free-form string, and the loopback/link-local check runs only if it parses as Ipv4Addr. Hostnames, ::1 and ::ffff:127.0.0.1 pass.
  - sens-api-gateway/src/commands/plc/upload.rs:168-187 port, client_cert_path and client_key_path come straight from params, so the agent opens whatever local key path it is sent.
  - sens-api-gateway/src/commands/ide_deploy.rs:67-103 IPv6 is accepted as valid, but only IPv4 is checked against loopback/link-local, so ::1 passes. plc_port is arbitrary (105-118).
  - sens-api-gateway/src/config.rs:386-392 says PLC commands use plc_programming inventory names as authorization/audit targets, and config.rs:3412-3443 validates that inventory. Neither upload.rs nor ide_deploy.rs reads config.plc_programming (plc_programming/mod.rs:367-387 is never consulted).
- **Kök neden:** The commands were written as generic remote-programming RPCs with connection details in the payload, and the inventory added later was only validated, never used as the source of truth.
- **Mimari düzeltme yönü:** Change the command schema to accept only an inventory endpoint name. Resolve address, port, protocol options and credentials (from the keystore) from config.plc_programming. Use the endpoint name as the authz/audit target, and reject unknown names and any address/port/path params.
- **Doğrulama:** Unit tests: a command carrying an address param is rejected, an unknown endpoint is rejected, and a known endpoint dials the configured address. The authz check receives the endpoint name.
- **Not:** Adversarial re-check rated MEDIUM (verifier HIGH): TITLE: PLC upload and IDE-deploy commands connect to any address and port given in the command parameters instead of the configured PLC inventory. VERDICT: PARTIAL. CONFIRMED: `address` and `plc_address` are free-form. The loopback, link-local and broadcast check applies only to IPv4 literals, so 'localhost', other hostnames, '::1' and '::ffff:127.0.0.1' pass. Rust's ToSocketAddrs splits on the last ':', so a bare '::1' works. ide_deploy accepts any IPv6 address. Ports are arbitrary, and upload.rs additionally truncates with `as u16`. config.plc_programming is validated but never read: there is no `.plc_programming` consumer outside config.rs. REFUTED sub-claim: 'the agent opens whatever local key path it is sent' is false. client_cert_path and client_key_path are only tested with is_some() for a warning and are never read. SEVERITY REDUCERS: plc_upload and deploy_to_codesys require the DeployProgram permission on the signed-envelope path, so exploitation needs a privileged operator, a compromised cloud or signing key, or signature_mode=permissive (allowed in release; see incidental). The Suderra-OS egress filter allows only 53/123/443/502/4840/8883 to non-loopback destinations, which limits the pivot (loopback is fully open). That same filter breaks CODESYS (1217), S7 (102), EtherNet/IP (44818) and ADS on Suderra-OS (see incidental). ROOT CAUSE: the commands were designed as generic remote-programming RPCs with connection details in the payload. The inventory was added later as validated-but-unused config, so the authorization target and the network target are not the same object. FIX: change the wire contract to carry only `plc: <inventory name>`, and resolve endpoint, port, protocol and credentials exclusively from config.plc_programming (credentials from the keystore, not the payload). Bind RBAC to Permission::DeployProgram{plc: name}. Use a resolved IpAddr allowlist check after DNS resolution, rejecting loopback, link-local and unspecified for both v4 and v6 including mapped addresses. Remove the address/port fields from the params schema so a payload cannot name an arbitrary target. TEST: unit tests where an unknown inventory name is rejected and payload address/port fields are rejected as unknown keys (deny_unknown_fields). Tests for resolution of 'localhost', '::1' and '::ffff:127.0.0.1' being rejected. An integration test showing the command connects only to the inventory endpoint.

<a id="EDGE-MEDIUM-097"></a>

### EDGE-MEDIUM-097 — Script webhook SSRF guard is a string-prefix check that is trivially bypassed and refers to a non-existent allowlist

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway/src/scripting/engine.rs action_webhook
- **Köken:** doğrulanan iddia T46 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/scripting/engine.rs:1893-1899`, `sens-api-gateway/src/scripting/engine.rs:1903-1906`, `sens-api-gateway/src/scripting/engine.rs:1929`, `sens-api-gateway/src/scripting/engine.rs:2009-2028`, `sens-api-gateway/src/config.rs:2040-2041`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/scripting/engine.rs:1893-1899 http:// is allowed.
  - sens-api-gateway/src/scripting/engine.rs:1903-1906 the host is taken by splitting on '://', '/' and ':'. Userinfo `http://x@127.0.0.1/` yields host 'x@127.0.0.1' and passes. Splitting `[::1]` on ':' yields '[', so the '[::1]' check at 1912 is dead. 127.0.0.2, 127.1, 2130706433, 0x7f000001, ::ffff:127.0.0.1, 100.64/10 and DNS names resolving to private or loopback addresses (including rebinding) all pass (1908-1946).
  - sens-api-gateway/src/scripting/engine.rs:1929 and 1950 tell users to add hosts to scripting.webhook_allowlist, but no config struct defines that field (repo-wide grep finds only these two lines).
  - sens-api-gateway/src/scripting/engine.rs:2009-2028 POST/PUT with a body are allowed, so loopback agent endpoints such as POST /lifecycle/confirm-active (auth Disabled by default, config.rs:2040-2041) are reachable. Redirects are disabled at 1992, which is correct.
- **Kök neden:** URL validation was done on the raw string instead of on parsed and resolved socket addresses, and the documented allowlist was never implemented.
- **Mimari düzeltme yönü:** Parse with url::Url and reject userinfo. Require https. Resolve DNS once and classify every IpAddr (loopback, private, link-local, ULA, CGNAT, multicast, unspecified, IPv4-mapped). Connect to the validated IP through a custom reqwest resolver so rebinding cannot swap targets. Implement a typed scripting.webhook_allowlist (host and port) and make it the only way to reach internal hosts.
- **Doğrulama:** A table-driven unit test over the bypass corpus (userinfo, decimal/hex/octal IPs, IPv6, 127.0.0.2, CGNAT, DNS-to-loopback via a mock resolver). An integration test with a local listener asserts no connection is made.
- **Not:** Adversarial re-check rated MEDIUM (verifier HIGH): TITLE: The script webhook SSRF guard is a raw-string host check that is trivially bypassed, and it points to a webhook_allowlist that does not exist. VERDICT: CONFIRMED. http:// is allowed. The host is taken by splitting on '://', '/' and ':', so userinfo (`http://x@127.0.0.1/`) passes, and `[::1]` reduces to '[', which makes the '[::1]' comparison dead code. 127.0.0.2, 127.1, decimal/hex IPs, ::ffff:127.0.0.1, 100.64/10, IPv6 ULA and DNS names resolving to private addresses (including rebinding) all pass. The URL is also built through context interpolation. scripting.webhook_allowlist exists only in these two strings. POST/PUT with a body are allowed. Redirects are disabled (correct). SEVERITY REDUCERS: deploy_script requires DeployProgram on the signed path (catalog.rs:461-467), so the attacker is a privileged script author who can already drive outputs through script actions. Reachable loopback targets are limited: SCADA GET endpoints are read-only and WS cannot be driven via reqwest, and /lifecycle/confirm-active exists only if the health server is enabled (its auth defaults to Disabled, config.rs:2038-2041), where it could confirm a bad A/B slot. On Suderra-OS the egress filter limits LAN targets to ports 53/123/443/502/4840/8883, while loopback is fully open. ROOT CAUSE: validation runs on the raw URL string instead of on the parsed URL and the resolved socket address actually connected to, and the documented allowlist was never implemented. FIX: parse with url::Url, require https, and resolve via a custom reqwest DNS resolver (reqwest::dns::Resolve) that returns only addresses passing an IpAddr policy (deny loopback, private, link-local, CGNAT, ULA, mapped, unspecified, multicast). Connecting through that resolver closes the rebinding TOCTOU. Implement `scripting.webhook_allowlist: Vec<HostPattern>` as a real config field validated at boot, and make the deny-by-default policy a type (WebhookTarget::try_from(Url)) that is the only input accepted by the send function. TEST: table-driven unit tests over the bypass corpus (userinfo, [::1], 127.1, 2130706433, 0x7f000001, ::ffff:127.0.0.1, 100.64.0.1, a name resolving to 127.0.0.1 via a mock resolver) must all be rejected. A positive test where an allowlisted private host is accepted. A config test where an unknown field is rejected.

<a id="EDGE-MEDIUM-098"></a>

### EDGE-MEDIUM-098 — MQTT broker failover is cosmetic: the client always uses the primary broker, yet failover commands report success

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway/src/mqtt_failover.rs + mqtt.rs + commands/failover.rs
- **Köken:** doğrulanan iddia T49 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/mqtt.rs:233-265`, `sens-api-gateway/src/mqtt_failover.rs:240`, `sens-api-gateway/src/main.rs:1132-1157`, `sens-api-gateway/src/commands/failover.rs:123-131`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/mqtt.rs:233-265 MqttClient::new always builds MqttOptions from config.mqtt.broker and config.mqtt.port.
  - sens-api-gateway/src/mqtt_failover.rs:240 get_active_broker has no callers outside the module. FailoverManager::record_failure (274) and record_success (300) are never called from the MQTT event loop (repo grep).
  - sens-api-gateway/src/main.rs:1132-1157 the manager is built and a health-check task is spawned anyway.
  - sens-api-gateway/src/commands/failover.rs:123-131 force_failover replies 'Failover to backup broker completed' even though the MQTT connection is unchanged.
- **Kök neden:** The failover state machine was built as a standalone primitive, and its integration into the MQTT connection lifecycle was never done.
- **Mimari düzeltme yönü:** Make broker selection owned by FailoverManager: MqttClient takes a BrokerSelector, the event loop reports connect outcomes, and a state change triggers a reconnect to the active endpoint. The command result reflects the actual CONNACK.
- **Doğrulama:** Integration test with two local rumqttd brokers: stop the primary and the client connects to the backup. force_failover returns success only after a CONNACK from the backup.

<a id="EDGE-MEDIUM-099"></a>

### EDGE-MEDIUM-099 — TPM keystore is a trait plus mock only; Auto mode silently falls back to FileBacked

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway/src/keystore/tpm_backed.rs + keystore/bootstrap.rs
- **Köken:** doğrulanan iddia T51 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/keystore/tpm_backed.rs:1-60`, `sens-api-gateway/Cargo.toml:485`, `sens-api-gateway/src/keystore/bootstrap.rs:115-121`, `sens-api-gateway/src/config.rs:1884-1901`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/keystore/tpm_backed.rs:1-60 the batch ships only the TpmDevice trait and MockTpmDevice. No `impl TpmDevice for` a real device exists anywhere in src (grep).
  - sens-api-gateway/Cargo.toml:485 `tpm = ["dep:tss-esapi"]` pulls in the FFI crate with no consumer.
  - sens-api-gateway/src/keystore/bootstrap.rs:115-121 KeystoreMode::Auto only logs a warn and falls through to FileBacked. config.rs:1884-1901 the default is Disabled.
  - Suderra-OS package/suderra-edge-agent/suderra-agent.service DeviceAllow=/dev/tpm0 and /dev/tpmrm0 are granted but unused.
- **Kök neden:** The 'primitive-first' delivery was split across batches, and the real device and boot selector batches never landed while Auto was already wired to degrade.
- **Mimari düzeltme yönü:** Implement RealTpmDevice (tss-esapi) and include it in the release features for TPM-capable targets. Auto must probe and fail closed unless a signed downgrade acceptance exists. Report the keystore tier in telemetry.
- **Doğrulama:** swtpm-backed CI test for seal, unseal and NV-counter anti-rollback. Unit test: Auto with no TPM and no acceptance returns an error.

<a id="EDGE-MEDIUM-100"></a>

### EDGE-MEDIUM-100 — Audit chain has no external anchor; deleted or truncated logs silently restart or continue, and audit is disabled by default

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway/src/audit/sink.rs + config.rs AuditMode
- **Köken:** doğrulanan iddia T53 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/audit/sink.rs:548-580`, `sens-api-gateway/src/audit/sink.rs:193-205`, `sens-api-gateway/src/audit/mod.rs:43`, `sens-api-gateway/src/config.rs:1819-1826`, `sens-api-gateway/src/audit/sink.rs:570-573`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/audit/sink.rs:548-580 a missing or empty file starts at genesis zeros. Tail truncation recovers from the last remaining complete line with no detection (sink.rs:193-205 docs).
  - sens-api-gateway/src/audit/mod.rs:43 the daily ed25519 anchor is cloud-side, not edge-side. There is no persisted chain head on the device.
  - sens-api-gateway/src/config.rs:1819-1826 `#[default] Disabled` for AuditMode.
  - sens-api-gateway/src/audit/sink.rs:570-573 the entire log is read into memory on every open, under MemoryMax=256M.
- **Kök neden:** Chain recovery reads its state from the very file it is supposed to protect, and there is no independent monotonic record of the head.
- **Mimari düzeltme yönü:** Persist (sequence, head HMAC) in an independent monotonic store (TPM NV counter or a signed head file) and periodically publish the signed head to the cloud. On open, a mismatch between the file tail and the stored head raises an alarm and fails closed. Enable audit by default in release, and use FS_APPEND_FL through a privileged helper. Seek to the tail instead of read_to_end.
- **Doğrulama:** Unit tests: truncate the log and open returns ChainHeadMismatch; delete the log and open returns a mismatch, not genesis.

<a id="EDGE-MEDIUM-101"></a>

### EDGE-MEDIUM-101 — ADR-019 security promises diverge from the code (Argon2 parameters, passphrase on disk, key epoch, SignedBootFlag, rescue slot, AntiRollbackCounter)

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** docs/adr/019-edge-firmware-signing-ab-partition.md vs sens-api-gateway keystore/updater
- **Köken:** doğrulanan iddia T55 (CONFIRMED)
- **Kanıt (dosya:satır):** `docs/adr/019-edge-firmware-signing-ab-partition.md:245-257`, `sens-api-gateway/src/config.rs:1954-1956`, `sens-api-gateway/src/keystore/file_backed.rs:77-91`, `sens-api-gateway/src/keystore/bootstrap.rs:76-78`, `sens-api-gateway/src/updater/verify.rs:82`, `sens-api-gateway/src/main.rs:2885-2912`
- **Kanıt (ayrıntı):**
  - docs/adr/019-edge-firmware-signing-ab-partition.md:245-257 promises Argon2id m=256 MiB, t=3, p=4, salt=HKDF(device_id, provisioning_nonce) and a passphrase that is 'never env var, never on-disk'.
  - sens-api-gateway/src/config.rs:1954-1956 the default argon2_memory_kib is 65_536 (64 MiB). keystore/file_backed.rs:77-91 the default is 64 MiB with a 19 MiB floor.
  - sens-api-gateway/src/keystore/bootstrap.rs:76-78 the passphrase and salt are files: /etc/suderra/keystore.passphrase and /etc/suderra/keystore.salt.
  - ADR-019 §3-5 (lines 80-193) specify signing_key_epoch, SignedBootFlag, AntiRollbackCounter and a p6 rescue slot. A src grep finds none of these. updater/verify.rs:82 uses only highest_seen_firmware_version, and main.rs:2885-2912 offers only Noop or Tryboot.
  - The ADR status is 'Proposed' (header), while Suderra-OS uses RAUC (package/suderra-rauc-config), not tryboot/p6.
- **Kök neden:** The ADR was written as a target design, and the code evolved independently with no mechanism linking ADR parameters to code constants.
- **Mimari düzeltme yönü:** Reconcile: amend the ADR to the actual RAUC-based OS design and current keystore, or implement the missing pieces. Add an invariant test that parses the ADR parameter table (Argon2 m/t/p) and compares it with the code defaults, so drift fails CI.
- **Doğrulama:** An invariant test comparing ADR constants to KeystoreConfig::default(). Once implemented, feature tests for epoch anti-rollback and the boot flag.

<a id="EDGE-MEDIUM-102"></a>

### EDGE-MEDIUM-102 — 34 ADR-cited invariant tests do not exist, and d3_boot_order.rs is orphaned by a copy-paste overwrite in Cargo.toml

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** docs/adr 017/018/019 + sens-api-gateway/tests/invariants
- **Köken:** doğrulanan iddia T58 (CONFIRMED)
- **Kanıt (dosya:satır):** `Cargo.toml:853-862`, `Cargo.toml:413`, `sens-api-gateway/docs/product/feature-matrix.md:177`, `sens-api-gateway/docs/deployment/install.md:267`, `sens-api-gateway/src/main.rs:3430`, `sens-api-gateway/src/main.rs:3447`
- **Kanıt (ayrıntı):**
  - I extracted every tests/invariants/*.rs path from docs/adr/017-st-bytecode-runtime.md (9), 018-edge-rbac-abac-model.md (12) and 019-edge-firmware-signing-ab-partition.md (13): 34 unique paths, and none exists anywhere in the repo. Examples: 017:61 st_opcode_set_closed.rs, 017:223 st_vm_never_unwinds.rs, 017:586-589 Faz 3 acceptance criteria; 018:98 rbac_key_segregation.rs, 018:615-618 authz_on_commands.rs / tenant_binding_sealed.rs; 019:41 hsm_slot_uniqueness.rs, 019:131 boot_flag_dual_signature.rs / firmware_epoch_monotonic.rs.
  - All three ADR headers say 'Status: Proposed ... target Accepted 2026-05-03'. That date has passed, and the code they govern (bytecode VM, RBAC, updater) ships.
  - /home/user/aquaculture_platform/sens-api-gateway/tests/invariants/d3_boot_order.rs (189 lines) has no [[test]] entry. Cargo.toml:853-862 still carries the 'D-3 boot-order wire-status invariant' comment but registers name = "cipher_allowlist_fleet_compat": the D-3 entry was overwritten. Cargo only auto-discovers tests/*.rs and tests/*/main.rs, so this file never compiles.
  - Cargo.toml:413, docs/product/feature-matrix.md:177 and docs/deployment/install.md:267 cite tests/invariants/default_build_no_security_escape.rs as 'PRESENT (invariant-tested)'. That file does not exist either.
  - No live regression yet: main.rs:3430 init_keystore still runs before main.rs:3447/3612/3624/3639 (the SQLCipher consumer inits).
- **Kök neden:** Each invariant file has to be registered by hand in Cargo.toml, so one edit can silently drop a target. The ADRs were written as plans that cite test names, and nothing checks that cited paths exist.
- **Mimari düzeltme yönü:** Make discovery automatic: one auto-discovered tests/invariants/main.rs that declares `mod` for every file, or a build-time check that every tests/invariants/*.rs is a target. Add a doc-link invariant: every tests/invariants/*.rs path cited under docs/** must exist and be reachable from a cargo test target. For the ADR-cited invariants, either write them (the safety ones first: st_write_tag_allowlist, st_safe_state_pinned_immutable, emergency_cannot_widen, authz_on_commands) or mark them as planned with tracked finding IDs. Never present them as existing.
- **Doğrulama:** A gate script compares the tests/invariants file list against `cargo metadata` test targets and greps docs/** for cited paths. Today it should fail on d3_boot_order.rs, the 34 ADR paths and default_build_no_security_escape.rs, and pass once they are fixed.

<a id="EDGE-LOW-103"></a>

### EDGE-LOW-103 — Several persistent stores hardcode /var/lib/suderra and ignore SUDERRA_DATA_DIR, so a data-dir override splits state

- **Önem:** LOW · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway persistent path literals
- **Köken:** doğrulanan iddia T04 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/data_dir.rs:31-49`, `sens-api-gateway/src/main.rs:1415`, `sens-api-gateway/src/main.rs:3313`, `sens-api-gateway/src/license_cache.rs:82`, `sens-api-gateway/src/main.rs:1644`, `sens-api-gateway/src/main.rs:1770`, `sens-api-gateway/src/main.rs:1909`, `sens-api-gateway/src/scada_server.rs:62`, `sens-api-gateway/src/updater/partition_store.rs:64`, `sens-api-gateway/src/commands/firmware.rs:315`, `sens-api-gateway/src/config.rs:1483`, `sens-api-gateway/src/config.rs:2550-2551`
- **Kanıt (ayrıntı):**
  - aquaculture_platform/sens-api-gateway/src/data_dir.rs:31-49 SUDERRA_DATA_DIR resolver exists (used by offline_queue main.rs:1415, integrity floor main.rs:3313)
  - license_cache.rs:82 DEFAULT_CACHE_PATH=/var/lib/suderra/license_cache.sqlite
  - main.rs:1644 jti_dedup.sqlite, main.rs:1770 rbac_version.sqlite, main.rs:1909 user_token_version.sqlite (literal fallbacks)
  - scada_server.rs:62 SCADA_DIR=/var/lib/suderra/scada; updater/partition_store.rs:64 /var/lib/suderra/partition.json; commands/firmware.rs:315 /var/lib/suderra/updates
  - config.rs:1483 lora_sessions.db default; config.rs:2550-2551 pki own/trusted dirs
  - Suderra-OS unit sets no SUDERRA_DATA_DIR (suderra-agent.service:12 only SUDERRA_CONFIG), so all paths coincide today and the defect is latent
- **Kök neden:** data_dir() was added later as an opt-in helper, and older consumers were never migrated. Path literals are scattered with no enforcement.
- **Mimari düzeltme yönü:** Derive every persistent path from AgentPaths.state_dir(). Config overrides become paths relative to the state dir, all literals are deleted, and an invariant test rejects '/var/lib/suderra' literals outside the paths module.
- **Doğrulama:** Boot harness with SUDERRA_DATA_DIR=<tmp> and an unwritable /var/lib/suderra: all stores open and every created file lies under <tmp>.

<a id="EDGE-LOW-104"></a>

### EDGE-LOW-104 — GPIO pin validation caps RaspberryPi at 0-27 (rejecting CM4 GPIO 28-45) and allows 0-127 on RevPi, where rppal cannot address those lines

- **Önem:** LOW · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway config.rs GpioPlatform::valid_range
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/config.rs:102-108`
- **Kanıt (ayrıntı):**
  - src/config.rs:102-108 RaspberryPi => (0, 27), RevolutionPi => (0, 127), GenericLinux/Unknown => (0, 255) (confirmed)
  - Platform detection reads /proc/device-tree/model, which ProcSubset=pid hides, so it also falls through to GenericLinux (claim T07)
- **Kök neden:** Pin ranges are a hand-written per-platform table rather than derived from the detected SoC/gpiochip line count.
- **Mimari düzeltme yönü:** Derive the valid range from the gpiochip line count at runtime (or the board profile) and validate configs against it.
- **Not:** Incidental finding (merged from 1 raw report(s)); area=agent.

<a id="EDGE-LOW-105"></a>

### EDGE-LOW-105 — MUTATING_COMMANDS is unused, lists non-existent commands and contradicts envelope.rs docs, while the catalog holds a second divergent list

- **Önem:** LOW · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway command_envelope/mutating.rs
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/command_envelope/mutating.rs:21-48`, `sens-api-gateway/src/command_envelope/envelope.rs:40-43`, `sens-api-gateway/src/command_envelope/envelope.rs:428-450`
- **Kanıt (ayrıntı):**
  - command_envelope/mutating.rs:21-48 lists deploy_firmware, rotate_master_key, write_tag, write_pwm, write_spi, safe_state_clear (none are dispatched); it is only re-exported (mod.rs:89) and referenced nowhere
  - envelope.rs:40-43 docs say Enforcing uses super::mutating::is_mutating, but Gate 7 (envelope.rs:428-450) uses catalog permission_for_command
  - A second divergent list exists: catalog.rs:871-925 MUTATING_WIRE_NAMES
- **Kök neden:** A legacy SSoT was superseded by the catalog but never deleted.
- **Mimari düzeltme yönü:** Delete mutating.rs, point the docs at the catalog, and add an invariant that exactly one mutating-command list exists.
- **Not:** Incidental finding (merged from 1 raw report(s)); area=agent.

<a id="EDGE-LOW-106"></a>

### EDGE-LOW-106 — The OPC UA client sends UserNameIdentityToken with a hardcoded policyId "username" instead of the server-advertised UserTokenPolicy

- **Önem:** LOW · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway plc_programming/opcua.rs
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/plc_programming/opcua.rs:2094`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/plc_programming/opcua.rs:2094 `let policy_id = "username";`
- **Kök neden:** The minimal client skips GetEndpoints/UserTokenPolicy negotiation.
- **Mimari düzeltme yönü:** Select the policyId from EndpointDescription.userIdentityTokens (covered by the T45 SDK replacement).
- **Not:** Incidental finding (merged from 1 raw report(s)); area=agent.

<a id="EDGE-LOW-107"></a>

### EDGE-LOW-107 — Rate-limited commands are dropped with only a local warn: no CommandResponse and no audit event

- **Önem:** LOW · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway commands/mod.rs rate limiter
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/commands/mod.rs:241-248`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/commands/mod.rs:241-248 `continue` after warn; no CommandResponse published and no audit emit
- **Kök neden:** Backpressure is implemented as a silent drop in the transport loop, before the dispatch layer that owns responses and audit.
- **Mimari düzeltme yönü:** Emit a rejected CommandResponse and an audit event for rate-limited commands, and exempt or prioritise safety-class commands.
- **Not:** Incidental finding (merged from 1 raw report(s)); area=agent.

<a id="EDGE-LOW-108"></a>

### EDGE-LOW-108 — If CSP nonce generation fails, the HMI is served under the middleware's static script-src 'none' CSP, giving a blank page

- **Önem:** LOW · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway scada_server.rs scada_page_handler
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/scada_server.rs:883-889`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/scada_server.rs:883-889 a getrandom failure returns SCADA_HTML with an empty HeaderMap; the middleware (2193-2208) then inserts the static CSP with script-src 'none', blocking every script
- **Kök neden:** The fallback path was never tested against the middleware default CSP.
- **Mimari düzeltme yönü:** Return a 500 with a clear error on nonce failure, or use a process-wide CSPRNG that cannot fail per request.
- **Not:** Incidental finding (merged from 1 raw report(s)); area=agent.

<a id="EDGE-LOW-109"></a>

### EDGE-LOW-109 — Dead and misleading PIN code: per-session PinSession lockout fields and is_locked_out are never updated, hash_pin() is never called (the "transparent upgrade" comment is false), and reset_requires_pin/hold_duration are never read

- **Önem:** LOW · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway scada_server.rs / scada_types.rs PIN code
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/scada_server.rs:1160-1183`, `sens-api-gateway/src/scada_server.rs:812-845`, `sens-api-gateway/src/scada_types.rs:234-239`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/scada_server.rs:1160-1183 has_valid_pin_session and is_locked_out read PinSession.lockout_until; every construction sets failed_attempts: 0 and lockout_until: None (1683-1687, 2061-2065) and nothing updates them; the real lockout is global (770-807)
  - scada_server.rs:812-845 the comment claims a transparent hash upgrade on next write, but hash_pin has no caller (grep)
  - src/scada_types.rs:234-239 reset_requires_pin and hold_duration are never read (grep)
- **Kök neden:** The design moved to a global lockout and partial hardening without removing the old paths or wiring new schema fields.
- **Mimari düzeltme yönü:** Remove the dead paths or wire them as part of the T34 per-principal lockout fix; deny dead_code in the scada modules.
- **Not:** Incidental finding (merged from 2 raw report(s)); area=agent.

<a id="EDGE-LOW-110"></a>

### EDGE-LOW-110 — SCADA REST endpoints (/scada/process, /scada/tags, /scada/alarms/history) do not validate the Host header, allowing DNS-rebinding reads

- **Önem:** LOW · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway scada_server.rs SCADA HTTP
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/scada_server.rs:2233-2246`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/scada_server.rs:2233-2246 GET /scada/process, /scada/tags and /scada/alarms/history have no Host/Origin check; CORS restricts only cross-origin reads
- **Kök neden:** Origin validation exists only on the WS upgrade; REST relies on CORS, which does not stop same-origin rebinding.
- **Mimari düzeltme yönü:** Add a router-wide Host allowlist middleware (bind address, configured hostnames, localhost).
- **Not:** Incidental finding (merged from 1 raw report(s)); area=agent.

<a id="EDGE-LOW-111"></a>

### EDGE-LOW-111 — OPC UA login throttle is per-username only, and Argon2 cost comes from the manifest PHC with no floor

- **Önem:** LOW · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway/src/opc_ua_server_user_tokens.rs + opc_ua_server/auth_throttle.rs
- **Köken:** doğrulanan iddia T43 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/opc_ua_server_user_tokens.rs:161-166`, `sens-api-gateway/src/opc_ua_server_user_tokens.rs:98-104`, `sens-api-gateway/src/opc_ua_server/auth_throttle.rs:20-45`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/opc_ua_server_user_tokens.rs:161-166 Argon2idHash::from_phc only checks that the PHC parses. Lines 190-197 Argon2::default().verify_password uses the m/t/p from the PHC string, so a manifest hash with m=8,t=1 is accepted.
  - sens-api-gateway/src/opc_ua_server_user_tokens.rs:98-104 the dummy hash for unknown users is m=19456,t=2. Enrolled hashes with other parameters therefore create a timing oracle for whether a username exists (309-331).
  - sens-api-gateway/src/opc_ua_server/auth_throttle.rs:20-45 the throttle is per-username, and cross-account spray from one IP is explicitly unthrottled (ORPHAN-MEDIUM-051). Each attempt costs at least 19 MiB of Argon2 memory, with no global concurrency cap.
  - Latent: the opc-ua-server feature is not in release builds.
- **Kök neden:** async-opcua's AuthManager does not expose the peer address, so throttling was keyed on the only identifier available, and hash parameters were trusted because the manifest is signed.
- **Mimari düzeltme yönü:** Enforce an Argon2 parameter floor at manifest parse (matching the ADR). Derive the dummy hash parameters from the enrolled set so timing is uniform. Add a global verification semaphore plus per-source throttling through a TCP accept interceptor.
- **Doğrulama:** Unit test: from_phc with m=8 is rejected. A timing test shows unknown and known usernames take equal time. A concurrency test shows more than N simultaneous verifications queue.

<a id="EDGE-LOW-112"></a>

### EDGE-LOW-112 — Raw /etc/machine-id and CPU serial are sent to the cloud at activation (only MACs are pseudonymised)

- **Önem:** LOW · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway/src/provisioning.rs
- **Köken:** doğrulanan iddia T48 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/provisioning.rs:493-500`, `sens-api-gateway/src/provisioning.rs:556-572`, `sens-api-gateway/src/provisioning.rs:530-552`, `sens-api-gateway/src/offline_queue.rs:118-126`, `sens-api-gateway/src/db_migration/v1_legacy_key.rs:141-181`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/provisioning.rs:493-500 collect_fingerprint includes machine_id and cpu_serial.
  - sens-api-gateway/src/provisioning.rs:556-572 the raw value from machine_uid::get() or /etc/machine-id is used. Lines 503-518 send the raw /proc/cpuinfo Serial.
  - sens-api-gateway/src/provisioning.rs:530-552 MACs are hashed, which is inconsistent with sending the other identifiers raw.
  - sens-api-gateway/src/offline_queue.rs:118-126 machine-id is one of the two inputs to the v1 SQLCipher key derivation, so the cloud stores half of the key inputs.
- **Kök neden:** The fingerprint was built from raw OS identifiers, and the pseudonymisation applied to MACs was not extended to the other fields.
- **Mimari düzeltme yönü:** Send app-specific IDs, HMAC-SHA256(machine-id, "suderra-fingerprint-v1") and the same for the CPU serial, as systemd recommends for machine-id. Never send a value that feeds key derivation.
- **Doğrulama:** Unit test with a SUDERRA_MACHINE_ID_PATH fixture: the serialized ActivationRequest does not contain the raw machine-id or serial string.

<a id="EDGE-LOW-113"></a>

### EDGE-LOW-113 — SQLCipher hex key cached as a plain String for the process lifetime; keystore passphrase and salt buffers not zeroized

- **Önem:** LOW · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway/src/offline_queue.rs + keystore/file_backed.rs
- **Köken:** doğrulanan iddia T50 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/offline_queue.rs:103-140`, `sens-api-gateway/src/authz/manifest_version_store.rs:459`, `sens-api-gateway/src/keystore/file_backed.rs:221-260`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/offline_queue.rs:103-140 `static CACHED: OnceLock<String>` holds the PRAGMA key hex for the whole process and returns clone()s as plain String to callers (authz/manifest_version_store.rs:459, 510), which drop them without zeroize.
  - sens-api-gateway/src/keystore/file_backed.rs:221-260 the passphrase and salt Vec<u8> are read, used in hash_password_into (282) and dropped without zeroize. The rotation path at 518-574 does the same.
  - Mitigations: LimitCORE=0 in the unit and PR_SET_DUMPABLE=0 (process_hardening.rs).
- **Kök neden:** Key material moves through ordinary String/Vec types, so zeroization depends on each author remembering it rather than on the type.
- **Mimari düzeltme yönü:** Return Zeroizing<String> or SecretString from derive_db_encryption_key and cache it in a zeroize-on-drop secret type. Read the passphrase into Zeroizing<Vec<u8>>. Add a lint or invariant test forbidding String for key-material APIs.
- **Doğrulama:** Compile-time signature test (the function returns a Zeroizing/Secret type). Unit test that the cache type implements ZeroizeOnDrop.

<a id="EDGE-LOW-114"></a>

### EDGE-LOW-114 — memfd_secret primitive is unused, and mlockall failure is non-fatal and in practice silent

- **Önem:** LOW · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway/src/process_hardening.rs + main.rs
- **Köken:** doğrulanan iddia T52 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/process_hardening.rs:633`, `sens-api-gateway/src/process_hardening.rs:88-112`, `sens-api-gateway/src/main.rs:2966-2990`, `sens-api-gateway/src/main.rs:4137`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/process_hardening.rs:633 `pub mod memfd_secret` has no callers outside the file (grep: only process_hardening.rs plus a comment in db_migration/schema_version.rs).
  - sens-api-gateway/src/process_hardening.rs:88-112 an mlockall error only triggers warn! and harden_process still returns Ok.
  - sens-api-gateway/src/main.rs:2966-2990 harden_process is the first statement of main(), before init_logging (main.rs:4137), so its info!/warn! output, including the mlockall failure, is discarded.
  - Suderra-OS unit grants no CAP_IPC_LOCK and no LimitMEMLOCK, so mlockall(MCL_CURRENT|MCL_FUTURE) is expected to fail.
- **Kök neden:** The hardening primitives were built ahead of the keystore integration that would consume them, and the boot ordering hides their results.
- **Mimari düzeltme yönü:** Allocate MasterKeyMaterial inside a memfd_secret region (falling back to mlock of that page only, not mlockall). Return a structured HardeningReport and log it after tracing init. Make the enforcement policy part of config, failing closed in release when required.
- **Doğrulama:** Unit test that the keystore master key is backed by a SecretRegion. A boot test asserts a hardening-outcome log line exists.

<a id="EDGE-LOW-115"></a>

### EDGE-LOW-115 — Backup format is unencrypted and unsigned, embeds the raw config, and create/restore have no callers

- **Önem:** LOW · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway/src/backup.rs
- **Köken:** doğrulanan iddia T54 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/backup.rs:91-102`, `sens-api-gateway/src/backup.rs:245-325`, `sens-api-gateway/src/backup.rs:103-104`, `sens-api-gateway/src/backup.rs:208-225`, `sens-api-gateway/src/main.rs:1511-1585`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/backup.rs:91-102 and 113 create_backup, restore_backup and validate_auth are unreferenced (`#![allow(dead_code)]`).
  - sens-api-gateway/src/backup.rs:245-325 the format is JSON, gzip and a magic header only, with no encryption or signature. The checksum is an unkeyed SHA-256 of the config only. The config is passed as a raw String.
  - sens-api-gateway/src/backup.rs:103-104 the docs claim the API has 'auth, encryption, ZIP-bomb defense'; encryption does not exist.
  - sens-api-gateway/src/backup.rs:208-225 validate_auth returns Ok when BACKUP_AUTH_SECRET is unset (fail-open). main.rs:1511-1585 the manager is constructed anyway.
- **Kök neden:** The API was kept as a placeholder for future GDPR and DR flows, and the security properties were documented rather than implemented.
- **Mimari düzeltme yönü:** Delete the unreferenced API, or implement it as AEAD-encrypted with a keystore KeyPurpose::Backup key and ed25519 signing, with typed secret redaction. validate_auth must fail closed.
- **Doğrulama:** Unit tests: restoring a tampered backup fails, the backup bytes contain no plaintext MQTT password, and validate_auth with no secret returns an error.

## Bulut — sensor-service

<a id="SENSOR-CRITICAL-200"></a>

### SENSOR-CRITICAL-200 — Activation credentials are persisted by rewriting the whole config.yaml via save(); secrets are only base64-encoded, and on Suderra OS the save fails after the cloud has already consumed the single-use token

- **Önem:** CRITICAL · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway activation flow (main.rs run_agent) + config.rs save_to + cloud provisioning.service.ts
- **Köken:** doğrulanan iddia T06 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/main.rs:4574-4607`, `sens-api-gateway/src/main.rs:4646-4679`, `sens-api-gateway/src/config.rs:4239-4290`, `sens-api-gateway/src/config.rs:28-50`, `apps/sensor-service/src/edge-device/provisioning.service.ts:356-363`, `Suderra-OS/package/suderra-edge-agent/suderra-edge-agent.mk:52`, `sens-api-gateway/src/commands/config_dispatch.rs:76-80`, `sens-api-gateway/src/commands/provision.rs:111`
- **Kanıt (ayrıntı):**
  - aquaculture_platform/sens-api-gateway/src/main.rs:4574-4607 self-register: writes device_id/mqtt broker/username/password/tenant_id into state.config then config.save()
  - main.rs:4646-4679 legacy activation: same fields, then config.save() ('device may be unrecoverable on restart')
  - config.rs:4239-4290 save()/save_to(): serde_yaml of the entire AgentConfig, tmp 0600 + rename next to /etc/suderra/config.yaml
  - config.rs:28-50 serialize_secret_option uses the 'b64:' prefix; the comment admits 'base64 is encoding, not encryption'
  - Cloud consumes the token before the device persists: apps/sensor-service/src/edge-device/provisioning.service.ts:356-363 (TOKEN_ALREADY_USED), :397-405 tokenUsedAt=now, provisioningToken=null
  - Suderra-OS: suderra-edge-agent.mk:52,56 config dir root:suderra 0750 and config.yaml 0640; suderra-edge-install:146,279-280 same. User suderra cannot create the tmp file or rename even with a correct path
  - Other save() callers that break too: commands/config_dispatch.rs:76-80 (remote config update), commands/provision.rs:111,201 (Modbus device provisioning)
- **Kök neden:** The operator config file doubles as a credential store and as mutable runtime state. The activation protocol is not idempotent: the cloud commits token consumption before the device has made the credentials durable.
- **Mimari düzeltme yönü:** (1) Keep the activation result in a dedicated credential store in StateDir, encrypted with the keystore/TPM rather than base64; the agent never writes config.yaml. (2) Prefer CSR-based mTLS identity (key generated on device, ideally in TPM), so no shared MQTT password is persisted at all. (3) Make activation two-phase: the cloud issues credentials as 'pending', the device persists them and returns a signed confirmation, and only then does the cloud mark the token used (or allow re-issue within its TTL).
- **Doğrulama:** Activation integration test with a read-only config dir and fault injection (kill between HTTP response and persist): the device must re-activate successfully. A grep test over the state dir must find no plaintext or base64 secrets.

<a id="SENSOR-CRITICAL-201"></a>

### SENSOR-CRITICAL-201 — Production can only run Permissive or Disabled, where unsigned legacy commands drive outputs and I/O config with no RBAC

- **Önem:** CRITICAL · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway command_envelope / commands mqtt_dispatch + catalog / config validation
- **Köken:** doğrulanan iddia T23 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/command_envelope/envelope.rs:66-77`, `sens-api-gateway/src/config.rs:270-272`, `sens-api-gateway/src/config.rs:1697-1710`, `sens-api-gateway/src/config.rs:3787-3806`, `sens-api-gateway/src/commands/mqtt_dispatch.rs:135-176`, `sens-api-gateway/src/commands/catalog.rs:974-1002`, `sens-api-gateway/src/commands/dispatch_lifecycle.rs:207-258`, `apps/sensor-service/src/edge-device/command-envelope-signer.service.ts:171`, `sens-api-gateway/src/commands/mqtt_dispatch.rs:142-151`
- **Kanıt (ayrıntı):**
  - src/command_envelope/envelope.rs:66-77 SignatureMode `#[default] Disabled`; config.rs:270-272 `#[serde(default)] signature_mode`
  - src/config.rs:1697-1710 RbacManifestMode `#[default] Disabled`
  - src/config.rs:3787-3806 the release-only checks reject just signature_mode=disabled and mtls.mode=legacy. Permissive passes, and rbac_manifest.mode is not checked
  - src/commands/mqtt_dispatch.rs:135-176 (NotEnvelopeFormat) and :226-243 (pre-provisioning): legacy CommandMessage executes after only `legacy_command_permitted`, with no authorize_adapted/RBAC call
  - src/commands/catalog.rs:974-1002 legacy_command_permitted: in Permissive, DenyUnsignedInEnforcing returns Ok
  - Executable unsigned in Permissive (not two-person-gated): write_gpio (GpioPinParam), write_modbus, set_output, update_io_config, provision_modbus_device, rotate_master, failover_force, update_policy, set_log_level (catalog.rs entries 380-470, 621, 677-695, 786-800). DeployProgram/UpdateFirmware/Reboot-class commands are blocked by the two-person gate (dispatch_lifecycle.rs:207-258)
  - The cloud never signs: CommandEnvelopeSignerService (apps/sensor-service/src/edge-device/command-envelope-signer.service.ts:171) has no consumers, and every publish in edge-device.service.ts (:1187, :1263, :1627, :1888, :2569) sends a legacy CommandMessage. Enforcing therefore rejects all cloud commands (mqtt_dispatch.rs:142-151), so the fleet must run Permissive
- **Kök neden:** Rollout states (Disabled/Permissive) were kept as runtime enums with serde defaults instead of build-time stages. The cloud signer was never wired, so the only working production posture is the transitional one. Authorization was attached only to the envelope path, not to the command boundary.
- **Mimari düzeltme yönü:** Make it impossible: release builds compile without the Disabled and Permissive variants (cfg-gated). Authorization runs at one dispatch chokepoint over a verified principal type that the legacy parser cannot produce, so no path reaches a handler without an authenticated actor and an RBAC Allow. Wire CommandEnvelopeSignerService into every cloud publish path (with co-approval UX for two-person commands) before flipping the fleet to Enforcing. Release validation must also require rbac_manifest.mode=enforcing.
- **Doğrulama:** Unit: with the release cfg, SignatureMode has only Enforcing (compile-time). Integration: a legacy write_gpio/set_output payload is rejected in every mode. A signed envelope from an operator without GpioWrite is denied. Contract test: every cloud command publisher emits a v3 envelope that the Rust verifier accepts (shared fixtures).

<a id="SENSOR-CRITICAL-202"></a>

### SENSOR-CRITICAL-202 — Releases are signed only with cosign keyless; Suderra OS accepts only Ed25519-signed artifacts, so no official release can be installed. An unused armv7 build can also block releases

- **Önem:** CRITICAL · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** edge-agent-release.yml signing/matrix vs Suderra OS edge artifact trust
- **Köken:** doğrulanan iddia T64 (CONFIRMED)
- **Kanıt (dosya:satır):** `.github/workflows/edge-agent-release.yml:346-367`, `Suderra-OS/board/suderra/common/rootfs-overlay/usr/sbin/suderra-edge-install:10`, `Suderra-OS/userspace/suderra-installer/src/contracts.rs:24`, `Suderra-OS/package/suderra-keys/suderra-keys.mk:81`, `Suderra-OS/userspace/suderra-installer/src/contracts.rs:46`, `apps/sensor-service/src/edge-device/installer-script.service.ts:247-251`, `.github/workflows/edge-agent-release.yml:154-163`, `apps/sensor-service/src/edge-device/installer-script.service.ts:579`
- **Kanıt (ayrıntı):**
  - /home/user/aquaculture_platform/.github/workflows/edge-agent-release.yml:346-367 cosign sign-blob keyless (ephemeral Fulcio ECDSA cert); :445-450 manifest signing.mode 'cosign-keyless'; :457-464 the manifest is cosign-signed too. Nothing in the workflow produces an Ed25519 signature.
  - Suderra OS requires an Ed25519 signature over the artifact bytes, carried in a signed 'suderra.edge-provisioning.v1' manifest and checked against the pinned /etc/suderra/edge-artifact.ed25519.pub: board/suderra/common/rootfs-overlay/usr/sbin/suderra-edge-install:10,165-168,236-243; userspace/suderra-installer/src/contracts.rs:24,362-381,847; package/suderra-keys/suderra-keys.mk:81.
  - Nothing produces that manifest or signature: 'edge-provisioning.v1' appears nowhere in aquaculture_platform, and the OS installer CLI has only Plan/VerifyArtifact (contracts.rs:46,59). The cloud manifest offers a `signature_url` (installer-script.service.ts:247-251), while the OS expects inline artifact.signature hex.
  - Matrix: edge-agent-release.yml:154-163 includes armv7-unknown-linux-gnueabihf, and :381 requires armv7 artifacts, so a failed armv7 build fails the whole release.
  - Every Suderra OS defconfig is BR2_aarch64 (cortex_a72) or BR2_x86_64 (corei7) on glibc (/home/user/Suderra-OS/configs/*). There is no armv7. The only armv7 consumer is the cloud's generic-Linux installer (installer-script.service.ts:579,1020).
- **Kök neden:** Two trust models were designed independently: Sigstore keyless provenance in cloud CI, and an offline pinned Ed25519 key with epoch and rollback floor in the OS. No signer bridges them. armv7 is a legacy Raspbian/RPi3 target carried over from before Suderra OS.
- **Mimari düzeltme yönü:** Choose one edge artifact trust root and make the other path impossible. Either the release pipeline signs the tarball and a per-release manifest with the Ed25519 edge-artifact key from an HSM/KMS step (key_epoch and rollback_floor included), keeping cosign as extra transparency evidence; or the OS verifier verifies Sigstore bundles offline against a pinned identity and TUF root. Add a final release job that runs the pinned suderra-installer `edge-manifest verify-artifact` with the production public key on the produced artifacts, so a release the OS cannot verify cannot be published. Derive the build matrix from a shared supported-targets file that the OS defconfigs and the cloud installer also consume, and drop armv7 if nothing supported needs it.
- **Doğrulama:** CI job: build suderra-installer at the pinned Suderra-OS revision and verify the release artifacts and manifest. Negative test: a cosign-only artifact must fail. An invariant asserts that the release matrix equals the supported-targets list.

<a id="SENSOR-CRITICAL-203"></a>

### SENSOR-CRITICAL-203 — Release agent refuses to boot with every shipped config: cloud and Suderra OS templates omit signature_mode and mtls.mode, whose serde defaults (Disabled/Legacy) are rejected by release-only validation

- **Önem:** CRITICAL · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway config.rs release gates + cloud installer-script.service.ts + Suderra-OS config skeletons
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/config.rs:3787-3806`, `sens-api-gateway/src/config.rs:3251-3262`, `sens-api-gateway/src/command_envelope/envelope.rs:66-72`, `sens-api-gateway/src/config.rs:271-272`, `sens-api-gateway/src/mtls/mode.rs:34-39`, `sens-api-gateway/src/config.rs:243`, `apps/sensor-service/src/edge-device/installer-script.service.ts:325-355`, `Suderra-OS/package/suderra-edge-agent/config.yaml:1-12`, `Suderra-OS/board/suderra/common/rootfs-overlay/etc/systemd/system/suderra-firstboot.service:52-65`, `sens-api-gateway/src/main.rs:3189`, `.github/workflows/edge-agent-release.yml:240`
- **Kanıt (ayrıntı):**
  - Spot-checked: config.rs:3787-3806 bails on SignatureMode::Disabled and MtlsMode::Legacy under cfg(not(debug_assertions)); load_from() (config.rs:3251-3262) calls validate(); Cargo.toml [profile.release] (549-554) sets no debug-assertions override
  - sens-api-gateway/src/command_envelope/envelope.rs:66-72 SignatureMode #[default] Disabled; config.rs:271-272 #[serde(default)] signature_mode; src/mtls/mode.rs:34-39 MtlsMode #[default] Legacy; config.rs:243 #[serde(default)] mtls
  - apps/sensor-service/src/edge-device/installer-script.service.ts:325-355 and :422-452 generated config.yaml templates contain no signature_mode and no mtls section (grep confirms)
  - Suderra-OS package/suderra-edge-agent/config.yaml:1-12 and rootfs-overlay/etc/systemd/system/suderra-firstboot.service:52-65 skeleton configs contain neither key
  - sens-api-gateway/src/main.rs:3189 AgentConfig::load(); :3284-3287 and :3318-3322 Err -> std::process::exit(1)
  - Release binaries are built with --release (edge-agent-release.yml:240; Buildroot pkg-cargo.mk:244 adds --release unless BR2_ENABLE_DEBUG); all CI test jobs run the debug profile, so this path is never exercised
- **Kök neden:** Fail-closed release gates (cfg(not(debug_assertions))) were layered on top of insecure serde defaults kept for backward compatibility; the config producers (cloud installer template, OS package config, firstboot skeleton) were never updated, and every CI test runs in debug, so no test validates producer output under release semantics.
- **Mimari düzeltme yönü:** Make it impossible: make the release-build defaults the secure values (or make the fields required) and generate every config template from one schema exported by AgentConfig. Add a `cargo test --release` contract job that runs AgentConfig::load/validate on the cloud-rendered config, the OS package config and the firstboot skeleton.
- **Not:** Incidental finding (merged from 4 raw report(s)); area=agent.

<a id="SENSOR-HIGH-204"></a>

### SENSOR-HIGH-204 — The cloud's Suderra OS install manifest is unsigned and in a different format from what the OS verifier accepts

- **Önem:** HIGH · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sensor-service edge-device / InstallerScriptService.renderSuderraOsInstallManifest
- **Köken:** doğrulanan iddia T114 (CONFIRMED)
- **Kanıt (dosya:satır):** `apps/sensor-service/src/edge-device/installer-script.service.ts:27-35`, `apps/sensor-service/src/edge-device/installer-script.service.ts:243-267`, `apps/sensor-service/src/edge-device/provisioning.service.ts:288-324`, `Suderra-OS/userspace/suderra-installer/src/contracts.rs:24`, `Suderra-OS/userspace/suderra-installer/src/contracts.rs:285-299`, `Suderra-OS/board/suderra/common/rootfs-overlay/usr/sbin/suderra-edge-install:173-181`, `.github/workflows/edge-agent-release.yml:353-367`, `Suderra-OS/userspace/suderra-installer/src/contracts.rs:376-380`, `Suderra-OS/board/suderra/common/rootfs-overlay/etc/suderra/edge-install.env:14`, `Suderra-OS/docs/operations/edge-agent-update.md:30-50`, `apps/sensor-service/src/edge-device/installer-script.service.ts:244-249`
- **Kanıt (ayrıntı):**
  - apps/sensor-service/src/edge-device/installer-script.service.ts:27-35 - SuderraOsInstallManifest is a flat object {version, artifact_url, sha256, signature_url, binary_name, artifact_format, activation_token}
  - installer-script.service.ts:243-267 - the render step just reads env values and returns them. Nothing is signed, and it has no schema_version, kind, device_id, device_code, tenant_id, board, arch, not_before, expires_at, rollback_floor, key_epoch, signature, artifact.size_bytes, artifact.signature or config{sha256,payload}. The activation_token is plaintext
  - provisioning.service.ts:288-324 - generateSuderraOsInstallManifest returns Promise<unknown>. The mqttBroker, mqttPort and deviceId it passes in are dropped by the renderer
  - Suderra-OS userspace/suderra-installer/src/contracts.rs:24 - EDGE_MANIFEST_KIND = "suderra.edge-provisioning.v1"; :99-116 the EdgeProvisioningManifest struct requires all of the fields above; :118-126 EdgeArtifact requires size_bytes and signature
  - contracts.rs:285-299 - strict serde parsing, then ensure_schema, then an Ed25519 check over canonical bytes with the signature removed. The cloud object fails the very first parse with 'edge provisioning manifest JSON is invalid'. :301-331 then check non-empty identity fields, https URL, time window, key_epoch, rollback_floor and the config digest
  - Suderra-OS board/suderra/common/rootfs-overlay/usr/sbin/suderra-edge-install:173-181 runs `suderra-installer edge-manifest plan` on the manifest; :275-285 exit 2 when there is no digest-bound config payload
  - suderra-edge-install:26-39 - the usage text still lists the old flat fields 'version, artifact_url, sha256, signature_url, binary_name'. The cloud shape matches this stale text, not contracts.rs
  - aquaculture_platform .github/workflows/edge-agent-release.yml:353-367 - the release only produces cosign keyless .sig/.pem files (sigstore ECDSA). It never produces an Ed25519 signature for the pinned /etc/suderra/edge-artifact.ed25519.pub (suderra-edge-install:10; contracts.rs:376-380), so even a correct signature_url points at a signature the OS cannot verify
- **Kök neden:** The cloud and the OS share no versioned, machine-checked provisioning contract. The cloud renderer was written against the OS script's outdated usage text, while the real verifier was hardened separately into a signed Ed25519 contract. The cloud has no provisioning-manifest signing key or service, and the manifest comes from global env vars rather than per-device, per-board release data.
- **Mimari düzeltme yönü:** Define suderra.edge-provisioning.v1 once, as a JSON Schema plus canonicalization rules in a shared contract artifact. Generate the TypeScript type and the Rust serde struct from that one schema, so a missing field fails to compile on either side. Add a cloud ProvisioningManifestService that builds the manifest per device from a signed release registry keyed by board and arch (EdgeFirmwareReleaseV2). It must include not_before/expires_at, rollback_floor, key_epoch and a config payload (agent config YAML with device_id/code/tenant/api_url/mqtts broker/activation secret) with its sha256, and be signed with Ed25519 by a KMS-held key whose epoch the OS pins. Change the release pipeline to also emit an Ed25519 artifact signature from the same key hierarchy.
- **Doğrulama:** Cross-repo golden-fixture CI job: the cloud generates a manifest with a test key, then the Rust `suderra-installer edge-manifest plan` and `verify-artifact` must accept it. Negative cases: a tampered field, an expired window, a low key_epoch and a missing config each have to be rejected. Add a jest schema-validation test on the renderer's output.
- **Durum notu (2026-10-20):** Advanced, not closed; the `Closes:` trailer of 6067b91a is withdrawn. The cloud side is done: the manifest is the signed, device-bound suderra.edge-provisioning.v1 delivery, and the golden tests verify it with the contract's reference verifier. Open: the Ed25519 release statement from the release pipeline (SENSOR-CRITICAL-202). Until an official release is signed, the endpoint can answer only release-unavailable.
- **Not:** Any one of the missing fields, the missing signature, or the missing config payload is enough to break provisioning on its own. The renderer's 'version' value (agentVersion) is also never validated and is empty in the droplet (AGENT_VERSION unset). Adversarial re-check rated HIGH (verifier CRITICAL): Confirmed. renderSuderraOsInstallManifest returns a flat, unsigned 7-field object. contracts.rs needs schema_version, kind, device_id, device_code, tenant_id, board, arch, artifact{url,sha256,size_bytes,signature,binary_name,format}, not_before, expires_at, rollback_floor, key_epoch and signature, and none of these fields has a serde default. serde_json::from_slice therefore fails before the Ed25519 check is reached. suderra-edge-install also refuses any manifest without a config payload (exit 2), and the release workflow produces only cosign keyless signatures, never an Ed25519 one. No code anywhere signs or reshapes the manifest on its way to the device. I found no counter-evidence. I lower the severity from CRITICAL because the failure is closed: the OS rejects the manifest. The cloud already received the activation token in the request header, so returning it exposes nothing new, and the generic curl|bash provisioning path does not depend on this one. This is a complete functional break of Suderra OS provisioning, not a security hole.

<a id="SENSOR-HIGH-205"></a>

### SENSOR-HIGH-205 — The manifest endpoint requires an X-Provisioning-Token header that the OS fetch path never sends

- **Önem:** HIGH · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sensor-service ProvisioningController GET install/:deviceCode/suderra-os + Suderra-OS suderra-provision/suderra-edge-install
- **Köken:** doğrulanan iddia T115 (CONFIRMED)
- **Kanıt (dosya:satır):** `apps/sensor-service/src/edge-device/provisioning.controller.ts:145-160`, `Suderra-OS/board/suderra/common/rootfs-overlay/usr/sbin/suderra-provision:42-50`, `apps/sensor-service/src/edge-device/installer-script.service.ts:232-237`, `Suderra-OS/docs/operations/edge-agent-update.md:56`
- **Kanıt (ayrıntı):**
  - apps/sensor-service/src/edge-device/provisioning.controller.ts:145-160 - the token is read only from the x-provisioning-token header; when it is missing the endpoint returns 401 {error:'Provisioning token required'}
  - Suderra-OS board/suderra/common/rootfs-overlay/usr/sbin/suderra-provision:42-50 - install-manifest-url keeps only $2 (the URL). Any later argument is silently dropped
  - suderra-provision-worker:48-51 - only the URL goes to `suderra-edge-install --manifest-url`
  - suderra-edge-install:65-86 - fetch_https runs curl with no -H/--header option, so no token can reach the server
  - apps/sensor-service/src/edge-device/installer-script.service.ts:232-237 - the cloud command builder emits `ssh provision@IP install-manifest-url URL X-Provisioning-Token:TOKEN`. That third argument is the one suderra-provision drops
  - Suderra-OS docs/operations/edge-agent-update.md:56 - the documented transport carries the token in the URL path (`/install/suderra-os/<token>.json`), which the cloud no longer accepts
- **Kök neden:** SENSOR-MEDIUM-002 moved the token from the URL into a header on the cloud side only. The OS forced-command grammar and fetcher were never updated, and no shared spec or test covers the provisioning transport between the two repos.
- **Mimari düzeltme yönü:** Define one transport contract that keeps the secret out of the OS fetch. Preferred: the cloud or tenant panel pushes the signed manifest over `install-manifest-json` on stdin, and the activation secret travels inside the signed, digest-bound config payload. If device-side pull stays, put an explicit `install-manifest-url URL` grammar plus token-on-stdin in one spec, have curl send it with `--header @file` from a 0600 tmpfs file, and generate both the cloud command builder and the OS parser from or against that spec.
- **Doğrulama:** Integration test running suderra-provision and suderra-provision-worker in a container against a mock HTTPS endpoint that requires the header, asserting status=ok. Cloud unit test that parses the builder's output with the OS forced-command grammar fixture. A negative test confirms a missing token still returns 401.
- **Durum notu (2026-10-20):** Advanced, not closed; the `Closes:` trailer of 6067b91a is withdrawn. Cloud side done: the endpoint reads the token from X-Provisioning-Token only and refuses one in the query, and the command builder emits `ssh provision@<ip> provision <device-code>` with no token in argv. Open: the OS twin EI-016, which is still Refs in Suderra-OS, and this finding's container integration test and builder-versus-OS-grammar fixture test.
- **Not:** Putting the token in SSH argv (the current builder) would also expose it in SSH_ORIGINAL_COMMAND and process listings. Adversarial re-check rated HIGH (verifier CRITICAL): Confirmed. The controller returns 401 when the x-provisioning-token header is missing. suderra-provision keeps only $2 for install-manifest-url, so the cloud builder's third argument 'X-Provisioning-Token:TOKEN' is dropped. The worker passes only the URL, and fetch_https runs curl with no -H. The QEMU target has no .curlrc that could add a header, and neither edge-install.env nor the script feeds any header into curl. The documented OS flow (token in the URL path) does not match any cloud route. This is an independent blocker of the same flow as T114. The failure is closed, but the builder also puts the token in SSH argv (SSH_ORIGINAL_COMMAND).

<a id="SENSOR-HIGH-206"></a>

### SENSOR-HIGH-206 — Cloud commands, including physical-output writes, are published unsigned; the envelope signer is never wired in and there is no RBAC manifest producer

- **Önem:** HIGH · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sensor-service CommandEnvelopeSignerService / all cloud-to-edge command publishers
- **Köken:** doğrulanan iddia T118 (CONFIRMED)
- **Kanıt (dosya:satır):** `apps/sensor-service/src/edge-device/command-envelope-signer.service.ts:171`, `apps/sensor-service/src/edge-device/edge-device.module.ts:64-75`, `apps/sensor-service/src/edge-device/edge-device.service.ts:1187`, `apps/sensor-service/src/vfd/services/vfd-edge-write.service.ts:117-133`, `apps/sensor-service/src/release-bundle/deploy-bundle-dispatcher.service.ts:181-187`, `sens-api-gateway/src/command_envelope/envelope.rs:68-77`, `apps/sensor-service/src/edge-device/mqtt-auth.service.ts:379`, `sens-api-gateway/src/commands/system.rs:232-236`, `sens-api-gateway/src/commands/dispatch_lifecycle.rs:207-258`
- **Kanıt (ayrıntı):**
  - apps/sensor-service/src/edge-device/command-envelope-signer.service.ts:171 - the class is referenced only by __tests__/command-envelope-signer.spec.ts. It is not in edge-device.module.ts:64-75 providers. :22-26 says that with no key the envelope goes out unsigned
  - No SENSOR_COMMAND_SIGNING_KEY_SEED_HEX in any docker-compose*.yml or .env.example
  - edge-device.service.ts:1187 (ping), :1263 (reboot), :1888 (set_output), :2567 (update_firmware) - raw {commandId, command, params, timestamp} published to tenants/{t}/devices/{id}/commands
  - vfd/services/vfd-edge-write.service.ts:117-133 - write_modbus to VFDs is unsigned. release-bundle/deploy-bundle-dispatcher.service.ts:181-187 - deploy_bundle is unsigned
  - sens-api-gateway/src/command_envelope/envelope.rs:68-77 + config.rs:3787-3807 - release builds reject signature_mode=disabled. The operator must choose Permissive, where unsigned mutating commands are accepted, or Enforcing, where every cloud command is rejected
  - grep for rbac[_-]manifest/RbacManifest/operator_pubkey across apps/, libs/ and web/ finds nothing, so there is no cloud producer of the operator RBAC manifest
  - mqtt-auth.service.ts:379 - the sensor_service account may publish on any tenant's tenants/*/(devices|commands)/ topics, so one service credential controls every tenant's outputs
- **Kök neden:** The signer was built as a standalone library to close SEC-MEDIUM-105 but never placed on a single command egress path. Each feature publishes raw JSON straight through mqtt.publish, so there is no chokepoint where signing could be enforced automatically. The RBAC manifest or actor-key side was never built in the cloud.
- **Mimari düzeltme yönü:** Add one EdgeCommandDispatcher as the only component allowed to publish to `/commands`. It builds and signs envelope v3 with the authenticated operator as actor, the tenant, policy_version and jti, using a KMS or HSM key, and refuses to boot in production without it. Add an ESLint rule plus an invariant spec banning mqtt.publish to a commands topic anywhere else. Build a cloud service that issues and distributes the signed RBAC manifest (operator pubkeys, roles, policy_version). Once both exist, ship agents with signature_mode=enforcing by default. Narrow the sensor_service ACL so it can no longer publish commands.
- **Doğrulama:** Invariant spec that scans for `/commands` publishes outside the dispatcher. Keep the existing cross-language vector test. E2E with the agent in Enforcing: a signed set_output from the cloud runs; unsigned, tampered, expired or replayed (same jti) commands are rejected. ACL unit test that sensor_service cannot publish /commands.
- **Not:** In Permissive mode, anyone who can publish to the broker on that topic (compromised sensor-service, broker or service credential) can drive outputs and VFD registers. Adversarial re-check rated HIGH (verifier CRITICAL): Confirmed. CommandEnvelopeSignerService is referenced only by its spec and is not a provider. Every publisher sends raw {commandId, command, params, timestamp}. On the agent side, a non-envelope payload falls back to legacy parsing in Disabled or Permissive mode, and DenyUnsignedInEnforcing commands such as set_output are accepted unsigned in Permissive. Enforcing rejects every non-envelope payload. No cloud code produces an RBAC manifest. A related problem: the cloud-generated config.yaml sets neither signature_mode nor mtls.mode, so both default to Disabled and Legacy. validate_faz2_security_coherence() then bails in release builds, and an operator must hand-edit the config, in practice to Permissive, before the agent runs. No setting is both secure and able to run cloud commands. I lower the severity from CRITICAL because exploitation needs a prior compromise of the broker, sensor-service, or the sensor_service/backend_service MQTT credentials. Device accounts are ACL-confined to their own tenant and device namespace, so an external or cross-tenant device cannot inject commands.

<a id="SENSOR-HIGH-207"></a>

### SENSOR-HIGH-207 — Nothing in either repo produces the ed25519 SignedFirmwareManifest the agent verifies, while the cloud disables legacy OTA and points operators to it

- **Önem:** HIGH · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** release pipeline / sensor-service vs sens-api-gateway updater/manifest.rs
- **Köken:** doğrulanan iddia T16 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/updater/manifest.rs:140-176`, `.github/workflows/edge-agent-release.yml:346-464`, `apps/sensor-service/src/deploy-artifact/deploy-signing.service.ts:31-50`, `apps/sensor-service/src/edge-device/edge-device.service.ts:2531-2542`, `tools/gates/sens-enterprise-validation.ts:711-735`, `apps/sensor-service/src/edge-device/edge-device.service.ts:2522-2527`, `.github/workflows/edge-agent-release.yml:369-464`
- **Kanıt (ayrıntı):**
  - aquaculture_platform/sens-api-gateway/src/updater/manifest.rs:140-176 FirmwareManifest/SignedFirmwareManifest (doc says 'Cloud release pipeline produces this'); :222-242 canonical bytes ending in b"firmware-manifest-v1"
  - grep 'firmware-manifest-v1' across aquaculture_platform and Suderra-OS: only sens-api-gateway/src/updater/manifest.rs and src/scripting/bytecode_sig.rs (verifier side)
  - edge-agent-release.yml:346-464 produces cosign keyless signatures and edge-release-manifest.json (kind suderra.edge.release.manifest), not an ed25519 SignedFirmwareManifest
  - apps/sensor-service/src/deploy-artifact/deploy-signing.service.ts:31-50 signs only scada-package/process/bundle domains; edge-device.service.ts:2531-2542 rejects legacy OTA and refers to 'apply_signed_manifest'; no cloud code sends that command (grep)
  - tools/gates/sens-enterprise-validation.ts:711-735 gate only checks for cosign manifest markers
- **Kök neden:** The verifier was built ahead of any producer, and no end-to-end contract test exists. Three incompatible release manifest formats coexist: the agent's ed25519 manifest, CI's cosign manifest, and the OS's EdgeProvisioningManifest.
- **Mimari düzeltme yönü:** Converge on one signed edge-release manifest format. Put its canonical bytes in a shared crate/schema used by the signer (CI with KMS/HSM ed25519) and every verifier (OS installer, plus the agent if it keeps one). The release workflow signs, and the cloud registry distributes.
- **Doğrulama:** CI e2e: the release workflow emits the manifest, then run the production verifiers (suderra-installer edge-manifest plan and the agent verifier) against it and expect a pass; flip one byte and expect a failure.

<a id="SENSOR-HIGH-208"></a>

### SENSOR-HIGH-208 — AGENT_VERSION is not set in any deployment, so every generic installer, uninstall and update script request throws and returns an error script or 500

- **Önem:** HIGH · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** docker-compose.droplet.yml sensor-service env / InstallerScriptService
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `apps/sensor-service/src/edge-device/installer-script.service.ts:60`, `docker-compose.droplet.yml:1029-1076`, `apps/sensor-service/src/edge-device/provisioning.controller.ts:120-134`, `apps/admin-api-service/src/system-management/services/global-settings.service.ts:879-880`
- **Kanıt (ayrıntı):**
  - Spot-checked: apps/sensor-service/src/edge-device/installer-script.service.ts:60 AGENT_VERSION defaults to ''; :179-183 assertExplicitAgentVersion throws on '' or 'latest'; used at :297, :396 and :511
  - Spot-checked: grep of docker-compose*.yml, infrastructure/ and .github/workflows finds no AGENT_VERSION, and the sensor-service service in docker-compose.droplet.yml:1029-1076 has no env_file
  - provisioning.controller.ts:120-134 turns the throw into an error script returned with 200, and :255-261 returns 500 for /update
  - The admin-API fallback would supply 'latest' (global-settings.service.ts:879-880), which also throws; the remote fetch itself never authenticates (see provisioning-config finding)
  - Same class as claim T116 (SUDERRA_OS_EDGE_* missing), different variable and endpoints
- **Kök neden:** Required release configuration is read lazily with an empty default and is validated only per request, not at boot or in the deploy SSoT; the admin-API fallback can only supply "latest", which is also rejected.
- **Mimari düzeltme yönü:** Resolve the agent version from the signed release registry, or require it through a boot-time validated config schema plus a deploy-SSoT invariant test over docker-compose*.yml.
- **Not:** Incidental finding (merged from 1 raw report(s)); area=cloud.

<a id="SENSOR-HIGH-209"></a>

### SENSOR-HIGH-209 — Command-envelope canonicalization rejects any nested-object param, so deploy_bundle (params.contents map) and deploy_scada_package (meta/packageData objects) can never be sent as signed envelopes, even once the cloud signer is wired

- **Önem:** HIGH · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway command_envelope/canonical.rs
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/command_envelope/canonical.rs:133-139`, `apps/sensor-service/src/release-bundle/deploy-bundle-dispatcher.service.ts:136-156`
- **Kanıt (ayrıntı):**
  - Spot-checked: sens-api-gateway/src/command_envelope/canonical.rs:133-139 returns CanonicalParamsError::ParamsNotAnObject when any param value is_object() (deferred as BATCH-007-FU-01)
  - Spot-checked: apps/sensor-service/src/release-bundle/deploy-bundle-dispatcher.service.ts:136-156 builds params.contents as a Record<sha256, string> object
  - deploy_scada_package carries meta/packageData objects, so it cannot be enveloped either
  - The rest of incidental #1 (cloud never signs, two-person gate rejects legacy commands) duplicates claim T118
- **Kök neden:** Recursive canonical ordering was deferred (BATCH-007-FU-01) and the canonicalizer fails closed on nested objects instead of defining a deterministic encoding for them; no contract test feeds real cloud command payloads through the envelope path.
- **Mimari düzeltme yönü:** Specify a deterministic recursive canonicalization (e.g. RFC 8785 JCS) under a bumped domain tag, implement it identically in the TS signer and the Rust verifier with golden vectors, and add a contract test that every cloud command builder output canonicalizes and verifies in Enforcing mode.
- **Not:** Incidental finding (merged from 1 raw report(s)); area=agent.

<a id="SENSOR-HIGH-210"></a>

### SENSOR-HIGH-210 — Cloud device-config pushes are published on the commands topic as command "config", which the agent rejects (uncatalogued, two-person gate), while the cloud returns success

- **Önem:** HIGH · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** apps/sensor-service edge-device.service.ts device config push
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `apps/sensor-service/src/edge-device/edge-device.service.ts:1797-1806`, `sens-api-gateway/src/commands/mqtt_dispatch.rs:396-424`, `sens-api-gateway/src/commands/dispatch_lifecycle.rs:211-258`
- **Kanıt (ayrıntı):**
  - Spot-checked: apps/sensor-service/src/edge-device/edge-device.service.ts:1797-1806 publishes {commandId, command: 'config', config, timestamp} to tenants/{t}/devices/{id}/commands and returns true
  - Spot-checked: sens-api-gateway/src/commands/catalog.rs has no 'config' entry; commands/mqtt_dispatch.rs:396-424 applies config only when message.topic == topics.config
  - 'config' falls to permission_for_command -> SafeStateTrigger (catalog.rs:936) and is rejected as two_person_integrity_required (dispatch_lifecycle.rs:211-258)
- **Kök neden:** There is no shared command-name or topic contract between cloud producers and the edge COMMAND_CATALOG; the agent only applies config on topics.config, and the publisher treats a successful MQTT publish as a successful apply.
- **Mimari düzeltme yönü:** Make it detectable then automatic: generate the TypeScript command-name union and topic map from the Rust catalog (or a shared schema) so an unknown command cannot be published; implement config updates as a signed update_config command and settle success on the device ack, not on publish.
- **Not:** Incidental finding (merged from 1 raw report(s)); area=cloud.

<a id="SENSOR-HIGH-211"></a>

### SENSOR-HIGH-211 — GET /install/tenant is captured by the earlier @Get('install/:deviceCode') route, so the tenant self-registration installer always returns 400 "Invalid device code format"

- **Önem:** HIGH · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** apps/sensor-service ProvisioningController route order
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `apps/sensor-service/src/edge-device/provisioning.controller.ts:68`, `apps/sensor-service/src/edge-device/provisioning.controller.ts:76-79`, `apps/sensor-service/src/edge-device/installer-script.service.ts:275-288`, `web/modules/tenant-admin/src/components/devices/InstallerKeyModal.tsx:281`
- **Kanıt (ayrıntı):**
  - Spot-checked: apps/sensor-service/src/edge-device/provisioning.controller.ts:68 @Get('install/:deviceCode') is declared before :388 @Get('install/tenant') in the same @Controller() (Nest/Express register and match routes in declaration order)
  - provisioning.controller.ts:76-79 'tenant' fails /^[A-Z]{2,5}-[0-9A-F]{8}$/ and returns 400 'Invalid device code format'
  - installer-script.service.ts:275-288 hands tenants `curl ... /install/tenant | sudo bash`, shown in web/modules/tenant-admin/src/components/devices/InstallerKeyModal.tsx:281; no HTTP-level test covers the route (existing specs mock builders only)
  - Inferred from Nest/Express declaration-order matching; not executed
- **Kök neden:** A static route is declared after a parameterized sibling in the same controller (Nest/Express match in registration order), and no HTTP-level test covers route resolution.
- **Mimari düzeltme yönü:** Move the tenant installer to a distinct prefix (e.g. /install-tenant) or declare it before the parameterized route, and add a supertest e2e spec asserting each provisioning route reaches its handler.
- **Not:** Incidental finding (merged from 1 raw report(s)); area=cloud.

<a id="SENSOR-HIGH-212"></a>

### SENSOR-HIGH-212 — I/O tag config and HH/H/L/LL alarm thresholds vanish on every agent restart (write-only persistence, no boot reader), alarm updates are additive so stale alarms persist, and the cloud never re-pushes automatically

- **Önem:** HIGH · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway commands/io_config.rs + apps/sensor-service pushIoConfigToDevice
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/commands/io_config.rs:76-117`, `sens-api-gateway/src/alarms.rs:626`, `sens-api-gateway/src/commands/io_config.rs:118-120`, `apps/sensor-service/src/edge-device/edge-device.service.ts:1566-1575`, `apps/sensor-service/src/edge-device/edge-device.resolver.ts:394-402`
- **Kanıt (ayrıntı):**
  - Spot-checked: sens-api-gateway/src/commands/io_config.rs:76-117 set_configs then alarm_mgr.register() per threshold, with no unregister of previous definitions (alarms.rs:626 unregister exists but is unused here)
  - Spot-checked: io_config.rs:118-120 persist failure is only warn! and the command still returns success; :791-803 writes /etc/suderra/io_config.yaml; grep of src finds no reader of io_config.yaml
  - Spot-checked: apps/sensor-service/src/edge-device/edge-device.service.ts:1566-1575 pushIoConfigToDevice refuses offline devices and is called only from the GraphQL mutation edge-device.resolver.ts:394-402 (manual), not on reconnect; the doc at :1558-1565 claims 'full reconciliation'
  - Combined with claim T08, restarts happen about every 60 s
  - Write-only persistence into read-only /etc is also noted in claim T03
- **Kök neden:** Persistence was added as a write-only side effect with no boot-time source of truth, the alarm manager is only ever register()ed in this path (no replace semantics), and the cloud assumes the device retains config.
- **Mimari düzeltme yönü:** Make the I/O config versioned durable state in the data dir, loaded at boot before control starts, and fail the command if persisting fails; replace the alarm set atomically; report the config hash in status so the cloud auto-reconciles on mismatch or on every Online event.
- **Not:** Incidental finding (merged from 2 raw report(s)); area=agent.

<a id="SENSOR-HIGH-213"></a>

### SENSOR-HIGH-213 — The cloud stores SCADA package PINs as scrypt$salt$hash, but the edge verifies only $argon2id$ PHC strings or legacy hex SHA-256, so no PIN ever validates on the device and every attempt feeds the global lockout

- **Önem:** HIGH · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** apps/sensor-service pin-hash.util.ts / scada-package.service.ts vs sens-api-gateway scada_server.rs verify_pin
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `apps/sensor-service/src/process/services/pin-hash.util.ts:13-33`, `apps/sensor-service/src/process/services/scada-package.service.ts:327-336`, `libs/sensor-contracts/src/scada-package-doc/scada-package-doc.schema.ts:104`, `sens-api-gateway/src/scada_types.rs:193`, `sens-api-gateway/src/scada_server.rs:812-835`, `sens-api-gateway/src/scada_server.rs:1700-1716`
- **Kanıt (ayrıntı):**
  - Spot-checked: apps/sensor-service/src/process/services/pin-hash.util.ts:13-33 hashPin returns `scrypt$<salt-b64>$<hash-b64>`
  - Spot-checked: scada-package.service.ts:327-336 hashes the plaintext PIN with hashPin into controlPermissions.pinHash
  - libs/sensor-contracts/src/scada-package-doc/scada-package-doc.schema.ts:104 controlPermissions is {type:'object'} (opaque) and is shipped unchanged by deployScadaPackageToEdge (954-964)
  - Spot-checked: sens-api-gateway/src/scada_types.rs:193 pin_hash (serde camelCase pinHash); scada_server.rs:812-835 verify_pin accepts only '$argon2id$' or a hex SHA-256 compare, so the scrypt string never matches
  - scada_server.rs:1700-1716 each failure increments the global lockout; :2036-2075 EmergencyReset is denied
- **Kök neden:** The PIN hash is a cross-service secret format with no shared contract; controlPermissions travels as an untyped object, so the KDF mismatch is invisible at build and deploy time.
- **Mimari düzeltme yönü:** Define PinHash in libs/sensor-contracts as a typed PHC schema with a fixed algorithm set (argon2id), generate the Rust validator from it, reject unknown formats on cloud save and in cmd_deploy_scada_package, re-hash existing rows in a migration, and add a cross-language golden fixture (TS-produced hash verified by Rust verify_pin).
- **Not:** Incidental finding (merged from 1 raw report(s)); area=cloud.

<a id="SENSOR-HIGH-214"></a>

### SENSOR-HIGH-214 — The cloud has nothing that produces cert-pinning updates, signed firmware manifests, OS RAUC OTA triggers or the RBAC manifest

- **Önem:** HIGH · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sensor-service edge-device (release registry / OTA / pinning / RBAC)
- **Köken:** doğrulanan iddia T122 (CONFIRMED)
- **Kanıt (dosya:satır):** `apps/sensor-service/src/edge-device/edge-device.service.ts:2531`, `sens-api-gateway/src/commands/audit_emit.rs:56`, `apps/sensor-service/src/edge-device/entities/v2/firmware-release-v2.entity.ts:26-65`, `apps/sensor-service/src/edge-device/edge-device.module.ts:25`, `apps/sensor-service/src/edge-device/edge-device.service.ts:2538-2541`, `apps/sensor-service/src/edge-device/edge-device.module.ts:28`
- **Kanıt (ayrıntı):**
  - grep for apply_signed_manifest, update_cert_pinning, rotate_master_key and rbac_manifest across apps/, libs/ and web/ finds only an error string at edge-device.service.ts:2531,2540 pointing operators to an 'apply_signed_manifest rollout path' that does not exist
  - sens-api-gateway/src/commands/audit_emit.rs:56,94 - the agent implements update_cert_pinning and apply_signed_manifest handlers
  - apps/sensor-service/src/edge-device/entities/v2/firmware-release-v2.entity.ts:26-65 - the entity is only registered in TypeORM forFeature (edge-device.module.ts:25,47; app.module.ts:69,228). No service or resolver reads or writes it
  - No RAUC/rauc reference in any cloud app or lib; legacy update_firmware is disabled (edge-device.service.ts:2538-2541), so there is no fleet OTA path at all
  - EdgeProvisioningRecordV2 is registered (edge-device.module.ts:28,48) but never written
- **Kök neden:** Agent capabilities were built ahead of their cloud producers, with no cross-repo capability matrix or completeness gate, so dormant entities and error messages make the feature look present.
- **Mimari düzeltme yönü:** Build a cloud release-registry service: ingest a signed release, record it in EdgeFirmwareReleaseV2 per board and arch, then sign and dispatch per-device apply_signed_manifest (agent) and RAUC bundle manifests (OS) through the single command dispatcher with staged rollout and rollback floors. Add a pin-rotation producer that pins the CA or intermediate, not the Let's Encrypt leaf, and an RBAC manifest issuer. Add a capability-matrix contract: every agent command must have a registered cloud producer, or be flagged device-local, or CI fails.
- **Doğrulama:** Capability-matrix contract test diffing the agent command registry against cloud producers. E2E: register a release, roll it out to a QEMU device, see the device verify and apply it, then roll back. Pin rotation e2e across a simulated certificate renewal.
- **Not:** Release builds forbid mtls.mode=legacy. With Strict leaf pinning against nginx's 90-day Let's Encrypt certificate and no pin-update producer, devices would lose the broker at each renewal.

<a id="SENSOR-HIGH-215"></a>

### SENSOR-HIGH-215 — MQTT config-topic updates are applied unsigned, with no RBAC even in Enforcing mode, and can persistently disable all control logic

- **Önem:** HIGH · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway commands/config_dispatch.rs
- **Köken:** doğrulanan iddia T26 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/commands/mqtt_dispatch.rs:396-424`, `sens-api-gateway/src/commands/config_dispatch.rs:70-78`, `sens-api-gateway/src/main.rs:5087`, `apps/sensor-service/src/edge-device/mqtt-auth.service.ts:358-366`
- **Kanıt (ayrıntı):**
  - src/commands/mqtt_dispatch.rs:396-424 the config topic gets only a retained-flag check before `handle_config_update`. No signature_mode, envelope or RBAC gate
  - src/commands/config_dispatch.rs:70-78 `scripting.enabled` is set from the payload and saved (config.save) at :78
  - src/main.rs:5087 and :5120 the scripting/bytecode scan-cycle driver is spawned only if config.scripting.enabled, so after a restart all automation is off
  - Broker ACL: backend_service and sensor_service can write any tenants/<uuid>/devices/... topic (mqtt-auth.service.ts:358-366), and a device can write its own namespace
- **Kök neden:** The config topic predates the command-authentication model and was never folded into the command catalog. It is a second ingress with its own parser and no authority model.
- **Mimari düzeltme yönü:** Make it impossible: remove the separate config-topic ingress. Config changes become a cataloged, signed `update_config` command with a ManageConfig permission and the same envelope/RBAC/two-person pipeline as other commands (safety-relevant keys like scripting.enabled require two-person). Unsubscribe the config topic.
- **Doğrulama:** Integration: publish {"scripting":{"enabled":false}} to the config topic in Enforcing mode and assert no state change and no save. A signed update_config without the permission is denied. With the permission it is applied and audited.

<a id="SENSOR-HIGH-216"></a>

### SENSOR-HIGH-216 — One firmware key verifies every artifact class, every trust anchor lives in the editable config.yaml, and config integrity can be bypassed

- **Önem:** HIGH · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway trust anchors / config_integrity
- **Köken:** doğrulanan iddia T30 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/commands/deploy_bytecode_program.rs:67`, `sens-api-gateway/src/commands/deploy_st_source.rs:135`, `sens-api-gateway/src/commands/bundle_deploy.rs:325`, `sens-api-gateway/src/commands/system.rs:308`, `sens-api-gateway/src/commands/refresh_license.rs:99`, `sens-api-gateway/src/commands/apply_signed_manifest.rs:151`, `sens-api-gateway/src/main.rs:2263-2316`, `sens-api-gateway/src/main.rs:2266-2275`, `apps/sensor-service/src/edge-device/installer-script.service.ts:347-348`, `sens-api-gateway/src/config.rs:1726`, `sens-api-gateway/src/main.rs:3310-3312`, `sens-api-gateway/src/config_integrity/verify_runtime.rs:48`
- **Kanıt (ayrıntı):**
  - Single key: deploy_bytecode_program.rs:67, deploy_st_source.rs:135, bundle_deploy.rs:325, system.rs:308/442 (deploy_process/scada gate), refresh_license.rs:99 and apply_signed_manifest.rs:151 all use `state.firmware_signing_pubkey`, from main.rs:2263-2316 (firmware_update.signing_pubkey_hex)
  - It is loaded only when firmware_update.mode != Disabled (main.rs:2266-2275). The cloud installer config sets `firmware_update: mode: disabled` (installer-script.service.ts:347-348), which disables bundle, bytecode, ST and license verification entirely
  - Anchors in config.yaml: firmware_update.signing_pubkey_hex, rbac_manifest.manifest_signing_pubkey_hex (config.rs:1726), config_integrity.factory_pubkey_hex (config.rs ~2373), user_token_manifest pubkey
  - config_integrity default Disabled (config.rs ~2350). The verifying key is read from the same config being verified (main.rs:3310-3312), which is self-referential
  - verify_runtime.rs:48 sidecar path is hardcoded; :108-123 load_highest_seen_version returns 0 on a parse error or missing file (rollback floor reset)
  - main.rs:4367-4376 the SIGHUP reload runs AgentConfig::load()+validate() with no config-integrity verify and swaps the whole config live (including signature_mode)
- **Kök neden:** Key separation (ADR-018 R-4: firmware, RBAC, command) was specified but implemented by reusing one parsed key. Trust anchors were placed in the mutable operator config for staging convenience, and the anchor protecting that config lives inside it.
- **Mimari düzeltme yönü:** Make it impossible: compile per-purpose verifying keys into the binary or read them from a read-only, dm-verity/RAUC-protected location. Use a typed `VerifyingKey<Purpose>` (Firmware, Bundle, Bytecode, License, ScadaPkg, Config) so a key for one purpose cannot verify another. Keep the config-integrity key outside config.yaml. Persist rollback floors in TPM NV or a monotonic counter and treat a missing or corrupt floor as tamper (fail closed). SIGHUP reload must run the same integrity verification as boot or be removed.
- **Doğrulama:** Unit: a bundle signed with the firmware key fails verification under VerifyingKey<Bundle>. Corrupting the version file fails boot in Enforcing. A SIGHUP with a modified unsigned config.yaml is rejected. Invariant test: no `*_pubkey_hex` field in AgentConfig.

<a id="SENSOR-MEDIUM-217"></a>

### SENSOR-MEDIUM-217 — The SUDERRA_OS_EDGE_* variables the manifest needs are missing from every deployment, so the endpoint always returns 400

- **Önem:** MEDIUM · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** docker-compose.droplet.yml sensor-service env / InstallerScriptService
- **Köken:** doğrulanan iddia T116 (CONFIRMED)
- **Kanıt (dosya:satır):** `apps/sensor-service/src/edge-device/installer-script.service.ts:244-256`, `apps/sensor-service/src/edge-device/provisioning.controller.ts:169-174`, `docker-compose.droplet.yml:1029-1076`, `apps/sensor-service/src/edge-device/installer-script.service.ts:244-245`
- **Kanıt (ayrıntı):**
  - apps/sensor-service/src/edge-device/installer-script.service.ts:244-256 - throws when SUDERRA_OS_EDGE_ARTIFACT_URL, SUDERRA_OS_EDGE_ARTIFACT_SHA256 or SUDERRA_OS_EDGE_SIGNATURE_URL is empty
  - provisioning.controller.ts:169-174 - every exception is mapped to 400 and the raw message (env var names) is returned to the caller
  - docker-compose.droplet.yml:1029-1076 - the sensor-service environment has no SUDERRA_OS_EDGE_* keys. A grep over all docker-compose*.yml, infrastructure/ and .env.example finds none
  - installer-script.service.ts:244-245 - a single global artifact URL and sha256 are used for every device. There is no board or arch selection, so even when set, an x86 PC and a RevPi aarch64 would get the same artifact
- **Kök neden:** Artifact selection is modeled as per-process env config instead of release data, and config is only validated lazily when a request arrives, not at boot. The deploy SSoT has no list of required keys, so the gap ships silently.
- **Mimari düzeltme yönü:** Remove env-sourced artifact config. Resolve the artifact from the signed release registry by device board and arch (EdgeFirmwareReleaseV2 plus a board map). For the few true config keys, use a typed, schema-validated ConfigModule that refuses to boot in production when the Suderra OS provisioning feature lacks its signing key or registry. Add a deploy-SSoT invariant that every ConfigService key the provisioning path reads has a value in docker-compose.droplet.yml.
- **Doğrulama:** Boot test with the droplet env: the service must fail fast, or the registry must resolve an artifact per board. Unit test that two devices with different boards get different artifact URLs. The invariant spec parses the compose env against the config schema.
- **Durum notu (2026-10-20):** Advanced, not closed; the `Closes:` trailer of 6067b91a is withdrawn. Done: the artifact comes from the signed per-board release statement, the channel configuration is all-or-nothing (SUDERRA_EDGE_*), and every key is present in docker-compose.droplet.yml. Open: every value is empty there, so production refuses every request (now 404). The droplet-env boot test and the compose-against-config-schema invariant named above are not written yet.
- **Not:** Even with these vars set, the output would still be rejected by the OS verifier (T114). Adversarial re-check rated MEDIUM (verifier CRITICAL): Confirmed. The sensor-service environment in docker-compose.droplet.yml has no SUDERRA_OS_EDGE_* keys, no env_file, and no mounted .env. ConfigModule loads '.env'/.env.local relative to the container, and the image contains neither. No compose, infrastructure or .env.example file defines these keys. One correction: the 400 that names the env vars is reached only after the device lookup and token validation succeed, so callers without a valid token get 401 or 404 and the leak is minimal. Unauthenticated OS fetches get 401 first (T115). I rate it MEDIUM because T114 already blocks the flow and the T114 fix direction removes this env-sourced config entirely. Setting the vars alone would still yield a manifest the OS rejects.

<a id="SENSOR-MEDIUM-218"></a>

### SENSOR-MEDIUM-218 — Activation burns the single-use token before the device confirms it saved its credentials, and on Suderra OS the agent cannot save them

- **Önem:** MEDIUM · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sensor-service ProvisioningService.activateDevice + agent config persistence
- **Köken:** doğrulanan iddia T117 (PARTIAL)
- **Kanıt (dosya:satır):** `apps/sensor-service/src/edge-device/provisioning.service.ts:394-409`, `apps/sensor-service/src/edge-device/provisioning.service.ts:386-387`, `apps/sensor-service/src/edge-device/provisioning.service.ts:356-364`, `apps/sensor-service/src/edge-device/provisioning.service.ts:516-566`, `apps/sensor-service/src/edge-device/edge-device.resolver.ts:289`, `Suderra-OS/board/suderra/common/rootfs-overlay/usr/sbin/suderra-lockdown:52-63`, `sens-api-gateway/src/config.rs:143`, `Suderra-OS/board/suderra/common/rootfs-overlay/etc/systemd/system/suderra-agent.service:34-37`, `sens-api-gateway/src/main.rs:4664-4669`
- **Kanıt (ayrıntı):**
  - apps/sensor-service/src/edge-device/provisioning.service.ts:394-409 - tokenUsedAt is set and provisioningToken is set to null, and the transaction commits before any device acknowledgment
  - provisioning.service.ts:386-387,422-432 - a plaintext mqtt_password is generated and returned exactly once; only its hash is stored, so a lost response cannot be re-delivered
  - provisioning.service.ts:356-364 - a retry with the same token fails with TOKEN_ALREADY_USED
  - provisioning.service.ts:516-566 + edge-device.resolver.ts:289 - a cloud-side resetForReprovisioning does exist. It issues a new installer token, so the claim that the device is unrecoverable from the cloud side is overstated
  - Suderra-OS usr/sbin/suderra-lockdown:52-63 locks the provision user and SSH after install, so a locked appliance cannot receive the new token without physical reflashing
  - sens-api-gateway/src/config.rs:143,4239-4241 - save() always writes /etc/suderra/config.yaml. Suderra-OS rootfs-overlay/etc/systemd/system/suderra-agent.service:34-37 has ProtectSystem=strict with ReadWritePaths limited to /var/lib/suderra and /var/log/suderra, so /etc is read-only
  - Suderra-OS suderra-edge-install:286-287 - config.yaml is root:suderra 0640, which the suderra user cannot rewrite either
  - sens-api-gateway/src/main.rs:4664-4669 - the agent's own comment admits a save failure after activation leaves the device unrecoverable
- **Kök neden:** Credential delivery is a single non-idempotent exchange where the token is consumed when credentials are issued, with no confirm step. The cloud delivers a shared secret instead of the device proving possession of a key it generated, and the agent's writable state is not separated from root-owned config.
- **Mimari düzeltme yönü:** Make activation two-phase. Phase 1: the device presents the token plus a device-generated public key or CSR and gets back an identity (cert) in PENDING state. Phase 2: the token is consumed only after the device proves possession, through its first mTLS CONNECT or a signed /activate/confirm. Re-issuing to the same key within the window is idempotent. On the agent side, persist credentials to a dedicated writable state path under /var/lib/suderra, honoring SUDERRA_CONFIG, separate from the read-only signed config.
- **Doğrulama:** Integration test: activate, drop the response, retry with the same token and key, and expect success. Assert the token stays usable until confirm and is rejected after it. QEMU e2e: restart the agent after activation and confirm it reconnects with no reprovisioning.
- **Not:** There is a cloud reset path, but no channel that can deliver the new token to a locked-down Suderra OS device. Adversarial re-check rated MEDIUM (verifier HIGH): The cloud side is confirmed. tokenUsedAt is set and provisioningToken is nulled inside the transaction that also returns the one-time mqtt_password. Only the hash is stored, so a response lost after commit cannot be re-delivered, and a retry gets TOKEN_ALREADY_USED. Recovery exists, though: resetForReprovisioning is exposed through the resolver. The Suderra OS sub-claim is overstated. save() does write /etc/suderra/config.yaml, but AgentConfig::load() also reads that fixed path and ignores SUDERRA_CONFIG, which is honored only by --init. In addition, firstboot and edge-install make /var/lib/suderra root:root 0750, which uid 200 cannot traverse. On Suderra OS the agent therefore exits at config load before it ever activates, so the token is never burned there. The 'locked appliance cannot receive a new token' scenario also cannot come from this flow. suderra-lockdown check_ready requires /var/lib/suderra/edge/registered or registration.json, which nothing in either repo writes, so lockdown fails and edge-install rolls back without locking the device. What remains is a non-idempotent activation exchange with a cloud-side recovery path: MEDIUM.

<a id="SENSOR-MEDIUM-219"></a>

### SENSOR-MEDIUM-219 — The broker listens only on plain 1883 behind nginx TLS without client-cert checks, and sensor-ingestion expects mqtts://mosquitto:8883, which nothing serves

- **Önem:** MEDIUM · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** infrastructure mosquitto / nginx stream / sensor-ingestion
- **Köken:** doğrulanan iddia T119 (CONFIRMED)
- **Kanıt (dosya:satır):** `infrastructure/mosquitto/mosquitto-production.conf:13`, `infrastructure/nginx/droplet.conf:29-45`, `infrastructure/sensor-ingestion/config.toml:27-33`, `docker-compose.droplet.yml:1131-1170`, `apps/sensor-service/src/edge-device/mqtt-auth.service.ts:63`
- **Kanıt (ayrıntı):**
  - infrastructure/mosquitto/mosquitto-production.conf:13 - the only listener is 1883, with no TLS, cafile or require_certificate. :18 allow_anonymous false
  - infrastructure/nginx/droplet.conf:29-45 - stream listens on 8883 ssl with a Let's Encrypt cert and proxies plain traffic to mosquitto:1883. There is no ssl_verify_client or ssl_client_certificate, so devices authenticate by password only, and no proxy_protocol, so the broker sees every device as the nginx IP
  - infrastructure/sensor-ingestion/config.toml:27-33 - broker_url = "mqtts://mosquitto:8883" with a client cert. Nothing listens on 8883 inside the mosquitto container, and the config has no MQTT username/password while mosquitto refuses anonymous clients
  - docker-compose.droplet.yml:1131-1170 - sensor-ingestion is deployed with that config.toml mounted. :2114-2116 shows only nginx publishes 8883
  - apps/sensor-service/src/edge-device/mqtt-auth.service.ts:63,103-112 - the service-account list has no sensor-ingestion principal, so it could not authenticate over HTTP auth either
- **Kök neden:** Broker topology is spread across three independently edited files (nginx terminates TLS, mosquitto runs plaintext, ingestion assumes broker-native mTLS) with no deploy SSoT or invariant tying client URLs to real listeners. TLS termination at nginx was chosen for convenience, which rules out broker-side mTLS identity.
- **Mimari düzeltme yönü:** Let the broker own TLS and mTLS natively: a mosquitto 8883 listener with the platform CA, require_certificate true and use_identity_as_username, for both devices and internal services. nginx either does TCP passthrough with no termination or is removed from the MQTT path. Derive every MQTT client URL (sensor-service, sensor-ingestion, agents via activation) from one deploy SSoT, and add an invariant that parses compose plus the broker and nginx confs and asserts each client URL hits an existing listener with matching TLS and auth mode.
- **Doğrulama:** Deploy-SSoT invariant spec. Testcontainers integration that boots mosquitto from the production conf, connects sensor-ingestion with its config and cert, and checks that a device without a valid client cert is rejected at the TLS layer.
- **Not:** sensor-ingestion is pilot-gated (default_backend=node), so no live traffic is lost today, but the pilot cannot be turned on. Adversarial re-check rated MEDIUM (verifier HIGH): Confirmed. The mosquitto image copies mosquitto-production.conf, which has a single 'listener 1883' and EXPOSE 1883. Nothing listens on 8883 inside the container, and only nginx publishes 8883, terminating TLS with no ssl_verify_client and no proxy_protocol. The deployed infrastructure/sensor-ingestion/config.toml uses mqtts://mosquitto:8883 and sets no credentials while the broker has allow_anonymous false, so the sidecar cannot connect. I lower the severity: sensor-ingestion is pilot-gated (default_backend=node, zero tenants routed), so no live data is lost unless an operator flips a tenant to rust. Password authentication over nginx-terminated TLS with a valid certificate is a standard, if weaker, posture, the plaintext 1883 listener is reachable only on the aqua-internal Docker network, and the missing mTLS overlaps with T126.

<a id="SENSOR-MEDIUM-220"></a>

### SENSOR-MEDIUM-220 — MQTT settings default to plain 1883 and derive TLS from the port number; production overrides this, but staging and the admin-API path do not

- **Önem:** MEDIUM · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sensor-service InstallerScriptService provisioning config
- **Köken:** doğrulanan iddia T120 (PARTIAL)
- **Kanıt (dosya:satır):** `apps/sensor-service/src/edge-device/installer-script.service.ts:66-67`, `docker-compose.droplet.yml:1069-1070`, `docker-compose.staging.yml:176`, `apps/admin-api-service/src/system-management/services/global-settings.service.ts:873-875`, `apps/sensor-service/src/edge-device/installer-script.service.ts:108-117`, `apps/sensor-service/src/edge-device/provisioning.service.ts:430`, `Suderra-OS/board/suderra/common/rootfs-overlay/etc/nftables.conf:55-59`
- **Kanıt (ayrıntı):**
  - apps/sensor-service/src/edge-device/installer-script.service.ts:66-67 - MQTT_PORT defaults to 1883 and MQTT_TLS_ENABLED is computed as port === 8883
  - docker-compose.droplet.yml:1069-1070 - production sets MQTT_BROKER_HOST app.suderra.com and MQTT_BROKER_PORT 8883, so the droplet path is TLS/8883 today
  - docker-compose.staging.yml:176 area - staging sensor-service does not set MQTT_BROKER_PORT, so it falls back to 1883 without TLS
  - apps/admin-api-service/src/system-management/services/global-settings.service.ts:873-875 - the remote provisioning-config defaults to broker 'localhost' port 1883. installer-script.service.ts:108-117 lets those values override env through `??`, while mqttTlsEnabled comes from env (it is not returned by admin)
  - provisioning.service.ts:430,786 - the activation and self-register responses compute mqtt_tls_enabled as config.mqttPort === 8883, ignoring config.mqttTlsEnabled that the installer uses (:276)
  - Suderra-OS rootfs-overlay/etc/nftables.conf:55-59 - egress allows only 443 and 8883, so a 1883 broker is unreachable from Suderra OS
  - The Suderra OS path never renders this installer script; the port reaches the device only through the activation response
- **Kök neden:** Defaults fail open, the TLS decision is inferred from a port number, and the broker endpoint has three sources of truth (env, admin-api remote config, hardcoded fallback) with inconsistent precedence.
- **Mimari düzeltme yönü:** Replace host, port and tls with one typed broker endpoint (an mqtts:// URL; the scheme decides TLS). It must be required and schema-validated at boot, with no insecure default, and plaintext must be rejected when NODE_ENV=production. Keep one source with explicit precedence, and have activation and installer read the same resolved value.
- **Doğrulama:** Unit test: constructing the service in production with no broker URL, or with mqtt://, throws. Contract test: the activation response is always TLS on a port that the OS nftables egress allowlist permits (a cross-repo fixture parses nftables.conf).
- **Not:** The code default is as claimed. The production droplet overrides it today, so impact is latent: staging, plus any deployment where the admin-api config becomes reachable.

<a id="SENSOR-MEDIUM-221"></a>

### SENSOR-MEDIUM-221 — The MQTT ACL denies the agent's watch and graceful-shutdown status topics, and the cloud never subscribes to task_stats or watch

- **Önem:** MEDIUM · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sensor-service MqttAuthService ACL + MqttListener filters vs agent topics
- **Köken:** doğrulanan iddia T121 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/main.rs:4903`, `apps/sensor-service/src/edge-device/mqtt-auth.service.ts:296-316`, `sens-api-gateway/src/main.rs:6066-6067`, `apps/sensor-service/src/edge-device/mqtt-auth.service.ts:349`, `sens-api-gateway/src/config.rs:3143-3144`, `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:79-95`, `apps/sensor-service/src/edge-device/mqtt-auth.service.ts:390-395`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/main.rs:4903 - watch topic is tenants/{tenant}/devices/{device_code}/watch, keyed by device_code
  - apps/sensor-service/src/edge-device/mqtt-auth.service.ts:296-316 - the device segment must equal the username (mqttClientId) or device.id (UUID), so a device_code segment is denied
  - sens-api-gateway/src/main.rs:6066-6067 - the graceful-shutdown offline status goes to suderra/{device_id}/status. mqtt-auth.service.ts:349 - anything not tenants/ or edge/ is denied
  - sens-api-gateway/src/config.rs:3143-3144 - task_stats is published to tenants/{t}/devices/{id}/task_stats (ACL allows the publish)
  - apps/sensor-service/src/ingestion/mqtt-listener.service.ts:79-95 - SENSOR_SERVICE_SUBSCRIPTION_FILTERS lacks task_stats and watch. mqtt-auth.service.ts:390-395 - the sensor_service subscribe allow-list lacks them too, so data is dropped silently
- **Kök neden:** The topic namespace is defined separately in agent string templates, the cloud ACL regex, and the listener filter list, with no shared topic contract or cross-repo test, and the identifier used in each segment is inconsistent (device_code, device_id, a non-tenant prefix).
- **Mimari düzeltme yönü:** Publish one topic contract (suffix list plus identifier = device UUID, all under tenants/{tenantId}/devices/{deviceId}/) as generated constants used by the agent topic resolver, the cloud ACL and the listener filters. Move the shutdown status onto the LWT and status topic; make watch use device_id. Add a contract test that every agent-published suffix is both ACL-permitted and subscribed, or explicitly marked device-local.
- **Doğrulama:** Cross-repo fixture test enumerating the agent's ResolvedTopics and watch/shutdown topics through MqttAuthService.checkTopicAccess (expect allow) and through SENSOR_SERVICE_SUBSCRIPTION_FILTERS matching. The mosquitto ACL spec (mqtt-acl.mosquitto.spec.ts) is extended with these topics.
- **Not:** On a clean DISCONNECT the LWT is not sent, so with the explicit shutdown status denied, the cloud only learns the device is offline after the heartbeat times out.

<a id="SENSOR-MEDIUM-222"></a>

### SENSOR-MEDIUM-222 — The Suderra OS SSH install command builder is never called and has no UI, and its route shape contradicts the OS runbook

- **Önem:** MEDIUM · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sensor-service InstallerScriptService Suderra OS builders / web UI
- **Köken:** doğrulanan iddia T125 (CONFIRMED)
- **Kanıt (dosya:satır):** `apps/sensor-service/src/edge-device/installer-script.service.ts:223-237`, `apps/sensor-service/src/edge-device/__tests__/installer-token-header.spec.ts:57-59`, `web/modules/sensor-module/src/components/fleet/InstallerCommandModal.tsx:166-167`, `web/modules/tenant-admin/src/components/devices/InstallerKeyModal.tsx:281`, `Suderra-OS/docs/operations/edge-agent-update.md:56`, `apps/sensor-service/src/edge-device/provisioning.controller.ts:145-149`
- **Kanıt (ayrıntı):**
  - apps/sensor-service/src/edge-device/installer-script.service.ts:223-237 - buildSuderraOsInstallerUrl and buildSuderraOsInstallerCommand are referenced only by their own definitions and by __tests__/installer-token-header.spec.ts:57-59. No resolver field or service calls them
  - web/ has no reference to suderra-os or install-manifest-url. The UI shows only the curl|bash installerCommand (web/modules/sensor-module/src/components/fleet/InstallerCommandModal.tsx:166-167; web/modules/tenant-admin/src/components/devices/InstallerKeyModal.tsx:281)
  - Suderra-OS docs/operations/edge-agent-update.md:56 documents `install-manifest-url https://tenant.example/install/suderra-os/<token>.json` (token in path), while the cloud route is GET install/:deviceCode/suderra-os with a header token (provisioning.controller.ts:145-149)
  - The cloud has no SSH client (no ssh2/node-ssh) and no way to receive the one-time provision password that firstboot prints only to /dev/console (suderra-firstboot.service:70-79), so the 'tenant panel runs the forced command' flow has no implementation
- **Kök neden:** The OS-appliance provisioning flow was designed in OS docs and partly scaffolded in the cloud, with no end-to-end owner. The builders are dead code that make the feature look done, and the route and token transport drifted between repos with no contract.
- **Mimari düzeltme yönü:** Choose one flow and make it the only one: the operator runs a CLI or panel action that pushes the signed manifest (install-manifest-json over the provision channel), or a device-initiated claim. Expose it through a resolver and UI, delete the unused builders, and fix the route grammar and token transport in the shared contract (see T115). Add an invariant that every exported provisioning builder has a production caller.
- **Doğrulama:** Dead-code invariant (ts-prune or a custom spec) on edge-device provisioning builders. UI e2e: create a Suderra OS device and see the push or claim instructions. Cross-repo fixture asserting the cloud route matches the OS runbook or contract.
- **Not:** Even when wired up, the current builder carries the token in argv, which the OS drops (T115). Adversarial re-check rated MEDIUM (verifier HIGH): Confirmed. buildSuderraOsInstallerUrl and buildSuderraOsInstallerCommand have no production callers, only the installer-token-header spec. web/ has no Suderra OS or install-manifest-url UI, and sensor-service has no SSH client dependency. The route and token transport also contradict the OS runbook. I lower the severity: dead helper code does no harm on its own. An operator could still run the ssh forced command by hand using the console-printed password, so the missing UI is not the blocking defect. The flow is already broken by T114 and T115, which makes this a duplicate symptom of the same missing end-to-end contract.

<a id="SENSOR-MEDIUM-223"></a>

### SENSOR-MEDIUM-223 — Legacy tarball OTA takes its repo from command params, verifies only a same-origin sha256, requests asset names the release workflow never publishes, and installs to a non-ExecStart read-only path

- **Önem:** MEDIUM · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway commands/firmware.rs (legacy update_firmware)
- **Köken:** doğrulanan iddia T13 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/commands/firmware.rs:178-195`, `sens-api-gateway/src/commands/firmware.rs:308-314`, `.github/workflows/edge-agent-release.yml:22`, `sens-api-gateway/src/commands/firmware.rs:410`, `sens-api-gateway/src/commands/firmware.rs:378-379`, `sens-api-gateway/src/commands/firmware.rs:388`, `sens-api-gateway/src/commands/firmware.rs:92-101`, `sens-api-gateway/src/config.rs:2013-2017`, `apps/sensor-service/src/edge-device/edge-device.service.ts:2533-2542`, `apps/sensor-service/src/edge-device/installer-script.service.ts:1133`, `sens-api-gateway/src/commands/apply_signed_manifest.rs:36-50`
- **Kanıt (ayrıntı):**
  - aquaculture_platform/sens-api-gateway/src/commands/firmware.rs:178-195 repo from params, default 'suderra/edge-agent'; only the format is validated (attacker-chosen repos allowed)
  - firmware.rs:308-314 asset 'suderra-agent-{arch}-unknown-linux-gnu.tar.gz' plus '.sha256' from the same base_url; :342-372 sha compare with no signature check
  - Release: .github/workflows/edge-agent-release.yml:22 ARCHIVE_BINARY_NAME=edge-agent, :155-163 slugs x86_64-linux/aarch64-linux/armv7-linux, :281-287 '${BINARY_NAME}-${RELEASE_VERSION}-${TARGET_SLUG}.tar.gz'. Asset name differs (no version, triple instead of slug) and the archive member edge-agent != firmware.rs:410 'suderra-agent'
  - firmware.rs:378-379,436 writes /opt/suderra/edge-agent(.bak/.new). ExecStart is /opt/suderra/edge/current/suderra-agent (Suderra-OS unit:13) and /usr/local/bin/suderra-agent (agent repo unit:37); /opt is read-only under ProtectSystem=strict
  - firmware.rs:388 tar, :424 chmod, :473 systemctl exec
  - Reachable only when firmware_update.mode=Permissive (firmware.rs:92-101). The config.rs:2013-2017 doc for Disabled says 'legacy tarball OTA remains the sole update path', which contradicts the gate. Cloud blocks it unless EDGE_LEGACY_OTA_ALLOWED (apps/sensor-service/src/edge-device/edge-device.service.ts:2533-2542)
- **Kök neden:** The legacy path was left in place after the signed path was introduced. Its contract with the release workflow drifted, and it never had authenticity checks.
- **Mimari düzeltme yönü:** Delete cmd_update_firmware and its catalog and permission entries at compile time, so the signed release path is the only update path. If any agent-initiated update remains, it must only forward a signed intent to the root-owned OS installer.
- **Doğrulama:** Invariant test: the command catalog has no 'update_firmware'. The enterprise gate asserts the handler is absent.

<a id="SENSOR-MEDIUM-224"></a>

### SENSOR-MEDIUM-224 — Release tarball contains `edge-agent`, but the Suderra OS installer, the cloud's Suderra OS manifest and the agent's own OTA look for `suderra-agent`

- **Önem:** MEDIUM · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** edge-agent-release.yml packaging vs Suderra OS installer / cloud manifests / agent OTA
- **Köken:** doğrulanan iddia T63 (CONFIRMED)
- **Kanıt (dosya:satır):** `.github/workflows/edge-agent-release.yml:21-22`, `Suderra-OS/board/suderra/common/rootfs-overlay/etc/suderra/edge-install.env:15-16`, `Suderra-OS/board/suderra/common/rootfs-overlay/usr/sbin/suderra-edge-install:16-17`, `Suderra-OS/userspace/suderra-installer/src/contracts.rs:1115`, `apps/sensor-service/src/edge-device/installer-script.service.ts:263-264`, `apps/sensor-service/src/edge-device/installer-script.service.ts:526`, `sens-api-gateway/src/commands/firmware.rs:308`, `sens-api-gateway/systemd/suderra-agent.service:37`, `Suderra-OS/package/suderra-edge-agent/suderra-agent.service:14`
- **Kanıt (ayrıntı):**
  - /home/user/aquaculture_platform/.github/workflows/edge-agent-release.yml:21-22 set BINARY_NAME=suderra-agent and ARCHIVE_BINARY_NAME=edge-agent. Lines 282-286 put only `edge-agent` in the tarball. The release notes (:518-520) say `sudo mv edge-agent /usr/local/bin/suderra-agent`.
  - Suderra OS: board/suderra/common/rootfs-overlay/etc/suderra/edge-install.env:15-16 (FORMAT tar.gz, BIN_NAME suderra-agent). usr/sbin/suderra-edge-install:16-17 sets the same defaults, and :245-261 runs `find -name ${BIN_NAME}`, which ends in 'suderra-agent not found in artifact' for the official tarball. userspace/suderra-installer/src/contracts.rs:1115 fixture uses binary_name suderra-agent.
  - Cloud Suderra OS manifest: apps/sensor-service/src/edge-device/installer-script.service.ts:263-264 default binary_name 'suderra-agent' and format 'tar.gz' (overridable through SUDERRA_OS_EDGE_BINARY_NAME).
  - Nuance: the cloud's generic-Linux installer does expect edge-agent (installer-script.service.ts:526,618,660,1062,1085,1133 -> /opt/suderra/edge-agent).
  - Agent legacy OTA: sens-api-gateway/src/commands/firmware.rs:308 expects asset `suderra-agent-{arch}-unknown-linux-gnu.tar.gz` (never published), :409 expects `suderra-agent` inside, and :365 installs to /opt/suderra/edge-agent.
  - Install layouts disagree as well: agent unit sens-api-gateway/systemd/suderra-agent.service:37 uses /usr/local/bin/suderra-agent; the Suderra OS unit package/suderra-edge-agent/suderra-agent.service:14 uses /opt/suderra/edge/current/suderra-agent.
- **Kök neden:** There is no single artifact contract. Four consumers each hardcode archive name, inner binary name and install path. The ARCHIVE_BINARY_NAME rename was kept for the legacy generic installer and never reconciled with Suderra OS.
- **Mimari düzeltme yönü:** Define one versioned edge-artifact contract: archive name pattern, inner binary name (= the cargo bin name suderra-agent) and layout. Store it as a shared schema with generated constants for the TypeScript cloud, the Rust agent and the OS installer. Have the release emit a manifest from it, and make every installer read the manifest instead of defaults. Remove ARCHIVE_BINARY_NAME, migrate the generic installer, and delete the legacy firmware.rs tarball path.
- **Doğrulama:** Add a release post-build contract job that extracts each tarball and runs the Suderra OS install verification (suderra-installer plus the BIN_NAME lookup) against it. Cross-repo golden fixtures: the cloud manifest renderer's output must pass the OS verifier; the agent OTA asset-name function must match the release naming.
- **Not:** Adversarial re-check rated MEDIUM (verifier HIGH): PARTIAL. The tarball does contain only `edge-agent`, and the consumers do disagree on the artifact contract and install layout. Two pieces of counter-evidence lower the impact. (1) The Suderra OS installer does not hardcode the inner name. BIN_NAME comes from the signed manifest's artifact.binary_name, a free non-empty string (contracts.rs:124,309,454-456 → plan env → suderra-edge-install:187,248). A correct manifest saying binary_name=edge-agent would install fine, renaming it to suderra-agent at :265-267. The defaults in edge-install.env and the script only matter for a manifest that says suderra-agent, such as the cloud default (installer-script.service.ts:263). (2) The agent's legacy tarball OTA is rejected unless firmware_update.mode is explicitly Permissive (firmware.rs:92-97). The cloud-generated config sets `firmware_update: mode: disabled` (installer-script.service.ts:349-350,447-448), so the firmware.rs:308/365/409 mismatch is a dormant path. The failure is loud ('suderra-agent not found in artifact'), not silent. It is also moot today because no Ed25519-signed edge-provisioning manifest is ever produced (T64), and the cloud's OS manifest does not even match the OS schema (incidental). What remains is a real contract-drift problem. Four places hardcode archive base, inner name and install path: /usr/local/bin/suderra-agent, /opt/suderra/edge/current/suderra-agent, /opt/suderra/edge-agent, and the release notes. Beyond the claim, the agent ignores SUDERRA_CONFIG, so even a correctly installed agent on Suderra OS cannot find its config (incidental CRITICAL). Root cause: there is no versioned artifact/layout contract. ARCHIVE_BINARY_NAME was kept for the legacy generic installer, and each consumer copied names by hand. FIX: define one artifact contract, a JSON Schema plus golden fixture in a shared location consumed by both repos. It should state the archive name pattern, inner binary name (suderra-agent), target slugs and digest. The release workflow should generate the tarball and manifest from it, the cloud manifest builder should take binary_name and format from the release manifest rather than env defaults, and the OS contract test should consume the same fixture. Remove the legacy firmware.rs tarball path or rebase it on the signed manifest. TEST: a release-workflow job that extracts the produced tarball and runs the OS installer's extraction and contract check against the fixture manifest. A cloud unit test asserts the manifest binary_name equals the name inside the release archive.

<a id="SENSOR-MEDIUM-225"></a>

### SENSOR-MEDIUM-225 — The installer's remote provisioning-config fetch sends an INTERNAL_SERVICE_TOKEN nothing else issues to a PlatformAdminGuard endpoint at an unset ADMIN_API_URL, so it always fails silently into fallback; if it succeeded, its localhost:1883/"latest" defaults would override production env

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sensor-service InstallerScriptService.getProvisioningConfig / admin-api provisioning-config
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `apps/sensor-service/src/edge-device/installer-script.service.ts:86-97`, `apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts:292-297`, `apps/admin-api-service/src/system-management/services/global-settings.service.ts:871-883`, `apps/sensor-service/src/edge-device/installer-script.service.ts:108-117`
- **Kanıt (ayrıntı):**
  - installer-script.service.ts:86-97 calls ${ADMIN_API_URL:-http://localhost:3010}/system/settings/provisioning-config with INTERNAL_SERVICE_TOKEN; that token is referenced nowhere else in apps/ or libs/ (confirmed by grep)
  - apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts:292-297 the endpoint is behind PlatformAdminGuard; ADMIN_API_URL is not set in docker-compose.droplet.yml
  - global-settings.service.ts:871-883 defaults are http://localhost:3000, broker localhost:1883 and version 'latest'; installer-script.service.ts:108-117 lets them override env because `??` only falls back on undefined
  - Default-override half overlaps claim T120 evidence
- **Kök neden:** Remote config was added without an authentication contract or precedence rules, and failures silently fall back.
- **Mimari düzeltme yönü:** Delete the remote fetch or replace it with an authenticated, schema-validated source with explicit precedence and no insecure defaults, plus a test that fails on fallback.
- **Not:** Incidental finding (merged from 1 raw report(s)); area=cloud.

<a id="SENSOR-MEDIUM-226"></a>

### SENSOR-MEDIUM-226 — No consumer verifies the cosign release signatures: the cloud's generic Linux installer checks only a sha256 file from the same release

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** edge release consumers (cloud generic installer)
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `apps/sensor-service/src/edge-device/installer-script.service.ts:618-634`
- **Kanıt (ayrıntı):**
  - apps/sensor-service/src/edge-device/installer-script.service.ts:618-634 and :1074 the generic installer verifies only `sha256sum -c` against a checksum file from the same release; there is no cosign reference in the file (confirmed)
  - No other consumer runs cosign verify-blob; the Suderra OS verifier accepts only Ed25519 (claim T64)
- **Kök neden:** Signing was added as release decoration without a verifier on the consuming side.
- **Mimari düzeltme yönü:** Make every consumer verify the signature (cosign verify-blob with pinned identity in the generic installer; Ed25519 on Suderra OS per T64) and refuse artifacts whose signature does not verify.
- **Not:** Incidental finding (merged from 1 raw report(s)); area=release-ci.

<a id="SENSOR-MEDIUM-227"></a>

### SENSOR-MEDIUM-227 — Self-register power-loss recovery re-issues a device's MQTT password to anyone holding the shared tenant token and the device's raw machine-id, and on Suderra OS prod (transient machine-id) it never matches, creating duplicate devices

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** apps/sensor-service ProvisioningService.selfRegisterDevice recovery branch
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `apps/sensor-service/src/edge-device/provisioning.service.ts:648-693`, `sens-api-gateway/src/provisioning.rs:557-572`, `apps/sensor-service/src/edge-device/installer-script.service.ts:427-430`
- **Kanıt (ayrıntı):**
  - apps/sensor-service/src/edge-device/provisioning.service.ts:648-693 if a device with the same fingerprint.machineId exists, has never been seen and is under 1 h old, a new MQTT password is generated, stored and returned
  - sens-api-gateway/src/provisioning.rs:557-572 sends the raw, world-readable /etc/machine-id (only MACs are hashed) and calls machine_uid::get() directly, bypassing the crate::machine_id::read SSoT
  - The tenant token is shared by every device and embedded in curl|bash scripts (installer-script.service.ts:427-430)
  - On Suderra OS prod machine-id is transient per boot (claim T05), so the recovery lookup never matches and each retry creates a duplicate device
- **Kök neden:** Recovery is authorised by a non-secret, non-stable OS identifier instead of proof of possession of a device-held key.
- **Mimari düzeltme yönü:** Enrol a device keypair (TPM-resident where available) and prove recovery/activation with a signature over a server nonce; never transmit the raw machine-id.
- **Not:** Incidental finding (merged from 2 raw report(s)); area=cloud.

<a id="SENSOR-MEDIUM-228"></a>

### SENSOR-MEDIUM-228 — Uncataloged commands resolve to the SafeStateTrigger permission; write_opcua and write_s7 are cataloged but have no dispatch arm

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway commands/catalog.rs + dispatch_lifecycle.rs
- **Köken:** doğrulanan iddia T28 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/commands/catalog.rs:933-937`, `sens-api-gateway/src/commands/dispatch_lifecycle.rs:264-387`, `sens-api-gateway/src/commands/write.rs:221`, `sens-api-gateway/src/commands/ide_deploy.rs:408`, `apps/sensor-service/src/edge-device/edge-device.service.ts:1799-1803`, `sens-api-gateway/src/commands/dispatch_lifecycle.rs:211-258`, `sens-api-gateway/src/command_envelope/mutating.rs:36`
- **Kanıt (ayrıntı):**
  - src/commands/catalog.rs:933-937 `permission_for_command ... .unwrap_or(Some(Permission::SafeStateTrigger))`, :942 is_mutating unwrap_or(true), :948 legacy policy default
  - catalog.rs:398-414 entries for write_opcua/write_s7 with handler_name cmd_write_opcua/cmd_write_s7. dispatch_lifecycle.rs:264-387 has no such arms, so they fall to 'Unknown command' (:373-385). The stub handlers exist at write.rs:221/246 and are reachable only from ide_deploy.rs:408
  - Effect: an unknown command (e.g. the cloud's `command: 'config'`, edge-device.service.ts:1799-1803) is rejected as 'two_person_integrity_required' (dispatch_lifecycle.rs:211-258), not as unknown, which misleads operators
  - There is no test tying catalog handler_name to the dispatch match (grep handler_name_for_command shows no consumer outside catalog.rs). `safe_state_trigger` is in command_envelope/mutating.rs:36 but has no catalog entry and no handler
- **Kök neden:** The catalog (metadata) and the dispatch match (behaviour) are two independent hand-maintained lists. The default for 'not in catalog' was chosen for RBAC strictness rather than rejecting unknown commands up front.
- **Mimari düzeltme yönü:** Make it impossible: generate the dispatch from the catalog (each entry holds a handler fn pointer or enum variant, and the match is derived), so an entry without a handler or a handler without an entry fails to compile. Reject unknown wire names at parse time with an explicit UnknownCommand before any permission resolution. Remove the dead MUTATING_COMMANDS list.
- **Doğrulama:** Compile-time: a const assert or build.rs check that every COMMAND_CATALOG handler_name maps to a dispatch arm. Unit: an unknown command yields an UnknownCommand rejection (not two_person_integrity_required). write_opcua with a co-approved envelope reaches the stub or is removed from the catalog.

<a id="SENSOR-MEDIUM-229"></a>

### SENSOR-MEDIUM-229 — SCADA process/package deploys accept unsigned artifacts; script, program, CODESYS and PLC uploads have no artifact signature

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway commands/system.rs, script.rs, program/deploy.rs, plc/upload.rs, ide_deploy.rs
- **Köken:** doğrulanan iddia T31 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/commands/system.rs:62-75`, `sens-api-gateway/src/commands/system.rs:322-328`, `sens-api-gateway/src/commands/script.rs:126-164`, `sens-api-gateway/src/authz/permission.rs:583-596`, `apps/sensor-service/src/process/services/scada-package.service.ts:1040`, `apps/sensor-service/src/process/services/process.service.ts:468`, `apps/sensor-service/src/automation/automation.service.ts:1343-1388`, `sens-api-gateway/src/scripting/deploy_sig.rs:220-230`
- **Kanıt (ayrıntı):**
  - src/commands/system.rs:62-75 DeploySigGate::Unsigned is documented as accepted. :198-216 gate_deploy_signature returns Ok(Unsigned) when no signature is present
  - system.rs:322-328 (deploy_process) and :466-471 (deploy_scada_package) warn 'accepted UNSIGNED' and proceed to deploy
  - script.rs:126-164 cmd_deploy_script deserializes and stores ScriptDefinition with no signature. program/deploy.rs and plc/upload.rs contain no signature/verify references. ide_deploy.rs (deploy_to_codesys) has none
  - Mitigation: DeployProgram is in requires_two_person_integrity (authz/permission.rs:583-596), so these commands execute only with a co-approved signed envelope whose canonical params cover the content. In practice the cloud sends legacy unsigned messages (scada-package.service.ts:1040, process.service.ts:468, automation.service.ts:1343-1388), so they are rejected outright (see incidental)
  - Even the 'Verified' path does not bind content: verify_deploy_signature (deploy_sig.rs:220-230) signs only (tenant, claimed artifactSha256), and system.rs never hashes the deployed process or package (see incidental)
- **Kök neden:** Artifact provenance was added incrementally per artifact type (bundle got a manifest; SCADA got an optional signature; scripts and programs got nothing). Enforcement was deferred to a future bundle phase instead of being a property of the deploy pipeline.
- **Mimari düzeltme yönü:** Make it impossible: all executable or visual artifacts are deployed only through the signed-bundle path (manifest signature, tenant binding, per-artifact sha256 recomputed over the exact bytes applied). Remove the individual deploy_* commands, or make each one construct an internal single-artifact bundle that requires a signature. The type the handlers apply is `VerifiedArtifact`, constructible only after hash and signature checks.
- **Doğrulama:** Integration: deploy_scada_package without signature is rejected. With a valid signature but tampered content (same artifactSha256) it is rejected. deploy_script/deploy_program without a bundle signature are rejected even with a co-approved envelope. A contract test with the cloud bundle signer fixtures passes.
- **Not:** Adversarial re-check rated MEDIUM (verifier HIGH): CONFIRMED as stated, but the impact is lower than HIGH. gate_deploy_signature returns Ok(Unsigned) without a signature, and deploy_process/deploy_scada_package proceed with a warn. Script, program, PLC and CODESYS deploys contain no artifact signature or verify code. The Verified path binds only (tenant, claimed artifactSha256), and system.rs never hashes the deployed body. A historical valid (sha, sig) pair can therefore be attached to arbitrary content forever, since there is no nonce or expiry. Why lower: every one of these commands maps to DeployProgram, which requires two-person integrity. A deploy reaches the handler only in an envelope whose cmd_hash covers the canonical params (the content) and carries at least one verified operator signature. Content is always bound by an operator key, though only one key is needed in Permissive (see T24). What is missing is release/build provenance independent of operator keys, and the 'Verified' label overstates what is checked. Root cause: artifact provenance was added per artifact type, and enforcement was deferred. Fix: one deploy pipeline. Every artifact class is a typed SignedArtifact<T>, constructed only by a verifier that hashes the received bytes itself and compares them with the signed digest. The signed body includes kind, tenant, device scope, version and expiry. Unsigned artifacts are unrepresentable at the handler boundary. Test: send a deploy_process whose body differs from the signed artifactSha256 and assert it is rejected. Assert an unsigned deploy_script is rejected at type level (no handler accepts unverified bytes). Replay an old (sha, sig) with new content and assert it is rejected.

<a id="SENSOR-MEDIUM-230"></a>

### SENSOR-MEDIUM-230 — Seven security/ADR-phase features are no-ops, and signed-deploy falsely claims to enforce signatures

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway Cargo.toml [features]
- **Köken:** doğrulanan iddia T60 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/keystore/mod.rs:62`, `sens-api-gateway/src/keystore/tpm_backed.rs:40`, `Cargo.toml:343`, `Cargo.toml:474-479`, `sens-api-gateway/src/command_envelope/envelope.rs:59-76`, `apps/sensor-service/src/edge-device/installer-script.service.ts:330-355`, `Cargo.toml:488`, `.github/workflows/sens-api-gateway-ci.yml:44`, `Cargo.toml:434`, `sens-api-gateway/src/security.rs:219`
- **Kanıt (ayrıntı):**
  - I grepped `feature = "<name>"` across sens-api-gateway/src, tests and build.rs: signed-deploy 0, st-bytecode 0, multi-task-scheduler 0, live-debug 0, license-enforce 0, metrics 0, kani 0. tpm has 3 hits and all are comments (src/keystore/mod.rs:62, src/keystore/tpm_backed.rs:40,370).
  - The optional deps are never referenced in src: tss_esapi (Cargo.toml:343), jsonwebtoken (:301), metrics / metrics-exporter-prometheus (:400-401). They are compiled whenever the CI feature set is used.
  - Cargo.toml:474-479 (signed-deploy): 'strict rejection mode only active with this flag'. False. Enforcement is the runtime config signature_mode, whose default is Disabled, documented as 'Any envelope accepted' (src/command_envelope/envelope.rs:59-76). Neither the cloud-generated config (apps/sensor-service/src/edge-device/installer-script.service.ts:330-355) nor the Suderra OS package config (/home/user/Suderra-OS/package/suderra-edge-agent/config.yaml) sets signature_mode.
  - Cargo.toml:488 (st-bytecode) says it 'Compiles src/st_compiler.rs + src/st_vm.rs'. Neither file exists. The VM (src/scripting/bytecode_vm.rs) and task_scheduler.rs compile unconditionally.
  - sens-api-gateway-ci.yml:44 lists these features in the CI set, which gives a false impression of coverage.
  - Doc contradiction: Cargo.toml:434 calls strict-security 'currently unused', but it is used at src/security.rs:219,231.
- **Kök neden:** The features were declared as ADR-phase placeholders. The implementations then landed either ungated or runtime-gated, the placeholder features were never removed, and nothing checks that a feature is actually used.
- **Mimari düzeltme yönü:** Delete the no-op features and the unused optional deps, or wire them for real. Use compile-time features only for including dependencies; express policy at runtime. Make insecure signature modes impossible by default in production: the release build should refuse signature_mode Disabled/Permissive unless an explicit, audited override is present, and the shipped default should be Enforcing. Add an invariant that every [features] entry has at least one cfg use (or is an alias of features that do) and every optional dep is referenced under its cfg.
- **Doğrulama:** A script parses Cargo.toml [features] and dep: entries and fails on zero cfg uses. Run cargo-machete/udeps on the CI feature set. A config test asserts that a release-profile load of a config without signature_mode results in Enforcing or a refused start.
- **Not:** Adversarial re-check rated MEDIUM (verifier HIGH): The feature facts are confirmed: signed-deploy, st-bytecode, multi-task-scheduler, live-debug, license-enforce, metrics and kani have 0 cfg sites. tpm has 3 hits, all comments. tss_esapi, jsonwebtoken and metrics are never referenced. src/st_compiler.rs and src/st_vm.rs do not exist. I found counter-evidence that lowers the security impact, and one sub-claim is refuted. (1) Shipped release binaries cannot run with the documented insecure default. AgentConfig::validate() → validate_faz2_security_coherence() has a #[cfg(not(debug_assertions))] gate that bails on signature_mode=disabled, and also on mtls.mode=legacy (config.rs:3775-3805), and the release profile has no debug-assertions override. So 'default Disabled = any envelope accepted' applies only to debug builds. In release the minimum posture is Permissive, which still accepts unsigned mutating commands (envelope.rs:441), so a real gap remains but needs explicit operator config. The same gate makes the release agent refuse to boot with the cloud and OS configs (incidental). (2) REFUTED sub-claim: the 'strict-security currently unused' comment is accurate in effect. The only cfg sites (security.rs:219,231) gate check_insecure_option, which has zero callers in src, and security.rs carries #![allow(dead_code)]. So 8 features are no-ops, not 7. (3) Beyond the claim: even with --features tpm the TPM cannot work. The only TpmDevice impl is MockTpmDevice and the only runtime TpmDeviceFactory is NullTpmDeviceFactory, which always returns None. The Suderra OS unit's /dev/tpm0 and /dev/tpmrm0 grants are therefore dead. (4) The [features] header cites invariant tests/invariants/default_build_no_security_escape.rs, which does not exist. The optional deps are not in the release binary (release = scada-display only), so the attack surface is CI-only. Overall this is a misleading security posture and documentation problem rather than an exploitable hole, so MEDIUM, not HIGH. Root cause: features were declared as ADR-phase placeholders. Implementations then landed ungated or runtime-gated, and nothing checks that a declared feature changes compilation. FIX: delete the placeholder features and their optional deps, or make them real. Add an invariant test that parses [features] in Cargo.toml and fails unless each feature is either a pure alias of other features or has at least one cfg(feature=...) site, outside comments, that guards reachable code. Make signature enforcement a typed config default of Enforcing in release, with Permissive requiring an explicit, expiring rollout token, and remove the false 'strict rejection only with this flag' text. TEST: add a dummy feature with no cfg sites and confirm the invariant fails. A release-profile test confirms a config without signature_mode boots in Enforcing, not rejected.

<a id="SENSOR-MEDIUM-231"></a>

### SENSOR-MEDIUM-231 — Decommissioning only changes database state: no wipe or safe-state command goes to the device and on-device secrets stay valid

- **Önem:** MEDIUM · **Faz:** P3 · **Son tarih:** 2027-03-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sensor-service EdgeDeviceService.decommissionDevice
- **Köken:** doğrulanan iddia T123 (PARTIAL)
- **Kanıt (dosya:satır):** `apps/sensor-service/src/edge-device/edge-device.service.ts:684-698`, `apps/sensor-service/src/edge-device/provisioning.service.ts:552-555`, `apps/sensor-service/src/edge-device/entities/edge-device.entity.ts:57-88`, `apps/sensor-service/src/edge-device/mqtt-auth.service.ts:196-208`, `infrastructure/mosquitto/mosquitto-production.conf:36`
- **Kanıt (ayrıntı):**
  - apps/sensor-service/src/edge-device/edge-device.service.ts:684-698 - sets lifecycleState=DECOMMISSIONED, isOnline=false and a config note. It sends no MQTT command, does not null mqttPasswordHash, logs no device event, and does not call mqttAuthService.removeDeviceCredentials (compare provisioning.service.ts:552-555)
  - Broker access is cut in HTTP auth mode: mayHoldBrokerSession (entities/edge-device.entity.ts:57-88) excludes DECOMMISSIONED and is re-checked on every CONNECT and ACL call (mqtt-auth.service.ts:196-208,302-307), with the go-auth cache disabled (mosquitto-production.conf:36). The claim of 'no key revocation' is therefore wrong for MQTT access
  - In legacy file mode the password-file entry is never removed on decommission, so the broker keeps admitting the device
  - No device-side wipe or decommission command exists in the cloud; the agent keeps its config, SQLCipher keys and local programs and keeps driving outputs autonomously
- **Kök neden:** Decommission is modeled as a database status flag, not as an orchestrated lifecycle transition with device-side effects and credential lifecycle steps.
- **Mimari düzeltme yönü:** Make decommission a state-machine transition owned by one service. It sends a signed decommission or safe-state-and-wipe command through the command dispatcher (with ack and timeout), revokes the device cert or credential (CRL or OCSP once PKI exists, nulls mqttPasswordHash now), removes file-mode credentials, emits an audit event, and marks the transition complete only after the device ack or an explicit operator override.
- **Doğrulama:** Unit test: decommission calls the dispatcher with a signed wipe command, nulls credentials and calls removeDeviceCredentials. Integration: after decommission, CONNECT and publish are refused in both auth modes. E2E: the device enters safe state and wipes its keystore when it receives the command.
- **Not:** Effective broker revocation exists in production HTTP mode.

<a id="SENSOR-MEDIUM-232"></a>

### SENSOR-MEDIUM-232 — There is no device certificate issuance (CSR); MQTT uses shared-secret passwords, and the provisioning_blob/signature/key_epoch fields are never filled

- **Önem:** MEDIUM · **Faz:** P3 · **Son tarih:** 2027-03-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sensor-service edge-device identity (activation, MQTT auth, v2 provisioning)
- **Köken:** doğrulanan iddia T126 (CONFIRMED)
- **Kanıt (dosya:satır):** `apps/sensor-service/src/edge-device/mqtt-auth.service.ts:152-188`, `infrastructure/nginx/droplet.conf:33-45`, `apps/sensor-service/src/edge-device/dto/provisioning.dto.ts:179-182`, `apps/sensor-service/src/edge-device/provisioning.service.ts:422-432`, `sens-api-gateway/src/provisioning.rs:125-132`, `apps/sensor-service/src/edge-device/entities/v2/device-v2.entity.ts:88-89`, `sens-api-gateway/src/mqtt.rs:1009`
- **Kanıt (ayrıntı):**
  - grep for csr, certificate signing, pkcs10 and X509 issuance across apps/*/src finds nothing
  - apps/sensor-service/src/edge-device/mqtt-auth.service.ts:152-188 (password verify), :460-468 (generateCredentials uses random 16-byte password and PBKDF2) - device auth is username/password
  - infrastructure/nginx/droplet.conf:33-45 - no client-certificate verification on 8883
  - dto/provisioning.dto.ts:179-182,324-327 declare provisioning_blob_b64, provisioning_signature_b64, provisioning_key_epoch and provisioning_bundle_version, but provisioning.service.ts:422-432 and 777-787 never set them
  - sens-api-gateway/src/provisioning.rs:125-132,199-206 - the agent deserializes them but no other module reads them
  - entities/v2/device-v2.entity.ts:88-89 provisioningBlobSha256 and EdgeProvisioningRecordV2 are never written
  - The agent already supports MQTT client certificates (sens-api-gateway/src/mqtt.rs:1009,1211) but nothing issues them
- **Kök neden:** Device identity was never migrated from cloud-issued shared secrets to device-held keys, and the v2 contract fields were added speculatively on both sides with no producer.
- **Mimari düzeltme yönü:** Have the device generate its keypair (TPM-backed where /dev/tpmrm0 exists; the OS unit already allows it) and send a CSR in the two-phase activation (T117). A cloud CA (KMS-backed, e.g. step-ca) issues a short-lived device cert with CN/SAN = device UUID and tenant. The broker uses mTLS with use_identity_as_username (T119), with renewal over the mTLS channel. Either make the provisioning bundle fields required in the v2 contract or delete them; no optional dead fields.
- **Doğrulama:** Integration test: CSR, then issued cert, then broker CONNECT with the cert succeeds and with a password only fails. Renewal before expiry. Contract test that activation v2 responses include the signed bundle and the agent verifies it.
- **Not:** Adversarial re-check rated MEDIUM (verifier HIGH): Confirmed. No device CSR or X.509 issuance exists in apps/*/src; the only cert code is NATS service mTLS. Device MQTT authentication is a per-device random password with PBKDF2 hashing, nginx does no client-certificate verification, and the provisioning_blob/signature/key_epoch DTO fields and provisioningBlobSha256 are never set. I lower the severity: each password is a unique 128-bit random secret, stored only as a hash, bound to the client ID, carried over TLS, and ACL-confined to the device's own namespace. That meets basic per-device unique authentication. The lack of device-held or hardware-bound keys is a hardening gap that matters when a credential is stolen from a device disk. It is not a directly exploitable vulnerability, and the dead optional DTO fields are LOW on their own.

<a id="SENSOR-LOW-233"></a>

### SENSOR-LOW-233 — MqttTlsConfig derived Default contradicts its serde defaults (enabled/verify_hostname false when the tls block is missing)

- **Önem:** LOW · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway/src/config.rs MqttTlsConfig
- **Köken:** doğrulanan iddia T38 (PARTIAL)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/config.rs:396-420`, `sens-api-gateway/src/config.rs:458-460`, `sens-api-gateway/src/main.rs:4658-4664`, `sens-api-gateway/src/config.rs:3616-3622`, `sens-api-gateway/src/mqtt.rs:957-963`, `apps/sensor-service/src/edge-device/installer-script.service.ts:337-338`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/config.rs:396-420 `#[derive(.., Default)] pub struct MqttTlsConfig` gives enabled=false and verify_hostname=false, while the field-level serde defaults are default_true.
  - sens-api-gateway/src/config.rs:458-460 `#[serde(default)] pub tls: MqttTlsConfig` uses the derived Default when the block is absent.
  - sens-api-gateway/src/main.rs:4658-4664 activation only sets tls.enabled=true (it never touches verify_hostname).
  - Mitigation: sens-api-gateway/src/config.rs:3616-3622 release builds bail when !mqtt.tls.enabled, so this is fail-closed rather than silent plaintext in release. mqtt.rs:957-963 treats verify_hostname=false as a hard error, so a debug build activated on 8883 without a tls block can never connect. Both shipped configs contain a tls block (Suderra-OS package/suderra-edge-agent/config.yaml; apps/sensor-service/src/edge-device/installer-script.service.ts:337-338).
- **Kök neden:** There are two independent sources of defaults (derive(Default) and serde default fns) that disagree.
- **Mimari düzeltme yönü:** Replace derive(Default) with a manual impl that calls the same default_true fns, so Default equals deserialize of an empty map. Alternatively, make the tls block required.
- **Doğrulama:** Unit test: MqttTlsConfig::default() equals serde_yaml::from_str("{}"). Parsing an MqttConfig without tls yields enabled=true and verify_hostname=true.

<a id="SENSOR-LOW-234"></a>

### SENSOR-LOW-234 — Provisioning endpoints return raw exception messages with 400 (env var names, token/activation/device-existence state), reveal readiness before token validation, and readiness ignores the REVOKED lifecycle state

- **Önem:** LOW · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sensor-service ProvisioningController / ProvisioningService readiness checks
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `apps/sensor-service/src/edge-device/provisioning.controller.ts:162-174`, `apps/sensor-service/src/edge-device/installer-script.service.ts:251-256`, `apps/sensor-service/src/edge-device/provisioning.service.ts:291-309`, `apps/sensor-service/src/edge-device/provisioning.controller.ts:91-107`, `apps/sensor-service/src/edge-device/provisioning.service.ts:488-490`, `infrastructure/nginx/droplet.conf:226`
- **Kanıt (ayrıntı):**
  - apps/sensor-service/src/edge-device/provisioning.controller.ts:162-174 maps every failure to 400 with error.message, including env var names (installer-script.service.ts:251-256) and distinct 'not found' / 'Invalid provisioning token' / 'Device has already been activated' messages (provisioning.service.ts:291-309)
  - provisioning.controller.ts:91-107 reveals device readiness and reason before the token is validated
  - provisioning.service.ts:488-490 isDeviceReadyForActivation checks only DECOMMISSIONED, not isTerminalLifecycleState (REVOKED), unlike activation at :348; generateSuderraOsInstallManifest (:288-310) checks no lifecycle state at all
  - infrastructure/nginx/droplet.conf:226 comment still says the token is sent as ?token= in the URL
  - The dead SSH command builder in incidental #172 is claim T125
- **Kök neden:** Each endpoint does its own validation and error mapping instead of sharing one guard and error policy.
- **Mimari düzeltme yönü:** Use one provisioning guard (format, then token, then terminal lifecycle state via isTerminalLifecycleState) and one exception filter returning uniform 401/404/409 codes with generic bodies.
- **Not:** Incidental finding (merged from 2 raw report(s)); area=cloud.
- **Durum notu (2026-10-20):** ADR-048 DEC-22 puts uniform public errors and rate limits in P0. This finding tracks the remainder until its deadline (owner @Okan-wqm, 2026-12-31). Done:
  - GET /install/{code}/suderra-os answers every refusal with delivery.json's uniform 404 body;
  - the nginx zones in front of /install/ and /api/devices/ answer a rate limit with 429 (delivery.json `rate_limited_status`, pinned by tests/invariants/suderra-edge-contracts.spec.ts).

  Open:
  - the generic GET /install/{code} and POST /api/devices/activate, which Suderra OS agents also call, still answer distinct 404/400/409/401 codes. The agent maps those codes to its own errors (sens-api-gateway/src/provisioning.rs), so making them uniform needs the agent side in the same change;
  - the gateway-api rate limits DEC-22 names (`apps/gateway-api/src/config/rate-limit.config.ts`).

<a id="SENSOR-LOW-235"></a>

### SENSOR-LOW-235 — Topic templates substitute the cloud-supplied tenant_id without rejecting MQTT wildcards or separators

- **Önem:** LOW · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway config.rs topic resolution
- **Köken:** doğrulanan iddia T27 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/config.rs:875-918`, `sens-api-gateway/src/main.rs:4581-4582`, `sens-api-gateway/src/config.rs:3283-3295`, `apps/sensor-service/src/edge-device/mqtt-auth.service.ts:296`, `sens-api-gateway/src/commands/mqtt_dispatch.rs:63`
- **Kanıt (ayrıntı):**
  - src/config.rs:875-918 MqttTopics::resolve uses `.replace("{tenant_id}", tenant_id)` on every topic. validate_no_placeholders (:956+) only looks for '{' '}' and only warns
  - The tenant_id comes from the provisioning response (main.rs:4581-4582, 4665-4666) as a free String with no UUID or wildcard validation. device_id is UUID-validated (config.rs:3283-3295)
  - Mitigations: broker ACL regex `^tenants\/([a-f0-9-]+)\/devices\/` (mqtt-auth.service.ts:296) rejects '+'/'#' tenants, and command matching is an exact string compare (mqtt_dispatch.rs:63), so a wildcard subscription would not execute other tenants' commands
- **Kök neden:** Identifiers are carried as raw Strings and interpolated into protocol strings. There is no validated TenantId type at the provisioning boundary.
- **Mimari düzeltme yönü:** Make it impossible: parse tenant_id into a TenantId(Uuid) newtype at the provisioning response boundary and in config load. Topic construction takes typed IDs (`Topic::commands(&TenantId, &DeviceId)`), so wildcard or '/' characters cannot reach a topic string.
- **Doğrulama:** Unit: provisioning responses with tenant_id "+", "#" or "a/b" are rejected at parse. Property test: resolved topics never contain '+', '#' or extra '/' segments.

## Altyapı ve CI/release

<a id="INFRA-CRITICAL-236"></a>

### INFRA-CRITICAL-236 — Release and OS builds ship without the gpio feature, so GPIO writes and safe-state only simulate while reporting success

- **Önem:** CRITICAL · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway gpio / release pipeline / Suderra OS agent package
- **Köken:** doğrulanan iddia T17 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/Cargo.toml:424`, `Cargo.toml:432-434`, `.github/workflows/edge-agent-release.yml:20`, `Suderra-OS/package/suderra-edge-agent/suderra-edge-agent.mk:17`, `sens-api-gateway/src/gpio.rs:502-508`, `sens-api-gateway/src/gpio.rs:647-676`, `sens-api-gateway/src/main.rs:6119-6129`, `sens-api-gateway/src/safe_state.rs:296-302`, `sens-api-gateway/src/main.rs:4844-4846`, `sens-api-gateway/src/gpio.rs:557-595`, `sens-api-gateway/src/i2c.rs:525-540`, `sens-api-gateway/src/i2c.rs:681-684`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/Cargo.toml:424 `default = ["health"]`, :425 `gpio = ["rppal"]`; the comment at :408 says 'default build must include gpio' (it does not)
  - Cargo.toml:432-434 edge-rc2/3/4 aliases = ["scada-display"] only
  - /home/user/aquaculture_platform/.github/workflows/edge-agent-release.yml:20 `EDGE_RELEASE_FEATURES: scada-display`, :240 `cross build --release ... --features "$EDGE_RELEASE_FEATURES"`
  - /home/user/Suderra-OS/package/suderra-edge-agent/suderra-edge-agent.mk:17 `CARGO_BUILD_OPTS = --bin suderra-agent` (default features only: no gpio, not even scada-display)
  - src/gpio.rs:502-508 the non-gpio `init_gpio` only does warn!("...simulation mode") and returns Ok(())
  - src/gpio.rs:647-676 the non-gpio `write_single_pin` stores into `simulated_states` and returns Ok (logs 'GPIO WRITE [SIM]')
  - src/main.rs:6119-6129 init_hardware only logs 'GPIO running in simulation mode' at info level; boot continues
  - src/safe_state.rs:296-302 GpioPin safe-state calls handle.write_pin → the simulated Ok is counted as success; main.rs:4844-4846 logs 'boot safe-state applied (N outputs driven to fail-safe)'
- **Kök neden:** Hardware I/O is an opt-in Cargo feature, and a missing feature drops to a silent simulation backend through the same GpioHandle API. No build or release contract ties a hardware target to its I/O backend, and the safe-state accounting cannot tell a simulated write from a physical one.
- **Mimari düzeltme yönü:** Make it impossible: remove the runtime simulation fallback from production binaries. The simulation backend should exist only under cfg(test) or an explicit `gpio-sim` feature that release CI rejects. Add a typed per-target IoBackend (Rpi BCM via gpiocdev, RevPi piControl, x86 GPIO/IO-module drivers) selected at build time from the defconfig/target triple. If gpio config is non-empty and no physical backend is present, init must fail closed (refuse boot or enter an explicit degraded mode reported to the cloud). The Buildroot package and the release workflow must pass the target's hardware feature set from one shared SSoT.
- **Doğrulama:** CI invariant: build the release feature set and assert `cargo tree -e features` contains the target's hardware backend. Unit test: a config with GPIO outputs and no physical backend makes init_hardware return Err, and SafeStateManager::apply reports 0 physical successes. HIL test on RevPi/RPi: a write_gpio command toggles a measured output line.

<a id="INFRA-HIGH-237"></a>

### INFRA-HIGH-237 — Edge CI suppresses every denied clippy lint, never compiles gpio, and release ships untested, unlocked builds

- **Önem:** HIGH · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway CI / edge-agent-release.yml / nested sens-api-gateway/.github
- **Köken:** doğrulanan iddia T56 (CONFIRMED)
- **Kanıt (dosya:satır):** `.github/workflows/sens-api-gateway-ci.yml:210-230`, `sens-api-gateway/Cargo.toml:561-570`, `.github/workflows/ci-edge.yml:16-20`, `.github/workflows/ci-edge.yml:131-135`, `.github/workflows/sens-api-gateway-ci.yml:44`, `.github/workflows/ci-edge.yml:109`, `.github/workflows/rust-ci.yml:162`, `Cargo.toml:13-15`, `.github/workflows/edge-agent-release.yml:84-90`, `.github/workflows/edge-agent-release.yml:240`, `sens-api-gateway/.github/workflows/release.yml:5-8`, `Cargo.toml:23`
- **Kanıt (ayrıntı):**
  - /home/user/aquaculture_platform/.github/workflows/sens-api-gateway-ci.yml:210-230 clippy step passes -A clippy::unwrap_used, expect_used, indexing_slicing, large_stack_arrays, todo, unimplemented, dbg_macro, print_stdout, print_stderr. That is all 9 lints sens-api-gateway/Cargo.toml:561-570 sets to deny. Command-line -A comes after the manifest [lints], so it wins. No executed job enforces them.
  - /home/user/aquaculture_platform/.github/workflows/ci-edge.yml:16-20,103-108 claims `cargo check` enforces the [lints.clippy] deny set. That is false: clippy lints only run under cargo clippy. ci-edge.yml:131-135 claims the release workflow runs the ignored integration tests. It runs none.
  - sens-api-gateway-ci.yml:44 SENS_API_GATEWAY_CI_FEATURES leaves out gpio. ci-edge.yml:109,120,136 use only --features health. rust-ci.yml:162,190 --all-features covers only the root workspace, and root Cargo.toml:13-15 excludes sens-api-gateway. No executed workflow compiles feature gpio, which has 61 cfg sites in gpio.rs/i2c.rs/pwm.rs/spi.rs.
  - edge-agent-release.yml jobs release-ref-contract (25-96), sens-enterprise-validation (98-140), build (142-310) and release (312-530) never run cargo test. tools/gates/sens-enterprise-validation.ts is a static text gate: its only spawnSync (:327) runs the deployment-scope selector. The release only checks that the tag is an ancestor of main (edge-agent-release.yml:84-90), not that CI passed on that SHA.
  - edge-agent-release.yml:240 `cross build --target-dir ... --release --target ... --features` has no --locked. The audit/deny step (205-229) runs earlier on the committed Cargo.lock, so the graph that was audited is not guaranteed to be the graph that was built.
  - /home/user/aquaculture_platform/sens-api-gateway/.github/workflows/release.yml:5-8 triggers on tag v*. It uses toolchain "1.85" (:35), builds --features gpio (:46,:50), copies the raw binary (:52-56) and publishes it with no checksum or signature (:80-84). The nested ci.yml (:39-40,88) excludes gpio claiming rppal is Linux-only, but it runs on Linux.
  - GitHub only runs workflows from the repo-root .github/workflows, so both nested files are dead in this monorepo. They also could not run in a standalone repo: Cargo.toml:23 and :950-951 use ../crates path deps. Nothing mirrors or splits the subtree (grep of workflows/scripts).
- **Kök neden:** The lint backlog was silenced on the CI command line instead of being fixed or ratcheted down. gpio was excluded because of a stale rppal-is-Linux-only argument. The release pipeline was designed as packaging-only and assumes main is green, with no SHA-bound CI evidence. The cross invocation never adopted the --locked discipline the CI jobs use. The nested workflows are left over from the pre-monorepo standalone edge-agent repo and were never removed.
- **Mimari düzeltme yönü:** Keep one CI source of truth. Delete sens-api-gateway/.github entirely. Make sens-api-gateway-ci a reusable workflow (workflow_call) and have edge-agent-release `needs` it on the exact tag SHA, so a release without green tests, clippy and deny on that SHA cannot happen. Extend the enterprise-validation gate to reject any cargo/cross build|test|check invocation in edge workflows that lacks --locked. Replace the -A flags with a ratchet: put #[expect(clippy::...)] at the existing sites or keep a committed per-lint count baseline that can only go down, so new unwrap/indexing fails CI. Derive the CI feature set from Cargo.toml [features] minus an explicit hardware-only exclusion list checked by a test, and add gpio. Add an aarch64 cross check with release features plus gpio.
- **Doğrulama:** Add gate unit tests that (a) fail if any edge workflow cargo/cross command lacks --locked, (b) fail if the clippy step allows any lint listed as deny in [lints.clippy], (c) fail if the CI features plus the documented exclusions differ from the Cargo.toml features, (d) fail if any .github directory exists below the repo root, and (e) fail if the release job graph does not include the test jobs. Negative checks: add an unwrap() in src and confirm the clippy job goes red; tag a commit with a failing test and confirm the release is blocked.
- **Durum notu (2026-10-20):** Advanced, not closed. Done: the nested sens-api-gateway/.github workflows are deleted; the release calls sens-api-gateway-ci.yml and ci-edge.yml on the tag's commit; every cargo/cross command carries --locked (pinned by tests/invariants/edge-release-pipeline.spec.ts); ci-edge.yml tests and, in profile-clippy, lints every planned release feature set, including suderra-os and the rpi4-cm4 gpio set that the gateway clippy job's curated CI feature set never covered (not yet run in CI). Open: the 14 `-A clippy::…` suppressions (9 of them lints that Cargo.toml [lints.clippy] denies) in both clippy jobs still need the ratchet described above.

<a id="INFRA-MEDIUM-238"></a>

### INFRA-MEDIUM-238 — apply_signed_manifest streams base64 files from the MQTT command into agent-owned slot dirs (impossible above 1 MiB, never executed), and the anti-rollback floor lives in a plaintext, agent-writable partition.json that resets when deleted

- **Önem:** MEDIUM · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway commands/apply_signed_manifest.rs + updater/partition_store.rs
- **Köken:** doğrulanan iddia T15 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/commands/apply_signed_manifest.rs:684-692`, `sens-api-gateway/src/mqtt.rs:276`, `.github/workflows/edge-agent-release.yml:274-277`, `sens-api-gateway/src/updater/partition_store.rs:64`, `sens-api-gateway/src/main.rs:2221-2226`, `sens-api-gateway/src/commands/apply_signed_manifest.rs:466-470`
- **Kanıt (ayrıntı):**
  - aquaculture_platform/sens-api-gateway/src/commands/apply_signed_manifest.rs:684-692 requires agent-config slot mounts; :716-778 'files' JSON map of base64 strings from the command -> InMemoryFileSource; :780 stream_files_to_standby
  - mqtt.rs:276 set_max_packet_size(1_048_576, 1_048_576); release requires binary >= 1 MiB (.github/workflows/edge-agent-release.yml:274-277), so the base64 agent binary can never fit; rumqttc 0.25.1 mqttbytes/mod.rs:182 PayloadSizeLimitExceeded
  - updater/partition_store.rs:64 /var/lib/suderra/partition.json (plain JSON, no MAC); :314-345 missing file -> PartitionState::initial(), floor reset; main.rs:2221-2226 error text tells operators to delete the file
  - apply_signed_manifest.rs:466-470 floor bumped at apply time, before the new firmware ever boots
  - Slot content is never executed: ExecStart is fixed to /opt/suderra/edge/current/suderra-agent, and /opt is read-only for the agent
- **Kök neden:** The agent reimplements A/B OTA inside its own sandbox, duplicating the root-owned OS installer and RAUC. The monotonic floor is stored where the subject process itself can rewrite or delete it.
- **Mimari düzeltme yönü:** Have the root-owned installer fetch artifacts over HTTPS (not inside MQTT payloads) and verify them against the OS-pinned key. The agent receives only a small signed update intent and forwards it to the OS service. The OS keeps the floor in tamper-resistant monotonic storage (TPM NV counter, or root-owned signed state on LUKS /data), and a missing floor fails closed instead of resetting.
- **Doğrulama:** Delete the floor state, then present an older validly signed manifest: it is rejected. QEMU: a 20 MB artifact installed through the intent path activates.
- **Not:** Adversarial re-check rated MEDIUM (verifier HIGH): TITLE: apply_signed_manifest is a non-functional in-sandbox A/B OTA (inline base64 over MQTT capped at 1 MiB, slots never executed) whose anti-rollback floor lives in agent-writable plaintext JSON. VERDICT: CONFIRMED as described, but I rate it MEDIUM, not HIGH. By default it is unreachable: ab_partitions slot mounts are None, so it returns 'ab_partitions_required', and firmware_update.mode defaults to Disabled. No producer of SignedFirmwareManifest exists (T16), so no device can be harmed through it today. The writable floor is exploitable only by someone who already runs as uid suderra, who can already do anything the agent can. The real-world impact is dead, misleading code that the cloud points operators to, plus a design that duplicates the root-owned OS installer and RAUC. All facts hold: the inline 'files' map is base64 from the command; the vendored rumqttc caps packets at 1 MiB (PayloadSizeLimitExceeded); the release gate requires a binary of at least 1 MiB; partition.json is plain JSON, resets to initial() when missing, and the operator error text recommends deleting it; the floor is bumped at apply time. ROOT CAUSE: the agent reimplements A/B OTA inside its own sandbox instead of delegating to the OS update authority, and monotonic state is stored where its subject can rewrite it. FIX: delete the in-agent A/B path. The agent's only update role is to receive a signed release reference and hand it to a root-owned OS service (suderra-edge-install/RAUC) over a narrow IPC. The anti-rollback floor lives in root-owned storage (TPM NV counter, or RAUC/edge-installer state under /var/lib/suderra-installer, 0700 root). TEST: a contract test that the agent's command catalog contains no command that writes executable content; an OS test that the floor survives deletion attempts by uid suderra.

<a id="INFRA-MEDIUM-239"></a>

### INFRA-MEDIUM-239 — mTLS pinning has no viable production mode: Legacy/Warn never enforce, and Strict pins the auto-renewed Let's Encrypt broker leaf

- **Önem:** MEDIUM · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway/src/mtls (mode.rs, rustls_verifier.rs, pinning.rs) + infrastructure/nginx
- **Köken:** doğrulanan iddia T39 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/mtls/mode.rs:33-48`, `sens-api-gateway/src/config.rs:3225-3233`, `sens-api-gateway/src/mtls/rustls_verifier.rs:183-200`, `sens-api-gateway/src/mtls/rustls_verifier.rs:363-371`, `sens-api-gateway/src/mtls/pinning.rs:1-19`, `infrastructure/nginx/droplet.conf:23-45`, `docker-compose.droplet.yml:2116-2120`, `sens-api-gateway/src/commands/cert_pinning.rs:56-63`, `sens-api-gateway/src/config.rs:3799-3805`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/mtls/mode.rs:33-48 `#[default] Legacy`. config.rs:3225-3233 MtlsConfig::default uses it.
  - sens-api-gateway/src/mtls/rustls_verifier.rs:183-200 in Legacy and Warn, any policy failure (age, unpinned fingerprint) is logged and the handshake accepted. Only Strict rejects (220-243).
  - sens-api-gateway/src/mtls/rustls_verifier.rs:363-371 the pin is the SHA-256 of the full leaf DER, not the SPKI or CA. pinning.rs:1-19 describes manual two-phase leaf rotation.
  - aquaculture_platform/infrastructure/nginx/droplet.conf:23-45 MQTT 8883 TLS is terminated by nginx with /etc/letsencrypt/live/app.suderra.com/fullchain.pem. docker-compose.droplet.yml:2116-2120 mounts /etc/letsencrypt, so the leaf fingerprint changes on every certbot renewal (about every 60 days).
  - sens-api-gateway/src/commands/cert_pinning.rs:56-63 runtime pin rotation is in-memory only, so a restart reloads the old pins from config.yaml.
  - sens-api-gateway/src/config.rs:3799-3805 release builds reject Legacy, so a config without an mtls block refuses to boot in release (see incidental) instead of running unpinned.
- **Kök neden:** The model is an exact leaf-cert pin with a manual rotation ceremony, but the broker cert is a public-CA web cert shared with app.suderra.com that rotates automatically. Nothing couples cloud cert renewal to edge pin distribution or persistence.
- **Mimari düzeltme yönü:** Terminate MQTT TLS with a cert issued by a dedicated private broker CA, kept separate from the web LE cert. Pin that CA (or the SPKI of a long-lived broker key) and verify the chain against it, so leaf renewals are transparent. Distribute pin sets in a signed manifest that is persisted atomically. Make Strict the default and remove Legacy from release builds at the type level (a cfg-gated enum variant).
- **Doğrulama:** rcgen-based integration tests: a new leaf under the same pinned CA/SPKI passes the handshake, a leaf from another CA is rejected, and new pins survive a restart after rotation. A release-profile test shows the default MtlsConfig is Strict and boots.
- **Not:** Adversarial re-check rated MEDIUM (verifier HIGH): TITLE: mTLS leaf pinning has no usable production mode: Warn never enforces, and Strict pins an auto-renewing Let's Encrypt leaf, causing a fleet outage on renewal. VERDICT: PARTIAL. TRUE: Legacy/Warn accept policy failures (unpinned fingerprint, age). Strict pins the SHA-256 of the full leaf DER. The broker endpoint is nginx with the certbot-managed app.suderra.com leaf, which changes on every renewal. Runtime pin rotation is in-memory only. Release builds reject Legacy, and the OS placeholder config.yaml has no mtls block. COUNTER-EVIDENCE: 'never enforce' covers only the Suderra policy gates. Every mode first runs the full rustls WebPkiServerVerifier (chain + hostname), and Legacy with no pins uses the stock rustls verifier, so the connection is never unauthenticated. Warn with an empty pin list is a valid release boot configuration (only Strict requires pins, config.rs:4206), giving standard public-CA TLS. The real-world defect is therefore: (1) pinning adds no protection in any workable mode, and (2) Strict, the documented end state, breaks MQTT at the next LE renewal with no in-band recovery, because update_cert_pinning arrives over the same failed MQTT link and is not persisted, which forces site visits. Not HIGH, because the security baseline (WebPKI) holds. Related: the cloud never verifies the edge's client certificate (see incidental), so 'mTLS' is one-way TLS. ROOT CAUSE: an exact-leaf pin model with a manual two-phase ceremony was applied to a public-CA web certificate shared with the website, which rotates automatically. Nothing couples cloud cert renewal to edge pin distribution or persistence. FIX: give the broker a dedicated private CA (or at minimum a stable key) separate from app.suderra.com. Pin the SPKI of the issuing CA (or a key-continuity SPKI set), not the leaf DER. Distribute pin sets in a signed, versioned manifest that is persisted atomically and applied before rotation (make-before-break, with the cloud publishing next+current). Make Strict refuse to activate unless the pinned SPKI set covers both current and next. TEST: a unit test where a renewed leaf with the same CA SPKI is accepted in Strict and a foreign CA is rejected. A persistence test where a pin update survives restart. An e2e test that rotates the broker leaf in a test harness and checks the agent reconnects without intervention.

<a id="INFRA-MEDIUM-240"></a>

### INFRA-MEDIUM-240 — The nightly fuzz job can never report a crash: fuzz_exit is tee's status (no pipefail), and the 23h run exceeds the 6h GitHub-hosted job limit

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** .github/workflows/fuzz-st-parser-nightly.yml
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `.github/workflows/fuzz-st-parser-nightly.yml:145-153`
- **Kanıt (ayrıntı):**
  - .github/workflows/fuzz-st-parser-nightly.yml:145-153 `set +e; cargo +nightly fuzz run ... 2>&1 | tee fuzz-output.log; fuzz_exit=$?` with no pipefail and no `shell: bash`, so $? is tee's status and crash_detected is always false (confirmed)
  - :91-92 runs-on ubuntu-latest with timeout-minutes 1440 and MAX_TOTAL_TIME_SECS 82800; the comment at :58-60 says hosted runners extend to 35h, but GitHub-hosted jobs are capped at 6h, so the job is cancelled and the crash/issue steps at :172-183 never fire
- **Kök neden:** Shell pipeline semantics and runner limits were assumed, not verified.
- **Mimari düzeltme yönü:** Use set -o pipefail or ${PIPESTATUS[0]}, cap the run below 6h or use a self-hosted runner, and add a self-test that injects a known crash and asserts crash_detected=true.
- **Not:** Incidental finding (merged from 1 raw report(s)); area=release-ci.

<a id="INFRA-MEDIUM-241"></a>

### INFRA-MEDIUM-241 — Release builds fetch an unpinned apt.llvm.org key and Xenial repo inside tag-pinned EOL cross images, and install unpinned cargo-audit/cargo-deny with errors swallowed

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway Cross.toml / edge-agent-release.yml build tooling
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `.github/workflows/edge-agent-release.yml:212-213`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/Cross.toml pre-build (all three targets): `wget -qO - https://apt.llvm.org/llvm-snapshot.gpg.key | apt-key add -` with no fingerprint pinning plus `deb http://apt.llvm.org/xenial/ llvm-toolchain-xenial-12` inside ghcr.io/cross-rs/*:0.2.5 images, pinned by tag not digest and based on EOL Ubuntu 16.04
  - .github/workflows/edge-agent-release.yml:212-213 `cargo install cargo-audit --locked 2>/dev/null || true` and the same for cargo-deny: no version pin, errors suppressed
- **Kök neden:** Build-environment dependencies are fetched live at release time instead of coming from a digest-pinned builder image.
- **Mimari düzeltme yönü:** Build a digest-pinned release builder image (current LTS, pinned LLVM) in its own reviewed workflow, reference it by digest in Cross.toml, and install audit tools at pinned versions, failing hard on error.
- **Not:** Incidental finding (merged from 2 raw report(s)); area=release-ci.

<a id="INFRA-MEDIUM-242"></a>

### INFRA-MEDIUM-242 — Rust toolchain and lockfile discipline drift across pipelines: MSRV 1.85, CI/release 1.88, Buildroot 1.86, ci-edge.yml on unpinned stable without --locked, and no gate builds the OS package or the declared MSRV

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway toolchain / ci-edge.yml / Suderra-OS Buildroot rust
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/Cargo.toml:5`, `.github/workflows/sens-api-gateway-ci.yml:82`, `.github/workflows/edge-agent-release.yml:19`, `sens-api-gateway/fuzz/Cargo.toml:5`, `Suderra-OS/package/suderra-edge-agent/Config.in:1-7`, `.github/workflows/ci-edge.yml:74`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/Cargo.toml:5 rust-version 1.85; sens-api-gateway-ci.yml:82 and edge-agent-release.yml:19 use 1.88.0; fuzz/Cargo.toml:5 rust-version 1.88
  - Suderra-OS buildroot/package/rust/rust.mk:9 RUST_VERSION = 1.86.0; BR2_PACKAGE_SUDERRA_EDGE_AGENT is unset in every defconfig and gated on CARGO4_HASH_REVALIDATED (package/suderra-edge-agent/Config.in:1-7), so the OS build is never exercised
  - Whether the lockfile builds on 1.86 cannot be checked here (no local crate registry)
  - .github/workflows/ci-edge.yml:74 RUST_TOOLCHAIN: stable; :109, :120, :136 cargo check/test without --locked, while sens-api-gateway-ci.yml uses 1.88.0 and --locked throughout
- **Kök neden:** Each pipeline pins its own toolchain and no gate builds with the declared MSRV or the OS toolchain.
- **Mimari düzeltme yönü:** Keep one toolchain SSoT for Cargo.toml rust-version, CI and the Buildroot pin; add an MSRV `cargo check --locked` job and a Buildroot package build in Suderra-OS CI; delete or fold ci-edge.yml into the curated workflow.
- **Not:** Incidental finding (merged from 2 raw report(s)); area=release-ci.

<a id="INFRA-MEDIUM-243"></a>

### INFRA-MEDIUM-243 — The SCADA kiosk cannot run: Suderra OS ships no display stack (cage/chromium), and the unit's NoNewPrivileges/RestrictNamespaces/RestrictSUIDSGID break the Chromium sandbox

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway systemd/suderra-display.service + Suderra-OS image
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/systemd/suderra-display.service:37-50`, `sens-api-gateway/systemd/suderra-display.service:59-67`, `.github/workflows/edge-agent-release.yml:20`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/systemd/suderra-display.service:37-50 cage + chromium-browser --app=http://localhost:6526/scada (no --no-sandbox)
  - suderra-display.service:59-67 NoNewPrivileges=true, RestrictNamespaces=true, RestrictSUIDSGID=true (blocks both the userns and setuid Chromium sandboxes)
  - Suderra-OS/configs/*_defconfig: no CAGE/CHROMIUM/WESTON/MESA packages (grep empty); release binaries still ship the SCADA server (edge-agent-release.yml:20)
- **Kök neden:** The HMI kiosk was designed for a general-purpose distro and never became part of the Suderra OS image contract, while release binaries still ship the SCADA server.
- **Mimari düzeltme yönü:** Decide the HMI surface per board profile: either add a kiosk package with a sandbox-compatible unit or exclude scada-display from images without a display; boot-test the display profile.
- **Not:** Incidental finding (merged from 1 raw report(s)); area=agent.

<a id="INFRA-MEDIUM-244"></a>

### INFRA-MEDIUM-244 — The SLSA/in-toto provenance is a hand-written heredoc from the build job (builder.id actions/runner/ubuntu-latest), not trusted-builder provenance

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** .github/workflows/edge-agent-release.yml provenance
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `.github/workflows/edge-agent-release.yml:292-295`
- **Kanıt (ayrıntı):**
  - .github/workflows/edge-agent-release.yml:292-295 the in-toto statement is written by `cat > ... <<EOF` with builder.id 'https://github.com/actions/runner/ubuntu-latest', then cosign-signed (:356-366); cosign only attests that this job wrote it
- **Kök neden:** The provenance format was imitated without an isolated provenance generator.
- **Mimari düzeltme yönü:** Generate provenance with actions/attest-build-provenance or slsa-github-generator and verify it in the release verification job.
- **Not:** Incidental finding (merged from 2 raw report(s)); area=release-ci.

<a id="INFRA-MEDIUM-245"></a>

### INFRA-MEDIUM-245 — SCADA server cannot be disabled by config and serves plain HTTP only

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway/src/main.rs Step 6c + scada_server.rs start
- **Köken:** doğrulanan iddia T37 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/main.rs:5546-5605`, `.github/workflows/edge-agent-release.yml:20`, `sens-api-gateway/src/scada_server.rs:2264-2312`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/main.rs:5546-5605 inside `#[cfg(feature = "scada-display")]` the server starts whenever ScadaDb::new succeeds. AgentConfig has no scada.enabled field.
  - aquaculture_platform/.github/workflows/edge-agent-release.yml:20 `EDGE_RELEASE_FEATURES: scada-display` compiles it into every release binary.
  - sens-api-gateway/src/scada_server.rs:2264-2312 the only knobs are the env vars SUDERRA_SCADA_PORT and SUDERRA_SCADA_BIND. `axum::serve(listener, app)` runs over plain TCP with no TLS option.
- **Kök neden:** The HMI was modelled as a compile-time feature rather than as a runtime surface with its own validated configuration, and transport security was left to the bind address.
- **Mimari düzeltme yönü:** Add a typed `scada: ScadaServerConfig {enabled, bind, port, tls, auth}` to AgentConfig and validate it in AgentConfig::validate. A non-loopback bind requires TLS and auth, and release builds fail closed. Remove the env-var overrides so the config file is the single source of truth.
- **Doğrulama:** Config validation tests: a non-loopback bind without TLS/auth is an error. A boot integration test shows that enabled=false opens no port 6526.

<a id="INFRA-MEDIUM-246"></a>

### INFRA-MEDIUM-246 — OPC UA server defaults to 0.0.0.0:4840 with trust-any-client-cert (TOFU) on first boot and a library-generated sample keypair

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway/src/opc_ua_server_runtime.rs + opc_ua_server/cert_rotation.rs + config.rs
- **Köken:** doğrulanan iddia T41 (PARTIAL)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/config.rs:2474-2479`, `sens-api-gateway/src/opc_ua_server/cert_rotation.rs:16-20`, `sens-api-gateway/src/opc_ua_server_runtime.rs:362-372`, `.github/workflows/edge-agent-release.yml:20`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/config.rs:2474-2479 and 2537-2552 the default bind is "0.0.0.0" and the port is 4840 (enabled=false by default).
  - sens-api-gateway/src/opc_ua_server/cert_rotation.rs:16-20 and 253-261 with no ledger PhaseTransition, the mode starts as LegacyAccept. Lines 98-103 LegacyAccept|WarnOnMismatch make trust_unpinned_clients() return true. Lines 264-269 mode() returns LegacyAccept on lock poisoning (fail-open).
  - sens-api-gateway/src/opc_ua_server_runtime.rs:362-372 `.create_sample_keypair(true).trust_client_certs(trust_unpinned)`.
  - Not verifiable locally: whether async-opcua's create_sample_keypair writes the private key unencrypted, because the library source is not vendored.
  - Latent: the opc-ua-server feature is not in EDGE_RELEASE_FEATURES (.github/workflows/edge-agent-release.yml:20).
- **Kök neden:** Interop-first defaults (TOFU, all interfaces, sample keypair) were chosen to ease HMI onboarding and were never revisited when the PKI rollout state machine landed.
- **Mimari düzeltme yönü:** Require an explicit bind address with no 0.0.0.0 default. Start in StrictPinOnly, with client certs enrolled through a signed manifest. Generate the server keypair through the keystore (encrypted at rest or TPM-sealed) instead of the sample generator. Fail closed on lock poisoning.
- **Doğrulama:** Unit tests for the defaults. An integration test with an async-opcua client presenting an unenrolled cert is rejected on first boot. A poisoned-lock test returns StrictPinOnly or an error.

<a id="INFRA-MEDIUM-247"></a>

### INFRA-MEDIUM-247 — Three of four fuzz targets never call agent code; every real untrusted-input parser except the ST parser is unfuzzed

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway/fuzz
- **Köken:** doğrulanan iddia T57 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/fuzz/fuzz_targets/config_parse.rs:12-27`, `sens-api-gateway/fuzz/fuzz_targets/mqtt_payload.rs:22-47`, `sens-api-gateway/fuzz/fuzz_targets/modbus_response.rs:18-128`, `sens-api-gateway/fuzz/fuzz_targets/st_parser.rs:68-69`, `sens-api-gateway/fuzz/Cargo.toml:28-29`, `Cargo.toml:575-577`, `sens-api-gateway/src/lora/mac.rs:305`, `sens-api-gateway/src/lora/codec.rs:47`, `sens-api-gateway/src/plc_programming/ethernet_ip.rs:390`, `sens-api-gateway/src/scada_server.rs:1354`, `.github/workflows/fuzz-st-parser-nightly.yml:146`, `sens-api-gateway/src/commands/firmware.rs:388-397`
- **Kanıt (ayrıntı):**
  - /home/user/aquaculture_platform/sens-api-gateway/fuzz/fuzz_targets/config_parse.rs:12-27 says "We can't directly use AgentConfig" and only fuzzes serde_yaml::Value / serde_json::Value.
  - fuzz_targets/mqtt_payload.rs:22-47 only fuzzes serde_json::Value plus a local depth walk.
  - fuzz_targets/modbus_response.rs:18-128 is a harness-local MBAP parser written inside the fuzz target. It never calls crate code (the agent uses rodbus).
  - fuzz_targets/st_parser.rs:68-69 is the only target that pulls in crate source, via #[path = "../../src/st_validator.rs"].
  - fuzz/Cargo.toml:28-29 depends on suderra-agent, but the crate is bin-only: there is no src/lib.rs and Cargo.toml:575-577 has only [[bin]]. The dependency cannot expose any API.
  - Unfuzzed trust-boundary entry points: src/lora/mac.rs:305 process_uplink (raw RF input), src/lora/codec.rs:47,193,244 decoders, src/plc_programming/ethernet_ip.rs:390 parse_cip_response, src/scada_server.rs:1354 WsClientMessage serde parse, plus src/command_envelope/envelope.rs, src/authz/manifest.rs, src/opc_ua_server/pki_store.rs and src/scripting/bytecode_vm.rs.
  - Only st_parser is ever run: .github/workflows/fuzz-st-parser-nightly.yml:146. No workflow references config_parse, mqtt_payload or modbus_response.
  - Nuance: the 'OTA tar' item is not an in-crate parser. The legacy OTA shells out to system tar (src/commands/firmware.rs:388-397).
- **Kök neden:** The edge crate is a single [[bin]] with no library, so harnesses cannot link the real parsers. Stand-in harnesses were written to satisfy the IEC 62443 FR3 fuzzing checkbox instead of fixing the crate structure.
- **Mimari düzeltme yönü:** Split the crate into a library (e.g. suderra-agent-core) and a thin bin so harnesses call production entry points. Add one fuzz target per trust boundary: envelope parse and verify, LoRa process_uplink and codecs, CIP/S7/ADS response parsers, bytecode load plus VM under gas, SCADA WS messages, RBAC/user-token manifests, PKI store load, signed firmware manifest. Add a registry invariant mapping every untrusted-input parser to a fuzz target, and a check that each target imports crate symbols (no harness-local parsing). Run a short corpus-regression pass per PR and long runs nightly.
- **Doğrulama:** Add a CI check that fails if a fuzz target does not reference suderra_agent_core:: items or if a registered parser has no target. Run `cargo fuzz run <t> -- -runs=N corpus/<t>` for every target in PR CI. Seed a known out-of-bounds panic in codec.rs on a scratch branch and confirm the fuzz job finds it.

<a id="INFRA-MEDIUM-248"></a>

### INFRA-MEDIUM-248 — sx1302-vendor-hal builds a fake concentrator instead of failing when the Semtech C sources are absent

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway build.rs / vendor/sx1302_hal / src/lora/sx1302.rs
- **Köken:** doğrulanan iddia T59 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/build.rs:57-91`, `sens-api-gateway/src/lora/sx1302.rs:405-470`, `Cargo.toml:462-465`, `sens-api-gateway/vendor/sx1302_hal/README.md:45`, `sens-api-gateway/docs/protocols/lorawan.md:27`, `sens-api-gateway/docs/deployment/configuration.md:195`, `.github/workflows/sens-api-gateway-ci.yml:287-305`, `.github/workflows/edge-agent-release.yml:20`, `Suderra-OS/package/suderra-edge-agent/suderra-edge-agent.mk:17-18`
- **Kanıt (ayrıntı):**
  - /home/user/aquaculture_platform/sens-api-gateway/vendor/sx1302_hal contains only README.md and libloragw/inc/loragw_hal.h. There are no .c sources.
  - build.rs:57-91: with no sources it panics only when SUDERRA_REQUIRE_SX1302_VENDOR_HAL=1 (:68-69). Otherwise it emits cargo:warning and returns without setting cfg sx1302_vendor_hal, so the simulation backend is compiled.
  - src/lora/sx1302.rs:405-470: the simulation init() always returns Ok, receive() returns an empty list, transmit() returns Ok without transmitting, and get_temperature() returns a constant 25.0.
  - Cargo.toml:462-465 says the feature preserves 'a fail-closed hardware build when real concentrator support is requested'. build.rs does the opposite by default.
  - The env var appears only in docs (vendor/sx1302_hal/README.md:45,55; docs/protocols/lorawan.md:27; docs/deployment/configuration.md:195). No workflow and no Buildroot .mk sets it.
  - sens-api-gateway-ci.yml:287-305 sx1302-vendor-hal-contract runs only on workflow_dispatch, only runs `test -d`, and is not in the summary needs (:392-403).
  - Mitigation: no shipped build enables lorawan (release features are scada-display, edge-agent-release.yml:20; the Suderra OS .mk builds default features, package/suderra-edge-agent/suderra-edge-agent.mk:17-18).
- **Kök neden:** A fail-closed requirement is expressed as an opt-in environment variable. The feature name asks for real hardware but the default behaviour is simulation. The NDA/vendor HAL was never vendored or packaged.
- **Mimari düzeltme yönü:** Make `sx1302-vendor-hal` itself fail the build when sources are missing, with no env-var escape. Move simulation behind a separate explicit `sx1302-sim` feature, with compile_error! if both are enabled or if sim is combined with a release tier. Provide the HAL as a hash-pinned source (submodule or Buildroot package). At runtime, the simulation backend must report simulated quality and degraded health, never a silent Ok.
- **Doğrulama:** CI matrix: `--features sx1302-vendor-hal` with an empty vendor dir must fail; `--features sx1302-vendor-hal,sx1302-sim` must fail. A unit test checks that the sim backend marks its readings as Simulated. Put the contract job in the summary needs.

<a id="INFRA-MEDIUM-249"></a>

### INFRA-MEDIUM-249 — Five RustSec advisories ignored, and the RSA Marvin rationale is factually wrong for the OPC UA server

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway deny.toml / .cargo/audit.toml
- **Köken:** doğrulanan iddia T61 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/deny.toml:33-98`, `.github/workflows/sens-api-gateway-ci.yml:347-352`, `.github/workflows/edge-agent-release.yml:222-227`, `Cargo.toml:321`, `deny.toml:43-48`, `sens-api-gateway/src/opc_ua_sens_auth_manager.rs:201-218`, `deny.toml:31-32`, `.github/workflows/edge-agent-release.yml:20`
- **Kanıt (ayrıntı):**
  - /home/user/aquaculture_platform/sens-api-gateway/deny.toml:33-98 ignores RUSTSEC-2023-0071, 2025-0141, 2023-0089, 2024-0436 and 2024-0449. The same list appears in .cargo/audit.toml, sens-api-gateway-ci.yml:347-352 and edge-agent-release.yml:222-227.
  - Cargo.lock reverse deps (parsed by hand; offline cargo tree was unavailable): rsa 0.9.10 <- async-opcua-crypto 0.18.0 (optional, opc-ua-server, Cargo.toml:321); bincode 1.3.3 <- suderra-agent directly; atomic-polyfill 1.0.3 <- heapless 0.7.17; paste 1.0.15 <- wasmi_core 0.36.5; unsafe-libyaml 0.2.11 <- serde_yaml 0.9.34+deprecated.
  - deny.toml:43-48 says the async-opcua 'X.509 VERIFICATION path does NOT expose' a timing oracle. But the server advertises UserName tokens under Basic256Sha256 (src/opc_ua_sens_auth_manager.rs:201-218), which requires server-side RSA private-key decryption of client-encrypted passwords. Basic256Sha256 secure channels also do server private-key RSA operations. Network-reachable private-key operations are exactly the Marvin precondition.
  - The RSA entry's deadline is 'RE-EVAL QUARTERLY', not a date, which breaks the file's own policy at deny.toml:31-32.
  - Mitigation: opc-ua-server is not in the release features (edge-agent-release.yml:20) or in Suderra OS builds. The other four advisories are unmaintained notices with no known vulnerability.
- **Kök neden:** The transitive dependencies are upstream-blocked, and the RSA risk acceptance was written without threat-modelling the OPC UA server's private-key use. Ignore entries are free text with no machine-checked expiry or feature scope.
- **Mimari düzeltme yönü:** For RSA: patch async-opcua-crypto to a constant-time RSA backend (e.g. an aws-lc-rs fork via [patch], the same pattern as local-rumqttc), or make opc-ua-server unbuildable while the advisory is ignored. Store ignores as structured data (owner, ISO deadline, the features that pull the crate, vuln vs unmaintained), extend scripts/ci/check-advisory-ignore-sync.ts to fail once a deadline passes, and add a gate that a release feature tier never pulls a crate under an ignored vulnerability advisory. Plan the bincode replacement (audit wire format) and the serde_yaml replacement as tracked work.
- **Doğrulama:** Unit tests for the sync script: an expired deadline fails; a missing feature scope fails. A CI gate checks that cargo tree -i rsa for the release tier is empty and that an opc-ua-server build fails while RUSTSEC-2023-0071 is ignored and the patched fork is absent.

<a id="INFRA-MEDIUM-250"></a>

### INFRA-MEDIUM-250 — Release builds wrap integer overflow silently, and panic=abort kills the whole agent with no software safe-state

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway Cargo.toml [profile.release]
- **Köken:** doğrulanan iddia T62 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/Cargo.toml:549-554`, `.github/workflows/sens-api-gateway-ci.yml:257`, `sens-api-gateway/src/scripting/bytecode_vm.rs:722-724`, `sens-api-gateway/src/process_hardening.rs:208-213`, `Cargo.toml:553`, `sens-api-gateway/src/opc_ua_server_runtime.rs:194-206`
- **Kanıt (ayrıntı):**
  - /home/user/aquaculture_platform/sens-api-gateway/Cargo.toml:549-554 [profile.release] sets opt-level z, lto, codegen-units 1, panic = "abort" and strip. There is no overflow-checks key, so it defaults to false in release.
  - Tests run only in the dev/test profile, where overflow checks are on (sens-api-gateway-ci.yml:257,285 have no --release). The shipped arithmetic behaviour is therefore never tested.
  - The ST VM uses explicit wrapping ops (src/scripting/bytecode_vm.rs:722-724), so VM semantics are not affected. The exposure is plain arithmetic on I/O values, offsets and counters elsewhere.
  - src/process_hardening.rs:208-213 argues 'WHY NOT panic = abort IN CARGO', which contradicts Cargo.toml:553. With abort, the JoinError-based task isolation (src/opc_ua_server_runtime.rs:194-206) can never observe a panic: any panic in any task, made more likely because clippy indexing_slicing is suppressed (see T56), terminates the process without running safe-state code.
- **Kök neden:** The profile was copied from size-optimised embedded defaults. Overflow semantics and the interaction between abort and output safety were not designed; the release and test profiles drifted apart.
- **Mimari düzeltme yönü:** Set overflow-checks = true in [profile.release], so an overflow becomes a detected fault and a supervised restart. Deny clippy::arithmetic_side_effects in safety and I/O modules so the wrapping/checked/saturating intent is explicit. Add a release-like test profile (inherits release, debug-assertions on) and run the suite in it. Since abort bypasses software safe-state, make the physical fail-safe hardware-enforced: output-module and fieldbus watchdog timeouts, or a systemd/hardware watchdog driving a safe state.
- **Doğrulama:** An invariant test asserts that the release profile has overflow-checks=true. Add a CI job running cargo test with the release-like profile. HIL fault injection: force a panic in the poll task of a release build and verify outputs reach safe state within the watchdog budget.

<a id="INFRA-LOW-251"></a>

### INFRA-LOW-251 — Load-bearing agent comments and config docs contradict the code (FirmwareUpdateMode::Disabled "sole update path", safe-state degraded-mode claim, "default build must include gpio", Strict leaf max-age "unbounded" vs 398 days, panic=abort rationale, dead log_file setting, release trigger)

- **Önem:** LOW · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway comments / Cargo.toml / config docs / ci-edge.yml
- **Köken:** yan bulgu (kod okunurken kaydedildi)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/config.rs:2943-2945`, `sens-api-gateway/src/main.rs:4137-4146`, `sens-api-gateway/src/config.rs:2013-2017`, `sens-api-gateway/src/main.rs:2256-2258`, `sens-api-gateway/src/commands/firmware.rs:96-97`, `sens-api-gateway/src/main.rs:4813-4816`, `Cargo.toml:408`, `Cargo.toml:434`, `sens-api-gateway/src/security.rs:219`, `Cargo.toml:521`, `sens-api-gateway/src/process_hardening.rs:208-213`, `Cargo.toml:553`
- **Kanıt (ayrıntı):**
  - config.rs:2943-2945 default_log_file /var/log/suderra-agent.log (outside ReadWritePaths) has no reader; main.rs:4137-4146 init_logging uses RUST_LOG only
  - config.rs:2013-2017 and main.rs:2256-2258 say legacy tarball OTA remains the sole/available update path when Disabled; commands/firmware.rs:96-97 Disabled => Reject
  - main.rs:4813-4816 'If any output cannot be driven to safe-state, the agent enters degraded mode' vs the gate at :4824 (only zero successes)
  - Cargo.toml:408 'default build must include gpio' vs :422-424 default = ["health"]
  - Cargo.toml:434 calls strict-security unused, but src/security.rs:219,231 use it; Cargo.toml:521 kani feature has zero uses and no cfg(kani) harness despite citing ADR-023
  - src/process_hardening.rs:208-213 'WHY NOT panic = abort IN CARGO' vs Cargo.toml:553 panic = "abort"
  - src/mtls/mode.rs:44-47 'Leaf cert max-age unbounded' vs mode.rs:62-68 and :101 Strict => Some(398)
  - ci-edge.yml:5-9 says the release workflow triggers on manual workflow_dispatch; edge-agent-release.yml:7-10 is tag-only
- **Kök neden:** Comments are treated as statements of intent and are never re-validated against code or gates.
- **Mimari düzeltme yönü:** Replace prose guarantees with executable gates (feature-use check, profile invariants, workflow-contract tests, tests named after the guarantee) and delete or wire dead config fields.
- **Not:** Incidental finding (merged from 4 raw report(s)); area=agent.

<a id="INFRA-LOW-252"></a>

### INFRA-LOW-252 — WASM decoder compilation is unbounded and decoder modules are unsigned

- **Önem:** LOW · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway/src/lora/wasm_decoder.rs
- **Köken:** doğrulanan iddia T47 (CONFIRMED)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/lora/wasm_decoder.rs:61-67`, `sens-api-gateway/src/lora/wasm_decoder.rs:213-246`, `.github/workflows/edge-agent-release.yml:20`
- **Kanıt (ayrıntı):**
  - sens-api-gateway/src/lora/wasm_decoder.rs:61-67 `Module::new(&engine, wasm)` compiles with no size or time bound. Fuel applies only to execution (85-93).
  - sens-api-gateway/src/lora/wasm_decoder.rs:213-246 load_dir reads whole .wasm files from lorawan.wasm_decoder_dir with no size cap and no hash or signature check. Lines 12-15 note the signed deploy path is tracked separately.
  - Latent: the wasm-codec feature is not in EDGE_RELEASE_FEATURES (.github/workflows/edge-agent-release.yml:20).
- **Kök neden:** Decoders were treated as having the same trust level as the local config, so the sandbox focused only on runtime bounds.
- **Mimari düzeltme yönü:** Reuse the signed bytecode-registry pattern: an ed25519-signed manifest over sha256(module), a maximum module size, and compilation in spawn_blocking with a timeout before registration.
- **Doğrulama:** Unit tests: an oversized module is rejected, an unsigned or mis-signed module is rejected, and a valid signed module loads.

## Yayın hattı incelemesi bulguları (2026-10-20)

ADR-048 P0 yayın hattının (release track) bağımsız incelemesinde kaydedildi.

<a id="EDGE-HIGH-128"></a>

### EDGE-HIGH-128 — The agent crate does not compile without its health feature, so every Suderra OS release builds the boards.json features plus health and signs a suderra.edge-release.v1 statement whose cargo_features misstate the build

- **Önem:** HIGH · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway feature graph / edge release statement
- **Köken:** yayın hattı incelemesi (2026-10-20)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/main.rs:1599`, `sens-api-gateway/src/main.rs:2011`, `sens-api-gateway/src/main.rs:5261`, `sens-api-gateway/src/io_poll.rs:118`, `sens-api-gateway/src/scripting/engine.rs:1161`, `sens-api-gateway/src/health.rs:1401`, `sens-api-gateway/release/edge-release.toml` (`crate_required_features`)
- **Kanıt (ayrıntı):**
  - `cargo check --no-default-features --features <a boards.json set>` fails with 16 errors at the lines above: HealthState, which the MQTT client, the outbound publisher, io_poll and the scripting engine take at init, is compiled only with `health`.
  - Contract v1's `cargo_feature` vocabulary (common.schema.json) has no `health`, and edge-release.schema.json defines `cargo_features` as the exact cargo feature set of the build. The release therefore builds each Suderra OS row with the board's features plus `crate_required_features = ["health"]` (edge-release.toml) and signs a statement that lists only the board's features. The provenance (`features=...health...`) and the statement disagree.
- **Kök neden:** The health HTTP server's feature also gates the observability state other modules depend on, against sens-api-gateway/CLAUDE.md (keep the build compile-clean when a feature is disabled).
- **Mimari düzeltme yönü:** Compile HealthState and its producers unconditionally and gate only the axum health server on `health`, then empty `crate_required_features`. Alternatively, add `health` to contract v1's cargo_feature vocabulary and to every boards.json entry in a reviewed contract version. Until one lands, every P0 Suderra OS release statement misstates its build's feature set.
- **Doğrulama:** `edge_release.py plan` refuses a non-empty `crate_required_features` without `crate_required_features_tracked_by` (tests/invariants/edge-release-pipeline.spec.ts). Closure test: ci-edge.yml profile-test passes with exactly the boards.json sets and `crate_required_features = []`.

<a id="INFRA-MEDIUM-253"></a>

### INFRA-MEDIUM-253 — The release checks a binary's NEEDED libraries and glibc symbol versions against hand-maintained release facts, not against a sysroot manifest the Suderra OS image publishes

- **Önem:** MEDIUM · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** scripts/edge/edge_release.py ELF check / contracts/suderra-edge boards.json
- **Köken:** yayın hattı incelemesi (2026-10-20)
- **Kanıt (dosya:satır):** `sens-api-gateway/release/edge-release.toml` (`[runtime.*]`, `max_glibc`), `scripts/edge/edge_release.py` (`check_binary`)
- **Kanıt (ayrıntı):**
  - ADR-048 DEC-8.5 checks a release binary's ELF NEEDED against the OS sysroot. Contract v1 records no runtime per board, so the agent keeps a copy: allowed sonames per arch, and the newest GLIBC_x.y symbol version per channel (2.41 for Suderra OS, from Suderra-OS Buildroot 2025.05.3 glibc 2.41; 2.23 for the generic channel's cross images).
  - A Buildroot glibc downgrade or a package removed on the OS side is not seen by the release; a binary that passes the release could still fail to load on a device.
- **Kök neden:** The board contract describes what the agent needs from the OS (kernel config) but not what the OS image provides to a dynamically linked agent.
- **Mimari düzeltme yönü:** Suderra-OS publishes, per board image, the provided sonames and glibc version (a contract v2 boards.json field, or an OS-side runtime manifest at the vendored contract digest). edge_release.py checks NEEDED and VERNEED against it instead of edge-release.toml.
- **Doğrulama:** A spec case where the OS-published glibc is lower than the binary's needed version fails the plan; the edge-release.toml runtime copy is gone.

<a id="INFRA-MEDIUM-257"></a>

### INFRA-MEDIUM-257 — No tool signs the production trust-anchors bundle with the offline fleet-root key: the only producer is the dev/CI generator, which signs with a file key, so the first production bundle and every later bundle change has no ceremony-grade path

- **Önem:** MEDIUM · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** Suderra-OS scripts/ci/edge-dev-keys.py / sensor-service trust-anchor bundle / key ceremony
- **Köken:** anahtar seremonisi araçları (RL paketi, 2026-10-23)
- **Kanıt (dosya:satır):** `Suderra-OS/scripts/ci/edge-dev-keys.py:183`, `apps/sensor-service/src/edge-device/suderra-edge.config.ts:38`, `apps/sensor-service/src/edge-device/trust-anchor-bundle.service.ts:1`
- **Kanıt (ayrıntı):**
  - The release statements have an offline production path (`scripts/edge/edge_release.py` `offline-request` / `offline-assemble`): the PAE goes to the HSM, the raw signature comes back, `verify_strict` runs before anything is written.
  - The `suderra.trust-anchors.v1` bundle, which `SUDERRA_EDGE_TRUST_ANCHORS` carries and the trust-anchors update request delivers (DEC-3.7), has only the dev/CI producer `edge-dev-keys.py`, which signs with a PKCS#8 file key (`sign_bundle`). The key ceremony's fleet-root key is non-exportable in the HSM, so no procedure can build and sign the first production bundle with it.
- **Kök neden:** The offline signing discipline was built for the first fleet-root artifact (the release statement is edge-release's) and not for the second, so the ceremony checklist names a step no tool performs.
- **Mimari düzeltme yönü:** Build the bundle payload from the key inventory (the bundle-anchored keys, the public MQTT CA roots, tenant scope, a monotonic `bundle_seq`) with a producer that writes the unsigned payload and its PAE; the HSM signs the PAE; assemble the DSSE envelope and verify it with the installer's own verifier before it reaches `SUDERRA_EDGE_TRUST_ANCHORS` or the update request.
- **Doğrulama:** A contract test runs the flow with a throwaway key (as the release flow's rehearsal does), refuses a TEST-ONLY key, a bundle whose anchors differ from the inventory and a `bundle_seq` that does not increase.

## Bulut hattı incelemesi bulguları (2026-10-20)

ADR-048 P0 bulut hattının (cloud track) bağımsız incelemesinde kaydedildi.

<a id="EDGE-MEDIUM-130"></a>

### EDGE-MEDIUM-130 — The suderra-os agent profile still builds tenant-token self-registration, which ADR-048 DEC-5.12 closes for Suderra OS, and the cloud cannot tell an agent's profile when it self-registers

- **Önem:** MEDIUM · **Faz:** P0 · **Son tarih:** 2026-11-02 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway self-registration (suderra-os profile) / sensor-service POST api/devices/self-register
- **Köken:** bulut hattı incelemesi (2026-10-20)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/config.rs:172`, `sens-api-gateway/src/main.rs:5136`, `sens-api-gateway/src/provisioning.rs:401`, `apps/sensor-service/src/edge-device/provisioning.controller.ts:470`, `apps/sensor-service/src/edge-device/provisioning.service.ts:867`
- **Kanıt (ayrıntı):**
  - Every agent profile compiles AgentConfig.tenant_token, the startup self-registration branch and its /api/devices/self-register client. A Suderra OS agent given a tenant token therefore registers itself outside the signed manifest chain: no device binding, no signed site config, no activation receipt.
  - The self-register request names no agent profile, so the cloud cannot refuse it by channel. What the cloud does enforce is structural: a self-registered device holds no provisioning token, so it can never reserve a Suderra OS manifest, and it stays on the generic channel.
- **Kök neden:** The profile split of DEC-1/DEC-28 left the tenant-token path in the shared code instead of compiling it out of the suderra-os feature.
- **Mimari düzeltme yönü:** Compile tenant_token, self-registration and its client out of the suderra-os feature, and pin that with a sens-api-gateway invariant that the suderra-os build has no tenant_token field. Optionally, a contract v2 request field naming the agent profile would let the cloud refuse a suderra-os self-registration as well.
- **Doğrulama:** `cargo check --features suderra-os` fails to compile a reference to tenant_token. The invariant test fails if the self-register client is reachable in the suderra-os build.

## ADR-048 kalıntı riskleri

ADR-048 tarafından bilerek sonraki bir faza bırakılan riskler. Her biri ADR-048'deki 'Takip edilen kalıntı riskler' tablosundaki R-NN satırına karşılık gelir.

<a id="EDGE-MEDIUM-116"></a>

### EDGE-MEDIUM-116 — Agent binary on /data is verified only before start; no kernel-enforced integrity until releases ship as signed verity images with DM_VERITY_VERIFY_ROOTHASH_SIG/IPE enforcement

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Köken:** ADR-048 kalıntı riski R-01
- **Kanıt (dosya:satır):** `docs/adr/048-suderra-os-edge-agent-integration-contract.md:1`
- **Mimari düzeltme yönü:** Ship each agent release as a signed read-only verity image; enforce the root-hash signature in the kernel keyring (DM_VERITY_VERIFY_ROOTHASH_SIG) or IPE; keep ExecStartPre=+verify-current until then.

<a id="EDGE-MEDIUM-117"></a>

### EDGE-MEDIUM-117 — Root update worker cannot verify operator approvals until the edge-update.v2 statement carries them (P1 approval check is cloud-side only)

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Köken:** ADR-048 kalıntı riski R-02
- **Kanıt (dosya:satır):** `docs/adr/048-suderra-os-edge-agent-integration-contract.md:1`
- **Mimari düzeltme yönü:** edge-update.v2 carries per-operator co-signatures verified by the root worker against the trust-anchor bundle.

<a id="EDGE-MEDIUM-118"></a>

### EDGE-MEDIUM-118 — No in-place USB/LAN agent or site-config update path for air-gapped sites; updates require re-provisioning

- **Önem:** MEDIUM · **Faz:** P3 · **Son tarih:** 2027-03-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Köken:** ADR-048 kalıntı riski R-03
- **Kanıt (dosya:satır):** `docs/adr/048-suderra-os-edge-agent-integration-contract.md:1`
- **Mimari düzeltme yönü:** Signed USB update bundle ingress through the same root verifier, device-bound, with update_seq.

<a id="EDGE-HIGH-119"></a>

### EDGE-HIGH-119 — Online provisioning, device-lifecycle and command signing keys live outside KMS (service env secrets) until the KMS/OIDC signer lands; pilots run with this risk

- **Önem:** HIGH · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Köken:** ADR-048 kalıntı riski R-04
- **Kanıt (dosya:satır):** `apps/sensor-service/src/edge-device/command-envelope-signer.service.ts:171`
- **Mimari düzeltme yönü:** Move all online signing keys into an Ed25519-capable KMS bound to one signer identity with per-signature audit, rate limits and tenant scoping.

<a id="EDGE-MEDIUM-120"></a>

### EDGE-MEDIUM-120 — TPM-less RPi4/CM4: rollback floor, epoch ratchet and agent keys are protected only by /data; SL2 cannot be claimed (operator decision Soru 3)

- **Önem:** MEDIUM · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Köken:** ADR-048 kalıntı riski R-05
- **Kanıt (dosya:satır):** `docs/adr/048-suderra-os-edge-agent-integration-contract.md:1`
- **Mimari düzeltme yönü:** Require an add-on TPM plus OTP secure boot for RPi4/CM4 production sites, or restrict them to non-critical sites by policy enforced in the cloud.

<a id="EDGE-MEDIUM-121"></a>

### EDGE-MEDIUM-121 — Single platform-authenticated command actor; no per-operator keys and no two-person integrity until P2 (TPI-class commands are rejected meanwhile)

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Köken:** ADR-048 kalıntı riski R-06
- **Kanıt (dosya:satır):** `sens-api-gateway/src/authz/permission.rs:584-598`
- **Mimari düzeltme yönü:** Per-operator keys in the RBAC manifest and co-signed TPI envelopes produced by the cloud.

<a id="EDGE-MEDIUM-122"></a>

### EDGE-MEDIUM-122 — Command envelope v3 binds to tenant, not device: a captured envelope can be replayed to another device of the same tenant within the 300 s window

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Köken:** ADR-048 kalıntı riski R-07
- **Kanıt (dosya:satır):** `sens-api-gateway/src/command_envelope/envelope.rs:390-415`
- **Mimari düzeltme yönü:** Envelope v4 binds device_id (and device key hash) into the signed bytes; agent rejects envelopes for another device.

<a id="EDGE-MEDIUM-123"></a>

### EDGE-MEDIUM-123 — P0 MQTT CA set includes the public ISRG roots (broker uses Let's Encrypt); a private broker PKI replaces them in P2

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Köken:** ADR-048 kalıntı riski R-08
- **Kanıt (dosya:satır):** `infrastructure/nginx/droplet.conf:34-40`
- **Mimari düzeltme yönü:** Private broker/device PKI; trust-anchor bundle ships current+next private roots; public roots removed from the suderra-os profile.

<a id="EDGE-MEDIUM-124"></a>

### EDGE-MEDIUM-124 — Physically wiping /data reopens provisioning mode until a write-once TPM NV 'provisioned' bit gates re-entry

- **Önem:** MEDIUM · **Faz:** P3 · **Son tarih:** 2027-03-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Köken:** ADR-048 kalıntı riski R-09
- **Kanıt (dosya:satır):** `docs/adr/048-suderra-os-edge-agent-integration-contract.md:1`
- **Mimari düzeltme yönü:** TPM NV write-once provisioned index checked by the lifecycle service; re-entry needs a signed device-lifecycle statement plus physical presence.

<a id="EDGE-LOW-125"></a>

### EDGE-LOW-125 — Production images carry a conditionally started SSH daemon for provisioning until claim-code provisioning becomes the default

- **Önem:** LOW · **Faz:** P3 · **Son tarih:** 2027-03-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Köken:** ADR-048 kalıntı riski R-10
- **Kanıt (dosya:satır):** `docs/adr/048-suderra-os-edge-agent-integration-contract.md:1`
- **Mimari düzeltme yönü:** Claim-code (outbound-only) provisioning as default; SSH daemon removed from prod images.

<a id="EDGE-MEDIUM-126"></a>

### EDGE-MEDIUM-126 — Activation has no proof-of-possession of a device key in P0-P2; binding relies on the provisioning token and the device-binding hash in the manifest

- **Önem:** MEDIUM · **Faz:** P3 · **Son tarih:** 2027-03-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Köken:** ADR-048 kalıntı riski R-12
- **Kanıt (dosya:satır):** `sens-api-gateway/src/provisioning.rs:324`
- **Mimari düzeltme yönü:** Activation signed by a device-generated key (TPM-resident where available) and CSR-based device certificate issuance.

<a id="EDGE-LOW-127"></a>

### EDGE-LOW-127 — Short-lived device certificates: a site offline longer than the certificate lifetime loses its cloud connection until PoP re-certification, and needs a site visit if PoP fails

- **Önem:** LOW · **Faz:** P3 · **Son tarih:** 2027-03-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Köken:** ADR-048 kalıntı riski R-13
- **Kanıt (dosya:satır):** `docs/adr/048-suderra-os-edge-agent-integration-contract.md:1`
- **Mimari düzeltme yönü:** Renewal window well before expiry, offline-tolerant grace with local-only operation, and a signed USB re-certification path.

## P0 sırasında kaydedilen yan bulgular

ADR-048 P0 uygulaması ve doğrulaması sırasında kodun okunmasıyla bulunan ve bağımsız olarak doğrulanan yan bulgular. Hiçbiri P0 kapsamında kapatılmadı; önemine göre P1 (CRITICAL/HIGH ve yayın engelleyenler) veya P2'ye yazıldı. Suderra OS reposuna düşen on yan bulgu `Okan-wqm/Suderra-OS` reposunda `docs/assessments/2026-10-19-edge-agent-integration-audit.md` içinde EI-078..EI-087 kimlikleriyle tutulur.

<a id="EDGE-HIGH-131"></a>

### EDGE-HIGH-131 — Safe-state writes pass through the per-device Modbus write limiter (burst 4, 2 ops/s), so a device with more than four outputs cannot be driven fully safe at boot or shutdown

- **Önem:** HIGH · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway Modbus write path and safe-state registry (modbus.rs, safe_state.rs, resilience/rate_limiter.rs)
- **Köken:** yan bulgu (P0 sırasında kaydedildi, I-safe-state-shares-modbus-write-limiter)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/modbus.rs:555`, `sens-api-gateway/src/modbus.rs:694`, `sens-api-gateway/src/modbus.rs:1195`, `sens-api-gateway/src/modbus.rs:1294`, `sens-api-gateway/src/modbus.rs:408`, `sens-api-gateway/src/safe_state.rs:238`, `sens-api-gateway/src/safe_state.rs:330`, `sens-api-gateway/src/resilience/rate_limiter.rs:175`
- **Kök neden:** write_coil_safe_state/write_register_safe_state only skip the degraded gate; they send the same ModbusCommand::WriteCoil/WriteRegister as an operator write, and the actor calls device.write_coil/write_register, which run validate_write_allowed, validate_write_address, validate_function_code and acquire_write_rate_limit. That limiter is a non-blocking token bucket created with capacity 4 and 2 tokens/s (modbus.rs:555-559, security.enabled defaults to true). SafeStateManager::apply loops over the outputs sequentially, so on a relay board with 8 coils outputs 1-4 are written and outputs 5-8 fail at once with 'Write rate limit exceeded'. At boot the agent goes degraded; at graceful shutdown outputs 5-8 keep their last state, which can be ON. The P0 incidental reports quoted 10 ops/s burst 20, which is the read limiter; the write limiter is stricter. AG2 and the agent review both left this open. Safe-state is a life-safety path that must not be throttled by a runaway-script guard.
- **Mimari düzeltme yönü:** Tier 1: give the SafeStateWrite capability its own write path that bypasses rate limiting, the function-code whitelist and the address policy (the output set is already derived from the config, so it needs no per-write authorization), e.g. a separate ModbusCommand variant handled without acquire_write_rate_limit. Add a unit test with a device of 12 outputs asserting all 12 safe-state writes succeed, and an invariant that no safe-state call chain reaches acquire_write_rate_limit.

<a id="EDGE-HIGH-132"></a>

### EDGE-HIGH-132 — On the generic profile the cached license is never loaded after a restart: init_license_cache reads AppState.tenant_id, which is still None at that point, so the device runs on Starter limits and I/O polling is refused above 16 channels

- **Önem:** HIGH · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway license cache init (main.rs, license.rs), generic profile
- **Köken:** yan bulgu (P0 sırasında kaydedildi, I-license-cache-not-loaded-after-restart-generic)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/main.rs:2596`, `sens-api-gateway/src/main.rs:4090`, `sens-api-gateway/src/main.rs:1000`, `sens-api-gateway/src/main.rs:5247`, `sens-api-gateway/src/main.rs:5509`, `sens-api-gateway/src/license.rs:177`
- **Kök neden:** AppState.tenant_id starts as None (main.rs:1000). On the generic profile it is set only by activation (main.rs:5024) or by the 'Device already activated' branch (main.rs:5247), both later in main than init_license_cache (main.rs:4090). init_license_cache resolves the tenant from self.tenant_id alone (main.rs:2596-2612) and on None returns leaving EdgeLicenseLimits::conservative() (Starter: 16 I/O channels, 8 FB instances, 0 forces, OPC UA server off, 5 s scan floor). The EDGE-HIGH-059 fix gave init_rbac_manifest_store the 'or config.tenant_id' fallback but not the license loader, whose own doc comment says 'tenant_id available via config'. After any restart or power loss a licensed device is back on Starter limits until a refresh_license command arrives, and the I/O budget gate (main.rs:5509) then puts a device configured with more than 16 channels into degraded mode with io_poll not started. It needs a cached license manifest and a configured firmware signing key, so it hits exactly the devices that use the license feature. The suderra-os profile is not affected (install_site sets tenant_id at main.rs:3680, before the license init).
- **Mimari düzeltme yönü:** Tier 1: resolve the bound tenant in one place (a single AppState::bound_tenant() that returns state.tenant_id or the activated config tenant) and make RBAC, license and the watch publisher use it, so no loader can read a half-initialised field. Add a boot test: activated generic config + cached signed license manifest -> license tier is restored after restart.

<a id="EDGE-HIGH-133"></a>

### EDGE-HIGH-133 — The offline queue is never used with the default config: the outbound publisher needs HealthState, which exists only when the health server is enabled (default off), so publishes go direct and are lost during a broker outage

- **Önem:** HIGH · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway outbound publisher / offline queue / HealthState construction (main.rs, publish_helpers.rs, config.rs)
- **Köken:** yan bulgu (P0 sırasında kaydedildi, I-outbound-publisher-needs-health-server)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/main.rs:1281`, `sens-api-gateway/src/main.rs:1295`, `sens-api-gateway/src/main.rs:2011`, `sens-api-gateway/src/main.rs:5312`, `sens-api-gateway/src/config.rs:627`, `sens-api-gateway/src/config.rs:671`, `sens-api-gateway/src/publish_helpers.rs:131`
- **Kök neden:** The connectivity state the OutboundPublisher and DrainTask read lives in HealthState, which is constructed only inside init_health_server, and that returns early unless config.health.enabled (HealthServerConfig::default has enabled: false). init_outbound_publisher then fails with 'health_state must be initialized first' (main.rs:2011-2013) on every default-config boot; AG2 changed the call site from exit(1) to a logged error (main.rs:5312-5325) but the publisher is still never built. publish_helpers.rs falls back to publishing directly through the MQTT client. The offline queue is enabled by default precisely to avoid 'drop-on-disconnect by default' (config.rs:671-676), its SQLCipher database is opened and keyed at boot, and nothing ever enqueues into it. Telemetry and alarms published during a broker or uplink outage are therefore lost on every Suderra OS device and on every generic device that does not enable the HTTP health server; the 'Initial status published via OutboundPublisher' log line is misleading. Related to EDGE-HIGH-128 (HealthState is also compile-gated on the health feature) and EDGE-HIGH-066, but the runtime coupling is a separate defect.
- **Mimari düzeltme yönü:** Tier 1: separate the connectivity flag from the health HTTP server. Construct HealthState (or a small ConnectivityState that HealthState wraps) unconditionally at boot and gate only the axum listener on health.enabled and the feature, so init_outbound_publisher cannot fail for a missing health server. Add a boot test with the default config asserting outbound_publisher is Some and that a publish while the broker is down lands in the queue and drains on reconnect. This should land with the EDGE-HIGH-128 fix since both need HealthState compiled and built unconditionally.

<a id="EDGE-MEDIUM-134"></a>

### EDGE-MEDIUM-134 — A Modbus device with allow_writes=true but the default function-code whitelist [1,2,3,4] passes config validation and registers safe-state outputs it can never write, so every boot goes degraded

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway config validation and Modbus write policy (config.rs, modbus.rs, safe_state.rs)
- **Köken:** yan bulgu (P0 sırasında kaydedildi, I-modbus-allow-writes-without-write-fc)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/safe_state.rs:332`, `sens-api-gateway/src/config.rs:1564`, `sens-api-gateway/src/config.rs:3099`, `sens-api-gateway/src/config.rs:3713`, `sens-api-gateway/src/modbus.rs:584`, `sens-api-gateway/src/modbus.rs:1293`
- **Kök neden:** Write authority is spread over three independent settings (allow_writes, allowed_function_codes, allowed_write_ranges/allow_all_write_addresses) and only the third is cross-checked by AgentConfig::validate (config.rs:3713-3720). collect_modbus_outputs registers every coil/holding register of a device from allow_writes alone, while a write also needs FC5/FC6 in allowed_function_codes (default [1,2,3,4]) and an address inside the policy. A config with allow_writes=true and the default whitelist validates, its safe-state writes are refused by validate_function_code, and the agent enters degraded mode (control disabled) on every boot; operator writes to the device fail the same way.
- **Mimari düzeltme yönü:** Tier 1: derive the write function codes from allow_writes (allow_writes adds FC5/FC6/FC15/FC16 to the effective whitelist) or make validate() reject allow_writes=true when the whitelist lacks the write codes; derive the safe-state output set from the same effective write policy so a registered output is by construction writable. Add validation tests for the allow_writes/whitelist/range combinations.

<a id="EDGE-MEDIUM-135"></a>

### EDGE-MEDIUM-135 — Every refused command envelope (bad signature, RBAC denial, stale or replayed command, missing tenant binding) is dropped with a WARN: no CommandResponse reaches the cloud and no audit event records the attempt

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway MQTT command dispatch (commands/mqtt_dispatch.rs)
- **Köken:** yan bulgu (P0 sırasında kaydedildi, I-refused-command-envelopes-silent)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/commands/mqtt_dispatch.rs:207`, `sens-api-gateway/src/commands/mqtt_dispatch.rs:227`, `sens-api-gateway/src/commands/mqtt_dispatch.rs:238`, `sens-api-gateway/src/commands/mqtt_dispatch.rs:307`, `sens-api-gateway/src/commands/mqtt_dispatch.rs:318`, `sens-api-gateway/src/commands/mqtt_dispatch.rs:73`
- **Kök neden:** The dispatch loop returns Ok(()) after a warn! at each pre-dispatch refusal, before the lifecycle layer that owns CommandResponse publication and audit emission, and the code still carries the comment 'audit sink wires in Sprint 6.2'. The cloud therefore cannot settle a command the agent refused (it waits for its ack timeout; SENSOR-HIGH-210 already shows the cloud treating publish as success), and rejected signature, replay and authorization-denied attempts leave no audit record, which IEC 62443 FR-2/FR-6 expect. EDGE-LOW-107 covers the rate-limit subset of the same pattern.
- **Mimari düzeltme yönü:** Tier 2: move refusal handling into one function that every pre-dispatch refusal calls, which publishes a rejected CommandResponse with a stable reason code (never signature material) and emits a CommandRejected/AuthorizationDenied audit entry; throttle the response publish so a flood of bad envelopes cannot amplify. Add dispatch tests for each refusal asserting one response and one audit event. Extend EDGE-LOW-107's fix to the same function.

<a id="EDGE-MEDIUM-136"></a>

### EDGE-MEDIUM-136 — Command audit actions are classified by a hand-written string match, not by the catalog that declares them, so the Suderra OS hand-off commands are audited as generic CommandExecuted and the catalog's audit and bootstrap fields plus command_acceptance.rs are dead code

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway command catalog and audit emission (commands/catalog.rs, audit_emit.rs, command_acceptance.rs)
- **Köken:** yan bulgu (P0 sırasında kaydedildi, I-command-audit-taxonomy-second-table)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/commands/audit_emit.rs:43`, `sens-api-gateway/src/commands/audit_emit.rs:127`, `sens-api-gateway/src/commands/catalog.rs:157`, `sens-api-gateway/src/commands/catalog.rs:230`, `sens-api-gateway/src/commands/catalog.rs:255`, `sens-api-gateway/src/commands/catalog.rs:1110`, `sens-api-gateway/src/commands/catalog.rs:1116`, `sens-api-gateway/src/commands/mod.rs:43`, `sens-api-gateway/src/commands/command_acceptance.rs:1`
- **Kök neden:** Two taxonomies exist. CommandCatalogEntry.audit_success/audit_failure and bootstrap_allowed, with is_bootstrap_allowed_command, audit_action_for_command, handler_name_for_command, is_mutating_command and MUTATING_WIRE_NAMES, are read only by tests; the runtime classifies through audit_emit::action_for_command, a separate match on string literals that falls to CommandExecuted. The catalog declares activation_receipt -> TenantProvisioned and request_update -> FirmwareDeployRequested, but audit_emit has no arm for activation_receipt, lifecycle_request or request_update, so those root hand-off events land in the catch-all and are indistinguishable from any other command in audit queries. src/commands/command_acceptance.rs (330 lines, decode_command and its rejection enums) is declared as a module and never called. Same family as EDGE-LOW-105 (superseded command lists never deleted).
- **Mimari düzeltme yönü:** Tier 1: make the catalog the only source: audit_emit reads entry.audit_success/audit_failure (with the outcome-dependent exceptions expressed as catalog data) and the second match is deleted; delete command_acceptance.rs and the unused catalog helpers, or wire them. Add an invariant that every catalog command's emitted audit action equals its declared one, and that exactly one mutating/audit command table exists.

<a id="EDGE-MEDIUM-137"></a>

### EDGE-MEDIUM-137 — Eighteen files under sens-api-gateway/tests/invariants (about 110 tests) assert on a string literal they define themselves, and some store tests silently skip when the store cannot open, so the security invariants they name are not tested

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway tests/invariants and authz manifest_version_store tests
- **Köken:** yan bulgu (P0 sırasında kaydedildi, I-vacuous-invariant-tests)
- **Kanıt (dosya:satır):** `sens-api-gateway/tests/invariants/config_coherence.rs:34`, `sens-api-gateway/tests/invariants/rbac_hot_reload.rs:28`, `sens-api-gateway/tests/invariants/audit_pipeline.rs:23`, `sens-api-gateway/tests/invariants/two_person_integrity_gate.rs:1`, `sens-api-gateway/tests/invariants/signature_mode.rs:1`, `sens-api-gateway/tests/invariants/mtls_config.rs:1`, `sens-api-gateway/src/authz/manifest_version_store.rs:387`, `sens-api-gateway/src/authz/manifest_version_store.rs:430`
- **Kök neden:** The 'contract-anchor' style (let _contract = "..."; assert!(!_contract.is_empty())) was adopted because the crate had no lib target for integration tests; 18 of 57 invariant files use it (109 literal assertions, e.g. all 15 in config_coherence.rs, all 8 in rbac_hot_reload.rs, 15 in audit_pipeline.rs), covering mTLS strictness, signature mode, two-person integrity, RBAC hot reload, dedup, rate limiting and config coherence. They pass whatever the production code does. Separately, manifest_version_store.rs tests use try_open, which prints 'Skipping test' and returns when the SQLCipher store cannot open, so the persistent-floor tests can pass with zero coverage. EDGE-MEDIUM-102 covers invariant files that do not exist; this is the opposite failure, files that exist and prove nothing.
- **Mimari düzeltme yönü:** Tier 3 with a Tier 1 backstop: expose the crate's logic through a lib target (or move each check into a unit test next to the code) and replace each literal with a call that fails when the rule is broken; add a lint or invariant that rejects a test whose only assertion is on a local string or constant. Replace try_open's silent skip with ensure_key_sandbox plus expect, as the new tests already do.

<a id="EDGE-MEDIUM-138"></a>

### EDGE-MEDIUM-138 — write_atomic_json/bytes uses one temp file name per process (.name.tmp-<pid>), so two concurrent writers of the same target can rename a half-written file into place

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway shared_io atomic JSON sidecar writer
- **Köken:** yan bulgu (P0 sırasında kaydedildi, I-atomic-sidecar-shared-temp-name)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/shared_io/atomic_json_sidecar.rs:244`, `sens-api-gateway/src/shared_io/atomic_json_sidecar.rs:251`, `sens-api-gateway/src/shared_io/atomic_json_sidecar.rs:255`, `sens-api-gateway/src/shared_io/atomic_json_sidecar.rs:283`, `sens-api-gateway/src/commands/root_handoff.rs:151`, `sens-api-gateway/src/authz/manifest_runtime.rs:551`
- **Kök neden:** The temp path depends only on the target name and the pid, the helper removes any existing temp file and reopens it with create+truncate. Writer B can unlink writer A's temp file while A still writes to the open inode, then create a fresh temp; A's fsync succeeds and A renames B's partially written file onto the target. This is the same race the AG1 package fixed in db_secret (which uses a unique name plus hard_link). Callers are the primitive for security state: the RBAC manifest and floor, the activation document, site trust, the DB migration manifest and the root hand-off statements (named by digest, which the cloud re-delivers on each online transition).
- **Mimari düzeltme yönü:** Tier 1: make the collision impossible by creating the temp file with O_EXCL under a unique name (pid plus a per-process counter plus random suffix, as TrybootBootloaderHandle already does) and cleaning stale temp files by prefix at start; add a test with N concurrent writers of one target asserting the final file always parses.

<a id="EDGE-LOW-139"></a>

### EDGE-LOW-139 — SPI and PWM drivers (about 1,370 lines) and the I2C/tag 'simulated' quality are compiled but unreachable: no config, no handle, no safe-state, no dispatch

- **Önem:** LOW · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway SPI / PWM / I2C drivers and tag quality (spi.rs, pwm.rs, i2c.rs, io_poll.rs)
- **Köken:** yan bulgu (P0 sırasında kaydedildi, I-dead-hardware-io-code)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/main.rs:105`, `sens-api-gateway/src/main.rs:249`, `sens-api-gateway/src/spi.rs:206`, `sens-api-gateway/src/pwm.rs:1`, `sens-api-gateway/src/i2c.rs:100`, `sens-api-gateway/src/io_poll.rs:293`
- **Kök neden:** mod spi and mod pwm are declared in main.rs and referenced nowhere else; AgentConfig has no SPI or PWM section, nothing creates an SpiHandle or PWM channel, and neither is part of safe-state registration, so a PWM-driven actuator can be neither configured nor driven safe and the code reads as supported hardware. After AG2 removed the simulated I2C results, I2cReadResult.simulated is always false and the TagQuality::Simulated branches in io_poll.rs (and atlas_ezo.rs:63) are dead.
- **Mimari düzeltme yönü:** Either wire SPI and PWM end to end (config, handle, safe-state registration, dispatch) as part of the RevPi/GPIO package, or delete the modules and the simulated flag so the feature surface matches what runs; add an unused-module check (dead_code deny on these modules) so it cannot recur.

<a id="EDGE-LOW-140"></a>

### EDGE-LOW-140 — Agent hygiene: the --audit-verify doc and clippy allows sit on the wrong function, run_audit_verify lacks its print allows, compute_hmac uses expect(), and remote-commands.md describes a pre-signing dispatcher

- **Önem:** LOW · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sens-api-gateway main.rs audit-verify, lifecycle_auth.rs, docs/api/remote-commands.md
- **Köken:** yan bulgu (P0 sırasında kaydedildi, I-agent-doc-and-lint-hygiene)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/main.rs:4236`, `sens-api-gateway/src/main.rs:4251`, `sens-api-gateway/src/main.rs:4299`, `sens-api-gateway/src/main.rs:4584`, `sens-api-gateway/src/lifecycle_auth.rs:402`, `sens-api-gateway/docs/api/remote-commands.md:4`, `sens-api-gateway/docs/api/remote-commands.md:16`
- **Kök neden:** When --confirm-active moved, the doc block and #[allow(clippy::print_stdout/print_stderr)] for run_audit_verify stayed above run_migrate_db_subcommand_with_context while run_audit_verify (a println!/eprintln! function) has neither; the crate denies expect_used (Cargo.toml:592) yet compute_hmac has expect(), unreachable in practice but hidden only because CI passes -A clippy::expect_used (INFRA-HIGH-237). docs/api/remote-commands.md cites src/commands.rs:364-475 and :380-397, a file that no longer exists, and states that the agent does not verify the invoker, which is false since signed envelopes and RBAC enforcement.
- **Mimari düzeltme yönü:** Move the doc and attributes back to run_audit_verify; return a typed error from compute_hmac (HmacSha256::new_from_slice cannot fail for any key length, so map it to AuthError); regenerate remote-commands.md from the catalog (the doc then cannot drift) or add a doc-link check that every cited src path exists.

<a id="INFRA-MEDIUM-254"></a>

### INFRA-MEDIUM-254 — sens-api-gateway-ci.yml greps for the literal version = "2.0.0-rc.4", and the release workflow now calls that CI, so the first version bump blocks every agent release

- **Önem:** MEDIUM · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** .github/workflows/sens-api-gateway-ci.yml and edge-agent-release.yml
- **Köken:** yan bulgu (P0 sırasında kaydedildi, I-ci-pins-agent-version-literal)
- **Kanıt (dosya:satır):** `.github/workflows/sens-api-gateway-ci.yml:81`, `.github/workflows/sens-api-gateway-ci.yml:82`, `.github/workflows/edge-agent-release.yml:196`, `sens-api-gateway/Cargo.toml:3`
- **Kök neden:** A release-policy check was written as a grep for the current Cargo version instead of comparing Cargo.toml's version with the release ref. edge-agent-release.yml runs sens-api-gateway-ci.yml as a reusable workflow on the tag SHA (INFRA-HIGH-237 fix), so any tag whose Cargo version is not rc.4 fails that job; the same job also pins docs/evidence/sens-api-gateway-edge-v2.0.0-rc4.md. Loud and one line to fix, but it blocks the update channel's first real release.
- **Mimari düzeltme yönü:** Tier 1: derive the expected version from the pushed ref (agent-vX.Y.Z -> Cargo.toml package.version must equal X.Y.Z) instead of a literal, and drop the rc4 evidence-file pin or select it by the same derived version; add a workflow-contract test that fails if a CI step contains a hard-coded crate version.

<a id="INFRA-MEDIUM-255"></a>

### INFRA-MEDIUM-255 — The nine CRITICAL findings registered by this audit have no truth-table row, so derived-merge-pins and enterprise-grade-debt-plan-contract fail on every run of the registry invariants

- **Önem:** MEDIUM · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** docs/plans enterprise-grade-debt-closure truth table and registry invariants
- **Köken:** yan bulgu (P0 sırasında kaydedildi, I-truth-table-rows-missing-for-audit-criticals)
- **Kanıt (dosya:satır):** `docs/plans/2026-06-18-enterprise-grade-debt-closure/finding-truth-table.md:1`, `tests/invariants/enterprise-grade-debt-plan-contract.spec.ts:159`, `tests/invariants/derived-merge-pins.spec.ts:196`, `docs/reviews/_registry/findings.jsonl:1`
- **Kök neden:** The registration commits (6cb0c746, 63b9f83f) appended EDGE-CRITICAL-046..049, SENSOR-CRITICAL-200..203 and INFRA-CRITICAL-236 to the registry without the one truth-table row (owner, sprint, bucket) per active CRITICAL that the invariant requires. Running the registry invariants on the branch tip fails 3 tests: 'keeps exactly one truth-table row per active CRITICAL' and two derived-merge-pins cases report missingRows with those nine ids. The invariants run in invariants:fast, so every PR stays red until the rows exist. (The finding-id-aliases spec also fails in this checkout, but only because the checkout is shallow and the 37 alias commits are not present; that is not a repository defect.)
- **Mimari düzeltme yönü:** Add the nine rows to finding-truth-table.md. Tier 2: make the registration tool emit the truth-table row (owner, sprint, bucket) in the same commit as any new CRITICAL, so registration cannot leave the invariant red.

<a id="INFRA-MEDIUM-256"></a>

### INFRA-MEDIUM-256 — e2e/.github/workflows/e2e-tests.yml is a nested workflow GitHub never runs, and it is the only caller of the e2e security, workflow and integration suites

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** e2e/.github/workflows (nested workflow) and the e2e Nx project
- **Köken:** yan bulgu (P0 sırasında kaydedildi, I-e2e-nested-workflow-orphan)
- **Kanıt (dosya:satır):** `e2e/.github/workflows/e2e-tests.yml:1`, `e2e/project.json:6`, `e2e/package.json:8`, `e2e/package.json:12`
- **Kök neden:** GitHub reads workflows only from the root .github/workflows. The root e2e-tests.yml was deleted when E2E moved off the production host (ARIA-HIGH-334), leaving this copy; the e2e Nx project declares only a lint target, and the root workflows run only the water-chemistry e2e and the schema invariants. The Playwright security project (csrf, rbac-escalation, tenant-isolation, token-lifecycle, header-spoofing, rate-limiting, graphql-limits) and the jest workflow/integration suites therefore have no CI caller; they can rot or regress silently. Same pattern as the nested sens-api-gateway workflows removed under INFRA-HIGH-237 and as SENSOR-HIGH-070 for the sensor device-flow suites.
- **Mimari düzeltme yönü:** Move the security and workflow suites into a root workflow (or Nx test targets reached from ci-affected) that runs against an ephemeral stack, and delete e2e/.github. Tier 3: extend the test-target-ci-reachability invariant to flag any .github/workflows directory below the repository root.

<a id="SENSOR-MEDIUM-236"></a>

### SENSOR-MEDIUM-236 — Re-provisioning replaces the device's live MQTT password hash at activation, before the commit, so a reinstall that never connects strands the device

- **Önem:** MEDIUM · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sensor-service edge-device provisioning-reservation.service.ts
- **Köken:** yan bulgu (P0 sırasında kaydedildi, I-reprovision-replaces-live-broker-credential)
- **Kanıt (dosya:satır):** `apps/sensor-service/src/edge-device/provisioning-reservation.service.ts:268`, `apps/sensor-service/src/edge-device/provisioning-reservation.service.ts:279`, `apps/sensor-service/src/edge-device/provisioning-reservation.service.ts:319`, `apps/sensor-service/src/edge-device/provisioning-reservation.service.ts:38`
- **Kök neden:** The state-machine comment says the committed activation record, 'the live broker credential' included, is kept until the new commit replaces it, but issueCredentials writes mqttPasswordHash, credentialsIssuedAt and lifecycleState straight onto the device row at ACTIVATION_PENDING while commitFirstSession only clears token fields. There is one credential slot, so the old credential is invalid the moment the new one is issued; if the reinstall fails, is rolled back or the device never reaches the broker, the previously working agent can no longer authenticate and the device stays offline until it is re-provisioned again.
- **Mimari düzeltme yönü:** Tier 1: add a second credential slot (pending_mqtt_password_hash and issued_at) that issueCredentials fills and commitFirstSession promotes, with the broker authenticator accepting the live hash and, until commit or expiry, the pending one; ship it as a generated migration (nullable column, no destructive change) and add a test: activate during re-provisioning, never connect, old credential still authenticates.

<a id="SENSOR-LOW-237"></a>

### SENSOR-LOW-237 — Self-register power-loss recovery reads a device outside a transaction and then saves the whole stale entity, overwriting concurrent changes (revocation, lifecycle, token) with the snapshot

- **Önem:** LOW · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sensor-service edge-device provisioning.service.ts (self-register recovery)
- **Köken:** yan bulgu (P0 sırasında kaydedildi, I-self-register-recovery-stale-entity-save)
- **Kanıt (dosya:satır):** `apps/sensor-service/src/edge-device/provisioning.service.ts:878`, `apps/sensor-service/src/edge-device/provisioning.service.ts:905`, `apps/sensor-service/src/edge-device/provisioning.service.ts:910`
- **Kök neden:** The existing device is loaded in runInTenantRead and, after bcrypt hashing, persisted with qr.manager.save(existing) in a separate transaction. save() writes every column of the snapshot, so a revoke, decommission or token change committed in between is reverted, and the recovery path never re-checks the lifecycle state. Related to SENSOR-MEDIUM-227 (the recovery path's identity weakness), but a distinct lost-update defect.
- **Mimari düzeltme yönü:** Tier 1: replace the whole-entity save with one conditional UPDATE of mqtt_password_hash that carries the guard (lifecycle_state not terminal, last_seen_at IS NULL, created_at within the window) inside the transaction and returns the affected row, like the other provisioning transitions.

<a id="SENSOR-LOW-238"></a>

### SENSOR-LOW-238 — The provisioning controller validates device codes with four copies of ^[A-Z]{2,5}-[0-9A-F]{8}$, narrower than the contract's ^[A-Za-z0-9_-]{1,50}$

- **Önem:** LOW · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sensor-service edge-device provisioning.controller.ts and contract common.schema.json
- **Köken:** yan bulgu (P0 sırasında kaydedildi, I-device-code-regex-copies-narrower-than-contract)
- **Kanıt (dosya:satır):** `apps/sensor-service/src/edge-device/provisioning.controller.ts:81`, `apps/sensor-service/src/edge-device/provisioning.controller.ts:215`, `apps/sensor-service/src/edge-device/provisioning.controller.ts:262`, `apps/sensor-service/src/edge-device/provisioning.controller.ts:356`, `contracts/suderra-edge/v1/schemas/common.schema.json:64`
- **Kök neden:** The format is pasted into four handlers instead of one shared constant derived from the device-code generator and the contract. It matches codes the cloud mints today, but the status, install, uninstall and update routes answer 400 for any other code the contract admits (for example the EDGE-REVPI-0001 style used in contract fixtures), so contract and cloud can drift without any test failing.
- **Mimari düzeltme yönü:** Tier 1: one exported DEVICE_CODE_PATTERN used by the generator, the controller and the DTO validation, with a contract-conformance test that the generator's output and the contract fixtures all pass it.

<a id="SENSOR-LOW-239"></a>

### SENSOR-LOW-239 — Banned type escapes remain in the edge provisioning and MQTT adapter code, and edge-device.service.ts and automation.service.ts fail the repo's Prettier gate

- **Önem:** LOW · **Faz:** P2 · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** sensor-service edge-device, automation and MQTT adapter code
- **Köken:** yan bulgu (P0 sırasında kaydedildi, I-sensor-edge-type-escapes-prettier)
- **Kanıt (dosya:satır):** `apps/sensor-service/src/protocol/adapters/iot/mqtt.adapter.ts:150`, `apps/sensor-service/src/edge-device/provisioning.service.ts:218`, `apps/sensor-service/src/edge-device/provisioning.service.ts:219`, `apps/sensor-service/src/edge-device/edge-provisioning-manifest.service.ts:111`, `apps/sensor-service/src/edge-device/edge-provisioning-manifest.service.ts:113`, `apps/sensor-service/src/edge-device/edge-device.service.ts:1`, `apps/sensor-service/src/automation/automation.service.ts:1`
- **Kök neden:** CLAUDE.md bans 'as unknown as X', 'as any' and defensive '?.'. mqtt.adapter.ts casts mqtt.connect() through unknown to MqttClientInstance; createProvisionedDevice catches 'error: any' and reads error?.code; the manifest parser asserts 'method as BindingMethod' and 'board as BoardProfile' after a runtime check instead of using a type guard. 'prettier --check' reports both edge-device.service.ts and automation.service.ts as unformatted, so any PR that touches them fails the format gate.
- **Mimari düzeltme yönü:** Tier 1: use type guards (isBindingMethod, isBoardProfile) that narrow without casts; catch unknown and narrow to a QueryFailedError-style guard for the 23505 code; type the mqtt client through the library's own MqttClient type; run prettier --write on the two files and add the escape patterns to the existing lint ban so they fail CI.

<a id="EDGE-MEDIUM-141"></a>

### EDGE-MEDIUM-141 — The activation request carries no deviceBinding or installedManifest, and the cloud checks no binding, although the contract requires both: a request built to the contract is refused with 400 by the DTO whitelist

- **Önem:** MEDIUM · **Faz:** P1 · **Son tarih:** 2026-11-30 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Bileşen:** edge agent activation request and sensor-service activation endpoint (provisioning.rs, provisioning.dto.ts, provisioning.service.ts)
- **Köken:** sözleşme 1.1.0 incelemesi (CT1 review, activation binding)
- **Kanıt (dosya:satır):** `sens-api-gateway/src/provisioning.rs:87`, `apps/sensor-service/src/edge-device/dto/provisioning.dto.ts:167`, `apps/sensor-service/src/edge-device/provisioning.service.ts:440`, `contracts/suderra-edge/v1/channels.json:44`, `contracts/suderra-edge/v1/schemas/edge-activation-request.schema.json:1`
- **Kök neden:** contract 1.2.0 (channels.json activation.binding_rule, schemas/edge-activation-request.schema.json) requires the activation request to carry deviceBinding and permits installedManifest, and requires the cloud to refuse, without committing the activation, a binding that differs from the one the manifest reservation was made for. The agent's ActivationRequest sends only deviceId, token, fingerprint and agentVersion; the cloud's DeviceActivationRequest has neither member and activateDevice compares no binding, and the sensor-service ValidationPipe (whitelist, forbidNonWhitelisted) would answer a request built to the contract with 400. Without the check a token reserved for one device binding activates another's.
- **Mimari düzeltme yönü:** Tier 1: agent adds deviceBinding (from identity.json) and installedManifest to ActivationRequest; cloud adds both members to DeviceActivationRequest and activateDevice compares the binding with the reservation's and refuses a mismatch before it commits or issues credentials; a contract test posts the schema's valid and invalid fixtures to the DTO.

## P1 kararı: x86 paketi P1b'ye alındı

<a id="EDGE-MEDIUM-142"></a>

### EDGE-MEDIUM-142 — x86 industrial-PC package set (USB installer image, Windows conversion and Secure Boot ownership runbook, qualification checker, driver set, signed PCR 7+11 policy) is deliberately P1b: it starts only after the operator selects the x86 model, and SG-3 stays closed until it is done

- **Önem:** MEDIUM · **Faz:** P1b · **Son tarih:** 2026-12-31 · **Sahip:** @Okan-wqm · **Durum:** OPEN
- **Köken:** ADR-048 P1 kapsam kararı (2026-10-22), operatör yetki devriyle
- **Kanıt (dosya:satır):** `docs/adr/048-suderra-os-edge-agent-integration-contract.md:2662`
- **Kök neden:** x86 modeli seçilmedi (ADR-048 Soru 1). Sürücü kümesi, qualification kaydı ve Microsoft UEFI CA kararı model olmadan verilemez; model seçilmeden yazılan runbook ve testler tahmine dayanır.
- **Mimari düzeltme yönü:** Modelden bağımsız parçalar P1'de kalır (x86 çekirdek sürüm ve kaynak-hash sabitlemesi EI-028/EI-051, `/data` kurtarma slotu, TPM kaynak kaydı, EI-078). Model seçilince P1b paketleri ADR-048 P1 x86 maddesine göre yazılır. Seçim 2026-12-31'den sonra gelirse son tarih seçimden 30 gün sonrasına çekilir.
- **Not:** P1b bitmeden SG-3 kapalıdır: sahaya x86 birimi kurulmaz.
