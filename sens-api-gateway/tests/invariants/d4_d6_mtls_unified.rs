//! Phase 1.1.5 — D-4 / D-6 mTLS unified-assembly closure invariant.
//!
//! ## Why this file exists
//!
//! Phase 1 of the Faz 2 closure plan ships the operational wires that
//! make the rustls `SuderraServerCertVerifier` hot-reloadable without an
//! agent restart:
//!
//! - **Phase 1.1.1** (`mtls/state_handle.rs::MtlsVerifierState`) — the
//!   atomic-swap state handle wrapping `Option<Arc<SuderraServerCertVerifier>>`.
//! - **Phase 1.1.4 part A** (`mtls/state_handle.rs::MtlsDelegatingVerifier`,
//!   `mqtt.rs::configure_tls`) — the delegating verifier wrapper that
//!   queries the state handle on every handshake, plus the
//!   `MqttClient::mtls_verifier_state()` accessor that lets
//!   `cmd_update_cert_pinning` (Phase 1.1.2) drive rebuilds.
//! - **Phase 1.1.2** (commands/cert_pinning.rs, planned) — the MQTT
//!   command that ed25519-verifies + replay-guards + two-person-gates an
//!   incoming pin-rotation manifest, then calls `state.rebuild()`.
//! - **Phase 1.1.3** (cloud HTTPS reqwest wire, planned) — the HTTPS
//!   transport reusing the same state handle so cipher allowlist + leaf
//!   pinning span both transports.
//!
//! These four wires are tightly coupled: deleting any one silently
//! reduces D-4 / D-6 closure to a partial state. Pre-Phase-1.1.5 the
//! coupling was prose-only — a future refactor that "simplifies" the
//! DelegatingVerifier wrapper or removes the `mtls_verifier_state` field
//! on `MqttClient` would compile and pass higher-level tests, but
//! `cmd_update_cert_pinning` would silently lose its hot-reload effect.
//!
//! THIS FILE is the Tier-3 MAKE-IT-DETECTABLE seam. It pins the
//! source-level shape of every Phase 1 wire so a regression surfaces
//! deterministically on the same PR that introduced it.
//!
//! Pattern mirrors `tests/invariants/cipher_allowlist_fleet_compat.rs`
//! (Phase 0.4) and `tests/invariants/faz1_architectural_primitives.rs`
//! (Batch #321).

fn read_source(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| {
        panic!(
            "BUG: d4_d6_mtls_unified invariant cannot read {path} — \
             this test runs from sens-api-gateway/ working dir per cargo \
             test convention. err={e}"
        )
    })
}

/// **ULTRA-HIGH-018 / D-4 closure (Phase 1.1.1):** the `MtlsVerifierState`
/// hot-reload handle MUST exist in `mtls/state_handle.rs`. The struct is
/// the single SSoT for the active rustls verifier; deleting it breaks
/// every Phase 1 wire downstream of it (cmd_update_cert_pinning has
/// nothing to rebuild; the DelegatingVerifier has nothing to delegate to).
#[test]
fn d4_mtls_verifier_state_struct_present() {
    let src = read_source("src/mtls/state_handle.rs");
    assert!(
        src.contains("pub struct MtlsVerifierState"),
        "ULTRA-HIGH-018 / D-4 WIRE INVARIANT VIOLATED: \
         src/mtls/state_handle.rs does not define `pub struct MtlsVerifierState`. \
         The state handle is the SSoT for the active rustls verifier — without it, \
         hot-reload is impossible. Restore the struct or document the rename + \
         update this invariant."
    );
}

/// **ULTRA-HIGH-018 / D-4 closure (Phase 1.1.1):** the `rebuild` method
/// is the operator-driven mutation point. cmd_update_cert_pinning calls
/// it from the command-dispatch path; a missing/renamed method silently
/// disables the rotation flow.
#[test]
fn d4_mtls_verifier_state_rebuild_method_present() {
    let src = read_source("src/mtls/state_handle.rs");
    assert!(
        src.contains("pub fn rebuild("),
        "ULTRA-HIGH-018 / D-4 WIRE INVARIANT VIOLATED: \
         src/mtls/state_handle.rs does not expose `pub fn rebuild(...)` on \
         MtlsVerifierState. cmd_update_cert_pinning needs this method to apply \
         a new pin set without restarting the agent."
    );
}

/// **ULTRA-HIGH-020 / D-6 closure (Phase 1.1.4 part A):** the
/// `MtlsDelegatingVerifier` wrapper MUST exist. It is the bridge between
/// the state handle (which mutates) and the rustls ClientConfig (which
/// captures verifiers at boot). Without the wrapper, rebuilds have no
/// effect on live connections.
#[test]
fn d6_mtls_delegating_verifier_struct_present() {
    let src = read_source("src/mtls/state_handle.rs");
    assert!(
        src.contains("pub struct MtlsDelegatingVerifier"),
        "ULTRA-HIGH-020 / D-6 WIRE INVARIANT VIOLATED: \
         src/mtls/state_handle.rs does not define `pub struct MtlsDelegatingVerifier`. \
         The wrapper is the architectural lynchpin that makes hot-reload visible to \
         live TLS connections — its `verify_server_cert` callback re-reads \
         `state.current()` on every handshake."
    );
}

/// **ULTRA-HIGH-020 / D-6 closure (Phase 1.1.4 part A):** the wrapper
/// must impl `rustls::client::danger::ServerCertVerifier`. Anchored on
/// the `impl ServerCertVerifier for MtlsDelegatingVerifier` block.
#[test]
fn d6_mtls_delegating_verifier_implements_server_cert_verifier() {
    let src = read_source("src/mtls/state_handle.rs");
    assert!(
        src.contains("impl ServerCertVerifier for MtlsDelegatingVerifier"),
        "ULTRA-HIGH-020 / D-6 WIRE INVARIANT VIOLATED: \
         MtlsDelegatingVerifier does not implement rustls' ServerCertVerifier. \
         Without this impl the wrapper cannot be installed via \
         ClientConfig::dangerous().with_custom_certificate_verifier(...) — \
         hot-reload is structurally impossible."
    );
}

/// **ULTRA-HIGH-020 / D-6 closure (Phase 1.1.4 part A):**
/// `mqtt.rs::configure_tls` MUST construct + install the
/// `MtlsDelegatingVerifier` rather than the bare
/// `Arc<SuderraServerCertVerifier>`. A revert to the pre-Phase-1 wire
/// (which captured the verifier at boot) silently breaks hot-reload —
/// the symptom is an operator running `cmd_update_cert_pinning` and
/// seeing the rebuild return Ok but the next handshake using the OLD
/// verifier. This test catches that drift on the same PR that introduces it.
#[test]
fn d6_mqtt_configure_tls_installs_delegating_verifier() {
    let src = read_source("src/mqtt.rs");
    assert!(
        src.contains("MtlsDelegatingVerifier::new"),
        "ULTRA-HIGH-020 / D-6 WIRE INVARIANT VIOLATED: \
         src/mqtt.rs does not call MtlsDelegatingVerifier::new. The MQTT TLS path \
         must install the delegating wrapper (not a bare Arc<SuderraServerCertVerifier>) \
         so cmd_update_cert_pinning rebuilds take effect on the next handshake."
    );
    assert!(
        src.contains("with_custom_certificate_verifier(delegating_verifier)"),
        "ULTRA-HIGH-020 / D-6 WIRE INVARIANT VIOLATED: \
         src/mqtt.rs does not pass `delegating_verifier` to \
         with_custom_certificate_verifier. The wrapper must be the verifier \
         installed in the rustls ClientConfig; bypassing it (e.g., calling \
         with_custom_certificate_verifier with the inner SuderraServerCertVerifier) \
         silently disables hot-reload."
    );
}

/// **ULTRA-HIGH-018 + ULTRA-HIGH-020 closure (Phase 1.1.4 part A):**
/// `MqttClient` MUST hold the state handle so `cmd_update_cert_pinning`
/// (Phase 1.1.2) can clone it via the public accessor. A regression that
/// drops the field would force the command to reach into mqtt-internal
/// state — exactly the cross-module coupling the wire was designed to
/// avoid.
#[test]
fn d4_d6_mqtt_client_holds_state_handle() {
    let src = read_source("src/mqtt.rs");
    assert!(
        src.contains("mtls_verifier_state: Option<Arc<crate::mtls::MtlsVerifierState>>")
            || src.contains("mtls_verifier_state: Option<std::sync::Arc<crate::mtls::MtlsVerifierState>>"),
        "ULTRA-HIGH-018 + ULTRA-HIGH-020 WIRE INVARIANT VIOLATED: \
         struct MqttClient does not declare `mtls_verifier_state: Option<Arc<...MtlsVerifierState>>`. \
         The field is the public bridge between MQTT transport state and the \
         command-dispatch path that drives rotations."
    );
    assert!(
        src.contains("pub fn mtls_verifier_state(") && src.contains("Arc<crate::mtls::MtlsVerifierState>"),
        "ULTRA-HIGH-018 + ULTRA-HIGH-020 WIRE INVARIANT VIOLATED: \
         MqttClient does not expose a `pub fn mtls_verifier_state(...) -> \
         Option<&Arc<MtlsVerifierState>>` accessor. cmd_update_cert_pinning \
         needs this accessor to clone the Arc and drive rebuilds without \
         touching mqtt-internal state."
    );
}

/// **Phase 1.1.4 part A regression guard:** the configure_tls signature
/// MUST return both the `Transport` AND the `Arc<MtlsVerifierState>`.
/// Pre-Phase-1.1.4 the function returned `Result<Transport>`; reverting
/// would orphan the state handle and silently disable hot-reload.
#[test]
fn d6_configure_tls_returns_state_handle() {
    let src = read_source("src/mqtt.rs");
    assert!(
        src.contains("Result<(Transport, Arc<crate::mtls::MtlsVerifierState>)>")
            || src.contains("Result<(Transport, std::sync::Arc<crate::mtls::MtlsVerifierState>)>"),
        "ULTRA-HIGH-020 / D-6 WIRE INVARIANT VIOLATED: \
         configure_tls signature does not return Result<(Transport, Arc<MtlsVerifierState>)>. \
         The function must surface the state handle to MqttClient::new so the handle is \
         stored on the client and reachable from cmd_update_cert_pinning."
    );
}

/// **Phase 1.1.4 part A regression guard:** the `build_fallback_webpki`
/// helper MUST exist + be called from configure_tls. The fallback is the
/// HC-1 path (Legacy + no pins) that the DelegatingVerifier delegates to
/// when `state.current()` returns None. A missing fallback would crash
/// every Legacy-mode handshake on a fresh deploy.
#[test]
fn d6_fallback_webpki_constructed_in_configure_tls() {
    let state_src = read_source("src/mtls/state_handle.rs");
    let mqtt_src = read_source("src/mqtt.rs");
    assert!(
        state_src.contains("pub fn build_fallback_webpki"),
        "ULTRA-HIGH-020 / D-6 WIRE INVARIANT VIOLATED: \
         src/mtls/state_handle.rs does not export `build_fallback_webpki`. The HC-1 \
         fallthrough (Legacy + no pins) requires this fallback verifier."
    );
    assert!(
        mqtt_src.contains("crate::mtls::build_fallback_webpki(")
            || mqtt_src.contains("build_fallback_webpki("),
        "ULTRA-HIGH-020 / D-6 WIRE INVARIANT VIOLATED: \
         src/mqtt.rs does not call build_fallback_webpki. The DelegatingVerifier \
         delegates to this fallback on the HC-1 path; without it Legacy-mode \
         handshakes panic in the wrapper."
    );
}

/// **ORPHAN-HIGH-035 cipher dimension closure (Phase 1.1.3a):** every
/// reqwest HTTPS callsite MUST use `build_suderra_https_client_config`
/// via `use_preconfigured_tls(...)`. A regression that drops this wire
/// reverts the cipher policy on the cloud-bound HTTPS path back to the
/// unrestricted ring provider — the bootstrap-token endpoint becomes
/// vulnerable to TLS 1.2 cipher-suite-downgrade again.
#[test]
fn https_clients_use_suderra_config() {
    for path in [
        "src/provisioning.rs",
        "src/commands/firmware.rs",
        "src/scripting/engine.rs",
    ] {
        let src = read_source(path);
        assert!(
            src.contains("build_suderra_https_client_config"),
            "ORPHAN-HIGH-035 cipher dimension VIOLATED: {path} does not call \
             build_suderra_https_client_config. The HTTPS reqwest path must \
             use the Suderra-narrowed ClientConfig so TLS 1.3 + 3-suite cipher \
             allowlist apply uniformly across MQTT and HTTPS transports."
        );
        assert!(
            src.contains("use_preconfigured_tls"),
            "ORPHAN-HIGH-035 cipher dimension VIOLATED: {path} does not pass \
             the Suderra ClientConfig via use_preconfigured_tls. Without this \
             wire, reqwest defaults to its native cert-loader + the unrestricted \
             rustls global default — Suderra cipher policy is bypassed."
        );
    }
}

/// **Phase 1.1.2 D-4 closure (operator surface):** the
/// `cmd_update_cert_pinning` handler MUST exist + be wired into both
/// the dispatch table AND the cmd→permission mapping. A regression that
/// drops any of these wires reduces the operator-facing surface but
/// leaves the architectural foundation (state handle + delegating
/// wrapper + downgrade gate) — symptom: operators cannot drive
/// rotations via MQTT, but the in-process `state.rebuild()` path still
/// works. This invariant catches that drift on the same PR.
#[test]
fn d4_cmd_update_cert_pinning_handler_present() {
    let src = read_source("src/commands/cert_pinning.rs");
    assert!(
        src.contains("pub(super) async fn cmd_update_cert_pinning"),
        "ULTRA-HIGH-018 / D-4 OPERATOR SURFACE WIRE INVARIANT VIOLATED: \
         src/commands/cert_pinning.rs does not define `cmd_update_cert_pinning`. \
         The handler is the operator-facing MQTT entrypoint that drives \
         MtlsVerifierState::rebuild — without it, hot-reload is reachable \
         only from in-process callers (Phase 1.1.4), not from operators."
    );
    assert!(
        src.contains("verifier_state.rebuild(new_mode, &pins_hex)"),
        "ULTRA-HIGH-018 / D-4 OPERATOR SURFACE WIRE INVARIANT VIOLATED: \
         cmd_update_cert_pinning does not call MtlsVerifierState::rebuild. \
         The handler must drive rebuild() so the Tier-1 downgrade gate \
         enforces the policy floor."
    );
}

/// **Phase 1.1.2 D-4 closure (dispatch wire):** the
/// `update_cert_pinning` command name MUST be in the
/// `dispatch_lifecycle` match arm. A regression that comments out or
/// removes the arm orphans the handler — code stays compiled but
/// operators get a "command not found" error.
#[test]
fn d4_update_cert_pinning_dispatch_wire_present() {
    let src = read_source("src/commands/dispatch_lifecycle.rs");
    assert!(
        src.contains("\"update_cert_pinning\"") && src.contains("cmd_update_cert_pinning"),
        "ULTRA-HIGH-018 / D-4 DISPATCH WIRE INVARIANT VIOLATED: \
         src/commands/dispatch_lifecycle.rs match table does not route \
         \"update_cert_pinning\" → self.cmd_update_cert_pinning. The \
         handler is unreachable from MQTT inbound commands."
    );
}

/// **Phase 1.1.2 D-4 closure (RBAC permission gate):** the
/// `update_cert_pinning` command MUST map to
/// `Permission::ManageCertPinning` in the cmd→permission table.
/// A regression that maps it to ManagePolicy (or omits it) collapses
/// the HSM-slot separation that ADR-021 §1 reserves between RBAC and
/// pinning rotations — an operator with RBAC authority would
/// auto-inherit pinning authority.
#[test]
fn d4_update_cert_pinning_requires_manage_cert_pinning_permission() {
    let src = read_source("src/commands/required_permission.rs");
    assert!(
        src.contains("\"update_cert_pinning\"")
            && src.contains("Permission::ManageCertPinning"),
        "ULTRA-HIGH-018 / D-4 RBAC GATE INVARIANT VIOLATED: \
         src/commands/required_permission.rs does not map \"update_cert_pinning\" \
         to Permission::ManageCertPinning. Mapping it to ManagePolicy collapses \
         the HSM-slot separation; omitting it lets the command bypass the RBAC \
         gate entirely."
    );
}

/// **Phase 1.1.2 (Permission enum additive contract):** the new
/// `ManageCertPinning` variant MUST exist on the Permission enum. Per
/// the ADR-018 §6 additive-only invariant, this variant cannot be
/// removed without bumping `min_edge_version` — the test pins its
/// presence so a future "cleanup" PR cannot silently delete it.
#[test]
fn permission_manage_cert_pinning_variant_present() {
    let src = read_source("src/authz/permission.rs");
    assert!(
        src.contains("ManageCertPinning"),
        "ULTRA-HIGH-018 / Permission enum INVARIANT VIOLATED: \
         src/authz/permission.rs does not declare the ManageCertPinning variant. \
         ADR-018 §6 additive-only contract: variants cannot be removed without \
         a min_edge_version bump."
    );
}

/// **ORPHAN-MEDIUM-036/037 closure (audit-sink HMAC chain emit):** the
/// `action_for_command` table at `commands/audit_emit.rs::42` MUST have
/// an explicit case for `"update_cert_pinning"` so the existing
/// command-dispatch audit pipeline emits a specific
/// `MqttCertRotated` / `MqttCertRotationRolledBack` action rather than
/// the catch-all `CommandExecuted`. Without this mapping, audit-stream
/// queries cannot distinguish a cert-pinning rotation event from any
/// other command, which defeats forensic post-mortem.
#[test]
fn audit_emit_table_classifies_update_cert_pinning() {
    let src = read_source("src/commands/audit_emit.rs");
    assert!(
        src.contains("\"update_cert_pinning\""),
        "ORPHAN-MEDIUM-036/037 VIOLATED: src/commands/audit_emit.rs \
         action_for_command table does not have an explicit case for \
         \"update_cert_pinning\". Without it, audit emits fall through to \
         CommandExecuted/CommandRejected — forensic queries cannot \
         distinguish pin rotations from generic commands."
    );
    assert!(
        src.contains("MqttCertRotated") && src.contains("MqttCertRotationRolledBack"),
        "ORPHAN-MEDIUM-036/037 VIOLATED: src/commands/audit_emit.rs \
         does not route to MqttCertRotated (success) and MqttCertRotationRolledBack \
         (failure) actions. Both wire_tags are pre-staged in audit/entry.rs \
         for this exact surface."
    );
}

/// **ORPHAN-HIGH-035 cipher dimension closure (Phase 1.1.3a):** the
/// helper itself MUST exist + use TLS 1.3 + the Suderra crypto provider.
/// Pins the source-level shape so an "optimization" that swaps in
/// `rustls::ClientConfig::with_safe_defaults()` (which uses the
/// unrestricted ring provider) is caught at test time.
#[test]
fn https_helper_uses_tls13_and_suderra_provider() {
    let src = read_source("src/mtls/https_client_config.rs");
    assert!(
        src.contains("build_suderra_crypto_provider"),
        "ORPHAN-HIGH-035 cipher dimension VIOLATED: \
         src/mtls/https_client_config.rs does not invoke build_suderra_crypto_provider. \
         The HTTPS factory must produce a ClientConfig narrowed to the 3-suite TLS 1.3 \
         allowlist; using ring's default_provider re-admits TLS 1.2 ciphers."
    );
    assert!(
        src.contains("with_protocol_versions(&[&rustls::version::TLS13])")
            || src.contains("&[&rustls::version::TLS13]"),
        "ORPHAN-HIGH-035 cipher dimension VIOLATED: \
         src/mtls/https_client_config.rs does not pin protocol version to TLS 1.3. \
         Even with the cipher allowlist narrowed, an explicit version pin is \
         defense-in-depth against future rustls feature flags re-enabling TLS 1.2."
    );
}

/// **Phase 1.1.5 / ORPHAN-HIGH-035 final closure (install_default ban):**
///
/// Pre-Phase-1.1.5 `mqtt.rs::configure_tls` called
/// `rustls::crypto::ring::default_provider().install_default()` at the top
/// of the function. That planted the UNRESTRICTED ring provider (every
/// TLS 1.2 ECDHE suite) as the process-wide rustls default. Every HTTPS
/// reqwest callsite that did not explicitly carry a Suderra-narrowed
/// provider would silently inherit the unrestricted set — bypassing the
/// cipher allowlist on HTTPS regardless of how carefully MQTT was
/// hardened. ORPHAN-HIGH-035 documented the gap.
///
/// Phase 1.1.5 removes the call. This invariant is the Tier-3
/// MAKE-IT-DETECTABLE source-grep detector that catches a regression
/// where a future change re-introduces `default_provider().install_default()`
/// for "convenience" (e.g., to silence a `rustls::Error::NoCryptoProvider`
/// panic surfaced by a new bare `ClientConfig::builder()` call). The
/// architecturally-correct fix for such a panic is to plumb the call
/// through `build_suderra_crypto_provider` (rustls path) or
/// `build_suderra_https_client_config` (reqwest path), NOT to plant a
/// permissive default.
///
/// Doc-comment usage of the identifier "install_default" is allowed
/// (this very comment uses it) — the detector targets the exact
/// method-chain expression `default_provider().install_default()`,
/// which is the only way to plant the unrestricted provider and which
/// does not appear in prose.
#[test]
fn no_install_default_in_non_test_code() {
    let banned = "default_provider().install_default()";
    let surfaces = [
        "src/mqtt.rs",
        "src/main.rs",
        "src/provisioning.rs",
        "src/commands/firmware.rs",
        "src/scripting/engine.rs",
        "src/mtls/crypto_provider.rs",
        "src/mtls/https_client_config.rs",
        "src/mtls/state_handle.rs",
        "src/mtls/rustls_verifier.rs",
        "src/mtls/mod.rs",
    ];
    for path in surfaces {
        let src = read_source(path);
        assert!(
            !src.contains(banned),
            "Phase 1.1.5 / ORPHAN-HIGH-035 INSTALL_DEFAULT BAN VIOLATED: \
             {path} contains the banned method-chain expression \
             `{banned}`. This call plants the unrestricted ring \
             CryptoProvider as the process-wide default — every TLS 1.2 \
             ECDHE suite is then advertised on any reqwest::Client::builder() \
             callsite that does not carry an explicit Suderra-narrowed provider. \
             The architecturally-correct fix is to plumb the new TLS callsite \
             through build_suderra_crypto_provider (rustls path) or \
             build_suderra_https_client_config (reqwest path). If a panic \
             from rustls about a missing CryptoProvider surfaced, that is \
             the SIGNAL that a callsite is bypassing the allowlist — fix \
             the callsite, do not plant a permissive default."
        );
    }
}

/// **Phase 1.1.5 / ORPHAN-MEDIUM-037 closure (Strict-reject audit emit):**
///
/// `SuderraServerCertVerifier::verify_server_cert` Strict-mode reject
/// arm previously emitted only `tracing::error!` — the orphan finding
/// flagged that subscribers bridging error-level to audit are
/// deployment-config-dependent, leaving forensic post-mortem
/// queryability dependent on a deployment-specific tracing wire.
///
/// Phase 1.1.5 adds the explicit audit-sink emit through the
/// process-global accessor (`crate::audit::try_emit_mtls_forensic_event`)
/// so the reject lands in the ADR-020 HMAC chain unconditionally. The
/// chain is offline-verifiable + tamper-evident — the architectural
/// floor for forensic evidence on a security-critical handshake-abort
/// surface.
///
/// This invariant pins the wire shape: the Strict-reject arm at
/// `(MtlsMode::Strict, Err(e))` MUST contain a call to
/// `try_emit_mtls_forensic_event` with the
/// `MtlsHandshakeRejectStrict` action discriminator. A regression that
/// removes the audit emit — even unintentionally during an
/// "optimization" of the verify_server_cert hot path — fails this
/// test on the same PR.
#[test]
fn strict_reject_arm_emits_audit_event() {
    let src = read_source("src/mtls/rustls_verifier.rs");
    assert!(
        src.contains("try_emit_mtls_forensic_event"),
        "ORPHAN-MEDIUM-037 VIOLATED: src/mtls/rustls_verifier.rs does not \
         call `try_emit_mtls_forensic_event`. The Strict-mode reject arm \
         must emit through the ADR-020 audit-sink HMAC chain alongside \
         the existing `tracing::error!` line — without it, forensic \
         post-mortem queries depend on a deployment-specific tracing \
         subscriber bridge."
    );
    assert!(
        src.contains("MtlsHandshakeRejectStrict"),
        "ORPHAN-MEDIUM-037 VIOLATED: src/mtls/rustls_verifier.rs does not \
         reference the `MtlsHandshakeRejectStrict` AuditAction variant. \
         The reject emit must use the dedicated discriminator (wire_tag \
         30) so audit-verify CLI queries can distinguish handshake-reject \
         events from generic `Failure` outcomes."
    );
}

/// **Phase 1.1.5 / ORPHAN-MEDIUM-036 closure (CA bundle parse audit emit):**
///
/// `mqtt.rs::configure_tls` custom-CA parse loop previously emitted
/// `tracing::error!` for `parse_errs > 0 && added > 0` partial-load
/// events. Same gap as ORPHAN-MEDIUM-037 — subscribers bridging error
/// to audit are deployment-config-dependent.
///
/// Phase 1.1.5 adds the explicit audit-sink emit through the same
/// `try_emit_mtls_forensic_event` helper. This invariant pins the
/// wire — a regression that removes the emit fails this test on the
/// same PR.
#[test]
fn ca_bundle_partial_load_emits_audit_event() {
    let src = read_source("src/mqtt.rs");
    assert!(
        src.contains("MtlsCaBundleParsePartial"),
        "ORPHAN-MEDIUM-036 VIOLATED: src/mqtt.rs does not reference the \
         `MtlsCaBundleParsePartial` AuditAction variant. The CA-bundle \
         partial-load arm (`parse_errs > 0`) must emit through the \
         audit-sink HMAC chain so operators see partial-load events in \
         the chain alongside the `tracing::error!` line."
    );
    assert!(
        src.contains("try_emit_mtls_forensic_event"),
        "ORPHAN-MEDIUM-036 VIOLATED: src/mqtt.rs does not call \
         `try_emit_mtls_forensic_event`. The architectural emit channel \
         requires this single helper — direct `AuditSink::append` calls \
         would bypass the global-accessor + tenant-fallback discipline."
    );
}

/// **Phase 1.1.5 / ORPHAN-MEDIUM-036/037 closure (global audit accessors):**
///
/// The cross-cutting forensic-emit surfaces (rustls verifier callback,
/// configure_tls CA parse) reach the audit sink via two
/// process-global accessors installed once at boot in
/// `state.rs::init_audit_sink`. The accessor symbols MUST exist on the
/// audit module surface; a regression that "simplifies" the API by
/// removing them collapses both 036 and 037 closures simultaneously
/// (the verifier + configure_tls would have nothing to call).
#[test]
fn audit_global_accessors_present() {
    let src = read_source("src/audit/mod.rs");
    assert!(
        src.contains("pub fn install_global_audit_sink("),
        "ORPHAN-MEDIUM-036/037 VIOLATED: src/audit/mod.rs does not define \
         `install_global_audit_sink`. The cross-cutting forensic-emit \
         surfaces have no install path."
    );
    assert!(
        src.contains("pub fn current_audit_sink("),
        "ORPHAN-MEDIUM-036/037 VIOLATED: src/audit/mod.rs does not define \
         `current_audit_sink`. The forensic-emit helper has no read path."
    );
    assert!(
        src.contains("pub fn try_emit_mtls_forensic_event("),
        "ORPHAN-MEDIUM-036/037 VIOLATED: src/audit/mod.rs does not define \
         `try_emit_mtls_forensic_event`. Both 036 (CA bundle parse) and \
         037 (Strict reject) sites depend on this single helper."
    );
}

/// **Phase 1.1.5 / ORPHAN-MEDIUM-036/037 closure (boot-time install):**
///
/// `state.rs::init_audit_sink` MUST install both global accessors
/// alongside the AppState.audit_sink Arc. A regression that wires the
/// AppState reference but forgets the global install would leave the
/// command-dispatch pipeline emitting normally (via AppState) while
/// the cross-cutting surfaces silently route through the
/// "global not installed" tracing-only fallback. This invariant pins
/// the install-time wire so both code paths land in the chain.
#[test]
fn boot_installs_global_audit_accessors() {
    let src = read_source("src/main.rs");
    assert!(
        src.contains("install_global_audit_sink"),
        "ORPHAN-MEDIUM-036/037 VIOLATED: src/main.rs does not call \
         `install_global_audit_sink` after the AuditSink Arc is built. \
         Cross-cutting forensic surfaces would silently fall through to \
         tracing-only emit."
    );
    assert!(
        src.contains("install_global_agent_tenant"),
        "ORPHAN-MEDIUM-036/037 VIOLATED: src/main.rs does not call \
         `install_global_agent_tenant`. Forensic AuditEntry events would \
         carry the zero-tenant placeholder, breaking per-tenant audit \
         queries."
    );
}

/// **Phase 1.1.5 / ORPHAN-HIGH-039 closure (BridgeRotation construction
/// channel discipline):**
///
/// `CertRotationStage::BridgeRotation { outgoing, incoming, bridge_until_unix_secs }`
/// is structurally lethal if `bridge_until_unix_secs` lands in the past
/// or within the 1-hour fleet-rotation floor. `accepted_fingerprints(now)`
/// collapses the post-window stage to "accept only `incoming`" — if the
/// `incoming` fingerprint is wrong (operator typo, malicious push,
/// fingerprint-mint bug), every TLS handshake fails-closed in Strict
/// mode → fleet strands simultaneously.
///
/// Phase 1.1.5 introduces [`pinning::validate_bridge_window`] +
/// [`CertRotationStage::try_bridge_rotation`] as the single architectural
/// channel for BridgeRotation construction. This invariant pins the
/// channel discipline: every prod source file that constructs
/// BridgeRotation MUST go through `try_bridge_rotation` rather than
/// direct enum-variant construction. The exception list is short and
/// audited: pinning.rs (defines the variant + tests it), tests/ (free to
/// construct directly to exercise the validator).
///
/// Adding a new construction site without going through
/// `try_bridge_rotation` would surface the literal substring
/// `CertRotationStage::BridgeRotation {` (or
/// `Self::BridgeRotation {` inside `impl CertRotationStage`) in a prod
/// file outside the allowlist — this test fails on the same PR.
#[test]
fn bridge_window_floor_enforced_at_construction_sites() {
    // Source files that legitimately construct BridgeRotation directly:
    //   - src/mtls/pinning.rs: defines the variant + the
    //     `try_bridge_rotation` smart constructor itself.
    // Every OTHER prod source file MUST use the smart constructor.
    let prod_surfaces_must_use_constructor = [
        "src/mtls/rustls_verifier.rs",
        "src/mtls/state_handle.rs",
        "src/commands/cert_pinning.rs",
        "src/commands/apply_signed_manifest.rs",
        "src/commands/verify_signed_manifest.rs",
    ];
    let banned = "CertRotationStage::BridgeRotation {";
    for path in prod_surfaces_must_use_constructor {
        // Some files may not exist yet (Phase 1.2 deser path is
        // forthcoming) — read_source panics on missing file, which is
        // fine; this invariant is the safety net that catches the
        // construction-site addition on the same PR.
        let src = std::fs::read_to_string(path).unwrap_or_default();
        if src.is_empty() {
            // File absent — nothing to check yet. The `try_bridge_rotation`
            // exists invariant below catches the symbol-presence
            // requirement; if a future PR adds a brand-new file with a
            // direct construct, the file will be in the codebase and
            // this loop iteration will catch it.
            continue;
        }
        assert!(
            !src.contains(banned),
            "ORPHAN-HIGH-039 BRIDGE WINDOW CHANNEL VIOLATED: {path} contains \
             direct enum-variant construction `{banned}`. The architectural \
             contract (Phase 1.1.5) is that BridgeRotation MUST be \
             constructed via `CertRotationStage::try_bridge_rotation(...)` \
             so the 1-hour fleet-rotation floor (validate_bridge_window) \
             applies uniformly. Direct construction bypasses the floor — a \
             past-time bridge_until from a poisoned signed-manifest deser \
             path would strand the fleet. Replace the direct construction \
             with try_bridge_rotation, threading the real now_unix_secs \
             from SystemTime::now()."
        );
    }
}

/// **Phase 1.1.5 / ORPHAN-HIGH-039 closure (smart constructor presence):**
///
/// The smart constructor + validator + floor const MUST exist on the
/// pinning module surface. A regression that "simplifies" the API by
/// removing `try_bridge_rotation` (returning the public surface to
/// direct enum-variant construction) collapses the
/// `bridge_window_floor_enforced_at_construction_sites` invariant above
/// — every prod callsite would silently fall back to direct construction
/// + the validator stops being callable.
#[test]
fn bridge_window_validator_and_constructor_present() {
    let src = read_source("src/mtls/pinning.rs");
    assert!(
        src.contains("pub const MIN_BRIDGE_WINDOW_SECS: i64"),
        "ORPHAN-HIGH-039 floor const MISSING from src/mtls/pinning.rs — \
         the validator chain has nothing to enforce."
    );
    assert!(
        src.contains("pub fn validate_bridge_window("),
        "ORPHAN-HIGH-039 validator MISSING from src/mtls/pinning.rs — \
         the smart constructor + every future signed-manifest deser path \
         depend on this single SSoT."
    );
    assert!(
        src.contains("pub fn try_bridge_rotation("),
        "ORPHAN-HIGH-039 smart constructor MISSING from src/mtls/pinning.rs \
         — without it, prod callsites have no architectural channel for \
         BridgeRotation construction."
    );
}

/// **Phase 1.1.5 / ORPHAN-HIGH-035 final closure (reqwest callsite parity):**
///
/// `https_clients_use_suderra_config` (above) verifies AT LEAST ONE
/// `use_preconfigured_tls` per file. That is a coarse detector — a
/// regression that adds a SECOND `reqwest::Client::builder()` call to
/// the same file WITHOUT the suderra_tls wire would pass that earlier
/// invariant (the original site still has it). The pre-Phase-1.1.5
/// state of `commands/firmware.rs::download_file` was exactly this
/// shape: `fetch_latest_agent_tag` carried `use_preconfigured_tls`,
/// `download_file` did not — both lived in the same file, the earlier
/// invariant was green, but firmware OTA tarball + checksum downloads
/// were silently bypassing the cipher allowlist.
///
/// This invariant pins per-file PARITY: every `reqwest::Client::builder()`
/// occurrence MUST be matched 1:1 by a `use_preconfigured_tls`
/// occurrence in the same file. A new HTTPS callsite that forgets the
/// wire fails this test on the same PR.
///
/// Counting is naïve string-match — Rust syntax means the literal
/// `reqwest::Client::builder()` appears at every callsite (no
/// macro-rewriting applies here), and `use_preconfigured_tls` is
/// uniquely the reqwest builder method that consumes a pre-built
/// `rustls::ClientConfig`. False positives in comments are unlikely
/// because the literal `reqwest::Client::builder()` parens make it
/// look like an expression, not prose.
#[test]
fn every_reqwest_client_builder_uses_preconfigured_tls() {
    let surfaces = [
        "src/provisioning.rs",
        "src/commands/firmware.rs",
        "src/scripting/engine.rs",
    ];
    for path in surfaces {
        let src = read_source(path);
        let builder_count = src.matches("reqwest::Client::builder()").count();
        let preconfigured_count = src.matches("use_preconfigured_tls").count();
        assert_eq!(
            builder_count, preconfigured_count,
            "Phase 1.1.5 / ORPHAN-HIGH-035 PARITY VIOLATED: {path} has \
             {builder_count} `reqwest::Client::builder()` callsite(s) but \
             only {preconfigured_count} `use_preconfigured_tls` wire(s). \
             Every reqwest builder MUST consume \
             `(*build_suderra_https_client_config()?).clone()` via \
             `use_preconfigured_tls(...)` — without it, reqwest defaults \
             to its native cert-loader plus the unrestricted rustls global \
             default, bypassing the Suderra cipher allowlist."
        );
    }
}
